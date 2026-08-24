/**
 * Postgres connection: configures the pg Pool, exposes a Drizzle ORM
 * instance bound to the app schema, and provides connect/disconnect helpers
 * used during server startup and shutdown.
 */
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import env from "../config/env.config";
import logger from "../logger/winston.logger";
import {
  organizations,
  users,
  roles,
  userRoles,
  auditLog,
  refreshTokens,
  aiJobs,
} from "../schema";

/**
 * Hand-listed rather than `import * as schema` so the relational query builder
 * only ever sees tables that are meant to be queryable from here. Every new
 * table needs three edits: the schema file, the barrel in src/schema/index.ts,
 * and this object. Miss the third and `db.query.<table>` is silently undefined.
 */
const schema = {
  organizations,
  users,
  roles,
  userRoles,
  auditLog,
  refreshTokens,
  aiJobs,
};

const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.name,
  user: env.db.user,
  password: env.db.password,
  ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db: NodePgDatabase<typeof schema> = drizzle(pool, {
  schema,
  logger: env.app.isDev,
});

export type DB = typeof db;

export const connectDatabase = async (): Promise<void> => {
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    logger.info("Database connected successfully");
  } catch (error) {
    if (error instanceof Error) {
      logger.error(
        "Database connection failed:" +
          JSON.stringify({
            message: error.message,
            stack: error.stack,
          }),
      );
    } else {
      logger.error("Database connection failed:", error);
    }
    process.exit(1);
  }
};

/**
 * Idempotent: `pg` throws "Called end on pool more than once" on a second call,
 * and shutdown is genuinely reachable twice — a SIGINT while a SIGTERM handler
 * is already running, or a test harness closing what a hook also closes. A
 * crash during shutdown is a confusing way to end an otherwise clean exit.
 */
let poolClosed = false;

export const disconnectDatabase = async (): Promise<void> => {
  if (poolClosed) return;
  poolClosed = true;
  await pool.end();
  logger.info("Database disconnected");
};

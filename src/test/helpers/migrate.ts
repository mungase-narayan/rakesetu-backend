/**
 * Applies `drizzle/` to the test database.
 *
 * The migration *files* are run, not `drizzle-kit push` and not a schema
 * synchronised from the TypeScript definitions. That is the point: migration
 * 0001 carries two hand-written `CREATE RULE` statements that exist in no
 * schema file, and a harness that skipped them would let every append-only
 * assertion in this phase pass against a table that is not append-only.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { resolve } from "path";

import { db } from "../../database/connection";

export const migrateTestDatabase = async (): Promise<void> => {
  await migrate(db, {
    migrationsFolder: resolve(process.cwd(), "drizzle"),
  });
};

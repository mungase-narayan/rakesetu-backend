import path from "path";
import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

const nodeEnv = process.env.NODE_ENV || "development";
const envFile =
  nodeEnv === "production"
    ? ".env.production"
    : nodeEnv === "staging"
      ? ".env.staging"
      : ".env";

// Remote environments (production, staging) sit behind managed Postgres that
// requires SSL; local/test connect without it. DB_SSL overrides the default,
// which is what a production-mode container talking to a sidecar Postgres needs.
const defaultSsl = nodeEnv === "production" || nodeEnv === "staging";

dotenv.config({ path: path.resolve(process.cwd(), envFile), override: true });

const useSsl = process.env.DB_SSL
  ? ["true", "1", "yes"].includes(process.env.DB_SSL.trim().toLowerCase())
  : defaultSsl;

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `[drizzle.config] Missing required env var "${key}" (env file: ${envFile})`,
    );
  }
  return value;
};

export default defineConfig({
  dialect: "postgresql",
  // Globs every file in src/schema, which is what lets the schema be split
  // across enums/organization/user/role files instead of one giant module.
  schema: "./src/schema/*",
  out: "./drizzle",
  dbCredentials: {
    host: required("DB_HOST"),
    port: Number(process.env.DB_PORT ?? 5432),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  },
  verbose: true,
  strict: true,
});

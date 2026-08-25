/**
 * Environment configuration: loads the correct .env file based on NODE_ENV
 * and exposes a typed, validated config object (app, db, jwt, rabbitmq, redis,
 * rateLimit, frontendUrl).
 * Throws at startup if any required variable is missing.
 */
import path from "path";
import dotenv from "dotenv";

import { EnvConfig, NodeEnv } from "../types/env.types";

const nodeEnv = (process.env.NODE_ENV || "development") as NodeEnv;

const envFilePath = path.resolve(
  process.cwd(),
  nodeEnv === "production"
    ? ".env.production"
    : nodeEnv === "staging"
      ? ".env.staging"
      : // "test" deliberately falls through to .env: the integration suite
        // overrides everything that matters (hosts, ports, secrets) from
        // src/test/setup.ts before this file is ever imported.
        ".env",
);

dotenv.config({ path: envFilePath });

const getRequired = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: "${key}"`);
  }
  return value;
};

const getOptional = (key: string, fallback: string = ""): string => {
  return process.env[key] || fallback;
};

const getNumber = (key: string, fallback: number): number => {
  const value = process.env[key];
  const parsed = Number(value);
  return isNaN(parsed) ? fallback : parsed;
};

const getBoolean = (key: string, fallback: boolean): boolean => {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  return ["true", "1", "yes"].includes(value.trim().toLowerCase());
};

// Feature flag: disable RabbitMQ (and run the AI jobs inline) on hosts that
// cannot keep an always-on consumer alive, e.g. Vercel serverless functions.
const useRabbitMQ = getBoolean("USE_RABBITMQ_SERVICE", true);

const env: EnvConfig = {
  app: {
    nodeEnv,
    port: getNumber("PORT", 4000),
    appName: getOptional("APP_NAME", "rakesetu-backend"),
    isDev: nodeEnv === "development",
    isProd: nodeEnv === "production",
    isTest: nodeEnv === "test",
  },

  db: {
    host: getRequired("DB_HOST"),
    port: getNumber("DB_PORT", 5432),
    name: getRequired("DB_NAME"),
    user: getRequired("DB_USER"),
    password: getRequired("DB_PASSWORD"),
    ssl: getBoolean("DB_SSL", nodeEnv === "production"),
    get url() {
      return `postgresql://${this.user}:${this.password}@${this.host}:${this.port}/${this.name}`;
    },
  },

  jwt: {
    accessSecret: getRequired("JWT_ACCESS_SECRET"),
    refreshSecret: getRequired("JWT_REFRESH_SECRET"),
    accessExpiresIn: getOptional("JWT_ACCESS_EXPIRES_IN", "15m"),
    refreshExpiresIn: getOptional("JWT_REFRESH_EXPIRES_IN", "7d"),
  },

  redis: {
    // Not getRequired: the API must still boot without Redis so /readyz can
    // report it as the thing that is down. A wrong URL fails at connect time,
    // loudly, rather than at import time before any logger exists.
    url: getOptional("REDIS_URL", "redis://localhost:6379"),
    keyPrefix: getOptional("REDIS_KEY_PREFIX", "rakesetu"),
  },

  rateLimit: {
    windowMs: getNumber("RATE_LIMIT_WINDOW_MINUTES", 15) * 60 * 1000,
    max: getNumber("RATE_LIMIT_MAX", 300),
    loginMax: getNumber("LOGIN_RATE_LIMIT_MAX", 10),
    passwordMax: getNumber("PASSWORD_RATE_LIMIT_MAX", 10),
    tokenMax: getNumber("TOKEN_RATE_LIMIT_MAX", 60),
  },

  rabbitmq: {
    // Only required when the broker is actually used.
    url: useRabbitMQ
      ? getRequired("RABBITMQ_URL")
      : getOptional("RABBITMQ_URL"),
    enabled: useRabbitMQ,
    consumeAiJobs: getBoolean("RABBITMQ_CONSUME_AI_JOBS", true),
    consumeEmailJobs: getBoolean("RABBITMQ_CONSUME_EMAIL_JOBS", true),
    prefetch: getNumber("RABBITMQ_PREFETCH", 1),
    emailPrefetch: getNumber("RABBITMQ_EMAIL_PREFETCH", 10),
  },

  mail: {
    // Derived, not a flag: if there is nowhere to send mail there is nothing to
    // enable. See MailConfig for why this is optional at all.
    enabled: Boolean(process.env.SMTP_HOST),
    // The same six variable names College-Level uses, so one .env works for
    // both projects and nobody has to remember which spells it differently.
    host: getOptional("SMTP_HOST"),
    port: getNumber("SMTP_PORT", 587),
    // Derived, exactly as College-Level does it — 465 is SMTPS, 587 STARTTLS.
    secure: getNumber("SMTP_PORT", 587) === 465,
    user: getOptional("SMTP_USER"),
    password: getOptional("SMTP_PASSWORD"),
    fromName: getOptional("SMTP_FROM_NAME", "RakeSetu"),
    fromEmail: getOptional("SMTP_FROM_EMAIL", "no-reply@rakesetu.dev"),
    retryBaseMs: getNumber("EMAIL_RETRY_BASE_MS", 1000),
  },

  storage: {
    region: getOptional("S3_REGION", "ap-south-1"),
    // Defaults are MinIO's stock credentials — usable out of the box for local
    // development, and obviously wrong anywhere else, which is the point.
    accessKeyId: getOptional("S3_ACCESS_KEY_ID", "minioadmin"),
    secretAccessKey: getOptional("S3_SECRET_ACCESS_KEY", "minioadmin"),
    privateBucket: getOptional("S3_PRIVATE_BUCKET", "rakesetu"),
    publicBucket: getOptional("S3_PUBLIC_BUCKET", "rakesetu-public"),
    /**
     * Empty selects real AWS S3. The default points at the MinIO in
     * docker-compose, which publishes on :9100 rather than :9000 — the same
     * port-shifting every other service here uses so two projects can run at
     * once. The API talks to one client either way.
     */
    endpoint: getOptional("S3_ENDPOINT", "http://localhost:9100"),
    // MinIO only understands path-style addressing; AWS accepts it too.
    forcePathStyle: getBoolean("S3_FORCE_PATH_STYLE", true),
    downloadUrlTtlSeconds: getNumber("S3_DOWNLOAD_URL_TTL_SECONDS", 15 * 60),
    maxUploadBytes: getNumber("S3_MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
  },

  tokens: {
    /**
     * Seven days for an invitation: it is sent to somebody who may be on leave,
     * and an admin re-sending it is cheap. One hour for a password reset,
     * because that link is a live credential for an *existing* account and the
     * person asking for it is, by definition, at their keyboard right now.
     */
    invitationTtlHours: getNumber("INVITATION_TTL_HOURS", 24 * 7),
    passwordResetTtlHours: getNumber("PASSWORD_RESET_TTL_HOURS", 1),
  },

  frontendUrl: getOptional("FRONTEND_URL", "http://localhost:5175"),
};

export default env;

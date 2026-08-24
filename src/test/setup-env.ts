/**
 * Per-worker environment, applied before any application module exists.
 *
 * This file must import **nothing** from `src/`. ES module imports are hoisted
 * above statements, so an application import here would run
 * `src/config/env.config.ts` — and open a Postgres pool from
 * `src/database/connection.ts` — against whatever `.env` says, before a single
 * assignment below had run. Splitting the environment from the hooks is what
 * makes the ordering guaranteed rather than lucky: vitest evaluates each
 * setupFile fully before importing the next, so setup-hooks.ts (which does
 * import the app) sees a fully configured process.
 */
import { readContainerConfig } from "./container-config";

const config = readContainerConfig();

// "test", not "development": it keeps development's relaxed cookie flags while
// turning off drizzle's per-query logging. See config/env.config.ts.
process.env.NODE_ENV = "test";

process.env.DB_HOST = config.dbHost;
process.env.DB_PORT = String(config.dbPort);
process.env.DB_NAME = config.dbName;
process.env.DB_USER = config.dbUser;
process.env.DB_PASSWORD = config.dbPassword;
process.env.DB_SSL = "false";
process.env.REDIS_URL = config.redisUrl;

// Deterministic secrets: a test asserting that a tampered token is rejected
// should fail because the signature is wrong, not because the developer's .env
// happened to change between runs.
process.env.JWT_ACCESS_SECRET = "test_access_secret";
process.env.JWT_REFRESH_SECRET = "test_refresh_secret";
process.env.JWT_ACCESS_EXPIRES_IN = "15m";
process.env.JWT_REFRESH_EXPIRES_IN = "7d";

// No broker in the test environment. USE_RABBITMQ_SERVICE=false makes AI jobs
// run inline through the fallback handler, which is a supported production mode
// (serverless) — so this exercises real code rather than stubbing it out.
process.env.USE_RABBITMQ_SERVICE = "false";
process.env.RABBITMQ_CONSUME_AI_JOBS = "false";

// The suite makes hundreds of requests from one address. The global limiter is
// a backstop against abuse; leaving it at its production value would just mean
// the suite fails at whichever test happened to be number 301. The limiters are
// mounted from factories, so the test that asserts on rate limiting builds its
// own with a small limit rather than relying on these.
process.env.RATE_LIMIT_MAX = "1000000";
process.env.LOGIN_RATE_LIMIT_MAX = "1000000";
process.env.PASSWORD_RATE_LIMIT_MAX = "1000000";
process.env.TOKEN_RATE_LIMIT_MAX = "1000000";

/**
 * No SMTP, ever — including the developer's Mailpit.
 *
 * `env.config.ts` falls through to `.env` for NODE_ENV=test, and `.env` now
 * points at the Mailpit container. Without this line the suite would open a
 * real SMTP connection on every invitation, which is slow when Mailpit is up
 * and a multi-second connect timeout when it is not — so the suite's speed
 * would depend on whether someone happened to run `docker compose up mailpit`.
 * Tests that assert on what was sent inject their own transport instead.
 */
process.env.SMTP_HOST = "";

// A failing assertion should be the loudest thing on screen, not the quietest.
process.env.LOG_LEVEL = "error";

/**
 * Runs in every worker **before any of our modules are imported**.
 *
 * That ordering is the whole job. `config/env.config.ts` reads `process.env` at
 * import time and `database/connection.ts` builds its pool from the result, so a
 * worker that imports a service before these assignments happen connects to the
 * developer's own Postgres — and then the isolation suite passes or fails
 * against their real data. `setupFiles` is the only hook that runs early enough.
 */
import fs from "node:fs";

import { TEST_ENV_FILE, type TestEnv } from "./env-file";

const testEnv = JSON.parse(fs.readFileSync(TEST_ENV_FILE, "utf8")) as TestEnv;

Object.assign(process.env, testEnv, {
  NODE_ENV: "test",
  /**
   * **A separate Redis namespace, and this one is load-bearing.**
   *
   * The suite runs against a throwaway Postgres container but talks to whatever
   * Redis `REDIS_URL` points at — in practice the developer's own. Several
   * cached values are keyed by content that is *global* rather than per-tenant:
   * `network:graph:v1` holds the section list with its primary keys, and a
   * container's `sections` table has entirely different uuids from the dev
   * database's.
   *
   * Without this line, running the tests leaves the developer's Redis holding a
   * network graph whose section ids belong to a database that no longer exists.
   * Nothing errors — the ETA engine looks every section up, misses every one of
   * them, and falls back to nominal speeds. The symptom is an engine that has
   * observed thirty days of running and reports `confidence: "low"` on every
   * estimate, which is a plausible-looking wrong answer and therefore the worst
   * kind.
   *
   * One prefix isolates all of it: the graph, the ETA weights, and the
   * idempotency records too.
   */
  REDIS_KEY_PREFIX: "rakesetu-test",
  USE_RABBITMQ_SERVICE: "false",
  RABBITMQ_CONSUME_AI_JOBS: "false",
  RABBITMQ_CONSUME_EMAIL_JOBS: "false",
  // Silences the SMTP transport: MailService.enabled is derived from this
  // being set, and a test that queues an invitation should not try to deliver it.
  SMTP_HOST: "",
  JWT_ACCESS_SECRET:
    process.env.JWT_ACCESS_SECRET ?? "test-access-secret-not-a-real-one",
  JWT_REFRESH_SECRET:
    process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret-not-a-real-one",
});

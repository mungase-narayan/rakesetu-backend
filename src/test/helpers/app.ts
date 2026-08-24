/**
 * The Express app under test.
 *
 * `bootstrap()` rather than `start()`: it registers the routes and returns the
 * app without binding a port or attaching a queue consumer. supertest supplies
 * its own ephemeral listener, so binding one here would just be a port to leak
 * between suites.
 *
 * Built once per worker and memoised — every `app.use` in the constructor is
 * pure setup, and rebuilding it per file would give each file its own
 * rate-limit counters, which would quietly make a limiter test meaningless.
 */
import type { Application } from "express";

import App from "../../app";
import { connectRedis, redis } from "../../database/redis";

let app: Application | undefined;

export const getTestApp = async (): Promise<Application> => {
  if (!app) {
    app = new App().bootstrap();
  }
  // The idempotency middleware needs a live client; lazyConnect means nothing
  // has opened the socket yet.
  if (redis.status !== "ready" && redis.status !== "connecting") {
    await connectRedis();
  }
  return app;
};

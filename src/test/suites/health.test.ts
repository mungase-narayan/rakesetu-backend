/**
 * Liveness and readiness.
 *
 * The assertion that matters is the split: with Redis unreachable, `/readyz`
 * must go 503 and name it while `/healthz` stays 200. Conflating the two is a
 * real outage mode — an orchestrator restarts a container that fails liveness,
 * so a dependency check in `/healthz` turns a brief Redis blip into a
 * simultaneous restart of every replica.
 *
 * Redis is broken by pointing the client at a closed port rather than by
 * stopping the container, because stopping it would take the rest of the suite
 * down with it. The code path exercised is the same one: `redis.status` is not
 * "ready", so the check reports disconnected.
 */
import request from "supertest";
import type { Application } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { redis, connectRedis } from "../../database/redis";
import { getTestApp } from "../helpers/app";

describe("health endpoints", () => {
  let app: Application;

  beforeAll(async () => {
    app = await getTestApp();
  });

  describe("when everything is up", () => {
    it("/healthz is 200 with no dependency checks", async () => {
      const response = await request(app).get("/healthz").expect(200);

      expect(response.body.status).toBe("OK");
      expect(response.body.uptime).toBeGreaterThanOrEqual(0);
      // Liveness must not report on dependencies at all.
      expect(response.body.dependencies).toBeUndefined();
    });

    it("/readyz reports each dependency", async () => {
      if (redis.status !== "ready") await connectRedis();

      const response = await request(app).get("/readyz").expect(200);

      expect(response.body.status).toBe("ready");
      expect(response.body.dependencies.database.status).toBe("connected");
      expect(response.body.dependencies.redis.status).toBe("connected");
      // USE_RABBITMQ_SERVICE=false in tests. "disabled" is a configuration, not
      // a fault, so it must not fail readiness.
      expect(response.body.dependencies.queue.status).toBe("disabled");
    });

    it("keeps /health answering for whatever still polls it", async () => {
      const response = await request(app).get("/health").expect(200);
      expect(response.body.message).toBe("Backend server is running.");
    });
  });

  describe("when Redis is unreachable", () => {
    afterAll(async () => {
      // Put it back for whatever runs next in this worker.
      await connectRedis();
    });

    it("/readyz is 503 and names redis, while /healthz stays 200", async () => {
      await redis.quit().catch(() => redis.disconnect());

      const ready = await request(app).get("/readyz").expect(503);

      expect(ready.body.status).toBe("not_ready");
      expect(ready.body.dependencies.redis.status).toBe("disconnected");
      // A breakdown that says *which* thing is down, not just that something is.
      expect(ready.body.dependencies.redis.detail).toBeTruthy();
      expect(ready.body.dependencies.database.status).toBe("connected");

      await request(app).get("/healthz").expect(200);
    });
  });
});

/**
 * The remaining cross-cutting mechanisms: pagination, correlation ids, the
 * security headers, and the Redis lock.
 *
 * These are the parts of the phase with no screen and no obvious owner, which
 * is exactly why they need a test — nothing else would notice if `withLock`
 * stopped being exclusive or if `X-Request-Id` stopped being echoed.
 */
import request from "supertest";
import type { Application } from "express";
import { randomUUID } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { aiJobs, type Organization } from "../../schema";
import { ScopedRepository } from "../../database/scoped-repository";
import {
  CacheService,
  LockUnavailableError,
  connectRedis,
  redis,
} from "../../database/redis";
import { MAX_LIMIT } from "../../types/pagination.types";
import {
  getRequestContext,
  runWithContext,
} from "../../logger/request-context";
import { getTestApp } from "../helpers/app";
import { loginAs, type Session } from "../helpers/auth";
import { organizationByCode } from "../factories/tenant.factory";

describe("platform mechanisms", () => {
  let app: Application;
  let cr: Organization;
  let admin: Session;

  beforeAll(async () => {
    app = await getTestApp();
    cr = await organizationByCode("CR");
    admin = await loginAs(app, "admin", "CR");
    if (redis.status !== "ready") await connectRedis();
  });

  describe("pagination", () => {
    it("returns the exact envelope", async () => {
      const repo = new ScopedRepository(aiJobs, cr.id);
      for (let i = 0; i < 5; i += 1) {
        await repo.insert({ type: "ingest", subjectId: `page-${i}` });
      }

      const page = await repo.paginate({ page: 1, limit: 2 });

      expect(Object.keys(page).sort()).toEqual(["data", "pagination"]);
      expect(Object.keys(page.pagination).sort()).toEqual([
        "limit",
        "page",
        "total",
        "totalPages",
      ]);
      expect(page.data).toHaveLength(2);
      expect(page.pagination.totalPages).toBe(
        Math.ceil(page.pagination.total / 2),
      );
    });

    it("clamps limit to MAX_LIMIT and floors page at 1", async () => {
      const repo = new ScopedRepository(aiJobs, cr.id);

      const huge = await repo.paginate({ page: 1, limit: 100_000 });
      expect(huge.pagination.limit).toBe(MAX_LIMIT);

      // A negative page is a client mistake, not an error worth a 400 — the
      // useful answer is the first page.
      const negative = await repo.paginate({ page: -3, limit: 10 });
      expect(negative.pagination.page).toBe(1);
    });

    it("ignores an unknown sort column instead of interpolating it", async () => {
      const repo = new ScopedRepository(aiJobs, cr.id);

      // If this reached SQL it would be a syntax error at best and an
      // injection at worst. It must fall back silently.
      const page = await repo.paginate({
        page: 1,
        limit: 5,
        sort: "id; drop table ai_jobs;--",
      });

      expect(page.data.length).toBeGreaterThan(0);
    });

    it("paginates stably across pages", async () => {
      const repo = new ScopedRepository(aiJobs, cr.id);

      const first = await repo.paginate({
        page: 1,
        limit: 2,
        sort: "id",
        order: "asc",
      });
      const second = await repo.paginate({
        page: 2,
        limit: 2,
        sort: "id",
        order: "asc",
      });

      const firstIds = first.data.map((r) => r.id);
      const secondIds = second.data.map((r) => r.id);
      expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    });
  });

  describe("correlation id", () => {
    it("echoes an inbound X-Request-Id", async () => {
      const id = randomUUID();

      const response = await request(app)
        .get("/healthz")
        .set("X-Request-Id", id)
        .expect(200);

      // A trace started by a gateway or the SPA stays one trace.
      expect(response.headers["x-request-id"]).toBe(id);
    });

    it("generates one when the client sends none", async () => {
      const response = await request(app).get("/healthz").expect(200);

      expect(response.headers["x-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("gives different requests different ids", async () => {
      const [a, b] = await Promise.all([
        request(app).get("/healthz"),
        request(app).get("/healthz"),
      ]);

      expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
    });

    it("strips anything that is not id-shaped from an inbound header", async () => {
      const response = await request(app)
        .get("/healthz")
        .set("X-Request-Id", "abc<script>alert(1)</script>")
        .expect(200);

      // Client-controlled, and it reaches a log line and a varchar(64) column.
      expect(response.headers["x-request-id"]).toBe("abcscriptalert1script");
    });

    it("threads the id onto the audit row", async () => {
      const id = `trace-${randomUUID()}`;

      await request(app)
        .patch("/api/v1/users/me")
        .set(admin.authHeader)
        .set("X-Request-Id", id)
        .send({ username: `admin-${randomUUID().slice(0, 8)}` })
        .expect(200);

      const response = await request(app)
        .get(`/api/v1/audit?action=user.update&limit=${MAX_LIMIT}`)
        .set(admin.authHeader)
        .expect(200);

      const rows = response.body.data.data as { correlationId: string }[];
      expect(rows.some((r) => r.correlationId === id)).toBe(true);
    });

    it("keeps concurrent contexts apart", async () => {
      // AsyncLocalStorage, not a module-level variable. The distinction only
      // shows up under concurrency, which is where it matters.
      const [a, b] = await Promise.all([
        runWithContext({ correlationId: "ctx-a" }, async () => {
          await new Promise((r) => setTimeout(r, 20));
          return getRequestContext()?.correlationId;
        }),
        runWithContext({ correlationId: "ctx-b" }, async () => {
          return getRequestContext()?.correlationId;
        }),
      ]);

      expect(a).toBe("ctx-a");
      expect(b).toBe("ctx-b");
    });
  });

  describe("security headers", () => {
    it("removes X-Powered-By and sets helmet's headers", async () => {
      const response = await request(app).get("/healthz").expect(200);

      // Advertising the framework and its version is free reconnaissance.
      expect(response.headers["x-powered-by"]).toBeUndefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-instance-id"]).toBeTruthy();
    });
  });

  describe("Redis lock", () => {
    const cache = new CacheService(redis, `test-${randomUUID().slice(0, 8)}`);

    it("round-trips a typed value", async () => {
      await cache.set("shape", { rake: "12345", wagons: 42 }, 60);
      expect(await cache.get<{ wagons: number }>("shape")).toEqual({
        rake: "12345",
        wagons: 42,
      });

      await cache.del("shape");
      expect(await cache.get("shape")).toBeNull();
    });

    it("runs the critical section exclusively", async () => {
      const key = `solver-${randomUUID()}`;
      let inside = 0;
      let maxConcurrent = 0;

      const work = async () => {
        inside += 1;
        maxConcurrent = Math.max(maxConcurrent, inside);
        await new Promise((r) => setTimeout(r, 60));
        inside -= 1;
      };

      const results = await Promise.allSettled([
        cache.withLock(key, 10, work),
        cache.withLock(key, 10, work),
      ]);

      // One wins, one is told so immediately — it does not queue and does not
      // silently run anyway.
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        LockUnavailableError,
      );
      expect(maxConcurrent).toBe(1);
    });

    it("releases the lock even when the work throws", async () => {
      const key = `release-${randomUUID()}`;

      await expect(
        cache.withLock(key, 10, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      // A crashed run must not block the next one for the whole TTL.
      await expect(
        cache.withLock(key, 10, async () => "second run"),
      ).resolves.toBe("second run");
    });
  });
});

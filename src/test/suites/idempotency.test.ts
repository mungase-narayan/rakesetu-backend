/**
 * Idempotency: same key twice → one effect.
 *
 * Mounted on a purpose-built route rather than a real one, because Phase 1 has
 * no event-creating POST yet — Phase 4's rake-event ingest is the first real
 * consumer. The route counts its own invocations, which is the only way to
 * assert "one effect" rather than "one response".
 *
 * The concurrency case is the one worth having. Two requests arriving at the
 * same instant is the actual production scenario — a phone that retries while
 * the first attempt is still in flight — and it is the case a naive
 * check-then-set implementation gets wrong every time.
 */
import express from "express";
import request from "supertest";
import { randomUUID } from "crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import ApiResponse from "../../utils/api-response";
import ApiError from "../../utils/api-error";
import { connectRedis, redis } from "../../database/redis";
import { idempotent } from "../../middlewares/idempotency.middleware";
import errorHandlerMiddleware from "../../middlewares/error-handler.middleware";

/** Invocations of the handler behind the middleware, per test. */
let effects: string[] = [];

const buildApp = () => {
  const app = express();
  app.use(express.json());

  app.post("/events", idempotent({ ttlSeconds: 60 }), (req, res) => {
    const id = randomUUID();
    effects.push(id);
    res
      .status(201)
      .json(new ApiResponse(201, { id, echo: req.body }, "Created"));
  });

  app.post("/slow", idempotent({ ttlSeconds: 60 }), async (_req, res) => {
    // Long enough that the second request certainly arrives mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const id = randomUUID();
    effects.push(id);
    res.status(201).json(new ApiResponse(201, { id }, "Created"));
  });

  app.post("/failing", idempotent({ ttlSeconds: 60 }), () => {
    throw new ApiError(400, "Deliberate failure");
  });

  app.use(errorHandlerMiddleware);
  return app;
};

describe("idempotency", () => {
  const app = buildApp();

  beforeAll(async () => {
    if (redis.status !== "ready") await connectRedis();
  });

  beforeEach(() => {
    effects = [];
  });

  it("requires the header on a route that mounts it", async () => {
    const response = await request(app).post("/events").send({ a: 1 });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/);
    expect(effects).toHaveLength(0);
  });

  it("runs once and replays the stored body on the second call", async () => {
    const key = randomUUID();

    const first = await request(app)
      .post("/events")
      .set("Idempotency-Key", key)
      .send({ rake: "12345" })
      .expect(201);

    const second = await request(app)
      .post("/events")
      .set("Idempotency-Key", key)
      .send({ rake: "12345" })
      .expect(201);

    expect(effects).toHaveLength(1);
    // Verbatim, including the generated id — that is what makes it a replay
    // rather than a second, coincidentally-similar answer.
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotent-replay"]).toBe("true");
  });

  it("treats a different key as a different operation", async () => {
    await request(app)
      .post("/events")
      .set("Idempotency-Key", randomUUID())
      .send({})
      .expect(201);

    await request(app)
      .post("/events")
      .set("Idempotency-Key", randomUUID())
      .send({})
      .expect(201);

    expect(effects).toHaveLength(2);
  });

  it("answers 409 while the first request is still in flight", async () => {
    const key = randomUUID();

    const [first, second] = await Promise.all([
      request(app).post("/slow").set("Idempotency-Key", key).send({}),
      // Started a beat later so the first has definitely claimed the key, but
      // long before it has answered.
      new Promise<request.Response>((resolve) => {
        setTimeout(() => {
          resolve(
            request(app).post("/slow").set("Idempotency-Key", key).send({}),
          );
        }, 20);
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    // The whole point: exactly one of them ran.
    expect(effects).toHaveLength(1);
  });

  it("scopes the key to the route, not just the value", async () => {
    const key = randomUUID();

    await request(app)
      .post("/events")
      .set("Idempotency-Key", key)
      .send({})
      .expect(201);

    // Same key, different operation. Replaying here would return a response
    // that never belonged to this route.
    await request(app)
      .post("/slow")
      .set("Idempotency-Key", key)
      .send({})
      .expect(201);

    expect(effects).toHaveLength(2);
  });

  it("releases the key when the request fails, so a retry can run", async () => {
    const key = randomUUID();

    await request(app)
      .post("/failing")
      .set("Idempotency-Key", key)
      .send({})
      .expect(400);

    // A failure is not a result worth replaying — the caller must be able to
    // retry the same key and have it actually execute.
    await request(app)
      .post("/failing")
      .set("Idempotency-Key", key)
      .send({})
      .expect(400);
  });
});

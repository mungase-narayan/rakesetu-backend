/**
 * The event spine over HTTP: guards, status codes, and the contract the
 * frontend and the phase document both depend on.
 *
 * The projector's behaviour is tested directly in `projector.test.ts`. What is
 * left for this suite is everything the service cannot see — that the guards
 * are actually mounted, that a 409's *body* names what the caller needs, and
 * that `/network/live` returns coordinates rather than a join nobody wrote.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../../database/connection";
import { rakeCycles, rakeEvents, rakeStates, rakes } from "../../schema";
import { api } from "../../test/helpers/app";
import { loginAs, type Session } from "../../test/helpers/auth";
import { requireOrg } from "../../../scripts/seed/tenancy.seed";

let controller: Session;
let admin: Session;
let customer: Session;
let rakeId: string;

const isoAgo = (hours: number): string =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

beforeAll(async () => {
  controller = await loginAs("freight_controller");
  admin = await loginAs("admin");
  customer = await loginAs("freight_customer");

  const orgId = (await requireOrg("CR")).id;
  const [created] = await db
    .insert(rakes)
    .values({
      orgId,
      code: `R-API-${Date.now() % 100000}`,
      wagonTypeCode: "BOXNHL",
      wagonCount: 42,
      owner: "IR",
      homeDivision: "Solapur",
      currentState: "EMPTY_AVAILABLE",
      currentStation: "KWV",
      stateSince: new Date(Date.now() - 48 * 60 * 60 * 1000),
    })
    .returning();
  rakeId = created.id;
});

afterAll(async () => {
  await db.delete(rakeEvents).where(eq(rakeEvents.rakeId, rakeId));
  await db.delete(rakeStates).where(eq(rakeStates.rakeId, rakeId));
  await db.delete(rakeCycles).where(eq(rakeCycles.rakeId, rakeId));
  await db.delete(rakes).where(eq(rakes.id, rakeId));
});

describe("guards", () => {
  it("rejects an unauthenticated read", async () => {
    const response = await api().get("/api/v1/network/live");
    expect(response.status).toBe(401);
  });

  it("a freight customer is refused the division-wide feed", async () => {
    /*
      The customer *does* hold `rake:read` — Phase 1 grants it so Phase 6 can
      give them tracking of their own consignments. What they must not have is
      the whole zone's freight position, which is why `/network/live` carries a
      role guard on top of the permission. Asserted here because a permission
      check that looks sufficient is exactly how this leaks.
    */
    const response = await customer.get("/api/v1/network/live");
    expect(response.status).toBe(403);
  });

  it("a controller may read but only an admin may reproject", async () => {
    expect((await controller.get("/api/v1/network/live")).status).toBe(200);
    expect(
      (await controller.post(`/api/v1/rakes/${rakeId}/reproject`)).status,
    ).toBe(403);
    expect((await admin.post(`/api/v1/rakes/${rakeId}/reproject`)).status).toBe(
      200,
    );
  });

  it("a write without an Idempotency-Key is refused", async () => {
    const response = await controller
      .post(`/api/v1/rakes/${rakeId}/events`)
      .send({ eventType: "EMPTY_AVAILABLE", occurredAt: isoAgo(40) });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/i);
  });
});

describe("POST /rakes/:rakeId/events", () => {
  it("records an event and answers with the new projection", async () => {
    const response = await controller
      .post(`/api/v1/rakes/${rakeId}/events`)
      .set("Idempotency-Key", `api-open-${Date.now()}`)
      .send({
        eventType: "EMPTY_AVAILABLE",
        occurredAt: isoAgo(40),
        stationCode: "KWV",
      });

    expect(response.status).toBe(201);
    expect(response.body.data.projection.state).toBe("EMPTY_AVAILABLE");
    expect(response.body.data.event.applied).toBe(true);
    // §8: the supervisor's identity is on the event, taken from the token and
    // never from the body.
    expect(response.body.data.event.recordedBy).toBe(controller.userId);
    expect(response.body.data.event.source).toBe("manual");
  });

  it("refuses a future-dated event", async () => {
    const response = await controller
      .post(`/api/v1/rakes/${rakeId}/events`)
      .set("Idempotency-Key", `api-future-${Date.now()}`)
      .send({
        eventType: "ALLOTTED",
        occurredAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      });

    // 422 is this codebase's validation status — a placement that has not
    // happened yet is a well-formed request making an unprocessable claim.
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/future/i);
  });

  /** T4.7's acceptance criterion, asserted on the body rather than the status. */
  it("a 409 names the from-state, the event and the legal set", async () => {
    const response = await controller
      .post(`/api/v1/rakes/${rakeId}/events`)
      .set("Idempotency-Key", `api-illegal-${Date.now()}`)
      .send({ eventType: "UNLOADING_COMPLETE", occurredAt: isoAgo(1) });

    expect(response.status).toBe(409);

    const [detail] = response.body.errors;
    expect(detail.from).toBe("EMPTY_AVAILABLE");
    expect(detail.event).toBe("UNLOADING_COMPLETE");
    expect(detail.legal).toContain("ALLOTTED");
    expect(detail.legal).not.toContain("UNLOADING_COMPLETE");
    expect(detail.recordedAs).toBe("anomaly");
  });

  it("the refused attempt is queryable at /anomalies", async () => {
    const response = await controller.get(
      `/api/v1/anomalies?rakeId=${rakeId}&limit=10`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.data.length).toBeGreaterThan(0);
    expect(response.body.data.data[0].applied).toBe(false);
    expect(response.body.data.data[0].rejectionReason).toBeTruthy();
  });

  it("a replayed Idempotency-Key returns the first response, not a second event", async () => {
    const key = `api-replay-${Date.now()}`;
    const body = {
      eventType: "ALLOTTED",
      occurredAt: isoAgo(38),
    };

    const first = await controller
      .post(`/api/v1/rakes/${rakeId}/events`)
      .set("Idempotency-Key", key)
      .send(body);
    const second = await controller
      .post(`/api/v1/rakes/${rakeId}/events`)
      .set("Idempotency-Key", key)
      .send(body);

    expect(first.status).toBe(201);
    // Either the Redis layer replays it or the durable key refuses it. Both are
    // correct; what must never happen is a second event.
    expect([201, 409]).toContain(second.status);
    if (second.status === 201) {
      expect(second.body.data.event.id).toBe(first.body.data.event.id);
    }

    const rows = await db
      .select()
      .from(rakeEvents)
      .where(eq(rakeEvents.idempotencyKey, key));
    expect(rows).toHaveLength(1);
  });
});

describe("bulk", () => {
  it("is all-or-nothing", async () => {
    const stamp = Date.now();
    const response = await controller
      .post(`/api/v1/rakes/${rakeId}/events/bulk`)
      .send({
        events: [
          {
            eventType: "DEPARTED_EMPTY",
            occurredAt: isoAgo(36),
            stationCode: "KWV",
            idempotencyKey: `bulk-${stamp}-1`,
          },
          {
            // Illegal from MOVING_TO_LOADING — the first must not survive.
            eventType: "UNLOADED_RELEASED",
            occurredAt: isoAgo(35),
            idempotencyKey: `bulk-${stamp}-2`,
          },
        ],
      });

    expect(response.status).toBe(409);

    const rows = await db
      .select()
      .from(rakeEvents)
      .where(eq(rakeEvents.idempotencyKey, `bulk-${stamp}-1`));
    expect(rows).toHaveLength(0);
  });

  it("accepts a legal batch whole", async () => {
    const stamp = Date.now();
    const response = await controller
      .post(`/api/v1/rakes/${rakeId}/events/bulk`)
      .send({
        events: [
          {
            eventType: "DEPARTED_EMPTY",
            occurredAt: isoAgo(34),
            stationCode: "KWV",
            idempotencyKey: `bulkok-${stamp}-1`,
          },
          {
            eventType: "ARRIVED_LOADING_YARD",
            occurredAt: isoAgo(32),
            stationCode: "SUR",
            idempotencyKey: `bulkok-${stamp}-2`,
          },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.accepted).toBe(2);
    expect(response.body.data.projection.state).toBe("MOVING_TO_LOADING");
  });
});

describe("reads", () => {
  it("the event log is queryable, filterable, and hides refusals by default", async () => {
    const withRefusals = await controller.get(
      `/api/v1/rakes/${rakeId}/events?includeRejected=true&limit=50`,
    );
    const without = await controller.get(
      `/api/v1/rakes/${rakeId}/events?limit=50`,
    );

    expect(withRefusals.body.data.pagination.total).toBeGreaterThan(
      without.body.data.pagination.total,
    );
    expect(
      without.body.data.data.every((row: { applied: boolean }) => row.applied),
    ).toBe(true);

    const filtered = await controller.get(
      `/api/v1/rakes/${rakeId}/events?eventType=DEPARTED_EMPTY`,
    );
    expect(
      filtered.body.data.data.every(
        (row: { eventType: string }) => row.eventType === "DEPARTED_EMPTY",
      ),
    ).toBe(true);
  });

  it("the projection and its cycles are readable", async () => {
    const state = await controller.get(`/api/v1/rakes/${rakeId}/state`);
    expect(state.status).toBe(200);
    expect(state.body.data.state).toBe("MOVING_TO_LOADING");

    const cycles = await controller.get(`/api/v1/rakes/${rakeId}/cycles`);
    expect(cycles.status).toBe(200);
    expect(cycles.body.data.data.length).toBeGreaterThan(0);

    const cycle = await controller.get(
      `/api/v1/rakes/${rakeId}/cycles/${cycles.body.data.data[0].id}`,
    );
    expect(cycle.status).toBe(200);
    expect(cycle.body.data.events.length).toBeGreaterThan(0);
  });

  /** T4.12's acceptance criterion. */
  it("/network/live returns one entry per active rake with coordinates resolved", async () => {
    const response = await controller.get("/api/v1/network/live");
    expect(response.status).toBe(200);

    const { rakes: live, terminals, asOf, counts } = response.body.data;
    expect(live.length).toBeGreaterThan(0);
    expect(terminals.length).toBeGreaterThan(0);
    expect(new Date(asOf).getTime()).toBeGreaterThan(0);

    const mine = live.find((r: { rakeId: string }) => r.rakeId === rakeId);
    expect(mine).toBeDefined();
    expect(typeof mine.lat).toBe("number");
    expect(typeof mine.lng).toBe("number");
    expect(mine.stateGroup).toBe("moving");

    // The counts are a histogram of the same rows, not a second query that
    // could disagree with them.
    const total = Object.values(counts as Record<string, number>).reduce(
      (sum, n) => sum + n,
      0,
    );
    expect(total).toBe(live.length);

    // Never cached: a five-second poll served from an intermediary is a map
    // that lies about being live.
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("the fleet list carries state, cycle and event counts", async () => {
    const response = await controller.get(
      "/api/v1/network/rake-states?limit=100",
    );
    expect(response.status).toBe(200);

    const mine = response.body.data.data.find(
      (r: { rakeId: string }) => r.rakeId === rakeId,
    );
    expect(mine.state).toBe("MOVING_TO_LOADING");
    expect(mine.cycleCount).toBeGreaterThan(0);
    expect(mine.eventCount).toBeGreaterThan(0);
  });

  it("the state filter is honoured", async () => {
    const response = await controller.get(
      "/api/v1/network/rake-states?state=MOVING_TO_LOADING&limit=100",
    );
    expect(
      response.body.data.data.every(
        (r: { state: string }) => r.state === "MOVING_TO_LOADING",
      ),
    ).toBe(true);
  });
});

describe("reproject (§13.2)", () => {
  it("reports no change on a healthy log", async () => {
    const response = await admin.post(`/api/v1/rakes/${rakeId}/reproject`);
    expect(response.status).toBe(200);
    expect(response.body.data.changed).toBe(false);
    expect(response.body.data.diff).toEqual({});
  });
});

describe("GET /network/section-load", () => {
  /**
   * The map's section layer, and the geometry the selected rake's path is drawn
   * from. Both consumers need **every** section, not only the busy ones — a
   * quiet section is a thin line, and a path that avoids traffic would
   * otherwise be drawn with gaps in it.
   */
  it("returns every section, including the ones nothing crossed", async () => {
    const response = await controller.get("/api/v1/network/section-load");

    expect(response.status).toBe(200);

    const body = response.body.data;
    expect(body.windowHours).toBe(24);
    expect(body.sections.length).toBeGreaterThan(0);

    for (const section of body.sections) {
      expect(typeof section.traversals).toBe("number");
      expect(section.traversals).toBeGreaterThanOrEqual(0);
      // The coordinates are what makes it drawable; a section whose stations
      // had none would be a line the map silently skipped.
      expect(section.fromLat).not.toBeNull();
      expect(section.toLng).not.toBeNull();
    }

    // Sections with no traffic in the window are present with a zero rather
    // than absent — the assertion that separates this from a `GROUP BY`.
    expect(
      body.sections.some((s: { traversals: number }) => s.traversals === 0),
    ).toBe(true);

    expect(body.maxTraversals).toBe(
      body.sections.reduce(
        (max: number, s: { traversals: number }) => Math.max(max, s.traversals),
        0,
      ),
    );
  });

  it("is division-wide, so a customer is refused", async () => {
    expect((await customer.get("/api/v1/network/section-load")).status).toBe(
      403,
    );
  });
});

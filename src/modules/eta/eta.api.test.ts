/**
 * The ETA engine against the real seeded network, and its HTTP surface.
 *
 * `eta.test.ts` proves the arithmetic on a fixture nobody can argue with. What
 * is left for this suite is everything that only exists once there is a
 * database: that a cold network really does answer from the timetable rather
 * than failing, that observed traversals really do displace it once there are
 * enough of them, that a stationary rake gets a reason instead of a time, and
 * that the guards are mounted.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../../database/connection";
import {
  rakeCycles,
  rakeCycles as cycles,
  rakeEvents,
  rakeStates,
  rakes,
  sections,
} from "../../schema";
import { api } from "../../test/helpers/app";
import { loginAs, type Session } from "../../test/helpers/auth";
import { requireOrg } from "../../../scripts/seed/tenancy.seed";
import { MIN_OBSERVATIONS, weightKey } from "./constants/eta.constants";
import SectionWeightService from "./services/section-weight.service";
import EtaLookupService from "./services/eta-lookup.service";

let controller: Session;
let supervisor: Session;
let customer: Session;
let orgId: string;
let rakeId: string;
let cycleId: string;

/** Two sections that meet, so a chained traversal pair can be written. */
let first: { id: string; fromCode: string; toCode: string };
let second: { id: string; fromCode: string; toCode: string };

const weights = new SectionWeightService();
const lookup = new EtaLookupService(weights);

/** 12:00 IST on a day `daysAgo` back — squarely inside the `day` band. */
const noonIstDaysAgo = (daysAgo: number): Date => {
  const now = new Date();
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  day.setUTCDate(day.getUTCDate() - daysAgo);
  // 12:00 IST is 06:30 UTC.
  return new Date(day.getTime() + (6 * 60 + 30) * 60_000);
};

beforeAll(async () => {
  controller = await loginAs("freight_controller");
  supervisor = await loginAs("terminal_supervisor");
  customer = await loginAs("freight_customer");
  orgId = (await requireOrg("CR")).id;

  const [created] = await db
    .insert(rakes)
    .values({
      orgId,
      code: `R-ETA-${Date.now() % 100000}`,
      wagonTypeCode: "BOXNHL",
      wagonCount: 42,
      owner: "IR",
      homeDivision: "Solapur",
      currentState: "EMPTY_AVAILABLE",
      currentStation: "KWV",
      stateSince: new Date(Date.now() - 96 * 60 * 60 * 1000),
    })
    .returning();
  rakeId = created.id;

  // The projection row, so the rake is *stationary* rather than *unknown* —
  // two different answers, and the first one is what T5.5 is about.
  await db.insert(rakeStates).values({
    rakeId,
    orgId,
    state: "EMPTY_AVAILABLE",
    stationCode: "KWV",
    since: new Date(Date.now() - 96 * 60 * 60 * 1000),
  });

  const [cycle] = await db
    .insert(cycles)
    .values({
      orgId,
      rakeId,
      startedAt: new Date(Date.now() - 96 * 60 * 60 * 1000),
      isClosed: false,
      eventCount: 0,
    })
    .returning();
  cycleId = cycle.id;

  // A chained pair from the seeded network: whatever it is, `second` starts
  // where `first` ends, which is the predicate the weight query applies.
  const [a] = await db
    .select({
      id: sections.id,
      fromCode: sections.fromCode,
      toCode: sections.toCode,
    })
    .from(sections)
    .where(eq(sections.fromCode, "KWV"))
    .limit(1);
  first = a;

  const [b] = await db
    .select({
      id: sections.id,
      fromCode: sections.fromCode,
      toCode: sections.toCode,
    })
    .from(sections)
    .where(
      and(eq(sections.fromCode, a.toCode), sql`${sections.toCode} <> 'KWV'`),
    )
    .limit(1);
  second = b;
});

afterAll(async () => {
  await db.delete(rakeEvents).where(eq(rakeEvents.rakeId, rakeId));
  await db.delete(rakeStates).where(eq(rakeStates.rakeId, rakeId));
  await db.delete(rakeCycles).where(eq(rakeCycles.rakeId, rakeId));
  await db.delete(rakes).where(eq(rakes.id, rakeId));
});

describe("guards", () => {
  it("refuses an unauthenticated estimate", async () => {
    const response = await api().post("/api/v1/eta/estimate").send({
      fromCode: "KWV",
      toCode: "PUNE",
      wagonTypeCode: "BOXNHL",
    });
    expect(response.status).toBe(401);
  });

  /**
   * The weight table is the inside of the engine. A supervisor holds
   * `rake:read` and `terminal:log` and has every reason to see an ETA; they
   * have none to be handed three hundred rows of medians, so the split is
   * `analytics:read` and it is asserted rather than assumed.
   */
  it("section weights need analytics:read", async () => {
    expect((await supervisor.get("/api/v1/eta/section-weights")).status).toBe(
      403,
    );
    expect((await controller.get("/api/v1/eta/section-weights")).status).toBe(
      200,
    );
  });

  it("a customer may ask for an estimate — Phase 6 tracks their own consignment", async () => {
    const response = await customer.post("/api/v1/eta/estimate").send({
      fromCode: "KWV",
      toCode: "PUNE",
      wagonTypeCode: "BOXNHL",
    });
    expect(response.status).toBe(200);
  });
});

describe("POST /eta/estimate", () => {
  it("answers an ad-hoc pair with a path and a coverage label", async () => {
    const response = await controller.post("/api/v1/eta/estimate").send({
      fromCode: "KWV",
      toCode: "PUNE",
      wagonTypeCode: "BOXNHL",
    });

    expect(response.status).toBe(200);

    const eta = response.body.data;
    expect(eta.totalMinutes).toBeGreaterThan(0);
    expect(eta.totalKm).toBeGreaterThan(0);
    expect(eta.path.length).toBeGreaterThan(0);
    expect(["low", "medium", "high"]).toContain(eta.confidence);
    expect(new Date(eta.arrivalAt).getTime()).toBeGreaterThan(
      new Date(eta.departAt).getTime(),
    );

    // Every leg names where its number came from. Phase 7 reads this shape.
    for (const leg of eta.path) {
      expect(["observed", "blended", "nominal"]).toContain(leg.source);
      expect(leg.minutes).toBeGreaterThan(0);
    }
  });

  it("refuses an unreachable pair with a 422 rather than an infinity", async () => {
    const response = await controller.post("/api/v1/eta/estimate").send({
      fromCode: "KWV",
      toCode: "ZZZZ",
      wagonTypeCode: "BOXNHL",
    });

    expect(response.status).toBe(422);
    expect(response.body.message).toMatch(/no route/i);
  });

  it("accepts a departure in the future — an estimate is not an observation", async () => {
    const response = await controller.post("/api/v1/eta/estimate").send({
      fromCode: "KWV",
      toCode: "PUNE",
      wagonTypeCode: "BOXNHL",
      departAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    });
    expect(response.status).toBe(200);
  });
});

describe("GET /eta/rake/:rakeId", () => {
  /**
   * §3.3's rule, as a test. A stationary rake is a legitimate question with a
   * legitimate answer, and the answer is not a time — so it is a 200 carrying a
   * null and a sentence, never a 404 and never a fabricated arrival.
   */
  it("answers 200 with a null and a reason for a rake that is not moving", async () => {
    const response = await controller.get(`/api/v1/eta/rake/${rakeId}`);

    expect(response.status).toBe(200);
    expect(response.body.data.eta).toBeNull();
    expect(response.body.data.reason).toBe("not_in_transit");
    expect(response.body.data.detail).toMatch(/not in transit/i);
  });

  it("says the destination is unknown when no event declared one", async () => {
    // Put the rake in a moving state without an ALLOTTED that names anywhere.
    await db
      .insert(rakeStates)
      .values({
        rakeId,
        orgId,
        state: "MOVING_TO_LOADING",
        stationCode: "KWV",
        since: new Date(Date.now() - 3 * 60 * 60 * 1000),
        lastEventAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        cycleId,
      })
      .onConflictDoUpdate({
        target: rakeStates.rakeId,
        set: {
          state: "MOVING_TO_LOADING",
          stationCode: "KWV",
          cycleId,
          lastEventAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        },
      });

    const answer = await lookup.etaForRake(orgId, rakeId);
    expect(answer.eta).toBeNull();
    expect((answer as { reason: string }).reason).toBe("no_destination");
  });

  it("estimates once an ALLOTTED names where the rake is going", async () => {
    await db.insert(rakeEvents).values({
      id: randomUUID(),
      orgId,
      rakeId,
      cycleId,
      eventType: "ALLOTTED",
      occurredAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      payload: { indentId: null, toStationCode: "PUNE" },
      source: "manual",
      idempotencyKey: `eta-dest-${randomUUID()}`,
      applied: true,
    });

    const answer = await lookup.etaForRake(orgId, rakeId);

    expect(answer.eta).not.toBeNull();
    const eta = (answer as { eta: { totalKm: number; path: unknown[] } }).eta;
    expect(eta.totalKm).toBeGreaterThan(0);
    expect(eta.path.length).toBeGreaterThan(0);
    expect(
      (answer as { destinationStationCode: string }).destinationStationCode,
    ).toBe("PUNE");
  });

  it("repositioning is measured from now, to a terminal's station", async () => {
    const options = await controller.get("/api/v1/terminals/board-options");
    expect(options.status).toBe(200);
    const terminal = options.body.data[0];

    const answer = await lookup.etaForRepositioning(orgId, rakeId, terminal.id);

    // Either a real estimate or a typed refusal — never a throw and never a
    // silently zero-length path passed off as an arrival.
    if (answer.eta) {
      expect(answer.destinationTerminalId).toBe(terminal.id);
      expect(answer.eta.departAt.getTime()).toBeGreaterThan(
        Date.now() - 60_000,
      );
    } else {
      expect(["no_route", "no_position"]).toContain(answer.reason);
    }
  });

  it("a consignment nobody has issued yet is a reason, not a crash", async () => {
    const answer = await lookup.etaForConsignment(orgId, randomUUID());
    expect(answer.eta).toBeNull();
    expect((answer as { reason: string }).reason).toBe("no_cycle");
  });
});

describe("section weights over the real log", () => {
  /**
   * T5.1's acceptance criterion, without waiting for a thirty-day simulation:
   * write `MIN_OBSERVATIONS` chained traversals of one section, all entered in
   * the same band, and the cell must flip from `nominal` to `observed` with the
   * median of what was written.
   */
  it("becomes observed once a section has enough chained traversals", async () => {
    const before = await weights.weightTable(orgId, "BOXNHL");
    const cellBefore = before.cells.find(
      (cell) => cell.sectionId === second.id && cell.band === "day",
    );
    expect(cellBefore?.source).toBe("nominal");

    // Each traversal is its own cycle, so the `lag()` never pairs across two of
    // them — the same guarantee a real journey gets from its cycle boundary.
    const minutesWritten = [40, 42, 44, 45, 46, 48, 50, 90];
    expect(minutesWritten).toHaveLength(MIN_OBSERVATIONS);

    for (const [index, minutes] of minutesWritten.entries()) {
      const [cycle] = await db
        .insert(cycles)
        .values({
          orgId,
          rakeId,
          startedAt: noonIstDaysAgo(index + 2),
          isClosed: true,
          eventCount: 2,
        })
        .returning();

      const enteredAt = noonIstDaysAgo(index + 2);

      await db.insert(rakeEvents).values([
        {
          id: randomUUID(),
          orgId,
          rakeId,
          cycleId: cycle.id,
          eventType: "SECTION_PASSED",
          occurredAt: enteredAt,
          stationCode: first.toCode,
          payload: {
            fromCode: first.fromCode,
            toCode: first.toCode,
            sectionId: first.id,
          },
          source: "simulator",
          idempotencyKey: `eta-w1-${randomUUID()}`,
          applied: true,
        },
        {
          id: randomUUID(),
          orgId,
          rakeId,
          cycleId: cycle.id,
          eventType: "SECTION_PASSED",
          occurredAt: new Date(enteredAt.getTime() + minutes * 60_000),
          stationCode: second.toCode,
          payload: {
            fromCode: second.fromCode,
            toCode: second.toCode,
            sectionId: second.id,
          },
          source: "simulator",
          idempotencyKey: `eta-w2-${randomUUID()}`,
          applied: true,
        },
      ]);
    }

    const after = await weights.weightTable(orgId, "BOXNHL");
    const cell = after.cells.find(
      (row) => row.sectionId === second.id && row.band === "day",
    );

    expect(cell?.source).toBe("observed");
    expect(cell?.samples).toBe(MIN_OBSERVATIONS);
    // The median of the eight written above is (45 + 46) / 2 = 45.5 — the 90 is
    // the detained outlier and it moves nothing.
    expect(cell?.minutes).toBeCloseTo(45.5, 1);
    expect(after.summary.observed).toBeGreaterThan(0);
    expect(after.summary.nominal).toBeGreaterThan(0);
  });

  /**
   * T5.2, and the cache's own semantics.
   *
   * The map is cached for six hours, so a call made *before* those traversals
   * were written keeps answering until it is invalidated — which is exactly why
   * `npm run eta:recompute` exists and is documented as a nightly cron rather
   * than as an optimisation. The invalidation is asserted here because a cache
   * nobody can clear is a cache that eventually serves last week's railway.
   */
  it("caches the map, and invalidation is what picks up new traversals", async () => {
    await weights.invalidate(orgId, "BOXNHL");

    const fresh = await weights.getSectionWeights(orgId, "BOXNHL");
    expect(fresh.has(weightKey(second.id, "day"))).toBe(true);
    // Nothing was written at night, so that cell stays absent and the estimator
    // falls back to the timetable for it.
    expect(fresh.has(weightKey(second.id, "night"))).toBe(false);

    // The second call is served from the cache and must be identical — a cache
    // that returned a different shape would be worse than no cache.
    const again = await weights.getSectionWeights(orgId, "BOXNHL");
    expect(again.size).toBe(fresh.size);
    expect(again.get(weightKey(second.id, "day"))?.minutes).toBe(
      fresh.get(weightKey(second.id, "day"))?.minutes,
    );
  });

  it("the debugging endpoint reports the mix", async () => {
    const response = await controller.get("/api/v1/eta/section-weights");

    expect(response.status).toBe(200);
    expect(response.body.data.minObservations).toBe(MIN_OBSERVATIONS);
    expect(response.body.data.summary.nominal).toBeGreaterThan(0);
    expect(response.body.data.wagonTypeCodes.length).toBeGreaterThan(0);
  });
});

describe("cross-tenant isolation", () => {
  it("weights are computed from the caller's own history only", async () => {
    const other = (await requireOrg("ACC")).id;
    const cells = await weights.computeSectionWeights(other, "BOXNHL");

    // Every observation written above belongs to CR. ACC's map must not carry
    // the section they were written against.
    expect(cells.some((cell) => cell.sectionId === second.id)).toBe(false);
  });
});

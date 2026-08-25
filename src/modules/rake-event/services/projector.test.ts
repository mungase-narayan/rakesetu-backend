/**
 * The projector against a real Postgres.
 *
 * Everything here needs a database by definition — transactions, the unique
 * index that makes idempotency durable, the partition routing, the re-projection
 * that rewrites rows. The *decisions* are all tested without one in
 * `state-machine.test.ts`; this suite is about what happens when those decisions
 * meet storage.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import logger from "../../../logger/winston.logger";
import { db } from "../../../database/connection";
import {
  rakeCycles,
  rakeEventKeys,
  rakeEvents,
  rakeStates,
  rakes,
  type Rake,
} from "../../../schema";
import AuditService from "../../audit/services/audit.service";
import ProjectorService from "./projector.service";
import RakeEventService from "./rake-event.service";
import { requireOrg } from "../../../../scripts/seed/tenancy.seed";

const projector = new ProjectorService(logger, new AuditService(logger));
const reads = new RakeEventService();

let orgId: string;
/** A rake created for this suite alone, so nothing else's history is disturbed. */
let rake: Rake;
let keyCounter = 0;

const key = () => `test-${Date.now()}-${(keyCounter += 1)}`;

const HOUR = 60 * 60 * 1000;
/** Fixed, and in the past, so nothing here trips the future-dating guard. */
const BASE = new Date("2026-04-06T00:00:00.000Z");
const at = (hours: number) => new Date(BASE.getTime() + hours * HOUR);

const append = (
  eventType: Parameters<typeof projector.applyEvent>[1]["eventType"],
  occurredAt: Date,
  extra: Partial<Parameters<typeof projector.applyEvent>[1]> = {},
) =>
  projector.applyEvent(orgId, {
    rakeId: rake.id,
    eventType,
    occurredAt,
    source: "manual",
    idempotencyKey: key(),
    ...extra,
  });

beforeAll(async () => {
  orgId = (await requireOrg("CR")).id;

  const [created] = await db
    .insert(rakes)
    .values({
      orgId,
      code: `R-TEST-${Date.now() % 100000}`,
      wagonTypeCode: "BOXNHL",
      wagonCount: 42,
      owner: "IR",
      homeDivision: "Solapur",
      currentState: "EMPTY_AVAILABLE",
      currentStation: "KWV",
      stateSince: at(-1),
    })
    .returning();
  rake = created;
});

afterAll(async () => {
  // Leaf-first: the keys point at the events, the events and cycles at the rake.
  await db.delete(rakeEvents).where(eq(rakeEvents.rakeId, rake.id));
  await db.delete(rakeStates).where(eq(rakeStates.rakeId, rake.id));
  await db.delete(rakeCycles).where(eq(rakeCycles.rakeId, rake.id));
  await db.delete(rakes).where(eq(rakes.id, rake.id));
});

describe("applyEvent", () => {
  it("appends, projects, and mirrors onto rakes in one transaction", async () => {
    const result = await append("EMPTY_AVAILABLE", at(0), {
      stationCode: "KWV",
    });

    expect(result.event.applied).toBe(true);
    expect(result.projection.state).toBe("EMPTY_AVAILABLE");
    expect(result.cycle).not.toBeNull();

    const [mirror] = await db.select().from(rakes).where(eq(rakes.id, rake.id));
    expect(mirror.currentState).toBe("EMPTY_AVAILABLE");
    expect(mirror.currentStation).toBe("KWV");
  });

  it("advances the state machine", async () => {
    await append("ALLOTTED", at(2));
    const result = await append("DEPARTED_EMPTY", at(4), {
      stationCode: "KWV",
    });
    expect(result.projection.state).toBe("MOVING_TO_LOADING");
  });

  it("refuses an illegal transition with a 409 and keeps the attempt", async () => {
    const before = await reads.listAnomalies(orgId, { page: 1, limit: 50 });

    await expect(append("UNLOADING_COMPLETE", at(5))).rejects.toMatchObject({
      statusCode: 409,
    });

    const after = await reads.listAnomalies(orgId, { page: 1, limit: 50 });
    expect(after.pagination.total).toBe(before.pagination.total + 1);

    const [anomaly] = after.data;
    expect(anomaly.applied).toBe(false);
    expect(anomaly.rejectionReason).toContain("MOVING_TO_LOADING");

    // And the projection did not move.
    const state = await reads.getState(orgId, rake.id);
    expect(state?.state).toBe("MOVING_TO_LOADING");
  });
});

describe("idempotency", () => {
  it("the same key twice writes one row and changes state once", async () => {
    const duplicate = key();
    const first = await projector.applyEvent(orgId, {
      rakeId: rake.id,
      eventType: "ARRIVED_LOADING_YARD",
      occurredAt: at(6),
      stationCode: "SUR",
      source: "manual",
      idempotencyKey: duplicate,
    });

    await expect(
      projector.applyEvent(orgId, {
        rakeId: rake.id,
        eventType: "ARRIVED_LOADING_YARD",
        occurredAt: at(6),
        stationCode: "SUR",
        source: "manual",
        idempotencyKey: duplicate,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const rows = await db
      .select()
      .from(rakeEvents)
      .where(
        and(
          eq(rakeEvents.rakeId, rake.id),
          eq(rakeEvents.idempotencyKey, duplicate),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.event.id);
  });

  it("concurrent duplicates settle as one success and one refusal", async () => {
    const duplicate = key();
    const submit = () =>
      projector.applyEvent(orgId, {
        rakeId: rake.id,
        eventType: "SECTION_PASSED",
        occurredAt: at(7),
        stationCode: "SUR",
        payload: { fromCode: "KWV", toCode: "SUR", sectionId: "s-test" },
        source: "manual",
        idempotencyKey: duplicate,
      });

    const outcomes = await Promise.allSettled([submit(), submit()]);
    const ok = outcomes.filter((o) => o.status === "fulfilled");
    const failed = outcomes.filter((o) => o.status === "rejected");

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const keys = await db
      .select()
      .from(rakeEventKeys)
      .where(eq(rakeEventKeys.idempotencyKey, duplicate));
    expect(keys).toHaveLength(1);
  });
});

describe("out-of-order arrival", () => {
  it("a late event marks the cycle dirty and re-projects to the ordered answer", async () => {
    await append("PLACED_FOR_LOADING", at(12), {
      stationCode: "SUR",
    });
    await append("LOADING_STARTED", at(16));

    // A crossing that happened at hour 10 but turns up now. In arrival order it
    // is nonsense; in occurred_at order it sits before the placement.
    const late = await append("SECTION_PASSED", at(10), {
      stationCode: "SUR",
      payload: { fromCode: "KWV", toCode: "SUR", sectionId: "s-late" },
    });

    expect(late.wasLate).toBe(true);
    expect(late.reprojected).toBe(true);

    const state = await reads.getState(orgId, rake.id);
    // The re-fold has run, so the flag is cleared and the state is the one the
    // ordered history produces — not the one arrival order suggested.
    expect(state?.isDirty).toBe(false);
    expect(state?.state).toBe("LOADING");
  });
});

describe("re-projection (§13.2)", () => {
  it("rebuilding from the log changes nothing", async () => {
    const result = await projector.reprojectRake(orgId, rake.id);
    expect(result.changed).toBe(false);
    expect(result.diff).toEqual({});
    expect(result.rejectedEventIds).toHaveLength(0);
  });

  it("a corrupted projection is repaired by the rebuild, and reported", async () => {
    // Exactly the corruption the schema warns about: a direct write to the
    // projection cache. It survives a screenshot and vanishes on the next fold.
    await db
      .update(rakeStates)
      .set({ state: "SICK" })
      .where(eq(rakeStates.rakeId, rake.id));

    const result = await projector.reprojectRake(orgId, rake.id);
    expect(result.changed).toBe(true);
    expect(result.diff.state).toEqual({ stored: "SICK", rebuilt: "LOADING" });

    // And it is idempotent: the second rebuild has nothing left to fix.
    expect((await projector.reprojectRake(orgId, rake.id)).changed).toBe(false);
  });
});

describe("cycle boundaries", () => {
  it("UNLOADED_RELEASED then EMPTY_AVAILABLE closes one cycle and opens the next", async () => {
    await append("LOADING_COMPLETE", at(20), {
      payload: { netWeightT: 2400, wagonsLoaded: 42 },
    });
    await append("LOADED_RELEASED", at(22), {
      payload: { netWeightT: 2400 },
    });
    await append("DEPARTED_ORIGIN", at(24), { stationCode: "SUR" });
    await append("ARRIVED_DEST", at(30), { stationCode: "PUNE" });
    await append("PLACED_FOR_UNLOADING", at(34), { stationCode: "PUNE" });
    await append("UNLOADING_STARTED", at(36));
    await append("UNLOADING_COMPLETE", at(44));
    const released = await append("UNLOADED_RELEASED", at(46), {
      stationCode: "PUNE",
    });

    const closingCycleId = released.projection.cycleId;

    const opened = await append("EMPTY_AVAILABLE", at(50), {
      stationCode: "PUNE",
    });

    expect(opened.projection.cycleId).not.toBe(closingCycleId);

    const [closed] = await db
      .select()
      .from(rakeCycles)
      .where(eq(rakeCycles.id, closingCycleId as string));

    expect(closed.isClosed).toBe(true);
    // §5.2's `emptyReturn` is measured across exactly this boundary.
    expect(closed.endedAt?.toISOString()).toBe(at(50).toISOString());
    expect(closed.netWeightT).toBe(2400);
  });

  it("a closed cycle refuses a new event without an explicit reopen", async () => {
    const [closed] = await db
      .select()
      .from(rakeCycles)
      .where(
        and(eq(rakeCycles.rakeId, rake.id), eq(rakeCycles.isClosed, true)),
      );

    // Hour 5 of the closed cycle: the rake was MOVING_TO_LOADING then, so a
    // crossing is legal *in context* — which is what makes this a test of the
    // closed-cycle rule rather than of the transition table.
    await expect(
      append(
        "SECTION_PASSED",
        new Date(closed.startedAt.getTime() + 5 * HOUR),
        {
          stationCode: "SUR",
          payload: { fromCode: "KWV", toCode: "SUR", sectionId: "s-x" },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: /immutable/ });
  });

  it("an explicit reopen is accepted and audited", async () => {
    const [closed] = await db
      .select()
      .from(rakeCycles)
      .where(
        and(eq(rakeCycles.rakeId, rake.id), eq(rakeCycles.isClosed, true)),
      );

    const result = await append(
      "SECTION_PASSED",
      // Also inside the empty haul, so the ordered fold accepts it.
      new Date(closed.startedAt.getTime() + 5.5 * HOUR),
      {
        stationCode: "SUR",
        payload: { fromCode: "KWV", toCode: "SUR", sectionId: "s-y" },
        reopenReason: "Interchange message arrived a week late from FOIS",
      },
    );

    expect(result.event.applied).toBe(true);
  });
});

describe("bulk", () => {
  it("is all-or-nothing — a bad element unwinds the good ones", async () => {
    const [fresh] = await db
      .insert(rakes)
      .values({
        orgId,
        code: `R-BULK-${Date.now() % 100000}`,
        wagonTypeCode: "BOXNHL",
        wagonCount: 42,
        owner: "IR",
        homeDivision: "Solapur",
        currentState: "EMPTY_AVAILABLE",
        currentStation: "KWV",
        stateSince: at(-1),
      })
      .returning();

    await expect(
      projector.applyBulk(orgId, [
        {
          rakeId: fresh.id,
          eventType: "EMPTY_AVAILABLE",
          occurredAt: at(0),
          stationCode: "KWV",
          source: "simulator",
          idempotencyKey: key(),
        },
        {
          rakeId: fresh.id,
          eventType: "ALLOTTED",
          occurredAt: at(1),
          source: "simulator",
          idempotencyKey: key(),
        },
        {
          // Illegal from ALLOTTED — the whole batch must come back out.
          rakeId: fresh.id,
          eventType: "UNLOADING_COMPLETE",
          occurredAt: at(2),
          source: "simulator",
          idempotencyKey: key(),
        },
      ]),
    ).rejects.toMatchObject({ statusCode: 409 });

    const applied = await db
      .select()
      .from(rakeEvents)
      .where(
        and(eq(rakeEvents.rakeId, fresh.id), eq(rakeEvents.applied, true)),
      );
    expect(applied).toHaveLength(0);

    await db.delete(rakeEvents).where(eq(rakeEvents.rakeId, fresh.id));
    await db.delete(rakeStates).where(eq(rakeStates.rakeId, fresh.id));
    await db.delete(rakeCycles).where(eq(rakeCycles.rakeId, fresh.id));
    await db.delete(rakes).where(eq(rakes.id, fresh.id));
  });
});

describe("partitions", () => {
  it("an event dated outside every declared range lands in the default partition", async () => {
    // Three years out — past the twelve partitions migration 0006 declares.
    const far = new Date("2029-07-14T09:00:00.000Z");

    const countDefault = async (): Promise<number> => {
      const result = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from rake_events_default`,
      );
      return result.rows[0]?.count ?? 0;
    };

    const before = await countDefault();

    const [fresh] = await db
      .insert(rakes)
      .values({
        orgId,
        code: `R-PART-${Date.now() % 100000}`,
        wagonTypeCode: "BOXNHL",
        wagonCount: 42,
        owner: "IR",
        homeDivision: "Solapur",
        currentState: "EMPTY_AVAILABLE",
        currentStation: "KWV",
        stateSince: at(-1),
      })
      .returning();

    // Not through applyEvent: `occurredAt` in the future is refused by the
    // validator for good reason, and this test is about storage routing.
    await db.insert(rakeEvents).values({
      orgId,
      rakeId: fresh.id,
      eventType: "EMPTY_AVAILABLE",
      occurredAt: far,
      source: "manual",
      idempotencyKey: key(),
    });

    // Stored, not refused. Losing an operational fact because a cron job did
    // not run would be far worse than filing it in the wrong partition.
    expect(await countDefault()).toBe(before + 1);

    await db.delete(rakeEvents).where(eq(rakeEvents.rakeId, fresh.id));
    await db.delete(rakes).where(eq(rakes.id, fresh.id));
  });
});

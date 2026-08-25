/**
 * Cross-tenant isolation for the three tables Phase 4 adds.
 *
 * The suite §8 asks for grows by one case per tenant-scoped table in every
 * phase, and these three are the ones that matter most so far: `rake_events` is
 * where a competitor's freight position lives, and it is also the table every
 * later number — turnaround, demurrage, invoices — is derived from. A leak here
 * is not a leak of one row; it is a leak of the other tenant's operation.
 *
 * The HTTP half is not redundant with the repository half. `ScopedRepository`
 * makes an unscoped query unconstructable, but the event routes take a
 * `rakeId` from the path — so the question "can org B post an event against org
 * A's rake" is answered by the projector's `requireRake`, and it needs its own
 * assertion.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "../../database/connection";
import { ScopedRepository } from "../../database/scoped-repository";
import {
  rakeCycles,
  rakeEvents,
  rakeStates,
  rakes,
  type Rake,
} from "../../schema";
import { requireOrg } from "../../../scripts/seed/tenancy.seed";
import { loginAs, type Session } from "../helpers/auth";

let zoneId: string;
let otherId: string;
let zoneRake: Rake;
let otherAdmin: Session;

beforeAll(async () => {
  zoneId = (await requireOrg("CR")).id;
  otherId = (await requireOrg("ACC")).id;
  otherAdmin = await loginAs("admin", "ACC");

  const [rake] = await db
    .select()
    .from(rakes)
    .where(eq(rakes.orgId, zoneId))
    .limit(1);
  zoneRake = rake;
});

describe("rake_events", () => {
  it("org B cannot read org A's event log", async () => {
    const mine = new ScopedRepository(rakeEvents, zoneId, db);
    const theirs = new ScopedRepository(rakeEvents, otherId, db);

    const ours = await mine.select(eq(rakeEvents.rakeId, zoneRake.id));
    expect(ours.length).toBeGreaterThan(0);

    expect(
      await theirs.select(eq(rakeEvents.rakeId, zoneRake.id)),
    ).toHaveLength(0);
    // "Not yours" is indistinguishable from "does not exist".
    expect(await theirs.findById(ours[0].id)).toBeNull();
  });

  it("an insert writes the bound tenant, not the one in the payload", async () => {
    const theirs = new ScopedRepository(rakeEvents, otherId, db);

    const created = await theirs.insert({
      // A body carrying somebody else's tenant. Structurally ignored, not
      // sanitised — the repository spreads values first and orgId second.
      orgId: zoneId,
      rakeId: zoneRake.id,
      eventType: "EMPTY_AVAILABLE",
      occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      source: "manual",
      idempotencyKey: `iso-${Date.now()}`,
    } as never);

    expect(created.orgId).toBe(otherId);
    expect(created.orgId).not.toBe(zoneId);

    await db.delete(rakeEvents).where(eq(rakeEvents.id, created.id));
  });
});

describe("rake_states", () => {
  /**
   * The one table here that does **not** go through `ScopedRepository`.
   *
   * Its primary key is `rake_id` — one projection row per rake — so it has no
   * `id` column and cannot satisfy `ScopedTable`. That is not a gap in the
   * scoping model: the projector reads and writes it with an explicit
   * `org_id` predicate, and this suite asserts against the same shape rather
   * than against a repository the table could never use. A future edit that
   * drops the `org_id` half of that predicate fails here.
   */
  it("a query scoped to org B sees none of org A's projections", async () => {
    const ours = await db
      .select()
      .from(rakeStates)
      .where(eq(rakeStates.orgId, zoneId));
    expect(ours.length).toBeGreaterThan(0);

    const theirs = await db
      .select()
      .from(rakeStates)
      .where(eq(rakeStates.orgId, otherId));
    expect(theirs).toHaveLength(0);
  });

  it("an update scoped to org B cannot touch org A's projection", async () => {
    const [before] = await db
      .select()
      .from(rakeStates)
      .where(eq(rakeStates.rakeId, zoneRake.id));
    expect(before).toBeDefined();

    await db
      .update(rakeStates)
      .set({ state: "SICK" })
      .where(
        and(eq(rakeStates.rakeId, zoneRake.id), eq(rakeStates.orgId, otherId)),
      );

    const [after] = await db
      .select()
      .from(rakeStates)
      .where(eq(rakeStates.rakeId, zoneRake.id));
    expect(after.state).toBe(before.state);
  });
});

describe("rake_cycles", () => {
  it("org B cannot read or close org A's cycles", async () => {
    const mine = new ScopedRepository(rakeCycles, zoneId, db);
    const theirs = new ScopedRepository(rakeCycles, otherId, db);

    const ours = await mine.select();
    expect(ours.length).toBeGreaterThan(0);
    expect(await theirs.select()).toHaveLength(0);
    expect(await theirs.findById(ours[0].id)).toBeNull();
    expect(await theirs.update(ours[0].id, { isClosed: true })).toBeNull();

    expect((await mine.findById(ours[0].id))?.isClosed).toBe(ours[0].isClosed);
  });
});

describe("over HTTP", () => {
  it("org B cannot post an event against org A's rake", async () => {
    const response = await otherAdmin
      .post(`/api/v1/rakes/${zoneRake.id}/events`)
      .set("Idempotency-Key", `iso-http-${Date.now()}`)
      .send({
        eventType: "DETAINED",
        occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
        payload: { reasonCode: "labour_unavailable" },
      });

    // 404, not 403: revealing that the id is valid but belongs elsewhere is
    // itself information, and it is exactly what an id-probing scan wants.
    expect(response.status).toBe(404);
  });

  it("org B's reads of org A's rake return no rows", async () => {
    /*
      The assertion is about *rows*, not about the status code, and that
      distinction is the point. A scoped list of somebody else's rake is an
      empty page and a 200 — which is correct: "there is nothing here for you"
      is a true answer, and it is the same answer an id that does not exist
      gives. Demanding a 403 would mean telling the caller that the id is real
      but not theirs, which is the information an id-probing scan is after.
    */
    for (const path of ["events", "cycles"]) {
      const response = await otherAdmin.get(
        `/api/v1/rakes/${zoneRake.id}/${path}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.data.data).toHaveLength(0);
      expect(response.body.data.pagination.total).toBe(0);
    }

    // The projection is a single row, so there is no empty page to return.
    const state = await otherAdmin.get(`/api/v1/rakes/${zoneRake.id}/state`);
    expect(state.status).toBe(404);
  });

  it("org B's network feed and anomalies are empty, not org A's", async () => {
    const live = await otherAdmin.get("/api/v1/network/live");
    expect(live.status).toBe(200);
    expect(live.body.data.rakes).toHaveLength(0);

    const anomalies = await otherAdmin.get("/api/v1/anomalies");
    expect(anomalies.status).toBe(200);
    expect(anomalies.body.data.data).toHaveLength(0);
  });
});

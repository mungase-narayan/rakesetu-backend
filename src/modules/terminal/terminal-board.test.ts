/**
 * The supervisor's board and quick entry (§9's "Board" and "Quick entry" rows).
 *
 * The headline assertion is the temporal one: **free time is resolved as of the
 * placement, not as of now.** The seed carries a superseding pair for
 * mechanised cement at a private siding — nine hours until 30 June 2026, seven
 * from 1 July — so a rake placed in June must still be on nine hours when the
 * board is read in August. Getting that wrong here would be a rehearsal for
 * getting a bill wrong in Phase 9, which is why it is asserted against the
 * *rule the seed ships* rather than against a fixture written for the test.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import logger from "../../logger/winston.logger";
import { db } from "../../database/connection";
import {
  rakeCycles,
  rakeEvents,
  rakeStates,
  rakes,
  terminals,
} from "../../schema";
import { api } from "../../test/helpers/app";
import { loginAs, type Session } from "../../test/helpers/auth";
import { requireOrg } from "../../../scripts/seed/tenancy.seed";
import {
  SUPERSEDED_FREE_TIME_REF,
  SUPERSEDING_FREE_TIME_REF,
} from "../../../scripts/seed/data/charge-rule.data";
import AuditService from "../audit/services/audit.service";
import ProjectorService from "../rake-event/services/projector.service";
import { legalEventsFrom } from "../rake-event/constants/transitions.constants";
import TerminalBoardService from "./services/terminal-board.service";

let supervisor: Session;
let commercial: Session;
let orgId: string;
let rakeId: string;
let terminalId: string;
let stationCode: string;

const board = new TerminalBoardService();
const projector = new ProjectorService(logger, new AuditService(logger));

/** June 2026 — before the superseding circular took effect on 1 July. */
const PLACED_AT = new Date("2026-06-20T04:00:00.000Z");

const at = (offsetHours: number): Date =>
  new Date(PLACED_AT.getTime() + offsetHours * 60 * 60 * 1000);

beforeAll(async () => {
  supervisor = await loginAs("terminal_supervisor");
  commercial = await loginAs("commercial_officer");
  orgId = (await requireOrg("CR")).id;

  // Hotgi Cement Siding: private siding, mechanised, cement — the exact
  // selector the superseding pair in the seed is scoped to.
  const [terminal] = await db
    .select({ id: terminals.id, stationCode: terminals.stationCode })
    .from(terminals)
    .where(and(eq(terminals.orgId, orgId), eq(terminals.code, "HG-SDG")))
    .limit(1);

  terminalId = terminal.id;
  stationCode = terminal.stationCode;

  const [created] = await db
    .insert(rakes)
    .values({
      orgId,
      code: `R-BRD-${Date.now() % 100000}`,
      wagonTypeCode: "BOXNHL",
      wagonCount: 42,
      owner: "IR",
      homeDivision: "Solapur",
      currentState: "EMPTY_AVAILABLE",
      currentStation: stationCode,
      stateSince: at(-12),
    })
    .returning();
  rakeId = created.id;

  // A real journey through the real projector, so the board reads a projection
  // nobody hand-wrote: available → allotted → running → placed.
  const ladder = [
    { eventType: "EMPTY_AVAILABLE" as const, occurredAt: at(-10) },
    { eventType: "ALLOTTED" as const, occurredAt: at(-8) },
    { eventType: "DEPARTED_EMPTY" as const, occurredAt: at(-6) },
    { eventType: "ARRIVED_LOADING_YARD" as const, occurredAt: at(-1) },
  ];

  for (const [index, step] of ladder.entries()) {
    await projector.applyEvent(orgId, {
      rakeId,
      ...step,
      stationCode,
      source: "manual",
      idempotencyKey: `board-ladder-${index}-${Date.now()}`,
    });
  }

  await projector.applyEvent(orgId, {
    rakeId,
    eventType: "PLACED_FOR_LOADING",
    occurredAt: PLACED_AT,
    stationCode,
    terminalId,
    payload: { lineNumber: "L2" },
    source: "manual",
    idempotencyKey: `board-placed-${Date.now()}`,
  });

  // The commodity the cycle is carrying. Phase 6's indent will set this; until
  // then the board would resolve the zone-wide default instead of the cement
  // rule, and the temporal assertion below would be about the wrong circular.
  await db
    .update(rakeCycles)
    .set({ commodityCode: "CEM" })
    .where(eq(rakeCycles.rakeId, rakeId));
});

afterAll(async () => {
  await db.delete(rakeEvents).where(eq(rakeEvents.rakeId, rakeId));
  await db.delete(rakeStates).where(eq(rakeStates.rakeId, rakeId));
  await db.delete(rakeCycles).where(eq(rakeCycles.rakeId, rakeId));
  await db.delete(rakes).where(eq(rakes.id, rakeId));
});

describe("free time is a temporal lookup", () => {
  it("returns the rule in force on the date it is asked about", async () => {
    const terminal = await board.requireTerminal(orgId, terminalId);

    const march = await board.freeTimeAt(
      terminal,
      "cement",
      new Date("2026-03-15T00:00:00.000Z"),
    );
    const august = await board.freeTimeAt(
      terminal,
      "cement",
      new Date("2026-08-01T00:00:00.000Z"),
    );

    expect(march.hours).toBe(9);
    expect(march.circularRef).toBe(SUPERSEDED_FREE_TIME_REF);

    expect(august.hours).toBe(7);
    expect(august.circularRef).toBe(SUPERSEDING_FREE_TIME_REF);
  });

  /**
   * **T5.12's acceptance criterion.** The board is read today; the placement
   * happened in June. The rake is on the June rule, and the row says which one
   * and on what date it was resolved — so a supervisor can check the claim
   * rather than take it.
   */
  it("the board resolves asOf the placement, not asOf now", async () => {
    const result = await board.board(orgId, terminalId);
    const row = result.onHand.find((entry) => entry.rakeId === rakeId);

    expect(row).toBeDefined();
    expect(row?.placedAt).toBe(PLACED_AT.toISOString());
    expect(row?.freeTime.hours).toBe(9);
    expect(row?.freeTime.circularRef).toBe(SUPERSEDED_FREE_TIME_REF);
    expect(row?.freeTime.resolvedAsOf).toBe(PLACED_AT.toISOString());

    // The rule in force *now* is the seven-hour one. If the board had resolved
    // at `now`, this is the value it would have shown.
    const now = await board.freeTimeAt(result.terminal, "cement", new Date());
    expect(now.hours).toBe(7);
  });
});

describe("the on-hand list", () => {
  it("ticks time in state and says how many hours over free time", async () => {
    const result = await board.board(orgId, terminalId);
    const row = result.onHand.find((entry) => entry.rakeId === rakeId);

    expect(row?.state).toBe("PLACED_FOR_LOADING");
    expect(row?.lineNumber).toBe("L2");
    expect(row?.hoursOnHand).toBeGreaterThan(9);
    expect(row?.status).toBe("over");
    // Hours over, not rupees: the money is Phase 9's and this screen computes
    // no charge at all.
    expect(row?.hoursOverFree).toBeGreaterThan(0);
    expect(Object.keys(row ?? {})).not.toContain("amount");
  });

  it("counts occupancy against the terminal's placement lines", async () => {
    const result = await board.board(orgId, terminalId);

    expect(result.occupancy.placementLines).toBeGreaterThan(0);
    expect(result.occupancy.onHand).toBe(result.onHand.length);
    expect(result.totals.overFreeTime).toBeGreaterThan(0);
  });
});

describe("GET /terminals/:id/next-events", () => {
  it("returns exactly the transition table's legal set", async () => {
    const response = await supervisor.get(
      `/api/v1/terminals/${terminalId}/next-events?rakeId=${rakeId}`,
    );

    expect(response.status).toBe(200);
    const entry = response.body.data.rakes[0];

    expect(entry.state).toBe("PLACED_FOR_LOADING");
    expect([...entry.legal].sort()).toEqual(
      [...legalEventsFrom("PLACED_FOR_LOADING")].sort(),
    );
    // The happy path is the primary button; the exception entries are not.
    expect(entry.primary).toBe("LOADING_STARTED");
    expect(entry.clearing).toEqual([]);
  });

  it("offers no forward step from an exception, only the way out", async () => {
    await projector.applyEvent(orgId, {
      rakeId,
      eventType: "DETAINED",
      occurredAt: at(2),
      terminalId,
      payload: { reasonCode: "labour_unavailable", note: "No gang" },
      source: "manual",
      idempotencyKey: `board-detained-${Date.now()}`,
    });

    const response = await supervisor.get(
      `/api/v1/terminals/${terminalId}/next-events?rakeId=${rakeId}`,
    );

    const entry = response.body.data.rakes[0];
    expect(entry.state).toBe("DETAINED");
    expect(entry.primary).toBeNull();
    expect(entry.clearing).toEqual(["DETENTION_CLEARED"]);

    await projector.applyEvent(orgId, {
      rakeId,
      eventType: "DETENTION_CLEARED",
      occurredAt: at(3),
      terminalId,
      source: "manual",
      idempotencyKey: `board-cleared-${Date.now()}`,
    });
  });

  it("lists every rake standing at the terminal or its station when no rake is named", async () => {
    const response = await supervisor.get(
      `/api/v1/terminals/${terminalId}/next-events`,
    );

    expect(response.status).toBe(200);
    expect(
      response.body.data.rakes.some(
        (entry: { rakeId: string }) => entry.rakeId === rakeId,
      ),
    ).toBe(true);
  });
});

describe("quick entry writes", () => {
  it("refuses an exception with a reason code nobody downstream can map", async () => {
    const response = await supervisor
      .post(`/api/v1/rakes/${rakeId}/events`)
      .set("Idempotency-Key", `board-badreason-${Date.now()}`)
      .send({
        eventType: "DETAINED",
        occurredAt: at(4).toISOString(),
        terminalId,
        payload: { reasonCode: "SOMETHING_MADE_UP" },
      });

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/reasonCode/);
  });

  it("refuses a future occurredAt", async () => {
    const response = await supervisor
      .post(`/api/v1/rakes/${rakeId}/events`)
      .set("Idempotency-Key", `board-future-${Date.now()}`)
      .send({
        eventType: "LOADING_STARTED",
        occurredAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        terminalId,
      });

    expect(response.status).toBe(422);
  });

  /**
   * The failure this prevents is the reason `Idempotency-Key` exists at all: a
   * siding tablet loses signal mid-submit and the supervisor taps again. One
   * event must land, because the second one would double the detention hours —
   * and detention hours are money.
   */
  it("the same idempotency key twice creates exactly one event", async () => {
    const key = `board-double-${Date.now()}`;
    const body = {
      eventType: "LOADING_STARTED",
      occurredAt: at(5).toISOString(),
      terminalId,
    };

    const first = await supervisor
      .post(`/api/v1/rakes/${rakeId}/events`)
      .set("Idempotency-Key", key)
      .send(body);
    expect(first.status).toBe(201);

    const second = await supervisor
      .post(`/api/v1/rakes/${rakeId}/events`)
      .set("Idempotency-Key", key)
      .send(body);

    // Either the Redis replay (200/201 with the header) or the durable key
    // (409). Both are correct; what must never happen is a second event.
    expect([200, 201, 409]).toContain(second.status);

    const rows = await db
      .select({ id: rakeEvents.id })
      .from(rakeEvents)
      .where(
        and(
          eq(rakeEvents.rakeId, rakeId),
          eq(rakeEvents.eventType, "LOADING_STARTED"),
        ),
      );

    expect(rows).toHaveLength(1);
  });
});

describe("guards and scope", () => {
  it("refuses an unauthenticated board", async () => {
    const response = await api().get(`/api/v1/terminals/${terminalId}/board`);
    expect(response.status).toBe(401);
  });

  /**
   * A commercial officer holds `masterdata:read` and can list terminals. The
   * board is `terminal:read` — an operating permission they do not hold — and
   * the two being different is the whole reason the guard is not the module's
   * default.
   */
  it("a commercial officer cannot open a supervisor's board", async () => {
    const response = await commercial.get(
      `/api/v1/terminals/${terminalId}/board`,
    );
    expect(response.status).toBe(403);
  });

  it("another tenant's terminal is a 404, not a 403", async () => {
    const other = (await requireOrg("ACC")).id;
    const [foreign] = await db
      .select({ id: terminals.id })
      .from(terminals)
      .where(eq(terminals.orgId, other))
      .limit(1);

    if (!foreign) return;

    const response = await supervisor.get(
      `/api/v1/terminals/${foreign.id}/board`,
    );
    expect(response.status).toBe(404);
  });
});

/**
 * Opens one in-flight cycle per active rake, so the Phase 4 map is populated
 * before the simulator has ever run.
 *
 * **It seeds events, not a projection.** The tempting shortcut is to write a
 * `rake_states` row straight from `rakes.current_state` and an open
 * `rake_cycles` row beside it — two inserts instead of four hundred. It is
 * wrong, and wrong in a way that only surfaces at the demo: `POST /reproject`
 * would then rebuild those rakes from an empty log, find no cycle and no state,
 * and report `changed: true` for every rake nobody had simulated. §13.2's spine
 * check would fail on a freshly seeded database.
 *
 * So each rake gets the short ladder of events that actually produces its
 * seeded state, written through `ProjectorService` like every other event in
 * the system. The log is the truth from the first `db:seed`, and the projection
 * is what a fold over it says — which is the invariant the whole phase rests on.
 *
 * Timestamps run backwards from `rakes.state_since`, so the last event lands
 * exactly on it and `rake_states.since` matches the seeded fleet register.
 */
/* eslint-disable no-console */
import { and, asc, eq } from "drizzle-orm";

import logger from "../../src/logger/winston.logger";
import { db } from "../../src/database/connection";
import {
  rakeEvents,
  rakeStates,
  rakes,
  terminals,
  type RakeEventType,
} from "../../src/schema";
import { sql } from "drizzle-orm";
import AuditService from "../../src/modules/audit/services/audit.service";
import ProjectorService from "../../src/modules/rake-event/services/projector.service";
import type { RakeState } from "../../src/schema";

const HOUR = 60 * 60 * 1000;

/**
 * The event ladder that lands on each seeded state.
 *
 * Every list is a legal path from `EMPTY_AVAILABLE` under `LEGAL_TRANSITIONS` —
 * the seed test folds each one through the state machine and asserts it arrives
 * where the key says. A typo here would seed a fleet whose projection disagrees
 * with its own register.
 */
const LADDER: Record<RakeState, RakeEventType[]> = {
  EMPTY_AVAILABLE: ["EMPTY_AVAILABLE"],
  ALLOTTED: ["EMPTY_AVAILABLE", "ALLOTTED"],
  MOVING_TO_LOADING: ["EMPTY_AVAILABLE", "ALLOTTED", "DEPARTED_EMPTY"],
  PLACED_FOR_LOADING: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
  ],
  LOADING: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
  ],
  LOADED_RELEASED: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
  ],
  IN_TRANSIT_LOADED: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
  ],
  AT_DEST_YARD: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "ARRIVED_DEST",
  ],
  PLACED_FOR_UNLOADING: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
  ],
  UNLOADING: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
    "UNLOADING_STARTED",
  ],
  UNLOADED_RELEASED: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
    "UNLOADING_STARTED",
    "UNLOADING_COMPLETE",
    "UNLOADED_RELEASED",
  ],
  EMPTY_RETURNING: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
    "UNLOADING_STARTED",
    "UNLOADING_COMPLETE",
    "UNLOADED_RELEASED",
    "DEPARTED_EMPTY_RETURN",
  ],

  // The exception states, each interrupting the operational state it is most
  // plausibly reached from — a detained rake is one standing at a siding, a
  // sick one is one in transit.
  DETAINED: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "DETAINED",
  ],
  SICK: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "MARKED_SICK",
  ],
  DIVERTED: ["EMPTY_AVAILABLE", "ALLOTTED", "DEPARTED_EMPTY", "DIVERTED"],
  HELD_FOR_ORDER: [
    "EMPTY_AVAILABLE",
    "ALLOTTED",
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "HELD_FOR_ORDER",
  ],
};

/** Which events want a terminal on them, when the rake's station has one. */
const TERMINAL_EVENTS: ReadonlySet<RakeEventType> = new Set<RakeEventType>([
  "PLACED_FOR_LOADING",
  "LOADING_STARTED",
  "LOADING_COMPLETE",
  "LOADED_RELEASED",
  "PLACED_FOR_UNLOADING",
  "UNLOADING_STARTED",
  "UNLOADING_COMPLETE",
  "UNLOADED_RELEASED",
  "DETAINED",
  "HELD_FOR_ORDER",
]);

const payloadFor = (
  eventType: RakeEventType,
  wagonCount: number,
): Record<string, unknown> => {
  switch (eventType) {
    case "LOADING_COMPLETE":
      return { netWeightT: wagonCount * 58, wagonsLoaded: wagonCount };
    case "LOADED_RELEASED":
      return { netWeightT: wagonCount * 58 };
    case "PLACED_FOR_LOADING":
    case "PLACED_FOR_UNLOADING":
      return { lineNumber: "L1" };
    case "DETAINED":
      return { reasonCode: "CUST_LABOUR" };
    case "MARKED_SICK":
      return { reasonCode: "BRAKE_BINDING" };
    case "HELD_FOR_ORDER":
      return { reasonCode: "AWAITING_ORDER" };
    default:
      return {};
  }
};

export interface EventSeedCounts {
  rakes: number;
  events: number;
  skipped: number;
}

export const seedOpeningCycles = async (
  orgId: string,
): Promise<EventSeedCounts> => {
  const auditService = new AuditService(logger);
  const projector = new ProjectorService(logger, auditService);

  const fleet = await db
    .select()
    .from(rakes)
    .where(and(eq(rakes.orgId, orgId), eq(rakes.isActive, true)))
    .orderBy(asc(rakes.code));

  const terminalRows = await db
    .select()
    .from(terminals)
    .where(eq(terminals.orgId, orgId))
    .orderBy(asc(terminals.code));

  const terminalByStation = new Map<string, string>();
  for (const terminal of terminalRows) {
    if (!terminalByStation.has(terminal.stationCode)) {
      terminalByStation.set(terminal.stationCode, terminal.id);
    }
  }

  let events = 0;
  let skipped = 0;

  for (const rake of fleet) {
    // Already has a history — from a previous seed run, or from the simulator.
    // Skipped whole rather than per-event: replaying the ladder over a rake the
    // simulator has since moved would reset its projection to a state its own
    // log contradicts.
    const [existing] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(rakeEvents)
      .where(eq(rakeEvents.rakeId, rake.id));

    if ((existing?.value ?? 0) > 0) {
      skipped += 1;
      continue;
    }

    const ladder = LADDER[rake.currentState];
    const terminalId = rake.currentStation
      ? (terminalByStation.get(rake.currentStation) ?? null)
      : null;

    // Two hours apart, ending exactly on `state_since` — so the projection's
    // `since` reproduces the fleet register rather than drifting from it.
    const last = rake.stateSince.getTime();
    const step = 2 * HOUR;
    const firstAt = last - (ladder.length - 1) * step;

    /**
     * Establish the starting point before the ladder runs.
     *
     * `rakes.current_state` is where this rake is meant to *end up*, and the
     * projector would otherwise judge the ladder's first event against it — so
     * a rake seeded as `ALLOTTED` would refuse the `EMPTY_AVAILABLE` that is
     * supposed to precede it. Writing the origin row here is the one place the
     * projection is set by anything but a fold, and it is legitimate for the
     * same reason Phase 3 seeded `current_state` at all: somebody has to state
     * where the fleet stood before there was any history.
     */
    await db
      .insert(rakeStates)
      .values({
        rakeId: rake.id,
        orgId,
        state: "EMPTY_AVAILABLE",
        stationCode: rake.currentStation,
        since: new Date(firstAt),
        isDirty: false,
      })
      .onConflictDoUpdate({
        target: rakeStates.rakeId,
        set: {
          state: "EMPTY_AVAILABLE",
          previousState: null,
          stationCode: rake.currentStation,
          terminalId: null,
          since: new Date(firstAt),
          cycleId: null,
          lastEventId: null,
          lastEventAt: null,
          isDirty: false,
          updatedAt: new Date(),
        },
      });

    for (const [index, eventType] of ladder.entries()) {
      try {
        await projector.applyEvent(orgId, {
          rakeId: rake.id,
          eventType,
          occurredAt: new Date(firstAt + index * step),
          stationCode: rake.currentStation,
          terminalId: TERMINAL_EVENTS.has(eventType) ? terminalId : null,
          payload: payloadFor(eventType, rake.wagonCount),
          source: "manual",
          sourceRef: "seed",
          recordedBy: null,
          // Stable, so `db:seed` run twice writes one ladder, not two. The
          // second run's inserts collide on `rake_event_keys` and are counted
          // as skipped.
          idempotencyKey: `seed:${rake.code}:${index}`,
        });
        events += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("already exists")) {
          skipped += 1;
          continue;
        }
        throw new Error(
          `Seeding ${rake.code}'s ladder failed at ${eventType} (${rake.currentState}): ${message}`,
        );
      }
    }
  }

  console.log(
    `  event spine   ${events} events across ${fleet.length - skipped} rakes` +
      `${skipped > 0 ? `, ${skipped} rakes already had a history` : ""}`,
  );

  return { rakes: fleet.length, events, skipped };
};

export { LADDER };

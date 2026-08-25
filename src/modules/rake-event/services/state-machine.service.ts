/**
 * The rake state machine (DESIGN.md §5.1) — **pure**.
 *
 * No database, no clock, no logger, no randomness. Not a style preference: §5
 * makes the deterministic engines pure functions *specifically so* they can be
 * tested without a database, and this one carries the property §13.2 calls the
 * spine check — *"re-running the projection from the event log produces
 * byte-identical state"*. That claim is only provable if projecting is a fold
 * over a sorted array with no ambient input, so this file has none.
 *
 * The corollary is enforced by a test, not by discipline: the suite asserts
 * that this module's import graph contains nothing from `database/`.
 *
 * ---
 *
 * **Ordering.** Everything sorts by `occurred_at`, never by arrival. Events
 * turn up late — a supervisor's phone reconnects the next morning, a FOIS
 * batch replays — and a fold in arrival order would make the rake's history
 * depend on network weather. `id` breaks ties so that two events at the same
 * instant fold in one fixed order and not whichever the planner returned.
 */
import type { RakeEventType, RakeState } from "../../../schema";
import {
  CLEARS_TERMINAL,
  CYCLE_OPENING_EVENT,
  POSITION_EVENTS,
  RESTORE_PREVIOUS,
  TARGET_STATE,
} from "../constants/event-type.constants";
import {
  IllegalTransitionError,
  isLegal,
  legalEventsFrom,
} from "../constants/transitions.constants";

/**
 * The minimum an event has to look like to be folded.
 *
 * Structural rather than `typeof rakeEvents.$inferSelect`, so the property
 * tests can generate plain objects and the simulator can fold a journey it has
 * not written yet. Every real row satisfies it.
 */
export interface FoldableEvent {
  id: string;
  eventType: RakeEventType;
  occurredAt: Date;
  stationCode?: string | null;
  terminalId?: string | null;
  cycleId?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface Projection {
  state: RakeState;
  previousState: RakeState | null;
  stationCode: string | null;
  terminalId: string | null;
  since: Date;
  cycleId: string | null;
  lastEventId: string | null;
  lastEventAt: Date | null;
}

/** What the fold learned about one turnaround. */
export interface CycleSummary {
  /** Taken from the events; null for a group whose rows are not yet assigned. */
  cycleId: string | null;
  startedAt: Date;
  /** The instant the *next* cycle opened. Null while this one is the last. */
  endedAt: Date | null;
  isClosed: boolean;
  eventCount: number;
  originTerminalId: string | null;
  destTerminalId: string | null;
  netWeightT: number | null;
  commodityCode: string | null;
  events: FoldableEvent[];
}

export interface RejectedEvent {
  event: FoldableEvent;
  /** The state the rake was in when the event was attempted. */
  from: RakeState;
  reason: string;
}

export interface ProjectionResult {
  projection: Projection;
  cycles: CycleSummary[];
  applied: FoldableEvent[];
  rejected: RejectedEvent[];
}

/** Where a rake with no history stands. */
export const initialProjection = (
  since: Date,
  stationCode: string | null = null,
): Projection => ({
  state: "EMPTY_AVAILABLE",
  previousState: null,
  stationCode,
  terminalId: null,
  since,
  cycleId: null,
  lastEventId: null,
  lastEventAt: null,
});

export const isLegalTransition = (
  from: RakeState,
  event: RakeEventType,
): boolean => isLegal(from, event);

/**
 * The state after `event`, or a throw.
 *
 * Throws rather than returning a result type because the two call sites want
 * opposite things: `applyEvent` wants the error (it becomes a 409 and an
 * anomaly row), and `project` wants to keep folding (it catches and records).
 * A `Result` would force both to unwrap, and the API path is where the loud
 * failure belongs.
 */
export const nextState = (
  from: RakeState,
  event: RakeEventType,
  previousState: RakeState | null = null,
): RakeState => {
  if (!isLegal(from, event)) {
    throw new IllegalTransitionError(from, event, legalEventsFrom(from));
  }

  const target = TARGET_STATE[event];
  if (target === null) return from;
  if (target === RESTORE_PREVIOUS) {
    // A cleared exception with no remembered state is not a crash — it is a
    // rake that was detained before this log began. `EMPTY_AVAILABLE` is the
    // only safe landing: it is the one state from which nothing is assumed to
    // be in progress, so the next real event re-establishes the truth.
    return previousState ?? "EMPTY_AVAILABLE";
  }
  return target;
};

/**
 * Sorts a copy by `occurred_at`, then `id`.
 *
 * A copy, because callers pass arrays they still own — mutating a caller's
 * array in a "pure" module is the kind of impurity that only shows up as a
 * flaky test six phases later.
 */
export const sortEvents = <T extends FoldableEvent>(
  events: readonly T[],
): T[] =>
  [...events].sort((a, b) => {
    const delta = a.occurredAt.getTime() - b.occurredAt.getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });

/**
 * Splits a rake's history into turnarounds.
 *
 * A new cycle begins at every `EMPTY_AVAILABLE`. Anything before the first one
 * — a log that starts mid-journey, which every seeded rake does — is its own
 * leading group rather than being discarded: those events are real, they belong
 * to a cycle that began before the log, and dropping them would make the
 * projection disagree with the row count.
 *
 * Rejected events are *not* excluded here. They carry no state change, so they
 * cannot move a boundary, and keeping them in the group is what lets the rake
 * detail screen show an attempt next to the events around it.
 */
export const splitCycles = <T extends FoldableEvent>(
  events: readonly T[],
): T[][] => {
  const sorted = sortEvents(events);
  const groups: T[][] = [];
  let current: T[] = [];

  for (const event of sorted) {
    if (event.eventType === CYCLE_OPENING_EVENT && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(event);
  }

  if (current.length > 0) groups.push(current);
  return groups;
};

const numberFrom = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Fold a rake's events into its current state and its cycles.
 *
 * Total: an illegal event is skipped and recorded in `rejected`, never thrown.
 * That is what makes the function safe to run over a log that already contains
 * anomalies — which every real log does, because §5.1 requires the attempts to
 * be kept.
 *
 * `opts.startFrom` folds an increment onto a known projection. Passing it is an
 * optimisation and nothing else: folding the whole history instead must produce
 * the same answer, and the determinism suite asserts exactly that.
 */
export const project = (
  events: readonly FoldableEvent[],
  opts: { startFrom?: Projection } = {},
): ProjectionResult => {
  const sorted = sortEvents(events);

  const seed =
    opts.startFrom ??
    initialProjection(sorted[0]?.occurredAt ?? new Date(0), null);

  let state = seed.state;
  let previousState = seed.previousState;
  let stationCode = seed.stationCode;
  let terminalId = seed.terminalId;
  let since = seed.since;
  let cycleId = seed.cycleId;
  let lastEventId = seed.lastEventId;
  let lastEventAt = seed.lastEventAt;

  const applied: FoldableEvent[] = [];
  const rejected: RejectedEvent[] = [];

  for (const event of sorted) {
    if (!isLegal(state, event.eventType)) {
      rejected.push({
        event,
        from: state,
        reason: new IllegalTransitionError(
          state,
          event.eventType,
          legalEventsFrom(state),
        ).message,
      });
      continue;
    }

    const target = nextState(state, event.eventType, previousState);

    if (target !== state) {
      // `previous_state` remembers only what an exception interrupted. Set on
      // the way in, cleared on the way out — so a rake that goes
      // LOADING → DETAINED → LOADING does not keep pointing back at LOADING
      // once it is loading again, and Phase 8 cannot mistake a resumed rake for
      // one still carrying an open exception.
      previousState = isExceptionTarget(target) ? state : null;
      state = target;
      since = event.occurredAt;
    }

    if (POSITION_EVENTS.has(event.eventType)) {
      // Only a positioning event may move the rake, and only when it actually
      // carries a position. `LOADING_COMPLETE` says nothing about where the
      // rake is, and an absent `stationCode` on `SECTION_PASSED` must not blank
      // a position the log already established.
      if (event.stationCode) stationCode = event.stationCode;
    }

    if (event.terminalId) {
      terminalId = event.terminalId;
    } else if (CLEARS_TERMINAL.has(event.eventType)) {
      // Departing or arriving elsewhere frees the placement line. See
      // `CLEARS_TERMINAL` — a terminal_id that is only ever set reads as a
      // terminal permanently occupied by stock that left days ago.
      terminalId = null;
    }

    if (event.eventType === CYCLE_OPENING_EVENT) {
      // The new cycle's id comes from the row, which the projector assigned.
      cycleId = event.cycleId ?? null;
    } else if (event.cycleId) {
      cycleId = event.cycleId;
    }

    lastEventId = event.id;
    lastEventAt = event.occurredAt;
    applied.push(event);
  }

  return {
    projection: {
      state,
      previousState,
      stationCode,
      terminalId,
      since,
      cycleId,
      lastEventId,
      lastEventAt,
    },
    cycles: summariseCycles(sorted),
    applied,
    rejected,
  };
};

const EXCEPTION_TARGETS: ReadonlySet<RakeState> = new Set<RakeState>([
  "DETAINED",
  "SICK",
  "DIVERTED",
  "HELD_FOR_ORDER",
]);

const isExceptionTarget = (state: RakeState): boolean =>
  EXCEPTION_TARGETS.has(state);

/**
 * Turns the split groups into cycle rows.
 *
 * Cycle N's `ended_at` is cycle N+1's `started_at`, which is not a
 * simplification — §5.2's `emptyReturn` bucket is defined as
 * `NEXT_EMPTY_AVAILABLE − UNLOAD_RELEASE`, so the empty haul has to fall inside
 * the cycle it returns from. Any other boundary orphans it.
 */
export const summariseCycles = (
  events: readonly FoldableEvent[],
): CycleSummary[] => {
  const groups = splitCycles(events);

  return groups.map((group, index) => {
    const next = groups[index + 1];
    const endedAt = next?.[0]?.occurredAt ?? null;

    let originTerminalId: string | null = null;
    let destTerminalId: string | null = null;
    let netWeightT: number | null = null;
    let commodityCode: string | null = null;

    for (const event of group) {
      if (event.eventType === "PLACED_FOR_LOADING" && event.terminalId) {
        originTerminalId = event.terminalId;
      }
      if (event.eventType === "PLACED_FOR_UNLOADING" && event.terminalId) {
        destTerminalId = event.terminalId;
      }
      if (
        event.eventType === "LOADING_COMPLETE" ||
        event.eventType === "LOADED_RELEASED"
      ) {
        netWeightT =
          numberFrom(
            (event.payload as { netWeightT?: unknown } | null)?.netWeightT,
          ) ?? netWeightT;

        const code = (event.payload as { commodityCode?: unknown } | null)
          ?.commodityCode;
        if (typeof code === "string" && code.length > 0) commodityCode = code;
      }
    }

    return {
      cycleId: group.find((event) => event.cycleId)?.cycleId ?? null,
      startedAt: group[0].occurredAt,
      endedAt,
      isClosed: endedAt !== null,
      eventCount: group.length,
      originTerminalId,
      destTerminalId,
      netWeightT,
      commodityCode,
      events: group,
    };
  });
};

export { IllegalTransitionError, legalEventsFrom };

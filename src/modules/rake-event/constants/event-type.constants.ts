/**
 * What each event type *means* to the projection.
 *
 * The enum in `schema/enums.schema.ts` is the vocabulary — the list of things
 * that can be said. This file is the semantics: for every word, which state it
 * leaves the rake in, whether it moves the rake's position, and whether it is
 * the kind of event that opens or closes a turnaround.
 *
 * All four maps are keyed by `RakeEventType` with no index signature, so adding
 * an event to the enum without deciding what it does here is a **compile
 * error**. That is the whole reason they are `Record<RakeEventType, …>` rather
 * than partial lookups with a default: an event the projection silently ignores
 * would be accepted by the API, stored, and never applied — the worst possible
 * outcome for an append-only log whose entire promise is that it is the truth.
 */
import type { RakeEventType, RakeState } from "../../../schema";

/**
 * A sentinel, not a state.
 *
 * `DETENTION_CLEARED` and its three siblings do not move the rake to a fixed
 * state — they move it back to whatever it was doing before the exception
 * interrupted it, which is `rake_state.previous_state`. Modelling that as a
 * string in the same map as the real targets keeps the table exhaustive
 * without inventing a "RESTORED" state nothing can ever be in.
 */
export const RESTORE_PREVIOUS = "__PREVIOUS__" as const;

export type EventTarget = RakeState | typeof RESTORE_PREVIOUS | null;

/**
 * The state each event leaves the rake in. `null` means **no state change** —
 * the event still lands in the log, still moves the position, and is still part
 * of the cycle, but the state machine does not advance.
 *
 * The three `null`s are each load-bearing:
 *
 *  - `SECTION_PASSED` is the ETA engine's raw material (§5.4). A rake crossing
 *    forty sections between two terminals is one state and forty position
 *    updates, not forty states.
 *  - `ARRIVED_LOADING_YARD` is the yard, not the siding. The rake is still
 *    `MOVING_TO_LOADING` until it is actually placed — which is what starts the
 *    demurrage clock, and therefore not a distinction to blur.
 *  - `CORRECTION` says something about an earlier event, not about now. Its
 *    effect is whatever re-projecting the cycle produces.
 */
export const TARGET_STATE: Record<RakeEventType, EventTarget> = {
  ALLOTTED: "ALLOTTED",
  DEPARTED_EMPTY: "MOVING_TO_LOADING",
  ARRIVED_LOADING_YARD: null,
  PLACED_FOR_LOADING: "PLACED_FOR_LOADING",
  LOADING_STARTED: "LOADING",
  LOADING_COMPLETE: "LOADING",
  LOADED_RELEASED: "LOADED_RELEASED",
  DEPARTED_ORIGIN: "IN_TRANSIT_LOADED",
  SECTION_PASSED: null,
  ARRIVED_DEST: "AT_DEST_YARD",
  PLACED_FOR_UNLOADING: "PLACED_FOR_UNLOADING",
  UNLOADING_STARTED: "UNLOADING",
  UNLOADING_COMPLETE: "UNLOADING",
  UNLOADED_RELEASED: "UNLOADED_RELEASED",
  DEPARTED_EMPTY_RETURN: "EMPTY_RETURNING",
  EMPTY_AVAILABLE: "EMPTY_AVAILABLE",

  DETAINED: "DETAINED",
  DETENTION_CLEARED: RESTORE_PREVIOUS,
  MARKED_SICK: "SICK",
  SICK_CLEARED: RESTORE_PREVIOUS,
  DIVERTED: "DIVERTED",
  DIVERSION_CLEARED: RESTORE_PREVIOUS,
  HELD_FOR_ORDER: "HELD_FOR_ORDER",
  HOLD_RELEASED: RESTORE_PREVIOUS,

  CORRECTION: null,
};

/**
 * The four exception states, and the event that ends each one.
 *
 * Read as a pair with `EXCEPTION_ENTRY` below: entry is legal from anywhere,
 * exit is legal only from the matching state. That asymmetry is what an
 * exception *is* — anything can go wrong at any time, but only the specific
 * thing that went wrong can be declared over.
 */
export const EXCEPTION_EXIT: Partial<Record<RakeState, RakeEventType>> = {
  DETAINED: "DETENTION_CLEARED",
  SICK: "SICK_CLEARED",
  DIVERTED: "DIVERSION_CLEARED",
  HELD_FOR_ORDER: "HOLD_RELEASED",
};

/** The four states a rake can be interrupted into. */
export const EXCEPTION_STATES = Object.keys(
  EXCEPTION_EXIT,
) as readonly RakeState[];

export const isExceptionState = (state: RakeState): boolean =>
  state in EXCEPTION_EXIT;

/**
 * Events that carry a new position for the rake.
 *
 * Not every event does. `LOADING_COMPLETE` says nothing about where the rake
 * is — it is already at the siding — so an event submitted without a
 * `station_code` must not blank the position the projection already holds.
 * Anything not in this set leaves `station_code`/`terminal_id` alone.
 */
export const POSITION_EVENTS: ReadonlySet<RakeEventType> =
  new Set<RakeEventType>([
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "SECTION_PASSED",
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
    "UNLOADED_RELEASED",
    "DEPARTED_EMPTY_RETURN",
    "EMPTY_AVAILABLE",
    "DIVERTED",
  ]);

/**
 * Events after which the rake is **not at a terminal** any more.
 *
 * Without this, `rake_states.terminal_id` is write-only: it is set by a
 * placement and never cleared, so a rake that unloaded at Pune three journeys
 * ago still reads as standing on Pune's line. Phase 7's solver reads that
 * column for its congestion term and Phase 8 writes `terminal_occupancy` from
 * it, so a stale value is not an untidy field — it is a terminal that looks
 * permanently occupied by stock which left days ago.
 *
 * A *release* does not clear it: `LOADED_RELEASED` means the paperwork is done,
 * not that the rake has moved, and it is still on the line until it departs.
 * Departure and arrival elsewhere are what actually free the line.
 */
export const CLEARS_TERMINAL: ReadonlySet<RakeEventType> =
  new Set<RakeEventType>([
    "DEPARTED_EMPTY",
    "DEPARTED_ORIGIN",
    "DEPARTED_EMPTY_RETURN",
    "SECTION_PASSED",
    "ARRIVED_LOADING_YARD",
    "ARRIVED_DEST",
    "EMPTY_AVAILABLE",
    "DIVERTED",
  ]);

/**
 * The event that opens a turnaround.
 *
 * A cycle runs `EMPTY_AVAILABLE → … → UNLOADED_RELEASED`, and the **next**
 * `EMPTY_AVAILABLE` both closes it and opens the one after. That boundary is
 * chosen to match §5.2 exactly: the attribution bucket `emptyReturn` is
 * `NEXT_EMPTY_AVAILABLE − UNLOAD_RELEASE`, so cycle N's `ended_at` has to be
 * cycle N+1's `started_at` or the empty haul belongs to no cycle at all.
 */
export const CYCLE_OPENING_EVENT: RakeEventType = "EMPTY_AVAILABLE";

/** The event after which a cycle is complete but not yet closed. */
export const CYCLE_COMPLETING_EVENT: RakeEventType = "UNLOADED_RELEASED";

/** Grouping used by the map legend and the rake list's status filter. */
export const STATE_GROUP: Record<
  RakeState,
  "empty" | "moving" | "at_terminal" | "exception"
> = {
  EMPTY_AVAILABLE: "empty",
  ALLOTTED: "empty",
  MOVING_TO_LOADING: "moving",
  PLACED_FOR_LOADING: "at_terminal",
  LOADING: "at_terminal",
  LOADED_RELEASED: "at_terminal",
  IN_TRANSIT_LOADED: "moving",
  AT_DEST_YARD: "moving",
  PLACED_FOR_UNLOADING: "at_terminal",
  UNLOADING: "at_terminal",
  UNLOADED_RELEASED: "at_terminal",
  EMPTY_RETURNING: "moving",
  DETAINED: "exception",
  SICK: "exception",
  DIVERTED: "exception",
  HELD_FOR_ORDER: "exception",
};

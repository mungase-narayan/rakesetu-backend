/**
 * The legal-transition table, as data (DESIGN.md §5.1).
 *
 * `LEGAL_TRANSITIONS[state]` lists the events that are allowed **while the rake
 * is in that state**. Three rules layer on top of it and are applied by
 * `isLegal()` rather than being copied into every row:
 *
 *  1. an `EXCEPTION_ENTRY` event is legal from any *operational* state — that
 *     is what makes it an exception rather than a step;
 *  2. `CORRECTION` is legal from every state, because a correction is a
 *     statement about the past and the present state is irrelevant to it;
 *  3. everything else is illegal, and an illegal transition is **rejected with
 *     a 409 and written to the log with `applied = false`**. §5.1 says illegal
 *     transitions are "logged as anomalies, never silently applied"; both
 *     halves matter, and the second is why the attempt survives the rejection.
 *
 * Keeping it as a table rather than a `switch` is what makes the property test
 * possible: the suite enumerates the full 16 × 24 cross-product and asserts
 * that exactly the pairs in here succeed. A `switch` would have to be read by a
 * human to know what it permits.
 */
import type { RakeEventType, RakeState } from "../../../schema";
import { EXCEPTION_EXIT, isExceptionState } from "./event-type.constants";

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: RakeState,
    public readonly event: RakeEventType,
    public readonly legal: readonly RakeEventType[],
  ) {
    super(
      `${event} is not legal from ${from} — legal events here are: ${legal.join(", ") || "none"}`,
    );
    this.name = "IllegalTransitionError";
  }
}

/**
 * The four events that can interrupt any operational state.
 *
 * Deliberately *not* legal from another exception state. A rake that is already
 * `SICK` and is then detained is a data-entry problem, not a real double
 * exception: `previous_state` holds one slot, so nesting them would silently
 * lose the state the rake has to return to.
 */
export const EXCEPTION_ENTRY: readonly RakeEventType[] = [
  "DETAINED",
  "MARKED_SICK",
  "DIVERTED",
  "HELD_FOR_ORDER",
];

export const LEGAL_TRANSITIONS: Record<RakeState, readonly RakeEventType[]> = {
  /**
   * `EMPTY_AVAILABLE` is legal from `EMPTY_AVAILABLE`, and that is not a
   * self-loop for its own sake. It is the **cycle-opening event**, so refusing
   * it here would make the first event of an idle rake's life impossible —
   * every rake seeded as available could never be given a turnaround at all.
   * It is also a real message: empty stock can be declared available a second
   * time when it is re-offered at a different pool, and each declaration is
   * genuinely a new turnaround boundary.
   */
  EMPTY_AVAILABLE: ["EMPTY_AVAILABLE", "ALLOTTED"],
  ALLOTTED: ["DEPARTED_EMPTY"],
  // The yard arrival and the section crossings are position updates; only the
  // placement advances the state — and it is the placement that starts the
  // demurrage clock, so the distinction is money.
  MOVING_TO_LOADING: [
    "SECTION_PASSED",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
  ],
  PLACED_FOR_LOADING: ["LOADING_STARTED"],
  // `LOADING_COMPLETE` carries the net weight and keeps the rake in LOADING:
  // the wagons are full, the paperwork is not done, and the free time has not
  // stopped running until the release.
  LOADING: ["LOADING_COMPLETE", "LOADED_RELEASED"],
  LOADED_RELEASED: ["DEPARTED_ORIGIN"],
  IN_TRANSIT_LOADED: ["SECTION_PASSED", "ARRIVED_DEST"],
  AT_DEST_YARD: ["PLACED_FOR_UNLOADING"],
  PLACED_FOR_UNLOADING: ["UNLOADING_STARTED"],
  UNLOADING: ["UNLOADING_COMPLETE", "UNLOADED_RELEASED"],
  // Two exits, and both are real. A rake released at a destination that is also
  // an empty pool goes straight back to available; one that has to run home
  // first spends the interval in EMPTY_RETURNING, which is the state §5.2's
  // `emptyReturn` bucket measures.
  UNLOADED_RELEASED: ["DEPARTED_EMPTY_RETURN", "EMPTY_AVAILABLE"],
  EMPTY_RETURNING: ["SECTION_PASSED", "EMPTY_AVAILABLE"],

  DETAINED: ["DETENTION_CLEARED"],
  SICK: ["SICK_CLEARED"],
  DIVERTED: ["DIVERSION_CLEARED"],
  HELD_FOR_ORDER: ["HOLD_RELEASED"],
};

/**
 * Everything permitted from a state, exception entries and `CORRECTION`
 * included. This is what a 409 body shows the caller — a list that omitted the
 * exception events would be a lie about what the API accepts.
 */
export const legalEventsFrom = (from: RakeState): readonly RakeEventType[] => {
  const base = LEGAL_TRANSITIONS[from] ?? [];
  return isExceptionState(from)
    ? [...base, "CORRECTION"]
    : [...base, ...EXCEPTION_ENTRY, "CORRECTION"];
};

export const isLegal = (from: RakeState, event: RakeEventType): boolean => {
  if (event === "CORRECTION") return true;
  if (LEGAL_TRANSITIONS[from]?.includes(event)) return true;
  return !isExceptionState(from) && EXCEPTION_ENTRY.includes(event);
};

/**
 * Sanity check run once at import: every state must be escapable and every
 * exception must have its exit wired.
 *
 * A state with no outgoing events is a rake that disappears from the fleet —
 * still on the books, never allottable again, and impossible to notice from any
 * screen. Catching it at boot costs nothing and the alternative is finding it
 * in a demo.
 */
const assertNoDeadEnds = (): void => {
  for (const [state, events] of Object.entries(LEGAL_TRANSITIONS)) {
    if (events.length === 0) {
      throw new Error(
        `LEGAL_TRANSITIONS: "${state}" has no outgoing event — a rake entering it could never leave`,
      );
    }
  }
  for (const [state, exit] of Object.entries(EXCEPTION_EXIT)) {
    if (!LEGAL_TRANSITIONS[state as RakeState]?.includes(exit)) {
      throw new Error(
        `LEGAL_TRANSITIONS: exception state "${state}" does not permit its exit event "${exit}"`,
      );
    }
  }
};

assertNoDeadEnds();

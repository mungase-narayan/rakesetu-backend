/**
 * Hand-built event sequences for the state-machine tests.
 *
 * These exist because the simulator deliberately **cannot** produce them.
 * `journey.generator.ts` promises it can only generate a legal history, so the
 * illegal transition, the correction and the mis-ordered arrival have to be
 * written by hand — a test that relied on the simulator to misbehave would be
 * testing a bug rather than a property.
 *
 * Pure data. No database, no clock: `at(n)` is an offset from a fixed epoch, so
 * every scenario is the same instants on every machine and a failure message
 * quotes a timestamp that means something.
 */
import type { RakeEventType } from "../../src/schema";
import type { FoldableEvent } from "../../src/modules/rake-event/services/state-machine.service";

/** A fixed Monday, so nothing here depends on when the suite runs. */
export const EPOCH = new Date("2026-03-02T00:00:00.000Z");

const HOUR = 60 * 60 * 1000;

/** `at(6)` → six hours after the epoch. */
export const at = (hours: number): Date =>
  new Date(EPOCH.getTime() + hours * HOUR);

let counter = 0;

/**
 * Ids are sequential and zero-padded, not random.
 *
 * `project()` breaks `occurred_at` ties on `id`, so a random id would make two
 * simultaneous events fold in a different order per run — which is exactly the
 * non-determinism the suite is meant to catch, arriving as a flake instead.
 */
export const event = (
  eventType: RakeEventType,
  occurredAt: Date,
  extra: Partial<FoldableEvent> = {},
): FoldableEvent => ({
  id: `evt-${String((counter += 1)).padStart(6, "0")}`,
  eventType,
  occurredAt,
  stationCode: null,
  terminalId: null,
  cycleId: null,
  payload: {},
  ...extra,
});

export const resetIds = (): void => {
  counter = 0;
};

/** A textbook turnaround: available → loaded → delivered → available again. */
export const cleanCycle = (): FoldableEvent[] => [
  event("EMPTY_AVAILABLE", at(0), { stationCode: "KWV" }),
  event("ALLOTTED", at(2)),
  event("DEPARTED_EMPTY", at(4), { stationCode: "KWV" }),
  event("SECTION_PASSED", at(6), {
    stationCode: "WSD",
    payload: { fromCode: "KWV", toCode: "WSD", sectionId: "s1" },
  }),
  event("ARRIVED_LOADING_YARD", at(8), { stationCode: "SUR" }),
  event("PLACED_FOR_LOADING", at(10), {
    stationCode: "SUR",
    terminalId: "t-origin",
  }),
  event("LOADING_STARTED", at(12), { terminalId: "t-origin" }),
  event("LOADING_COMPLETE", at(20), {
    terminalId: "t-origin",
    payload: { netWeightT: 2800, wagonsLoaded: 48 },
  }),
  event("LOADED_RELEASED", at(22), {
    stationCode: "SUR",
    terminalId: "t-origin",
    payload: { netWeightT: 2800 },
  }),
  event("DEPARTED_ORIGIN", at(24), { stationCode: "SUR" }),
  event("SECTION_PASSED", at(30), {
    stationCode: "PUNE",
    payload: { fromCode: "SUR", toCode: "PUNE", sectionId: "s2" },
  }),
  event("ARRIVED_DEST", at(34), { stationCode: "PUNE" }),
  event("PLACED_FOR_UNLOADING", at(38), {
    stationCode: "PUNE",
    terminalId: "t-dest",
  }),
  event("UNLOADING_STARTED", at(40), { terminalId: "t-dest" }),
  event("UNLOADING_COMPLETE", at(48), { terminalId: "t-dest" }),
  event("UNLOADED_RELEASED", at(50), {
    stationCode: "PUNE",
    terminalId: "t-dest",
  }),
  // Closes the cycle above and opens the next.
  event("EMPTY_AVAILABLE", at(56), { stationCode: "PUNE" }),
];

/**
 * The same cycle with one crossing delivered after the crossing that follows
 * it. Folding it must produce exactly `cleanCycle`'s answer.
 */
export const outOfOrderCycle = (
  /**
   * The ordered history to disorder.
   *
   * Passed in rather than built here, because `event()` mints sequential ids:
   * calling `cleanCycle()` twice yields two histories that differ in their ids,
   * and comparing their projections would then fail on `lastEventId` — a
   * difference in the *fixture*, not in the fold. The caller builds one array
   * and hands it to both sides.
   */
  base: FoldableEvent[] = cleanCycle(),
): FoldableEvent[] => {
  const first = base.findIndex((e) => e.eventType === "SECTION_PASSED");
  const swapped = [...base];
  [swapped[first], swapped[first + 1]] = [swapped[first + 1], swapped[first]];
  return swapped;
};

/** An exception opened and cleared: the rake must return to what it was doing. */
export const exceptionRoundTrip = (): FoldableEvent[] => [
  event("EMPTY_AVAILABLE", at(0), { stationCode: "KWV" }),
  event("ALLOTTED", at(2)),
  event("DEPARTED_EMPTY", at(4), { stationCode: "KWV" }),
  event("ARRIVED_LOADING_YARD", at(8), { stationCode: "SUR" }),
  event("PLACED_FOR_LOADING", at(10), { terminalId: "t-origin" }),
  event("DETAINED", at(12), { payload: { reasonCode: "labour_unavailable" } }),
  event("DETENTION_CLEARED", at(30)),
  event("LOADING_STARTED", at(32), { terminalId: "t-origin" }),
];

/** An illegal attempt in the middle of an otherwise fine history. */
export const withIllegalTransition = (): FoldableEvent[] => [
  event("EMPTY_AVAILABLE", at(0), { stationCode: "KWV" }),
  event("ALLOTTED", at(2)),
  // Nothing has been loaded and the rake has not moved. Refused, kept.
  event("UNLOADING_COMPLETE", at(3)),
  event("DEPARTED_EMPTY", at(4), { stationCode: "KWV" }),
];

/**
 * A correction against an earlier event.
 *
 * The corrected row is untouched — that is the property. The correction is an
 * additional row that says what the earlier one should have said, and the
 * answer comes from re-folding, never from an UPDATE.
 */
export const withCorrection = (): FoldableEvent[] => {
  const events = cleanCycle();
  const loading = events.find((e) => e.eventType === "LOADING_COMPLETE");
  return [
    ...events,
    event("CORRECTION", at(58), {
      payload: {
        correctsEventId: loading?.id ?? "unknown",
        reason: "Weighbridge re-read after the RR was queried",
        fields: { netWeightT: 2750 },
      },
    }),
  ];
};

export const SCENARIOS = {
  cleanCycle,
  outOfOrderCycle,
  exceptionRoundTrip,
  withIllegalTransition,
  withCorrection,
};

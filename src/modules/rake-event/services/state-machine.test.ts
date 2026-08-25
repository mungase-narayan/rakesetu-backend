/**
 * The state machine, tested as a pure function.
 *
 * **This file imports no database module, and that is an acceptance criterion**
 * (T4.5), not a stylistic preference — §5 makes the deterministic engines pure
 * *specifically so* they can be tested without one. A test at the bottom greps
 * the module's own source to prove it, so the property survives a future import
 * somebody adds without thinking.
 *
 * The determinism suite is the single most important thing in the phase: §13.2
 * claims that re-running the projection from the event log produces identical
 * state, and everything downstream — Phase 8's TAT, Phase 9's charges — is a
 * fold over this same log.
 */
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { RAKE_EVENT_TYPES, RAKE_STATES } from "../../../schema";
import type { RakeState } from "../../../schema";
import {
  EXCEPTION_ENTRY,
  IllegalTransitionError,
  LEGAL_TRANSITIONS,
  isLegal,
  legalEventsFrom,
} from "../constants/transitions.constants";
import {
  TARGET_STATE,
  RESTORE_PREVIOUS,
} from "../constants/event-type.constants";
import {
  initialProjection,
  nextState,
  project,
  sortEvents,
  splitCycles,
  type FoldableEvent,
} from "./state-machine.service";
import {
  at,
  cleanCycle,
  event,
  exceptionRoundTrip,
  outOfOrderCycle,
  withCorrection,
  withIllegalTransition,
} from "../../../../scripts/fixtures/event-scenarios";

const SEED = initialProjection(at(-1), "KWV");

/**
 * Generates a **legal** walk through the state machine.
 *
 * Random event sequences would be almost entirely illegal and would test the
 * rejection path forty times over while never exercising a real history. This
 * walks the transition table instead, so every generated case is a history the
 * product could actually have.
 */
const legalWalk = (length: number) =>
  fc
    .array(fc.nat(), { minLength: length, maxLength: length })
    .map((choices) => {
      let state: RakeState = "EMPTY_AVAILABLE";
      let previous: RakeState | null = null;
      const events: FoldableEvent[] = [];

      choices.forEach((choice, index) => {
        const options = legalEventsFrom(state).filter(
          (candidate) => candidate !== "CORRECTION",
        );
        const eventType = options[choice % options.length];
        events.push(event(eventType, at(index), { stationCode: "KWV" }));
        const next = nextState(state, eventType, previous);
        previous =
          next !== state &&
          (next === "DETAINED" ||
            next === "SICK" ||
            next === "DIVERTED" ||
            next === "HELD_FOR_ORDER")
            ? state
            : next !== state
              ? null
              : previous;
        state = next;
      });

      return events;
    });

describe("determinism (§13.2)", () => {
  it("projecting the same events twice produces identical output", () => {
    fc.assert(
      fc.property(legalWalk(30), (events) => {
        const first = project(events, { startFrom: SEED });
        const second = project(events, { startFrom: SEED });
        expect(second.projection).toEqual(first.projection);
        expect(second.applied.map((e) => e.id)).toEqual(
          first.applied.map((e) => e.id),
        );
      }),
      { numRuns: 120 },
    );
  });

  /**
   * The property the whole phase rests on: **arrival order does not matter**.
   *
   * A supervisor's phone reconnects the next morning, a FOIS batch replays, the
   * simulator delivers a crossing late. If the answer depended on which order
   * the rows landed in, every number computed downstream would depend on
   * network weather.
   */
  it("shuffling arrival order while keeping occurred_at changes nothing", () => {
    fc.assert(
      fc.property(
        legalWalk(30),
        fc.array(fc.nat(), { maxLength: 60 }),
        (events, swaps) => {
          const shuffled = [...events];
          for (let i = 0; i + 1 < swaps.length; i += 2) {
            const a = swaps[i] % shuffled.length;
            const b = swaps[i + 1] % shuffled.length;
            [shuffled[a], shuffled[b]] = [shuffled[b], shuffled[a]];
          }

          expect(project(shuffled, { startFrom: SEED }).projection).toEqual(
            project(events, { startFrom: SEED }).projection,
          );
        },
      ),
      { numRuns: 120 },
    );
  });

  it("the fixed out-of-order scenario folds to the clean cycle's answer", () => {
    // One base array for both sides: `event()` mints sequential ids, so two
    // separate `cleanCycle()` calls would differ in `lastEventId` and the
    // assertion would fail on the fixture rather than on the fold.
    const ordered = cleanCycle();

    expect(
      project(outOfOrderCycle(ordered), { startFrom: SEED }).projection,
    ).toEqual(project(ordered, { startFrom: SEED }).projection);
  });

  /**
   * The canary. Removing the `occurred_at` sort must break this — T4.17's
   * acceptance criterion — so the test asserts the sort is doing work rather
   * than assuming it.
   */
  it("sortEvents orders by occurred_at and breaks ties on id", () => {
    const unsorted = [
      event("SECTION_PASSED", at(5), {}),
      event("SECTION_PASSED", at(1), {}),
      event("SECTION_PASSED", at(3), {}),
    ];
    expect(sortEvents(unsorted).map((e) => e.occurredAt.getTime())).toEqual([
      at(1).getTime(),
      at(3).getTime(),
      at(5).getTime(),
    ]);
    // And it copies rather than mutating the caller's array.
    expect(unsorted[0].occurredAt.getTime()).toBe(at(5).getTime());
  });
});

describe("legal transitions", () => {
  it("every (state, event) pair outside the table throws", () => {
    for (const state of RAKE_STATES) {
      for (const eventType of RAKE_EVENT_TYPES) {
        const legal = isLegal(state, eventType);

        if (legal) {
          expect(() => nextState(state, eventType)).not.toThrow();
        } else {
          expect(() => nextState(state, eventType)).toThrow(
            IllegalTransitionError,
          );
        }
      }
    }
  });

  it("every state can be left", () => {
    for (const state of RAKE_STATES) {
      expect(LEGAL_TRANSITIONS[state].length).toBeGreaterThan(0);
    }
  });

  it("every event has a target, and every target is a real state", () => {
    for (const eventType of RAKE_EVENT_TYPES) {
      const target = TARGET_STATE[eventType];
      if (target !== null && target !== RESTORE_PREVIOUS) {
        expect(RAKE_STATES).toContain(target);
      }
    }
  });

  it("an exception may be entered from any operational state and no other", () => {
    for (const state of RAKE_STATES) {
      const operational = !EXCEPTION_ENTRY.some(
        (entry) => TARGET_STATE[entry] === state,
      );
      for (const entry of EXCEPTION_ENTRY) {
        expect(isLegal(state, entry)).toBe(operational);
      }
    }
  });

  it("a correction is legal from everywhere and moves nothing", () => {
    for (const state of RAKE_STATES) {
      expect(isLegal(state, "CORRECTION")).toBe(true);
      expect(nextState(state, "CORRECTION")).toBe(state);
    }
  });

  it("the 409 body's legal set is exactly what isLegal accepts", () => {
    for (const state of RAKE_STATES) {
      const listed = new Set(legalEventsFrom(state));
      for (const eventType of RAKE_EVENT_TYPES) {
        expect(listed.has(eventType)).toBe(isLegal(state, eventType));
      }
    }
  });
});

describe("exception round-trip", () => {
  it("clearing an exception returns the rake to what it interrupted", () => {
    const result = project(exceptionRoundTrip(), { startFrom: SEED });
    // DETAINED interrupted PLACED_FOR_LOADING, and LOADING_STARTED then moved
    // it on — which is only reachable if the restore actually happened.
    expect(result.projection.state).toBe("LOADING");
    expect(result.rejected).toHaveLength(0);
  });

  it("previous_state is cleared once the rake moves on", () => {
    const result = project(exceptionRoundTrip(), { startFrom: SEED });
    expect(result.projection.previousState).toBeNull();
  });

  it("any operational state survives an exception and returns", () => {
    const operational = RAKE_STATES.filter(
      (state) =>
        !["DETAINED", "SICK", "DIVERTED", "HELD_FOR_ORDER"].includes(state),
    );

    for (const state of operational) {
      const detained = nextState(state, "DETAINED");
      expect(detained).toBe("DETAINED");
      expect(nextState(detained, "DETENTION_CLEARED", state)).toBe(state);
    }
  });
});

describe("cycles", () => {
  it("EMPTY_AVAILABLE opens a cycle and the next one closes it", () => {
    const groups = splitCycles(cleanCycle());
    expect(groups).toHaveLength(2);
    expect(groups[1]).toHaveLength(1);

    const [first] = project(cleanCycle(), { startFrom: SEED }).cycles;
    expect(first.isClosed).toBe(true);
    // Cycle N's end is cycle N+1's start — §5.2's `emptyReturn` bucket is
    // defined across exactly that boundary.
    expect(first.endedAt?.getTime()).toBe(at(56).getTime());
    expect(first.eventCount).toBe(16);
  });

  it("the open cycle stays open", () => {
    const cycles = project(cleanCycle(), { startFrom: SEED }).cycles;
    expect(cycles[cycles.length - 1].isClosed).toBe(false);
    expect(cycles[cycles.length - 1].endedAt).toBeNull();
  });

  it("a cycle carries the weight and terminals its events reported", () => {
    const [first] = project(cleanCycle(), { startFrom: SEED }).cycles;
    expect(first.netWeightT).toBe(2800);
    expect(first.originTerminalId).toBe("t-origin");
    expect(first.destTerminalId).toBe("t-dest");
  });
});

describe("anomalies and corrections", () => {
  it("an illegal event is recorded, skipped, and does not derail the fold", () => {
    const result = project(withIllegalTransition(), { startFrom: SEED });

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].event.eventType).toBe("UNLOADING_COMPLETE");
    expect(result.rejected[0].from).toBe("ALLOTTED");
    // The events after it still applied — a refusal is not a stop.
    expect(result.projection.state).toBe("MOVING_TO_LOADING");
  });

  it("a correction never mutates the event it corrects", () => {
    const events = withCorrection();
    const corrected = events.find((e) => e.eventType === "LOADING_COMPLETE");

    const before = JSON.stringify(corrected?.payload);
    project(events, { startFrom: SEED });
    expect(JSON.stringify(corrected?.payload)).toBe(before);
  });

  it("a correction moves no state", () => {
    const withoutCorrection = cleanCycle();
    const both = withCorrection();

    expect(project(both, { startFrom: SEED }).projection.state).toBe(
      project(withoutCorrection, { startFrom: SEED }).projection.state,
    );
  });
});

describe("purity (T4.5)", () => {
  /**
   * Greps the source rather than trusting the import list to stay clean.
   *
   * A DB import here would not fail any other test — it would simply make the
   * engine untestable without a container, and that regression is invisible
   * until somebody tries. This is the check that makes it visible immediately.
   */
  it("the state machine imports nothing from database/, and no clock", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "state-machine.service.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'].*database\//);
    expect(source).not.toMatch(/drizzle-orm/);
    expect(source).not.toMatch(/Math\.random/);
    // `new Date(0)` is the empty-stream fallback and is a constant, not a clock.
    expect(source).not.toMatch(/Date\.now\(\)/);
    expect(source).not.toMatch(/new Date\(\)/);
  });
});

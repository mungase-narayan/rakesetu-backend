/**
 * The simulator's two contracts.
 *
 * §14 leans on the synthetic feed as the substitute for a live FOIS one, and a
 * substitute is only as good as the promises it keeps:
 *
 *  1. **`--seed N` twice produces an identical stream** — otherwise no test can
 *     assert against generated history and no two developers can discuss the
 *     same run.
 *  2. **It cannot generate an illegal history** — the anomaly path belongs to
 *     hand-built fixtures. A source that occasionally emitted nonsense would
 *     make every refusal in a demo ambiguous: a bug in the product, or a bug in
 *     the data?
 *
 * `from` and `to` are fixed here rather than derived from the clock. The script
 * uses `now`, which is right for a demo and useless for a test — the same seed
 * over a different window is a different stream, and that is a property of the
 * window, not a failure of the seed.
 */
import { describe, expect, it } from "vitest";

import { buildGraph } from "../../network/services/graph";
import {
  isLegalTransition,
  nextState,
} from "../../rake-event/services/state-machine.service";
import type { RakeState } from "../../../schema";
import {
  DEFAULT_RATES,
  generateJourneys,
  makeRandom,
  type World,
} from "./journey.generator";
import FoisSource from "./fois.source";

const FROM = new Date("2026-05-01T00:00:00.000Z");
const TO = new Date("2026-05-15T00:00:00.000Z");

/**
 * A miniature network — four stations on a line, two terminals.
 *
 * Hand-built rather than loaded from the seed, so the suite runs without a
 * database and so a change to the seeded division cannot silently change what
 * this file is asserting.
 */
const world = (): World => ({
  rakes: [
    {
      id: "rake-1",
      code: "R-9001",
      wagonCount: 42,
      wagonTypeCode: "BOXNHL",
      ccT: 58,
      homeDivision: "Solapur",
      startStation: "AAA",
      resumeState: "EMPTY_AVAILABLE",
      resumeAt: null,
    },
    {
      id: "rake-2",
      code: "R-9002",
      wagonCount: 58,
      wagonTypeCode: "BCNA",
      ccT: 61,
      homeDivision: "Pune",
      startStation: "DDD",
      resumeState: "EMPTY_AVAILABLE",
      resumeAt: null,
    },
  ],
  terminals: [
    {
      id: "term-1",
      code: "AAA-GS",
      stationCode: "AAA",
      avgPlacementMinutes: 90,
      isMechanised: true,
      placementLines: 3,
      commodityGroups: ["cement"],
      maxRakeLength: 58,
    },
    {
      id: "term-2",
      code: "DDD-GS",
      stationCode: "DDD",
      // One line and a long placement: the bottleneck shape Phase 8 needs.
      avgPlacementMinutes: 240,
      isMechanised: false,
      placementLines: 1,
      commodityGroups: ["coal"],
      maxRakeLength: 58,
    },
  ],
  graph: buildGraph([
    { id: "s1", from: "AAA", to: "BBB", distanceKm: 60, nominalSpeedKmph: 45 },
    { id: "s2", from: "BBB", to: "CCC", distanceKm: 55, nominalSpeedKmph: 45 },
    { id: "s3", from: "CCC", to: "DDD", distanceKm: 70, nominalSpeedKmph: 50 },
    { id: "s4", from: "DDD", to: "CCC", distanceKm: 70, nominalSpeedKmph: 50 },
    { id: "s5", from: "CCC", to: "BBB", distanceKm: 55, nominalSpeedKmph: 45 },
    { id: "s6", from: "BBB", to: "AAA", distanceKm: 60, nominalSpeedKmph: 45 },
  ]),
  commoditiesByGroup: new Map([
    ["cement", ["CEM"]],
    ["coal", ["COAL"]],
  ]),
});

const generate = (seed: number, runRef = "test") =>
  generateJourneys({ world: world(), from: FROM, to: TO, seed, runRef });

/**
 * A long window, for the assertions that are **statistical**.
 *
 * Detention fires on 18% of loadings and sick wagons on 6%; two rakes over a
 * fortnight is four turnarounds, and asserting that a 6% event appears in four
 * trials is asserting a coin lands heads. Widening the window is the honest fix
 * — the alternative is a flaky test or a rate tuned to make a test pass.
 */
const LONG_TO = new Date(FROM.getTime() + 400 * 24 * 60 * 60 * 1000);
const generateLong = (seed: number) =>
  generateJourneys({
    world: world(),
    from: FROM,
    to: LONG_TO,
    seed,
    runRef: "long",
  });

describe("determinism", () => {
  it("the same seed produces an identical stream", () => {
    const a = generate(42);
    const b = generate(42);

    expect(b).toHaveLength(a.length);
    expect(
      b.map((e) => `${e.rakeId}|${e.eventType}|${e.occurredAt.toISOString()}`),
    ).toEqual(
      a.map((e) => `${e.rakeId}|${e.eventType}|${e.occurredAt.toISOString()}`),
    );
    expect(b.map((e) => e.idempotencyKey)).toEqual(
      a.map((e) => e.idempotencyKey),
    );
  });

  it("a different seed produces a different stream", () => {
    const a = generate(42);
    const b = generate(43);
    expect(b.map((e) => e.idempotencyKey)).not.toEqual(
      a.map((e) => e.idempotencyKey),
    );
  });

  it("the PRNG itself is reproducible", () => {
    const a = Array.from({ length: 8 }, makeRandom(7));
    const b = Array.from({ length: 8 }, makeRandom(7));
    expect(a).toEqual(b);
  });
});

describe("the generator cannot produce an illegal history", () => {
  /**
   * Folds every rake's stream through the state machine in `occurred_at` order
   * and asserts nothing is refused. This is the property that lets a refusal in
   * a demo mean "the product caught something" rather than "the data was junk".
   */
  it.each([1, 42, 99, 12345])(
    "seed %i produces only legal transitions",
    (seed) => {
      const events = generate(seed);
      expect(events.length).toBeGreaterThan(0);

      const byRake = new Map<string, typeof events>();
      for (const event of events) {
        byRake.set(event.rakeId, [...(byRake.get(event.rakeId) ?? []), event]);
      }

      for (const [rakeId, stream] of byRake) {
        const ordered = [...stream].sort(
          (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
        );

        let state: RakeState = "EMPTY_AVAILABLE";
        let previous: RakeState | null = null;

        for (const event of ordered) {
          expect(
            isLegalTransition(state, event.eventType),
            `${rakeId}: ${event.eventType} from ${state} at ${event.occurredAt.toISOString()}`,
          ).toBe(true);

          const next = nextState(state, event.eventType, previous);
          const isException = [
            "DETAINED",
            "SICK",
            "DIVERTED",
            "HELD_FOR_ORDER",
          ].includes(next);
          if (next !== state) previous = isException ? state : null;
          state = next;
        }
      }
    },
  );

  it("every event carries a unique idempotency key", () => {
    const keys = generate(42).map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("nothing is generated past the window's end", () => {
    // Otherwise every rake finishes its final cycle and the fleet ends up in
    // one or two end-of-cycle states — a map that looks broken.
    for (const event of generate(42)) {
      expect(event.occurredAt.getTime()).toBeLessThanOrEqual(TO.getTime());
    }
  });
});

describe("the injections later phases depend on", () => {
  const events = generateLong(42);
  const typesOf = (type: string) =>
    events.filter((e) => e.eventType === type).length;

  it("emits SECTION_PASSED — Phase 5's ETA history", () => {
    expect(typesOf("SECTION_PASSED")).toBeGreaterThan(0);
    const crossing = events.find((e) => e.eventType === "SECTION_PASSED");
    expect(crossing?.payload).toMatchObject({
      fromCode: expect.any(String),
      toCode: expect.any(String),
      sectionId: expect.any(String),
    });
  });

  it("emits detention — Phase 9's demurrage demo needs someone to charge", () => {
    expect(typesOf("DETAINED")).toBeGreaterThan(0);
    expect(typesOf("DETENTION_CLEARED")).toBe(typesOf("DETAINED"));
  });

  it("emits weather holds — Phase 10's waiver queue needs claimable events", () => {
    expect(typesOf("HELD_FOR_ORDER")).toBeGreaterThan(0);
    expect(typesOf("HOLD_RELEASED")).toBe(typesOf("HELD_FOR_ORDER"));
  });

  it("emits sick wagons — Phase 7's constraint needs stock to refuse", () => {
    expect(typesOf("MARKED_SICK")).toBeGreaterThan(0);
    expect(typesOf("SICK_CLEARED")).toBe(typesOf("MARKED_SICK"));
  });

  it("emits EMPTY_RETURNING legs — §5.2's emptyReturn bucket needs them", () => {
    expect(typesOf("DEPARTED_EMPTY_RETURN")).toBeGreaterThan(0);
  });

  it("delivers some crossings out of order — the re-projection path", () => {
    const outOfOrder = events.filter(
      (event, index) =>
        index > 0 &&
        events[index - 1].rakeId === event.rakeId &&
        events[index - 1].occurredAt.getTime() > event.occurredAt.getTime(),
    );
    expect(outOfOrder.length).toBeGreaterThan(0);
    // And only ever crossings — see `applyOutOfOrder`. Anything else would be
    // an illegal ordering rather than a late one.
    expect(
      outOfOrder.every((event) => event.eventType === "SECTION_PASSED"),
    ).toBe(true);
  });

  it("honours a zero injection rate", () => {
    const quiet = generateJourneys({
      world: world(),
      from: FROM,
      to: LONG_TO,
      seed: 42,
      runRef: "quiet",
      rates: {
        ...DEFAULT_RATES,
        detention: 0,
        rain: 0,
        sick: 0,
        outOfOrder: 0,
      },
    });

    expect(quiet.filter((e) => e.eventType === "DETAINED")).toHaveLength(0);
    expect(quiet.filter((e) => e.eventType === "MARKED_SICK")).toHaveLength(0);
  });
});

describe("the FOIS seam", () => {
  it("is a stub that refuses rather than a stub that returns nothing", () => {
    const source = new FoisSource();
    expect(source.name).toBe("fois");
    // A stub yielding an empty stream would look like a working integration
    // against a quiet feed, which is the failure mode worth refusing.
    return expect(source.start()).rejects.toMatchObject({ statusCode: 501 });
  });

  it("stopping something that never started is a no-op", async () => {
    await expect(new FoisSource().stop()).resolves.toBeUndefined();
  });
});

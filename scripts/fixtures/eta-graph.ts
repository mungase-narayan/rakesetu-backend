/**
 * A five-station network whose every answer can be worked out on paper.
 *
 * The ETA suite asserts against arithmetic done by hand, not against the
 * estimator's own output — which is the only way a test of an estimator means
 * anything. Every distance and speed below divides cleanly, so each section's
 * free-running time is a whole number of minutes and the totals can be checked
 * in the margin:
 *
 * ```
 *            60 km @ 60          90 km @ 45
 *      SA ───────────────► SB ───────────────► SC ──── 40 km @ 40 ──► SE
 *       │      60 min       │      120 min      ▲            60 min
 *       │                   │ 30 km @ 30        │
 *       │ 100 km @ 60       └──────────────► SD ┘ 50 km @ 50
 *       └───────────────────────► 100 min        60 min
 * ```
 *
 * Facts the suite relies on, all of them hand-computed:
 *
 *  - `SA → SC` costs **160 min / 150 km** via SD, beating 180 min via SB. The
 *    path is therefore `SA → SD → SC`, and it is *not* the fewest-hops route —
 *    which is the point: a test whose right answer is also the obvious one
 *    proves nothing about the search.
 *  - `SA → SE` costs **220 min / 190 km** via `SD → SC`.
 *  - `SE` has no outgoing section, so `SE → SA` has **no route** — the typed
 *    error case, on the same graph, with no special fixture.
 *
 * Nothing here touches the database. The graph is built with the same
 * `buildGraph` the real loader uses, so the fixture cannot drift from the shape
 * the production code walks.
 */
import {
  buildGraph,
  type GraphEdge,
  type NetworkGraph,
} from "../../src/modules/network/services/graph";
import {
  weightKey,
  type HourBand,
} from "../../src/modules/eta/constants/eta.constants";
import type {
  SectionWeight,
  SectionWeightMap,
  WeightSource,
} from "../../src/modules/eta/types/eta.types";

export const FIXTURE_STATIONS = ["SA", "SB", "SC", "SD", "SE"] as const;

/** Six directed sections. Minutes are `km / kmph × 60` and all are integers. */
export const FIXTURE_EDGES: GraphEdge[] = [
  { id: "sec-ab", from: "SA", to: "SB", distanceKm: 60, nominalSpeedKmph: 60 },
  { id: "sec-bc", from: "SB", to: "SC", distanceKm: 90, nominalSpeedKmph: 45 },
  { id: "sec-ad", from: "SA", to: "SD", distanceKm: 100, nominalSpeedKmph: 60 },
  { id: "sec-dc", from: "SD", to: "SC", distanceKm: 50, nominalSpeedKmph: 50 },
  { id: "sec-ce", from: "SC", to: "SE", distanceKm: 40, nominalSpeedKmph: 40 },
  { id: "sec-bd", from: "SB", to: "SD", distanceKm: 30, nominalSpeedKmph: 30 },
];

/** Free-running minutes per section, worked out by hand. */
export const FIXTURE_NOMINAL_MINUTES: Record<string, number> = {
  "sec-ab": 60,
  "sec-bc": 120,
  "sec-ad": 100,
  "sec-dc": 60,
  "sec-ce": 60,
  "sec-bd": 60,
};

export const fixtureGraph = (): NetworkGraph => buildGraph(FIXTURE_EDGES);

/** One cell, spelled out — so a test reads as a table rather than as a builder. */
export interface FixtureWeight {
  sectionId: string;
  band: HourBand;
  minutes: number;
  source?: WeightSource;
  samples?: number;
  observedMedianMinutes?: number | null;
}

/**
 * Turns a handful of cells into the map the estimator takes.
 *
 * Deliberately partial: whatever is not listed falls through to the nominal
 * speed on the edge, which is exactly how the cold start behaves in production
 * and therefore exactly what the cold-start cases need to exercise.
 */
export const fixtureWeights = (
  entries: readonly FixtureWeight[],
): SectionWeightMap => {
  const map: SectionWeightMap = new Map();

  for (const entry of entries) {
    const nominal = FIXTURE_NOMINAL_MINUTES[entry.sectionId];
    const cell: SectionWeight = {
      sectionId: entry.sectionId,
      band: entry.band,
      minutes: entry.minutes,
      source: entry.source ?? "observed",
      samples: entry.samples ?? 50,
      nominalMinutes: nominal,
      observedMedianMinutes:
        entry.observedMedianMinutes === undefined
          ? entry.minutes
          : entry.observedMedianMinutes,
    };
    map.set(weightKey(entry.sectionId, entry.band), cell);
  }

  return map;
};

/** The same cell in all four bands — for tests that are not about time of day. */
export const allBands = (
  sectionId: string,
  minutes: number,
  extra: Partial<FixtureWeight> = {},
): FixtureWeight[] =>
  (["night", "morning", "day", "evening"] as const).map((band) => ({
    sectionId,
    band,
    minutes,
    ...extra,
  }));

/**
 * An instant at a given IST hour and minute, on a fixed date.
 *
 * The date is fixed and the zone is explicit so a band test cannot pass or fail
 * according to when it is run — IST is UTC+5:30, so 21:50 IST is 16:20 UTC.
 */
export const istAt = (hour: number, minute = 0): Date => {
  const utcMinutes = hour * 60 + minute - 330;
  return new Date(Date.UTC(2026, 5, 15, 0, 0, 0) + utcMinutes * 60_000);
};

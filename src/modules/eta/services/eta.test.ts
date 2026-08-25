/**
 * The estimator, against arithmetic done by hand (§9).
 *
 * Every expected number in this file was worked out from `eta-graph.ts`'s
 * five-station fixture before the code was run. That is the whole discipline: a
 * test that asserts `estimateEta` returns what `estimateEta` returned is a
 * regression guard, not a proof, and an ETA nobody can reproduce on paper is an
 * ETA nobody can defend in a viva.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  allBands,
  fixtureGraph,
  fixtureWeights,
  istAt,
} from "../../../../scripts/fixtures/eta-graph";
import {
  MIN_OBSERVATIONS,
  hourBandOf,
  weightKey,
} from "../constants/eta.constants";
import { NoRouteError, estimateEta, nominalMinutes } from "./eta.service";
import { blend, median } from "./section-weight.service";

const graph = fixtureGraph();
const NOON = istAt(12);

const estimate = (
  fromCode: string,
  toCode: string,
  weights = fixtureWeights([]),
  departAt = NOON,
) =>
  estimateEta({
    fromCode,
    toCode,
    departAt,
    wagonTypeCode: "BOXNHL",
    graph,
    weights,
  });

describe("ETA purity", () => {
  /**
   * A structural assertion rather than a behavioural one, and it earns its
   * place: the moment `eta.service.ts` can reach the database, every test above
   * it becomes a test of a fixture *plus whatever happens to be in Postgres*,
   * and the "runs entirely off the fixture graph" claim quietly stops being
   * true without a single test going red.
   */
  it("estimateEta imports nothing that touches I/O", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "eta.service.ts"),
      "utf8",
    );

    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);

    expect(imports).not.toContain("drizzle-orm");
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/database\/(connection|redis)/);
      expect(specifier).not.toMatch(/schema/);
    }
  });
});

describe("path correctness", () => {
  it("prefers the faster route even when it has the same hop count", () => {
    // SA → SD → SC is 100 + 60 = 160 min / 150 km.
    // SA → SB → SC is  60 + 120 = 180 min / 150 km.
    const result = estimate("SA", "SC");

    expect(result.totalMinutes).toBe(160);
    expect(result.totalKm).toBe(150);
    expect(result.path.map((leg) => leg.fromCode)).toEqual(["SA", "SD"]);
    expect(result.path.map((leg) => leg.toCode)).toEqual(["SD", "SC"]);
  });

  it("adds the legs of a longer path and dates the arrival from them", () => {
    // SA → SD → SC → SE = 100 + 60 + 60 = 220 min over 190 km.
    const result = estimate("SA", "SE");

    expect(result.totalMinutes).toBe(220);
    expect(result.totalKm).toBe(190);
    expect(result.path).toHaveLength(3);
    expect(result.path[result.path.length - 1].elapsedMinutes).toBe(220);
    expect(result.arrivalAt.getTime() - NOON.getTime()).toBe(220 * 60_000);
  });

  it("answers a same-station pair with zero rather than a route", () => {
    const result = estimate("SA", "SA");
    expect(result.totalMinutes).toBe(0);
    expect(result.path).toEqual([]);
  });
});

describe("no route", () => {
  /**
   * The failure mode this guards is specific: a Dijkstra that leaves the
   * destination at `Infinity` and returns it produces an arrival in the year
   * 275760, three screens away from the bug.
   */
  it("throws a typed error, never an infinity", () => {
    // SE has no outgoing section.
    expect(() => estimate("SE", "SA")).toThrow(NoRouteError);
    expect(() => estimate("SA", "NOWHERE")).toThrow(NoRouteError);

    try {
      estimate("SE", "SA");
    } catch (error) {
      expect(error).toBeInstanceOf(NoRouteError);
      expect((error as NoRouteError).fromCode).toBe("SE");
      expect(
        Number.isFinite((error as { minutes?: number }).minutes ?? 0),
      ).toBe(true);
    }
  });
});

describe("cold start", () => {
  it("falls back to the nominal speed, labels it, and is never null or zero", () => {
    const result = estimate("SA", "SC", fixtureWeights([]));

    expect(result.totalMinutes).toBeGreaterThan(0);
    expect(result.path.every((leg) => leg.source === "nominal")).toBe(true);
    expect(result.path.every((leg) => leg.samples === 0)).toBe(true);
    expect(result.confidence).toBe("low");
    expect(result.observedShare).toBe(0);
  });

  it("prices a nominal leg at distance over speed", () => {
    const [leg] = estimate("SA", "SD").path;
    // 100 km at 60 kmph is 100 minutes.
    expect(leg.minutes).toBe(100);
    expect(
      nominalMinutes({
        id: "x",
        from: "A",
        to: "B",
        distanceKm: 100,
        nominalSpeedKmph: 60,
      }),
    ).toBe(100);
  });
});

describe("blending", () => {
  it("sits strictly between the nominal and the observed one sample short", () => {
    const samples = MIN_OBSERVATIONS - 1;

    // Pure arithmetic first: 100 × (1 − 7/8) + 200 × 7/8 = 187.5.
    expect(blend(100, 200, samples)).toBeCloseTo(187.5, 5);
    expect(blend(100, 200, samples)).toBeGreaterThan(100);
    expect(blend(100, 200, samples)).toBeLessThan(200);
  });

  it("puts a blended leg on the path, strictly between the two", () => {
    const samples = MIN_OBSERVATIONS - 1;
    // 110 rather than 200, deliberately: sec-ad's nominal is 100 min and the
    // alternative SA → SB → SD is 120, so a weight that large would send the
    // search the other way and the assertion would be about a different leg.
    // 100 × 1/8 + 110 × 7/8 = 108.75.
    const blended = blend(100, 110, samples);
    expect(blended).toBeCloseTo(108.75, 5);

    const result = estimate(
      "SA",
      "SD",
      fixtureWeights(
        allBands("sec-ad", blended, { source: "blended", samples }),
      ),
    );

    expect(result.path).toHaveLength(1);
    expect(result.path[0].sectionId).toBe("sec-ad");
    expect(result.path[0].source).toBe("blended");
    expect(result.path[0].minutes).toBeGreaterThan(100);
    expect(result.path[0].minutes).toBeLessThan(110);
  });

  it("is the observed value once there are enough samples", () => {
    expect(blend(100, 200, MIN_OBSERVATIONS)).toBe(200);
    expect(blend(100, 200, MIN_OBSERVATIONS * 3)).toBe(200);
  });

  it("is the nominal value with no samples at all", () => {
    expect(blend(100, 200, 0)).toBe(100);
  });
});

describe("median robustness", () => {
  /**
   * §9's stated bar: one detained rake must not move the estimate. The mean is
   * computed alongside purely to show the size of what the median is refusing.
   */
  it("a single 10x outlier moves the answer by under 5%", () => {
    const clean = [95, 98, 100, 100, 102, 104, 106, 110];
    const withOutlier = [...clean.slice(0, 7), 1000];

    const before = median(clean);
    const after = median(withOutlier);

    expect(Math.abs(after - before) / before).toBeLessThan(0.05);

    const mean = (values: number[]) =>
      values.reduce((a, b) => a + b, 0) / values.length;
    expect(
      Math.abs(mean(withOutlier) - mean(clean)) / mean(clean),
    ).toBeGreaterThan(0.5);
  });

  it("averages the middle two on an even sample", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([40, 10, 30, 20])).toBe(25);
  });
});

describe("hour bands", () => {
  it("bands by IST, not by the machine's zone", () => {
    expect(hourBandOf(istAt(23, 30))).toBe("night");
    expect(hourBandOf(istAt(5, 59))).toBe("night");
    expect(hourBandOf(istAt(6, 0))).toBe("morning");
    expect(hourBandOf(istAt(10, 0))).toBe("day");
    expect(hourBandOf(istAt(17, 59))).toBe("day");
    expect(hourBandOf(istAt(18, 0))).toBe("evening");
    expect(hourBandOf(istAt(21, 50))).toBe("evening");
    expect(hourBandOf(istAt(22, 0))).toBe("night");
  });

  /**
   * The detail that makes an ETA defensible: the band is re-read at every node,
   * so a rake that departs at 21:50 is priced at evening running for the first
   * section and **night** running for the second — it crossed 22:00 en route.
   */
  it("carries the band forward, so a 21:50 departure arrives later than a 10:00 one", () => {
    const weights = fixtureWeights([
      { sectionId: "sec-ab", band: "evening", minutes: 10 },
      { sectionId: "sec-ab", band: "day", minutes: 10 },
      { sectionId: "sec-bd", band: "evening", minutes: 60 },
      { sectionId: "sec-bd", band: "night", minutes: 180 },
      { sectionId: "sec-bd", band: "day", minutes: 60 },
      // Kept expensive so the search still prefers SA → SB → SD.
      ...allBands("sec-ad", 500),
    ]);

    const evening = estimate("SA", "SD", weights, istAt(21, 50));
    const day = estimate("SA", "SD", weights, istAt(10, 0));

    expect(day.totalMinutes).toBe(70);
    // 10 minutes in the evening band, then 22:00 has passed and sec-bd is
    // priced at night: 10 + 180.
    expect(evening.totalMinutes).toBe(190);
    expect(evening.path[0].band).toBe("evening");
    expect(evening.path[1].band).toBe("night");
    expect(evening.totalMinutes).toBeGreaterThan(day.totalMinutes);
  });
});

describe("confidence is a coverage label", () => {
  it("is high when the path rests on observed running", () => {
    const result = estimate(
      "SA",
      "SC",
      fixtureWeights([...allBands("sec-ad", 100), ...allBands("sec-dc", 60)]),
    );

    expect(result.observedShare).toBe(1);
    expect(result.confidence).toBe("high");
  });

  it("is low when most of it is the timetable", () => {
    const result = estimate(
      "SA",
      "SC",
      // One observed leg of 60 minutes against 100 nominal — 37.5% coverage.
      fixtureWeights(allBands("sec-dc", 60)),
    );

    expect(result.observedShare).toBeLessThan(0.4);
    expect(result.confidence).toBe("low");
  });

  it("counts a blended leg by the fraction that decided its blend", () => {
    const result = estimate(
      "SA",
      "SD",
      fixtureWeights(
        allBands("sec-ad", 100, { source: "blended", samples: 4 }),
      ),
    );

    // 4 of 8 samples, so half of the leg's minutes count as observed.
    expect(result.observedShare).toBeCloseTo(0.5, 5);
    expect(result.confidence).toBe("medium");
  });

  /**
   * The refusal that matters most on this endpoint. §2's correction is that
   * Tier 2 is Phase 8, so nothing here may look like a probability — no
   * percentage, no interval, no `p80` — or the UI will render one.
   */
  it("never returns anything shaped like a probability", () => {
    const result = estimate("SA", "SC");
    expect(["low", "medium", "high"]).toContain(result.confidence);
    expect(Object.keys(result)).not.toContain("p50");
    expect(Object.keys(result)).not.toContain("p80");
    expect(Object.keys(result)).not.toContain("band");
  });
});

describe("weight keys", () => {
  it("separate a section's bands", () => {
    expect(weightKey("sec-ab", "night")).not.toBe(weightKey("sec-ab", "day"));
  });
});

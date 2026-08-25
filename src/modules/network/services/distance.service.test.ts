/**
 * The two distances, against the seeded network.
 *
 * The assertion that matters most is the negative one: a pair missing from
 * `chargeable_distances` must **throw**, and must not quietly return the
 * Dijkstra figure. That single behaviour is why the module has two functions
 * with two names instead of one with a `basis` flag and a default.
 */
import { describe, expect, it } from "vitest";

import DistanceService from "./distance.service";
import { DELIBERATELY_MISSING_TARIFF_PAIRS } from "../../../../scripts/seed/data/network.data";

describe("tariffKm", () => {
  const distance = new DistanceService();

  it("returns the seeded official distance", async () => {
    // 268 tariff km. The same pair is 281.4 operational km — see below.
    await expect(distance.tariffKm("KWV", "PUNE")).resolves.toBe(268);
  });

  it("is case-insensitive on station codes", async () => {
    await expect(distance.tariffKm("kwv", "pune")).resolves.toBe(268);
  });

  it.each(DELIBERATELY_MISSING_TARIFF_PAIRS)(
    "throws 422 for %s→%s rather than falling back to Dijkstra",
    async (from, to) => {
      // Both stations exist and a route between them exists, so a fallback
      // would produce a plausible number. Plausible and wrong is the failure
      // mode this test exists to prevent.
      await expect(distance.operationalKm(from, to)).resolves.toBeGreaterThan(
        0,
      );
      await expect(distance.tariffKm(from, to)).rejects.toMatchObject({
        statusCode: 422,
      });
    },
  );
});

describe("operationalKm and shortestPath", () => {
  const distance = new DistanceService();

  it("returns the summed section distance, which differs from the tariff", async () => {
    const operational = await distance.operationalKm("KWV", "PUNE");
    const tariff = await distance.tariffKm("KWV", "PUNE");

    expect(operational).toBe(281.4);
    expect(operational).not.toBe(tariff);
  });

  it("returns a path whose sections sum to the reported distance", async () => {
    const path = await distance.shortestPath("KWV", "PUNE");

    expect(path).not.toBeNull();
    const summed = path!.sections.reduce(
      (total, section) => total + section.distanceKm,
      0,
    );
    expect(Math.round(summed * 100) / 100).toBe(path!.totalKm);
    expect(path!.stations[0]).toBe("KWV");
    expect(path!.stations[path!.stations.length - 1]).toBe("PUNE");
  });

  it("is symmetric across the seeded network", async () => {
    const forward = await distance.operationalKm("KWV", "PUNE");
    const backward = await distance.operationalKm("PUNE", "KWV");

    expect(backward).toBe(forward);
  });

  it("returns null for a station that is not on the network", async () => {
    // Not a throw: "no path exists" is a legitimate fact, and the caller that
    // needs it to be an error — a quotation — raises its own.
    await expect(distance.operationalKm("KWV", "NOWHERE")).resolves.toBeNull();
  });

  it("connects the Solapur belt to the Nagpur belt", async () => {
    // Through Manmad and Bhusaval. If this ever returns null, the seed has been
    // split into two disconnected components and every cross-belt haul in the
    // product silently becomes infeasible.
    await expect(distance.operationalKm("KWV", "NGP")).resolves.toBeGreaterThan(
      0,
    );
  });

  it("reports free-running minutes derived from the nominal speeds", async () => {
    const path = await distance.shortestPath("KWV", "PUNE");

    // The Pune–Solapur corridor is seeded at 75 km/h throughout, so the whole
    // 281.4 km should take a shade over 225 minutes. This is the ETA cold start
    // Phase 5 falls back to before any event history exists.
    expect(path!.totalMinutes).toBeCloseTo((281.4 / 75) * 60, 1);
  });
});

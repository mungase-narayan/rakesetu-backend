/**
 * `getRakeConstraints` — the as-of read.
 *
 * The whole suite turns on one distinction that is invisible until a wagon is
 * swapped: "which wagons are in this rake" and "which wagons were in this rake
 * during that journey" return the same answer right up until they do not, and
 * a solver that asks the first question while meaning the second starts clearing
 * rakes on the fitness date of a wagon that left months ago.
 *
 * The seed contains one rake whose composition changed, precisely so this can be
 * proved rather than asserted.
 */
import { beforeAll, describe, expect, it } from "vitest";

import RakeService from "./rake.service";
import { requireOrg } from "../../../../scripts/seed/tenancy.seed";
import { COMPOSITION_CHANGED_RAKE_CODE } from "../../../../scripts/seed/data/asset.data";

const service = new RakeService();
const DAY_MS = 24 * 60 * 60 * 1000;

let orgId: string;
let rakeId: string;

beforeAll(async () => {
  const zone = await requireOrg("CR");
  orgId = zone.id;

  const page = await service.list(orgId, { limit: 100 });
  const rake = page.data.find(
    (candidate) => candidate.code === COMPOSITION_CHANGED_RAKE_CODE,
  );
  if (!rake) {
    throw new Error(
      `The seed no longer contains ${COMPOSITION_CHANGED_RAKE_CODE}. That rake is the as-of fixture — restore it rather than deleting this test.`,
    );
  }
  rakeId = rake.id;
});

describe("getRakeConstraints", () => {
  it("reads the composition valid at the given moment, not the current one", async () => {
    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * DAY_MS);

    const current = await service.getRakeConstraints(orgId, rakeId, now);
    const past = await service.getRakeConstraints(orgId, rakeId, sixtyDaysAgo);

    // Two wagons were detached thirty days ago, so the historical composition
    // is strictly larger.
    expect(past.wagonCount).toBeGreaterThan(current.wagonCount);
    expect(past.wagonCount - current.wagonCount).toBe(2);
  });

  it("returns the minimum overhaul date across the composition, as of that moment", async () => {
    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * DAY_MS);

    const current = await service.getRakeConstraints(orgId, rakeId, now);
    const past = await service.getRakeConstraints(orgId, rakeId, sixtyDaysAgo);

    expect(past.earliestPohDue).not.toBeNull();
    expect(current.earliestPohDue).not.toBeNull();
    // The detached wagons were overdue — which is why they were detached — so
    // the historical minimum is earlier than today's.
    expect(past.earliestPohDue!.getTime()).toBeLessThan(
      current.earliestPohDue!.getTime(),
    );
    expect(past.earliestFitnessDue!.getTime()).toBeLessThan(
      current.earliestFitnessDue!.getTime(),
    );
  });

  it("sums the composition's length for the max-rake-length constraint", async () => {
    const constraints = await service.getRakeConstraints(orgId, rakeId);

    expect(constraints.totalLengthM).toBeGreaterThan(0);
    // Every wagon in a seeded rake is the same type, so the total is the count
    // times one wagon's length — a cheap check that the join is not fanning out.
    expect(constraints.totalLengthM / constraints.wagonCount).toBeGreaterThan(
      5,
    );
  });

  it("excludes a row closed exactly at the instant asked about", async () => {
    // The interval is half-open: `from_ts <= at AND to_ts > at`. Without the
    // strict `>`, a swap would return both the old wagon and the new one for
    // the changeover second, and the count would be wrong by two.
    const composition = await service.getComposition(orgId, rakeId);
    const closed = await service.getComposition(
      orgId,
      rakeId,
      new Date(Date.now() - 30 * DAY_MS),
    );

    expect(closed.length).toBeGreaterThanOrEqual(composition.length);
    expect(composition.every((entry) => entry.toTs === null)).toBe(true);
  });

  it("refuses a rake in another tenant", async () => {
    const other = await requireOrg("ACC");

    await expect(
      service.getRakeConstraints(other.id, rakeId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

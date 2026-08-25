/**
 * The tuning constants of the Tier 1 ETA engine (DESIGN.md §5.4), in one place
 * because every one of them is a **specified behaviour** rather than an
 * implementation detail — the cold-start blend in particular is something the
 * product has to be able to explain out loud, not something a reader has to
 * reverse-engineer out of a service.
 */

/**
 * Observations required before a section's own history beats the timetable.
 *
 * Eight, and the number is a trade rather than a guess: fewer and one unlucky
 * crossing sets the estimate for a whole section, more and a month of
 * simulated history leaves most cells still cold. It is exported so the tests
 * assert against the constant instead of restating it — a suite that hardcodes
 * `8` passes after somebody changes the blend and breaks the product.
 */
export const MIN_OBSERVATIONS = 8;

/** How far back traversals are read. Older running is a different railway. */
export const OBSERVATION_WINDOW_DAYS = 90;

/**
 * The four bands a day is cut into.
 *
 * **Coarse on purpose.** Freight runs differently at night — fewer passenger
 * paths to be looped for — and that difference is worth modelling. Splitting
 * further is not: every extra band divides the sample count, and a model with
 * twenty-four cells per section is a model in which every cell is cold-start.
 */
export const HOUR_BANDS = ["night", "morning", "day", "evening"] as const;
export type HourBand = (typeof HOUR_BANDS)[number];

/** IST is UTC+5:30 and is never read from the machine's zone. */
const IST_OFFSET_MINUTES = 330;

/** Minutes since IST midnight, for an instant stored in UTC. */
const istMinutesOfDay = (at: Date): number => {
  const utcMinutes = Math.floor(at.getTime() / 60_000);
  return (((utcMinutes + IST_OFFSET_MINUTES) % 1440) + 1440) % 1440;
};

/**
 * Which band an instant falls in, **by Indian Standard Time**.
 *
 * The zone is explicit for the same reason every rendered timestamp names it:
 * a band boundary computed in the server's local zone would move the "night"
 * window by five and a half hours the first time this runs anywhere but a
 * developer's laptop, and the resulting ETA would be wrong in a way that looks
 * like ordinary noise.
 */
export const hourBandOf = (at: Date): HourBand => {
  const hour = Math.floor(istMinutesOfDay(at) / 60);
  if (hour >= 22 || hour < 6) return "night";
  if (hour < 10) return "morning";
  if (hour < 18) return "day";
  return "evening";
};

/** The IST calendar date of an instant, `YYYY-MM-DD`. Used in the cache key. */
export const istDateOf = (at: Date): string =>
  new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 10);

/**
 * Cache key for one day's weight map.
 *
 * **Two corrections to the phase document, both deliberate.**
 *
 * 1. It carries `orgId`. §5.4's key is `eta:weights:v1:<date>:<wagonType>`,
 *    which is the one shape in the product that would let one tenant's running
 *    times decide another's ETAs. Every other read in the codebase is scoped;
 *    a cache key is not the place to make the exception.
 * 2. It carries the wagon type, and therefore so does the loader's signature.
 *    §3.1 keys the weights by `(section, wagon_type, hour_band)` while the
 *    signature it prints takes only `asOf` — the two cannot both be true, and
 *    the wagon type is the half the estimator actually needs.
 */
export const weightCacheKey = (
  orgId: string,
  asOf: Date,
  wagonTypeCode: string,
): string => `eta:weights:v1:${orgId}:${istDateOf(asOf)}:${wagonTypeCode}`;

/** Six hours. A recompute is nightly; this is the ceiling, not the schedule. */
export const WEIGHT_CACHE_TTL_SECONDS = 6 * 60 * 60;

/**
 * Where the coverage label changes.
 *
 * These are **not** probabilities and the thresholds must never be presented as
 * such — see `EtaResult.confidence`. Phase 8 replaces the label with real
 * p50/p80/p90 bands computed from completed cycles.
 */
export const CONFIDENCE_HIGH_THRESHOLD = 0.8;
export const CONFIDENCE_LOW_THRESHOLD = 0.4;

/**
 * The composite key a weight map is stored under.
 *
 * `SectionWeightMap` is documented in §3.1 as `Map<sectionId, …>`, but §3.2
 * requires the hour band to be carried forward as the walk advances — which is
 * only possible if the band is part of the key. It is a single string rather
 * than a nested map so the whole thing survives `JSON.stringify` into Redis
 * without a custom serialiser.
 */
export const weightKey = (sectionId: string, band: HourBand): string =>
  `${sectionId}|${band}`;

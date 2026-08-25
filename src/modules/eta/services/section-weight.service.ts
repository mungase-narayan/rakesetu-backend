/**
 * Where the ETA's edge weights come from — the **I/O half** of §5.4.
 *
 * `eta.service.ts` decides; this file reads. It pulls `SECTION_PASSED` pairs out
 * of the event log, turns them into a median traversal time per
 * `(section, wagon type, hour band)`, blends toward the timetable while the
 * sample count is thin, and caches the result in Redis.
 *
 * ---
 *
 * **Why the median and not the mean.** One rake detained in a loop for nine
 * hours between two crossings is a real event and a terrible estimator: a mean
 * over eight traversals moves by an hour, a median does not move at all. The
 * detention is not a property of the section, and §5.2 already has a bucket for
 * it. §9 makes this a test — a single 10× outlier must move the answer by less
 * than 5%.
 *
 * **Why the pairs are chained.** A traversal is the gap between the
 * `SECTION_PASSED` that *ended* the previous section and the one that ends this
 * one — so the predicate is `previous.toCode = this.fromCode`, within one
 * cycle. Without the chain check, the gap across a cycle boundary or a
 * diversion would be recorded as a section that takes four days to cross.
 *
 * **What is deliberately not filtered out.** A pair that straddles a detention
 * is left in. Excluding it would need this module to know what a detention is,
 * and the median already handles it — a filter that quietly drops "bad" data is
 * a filter nobody can audit, and the sample count would then overstate how much
 * running the estimate rests on.
 */
import { asc, sql } from "drizzle-orm";
import type { Logger } from "winston";

import logger from "../../../logger/winston.logger";
import { db, type DB } from "../../../database/connection";
import { cache, type CacheService } from "../../../database/redis";
import { rakes, sections } from "../../../schema";
import {
  HOUR_BANDS,
  MIN_OBSERVATIONS,
  OBSERVATION_WINDOW_DAYS,
  WEIGHT_CACHE_TTL_SECONDS,
  hourBandOf,
  weightCacheKey,
  weightKey,
  type HourBand,
} from "../constants/eta.constants";
import type { SectionWeight, SectionWeightMap } from "../types/eta.types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The middle value, averaging the two middle ones on an even count.
 *
 * Exported because the property it carries — resistance to a single wild
 * observation — is asserted directly by the test suite, and asserting it
 * through four layers of service would be testing the plumbing instead.
 */
export const median = (values: readonly number[]): number => {
  if (values.length === 0) throw new Error("median of an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * The cold-start blend, as one function so it is testable and quotable.
 *
 * Linear in `samples / MIN_OBSERVATIONS`: at zero observations the answer is
 * the timetable, at `MIN_OBSERVATIONS` it is entirely the observed median, and
 * in between it is a weighted average that moves smoothly. §9 asserts the
 * middle case is *strictly between* the two endpoints — a blend that snapped to
 * one side would make "blended" a label with no meaning.
 */
export const blend = (
  nominal: number,
  observed: number,
  samples: number,
): number => {
  const weight = Math.min(1, samples / MIN_OBSERVATIONS);
  return nominal * (1 - weight) + observed * weight;
};

/**
 * `db.execute` types its rows as `Record<string, unknown>`, so the shape is
 * declared as a type with an index signature rather than an interface — the
 * two are otherwise identical and the constraint only accepts the former.
 */
type TraversalRow = {
  section_id: string;
  /**
   * A **string**, not a `Date`.
   *
   * Drizzle installs its own `pg` type parsers so that it — rather than the
   * driver — decides how a `timestamptz` becomes a JavaScript value, and a raw
   * `db.execute` bypasses the mapping that would normally follow. So the row
   * arrives as the ISO text Postgres sent, and it is parsed explicitly below.
   * Typing it as `Date` here would compile and then throw at the first
   * `.getTime()`.
   */
  entered_at: string;
  minutes: number;
} & Record<string, unknown>;

interface SectionRow {
  id: string;
  fromCode: string;
  toCode: string;
  distanceKm: number;
  nominalSpeedKmph: number;
}

/** The full table a debugging view wants: every cell, observed or not. */
export interface WeightTable {
  orgId: string;
  wagonTypeCode: string;
  asOf: string;
  windowDays: number;
  minObservations: number;
  cells: (SectionWeight & { fromCode: string; toCode: string })[];
  summary: { observed: number; blended: number; nominal: number };
}

class SectionWeightService {
  constructor(
    private readonly database: DB = db,
    private readonly cacheService: CacheService = cache,
    private readonly log: Logger = logger,
  ) {}

  /**
   * The weight map for one wagon type, from Redis when warm.
   *
   * **Values are cached, not answers.** Assembling the map is a window function
   * over ninety days of events; running Dijkstra against it is microseconds. So
   * the expensive half is what goes in Redis and every individual estimate is
   * computed fresh — which also means an ETA is never served from a cache that
   * predates the event a supervisor just logged.
   *
   * A Redis outage degrades this to a recompute per call rather than an error,
   * matching `DistanceService.loadGraph`. An ETA that fails because a cache is
   * down would be a worse trade than one that is slow.
   */
  async getSectionWeights(
    orgId: string,
    wagonTypeCode: string,
    asOf: Date = new Date(),
  ): Promise<SectionWeightMap> {
    const key = weightCacheKey(orgId, asOf, wagonTypeCode);

    try {
      const cached = await this.cacheService.get<SectionWeight[]>(key);
      if (cached) return toMap(cached);
    } catch (error) {
      this.log.warn(`ETA weight cache read failed: ${message(error)}`);
    }

    const cells = await this.computeSectionWeights(orgId, wagonTypeCode, asOf);

    try {
      await this.cacheService.set(key, cells, WEIGHT_CACHE_TTL_SECONDS);
    } catch (error) {
      this.log.warn(`ETA weight cache write failed: ${message(error)}`);
    }

    return toMap(cells);
  }

  /**
   * The observed cells, computed from the log. **No cache, no fallbacks.**
   *
   * Returns only cells with at least one observation — a section nobody has
   * crossed is absent, and the estimator answers for it from the graph edge's
   * nominal speed. Materialising every `section × band` here would inflate the
   * cached payload by an order of magnitude to say "we know nothing" 300 times.
   */
  async computeSectionWeights(
    orgId: string,
    wagonTypeCode: string,
    asOf: Date = new Date(),
  ): Promise<SectionWeight[]> {
    const since = new Date(asOf.getTime() - OBSERVATION_WINDOW_DAYS * DAY_MS);

    const [traversals, sectionRows] = await Promise.all([
      this.readTraversals(orgId, wagonTypeCode, since, asOf),
      this.readSections(),
    ]);

    const byCell = new Map<string, number[]>();
    const cellMeta = new Map<string, { sectionId: string; band: HourBand }>();

    for (const row of traversals) {
      // The band the rake **entered** the section in — the previous crossing's
      // timestamp. Banding on the exit would file a night run that finishes at
      // 06:10 under "morning" and make the night band look faster than it is.
      const band = hourBandOf(new Date(row.entered_at));
      const key = weightKey(row.section_id, band);
      const bucket = byCell.get(key);
      if (bucket) bucket.push(row.minutes);
      else {
        byCell.set(key, [row.minutes]);
        cellMeta.set(key, { sectionId: row.section_id, band });
      }
    }

    const sectionById = new Map(sectionRows.map((row) => [row.id, row]));
    const cells: SectionWeight[] = [];

    for (const [key, samples] of byCell) {
      const meta = cellMeta.get(key) as { sectionId: string; band: HourBand };
      const section = sectionById.get(meta.sectionId);
      // A section that has since been deleted. Its history is real but there is
      // no edge to price, so the cell is dropped rather than kept as an orphan.
      if (!section) continue;

      const nominal = (section.distanceKm / section.nominalSpeedKmph) * 60;
      const observedMedian = median(samples);
      const enough = samples.length >= MIN_OBSERVATIONS;

      cells.push({
        sectionId: meta.sectionId,
        band: meta.band,
        minutes: round2(
          enough
            ? observedMedian
            : blend(nominal, observedMedian, samples.length),
        ),
        source: enough ? "observed" : "blended",
        samples: samples.length,
        nominalMinutes: round2(nominal),
        observedMedianMinutes: round2(observedMedian),
      });
    }

    return cells;
  }

  /**
   * Every cell the debugging view shows — the observed ones plus a nominal row
   * for each section and band that has none.
   *
   * This is what makes T5.1's acceptance criterion checkable: "a realistic mix
   * of observed and nominal after a 30-day sim" is a claim about the rows that
   * are *not* there as much as the ones that are.
   */
  async weightTable(
    orgId: string,
    wagonTypeCode: string,
    asOf: Date = new Date(),
  ): Promise<WeightTable> {
    const [observedCells, sectionRows] = await Promise.all([
      this.computeSectionWeights(orgId, wagonTypeCode, asOf),
      this.readSections(),
    ]);

    const observed = new Map(
      observedCells.map((cell) => [weightKey(cell.sectionId, cell.band), cell]),
    );

    const cells: WeightTable["cells"] = [];
    for (const section of sectionRows) {
      const nominal = (section.distanceKm / section.nominalSpeedKmph) * 60;
      for (const band of HOUR_BANDS) {
        const cell = observed.get(weightKey(section.id, band));
        cells.push({
          ...(cell ?? {
            sectionId: section.id,
            band,
            minutes: round2(nominal),
            source: "nominal" as const,
            samples: 0,
            nominalMinutes: round2(nominal),
            observedMedianMinutes: null,
          }),
          fromCode: section.fromCode,
          toCode: section.toCode,
        });
      }
    }

    const summary = { observed: 0, blended: 0, nominal: 0 };
    for (const cell of cells) summary[cell.source] += 1;

    return {
      orgId,
      wagonTypeCode,
      asOf: asOf.toISOString(),
      windowDays: OBSERVATION_WINDOW_DAYS,
      minObservations: MIN_OBSERVATIONS,
      cells,
      summary,
    };
  }

  /** The wagon types this tenant actually runs — what `eta:recompute` iterates. */
  async wagonTypeCodes(orgId: string): Promise<string[]> {
    const rows = await this.database
      .selectDistinct({ code: rakes.wagonTypeCode })
      .from(rakes)
      .where(sql`${rakes.orgId} = ${orgId} and ${rakes.isActive}`)
      .orderBy(asc(rakes.wagonTypeCode));
    return rows.map((row) => row.code);
  }

  /**
   * Recomputes and **overwrites** the cache for every wagon type. The nightly
   * cron, and the thing `npm run eta:recompute` calls.
   */
  async recompute(
    orgId: string,
    asOf: Date = new Date(),
  ): Promise<{ wagonTypeCode: string; cells: number; observed: number }[]> {
    const codes = await this.wagonTypeCodes(orgId);
    const report: { wagonTypeCode: string; cells: number; observed: number }[] =
      [];

    for (const wagonTypeCode of codes) {
      const cells = await this.computeSectionWeights(
        orgId,
        wagonTypeCode,
        asOf,
      );
      await this.cacheService.set(
        weightCacheKey(orgId, asOf, wagonTypeCode),
        cells,
        WEIGHT_CACHE_TTL_SECONDS,
      );
      report.push({
        wagonTypeCode,
        cells: cells.length,
        observed: cells.filter((cell) => cell.source === "observed").length,
      });
    }

    return report;
  }

  /** Drops one day's map. Deleting rather than rewriting, as the graph cache does. */
  async invalidate(
    orgId: string,
    wagonTypeCode: string,
    asOf: Date = new Date(),
  ): Promise<void> {
    try {
      await this.cacheService.del(weightCacheKey(orgId, asOf, wagonTypeCode));
    } catch (error) {
      this.log.error(`ETA weight cache invalidation failed: ${message(error)}`);
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Consecutive `SECTION_PASSED` pairs, as traversal minutes.
   *
   * A window function rather than a fetch-and-pair in JavaScript: ninety days
   * of a forty-rake fleet is tens of thousands of rows, and pulling them into
   * the process to compute a `lag()` Postgres already implements would be the
   * one query in this module that does not scale with the demo.
   *
   * `applied` is checked because a quarantined event is an attempt, not a
   * crossing — folding refused rows into the weights would let an anomaly
   * change an estimate.
   */
  private async readTraversals(
    orgId: string,
    wagonTypeCode: string,
    since: Date,
    asOf: Date,
  ): Promise<TraversalRow[]> {
    const result = await this.database.execute<TraversalRow>(sql`
      with passed as (
        select
          e.occurred_at,
          e.payload ->> 'sectionId' as section_id,
          e.payload ->> 'fromCode'  as from_code,
          lag(e.occurred_at)            over w as prev_at,
          lag(e.payload ->> 'toCode')   over w as prev_to
        from rake_events e
        join rakes r on r.id = e.rake_id
        where e.org_id = ${orgId}
          and e.event_type = 'SECTION_PASSED'
          and e.applied
          and e.cycle_id is not null
          and e.occurred_at >= ${since}
          and e.occurred_at <= ${asOf}
          and r.wagon_type_code = ${wagonTypeCode}
        window w as (
          partition by e.rake_id, e.cycle_id
          order by e.occurred_at, e.id
        )
      )
      select
        section_id,
        prev_at as entered_at,
        (extract(epoch from (occurred_at - prev_at)) / 60.0)::float8 as minutes
      from passed
      where prev_at is not null
        and prev_to = from_code
        and occurred_at > prev_at
        and section_id is not null
    `);

    return result.rows;
  }

  private async readSections(): Promise<SectionRow[]> {
    return this.database
      .select({
        id: sections.id,
        fromCode: sections.fromCode,
        toCode: sections.toCode,
        distanceKm: sections.distanceKm,
        nominalSpeedKmph: sections.nominalSpeedKmph,
      })
      .from(sections);
  }
}

const toMap = (cells: readonly SectionWeight[]): SectionWeightMap =>
  new Map(cells.map((cell) => [weightKey(cell.sectionId, cell.band), cell]));

const round2 = (value: number): number => Math.round(value * 100) / 100;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export default SectionWeightService;

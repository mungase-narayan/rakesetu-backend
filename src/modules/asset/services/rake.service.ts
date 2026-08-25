/**
 * rakes and their versioned composition, plus `getRakeConstraints` — the
 * function Phase 7's solver calls before it will allot anything.
 *
 * The composition is bitemporal: a row is valid from `from_ts` until `to_ts`,
 * and `to_ts IS NULL` means "still valid". Reading it correctly is the entire
 * point of the table, and getting it wrong is invisible — "which wagons are in
 * this rake" and "which wagons were in this rake during that journey" return
 * the same answer right up until a wagon is swapped, at which point the solver
 * starts clearing rakes on the fitness date of a wagon that is no longer in them.
 */
import {
  and,
  asc,
  eq,
  gt,
  isNull,
  lte,
  min,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  rakeCompositions,
  rakes,
  wagonTypes,
  wagons,
  type Rake,
} from "../../../schema";
import ApiError from "../../../utils/api-error";
import { db, type DB } from "../../../database/connection";
import {
  ScopedRepository,
  type ScopedInsert,
} from "../../../database/scoped-repository";
import type {
  CompositionEntry,
  IListRakesQuery,
  RakeConstraints,
} from "../types/asset.types";

class RakeService {
  constructor(private readonly database: DB = db) {}

  private repo(orgId: string) {
    return new ScopedRepository(rakes, orgId, this.database);
  }

  async list(orgId: string, query: IListRakesQuery = {}) {
    return this.repo(orgId).paginate(
      { ...query, sort: query.sort ?? "code", order: query.order ?? "asc" },
      this.filters(query),
    );
  }

  async findById(orgId: string, id: string): Promise<Rake | null> {
    return this.repo(orgId).findById(id);
  }

  async create(
    orgId: string,
    values: ScopedInsert<typeof rakes>,
  ): Promise<Rake> {
    return this.repo(orgId).insert({
      ...values,
      code: values.code.toUpperCase(),
      wagonTypeCode: values.wagonTypeCode.toUpperCase(),
    });
  }

  /**
   * Updates a rake's **static** attributes.
   *
   * `currentState`, `currentStation` and `stateSince` are stripped here, not
   * merely undocumented: from Phase 4 the projection owns them, and a PATCH that
   * set them would appear to work and then be silently overwritten by the next
   * event. Rejecting them at the boundary is what keeps the event spine the only
   * writer.
   */
  async update(
    orgId: string,
    id: string,
    values: Partial<ScopedInsert<typeof rakes>>,
  ): Promise<Rake | null> {
    const {
      currentState: _state,
      currentStation: _station,
      stateSince: _since,
      ...patch
    } = values;
    return this.repo(orgId).update(id, patch);
  }

  // ---- composition --------------------------------------------------------

  /**
   * The composition valid **at a moment**.
   *
   * The predicate is `from_ts <= at AND (to_ts IS NULL OR to_ts > at)`, in SQL.
   * Note the strict `>`: a row closed exactly at `at` was no longer in the rake
   * at that instant, and the half-open interval is what stops a swap from
   * returning both the old wagon and the new one for the changeover second.
   */
  async getComposition(
    orgId: string,
    rakeId: string,
    at: Date = new Date(),
  ): Promise<CompositionEntry[]> {
    const rake = await this.findById(orgId, rakeId);
    if (!rake) throw new ApiError(404, "Rake not found");

    return this.database
      .select({
        id: rakeCompositions.id,
        position: rakeCompositions.position,
        fromTs: rakeCompositions.fromTs,
        toTs: rakeCompositions.toTs,
        wagonId: wagons.id,
        wagonNumber: wagons.number,
        typeCode: wagons.typeCode,
        pohDueOn: wagons.pohDueOn,
        fitnessDueOn: wagons.fitnessDueOn,
        status: wagons.status,
      })
      .from(rakeCompositions)
      .innerJoin(wagons, eq(rakeCompositions.wagonId, wagons.id))
      .where(this.validAt(rakeId, at))
      .orderBy(asc(rakeCompositions.position));
  }

  /**
   * **The Phase 7 constraint read.** Returns the *minimum* overhaul and fitness
   * dates across the composition valid at `at`, plus the wagon count and total
   * length the solver checks against `terminals.max_rake_length`.
   *
   * Provided here, in the phase that owns the table, precisely so Phase 7 cannot
   * write `SELECT min(poh_due_on) … WHERE to_ts IS NULL` and be wrong for every
   * historical query it ever runs.
   */
  async getRakeConstraints(
    orgId: string,
    rakeId: string,
    at: Date = new Date(),
  ): Promise<RakeConstraints> {
    const rake = await this.findById(orgId, rakeId);
    if (!rake) throw new ApiError(404, "Rake not found");

    const [row] = await this.database
      .select({
        earliestPohDue: min(wagons.pohDueOn),
        earliestFitnessDue: min(wagons.fitnessDueOn),
        wagonCount: sql<number>`count(*)::int`,
        totalLengthM: sql<number>`coalesce(sum(${wagonTypes.lengthM}), 0)::float`,
      })
      .from(rakeCompositions)
      .innerJoin(wagons, eq(rakeCompositions.wagonId, wagons.id))
      .innerJoin(wagonTypes, eq(wagons.typeCode, wagonTypes.code))
      .where(this.validAt(rakeId, at));

    return {
      rakeId,
      at,
      earliestPohDue: row?.earliestPohDue ? new Date(row.earliestPohDue) : null,
      earliestFitnessDue: row?.earliestFitnessDue
        ? new Date(row.earliestFitnessDue)
        : null,
      wagonCount: row?.wagonCount ?? 0,
      totalLengthM: row?.totalLengthM ?? 0,
    };
  }

  /**
   * Replaces the current composition.
   *
   * Two statements in one transaction: close every open row at `effectiveFrom`,
   * then insert the new set from the same instant. Doing it in one transaction
   * is what stops a crash between the two from leaving a rake with no wagons —
   * and doing both at the *same* timestamp is what makes the half-open interval
   * above return exactly one set for every instant.
   */
  async replaceComposition(
    orgId: string,
    rakeId: string,
    wagonIds: string[],
    effectiveFrom: Date = new Date(),
  ): Promise<CompositionEntry[]> {
    const rake = await this.findById(orgId, rakeId);
    if (!rake) throw new ApiError(404, "Rake not found");

    // Every wagon must belong to this tenant. Left to the foreign key, a wagon
    // id from another zone would insert happily — `rake_compositions` has no
    // org column of its own, it inherits scope from the rake.
    const owned = await this.database
      .select({ id: wagons.id })
      .from(wagons)
      .where(
        and(eq(wagons.orgId, orgId), sql`${wagons.id} = ANY(${wagonIds})`),
      );

    if (owned.length !== new Set(wagonIds).size) {
      throw new ApiError(
        422,
        "One or more wagons do not exist in this organization",
      );
    }

    await this.database.transaction(async (tx) => {
      await tx
        .update(rakeCompositions)
        .set({ toTs: effectiveFrom })
        .where(
          and(
            eq(rakeCompositions.rakeId, rakeId),
            isNull(rakeCompositions.toTs),
          ),
        );

      if (wagonIds.length > 0) {
        await tx.insert(rakeCompositions).values(
          wagonIds.map((wagonId, index) => ({
            rakeId,
            wagonId,
            position: index + 1,
            fromTs: effectiveFrom,
          })),
        );
      }
    });

    // `wagon_count` is a denormalised copy of what the composition says; letting
    // the two disagree would make the solver's capacity check meaningless.
    await this.repo(orgId).update(rakeId, { wagonCount: wagonIds.length });

    return this.getComposition(orgId, rakeId, effectiveFrom);
  }

  /** `from_ts <= at AND (to_ts IS NULL OR to_ts > at)`, for one rake. */
  private validAt(rakeId: string, at: Date): SQL {
    return and(
      eq(rakeCompositions.rakeId, rakeId),
      lte(rakeCompositions.fromTs, at),
      or(isNull(rakeCompositions.toTs), gt(rakeCompositions.toTs, at)),
    ) as SQL;
  }

  private filters(query: IListRakesQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.search) {
      conditions.push(sql`${rakes.code} ILIKE ${`%${query.search}%`}`);
    }
    if (query.state) conditions.push(eq(rakes.currentState, query.state));
    if (query.station) {
      conditions.push(eq(rakes.currentStation, query.station.toUpperCase()));
    }
    if (query.wagonType) {
      conditions.push(eq(rakes.wagonTypeCode, query.wagonType.toUpperCase()));
    }
    if (query.division) {
      conditions.push(eq(rakes.homeDivision, query.division));
    }
    if (query.isActive !== undefined) {
      conditions.push(eq(rakes.isActive, query.isActive));
    }

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default RakeService;

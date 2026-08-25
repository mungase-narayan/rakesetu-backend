/**
 * Reads over the event spine: the log, the projection, the cycles, the
 * anomalies, and the feed the network map polls.
 *
 * Writes live in `projector.service.ts`. Splitting them is what keeps the
 * read path free of any temptation to "fix" a projection it finds wrong —
 * nothing in this file writes, so a stale row is reported as stale rather than
 * quietly repaired mid-request.
 */
import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import { db, type DB } from "../../../database/connection";
import { ScopedRepository } from "../../../database/scoped-repository";
import {
  rakeCycles,
  rakeEvents,
  rakeStates,
  rakes,
  stations,
  terminals,
  type RakeCycle,
  type RakeEvent,
  type RakeStateRow,
} from "../../../schema";
import type { Paginated } from "../../../types/pagination.types";
import { STATE_GROUP } from "../constants/event-type.constants";
import type {
  IListAnomaliesQuery,
  IListCyclesQuery,
  IListEventsQuery,
  LiveRake,
  LiveTerminal,
  NetworkLive,
  SectionLoad,
} from "../types/rake-event.types";

const MS_PER_HOUR = 3_600_000;

class RakeEventService {
  constructor(private readonly database: DB = db) {}

  /**
   * One rake's log, oldest first.
   *
   * `occurred_at` order, not `recorded_at` — the screen is a story about the
   * rake, and the story is what happened, not what arrived. The two columns are
   * shown side by side precisely so a reader can see where they disagree.
   */
  async listEvents(
    orgId: string,
    rakeId: string,
    query: IListEventsQuery,
  ): Promise<Paginated<RakeEvent>> {
    const repo = new ScopedRepository(rakeEvents, orgId, this.database);
    const conditions: SQL[] = [eq(rakeEvents.rakeId, rakeId)];

    if (!query.includeRejected) {
      conditions.push(eq(rakeEvents.applied, true));
    }
    if (query.from) conditions.push(gte(rakeEvents.occurredAt, query.from));
    if (query.to) conditions.push(lte(rakeEvents.occurredAt, query.to));
    if (query.eventType) {
      conditions.push(eq(rakeEvents.eventType, query.eventType));
    }

    return repo.paginate(
      {
        page: query.page,
        limit: query.limit,
        sort: "occurredAt",
        order: query.order ?? "desc",
      },
      and(...conditions),
    );
  }

  async getState(orgId: string, rakeId: string): Promise<RakeStateRow | null> {
    const [row] = await this.database
      .select()
      .from(rakeStates)
      .where(and(eq(rakeStates.orgId, orgId), eq(rakeStates.rakeId, rakeId)))
      .limit(1);
    return row ?? null;
  }

  async listCycles(
    orgId: string,
    rakeId: string,
    query: IListCyclesQuery,
  ): Promise<Paginated<RakeCycle>> {
    const repo = new ScopedRepository(rakeCycles, orgId, this.database);
    const conditions: SQL[] = [eq(rakeCycles.rakeId, rakeId)];
    if (query.isClosed !== undefined) {
      conditions.push(eq(rakeCycles.isClosed, query.isClosed));
    }

    return repo.paginate(
      {
        page: query.page,
        limit: query.limit,
        sort: "startedAt",
        order: query.order ?? "desc",
      },
      and(...conditions),
    );
  }

  /** A cycle and every event filed under it, in order. */
  async getCycle(
    orgId: string,
    cycleId: string,
  ): Promise<{ cycle: RakeCycle; events: RakeEvent[] } | null> {
    const [cycle] = await this.database
      .select()
      .from(rakeCycles)
      .where(and(eq(rakeCycles.orgId, orgId), eq(rakeCycles.id, cycleId)))
      .limit(1);

    if (!cycle) return null;

    const events = await this.database
      .select()
      .from(rakeEvents)
      .where(and(eq(rakeEvents.orgId, orgId), eq(rakeEvents.cycleId, cycleId)))
      .orderBy(asc(rakeEvents.occurredAt), asc(rakeEvents.id));

    return { cycle, events };
  }

  /**
   * Rejected attempts, newest first.
   *
   * Phase 8 turns this into the controller's exception queue. It is already a
   * real endpoint rather than a placeholder because the rows exist from the
   * first illegal transition, and a queue that only starts collecting when
   * somebody builds the screen would have nothing in it on the day it ships.
   */
  async listAnomalies(
    orgId: string,
    query: IListAnomaliesQuery,
  ): Promise<Paginated<RakeEvent>> {
    const repo = new ScopedRepository(rakeEvents, orgId, this.database);
    const conditions: SQL[] = [eq(rakeEvents.applied, false)];

    if (query.rakeId) conditions.push(eq(rakeEvents.rakeId, query.rakeId));
    if (query.from) conditions.push(gte(rakeEvents.occurredAt, query.from));
    if (query.to) conditions.push(lte(rakeEvents.occurredAt, query.to));

    return repo.paginate(
      {
        page: query.page,
        limit: query.limit,
        sort: "occurredAt",
        order: query.order ?? "desc",
      },
      and(...conditions),
    );
  }

  /**
   * The map feed: every active rake with a resolved position, plus the
   * terminals to draw under them.
   *
   * A **LEFT JOIN from `rakes`**, not an inner join from `rake_states`. A rake
   * that has never received an event has no projection row, and it is still a
   * real rake standing at a real station — dropping it would make the map
   * disagree with the fleet list for no reason a user could work out.
   * `COALESCE` falls back to the seeded projection cache in exactly that case.
   *
   * One query, not one per rake. Forty rakes is nothing today, but this is the
   * endpoint every open browser tab hits every five seconds, so N+1 here is a
   * load test that fails at demo scale.
   */
  async networkLive(orgId: string): Promise<NetworkLive> {
    const now = new Date();

    const rows = await this.database
      .select({
        rakeId: rakes.id,
        code: rakes.code,
        wagonTypeCode: rakes.wagonTypeCode,
        wagonCount: rakes.wagonCount,
        homeDivision: rakes.homeDivision,
        state: sql<string>`coalesce(${rakeStates.state}, ${rakes.currentState})`,
        previousState: rakeStates.previousState,
        since: sql<Date>`coalesce(${rakeStates.since}, ${rakes.stateSince})`,
        stationCode: sql<
          string | null
        >`coalesce(${rakeStates.stationCode}, ${rakes.currentStation})`,
        stationName: stations.name,
        lat: stations.lat,
        lng: stations.lng,
        terminalId: rakeStates.terminalId,
        cycleId: rakeStates.cycleId,
        lastEventAt: rakeStates.lastEventAt,
        isDirty: sql<boolean>`coalesce(${rakeStates.isDirty}, false)`,
      })
      .from(rakes)
      .leftJoin(rakeStates, eq(rakeStates.rakeId, rakes.id))
      .leftJoin(
        stations,
        eq(
          stations.code,
          sql`coalesce(${rakeStates.stationCode}, ${rakes.currentStation})`,
        ),
      )
      .where(and(eq(rakes.orgId, orgId), eq(rakes.isActive, true)))
      .orderBy(asc(rakes.code));

    const liveRakes: LiveRake[] = rows.map((row) => {
      const since = new Date(row.since);
      const state = row.state as LiveRake["state"];

      return {
        rakeId: row.rakeId,
        code: row.code,
        wagonTypeCode: row.wagonTypeCode,
        wagonCount: row.wagonCount,
        homeDivision: row.homeDivision,
        state,
        previousState: row.previousState,
        stateGroup: STATE_GROUP[state],
        since: since.toISOString(),
        hoursInState:
          Math.round(((now.getTime() - since.getTime()) / MS_PER_HOUR) * 10) /
          10,
        stationCode: row.stationCode,
        stationName: row.stationName,
        lat: row.lat,
        lng: row.lng,
        terminalId: row.terminalId,
        cycleId: row.cycleId,
        lastEventAt: row.lastEventAt?.toISOString() ?? null,
        isDirty: row.isDirty,
      };
    });

    const terminalRows = await this.database
      .select({
        id: terminals.id,
        code: terminals.code,
        name: terminals.name,
        stationCode: terminals.stationCode,
        lat: stations.lat,
        lng: stations.lng,
        placementLines: terminals.placementLines,
        isMechanised: terminals.isMechanised,
      })
      .from(terminals)
      .innerJoin(stations, eq(stations.code, terminals.stationCode))
      .where(and(eq(terminals.orgId, orgId), eq(terminals.isActive, true)))
      .orderBy(asc(terminals.code));

    const counts: Record<string, number> = {};
    for (const rake of liveRakes) {
      counts[rake.state] = (counts[rake.state] ?? 0) + 1;
    }

    return {
      asOf: now.toISOString(),
      rakes: liveRakes,
      terminals: terminalRows as LiveTerminal[],
      counts,
    };
  }

  /**
   * The controller's fleet list — one row per rake with its live state and how
   * many turnarounds it has completed.
   *
   * The cycle count is a correlated subquery rather than a join with a GROUP BY
   * so that the page still returns one row per rake when a rake has no cycles
   * at all, which every rake does until its first event.
   */
  async listRakesWithState(
    orgId: string,
    query: { page?: number; limit?: number; state?: string; search?: string },
  ) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const conditions: SQL[] = [eq(rakes.orgId, orgId)];
    if (query.state) {
      conditions.push(
        sql`coalesce(${rakeStates.state}, ${rakes.currentState})::text = ${query.state}`,
      );
    }
    if (query.search) {
      conditions.push(sql`${rakes.code} ilike ${`%${query.search}%`}`);
    }
    const where = and(...conditions) as SQL;

    const [rows, [total]] = await Promise.all([
      this.database
        .select({
          rakeId: rakes.id,
          code: rakes.code,
          wagonTypeCode: rakes.wagonTypeCode,
          wagonCount: rakes.wagonCount,
          homeDivision: rakes.homeDivision,
          isActive: rakes.isActive,
          state: sql<string>`coalesce(${rakeStates.state}, ${rakes.currentState})`,
          previousState: rakeStates.previousState,
          since: sql<Date>`coalesce(${rakeStates.since}, ${rakes.stateSince})`,
          stationCode: sql<
            string | null
          >`coalesce(${rakeStates.stationCode}, ${rakes.currentStation})`,
          stationName: stations.name,
          cycleId: rakeStates.cycleId,
          lastEventAt: rakeStates.lastEventAt,
          isDirty: sql<boolean>`coalesce(${rakeStates.isDirty}, false)`,
          cycleCount: sql<number>`(
            select count(*)::int from ${rakeCycles}
            where ${rakeCycles.rakeId} = ${rakes.id}
          )`,
          eventCount: sql<number>`(
            select count(*)::int from ${rakeEvents}
            where ${rakeEvents.rakeId} = ${rakes.id} and ${rakeEvents.applied}
          )`,
        })
        .from(rakes)
        .leftJoin(rakeStates, eq(rakeStates.rakeId, rakes.id))
        .leftJoin(
          stations,
          eq(
            stations.code,
            sql`coalesce(${rakeStates.stationCode}, ${rakes.currentStation})`,
          ),
        )
        .where(where)
        .orderBy(desc(rakeStates.lastEventAt), asc(rakes.code))
        .limit(limit)
        .offset((page - 1) * limit),
      this.database
        .select({ value: sql<number>`count(*)::int` })
        .from(rakes)
        .leftJoin(rakeStates, eq(rakeStates.rakeId, rakes.id))
        .where(where),
    ]);

    const totalRows = total?.value ?? 0;

    return {
      data: rows.map((row) => ({
        ...row,
        since: new Date(row.since).toISOString(),
        hoursInState:
          Math.round(
            ((Date.now() - new Date(row.since).getTime()) / MS_PER_HOUR) * 10,
          ) / 10,
        stateGroup: STATE_GROUP[row.state as LiveRake["state"]],
        lastEventAt: row.lastEventAt?.toISOString() ?? null,
      })),
      pagination: {
        page,
        limit,
        total: totalRows,
        totalPages: Math.max(1, Math.ceil(totalRows / limit)),
      },
    };
  }

  /**
   * Every section with the traversals it carried recently, and the coordinates
   * to draw it with (Phase 5, §5.4).
   *
   * Two consumers, one query, and that is why it returns **all** sections
   * rather than only the busy ones:
   *
   *  - the map weights each line by `traversals`, and a section that carried
   *    nothing in the window is a real and interesting zero — a line drawn thin
   *    says something a missing line does not;
   *  - the rake detail sheet draws a selected rake's remaining path, and the
   *    ETA it comes from names sections by id. A response that omitted the
   *    quiet ones would leave gaps in exactly the paths that avoid traffic.
   *
   * A LEFT JOIN from `sections`, so the zero rows survive; the aggregate is a
   * grouped subquery rather than a correlated one so the whole thing is a
   * single pass over the window.
   */
  async sectionLoad(orgId: string, hours = 24): Promise<SectionLoad> {
    const since = new Date(Date.now() - hours * MS_PER_HOUR);

    /**
     * Written as one raw statement rather than through the query builder.
     *
     * The shape needs a **grouped subquery joined back to `sections`**, and the
     * builder's aliasing for that case renders the joined columns unqualified —
     * `coalesce("traversals", 0)` against a subquery also called `traversals`,
     * which Postgres reads as a column reference and refuses. The SQL below is
     * what was meant, it is explicit about every qualification, and the numeric
     * casts are here rather than in JavaScript because `numeric` arrives as a
     * string and a silently-concatenated latitude is a marker in the sea.
     */
    const result = await this.database.execute<{
      section_id: string;
      from_code: string;
      to_code: string;
      distance_km: number;
      from_lat: number;
      from_lng: number;
      to_lat: number;
      to_lng: number;
      traversals: number;
    }>(sql`
      with traversed as (
        select
          e.payload ->> 'sectionId' as section_id,
          count(*)::int             as traversals
        from rake_events e
        where e.org_id = ${orgId}
          and e.event_type = 'SECTION_PASSED'
          and e.applied
          and e.occurred_at >= ${since}
        group by e.payload ->> 'sectionId'
      )
      select
        s.id                          as section_id,
        s.from_code,
        s.to_code,
        s.distance_km::float8         as distance_km,
        f.lat::float8                 as from_lat,
        f.lng::float8                 as from_lng,
        t.lat::float8                 as to_lat,
        t.lng::float8                 as to_lng,
        coalesce(v.traversals, 0)     as traversals
      from sections s
      join stations f on f.code = s.from_code
      join stations t on t.code = s.to_code
      left join traversed v on v.section_id = s.id::text
      order by s.from_code asc, s.to_code asc
    `);

    const sectionRows = result.rows.map((row) => ({
      sectionId: row.section_id,
      fromCode: row.from_code,
      toCode: row.to_code,
      distanceKm: row.distance_km,
      fromLat: row.from_lat,
      fromLng: row.from_lng,
      toLat: row.to_lat,
      toLng: row.to_lng,
      traversals: row.traversals,
    }));

    return {
      asOf: new Date().toISOString(),
      windowHours: hours,
      /**
       * The busiest section in the window, so the client can scale line widths
       * without a second pass. Computed here rather than in the browser because
       * the scale has to be stable across the *whole* network, and a client that
       * filtered before scaling would silently re-normalise the map.
       */
      maxTraversals: sectionRows.reduce(
        (max, row) => Math.max(max, row.traversals),
        0,
      ),
      sections: sectionRows,
    };
  }

  /** Count of rakes standing available — the controller dashboard's first tile. */
  async countAvailable(orgId: string): Promise<number> {
    const [row] = await this.database
      .select({ value: sql<number>`count(*)::int` })
      .from(rakes)
      .leftJoin(rakeStates, eq(rakeStates.rakeId, rakes.id))
      .where(
        and(
          eq(rakes.orgId, orgId),
          eq(rakes.isActive, true),
          sql`coalesce(${rakeStates.state}, ${rakes.currentState}) = 'EMPTY_AVAILABLE'`,
        ),
      );
    return row?.value ?? 0;
  }
}

export default RakeEventService;

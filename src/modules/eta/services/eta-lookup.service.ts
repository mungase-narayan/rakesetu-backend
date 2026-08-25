/**
 * The three ways the product asks for an ETA (§3.3), and the one place that
 * decides a rake has no answerable one.
 *
 *   `etaForRake`          — map, rake detail, terminal board
 *   `etaForRepositioning` — Phase 7's solver: release station → loading terminal
 *   `etaForConsignment`   — Phase 6's customer tracking
 *
 * ---
 *
 * **Nothing here invents a time.** A rake that is standing still, has no
 * declared destination, or sits on a disconnected pair returns a typed
 * `EtaUnavailable` with a sentence a screen can render. The temptation this
 * resists is real: `null` is awkward to render and "about 6 hours" always looks
 * better than "not in transit", right up until a customer plans a truck around
 * it.
 *
 * **Where a destination comes from.** The event log only learned to carry one
 * in Phase 5 — see `DestinationPayload`. Each moving state has exactly one
 * event that could have declared where the rake is headed, and this module
 * reads that event and no other. A history written before the payload existed
 * answers `no_destination`, which is the truthful answer about a log that never
 * said.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db, type DB } from "../../../database/connection";
import {
  rakeCycles,
  rakeEvents,
  rakeStates,
  rakes,
  stations,
  terminals,
  type RakeEventType,
  type RakeState,
} from "../../../schema";
import type { DestinationPayload } from "../../../types/event-payload.types";
import DistanceService from "../../network/services/distance.service";
import SectionWeightService from "./section-weight.service";
import { NoRouteError, estimateEta } from "./eta.service";
import type {
  EtaResult,
  EtaUnavailable,
  RakeEta,
  RakeEtaAnswer,
  SectionWeightMap,
} from "../types/eta.types";

/**
 * The three states in which "where will it get to, and when" is a question with
 * an answer.
 *
 * `AT_DEST_YARD` is deliberately absent: the rake has arrived, and what remains
 * is a placement queue, not a run. Phase 8's terminal simulation owns that
 * wait; pretending an ETA covers it would put a transit estimate on a delay
 * that has nothing to do with track.
 */
const MOVING_STATES: Record<string, RakeEventType> = {
  MOVING_TO_LOADING: "ALLOTTED",
  IN_TRANSIT_LOADED: "LOADED_RELEASED",
  EMPTY_RETURNING: "DEPARTED_EMPTY_RETURN",
};

interface MovingRake {
  rakeId: string;
  code: string;
  wagonTypeCode: string;
  state: RakeState;
  previousState: RakeState | null;
  stationCode: string | null;
  since: Date;
  lastEventAt: Date | null;
  cycleId: string | null;
}

const unavailable = (
  reason: EtaUnavailable["reason"],
  detail: string,
): EtaUnavailable => ({ eta: null, reason, detail });

class EtaLookupService {
  constructor(
    private readonly weightService: SectionWeightService = new SectionWeightService(),
    private readonly distanceService: DistanceService = new DistanceService(),
    private readonly database: DB = db,
  ) {}

  /**
   * The ad-hoc estimate behind `POST /eta/estimate`.
   *
   * Phase 7's cost function calls this signature directly, which is why it
   * takes plain station codes rather than a rake: the solver asks about
   * journeys that have not been allotted to anybody yet.
   */
  async estimate(
    orgId: string,
    input: {
      fromCode: string;
      toCode: string;
      departAt: Date;
      wagonTypeCode: string;
    },
  ): Promise<EtaResult> {
    const [graph, weights] = await Promise.all([
      this.distanceService.loadGraph(),
      this.weightService.getSectionWeights(
        orgId,
        input.wagonTypeCode,
        input.departAt,
      ),
    ]);

    return estimateEta({ ...input, graph, weights });
  }

  /** Where this rake gets to, and when. `null` with a reason when it does not. */
  async etaForRake(orgId: string, rakeId: string): Promise<RakeEtaAnswer> {
    const [rake] = await this.readRakes(orgId, [rakeId]);
    if (!rake) {
      return unavailable(
        "no_position",
        "This rake has no projection yet — no event has been recorded against it.",
      );
    }

    const answers = await this.etaForRakes(orgId, [rake]);
    return answers.get(rakeId) as RakeEtaAnswer;
  }

  /**
   * The empty-haul estimate Phase 7's cost function needs: from where the rake
   * stands now to the station a terminal sits at.
   *
   * Distinct from `etaForRake` because the question is hypothetical — the rake
   * has not been sent there, and asking "what would it cost to send it" is the
   * whole point of a solver.
   */
  async etaForRepositioning(
    orgId: string,
    rakeId: string,
    terminalId: string,
  ): Promise<RakeEtaAnswer> {
    const [rake] = await this.readRakes(orgId, [rakeId]);
    if (!rake) {
      return unavailable("no_position", "This rake has no projection yet.");
    }
    if (!rake.stationCode) {
      return unavailable(
        "no_position",
        `${rake.code} has no known station, so no distance can be measured from it.`,
      );
    }

    const [terminal] = await this.database
      .select({
        id: terminals.id,
        name: terminals.name,
        stationCode: terminals.stationCode,
      })
      .from(terminals)
      .where(and(eq(terminals.orgId, orgId), eq(terminals.id, terminalId)))
      .limit(1);

    if (!terminal) {
      return unavailable(
        "no_destination",
        "That terminal is not on this zone's books.",
      );
    }

    // From now, not from the rake's last event: repositioning is a decision
    // being considered at this moment, and dating it from a crossing that
    // happened six hours ago would put the whole empty haul in the past.
    const departAt = new Date();

    try {
      const eta = await this.estimate(orgId, {
        fromCode: rake.stationCode,
        toCode: terminal.stationCode,
        departAt,
        wagonTypeCode: rake.wagonTypeCode,
      });

      return {
        eta,
        rakeId: rake.rakeId,
        rakeCode: rake.code,
        state: rake.state,
        destinationStationCode: terminal.stationCode,
        destinationName: terminal.name,
        destinationTerminalId: terminal.id,
        isOverdue: false,
      };
    } catch (error) {
      if (error instanceof NoRouteError) {
        return unavailable(
          "no_route",
          `No route runs from ${rake.stationCode} to ${terminal.stationCode}.`,
        );
      }
      throw error;
    }
  }

  /**
   * Phase 6's customer tracking, answerable today.
   *
   * A consignment is carried by exactly one turnaround, and `rake_cycles`
   * already holds the column that names it — so this resolves the cycle, takes
   * its rake, and asks the same question the map asks. When Phase 6 starts
   * writing `consignment_id`, this begins returning answers without an edit.
   */
  async etaForConsignment(
    orgId: string,
    consignmentId: string,
  ): Promise<RakeEtaAnswer> {
    const [cycle] = await this.database
      .select({ rakeId: rakeCycles.rakeId })
      .from(rakeCycles)
      .where(
        and(
          eq(rakeCycles.orgId, orgId),
          eq(rakeCycles.consignmentId, consignmentId),
        ),
      )
      .orderBy(desc(rakeCycles.startedAt))
      .limit(1);

    if (!cycle) {
      return unavailable(
        "no_cycle",
        "No turnaround carries that consignment yet.",
      );
    }

    return this.etaForRake(orgId, cycle.rakeId);
  }

  /**
   * Many rakes at once — the terminal board's inbound list and the map.
   *
   * The graph and the weight map are loaded **once per wagon type** rather than
   * once per rake. Forty rakes over three wagon types is three cache reads and
   * forty microsecond Dijkstras; doing it the obvious way would be forty cache
   * reads on the endpoint every open browser tab hits.
   */
  async etaForRakes(
    orgId: string,
    input: readonly MovingRake[] | readonly string[],
  ): Promise<Map<string, RakeEtaAnswer>> {
    const list: MovingRake[] =
      typeof input[0] === "string" || input.length === 0
        ? await this.readRakes(orgId, input as readonly string[])
        : (input as MovingRake[]);

    const answers = new Map<string, RakeEtaAnswer>();
    if (list.length === 0) return answers;

    const movable: {
      rake: MovingRake;
      toCode: string;
      terminalId: string | null;
    }[] = [];

    const destinations = await this.readDestinations(orgId, list);

    for (const rake of list) {
      const declaring = MOVING_STATES[rake.state];

      if (!declaring) {
        answers.set(
          rake.rakeId,
          unavailable(
            "not_in_transit",
            rake.previousState
              ? `${rake.code} is ${humanState(rake.state)} — it was ${humanState(rake.previousState)} before the exception.`
              : `${rake.code} is ${humanState(rake.state)}, not in transit.`,
          ),
        );
        continue;
      }

      if (!rake.cycleId) {
        answers.set(
          rake.rakeId,
          unavailable(
            "no_cycle",
            `${rake.code} is not filed under a turnaround, so there is nothing to estimate against.`,
          ),
        );
        continue;
      }

      if (!rake.stationCode) {
        answers.set(
          rake.rakeId,
          unavailable("no_position", `${rake.code} has no last known station.`),
        );
        continue;
      }

      const declared = destinations.get(rake.rakeId);
      if (!declared?.toStationCode) {
        answers.set(
          rake.rakeId,
          unavailable(
            "no_destination",
            `No ${declaring} event in ${rake.code}'s current turnaround named a destination.`,
          ),
        );
        continue;
      }

      movable.push({
        rake,
        toCode: declared.toStationCode,
        terminalId: declared.toTerminalId ?? null,
      });
    }

    if (movable.length === 0) return answers;

    const graph = await this.distanceService.loadGraph();
    const weightsByType = await this.loadWeights(
      orgId,
      movable.map(({ rake }) => rake.wagonTypeCode),
    );
    const names = await this.stationNames(movable.map(({ toCode }) => toCode));
    const now = Date.now();

    for (const { rake, toCode, terminalId } of movable) {
      // The rake left its last known station at `lastEventAt`; the remaining
      // run starts from there. Dating it from `now` would silently add however
      // long the feed has been quiet to every estimate — and an arrival that is
      // already in the past is information, not an error, so it is reported as
      // `isOverdue` rather than nudged forward.
      const departAt = rake.lastEventAt ?? rake.since;

      try {
        const eta = estimateEta({
          fromCode: rake.stationCode as string,
          toCode,
          departAt,
          wagonTypeCode: rake.wagonTypeCode,
          graph,
          weights: weightsByType.get(rake.wagonTypeCode) as SectionWeightMap,
        });

        answers.set(rake.rakeId, {
          eta,
          rakeId: rake.rakeId,
          rakeCode: rake.code,
          state: rake.state,
          destinationStationCode: toCode,
          destinationName: names.get(toCode) ?? null,
          destinationTerminalId: terminalId,
          isOverdue: eta.arrivalAt.getTime() < now,
        } satisfies RakeEta);
      } catch (error) {
        if (error instanceof NoRouteError) {
          answers.set(
            rake.rakeId,
            unavailable(
              "no_route",
              `No route runs from ${rake.stationCode} to ${toCode}.`,
            ),
          );
          continue;
        }
        throw error;
      }
    }

    return answers;
  }

  /** Every rake currently in a state an ETA can be computed for. */
  async movingRakes(orgId: string): Promise<MovingRake[]> {
    return this.readRakes(
      orgId,
      null,
      Object.keys(MOVING_STATES) as RakeState[],
    );
  }

  // -------------------------------------------------------------------------

  private async readRakes(
    orgId: string,
    rakeIds: readonly string[] | null,
    states?: readonly RakeState[],
  ): Promise<MovingRake[]> {
    if (rakeIds !== null && rakeIds.length === 0) return [];

    const conditions = [eq(rakes.orgId, orgId)];
    if (rakeIds !== null) conditions.push(inArray(rakes.id, [...rakeIds]));
    if (states) {
      conditions.push(inArray(rakeStates.state, [...states]));
    }

    const rows = await this.database
      .select({
        rakeId: rakes.id,
        code: rakes.code,
        wagonTypeCode: rakes.wagonTypeCode,
        state: rakeStates.state,
        previousState: rakeStates.previousState,
        stationCode: rakeStates.stationCode,
        since: rakeStates.since,
        lastEventAt: rakeStates.lastEventAt,
        cycleId: rakeStates.cycleId,
      })
      .from(rakes)
      .innerJoin(rakeStates, eq(rakeStates.rakeId, rakes.id))
      .where(and(...conditions));

    return rows as MovingRake[];
  }

  /**
   * The destination each rake's current turnaround declared, in one query.
   *
   * `DISTINCT ON` rather than a correlated subquery per rake: the board asks
   * this about every inbound rake at once, and Postgres answers it with one
   * index scan over `(rake_id, occurred_at)`.
   */
  private async readDestinations(
    orgId: string,
    list: readonly MovingRake[],
  ): Promise<Map<string, DestinationPayload>> {
    const targets = list.filter(
      (rake) => rake.cycleId && MOVING_STATES[rake.state],
    );
    if (targets.length === 0) return new Map();

    const rows = await this.database
      .select({
        rakeId: rakeEvents.rakeId,
        eventType: rakeEvents.eventType,
        cycleId: rakeEvents.cycleId,
        payload: rakeEvents.payload,
        occurredAt: rakeEvents.occurredAt,
      })
      .from(rakeEvents)
      .where(
        and(
          eq(rakeEvents.orgId, orgId),
          eq(rakeEvents.applied, true),
          inArray(
            rakeEvents.rakeId,
            targets.map((rake) => rake.rakeId),
          ),
          inArray(
            rakeEvents.cycleId,
            targets.map((rake) => rake.cycleId as string),
          ),
          inArray(rakeEvents.eventType, [
            "ALLOTTED",
            "LOADED_RELEASED",
            "DEPARTED_EMPTY_RETURN",
          ]),
        ),
      )
      .orderBy(desc(rakeEvents.occurredAt));

    const wanted = new Map(
      targets.map((rake) => [
        rake.rakeId,
        {
          cycleId: rake.cycleId as string,
          eventType: MOVING_STATES[rake.state],
        },
      ]),
    );

    const out = new Map<string, DestinationPayload>();
    for (const row of rows) {
      const target = wanted.get(row.rakeId);
      if (!target) continue;
      if (out.has(row.rakeId)) continue;
      if (row.cycleId !== target.cycleId) continue;
      if (row.eventType !== target.eventType) continue;
      out.set(row.rakeId, (row.payload ?? {}) as DestinationPayload);
    }

    return out;
  }

  private async loadWeights(
    orgId: string,
    wagonTypeCodes: readonly string[],
  ): Promise<Map<string, SectionWeightMap>> {
    const unique = [...new Set(wagonTypeCodes)];
    const entries = await Promise.all(
      unique.map(
        async (code) =>
          [
            code,
            await this.weightService.getSectionWeights(orgId, code),
          ] as const,
      ),
    );
    return new Map(entries);
  }

  private async stationNames(
    codes: readonly string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) return new Map();

    const rows = await this.database
      .select({ code: stations.code, name: stations.name })
      .from(stations)
      .where(inArray(stations.code, unique));

    return new Map(rows.map((row) => [row.code, row.name]));
  }
}

/** `MOVING_TO_LOADING` → "moving to the loading point". For a sentence, not a badge. */
const humanState = (state: string): string =>
  state.toLowerCase().replace(/_/g, " ");

export { MOVING_STATES };
export type { MovingRake };
export default EtaLookupService;

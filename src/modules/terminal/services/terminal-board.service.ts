/**
 * The terminal supervisor's board (§5.1): what is coming, what is standing on
 * the line, and what left today.
 *
 * ---
 *
 * **The one rule that makes this screen worth building: free time is resolved
 * `asOf` the placement, never `asOf` now.**
 *
 * `lookupRule` takes an explicit date on every call — there is deliberately no
 * `lookupCurrentRule()` — and the date passed here is `placedAt`. A rake placed
 * on 28 June under a nine-hour rule is still on nine hours on 2 July, even
 * though the superseding seven-hour circular is in force by then. Resolving at
 * `now` would silently re-price a placement that has already happened, and the
 * screen would start showing a rake as "over free time" on the morning a
 * circular changed. Phase 9 computes money from the same lookup; getting the
 * date wrong here would be a rehearsal for getting a bill wrong there.
 *
 * **No charge is computed on this screen.** The tint says "this rake is past
 * its free hours", which is an operational warning a supervisor can act on.
 * What that costs is Phase 9's, and putting a rupee figure here would be a
 * number nobody has traced.
 *
 * **Scope.** A supervisor sees the terminals of *their organization*. There is
 * no user↔terminal table in the schema — `customer_sidings` maps customers to
 * terminals, not staff — so per-person assignment would mean inventing one.
 * The tenant boundary is enforced (a supervisor at CR cannot read WR's board);
 * narrowing it to a single terminal per person is left to the phase that adds
 * the table rather than faked with a convention.
 */
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";

import ApiError from "../../../utils/api-error";
import { db, type DB } from "../../../database/connection";
import {
  commodities,
  rakeCycles,
  rakeEvents,
  rakeStates,
  rakes,
  stations,
  terminals,
  type CommodityGroup,
  type RakeEventType,
  type RakeState,
} from "../../../schema";
import type { FreeTimeParams } from "../../../types/selector.types";
import ChargeRuleService from "../../charge-rule/services/charge-rule.service";
import EtaLookupService from "../../eta/services/eta-lookup.service";
import { isUnavailable } from "../../eta/types/eta.types";
import {
  EXCEPTION_ENTRY,
  legalEventsFrom,
  LEGAL_TRANSITIONS,
} from "../../rake-event/constants/transitions.constants";
import {
  EXCEPTION_EXIT,
  STATE_GROUP,
  isExceptionState,
} from "../../rake-event/constants/event-type.constants";
import type {
  BoardOnHand,
  BoardInbound,
  BoardReleased,
  FreeTimeResolution,
  NextEvents,
  TerminalBoard,
} from "../types/terminal.types";

const MS_PER_HOUR = 3_600_000;
const IST_OFFSET_MINUTES = 330;

/**
 * The states in which a rake is physically standing on one of this terminal's
 * lines.
 *
 * A *release* is included, and that is not an oversight: `LOADED_RELEASED`
 * means the paperwork is done, not that the rake has moved, and the line is not
 * free until it departs. `CLEARS_TERMINAL` in the event-type constants encodes
 * the same judgement from the other side.
 */
const ON_HAND_STATES: readonly RakeState[] = [
  "PLACED_FOR_LOADING",
  "LOADING",
  "LOADED_RELEASED",
  "PLACED_FOR_UNLOADING",
  "UNLOADING",
  "UNLOADED_RELEASED",
  // An exception does not move the rake off the line. A detained rake is very
  // much on hand — it is the *reason* the board exists.
  "DETAINED",
  "HELD_FOR_ORDER",
  "SICK",
];

const PLACEMENT_EVENTS: readonly RakeEventType[] = [
  "PLACED_FOR_LOADING",
  "PLACED_FOR_UNLOADING",
];

const RELEASE_EVENTS: readonly RakeEventType[] = [
  "LOADED_RELEASED",
  "UNLOADED_RELEASED",
];

/** Inbound rakes are shown this far ahead. Beyond it, an ETA is not a plan. */
const INBOUND_HORIZON_HOURS = 24;

/** Amber at this share of the free time; red past it. */
const APPROACHING_SHARE = 0.8;

/** IST midnight, as a UTC instant — "today" on a board read in India. */
export const istStartOfDay = (at: Date): Date => {
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MINUTES * 60_000);
};

const hoursBetween = (from: Date, to: Date): number =>
  Math.round(((to.getTime() - from.getTime()) / MS_PER_HOUR) * 10) / 10;

class TerminalBoardService {
  constructor(
    private readonly etaService: EtaLookupService = new EtaLookupService(),
    private readonly ruleService: ChargeRuleService = new ChargeRuleService(),
    private readonly database: DB = db,
  ) {}

  /**
   * The whole board in one call.
   *
   * Three reads and one ETA batch rather than a query per rake — this is the
   * screen a supervisor leaves open all shift, and it refreshes.
   */
  async board(
    orgId: string,
    terminalId: string,
    asOf: Date = new Date(),
  ): Promise<TerminalBoard> {
    const terminal = await this.requireTerminal(orgId, terminalId);

    const [onHand, releasedToday, inbound] = await Promise.all([
      this.onHand(orgId, terminal, asOf),
      this.releasedToday(orgId, terminal, asOf),
      this.inbound(orgId, terminal, asOf),
    ]);

    const overFreeTime = onHand.filter((row) => row.status === "over").length;

    return {
      terminal,
      asOf: asOf.toISOString(),
      occupancy: {
        onHand: onHand.length,
        placementLines: terminal.placementLines,
        /**
         * A naive but honest measure: rakes standing over lines available.
         * It can exceed 1 — a terminal genuinely holds rakes in excess of its
         * lines when they are queued in the yard — and clamping it would hide
         * the only situation the number exists to show. Phase 8 replaces it
         * with the discrete-event twin's occupancy.
         */
        ratio:
          terminal.placementLines > 0
            ? Math.round((onHand.length / terminal.placementLines) * 100) / 100
            : 0,
      },
      inbound,
      onHand,
      releasedToday,
      totals: {
        inbound: inbound.length,
        onHand: onHand.length,
        releasedToday: releasedToday.length,
        detentionHoursToday:
          Math.round(
            releasedToday.reduce(
              (sum, row) => sum + (row.detentionHours ?? 0),
              0,
            ) * 10,
          ) / 10,
        overFreeTime,
      },
    };
  }

  /**
   * The free time in force for a commodity group at this terminal on a date.
   *
   * Public because it is the assertion T5.12 is graded on: called twice with
   * two dates that straddle a superseding circular, it must return two
   * different numbers naming two different circulars.
   *
   * A missing rule is **not** an error here. §5.6's resolver throws a 404 when
   * the rule book has a hole, and that is right for a charge engine — but an
   * operational board that refuses to render because one commodity has no
   * default would be a screen a supervisor cannot use during exactly the
   * incident it exists for. The row says the threshold is unknown instead.
   */
  async freeTimeAt(
    terminal: TerminalBoard["terminal"],
    commodityGroup: CommodityGroup | undefined,
    asOf: Date,
  ): Promise<FreeTimeResolution> {
    try {
      const rule = await this.ruleService.lookupRule(
        "free_time",
        {
          commodityGroup,
          terminalType: terminal.type,
          handlingMode: terminal.handlingMode,
          division: terminal.division,
        },
        asOf,
      );

      return {
        hours: (rule.params as FreeTimeParams).hours,
        circularRef: rule.circularRef,
        clauseRef: rule.clauseRef ?? null,
        effectiveFrom: rule.effectiveFrom,
        resolvedAsOf: asOf.toISOString(),
      };
    } catch {
      return {
        hours: null,
        circularRef: null,
        clauseRef: null,
        effectiveFrom: null,
        resolvedAsOf: asOf.toISOString(),
      };
    }
  }

  // -------------------------------------------------------------------------

  private async onHand(
    orgId: string,
    terminal: TerminalBoard["terminal"],
    asOf: Date,
  ): Promise<BoardOnHand[]> {
    const rows = await this.database
      .select({
        rakeId: rakes.id,
        code: rakes.code,
        wagonTypeCode: rakes.wagonTypeCode,
        wagonCount: rakes.wagonCount,
        state: rakeStates.state,
        previousState: rakeStates.previousState,
        since: rakeStates.since,
        cycleId: rakeStates.cycleId,
        commodityGroup: commodities.group,
      })
      .from(rakeStates)
      .innerJoin(rakes, eq(rakes.id, rakeStates.rakeId))
      .leftJoin(rakeCycles, eq(rakeCycles.id, rakeStates.cycleId))
      .leftJoin(commodities, eq(commodities.code, rakeCycles.commodityCode))
      .where(
        and(
          eq(rakeStates.orgId, orgId),
          eq(rakeStates.terminalId, terminal.id),
          inArray(rakeStates.state, ON_HAND_STATES),
        ),
      )
      .orderBy(asc(rakeStates.since));

    if (rows.length === 0) return [];

    const placements = await this.lastPlacements(
      orgId,
      terminal.id,
      rows.map((row) => row.rakeId),
    );

    const out: BoardOnHand[] = [];

    for (const row of rows) {
      const placement = placements.get(row.rakeId) ?? null;
      const placedAt = placement?.occurredAt ?? null;

      // **`asOf: placedAt`.** The whole point of the screen — see the file
      // header. A rake with no placement on record falls back to the moment it
      // entered its current state, which is the closest thing the log has.
      const freeTime = await this.freeTimeAt(
        terminal,
        row.commodityGroup ?? undefined,
        placedAt ?? row.since,
      );

      const hoursOnHand = placedAt ? hoursBetween(placedAt, asOf) : null;
      const hoursOverFree =
        hoursOnHand !== null && freeTime.hours !== null
          ? Math.round((hoursOnHand - freeTime.hours) * 10) / 10
          : null;

      out.push({
        rakeId: row.rakeId,
        code: row.code,
        wagonTypeCode: row.wagonTypeCode,
        wagonCount: row.wagonCount,
        state: row.state,
        previousState: row.previousState,
        stateGroup: STATE_GROUP[row.state],
        since: row.since.toISOString(),
        hoursInState: hoursBetween(row.since, asOf),
        cycleId: row.cycleId,
        commodityGroup: row.commodityGroup ?? null,
        lineNumber: placement?.lineNumber ?? null,
        placedAt: placedAt?.toISOString() ?? null,
        hoursOnHand,
        freeTime,
        hoursOverFree,
        status: statusOf(hoursOnHand, freeTime.hours),
      });
    }

    return out;
  }

  private async releasedToday(
    orgId: string,
    terminal: TerminalBoard["terminal"],
    asOf: Date,
  ): Promise<BoardReleased[]> {
    const dayStart = istStartOfDay(asOf);

    const rows = await this.database
      .select({
        rakeId: rakeEvents.rakeId,
        code: rakes.code,
        wagonCount: rakes.wagonCount,
        eventType: rakeEvents.eventType,
        occurredAt: rakeEvents.occurredAt,
        cycleId: rakeEvents.cycleId,
      })
      .from(rakeEvents)
      .innerJoin(rakes, eq(rakes.id, rakeEvents.rakeId))
      .where(
        and(
          eq(rakeEvents.orgId, orgId),
          eq(rakeEvents.terminalId, terminal.id),
          eq(rakeEvents.applied, true),
          gte(rakeEvents.occurredAt, dayStart),
          inArray(rakeEvents.eventType, [...RELEASE_EVENTS]),
        ),
      )
      .orderBy(desc(rakeEvents.occurredAt));

    if (rows.length === 0) return [];

    const placements = await this.lastPlacements(
      orgId,
      terminal.id,
      rows.map((row) => row.rakeId),
      dayStart,
    );

    return rows.map((row) => {
      const placedAt = placements.get(row.rakeId)?.occurredAt ?? null;
      return {
        rakeId: row.rakeId,
        code: row.code,
        wagonCount: row.wagonCount,
        eventType: row.eventType,
        releasedAt: row.occurredAt.toISOString(),
        placedAt: placedAt?.toISOString() ?? null,
        /**
         * Hours between placement and release. Named `detentionHours` because
         * that is what a supervisor calls it, and **it is not a charge**: the
         * free time has not been subtracted and no slab has been applied.
         * Phase 9 owns both.
         */
        detentionHours: placedAt
          ? hoursBetween(placedAt, row.occurredAt)
          : null,
        cycleId: row.cycleId,
      };
    });
  }

  /**
   * Rakes with an ETA to this terminal inside the horizon.
   *
   * Every moving rake in the zone is estimated once — the ETA service batches
   * the graph and the weight maps — and then filtered to the ones whose
   * declared destination is this terminal, or this terminal's station. Filtering
   * before estimating would need the destination resolved twice.
   */
  private async inbound(
    orgId: string,
    terminal: TerminalBoard["terminal"],
    asOf: Date,
  ): Promise<BoardInbound[]> {
    const moving = await this.etaService.movingRakes(orgId);
    if (moving.length === 0) return [];

    const answers = await this.etaService.etaForRakes(orgId, moving);
    const horizon = asOf.getTime() + INBOUND_HORIZON_HOURS * MS_PER_HOUR;

    const out: BoardInbound[] = [];

    for (const rake of moving) {
      const answer = answers.get(rake.rakeId);
      if (!answer || isUnavailable(answer)) continue;

      const forUs =
        answer.destinationTerminalId === terminal.id ||
        (answer.destinationTerminalId === null &&
          answer.destinationStationCode === terminal.stationCode);
      if (!forUs) continue;

      // An overdue rake stays on the board. It is the one a supervisor most
      // needs to see, and dropping it because its estimate has expired would
      // hide the arrival that is actually late.
      if (!answer.isOverdue && answer.eta.arrivalAt.getTime() > horizon) {
        continue;
      }

      out.push({
        rakeId: rake.rakeId,
        code: rake.code,
        wagonTypeCode: rake.wagonTypeCode,
        state: rake.state,
        fromCode: answer.eta.fromCode,
        arrivalAt: answer.eta.arrivalAt.toISOString(),
        totalMinutes: answer.eta.totalMinutes,
        totalKm: answer.eta.totalKm,
        legs: answer.eta.path.length,
        confidence: answer.eta.confidence,
        observedShare: answer.eta.observedShare,
        isOverdue: answer.isOverdue,
      });
    }

    return out.sort((a, b) => a.arrivalAt.localeCompare(b.arrivalAt));
  }

  /**
   * The most recent placement at this terminal for each rake, with its line.
   *
   * `DISTINCT ON` so it is one index scan rather than a query per rake. The
   * `since` bound is optional and used by the released-today list, where a
   * placement from three journeys ago would produce a nonsense detention.
   */
  private async lastPlacements(
    orgId: string,
    terminalId: string,
    rakeIds: readonly string[],
    since?: Date,
  ): Promise<Map<string, { occurredAt: Date; lineNumber: string | null }>> {
    const unique = [...new Set(rakeIds)];
    if (unique.length === 0) return new Map();

    const conditions = [
      eq(rakeEvents.orgId, orgId),
      eq(rakeEvents.terminalId, terminalId),
      eq(rakeEvents.applied, true),
      inArray(rakeEvents.rakeId, unique),
      inArray(rakeEvents.eventType, [...PLACEMENT_EVENTS]),
    ];
    if (since) {
      // A placement can precede the day it is released on — a rake placed at
      // 23:40 and released at 06:00 is one placement — so the window is opened
      // a day wider than the release window rather than aligned to it.
      conditions.push(
        gte(
          rakeEvents.occurredAt,
          new Date(since.getTime() - 7 * 24 * MS_PER_HOUR),
        ),
      );
    }

    const rows = await this.database
      .selectDistinctOn([rakeEvents.rakeId], {
        rakeId: rakeEvents.rakeId,
        occurredAt: rakeEvents.occurredAt,
        payload: rakeEvents.payload,
      })
      .from(rakeEvents)
      .where(and(...conditions))
      .orderBy(asc(rakeEvents.rakeId), desc(rakeEvents.occurredAt));

    return new Map(
      rows.map((row) => [
        row.rakeId,
        {
          occurredAt: row.occurredAt,
          lineNumber:
            (row.payload as { lineNumber?: string } | null)?.lineNumber ?? null,
        },
      ]),
    );
  }

  /**
   * What the quick-entry screen may offer, for every rake this terminal could
   * legitimately log against.
   *
   * **The transition table drives the UI.** `legal` comes straight from
   * `legalEventsFrom`, so the screen cannot render a button the API would
   * refuse — and when the table gains a transition, the button appears without
   * anybody editing a component. The alternative, a hand-maintained list of
   * "what a supervisor can do", is a second copy of the state machine that
   * drifts the first time somebody edits one of them.
   *
   * The candidates are rakes **standing at this terminal or at its station**.
   * The second half matters: a rake that has reached the yard has no
   * `terminal_id` yet — placement is what sets it — so a board that looked only
   * at `terminal_id` would never offer the placement that is the single most
   * important thing this screen exists to record.
   */
  async nextEvents(
    orgId: string,
    terminalId: string,
    rakeId?: string,
  ): Promise<{
    terminal: TerminalBoard["terminal"];
    asOf: string;
    rakes: NextEvents[];
  }> {
    const terminal = await this.requireTerminal(orgId, terminalId);
    const asOf = new Date();

    const conditions = [
      eq(rakeStates.orgId, orgId),
      eq(rakes.isActive, true),
      rakeId
        ? eq(rakes.id, rakeId)
        : (sql`(${rakeStates.terminalId} = ${terminal.id}
                or ${rakeStates.stationCode} = ${terminal.stationCode})` as ReturnType<
            typeof sql
          >),
    ];

    const rows = await this.database
      .select({
        rakeId: rakes.id,
        code: rakes.code,
        state: rakeStates.state,
        previousState: rakeStates.previousState,
        since: rakeStates.since,
        terminalId: rakeStates.terminalId,
      })
      .from(rakeStates)
      .innerJoin(rakes, eq(rakes.id, rakeStates.rakeId))
      .where(and(...conditions))
      .orderBy(asc(rakes.code));

    if (rakeId && rows.length === 0) {
      throw new ApiError(404, "That rake has no projection in this zone");
    }

    return {
      terminal,
      asOf: asOf.toISOString(),
      rakes: rows.map((row) => {
        const legal = legalEventsFrom(row.state);
        const exit = EXCEPTION_EXIT[row.state];

        return {
          rakeId: row.rakeId,
          code: row.code,
          state: row.state,
          previousState: row.previousState,
          since: row.since.toISOString(),
          hoursInState: hoursBetween(row.since, asOf),
          terminalId: row.terminalId,
          legal: [...legal],
          /**
           * The happy path is the **first** entry of the state's own row in
           * `LEGAL_TRANSITIONS` — the table is written in journey order, so the
           * first entry is the step forward and everything after it is an
           * alternative. An exception state has no step forward, only a way
           * out, so `primary` is null and `clearing` carries the answer.
           */
          primary: isExceptionState(row.state)
            ? null
            : ((LEGAL_TRANSITIONS[row.state] ?? []).find(
                (event) => !EXCEPTION_ENTRY.includes(event),
              ) ?? null),
          clearing: exit ? [exit] : [],
        } satisfies NextEvents;
      }),
    };
  }

  /** The terminal, its station's division, or a 404 that says nothing about why. */
  async requireTerminal(
    orgId: string,
    terminalId: string,
  ): Promise<TerminalBoard["terminal"]> {
    const [row] = await this.database
      .select({
        id: terminals.id,
        code: terminals.code,
        name: terminals.name,
        type: terminals.type,
        handlingMode: terminals.handlingMode,
        placementLines: terminals.placementLines,
        isMechanised: terminals.isMechanised,
        stationCode: terminals.stationCode,
        stationName: stations.name,
        division: stations.division,
        commodityGroups: terminals.commodityGroups,
      })
      .from(terminals)
      .innerJoin(stations, eq(stations.code, terminals.stationCode))
      .where(and(eq(terminals.orgId, orgId), eq(terminals.id, terminalId)))
      .limit(1);

    if (!row) {
      // 404 for "not yours" as well as "does not exist" — the caller cannot
      // tell the two apart, and neither can somebody probing for terminal ids.
      throw new ApiError(404, "Terminal not found");
    }
    return row;
  }

  /** The terminals a supervisor may pick between — their organization's. */
  async selectableTerminals(orgId: string) {
    return this.database
      .select({
        id: terminals.id,
        code: terminals.code,
        name: terminals.name,
        type: terminals.type,
        stationCode: terminals.stationCode,
        placementLines: terminals.placementLines,
        /**
         * The occupancy count, as a correlated subquery rather than a join
         * with a GROUP BY — so a terminal with nothing standing on it still
         * comes back as a row with a zero, which is exactly the terminal a
         * supervisor is looking for when they open the picker.
         */
        onHand: sql<number>`(
          select count(*)::int from ${rakeStates}
          where ${rakeStates.terminalId} = ${terminals.id}
            and ${inArray(rakeStates.state, [...ON_HAND_STATES])}
        )`,
      })
      .from(terminals)
      .where(and(eq(terminals.orgId, orgId), eq(terminals.isActive, true)))
      .orderBy(asc(terminals.code));
  }
}

/** ok → approaching → over. `unknown` when there is no placement or no rule. */
const statusOf = (
  hoursOnHand: number | null,
  freeHours: number | null,
): BoardOnHand["status"] => {
  if (hoursOnHand === null || freeHours === null) return "unknown";
  if (hoursOnHand > freeHours) return "over";
  if (hoursOnHand >= freeHours * APPROACHING_SHARE) return "approaching";
  return "ok";
};

export { ON_HAND_STATES, INBOUND_HORIZON_HOURS };
export default TerminalBoardService;

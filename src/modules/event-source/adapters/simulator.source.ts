/**
 * The synthetic `EventSource` — DESIGN.md §14's mitigation for having no live
 * FOIS feed, built as an adapter rather than a script so the seam is real.
 *
 * This class does the I/O the generator refuses to: it loads the seeded world
 * out of Postgres and turns a generated array into a stream. Everything that
 * *decides* what happens lives in `journey.generator.ts` and is pure, which is
 * why "same `--seed` → identical stream" is a property a test can assert
 * without a database.
 *
 * `backfill` is the demo path (`--days 30`) and `start` is the live one: the
 * same generated stream, released against a clock compressed by `--speed`, so a
 * controller watching the map sees markers move rather than teleport.
 */
import { asc, eq } from "drizzle-orm";

import { db, type DB } from "../../../database/connection";
import {
  commodities,
  rakeStates,
  rakes,
  sections,
  terminals,
  wagonTypes,
} from "../../../schema";
import { buildGraph, type GraphEdge } from "../../network/services/graph";
import type { EventSource, IncomingEvent } from "../types/event-source.types";
import {
  DEFAULT_RATES,
  generateJourneys,
  type InjectionRates,
  type SimRake,
  type SimTerminal,
  type World,
} from "./journey.generator";

export interface SimulatorOptions {
  orgId: string;
  seed?: number;
  /** Wall-clock compression for `start()`. 100 → a simulated hour every 36 s. */
  speed?: number;
  /** How far back `start()` seeds its history before going live. */
  days?: number;
  rates?: Partial<InjectionRates>;
  /** Stamped on every event as `source_ref`. Defaults to the seed. */
  runRef?: string;
}

class SimulatorSource implements EventSource {
  readonly name = "simulator";

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private world: World | null = null;

  constructor(
    private readonly options: SimulatorOptions,
    private readonly database: DB = db,
  ) {}

  private get seed(): number {
    return this.options.seed ?? 42;
  }

  private get runRef(): string {
    return this.options.runRef ?? String(this.seed);
  }

  private get rates(): InjectionRates {
    return { ...DEFAULT_RATES, ...this.options.rates };
  }

  /**
   * Loads the world once and caches it.
   *
   * Once, because the network and the fleet do not change during a run and
   * re-reading them per journey would make the generator's determinism depend
   * on query timing. The cache is also what lets `backfill` and `start` in the
   * same process produce one continuous history.
   */
  async loadWorld(): Promise<World> {
    if (this.world) return this.world;

    const { orgId } = this.options;

    const [rakeRows, terminalRows, sectionRows, commodityRows] =
      await Promise.all([
        this.database
          .select({
            id: rakes.id,
            code: rakes.code,
            wagonCount: rakes.wagonCount,
            wagonTypeCode: rakes.wagonTypeCode,
            homeDivision: rakes.homeDivision,
            currentStation: rakes.currentStation,
            ccT: wagonTypes.ccT,
            // The projection, not the mirror on `rakes` — they agree today, and
            // the projection is the one that stays right if they ever do not.
            resumeState: rakeStates.state,
            resumeAt: rakeStates.lastEventAt,
            resumeStation: rakeStates.stationCode,
          })
          .from(rakes)
          .innerJoin(wagonTypes, eq(wagonTypes.code, rakes.wagonTypeCode))
          .leftJoin(rakeStates, eq(rakeStates.rakeId, rakes.id))
          .where(eq(rakes.orgId, orgId))
          .orderBy(asc(rakes.code)),
        this.database
          .select()
          .from(terminals)
          .where(eq(terminals.orgId, orgId))
          .orderBy(asc(terminals.code)),
        this.database.select().from(sections).orderBy(asc(sections.id)),
        this.database.select().from(commodities).orderBy(asc(commodities.code)),
      ]);

    const edges: GraphEdge[] = sectionRows.map((row) => ({
      id: row.id,
      from: row.fromCode,
      to: row.toCode,
      distanceKm: row.distanceKm,
      nominalSpeedKmph: row.nominalSpeedKmph,
    }));

    const commoditiesByGroup = new Map<string, string[]>();
    for (const row of commodityRows) {
      const list = commoditiesByGroup.get(row.group) ?? [];
      list.push(row.code);
      commoditiesByGroup.set(row.group, list);
    }

    const simRakes: SimRake[] = rakeRows
      // A rake with no seeded position has nowhere to depart from. Skipping it
      // is honest; inventing a station for it would put a marker on the map at
      // a place the fleet register does not claim it is.
      .filter((row) => row.currentStation !== null)
      .map((row) => ({
        id: row.id,
        code: row.code,
        wagonCount: row.wagonCount,
        wagonTypeCode: row.wagonTypeCode,
        ccT: row.ccT,
        homeDivision: row.homeDivision,
        startStation: (row.resumeStation ?? row.currentStation) as string,
        resumeState: row.resumeState ?? "EMPTY_AVAILABLE",
        resumeAt: row.resumeAt,
      }));

    const simTerminals: SimTerminal[] = terminalRows
      .filter((row) => row.isActive)
      .map((row) => ({
        id: row.id,
        code: row.code,
        stationCode: row.stationCode,
        avgPlacementMinutes: row.avgPlacementMinutes,
        isMechanised: row.isMechanised,
        placementLines: row.placementLines,
        commodityGroups: row.commodityGroups,
        maxRakeLength: row.maxRakeLength,
      }));

    if (simRakes.length === 0 || simTerminals.length === 0) {
      throw new Error(
        "SimulatorSource: no rakes or terminals for this organization — run `npm run db:seed` first",
      );
    }

    this.world = {
      rakes: simRakes,
      terminals: simTerminals,
      graph: buildGraph(edges),
      commoditiesByGroup,
    };
    return this.world;
  }

  /** The whole window, generated up front and yielded in delivery order. */
  async *backfill(from: Date, to: Date): AsyncIterable<IncomingEvent> {
    const world = await this.loadWorld();

    const events = generateJourneys({
      world,
      from,
      to,
      seed: this.seed,
      runRef: this.runRef,
      rates: this.rates,
    });

    for (const event of events) {
      yield event;
    }
  }

  /**
   * Live mode: keep generating ahead of a compressed clock and release each
   * event when its simulated instant arrives.
   *
   * Resolves as soon as the loop is running — a `start()` that only resolved
   * when the feed ended would be indistinguishable from a hang, and a real
   * feed never ends.
   */
  async start(handler: (event: IncomingEvent) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;

    const speed = Math.max(1, this.options.speed ?? 60);
    const startedAt = Date.now();
    const world = await this.loadWorld();

    // One long window, generated once. Regenerating per tick with the same seed
    // would replay the same journeys forever; regenerating with a new seed
    // would break the "same seed, same run" promise mid-stream.
    const horizonDays = Math.max(1, this.options.days ?? 7);
    const events = generateJourneys({
      world,
      from: new Date(startedAt),
      to: new Date(startedAt + horizonDays * 24 * 60 * 60 * 1000),
      seed: this.seed,
      runRef: this.runRef,
      rates: this.rates,
    });

    let cursor = 0;

    const tick = async (): Promise<void> => {
      if (!this.running) return;

      const simulatedNow = startedAt + (Date.now() - startedAt) * speed;

      while (
        cursor < events.length &&
        events[cursor].occurredAt.getTime() <= simulatedNow
      ) {
        await handler(events[cursor]);
        cursor += 1;
      }

      if (cursor >= events.length) {
        this.running = false;
        return;
      }
      this.timer = setTimeout(() => void tick(), 250);
    };

    this.timer = setTimeout(() => void tick(), 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export default SimulatorSource;

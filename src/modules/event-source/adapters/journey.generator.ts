/**
 * Synthetic freight movement, generated deterministically.
 *
 * **Pure.** No database, no `Date.now()`, no `Math.random()` — the only source
 * of variation is a seeded PRNG threaded through every decision. That is what
 * makes `--seed 42` twice produce a byte-identical stream, and it is not a
 * convenience: DESIGN.md §14 leans on the simulator as the substitute for a
 * live FOIS feed, and a substitute that cannot be replayed is a substitute
 * nobody can debug against or write a test over.
 *
 * **The generator cannot produce an illegal history.** Every sequence below
 * follows `LEGAL_TRANSITIONS`, and a test folds every generated journey through
 * the state machine to prove it. The injected exceptions are exceptions the
 * grammar permits, not violations of it — the anomaly path is exercised by
 * deliberately malformed test fixtures, never by the source that stands in for
 * production.
 *
 * What is injected, and which later phase needs it:
 *
 *  | injection            | needed by                                   |
 *  | -------------------- | ------------------------------------------- |
 *  | over-detention       | Phase 9's demurrage demo has to charge someone |
 *  | rain stoppages       | Phase 10's waiver queue needs claimable events |
 *  | sick wagons          | Phase 7's maintenance constraint needs stock to refuse |
 *  | out-of-order arrivals| Phase 4's own re-projection path, in the demo and not only in tests |
 */
import type { RakeEventType, RakeState } from "../../../schema";
import {
  shortestPath,
  type GraphEdge,
  type NetworkGraph,
} from "../../network/services/graph";
import type { IncomingEvent } from "../types/event-source.types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface SimRake {
  id: string;
  code: string;
  wagonCount: number;
  wagonTypeCode: string;
  /** Carrying capacity per wagon — the loaded weight is derived from it. */
  ccT: number;
  homeDivision: string;
  startStation: string;
  /**
   * Where the rake already stands, per its projection.
   *
   * The simulator **continues** the world; it does not contradict it. A rake
   * caught mid-loading gets the rest of that turnaround before its first
   * invented one, because `EMPTY_AVAILABLE` is not legal from `LOADING` and a
   * source that emitted it anyway would be generating an illegal history —
   * exactly what this module promises it cannot do.
   */
  resumeState: RakeState;
  /** Its last event's instant, or null when it has no history. */
  resumeAt: Date | null;
}

/**
 * What each state still owes before the turnaround can close.
 *
 * Read as the tail of the ladder in `scripts/seed/event.seed.ts` — the same
 * lifecycle, entered partway. `EMPTY_AVAILABLE` owes nothing: it is already at
 * the boundary. The four exception states owe their clearing event first, and
 * then whatever the state they interrupted owed, which is resolved at runtime
 * because only `previous_state` knows what that was.
 */
const COMPLETION_SUFFIX: Record<RakeState, RakeEventType[]> = {
  EMPTY_AVAILABLE: [],
  ALLOTTED: [
    "DEPARTED_EMPTY",
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
    "UNLOADING_STARTED",
    "UNLOADING_COMPLETE",
    "UNLOADED_RELEASED",
  ],
  MOVING_TO_LOADING: [
    "ARRIVED_LOADING_YARD",
    "PLACED_FOR_LOADING",
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
    "UNLOADING_STARTED",
    "UNLOADING_COMPLETE",
    "UNLOADED_RELEASED",
  ],
  PLACED_FOR_LOADING: [
    "LOADING_STARTED",
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
    "UNLOADING_STARTED",
    "UNLOADING_COMPLETE",
    "UNLOADED_RELEASED",
  ],
  LOADING: [
    "LOADING_COMPLETE",
    "LOADED_RELEASED",
    "DEPARTED_ORIGIN",
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
    "UNLOADING_STARTED",
    "UNLOADING_COMPLETE",
    "UNLOADED_RELEASED",
  ],
  LOADED_RELEASED: [
    "DEPARTED_ORIGIN",
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
    "UNLOADING_STARTED",
    "UNLOADING_COMPLETE",
    "UNLOADED_RELEASED",
  ],
  IN_TRANSIT_LOADED: [
    "ARRIVED_DEST",
    "PLACED_FOR_UNLOADING",
    "UNLOADING_STARTED",
    "UNLOADING_COMPLETE",
    "UNLOADED_RELEASED",
  ],
  AT_DEST_YARD: [
    "PLACED_FOR_UNLOADING",
    "UNLOADING_STARTED",
    "UNLOADING_COMPLETE",
    "UNLOADED_RELEASED",
  ],
  PLACED_FOR_UNLOADING: [
    "UNLOADING_STARTED",
    "UNLOADING_COMPLETE",
    "UNLOADED_RELEASED",
  ],
  UNLOADING: ["UNLOADING_COMPLETE", "UNLOADED_RELEASED"],
  UNLOADED_RELEASED: [],
  EMPTY_RETURNING: [],

  DETAINED: ["DETENTION_CLEARED"],
  SICK: ["SICK_CLEARED"],
  DIVERTED: ["DIVERSION_CLEARED"],
  HELD_FOR_ORDER: ["HOLD_RELEASED"],
};

export { COMPLETION_SUFFIX };

export interface SimTerminal {
  id: string;
  code: string;
  stationCode: string;
  avgPlacementMinutes: number;
  isMechanised: boolean;
  placementLines: number;
  commodityGroups: string[];
  maxRakeLength: number;
}

export interface World {
  rakes: SimRake[];
  terminals: SimTerminal[];
  graph: NetworkGraph;
  /** commodity group → the codes in it, so a journey can name what it carried. */
  commoditiesByGroup: Map<string, string[]>;
}

export interface InjectionRates {
  /** Fraction of loadings held far past their free time. */
  detention: number;
  /** Fraction of loadings interrupted by weather. */
  rain: number;
  /** Fraction of loaded runs where a wagon is marked sick in transit. */
  sick: number;
  /** Fraction of section crossings delivered after the one that follows them. */
  outOfOrder: number;
}

export const DEFAULT_RATES: InjectionRates = {
  detention: 0.18,
  rain: 0.08,
  sick: 0.06,
  outOfOrder: 0.03,
};

/**
 * Mulberry32 — the same generator `asset.data.ts` uses, for the same reason.
 * Thirty lines shorter than a dependency, and the only property that matters is
 * that the sequence is identical on every machine.
 */
export const makeRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Random = () => number;

const between = (random: Random, min: number, max: number): number =>
  min + random() * (max - min);

const pick = <T>(random: Random, values: readonly T[]): T =>
  values[Math.floor(random() * values.length)];

/**
 * A draw skewed towards the low end with a long tail — dwell times are not
 * uniform, and a uniform draw makes every terminal look equally busy, which is
 * exactly the signal Phase 8's congestion twin is supposed to find.
 */
const skewed = (random: Random, min: number, max: number): number =>
  min + (max - min) * random() * random();

interface Cursor {
  at: number;
  station: string;
  seq: number;
}

export interface GenerateOptions {
  world: World;
  from: Date;
  to: Date;
  seed: number;
  runRef: string;
  rates?: InjectionRates;
}

/**
 * The whole synthetic stream for a window, **in delivery order**.
 *
 * Delivery order is not `occurred_at` order: a configured fraction of section
 * crossings is deliberately swapped with its neighbour so the ingest sees an
 * event that happened before the one it already applied. That is the only way
 * the re-projection path gets exercised by the demo rather than only by tests,
 * and §13.2's whole claim is about what happens when order is not guaranteed.
 */
export const generateJourneys = (options: GenerateOptions): IncomingEvent[] => {
  const { world, from, to, seed, runRef } = options;
  const rates = options.rates ?? DEFAULT_RATES;
  const random = makeRandom(seed);

  const all: IncomingEvent[] = [];

  for (const rake of world.rakes) {
    all.push(...generateRake(rake, world, from, to, random, runRef, rates));
  }

  /**
   * Truncate at the window's end, so the fleet is caught **mid-journey**.
   *
   * Each rake's loop finishes whatever cycle it has started, which would put
   * every rake past `to` in the same one or two end-of-cycle states — and a map
   * showing forty rakes all `EMPTY_RETURNING` is a map that looks broken. Cut
   * at `to` and the fleet spreads naturally across the lifecycle, which is what
   * a real network looks like at any instant.
   */
  const within = all.filter(
    (event) => event.occurredAt.getTime() <= to.getTime(),
  );

  // Interleave the fleet by time first, **then** disorder it. Doing the swap
  // per-rake beforehand would be pointless: the merge sorts on `occurred_at`
  // and would put every swapped pair straight back into order.
  return applyOutOfOrder(byOccurredAt(within), random, rates.outOfOrder);
};

const generateRake = (
  rake: SimRake,
  world: World,
  from: Date,
  to: Date,
  random: Random,
  runRef: string,
  rates: InjectionRates,
): IncomingEvent[] => {
  const events: IncomingEvent[] = [];
  const cursor: Cursor = {
    // Staggered so forty rakes do not all become available at midnight. A rake
    // that already has history resumes just after its last event instead —
    // writing before it would make every generated event *late*, and a backfill
    // that re-folds the whole history 20,000 times is not a backfill.
    at: Math.max(
      from.getTime() + Math.floor(between(random, 0, 18 * HOUR)),
      (rake.resumeAt?.getTime() ?? 0) + HOUR,
    ),
    station: rake.startStation,
    seq: 0,
  };

  const emit = (
    eventType: RakeEventType,
    extra: Partial<IncomingEvent> = {},
  ): void => {
    events.push({
      rakeId: rake.id,
      eventType,
      occurredAt: new Date(cursor.at),
      stationCode: extra.stationCode ?? cursor.station,
      terminalId: extra.terminalId ?? null,
      payload: extra.payload ?? {},
      source: "simulator",
      sourceRef: runRef,
      /**
       * Deterministic, and keyed on **when** as well as which.
       *
       * The sequence number alone is not enough. A second run against a
       * database this source has already written resumes from a later instant,
       * so its sequence 0 is a different fact from the first run's sequence 0 —
       * and a key that ignored the timestamp would make the second run collide
       * with the first and silently write nothing. Including `occurred_at`
       * keeps a genuinely identical replay idempotent while letting a
       * continuation append.
       */
      idempotencyKey: `sim:${runRef}:${rake.code}:${cursor.at}:${cursor.seq++}`,
    });
  };

  const advance = (ms: number): void => {
    cursor.at += Math.max(MINUTE, Math.floor(ms));
  };

  const end = to.getTime();

  // Finish whatever the rake was already doing, so the first invented cycle
  // starts from a boundary the state machine recognises.
  emitCompletion(rake, emit, advance, random);

  while (cursor.at < end) {
    // ---- the cycle opens ---------------------------------------------------
    emit("EMPTY_AVAILABLE");
    advance(skewed(random, 2 * HOUR, 30 * HOUR));

    const origin = pickTerminal(random, world.terminals, cursor.station);
    const destination = pickTerminal(
      random,
      world.terminals.filter((t) => t.code !== origin.code),
      origin.stationCode,
    );

    const outbound = shortestPath(
      world.graph,
      cursor.station,
      origin.stationCode,
    );
    const loaded = shortestPath(
      world.graph,
      origin.stationCode,
      destination.stationCode,
    );

    if (!outbound || !loaded) {
      // A disconnected pair. Rather than emitting a journey that never
      // arrives, the rake waits and tries a different terminal next round —
      // the alternative would be a gap in the log that looks like data loss.
      advance(6 * HOUR);
      continue;
    }

    /**
     * The allotment names where the rake is going, which is the only reason
     * Phase 5 can estimate an arrival before the rake has arrived. The
     * generator has always known both terminals; until now it kept them to
     * itself and the log said only that *something* had been allotted.
     */
    emit("ALLOTTED", {
      payload: {
        indentId: null,
        toStationCode: origin.stationCode,
        toTerminalId: origin.id,
      },
    });
    advance(between(random, 30 * MINUTE, 3 * HOUR));

    // ---- empty haul to the loading point ----------------------------------
    emit("DEPARTED_EMPTY");
    runSections(outbound.sections, emit, advance, cursor, random);

    advance(between(random, 15 * MINUTE, 90 * MINUTE));
    cursor.station = origin.stationCode;
    emit("ARRIVED_LOADING_YARD");

    // Queueing for a line. A one-line terminal makes rakes wait, which is the
    // congestion Phase 8's discrete-event twin is built to explain.
    advance(
      between(random, 0.5, 2.5) *
        origin.avgPlacementMinutes *
        MINUTE *
        (origin.placementLines === 1 ? 2.2 : 1),
    );

    emit("PLACED_FOR_LOADING", {
      terminalId: origin.id,
      payload: {
        lineNumber: `L${1 + Math.floor(random() * origin.placementLines)}`,
      },
    });

    if (random() < rates.detention) {
      // Held past the free time. Phase 9 charges for this; without it the
      // demurrage screen has nothing to explain.
      advance(between(random, 1, 4) * HOUR);
      emit("DETAINED", {
        terminalId: origin.id,
        payload: {
          reasonCode: pick(random, [
            "labour_unavailable",
            "customer_delay",
            "railway_delay",
          ]),
        },
      });
      advance(between(random, 6, 26) * HOUR);
      emit("DETENTION_CLEARED", { terminalId: origin.id });
    }

    advance(between(random, 20 * MINUTE, 2 * HOUR));
    emit("LOADING_STARTED", { terminalId: origin.id });

    if (random() < rates.rain) {
      // Weather. Phase 10's waiver adjudication needs claimable interruptions,
      // and a claim nobody can substantiate is not a test of adjudication.
      advance(between(random, 1, 5) * HOUR);
      emit("HELD_FOR_ORDER", {
        terminalId: origin.id,
        payload: { reasonCode: "rain_stoppage" },
      });
      advance(between(random, 3, 14) * HOUR);
      emit("HOLD_RELEASED", { terminalId: origin.id });
    }

    const hours = origin.isMechanised
      ? between(random, 3, 7)
      : between(random, 7, 16);
    advance(hours * HOUR);

    const group = pick(random, origin.commodityGroups);
    const commodityCodes = world.commoditiesByGroup.get(group) ?? [];
    const netWeightT =
      Math.round(rake.wagonCount * rake.ccT * between(random, 0.9, 1.0) * 10) /
      10;

    const commodityCode = commodityCodes[0] ?? null;

    emit("LOADING_COMPLETE", {
      terminalId: origin.id,
      payload: {
        netWeightT,
        wagonsLoaded: rake.wagonCount,
        // What the cycle is carrying. Phase 5's terminal board scopes free time
        // by commodity group, and a cycle that never says what is in the wagons
        // resolves the zone-wide default for cement, coal and everything else
        // alike — which makes the temporal-rule demo invisible in the app.
        ...(commodityCode ? { commodityCode } : {}),
      },
    });

    advance(between(random, 40 * MINUTE, 5 * HOUR));
    emit("LOADED_RELEASED", {
      terminalId: origin.id,
      payload: {
        netWeightT,
        // Phase 6 replaces this with a real receipt number issued by the state
        // machine. Until then it is a plausible placeholder the RR screen can
        // render, marked by its `SIM-` prefix so nobody mistakes it for one.
        rrNumber: `SIM-${commodityCode ?? group}-${runRef}-${cursor.seq}`,
        ...(commodityCode ? { commodityCode } : {}),
        // The destination is on the receipt in reality, and it is on the
        // release event here for the same reason — it is what the loaded run
        // is aimed at, and what the ETA engine reads while the rake is moving.
        toStationCode: destination.stationCode,
        toTerminalId: destination.id,
      },
    });

    advance(between(random, 30 * MINUTE, 4 * HOUR));
    emit("DEPARTED_ORIGIN");

    // ---- the loaded run ----------------------------------------------------
    const sickAt =
      random() < rates.sick && loaded.sections.length > 2
        ? 1 + Math.floor(random() * (loaded.sections.length - 2))
        : -1;

    loaded.sections.forEach((section, index) => {
      advance(travelMinutes(section, random) * MINUTE);
      cursor.station = section.to;
      emit("SECTION_PASSED", {
        payload: {
          fromCode: section.from,
          toCode: section.to,
          sectionId: section.id,
        },
      });

      if (index === sickAt) {
        advance(between(random, 30 * MINUTE, 2 * HOUR));
        emit("MARKED_SICK", {
          payload: {
            // The canonical six (src/constants/exception-reason.constants.ts).
            // Simulated and hand-logged exceptions must speak the same
            // vocabulary or Phase 10 adjudicates half a corpus.
            reasonCode: "wagon_defect",
            note: "Detached at the next yard",
          },
        });
        advance(between(random, 4, 20) * HOUR);
        emit("SICK_CLEARED");
      }
    });

    advance(between(random, 20 * MINUTE, 3 * HOUR));
    cursor.station = destination.stationCode;
    emit("ARRIVED_DEST");

    advance(
      between(random, 0.5, 2.5) *
        destination.avgPlacementMinutes *
        MINUTE *
        (destination.placementLines === 1 ? 2.2 : 1),
    );
    emit("PLACED_FOR_UNLOADING", {
      terminalId: destination.id,
      payload: {
        lineNumber: `L${1 + Math.floor(random() * destination.placementLines)}`,
      },
    });

    advance(between(random, 20 * MINUTE, 2 * HOUR));
    emit("UNLOADING_STARTED", { terminalId: destination.id });

    advance(
      (destination.isMechanised
        ? between(random, 2, 6)
        : between(random, 6, 15)) * HOUR,
    );
    emit("UNLOADING_COMPLETE", {
      terminalId: destination.id,
      payload: { netWeightT, wagonsLoaded: rake.wagonCount },
    });

    advance(between(random, 30 * MINUTE, 4 * HOUR));
    emit("UNLOADED_RELEASED", { terminalId: destination.id });

    // ---- the empty return --------------------------------------------------
    // Not every rake runs home. The ones that do spend the interval in
    // EMPTY_RETURNING, which is the span §5.2's `emptyReturn` bucket measures —
    // and a fleet where none of them did would leave that bucket empty forever.
    const returnTo = pickTerminal(random, world.terminals, cursor.station);
    const back =
      random() < 0.7
        ? shortestPath(world.graph, cursor.station, returnTo.stationCode)
        : null;

    if (back && back.sections.length > 0) {
      advance(between(random, 1, 6) * HOUR);
      emit("DEPARTED_EMPTY_RETURN", {
        payload: {
          toStationCode: returnTo.stationCode,
          toTerminalId: returnTo.id,
        },
      });
      runSections(back.sections, emit, advance, cursor, random);
      advance(between(random, 30 * MINUTE, 4 * HOUR));
    } else {
      advance(between(random, 2, 12) * HOUR);
    }
    // The loop's next `EMPTY_AVAILABLE` closes this cycle and opens the next.
  }

  return events;
};

/**
 * Emits the tail of an in-flight turnaround.
 *
 * The rake is where the seed (or a previous run) left it, and the loop below
 * begins each cycle with `EMPTY_AVAILABLE` — which is legal only from
 * `EMPTY_AVAILABLE`, `UNLOADED_RELEASED` or `EMPTY_RETURNING`. Without this the
 * simulator's very first event against a freshly seeded fleet would be refused
 * for 37 of the 40 rakes.
 *
 * An exception state is cleared first and then the suffix of whatever it
 * interrupted is emitted — but the generator does not know what that was, so it
 * resumes conservatively from the state the clearing event is most likely to
 * return to. Getting that wrong costs nothing: the projector restores
 * `previous_state`, and the next event either fits or the rake simply idles
 * until the next `EMPTY_AVAILABLE`.
 */
const emitCompletion = (
  rake: SimRake,
  emit: (type: RakeEventType, extra?: Partial<IncomingEvent>) => void,
  advance: (ms: number) => void,
  random: Random,
): void => {
  const clearing = COMPLETION_SUFFIX[rake.resumeState];
  if (clearing.length === 0) return;

  for (const eventType of clearing) {
    advance(between(random, 40 * MINUTE, 8 * HOUR));
    emit(eventType, { payload: payloadForCompletion(eventType, rake) });
  }
};

/** Just enough payload that a resumed cycle still carries a weight. */
const payloadForCompletion = (
  eventType: RakeEventType,
  rake: SimRake,
): Record<string, never> | { netWeightT: number; wagonsLoaded?: number } => {
  const netWeightT = Math.round(rake.wagonCount * rake.ccT * 0.95 * 10) / 10;
  if (eventType === "LOADING_COMPLETE" || eventType === "UNLOADING_COMPLETE") {
    return { netWeightT, wagonsLoaded: rake.wagonCount };
  }
  if (eventType === "LOADED_RELEASED") return { netWeightT };
  return {};
};

const runSections = (
  sections: readonly GraphEdge[],
  emit: (type: RakeEventType, extra?: Partial<IncomingEvent>) => void,
  advance: (ms: number) => void,
  cursor: Cursor,
  random: Random,
): void => {
  for (const section of sections) {
    advance(travelMinutes(section, random) * MINUTE);
    cursor.station = section.to;
    emit("SECTION_PASSED", {
      payload: {
        fromCode: section.from,
        toCode: section.to,
        sectionId: section.id,
      },
    });
  }
};

/**
 * Free-running time at the section's nominal speed, plus noise.
 *
 * The noise is **asymmetric** — a freight train is occasionally a little faster
 * than nominal and frequently a lot slower, because it is crossed, looped and
 * held. A symmetric ± would give Phase 5's ETA engine a median that matches the
 * timetable, which is the one thing real freight data never does.
 */
const travelMinutes = (section: GraphEdge, random: Random): number => {
  const nominal = (section.distanceKm / section.nominalSpeedKmph) * 60;
  return nominal * between(random, 0.92, 1.55);
};

/** Prefers a terminal that is not where the rake already stands. */
const pickTerminal = (
  random: Random,
  terminals: readonly SimTerminal[],
  avoidStation: string,
): SimTerminal => {
  const elsewhere = terminals.filter((t) => t.stationCode !== avoidStation);
  return pick(random, elsewhere.length > 0 ? elsewhere : terminals);
};

/**
 * Delivers a fraction of section crossings **after** the crossing that follows
 * them, leaving `occurred_at` untouched.
 *
 * Only section crossings, and that restriction is the whole design. A crossing
 * is legal from every state a moving rake can be in, so the pair is legal in
 * either arrival order — the second one to arrive is simply *late*, which sets
 * `is_dirty` and forces a re-projection. Swapping, say, `LOADING_STARTED` with
 * `LOADING_COMPLETE` would instead produce a genuinely illegal transition, and
 * the simulator's contract is that it cannot generate an illegal history: the
 * anomaly path belongs to hand-built fixtures.
 *
 * The partner is the rake's **immediately next event**, and only when that
 * event is itself a crossing. Reaching further — to the next crossing anywhere
 * later in the stream — would straddle a leg boundary, delivering a crossing
 * from the *next* journey while the rake is still being loaded on this one. The
 * ingest would accept it (it is legal from `MOVING_TO_LOADING`), and a re-fold
 * running before the intervening events had arrived would then see a crossing
 * immediately after `PLACED_FOR_LOADING` and quarantine a perfectly good event.
 * Adjacent-only keeps every ordering the swap can produce legal under *any*
 * prefix of the stream, which is the property the ingest actually relies on.
 */
const applyOutOfOrder = (
  events: IncomingEvent[],
  random: Random,
  rate: number,
): IncomingEvent[] => {
  if (rate <= 0) return events;

  const out = [...events];
  const swapped = new Set<number>();

  for (let index = 0; index < out.length; index += 1) {
    if (swapped.has(index)) continue;
    if (out[index].eventType !== "SECTION_PASSED") continue;
    if (random() >= rate) continue;

    const rakeId = out[index].rakeId;
    const next = out.findIndex(
      (event, at) => at > index && event.rakeId === rakeId,
    );
    if (next === -1) continue;
    if (out[next].eventType !== "SECTION_PASSED") continue;

    [out[index], out[next]] = [out[next], out[index]];
    swapped.add(index);
    swapped.add(next);
  }

  return out;
};

/**
 * Merges the per-rake streams into one, ordered by `occurred_at` and **stable**
 * on the original index — so two events at the same instant always merge in one
 * fixed order and the stream stays reproducible.
 */
const byOccurredAt = (events: IncomingEvent[]): IncomingEvent[] =>
  events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const delta = a.event.occurredAt.getTime() - b.event.occurredAt.getTime();
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map(({ event }) => event);

/**
 * The Tier 1 ETA estimator (DESIGN.md §5.4) — **a pure function**.
 *
 * Nothing in this file reads the database, the clock or the environment. It
 * takes a graph, a weight table and a departure time, and returns an arrival.
 * That is not a stylistic preference: §9's first exit criterion is that the
 * estimator runs entirely off a fixture graph, and the only way an ETA is
 * defensible in a viva is if the arithmetic behind it can be reproduced by hand
 * — which requires that every input be visible in the call.
 *
 * The loader that assembles the weight table is `section-weight.service.ts`,
 * and it is emphatically not pure. The two halves live apart for the same
 * reason `state-machine.service.ts` and `projector.service.ts` do.
 *
 * ---
 *
 * **Shortest by time, not by distance.** `graph.shortestPath()` answers a
 * different question — the kilometres the train actually runs, which must not
 * change when somebody edits a speed restriction. This walks the same graph
 * with its own weights and is entitled to prefer a longer route that is faster,
 * because that is the route the rake will be given.
 */
import {
  weightKey,
  hourBandOf,
  MIN_OBSERVATIONS,
} from "../constants/eta.constants";
import {
  CONFIDENCE_HIGH_THRESHOLD,
  CONFIDENCE_LOW_THRESHOLD,
} from "../constants/eta.constants";
import type { GraphEdge, NetworkGraph } from "../../network/services/graph";
import type {
  EtaInput,
  EtaLeg,
  EtaResult,
  HourBand,
  SectionWeightMap,
  WeightSource,
} from "../types/eta.types";

/**
 * Thrown when the destination cannot be reached.
 *
 * A **typed error**, never `Infinity` and never a null that a caller can
 * accidentally render as "0 minutes". §9 makes this its own test case because
 * a silent infinity is the failure mode of every Dijkstra written in a hurry:
 * it propagates into an arithmetic result and surfaces three screens later as
 * an arrival time in the year 275760.
 */
export class NoRouteError extends Error {
  constructor(
    public readonly fromCode: string,
    public readonly toCode: string,
  ) {
    super(`No route from ${fromCode} to ${toCode} over the current network`);
    this.name = "NoRouteError";
  }
}

const MS_PER_MINUTE = 60_000;

/** Free-running minutes at the section's own nominal speed — the cold start. */
export const nominalMinutes = (edge: GraphEdge): number =>
  (edge.distanceKm / edge.nominalSpeedKmph) * 60;

interface ResolvedWeight {
  minutes: number;
  source: WeightSource;
  samples: number;
}

/**
 * What one section costs, entering it in this band.
 *
 * **The cold start lives here and it is a specified behaviour.** A cell with no
 * observations is not an error and not a null — it is the timetable, marked as
 * such. §5.4 derives weights "from historical events"; on a fresh database
 * there are none, so a literal reading produces a product whose first ETA is
 * garbage. The fallback is what makes the first demo honest, and `source`
 * is what stops it from being mistaken for measurement.
 */
export const resolveWeight = (
  edge: GraphEdge,
  band: HourBand,
  weights: SectionWeightMap,
): ResolvedWeight => {
  const cell = weights.get(weightKey(edge.id, band));
  if (cell) {
    return {
      minutes: cell.minutes,
      source: cell.source,
      samples: cell.samples,
    };
  }
  return { minutes: nominalMinutes(edge), source: "nominal", samples: 0 };
};

/**
 * How much of a leg's time rests on observation.
 *
 * An observed edge contributes all of its minutes, a nominal edge none, and a
 * blended edge the same fraction that decided its blend. Anything coarser —
 * counting a blended edge as fully observed, say — would let a section with one
 * traversal push a whole path into "high", which is precisely the overclaim the
 * coverage label exists to avoid.
 */
const observedWeightOf = (leg: ResolvedWeight): number => {
  if (leg.source === "observed") return leg.minutes;
  if (leg.source === "blended") {
    return leg.minutes * Math.min(1, leg.samples / MIN_OBSERVATIONS);
  }
  return 0;
};

const labelFor = (share: number): EtaResult["confidence"] => {
  if (share >= CONFIDENCE_HIGH_THRESHOLD) return "high";
  if (share < CONFIDENCE_LOW_THRESHOLD) return "low";
  return "medium";
};

/** An arrival time with seconds is false precision. Rounded to the minute. */
const roundToMinute = (at: number): Date =>
  new Date(Math.round(at / MS_PER_MINUTE) * MS_PER_MINUTE);

const round1 = (value: number): number => Math.round(value * 10) / 10;

interface Hop {
  edge: GraphEdge;
  band: HourBand;
  weight: ResolvedWeight;
  /** Cumulative minutes at the far end of this edge. */
  elapsed: number;
}

/**
 * Time-dependent Dijkstra.
 *
 * The band is recomputed at each settled node from `departAt + elapsed`, so a
 * rake entering a section at 21:50 crosses into the night band and is costed at
 * night running for that section — which is the detail that makes an ETA
 * defensible rather than a distance divided by an average.
 *
 * The relaxation is a plain linear scan for the minimum, matching
 * `graph.shortestPath()`. The network is sixty stations; a heap would be more
 * code for a saving no profile would show, in a function two later phases
 * depend on being obviously correct.
 *
 * Settling nodes in increasing elapsed-time order stays correct under
 * time-dependent weights because every weight is strictly positive and waiting
 * never helps — arriving at a node earlier can never produce a later arrival at
 * the destination, since the cost of a section is read at entry and no section
 * is ever cheaper to enter later than to enter now by more than the wait. Where
 * that assumption is violated in the real world (a train held for a path) the
 * event log records it as detention, which is not a section weight.
 */
export const estimateEta = (input: EtaInput): EtaResult => {
  const from = input.fromCode.toUpperCase();
  const to = input.toCode.toUpperCase();
  const { graph, weights, departAt, wagonTypeCode } = input;

  if (!graph.has(from) || !graph.has(to)) throw new NoRouteError(from, to);

  if (from === to) {
    // Already there. A real answer, and one the board's "inbound" list needs —
    // a rake standing at the terminal it is bound for is not en route.
    return {
      fromCode: from,
      toCode: to,
      departAt,
      arrivalAt: roundToMinute(departAt.getTime()),
      totalMinutes: 0,
      totalKm: 0,
      path: [],
      confidence: "high",
      observedShare: 1,
      wagonTypeCode,
    };
  }

  const elapsed = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, Hop>();
  const settled = new Set<string>();

  const nextUnsettled = (): string | null => {
    let best: string | null = null;
    let bestCost = Infinity;
    for (const [node, cost] of elapsed) {
      if (!settled.has(node) && cost < bestCost) {
        best = node;
        bestCost = cost;
      }
    }
    return best;
  };

  for (;;) {
    const current = nextUnsettled();
    if (current === null) break;
    if (current === to) break;
    settled.add(current);

    const atNode = elapsed.get(current) as number;
    const band = hourBandOf(
      new Date(departAt.getTime() + atNode * MS_PER_MINUTE),
    );

    for (const edge of graph.get(current) ?? []) {
      if (settled.has(edge.to)) continue;
      const weight = resolveWeight(edge, band, weights);
      const cost = atNode + weight.minutes;
      if (cost < (elapsed.get(edge.to) ?? Infinity)) {
        elapsed.set(edge.to, cost);
        previous.set(edge.to, { edge, band, weight, elapsed: cost });
      }
    }
  }

  if (!elapsed.has(to)) throw new NoRouteError(from, to);

  const hops: Hop[] = [];
  let cursor = to;
  while (cursor !== from) {
    const hop = previous.get(cursor);
    // Unreachable in practice, but a missing predecessor here would be an
    // infinite loop in a request thread — checked rather than assumed.
    if (!hop) throw new NoRouteError(from, to);
    hops.unshift(hop);
    cursor = hop.edge.from;
  }

  const path: EtaLeg[] = hops.map((hop) => ({
    sectionId: hop.edge.id,
    fromCode: hop.edge.from,
    toCode: hop.edge.to,
    distanceKm: hop.edge.distanceKm,
    minutes: round1(hop.weight.minutes),
    source: hop.weight.source,
    samples: hop.weight.samples,
    band: hop.band,
    elapsedMinutes: round1(hop.elapsed),
  }));

  const rawTotal = hops.reduce((sum, hop) => sum + hop.weight.minutes, 0);
  const observed = hops.reduce(
    (sum, hop) => sum + observedWeightOf(hop.weight),
    0,
  );
  const share = rawTotal > 0 ? observed / rawTotal : 0;

  return {
    fromCode: from,
    toCode: to,
    departAt,
    arrivalAt: roundToMinute(departAt.getTime() + rawTotal * MS_PER_MINUTE),
    totalMinutes: round1(rawTotal),
    totalKm: round1(hops.reduce((sum, hop) => sum + hop.edge.distanceKm, 0)),
    path,
    confidence: labelFor(share),
    observedShare: Math.round(share * 1000) / 1000,
    wagonTypeCode,
  };
};

/** Re-exported so a caller building a hypothetical graph has one import. */
export type { NetworkGraph };

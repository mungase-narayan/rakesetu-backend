/**
 * The rail network as a graph, and Dijkstra over it.
 *
 * **Pure functions, no I/O** — DESIGN.md §5 requires the deterministic engines
 * to be unit-testable without a database, and this one has two consumers that
 * make that non-negotiable: Phase 5's ETA engine and Phase 7's `emptyHaulKm`.
 * Both need to run the same path-finding over hypothetical networks (a section
 * closed by an embargo, a speed restriction applied) that no fixture database
 * would contain.
 *
 * The loader lives in `distance.service.ts`. Nothing in this file imports `db`,
 * and nothing in it should.
 */

/** One directed section, reduced to what path-finding needs. */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  distanceKm: number;
  nominalSpeedKmph: number;
}

/** Adjacency list, keyed by station code. */
export type NetworkGraph = Map<string, GraphEdge[]>;

export interface PathResult {
  /** Station codes from origin to destination, inclusive of both. */
  stations: string[];
  /** The sections traversed, in order. */
  sections: GraphEdge[];
  totalKm: number;
  /**
   * Free-running time over the path at each section's nominal speed. It is a
   * floor, not an estimate: it contains no dwell, no crossing wait and no
   * congestion. Phase 5's ETA engine adds those from observed events; this is
   * what it falls back to on a section with no history.
   */
  totalMinutes: number;
}

/**
 * Builds the adjacency list. Edges are already directed — `sections` stores
 * both directions as separate rows — so this does not mirror anything, and a
 * one-way section is a one-way edge exactly as seeded.
 */
export const buildGraph = (edges: readonly GraphEdge[]): NetworkGraph => {
  const graph: NetworkGraph = new Map();
  for (const edge of edges) {
    const outgoing = graph.get(edge.from);
    if (outgoing) outgoing.push(edge);
    else graph.set(edge.from, [edge]);
    // Destinations with no outgoing section still have to exist as nodes, or a
    // path *into* a terminus would look unreachable.
    if (!graph.has(edge.to)) graph.set(edge.to, []);
  }
  return graph;
};

/**
 * Shortest path by **distance**, not by time.
 *
 * The choice matters and is deliberate: `operationalKm()` answers "how far does
 * the train actually run", which is a physical fact used for empty-haul cost
 * and for comparison against the tariff distance. A time-weighted path would
 * answer a different question — the fastest route — and would silently change
 * the reported kilometres whenever a speed restriction was edited.
 *
 * Phase 5 wants the fastest route and will pass its own weights; that is a
 * different call against the same graph, which is why the weight is not baked
 * into `GraphEdge`.
 *
 * Returns `null` when the destination is unreachable — not a throw. "No path
 * exists" is a legitimate answer about a network with disconnected divisions,
 * and the caller that needs it to be an error (a quotation) raises its own.
 */
export const shortestPath = (
  graph: NetworkGraph,
  fromCode: string,
  toCode: string,
): PathResult | null => {
  if (!graph.has(fromCode) || !graph.has(toCode)) return null;
  if (fromCode === toCode) {
    return { stations: [fromCode], sections: [], totalKm: 0, totalMinutes: 0 };
  }

  const distance = new Map<string, number>([[fromCode, 0]]);
  const previous = new Map<string, GraphEdge>();
  const settled = new Set<string>();

  // A linear scan for the minimum rather than a binary heap. The network is ~60
  // stations; a heap would be more code for a saving no profile would show, and
  // this stays obviously correct — which matters more in the function two
  // pricing engines depend on.
  const nextUnsettled = (): string | null => {
    let best: string | null = null;
    let bestCost = Infinity;
    for (const [node, cost] of distance) {
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
    if (current === toCode) break;
    settled.add(current);

    for (const edge of graph.get(current) ?? []) {
      if (settled.has(edge.to)) continue;
      const cost = (distance.get(current) ?? Infinity) + edge.distanceKm;
      if (cost < (distance.get(edge.to) ?? Infinity)) {
        distance.set(edge.to, cost);
        previous.set(edge.to, edge);
      }
    }
  }

  if (!distance.has(toCode)) return null;

  const sections: GraphEdge[] = [];
  let cursor = toCode;
  while (cursor !== fromCode) {
    const edge = previous.get(cursor);
    // Unreachable in practice — `distance` holding a node implies a predecessor
    // for every node but the origin — but a silent infinite loop here would be
    // a hang in a request thread, so it is checked rather than assumed.
    if (!edge) return null;
    sections.unshift(edge);
    cursor = edge.from;
  }

  const totalKm = sections.reduce((sum, edge) => sum + edge.distanceKm, 0);
  const totalMinutes = sections.reduce(
    (sum, edge) => sum + (edge.distanceKm / edge.nominalSpeedKmph) * 60,
    0,
  );

  return {
    stations: [fromCode, ...sections.map((edge) => edge.to)],
    sections,
    // Floating-point addition of two-decimal distances produces 281.39999…;
    // rounding here keeps the API from reporting a number nobody seeded.
    totalKm: Math.round(totalKm * 100) / 100,
    totalMinutes: Math.round(totalMinutes * 100) / 100,
  };
};

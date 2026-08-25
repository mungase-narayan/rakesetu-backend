/**
 * Dijkstra, against a fixture graph and **no database**.
 *
 * That is the point of the suite as much as the assertions are: DESIGN.md §5
 * requires the deterministic engines to be unit-testable without I/O, and Phase
 * 5's ETA engine and Phase 7's empty-haul cost both call this function over
 * hypothetical networks — a section closed by an embargo, a speed restriction
 * applied — that no seeded database would contain.
 */
import { describe, expect, it } from "vitest";

import { buildGraph, shortestPath, type GraphEdge } from "./graph";

/**
 * A → B → C → D along the top, and a long way round A → E → D.
 *
 *   A -10- B -10- C -10- D
 *   A -----------45----- E -10- D
 *
 * The top route is 30 km; the bottom is 55. The bottom route is *faster*
 * (100 km/h against 40), which is what makes this fixture worth having: it
 * proves the function minimises distance, not time.
 */
const edge = (
  from: string,
  to: string,
  distanceKm: number,
  nominalSpeedKmph = 40,
): GraphEdge[] => [
  { id: `${from}-${to}`, from, to, distanceKm, nominalSpeedKmph },
  { id: `${to}-${from}`, from: to, to: from, distanceKm, nominalSpeedKmph },
];

const FIXTURE: GraphEdge[] = [
  ...edge("A", "B", 10),
  ...edge("B", "C", 10),
  ...edge("C", "D", 10),
  ...edge("A", "E", 45, 100),
  ...edge("E", "D", 10, 100),
  // A component nothing else touches — "unreachable" has to be a real state.
  ...edge("X", "Y", 5),
];

describe("shortestPath", () => {
  const graph = buildGraph(FIXTURE);

  it("finds the shortest route by distance", () => {
    const result = shortestPath(graph, "A", "D");

    expect(result).not.toBeNull();
    expect(result?.totalKm).toBe(30);
    expect(result?.stations).toEqual(["A", "B", "C", "D"]);
    expect(result?.sections).toHaveLength(3);
  });

  it("minimises distance, not time", () => {
    // The A→E→D route is 55 km at 100 km/h — 33 minutes against the winner's
    // 45. A time-weighted implementation would return it, and `operationalKm`
    // would start reporting 55 for a train that runs 30.
    const result = shortestPath(graph, "A", "D");

    expect(result?.totalKm).toBe(30);
    expect(result?.totalMinutes).toBe(45);
  });

  it("is symmetric when both directions are present", () => {
    const forward = shortestPath(graph, "A", "D");
    const backward = shortestPath(graph, "D", "A");

    expect(backward?.totalKm).toBe(forward?.totalKm);
    expect(backward?.stations).toEqual(
      [...(forward?.stations ?? [])].reverse(),
    );
  });

  it("returns null for an unreachable pair rather than throwing", () => {
    // "No path exists" is a legitimate fact about a network with disconnected
    // divisions. The caller that needs it to be an error raises its own.
    expect(shortestPath(graph, "A", "X")).toBeNull();
  });

  it("returns null for a station that is not in the graph at all", () => {
    expect(shortestPath(graph, "A", "ZZZ")).toBeNull();
  });

  it("returns a zero-length path from a station to itself", () => {
    const result = shortestPath(graph, "A", "A");

    expect(result?.totalKm).toBe(0);
    expect(result?.sections).toHaveLength(0);
    expect(result?.stations).toEqual(["A"]);
  });

  it("honours a one-way section", () => {
    // Only P → Q exists. Q → P must be unreachable, which is the property that
    // makes storing both directions as separate rows meaningful.
    const oneWay = buildGraph([
      { id: "p-q", from: "P", to: "Q", distanceKm: 12, nominalSpeedKmph: 60 },
    ]);

    expect(shortestPath(oneWay, "P", "Q")?.totalKm).toBe(12);
    expect(shortestPath(oneWay, "Q", "P")).toBeNull();
  });
});

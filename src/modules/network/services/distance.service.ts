/**
 * The two distances, named so they cannot be confused (DESIGN.md §4.2, §5.7).
 *
 *   `tariffKm(from, to)`      — the official chargeable distance. Looked up.
 *                               **Throws when absent. Never computed.**
 *   `operationalKm(from, to)` — the kilometres the train actually runs.
 *                               Dijkstra over `sections`.
 *
 * They differ — KWV→PUNE is 268 tariff km against 281.4 operational — and the
 * reason they are two functions with two names, rather than one with a flag
 * defaulting to something, is that a quotation which silently falls back to the
 * Dijkstra figure is wrong in a way nobody notices until a customer disputes an
 * invoice. A 422 is noticed the same afternoon.
 *
 * The graph itself is loaded once and cached in Redis; the path-finding is a
 * pure function in `graph.ts` that this service feeds.
 */
import { and, asc, eq } from "drizzle-orm";

import ApiError from "../../../utils/api-error";
import logger from "../../../logger/winston.logger";
import { db, type DB } from "../../../database/connection";
import { cache, type CacheService } from "../../../database/redis";
import { chargeableDistances, sections } from "../../../schema";
import {
  buildGraph,
  shortestPath,
  type GraphEdge,
  type NetworkGraph,
  type PathResult,
} from "./graph";

/**
 * Versioned in the key. A change to what `GraphEdge` carries must not be served
 * a cached payload written by the previous shape — bumping the version is
 * cheaper and more obvious than a migration for a cache.
 */
export const NETWORK_GRAPH_CACHE_KEY = "network:graph:v1";
const GRAPH_CACHE_TTL_SECONDS = 60 * 60;

class DistanceService {
  constructor(
    private readonly database: DB = db,
    private readonly cacheService: CacheService = cache,
  ) {}

  /**
   * The official tariff distance. **Throws 422 when the pair is not on record.**
   *
   * This is the single most important line in the module: there is no fallback
   * path, no "approximately", and no route through `operationalKm`. If the
   * tariff table does not have the pair, the answer is that nobody knows what to
   * charge, and the caller must say so.
   */
  async tariffKm(fromCode: string, toCode: string): Promise<number> {
    const from = fromCode.toUpperCase();
    const to = toCode.toUpperCase();

    const [row] = await this.database
      .select({ km: chargeableDistances.km })
      .from(chargeableDistances)
      .where(
        and(
          eq(chargeableDistances.fromCode, from),
          eq(chargeableDistances.toCode, to),
        ),
      )
      .limit(1);

    if (!row) {
      throw new ApiError(
        422,
        `No chargeable distance on record for ${from}→${to}`,
      );
    }
    return row.km;
  }

  /** Kilometres actually run, by shortest path. Null when unreachable. */
  async operationalKm(
    fromCode: string,
    toCode: string,
  ): Promise<number | null> {
    const path = await this.shortestPath(fromCode, toCode);
    return path ? path.totalKm : null;
  }

  /** The full path — stations, sections, km and free-running minutes. */
  async shortestPath(
    fromCode: string,
    toCode: string,
  ): Promise<PathResult | null> {
    const graph = await this.loadGraph();
    return shortestPath(graph, fromCode.toUpperCase(), toCode.toUpperCase());
  }

  /**
   * The adjacency list, from Redis when warm and Postgres when not.
   *
   * A Redis outage degrades this to a query per call rather than an error — the
   * network is ~90 rows, so the fallback is slow-ish, not broken, and an ETA
   * that fails because a cache is down would be a worse trade.
   */
  async loadGraph(): Promise<NetworkGraph> {
    try {
      const cached = await this.cacheService.get<GraphEdge[]>(
        NETWORK_GRAPH_CACHE_KEY,
      );
      if (cached) return buildGraph(cached);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Network graph cache read failed: ${message}`);
    }

    const edges = await this.loadEdges();

    try {
      await this.cacheService.set(
        NETWORK_GRAPH_CACHE_KEY,
        edges,
        GRAPH_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Network graph cache write failed: ${message}`);
    }

    return buildGraph(edges);
  }

  private async loadEdges(): Promise<GraphEdge[]> {
    return this.database
      .select({
        id: sections.id,
        from: sections.fromCode,
        to: sections.toCode,
        distanceKm: sections.distanceKm,
        nominalSpeedKmph: sections.nominalSpeedKmph,
      })
      .from(sections)
      .orderBy(asc(sections.fromCode));
  }

  /**
   * Called by every write to `sections`. Deleting the key rather than rewriting
   * it means a concurrent reader repopulates from Postgres instead of racing
   * two writers to decide whose version of the graph wins.
   */
  async invalidateGraphCache(): Promise<void> {
    try {
      await this.cacheService.del(NETWORK_GRAPH_CACHE_KEY);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Loud, because the consequence is stale routing for up to an hour.
      logger.error(`Network graph cache invalidation failed: ${message}`);
    }
  }
}

export default DistanceService;

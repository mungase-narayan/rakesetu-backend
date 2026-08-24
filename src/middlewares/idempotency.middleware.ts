/**
 * Idempotency for event-creating POSTs (DESIGN.md §8).
 *
 * The failure this prevents is concrete: a siding supervisor's phone loses
 * signal mid-submit and retries. Without a key, the placement event lands
 * twice, the rake looks placed twice, and the detention hours — which are
 * money — are double-counted. With one, the retry replays the first response
 * and changes nothing.
 *
 * Three states, and the middle one is the one that is usually missed:
 *
 *  - **absent**  → claim the key and run the handler
 *  - **in_flight** → 409. The first request has not answered yet; a replay
 *    cannot be served because there is nothing to replay, and running the
 *    handler again is exactly the double-write being prevented.
 *  - **completed** → replay the stored status and body verbatim.
 *
 * Redis holds the record and `rake_events.idempotency_key` (Phase 4) holds the
 * durable one. Both exist on purpose: Redis is fast and forgets after a day;
 * the unique index is slow to consult but cannot be flushed.
 */
import { createHash } from "crypto";
import { NextFunction, Response } from "express";

import logger from "../logger/winston.logger";
import ApiError from "../utils/api-error";
import { CacheService, cache as defaultCache } from "../database/redis";
import { CustomRequest } from "../types/common.types";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** 24 h: long enough to cover a phone that reconnects the next morning. */
const DEFAULT_TTL_SECONDS = 86_400;

interface IdempotencyOptions {
  ttlSeconds?: number;
  cache?: CacheService;
}

type IdempotencyRecord =
  | { status: "in_flight" }
  | { status: "completed"; httpStatus: number; body: unknown };

/**
 * The key includes the tenant, the method and the path — not just the client's
 * value. Two tenants that both send `Idempotency-Key: 1` must not collide, and
 * the same key on a different route is a different operation, not a replay.
 */
const buildKey = (
  orgId: string,
  method: string,
  path: string,
  clientKey: string,
): string =>
  `idem:${createHash("sha256")
    .update(`${orgId}|${method}|${path}|${clientKey}`)
    .digest("hex")}`;

export const idempotent = (options: IdempotencyOptions = {}) => {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const cache = options.cache ?? defaultCache;

  return async (
    req: CustomRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const clientKey = req.header(IDEMPOTENCY_HEADER)?.trim();

      // 400, not "carry on unprotected". A route only mounts this middleware
      // because replaying it is unsafe; silently allowing the unkeyed request
      // would make the protection opt-in for the caller, which is backwards.
      if (!clientKey) {
        throw new ApiError(
          400,
          `${IDEMPOTENCY_HEADER} header is required for this request`,
        );
      }

      const orgId = req.tenant?.orgId ?? req.user?.orgId ?? "anonymous";
      const key = buildKey(orgId, req.method, req.path, clientKey);

      const claimed = await cache.setIfAbsent<IdempotencyRecord>(
        key,
        { status: "in_flight" },
        ttlSeconds,
      );

      if (!claimed) {
        const existing = await cache.get<IdempotencyRecord>(key);

        if (existing?.status === "completed") {
          res.setHeader("Idempotent-Replay", "true");
          res.status(existing.httpStatus).json(existing.body);
          return;
        }

        // in_flight, or the record expired between the SET NX and the GET.
        // Both mean "do not run this again right now".
        throw new ApiError(
          409,
          "A request with this Idempotency-Key is already in progress",
        );
      }

      // Capture the response as it is sent. `res.json` is wrapped rather than
      // hooking the 'finish' event because by the time 'finish' fires the body
      // has been written and is no longer available to store.
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        void (async () => {
          try {
            if (res.statusCode >= 400) {
              // A failure is not a result worth replaying — the caller should
              // be able to retry the same key and have it actually run.
              await cache.del(key);
              return;
            }
            await cache.set<IdempotencyRecord>(
              key,
              { status: "completed", httpStatus: res.statusCode, body },
              ttlSeconds,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.error(`Failed to store idempotency result: ${message}`);
          }
        })();
        return originalJson(body);
      };

      next();
    } catch (error) {
      next(error);
    }
  };
};

export default idempotent;

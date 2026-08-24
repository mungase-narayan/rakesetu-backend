/**
 * Rate limiting (DESIGN.md §8, Denial of Service).
 *
 * Two limiters with different jobs:
 *
 *  - **globalRateLimiter** — a coarse ceiling per IP so one client cannot
 *    saturate the API. Generous by design; it is a backstop, not a quota.
 *  - **loginRateLimiter** — narrow and strict, keyed by **IP + email**. The
 *    per-account lockout in the user controller already stops five guesses at
 *    one account, but it does nothing about the opposite attack: one common
 *    password sprayed across every account, where each account sees a single
 *    failure and nothing ever locks. Keying on the pair catches both shapes,
 *    and keeps one office behind a shared NAT from locking out its colleagues.
 *
 * Per-org solver limits are Phase 7 and the per-org AI budget is Phase 11 —
 * both are business quotas rather than abuse controls, and neither belongs here.
 *
 * The store is in-memory, which means the budget is per replica. With four
 * replicas the effective limit is four times the configured one. That is
 * acceptable for a backstop and wrong for anything precise; Phase 13's
 * observability work is where a shared Redis store belongs.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

import env from "../config/env.config";
import ApiError from "../utils/api-error";

/** Both limiters answer through the standard error envelope, not express's. */
const handler = () => {
  throw new ApiError(429, "Too many requests — please try again later");
};

/**
 * Both are factories rather than module-level constants so a test can mount one
 * with a limit of 10 without the whole suite running against a limit of 10.
 * The app builds its pair from env at startup; nothing else should need to.
 */
export const createGlobalRateLimiter = (
  limit: number = env.rateLimit.max,
  windowMs: number = env.rateLimit.windowMs,
) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler,
    // Liveness and readiness are polled by orchestrators on a fixed schedule
    // and must never be throttled — a 429 there reads as an unhealthy instance
    // and gets the replica restarted for being popular.
    skip: (req: Request) =>
      req.path === "/healthz" ||
      req.path === "/readyz" ||
      req.path === "/health",
  });

export const createLoginRateLimiter = (
  limit: number = env.rateLimit.loginMax,
  windowMs: number = env.rateLimit.windowMs,
) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler,
    keyGenerator: (req: Request) => {
      // ipKeyGenerator, not req.ip: it normalises IPv6 to a /64 prefix, without
      // which a single host can present a practically unlimited set of
      // addresses and never spend more than one request from any bucket.
      const ip = ipKeyGenerator(req.ip ?? "");
      const email =
        typeof req.body?.email === "string"
          ? req.body.email.trim().toLowerCase()
          : "";
      return `${ip}:${email}`;
    },
  });

export const globalRateLimiter = createGlobalRateLimiter();
export const loginRateLimiter = createLoginRateLimiter();

export default globalRateLimiter;

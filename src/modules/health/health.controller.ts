/**
 * Liveness and readiness (DESIGN.md §10).
 *
 * The distinction is the whole point, and conflating them is a real outage
 * mode:
 *
 *  - **`/healthz`** — is this process alive? No dependency checks, always 200
 *    if the event loop is turning. An orchestrator restarts a container that
 *    fails liveness, so wiring a database check in here means a brief Postgres
 *    blip restarts every replica simultaneously and turns a degradation into an
 *    outage.
 *  - **`/readyz`** — should traffic be routed here? Checks every dependency and
 *    answers 503 with a per-dependency breakdown, so the load balancer takes
 *    the instance out and a human reads *which* thing is down.
 *
 * `/metrics` is Phase 13.
 */
import { Request, Response } from "express";
import { sql } from "drizzle-orm";

import { db } from "../../database/connection";
import { redis } from "../../database/redis";
import RabbitMQService from "../../utils/rabbitmq";

export type DependencyState =
  | "connected"
  | "disconnected"
  /** Configured off on purpose. Not a fault, and not a reason to fail readiness. */
  | "disabled";

interface Dependency {
  status: DependencyState;
  /** Present only when something went wrong; kept short and non-secret. */
  detail?: string;
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  instance: string;
  uptime: number;
  dependencies: Record<string, Dependency>;
}

const checkDatabase = async (): Promise<Dependency> => {
  try {
    await db.execute(sql`select 1`);
    return { status: "connected" };
  } catch (error) {
    return {
      status: "disconnected",
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }
};

const checkRedis = async (): Promise<Dependency> => {
  try {
    // The status is checked first because ioredis runs with enableOfflineQueue
    // false — a PING while the socket is down rejects anyway, but reading the
    // status gives the clearer answer without waiting on a timeout.
    if (redis.status !== "ready") {
      return { status: "disconnected", detail: `socket is ${redis.status}` };
    }
    await redis.ping();
    return { status: "connected" };
  } catch (error) {
    return {
      status: "disconnected",
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }
};

const checkQueue = (rabbitmq: RabbitMQService): Dependency => {
  if (!rabbitmq.isEnabled()) return { status: "disabled" };
  return rabbitmq.isReady()
    ? { status: "connected" }
    : { status: "disconnected", detail: "no open channel" };
};

class HealthController {
  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly instanceId: string,
  ) {}

  /** Liveness. Deliberately trivial. */
  live = (_req: Request, res: Response) => {
    return res.status(200).json({
      status: "OK",
      instance: this.instanceId,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
    });
  };

  /** Readiness. 503 the moment any *required* dependency is not connected. */
  ready = async (_req: Request, res: Response) => {
    const [database, cache] = await Promise.all([
      checkDatabase(),
      checkRedis(),
    ]);
    const queue = checkQueue(this.rabbitmq);

    const dependencies = { database, redis: cache, queue };

    // "disabled" is a configuration, not a failure — a serverless deployment
    // with USE_RABBITMQ_SERVICE=false is ready, it just runs AI jobs inline.
    const isReady = Object.values(dependencies).every(
      (dependency) => dependency.status !== "disconnected",
    );

    const report: ReadinessReport = {
      status: isReady ? "ready" : "not_ready",
      instance: this.instanceId,
      uptime: Math.round(process.uptime()),
      dependencies,
    };

    return res.status(isReady ? 200 : 503).json(report);
  };

  /**
   * The original `/health`, kept verbatim in shape so anything already polling
   * it — the compose healthcheck, a bookmark, a monitor — does not break.
   */
  legacy = (_req: Request, res: Response) => {
    return res.status(200).json({
      status: "OK",
      message: "Backend server is running.",
      instance: this.instanceId,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      queue: checkQueue(this.rabbitmq).status,
    });
  };
}

export default HealthController;

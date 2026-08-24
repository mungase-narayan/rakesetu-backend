/**
 * Redis connection and a small typed wrapper over it.
 *
 * Same lifecycle shape as database/connection.ts — a module-level client plus
 * connect/disconnect helpers called from App.start()/shutdown() — with one
 * deliberate difference: a failed connect does **not** `process.exit(1)`.
 *
 * Postgres is load-bearing; without it no request can be answered, so dying at
 * boot is honest. Redis backs idempotency replay, solver locks and (from Phase
 * 5) the ETA cache — an API without it is degraded, not broken, and it has to
 * stay up long enough for `/readyz` to say *which* dependency is missing. A
 * process that exits instead just restart-loops with the reason in a log nobody
 * is tailing.
 */
import Redis, { type RedisOptions } from "ioredis";

import env from "../config/env.config";
import logger from "../logger/winston.logger";

/** Thrown by withLock when someone else already holds the key. */
export class LockUnavailableError extends Error {
  constructor(public readonly key: string) {
    super(`Lock is already held: ${key}`);
    this.name = "LockUnavailableError";
  }
}

const options: RedisOptions = {
  // Connect on demand rather than at import. Importing this module must not be
  // what opens a socket — tests, scripts and drizzle-kit all import the app.
  lazyConnect: true,
  // Fail a command rather than queueing it forever while Redis is down: an
  // idempotency check that hangs is worse than one that errors and is handled.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 2,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
};

export const redis = new Redis(env.redis.url, options);

redis.on("error", (error: Error) => {
  // ioredis emits 'error' on every reconnect attempt. Logging at warn keeps a
  // dead Redis from burying real errors, and /readyz carries the real signal.
  logger.warn(`Redis error: ${error.message}`);
});
redis.on("ready", () => logger.info("Redis connected successfully"));

/** True when the socket is up and commands will be attempted. */
export const isRedisReady = (): boolean => redis.status === "ready";

export const connectRedis = async (): Promise<void> => {
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      `Redis connection failed: ${message} — continuing without it; /readyz will report it`,
    );
  }
};

/** Idempotent for the same reason disconnectDatabase is. */
export const disconnectRedis = async (): Promise<void> => {
  if (redis.status === "end") return;
  try {
    await redis.quit();
    logger.info("Redis disconnected");
  } catch {
    // quit() rejects if the socket was never opened. Nothing to close, so the
    // only correct handling is to drop it and say nothing.
    redis.disconnect();
  }
};

/**
 * Releases a lock only if we still hold it.
 *
 * The naive `DEL key` is a race: if our work outran the lock TTL, the key we
 * delete belongs to whoever acquired it next, and two holders run at once —
 * precisely the thing the lock existed to prevent. Compare-and-delete in Lua is
 * atomic, so an expired holder releases nothing.
 */
const RELEASE_IF_MINE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export class CacheService {
  constructor(
    private readonly client: Redis = redis,
    private readonly prefix: string = env.redis.keyPrefix,
  ) {}

  /** Namespaces a key. Every method goes through it; callers pass bare names. */
  key(name: string): string {
    return `${this.prefix}:${name}`;
  }

  async get<T>(name: string): Promise<T | null> {
    const raw = await this.client.get(this.key(name));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A value written by something that did not serialise as JSON. Treat it
      // as a miss rather than throwing into whatever asked for it.
      logger.warn(`Cache value for "${name}" is not JSON — treating as a miss`);
      return null;
    }
  }

  async set<T>(name: string, value: T, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds === undefined) {
      await this.client.set(this.key(name), payload);
      return;
    }
    await this.client.set(this.key(name), payload, "EX", ttlSeconds);
  }

  /**
   * Sets only when the key is absent. Returns whether this caller won — the
   * primitive the idempotency middleware is built on.
   */
  async setIfAbsent<T>(
    name: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.client.set(
      this.key(name),
      JSON.stringify(value),
      "EX",
      ttlSeconds,
      "NX",
    );
    return result === "OK";
  }

  async del(name: string): Promise<void> {
    await this.client.del(this.key(name));
  }

  /**
   * Runs `fn` while holding an exclusive lock on `name`.
   *
   * Throws LockUnavailableError immediately if the lock is held — it does not
   * queue or retry. A solver run that is already in flight should tell the
   * caller so, not silently run twice or block a request thread for a minute.
   *
   * `ttlSeconds` is the ceiling on how long a crashed holder can block others,
   * so it should exceed the expected work by a margin, not hug it.
   */
  async withLock<T>(
    name: string,
    ttlSeconds: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `lock:${name}`;
    // A token unique to this holder, so release can prove ownership.
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const acquired = await this.setIfAbsent(lockKey, token, ttlSeconds);
    if (!acquired) throw new LockUnavailableError(name);

    try {
      return await fn();
    } finally {
      await this.client.eval(
        RELEASE_IF_MINE,
        1,
        this.key(lockKey),
        JSON.stringify(token),
      );
    }
  }
}

/** The instance the app uses. Tests construct their own against a test client. */
export const cache = new CacheService();

export default redis;

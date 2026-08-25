/**
 * The live half of the read side (DESIGN.md §3): one push stream per tenant,
 * carrying state changes off the event spine to whatever is watching.
 *
 * ---
 *
 * **Three rules, and every one of them is a correctness rule rather than a
 * transport preference.**
 *
 * 1. **Nothing is published from inside a transaction.** `applyEvent` calls
 *    `notify()` after its transaction has committed, never before. A frame
 *    emitted inside a transaction that then rolls back is a map showing a
 *    placement that never happened — and because the client patches its cache
 *    in place rather than refetching, that ghost survives until the next full
 *    poll. §9 makes the rollback case its own test.
 *
 * 2. **The tenant comes from the session.** `EventSource` cannot set headers, so
 *    the token rides in the query string — and that is the *only* thing the
 *    query string is trusted for. The org is read off the authenticated user
 *    exactly as `withTenant` reads it everywhere else, so a forged `orgId`
 *    parameter is not rejected so much as never consulted.
 *
 * 3. **A dropped connection does not silently desync.** Every frame carries the
 *    event id as its SSE `id:`; a reconnecting client sends `Last-Event-ID` and
 *    the gap is replayed from `rake_events`. When the id is unknown — the
 *    client was away longer than the replay window, or the event was
 *    quarantined — a `resync` frame tells it to refetch `/network/live` rather
 *    than continue from a history it cannot reconstruct.
 *
 * ---
 *
 * **Why there is a tailer as well as an emitter.**
 *
 * The emitter is per-process, and the simulator is a *different* process: it
 * holds its own `ProjectorService` and writes straight to Postgres, so its
 * `notify()` calls land in an emitter nobody is listening to. An in-process
 * emitter alone would therefore satisfy the design and fail the demo — the map
 * would sit still through exactly the run it exists to show.
 *
 * So while at least one client is connected, the API process tails
 * `rake_events` by `recorded_at` and feeds anything it has not already
 * published into the same emitter. It is a poll, but it is **one poll per
 * instance** rather than one per open browser tab, it is the only thing that
 * makes an out-of-process producer visible, and it is the same mechanism
 * `rakesetu-ai-ml` will need in Phase 11. Redis pub/sub replaces both halves
 * when there is more than one instance — see **DECISIONS D9**.
 */
import { EventEmitter } from "events";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Logger } from "winston";

import logger from "../../../logger/winston.logger";
import { db, type DB } from "../../../database/connection";
import {
  rakeEvents,
  rakeStates,
  rakes,
  stations,
  type RakeEventType,
  type RakeState,
} from "../../../schema";
import { STATE_GROUP } from "../constants/event-type.constants";

/** Proxies close an idle stream; twenty seconds is comfortably inside every default. */
export const HEARTBEAT_MS = 20_000;

/** How often the process looks for events written by somebody else. */
export const TAIL_INTERVAL_MS = 1_000;

/**
 * How long ids are remembered so the tailer does not re-publish what the
 * in-process projector already sent. Generous: a simulator at `--speed 500`
 * writes a few hundred events a second and the set is only strings.
 */
const SEEN_CAPACITY = 5_000;

/** Per-user and per-instance stream caps (§4). Over the cap, the client polls. */
export const MAX_STREAMS_PER_USER = 5;
export const MAX_STREAMS_PER_INSTANCE = 200;

/** The most events a reconnect will replay before telling the client to resync. */
const MAX_REPLAY = 500;

/** Frames are batched for this long so a bulk apply is a few writes, not a thousand. */
const FLUSH_MS = 120;

export type StreamFrameName = "rake.state" | "rake.event" | "resync";

export interface RakeStateFrame {
  rakeId: string;
  code: string;
  state: RakeState;
  previousState: RakeState | null;
  stateGroup: "empty" | "moving" | "at_terminal" | "exception";
  stationCode: string | null;
  stationName: string | null;
  lat: number | null;
  lng: number | null;
  terminalId: string | null;
  since: string;
  isDirty: boolean;
}

export interface RakeEventFrame {
  eventId: string;
  rakeId: string;
  code: string;
  eventType: RakeEventType;
  occurredAt: string;
  recordedAt: string;
  stationCode: string | null;
  terminalId: string | null;
  applied: boolean;
}

export interface StreamFrame {
  /** The SSE `id:` — an event id, which is what `Last-Event-ID` replays from. */
  id: string;
  name: StreamFrameName;
  data: RakeStateFrame | RakeEventFrame | { reason: string };
}

export class StreamCapacityError extends Error {
  constructor(public readonly scope: "user" | "instance") {
    super(
      scope === "user"
        ? `A user may hold at most ${MAX_STREAMS_PER_USER} live streams`
        : `This instance is carrying its maximum of ${MAX_STREAMS_PER_INSTANCE} live streams`,
    );
    this.name = "StreamCapacityError";
  }
}

type Listener = (frame: StreamFrame) => void;

class EventStreamService {
  /** One emitter per tenant. A listener can only ever be attached to its own. */
  private readonly emitters = new Map<string, EventEmitter>();
  /** Event ids waiting to be turned into frames, per tenant. */
  private readonly pending = new Map<string, Set<string>>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();

  /** Ids already published, so the tailer does not duplicate the projector. */
  private readonly seen = new Set<string>();

  private readonly streamsPerUser = new Map<string, number>();
  private streamCount = 0;

  private tailTimer: NodeJS.Timeout | null = null;
  private tailFrom: Date | null = null;

  constructor(
    private readonly database: DB = db,
    private readonly log: Logger = logger,
  ) {}

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * "This event landed." Cheap, synchronous, and **called only after commit.**
   *
   * It does not build the frame — the caller is inside a request and should not
   * pay for a join it does not need. Ids are batched and materialised together,
   * so a two-hundred-event bulk apply is one query rather than two hundred.
   */
  notify(orgId: string, eventId: string): void {
    if (!this.emitters.get(orgId)?.listenerCount("frame")) return;

    const queue = this.pending.get(orgId);
    if (queue) {
      queue.add(eventId);
      return;
    }

    this.pending.set(orgId, new Set([eventId]));
    this.flushTimers.set(
      orgId,
      setTimeout(() => {
        void this.flush(orgId);
      }, FLUSH_MS),
    );
  }

  /** Turns queued ids into frames and emits them to that tenant's listeners. */
  private async flush(orgId: string): Promise<void> {
    const queue = this.pending.get(orgId);
    this.pending.delete(orgId);
    const timer = this.flushTimers.get(orgId);
    if (timer) clearTimeout(timer);
    this.flushTimers.delete(orgId);

    if (!queue || queue.size === 0) return;

    const fresh = [...queue].filter((id) => !this.seen.has(id));
    if (fresh.length === 0) return;

    try {
      const frames = await this.buildFrames(orgId, fresh);
      for (const id of fresh) this.remember(id);
      this.emit(orgId, frames);
    } catch (error) {
      // A stream that cannot be built is a degraded live view, never a failed
      // request — the write it describes has already committed.
      this.log.warn(`SSE frame build failed: ${message(error)}`);
    }
  }

  private emit(orgId: string, frames: readonly StreamFrame[]): void {
    const emitter = this.emitters.get(orgId);
    if (!emitter) return;
    for (const frame of frames) emitter.emit("frame", frame);
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_CAPACITY) {
      // Insertion-ordered, so the oldest quarter goes first. A bounded set
      // rather than an unbounded one: this process runs for weeks.
      const drop = Math.floor(SEEN_CAPACITY / 4);
      let removed = 0;
      for (const value of this.seen) {
        this.seen.delete(value);
        if (++removed >= drop) break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Subscribing
  // -------------------------------------------------------------------------

  /**
   * Attaches a listener to a tenant's emitter. Returns the unsubscribe.
   *
   * Throws `StreamCapacityError` over either cap. The client's answer to that
   * is to fall back to polling, which is why the caps are a refusal the client
   * can act on rather than a silently dropped connection.
   */
  subscribe(orgId: string, userId: string, listener: Listener): () => void {
    if (this.streamCount >= MAX_STREAMS_PER_INSTANCE) {
      throw new StreamCapacityError("instance");
    }
    if ((this.streamsPerUser.get(userId) ?? 0) >= MAX_STREAMS_PER_USER) {
      throw new StreamCapacityError("user");
    }

    let emitter = this.emitters.get(orgId);
    if (!emitter) {
      emitter = new EventEmitter();
      // The cap is per instance, not per emitter; Node's default of 10 would
      // print a leak warning at the eleventh browser tab.
      emitter.setMaxListeners(MAX_STREAMS_PER_INSTANCE);
      this.emitters.set(orgId, emitter);
    }

    emitter.on("frame", listener);
    this.streamCount += 1;
    this.streamsPerUser.set(userId, (this.streamsPerUser.get(userId) ?? 0) + 1);
    this.startTail();

    let released = false;
    return () => {
      if (released) return;
      released = true;

      emitter.off("frame", listener);
      this.streamCount -= 1;
      const perUser = (this.streamsPerUser.get(userId) ?? 1) - 1;
      if (perUser <= 0) this.streamsPerUser.delete(userId);
      else this.streamsPerUser.set(userId, perUser);

      if (emitter.listenerCount("frame") === 0) this.emitters.delete(orgId);
      if (this.streamCount === 0) this.stopTail();
    };
  }

  stats() {
    return {
      streams: this.streamCount,
      tenants: this.emitters.size,
      tailing: this.tailTimer !== null,
      maxPerUser: MAX_STREAMS_PER_USER,
      maxPerInstance: MAX_STREAMS_PER_INSTANCE,
    };
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  /**
   * The frames a client missed, given the last id it saw.
   *
   * Ordered by `recorded_at` — **arrival order, not occurrence order**. The
   * stream is a record of what the server learnt and when; replaying by
   * `occurred_at` would silently omit every late event, which is the one class
   * of event a reconnecting client most needs to be told about.
   *
   * Returns `null` when the id is unknown, which the caller turns into a
   * `resync` frame.
   */
  async replaySince(
    orgId: string,
    lastEventId: string,
  ): Promise<StreamFrame[] | null> {
    const [anchor] = await this.database
      .select({ id: rakeEvents.id })
      .from(rakeEvents)
      .where(and(eq(rakeEvents.orgId, orgId), eq(rakeEvents.id, lastEventId)))
      .limit(1);

    if (!anchor) return null;

    /**
     * The cursor comparison happens **entirely in SQL**, and that is not a
     * micro-optimisation.
     *
     * `recorded_at` is `timestamptz`, which Postgres stores to the microsecond;
     * a JavaScript `Date` holds milliseconds. Reading the anchor into the
     * process and sending it back as a bind parameter therefore truncates it —
     * and a truncated lower bound is *earlier* than the row it came from, so
     * `recorded_at > anchor` matches the anchor itself and the client is
     * handed back the very event it told us it already had.
     *
     * The row comparison `(recorded_at, id) > (…)` keeps full precision and
     * breaks ties on `id`, so two events recorded in the same microsecond
     * replay in a stable order instead of one of them going missing.
     */
    const missed = await this.database.execute<{ id: string }>(sql`
      select e.id
      from rake_events e
      where e.org_id = ${orgId}
        and (e.recorded_at, e.id) > (
          select a.recorded_at, a.id
          from rake_events a
          where a.org_id = ${orgId} and a.id = ${lastEventId}
          limit 1
        )
      order by e.recorded_at, e.id
      limit ${MAX_REPLAY + 1}
    `);

    // More than the window: the client has been away too long for a replay to
    // be cheaper than a refetch, and a truncated replay would leave it wrong
    // while looking correct.
    if (missed.rows.length > MAX_REPLAY) return null;
    if (missed.rows.length === 0) return [];

    return this.buildFrames(
      orgId,
      missed.rows.map((row) => row.id),
    );
  }

  // -------------------------------------------------------------------------
  // The tailer
  // -------------------------------------------------------------------------

  private startTail(): void {
    if (this.tailTimer) return;
    this.tailFrom = new Date();
    this.tailTimer = setInterval(() => {
      void this.tail();
    }, TAIL_INTERVAL_MS);
    // Must not hold the process open on its own — a shutdown should not wait
    // for a poll that exists only while somebody is watching.
    this.tailTimer.unref?.();
  }

  private stopTail(): void {
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.tailTimer = null;
    this.tailFrom = null;
  }

  private async tail(): Promise<void> {
    const since = this.tailFrom;
    if (!since || this.streamCount === 0) return;

    try {
      const rows = await this.database
        .select({
          id: rakeEvents.id,
          orgId: rakeEvents.orgId,
          recordedAt: rakeEvents.recordedAt,
        })
        .from(rakeEvents)
        .where(gt(rakeEvents.recordedAt, since))
        .orderBy(asc(rakeEvents.recordedAt))
        .limit(MAX_REPLAY);

      if (rows.length === 0) return;

      /**
       * Millisecond truncation makes this bound very slightly *earlier* than
       * the row it came from, so the next poll can re-read the last row or two.
       * That is the safe direction — it duplicates rather than skips — and the
       * `seen` set drops the repeats before they reach a subscriber.
       */
      this.tailFrom = rows[rows.length - 1].recordedAt;

      const byOrg = new Map<string, string[]>();
      for (const row of rows) {
        if (this.seen.has(row.id)) continue;
        if (!this.emitters.get(row.orgId)?.listenerCount("frame")) continue;
        const bucket = byOrg.get(row.orgId);
        if (bucket) bucket.push(row.id);
        else byOrg.set(row.orgId, [row.id]);
      }

      for (const [orgId, ids] of byOrg) {
        const frames = await this.buildFrames(orgId, ids);
        for (const id of ids) this.remember(id);
        this.emit(orgId, frames);
      }
    } catch (error) {
      this.log.warn(`SSE tail failed: ${message(error)}`);
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Builds the `rake.event` and `rake.state` frames for a set of event ids.
   *
   * One query with the joins the map needs, **scoped by `org_id`**, so a
   * caller that somehow passed another tenant's id gets nothing rather than a
   * frame. The state frame reflects the projection *now* rather than at the
   * moment of the event, which is right: it is a live position, and two events
   * for one rake in the same batch should not produce two contradicting
   * positions on the map.
   */
  private async buildFrames(
    orgId: string,
    eventIds: readonly string[],
  ): Promise<StreamFrame[]> {
    if (eventIds.length === 0) return [];

    const rows = await this.database
      .select({
        eventId: rakeEvents.id,
        rakeId: rakeEvents.rakeId,
        eventType: rakeEvents.eventType,
        occurredAt: rakeEvents.occurredAt,
        recordedAt: rakeEvents.recordedAt,
        eventStationCode: rakeEvents.stationCode,
        eventTerminalId: rakeEvents.terminalId,
        applied: rakeEvents.applied,
        code: rakes.code,
        state: sql<RakeState>`coalesce(${rakeStates.state}, ${rakes.currentState})`,
        previousState: rakeStates.previousState,
        stationCode: sql<
          string | null
        >`coalesce(${rakeStates.stationCode}, ${rakes.currentStation})`,
        since: sql<Date>`coalesce(${rakeStates.since}, ${rakes.stateSince})`,
        terminalId: rakeStates.terminalId,
        isDirty: sql<boolean>`coalesce(${rakeStates.isDirty}, false)`,
        stationName: stations.name,
        lat: stations.lat,
        lng: stations.lng,
      })
      .from(rakeEvents)
      .innerJoin(rakes, eq(rakes.id, rakeEvents.rakeId))
      .leftJoin(rakeStates, eq(rakeStates.rakeId, rakeEvents.rakeId))
      .leftJoin(
        stations,
        eq(
          stations.code,
          sql`coalesce(${rakeStates.stationCode}, ${rakes.currentStation})`,
        ),
      )
      .where(
        and(eq(rakeEvents.orgId, orgId), inArray(rakeEvents.id, [...eventIds])),
      )
      .orderBy(asc(rakeEvents.recordedAt));

    const frames: StreamFrame[] = [];

    for (const row of rows) {
      frames.push({
        id: row.eventId,
        name: "rake.event",
        data: {
          eventId: row.eventId,
          rakeId: row.rakeId,
          code: row.code,
          eventType: row.eventType,
          occurredAt: row.occurredAt.toISOString(),
          recordedAt: row.recordedAt.toISOString(),
          stationCode: row.eventStationCode,
          terminalId: row.eventTerminalId,
          applied: row.applied,
        } satisfies RakeEventFrame,
      });

      // A refused attempt moves nothing, so it gets no state frame. It is still
      // streamed as an event: the anomaly queue is live too.
      if (!row.applied) continue;

      frames.push({
        id: row.eventId,
        name: "rake.state",
        data: {
          rakeId: row.rakeId,
          code: row.code,
          state: row.state,
          previousState: row.previousState,
          stateGroup: STATE_GROUP[row.state],
          stationCode: row.stationCode,
          stationName: row.stationName,
          lat: row.lat,
          lng: row.lng,
          terminalId: row.terminalId,
          since: new Date(row.since).toISOString(),
          isDirty: row.isDirty,
        } satisfies RakeStateFrame,
      });
    }

    return frames;
  }
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * One instance per process.
 *
 * A singleton because the emitter *is* the process-local bus: a second instance
 * would be a second bus, and the projector would publish into whichever one it
 * happened to be constructed with. Injected in tests by constructing directly.
 */
export const eventStream = new EventStreamService();

export default EventStreamService;

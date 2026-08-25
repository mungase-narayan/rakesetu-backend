/**
 * The I/O shell around the pure state machine.
 *
 * Everything that touches Postgres, the clock or the audit trail lives here;
 * everything that decides what an event *means* lives in
 * `state-machine.service.ts`. The split is not decoration — §13.2's spine check
 * ("re-running the projection produces byte-identical state") is only a
 * meaningful claim if the deciding half has no ambient input, and this file is
 * where all the ambient input is quarantined.
 *
 * ---
 *
 * **Tenant scoping.** The rake is resolved through `ScopedRepository` *before*
 * any write, and every row written afterwards takes its `org_id` from that
 * resolved rake — never from the request. A caller who names another tenant's
 * rake gets a 404, so no write inside the transaction is reachable with a
 * foreign `org_id`. Drizzle's transaction handle is not a `DB`, so the writes
 * themselves are plain drizzle with an explicit `org_id` predicate; the
 * authorisation has already happened by then.
 *
 * **`cycle_id` is projector bookkeeping, not history.** The append-only rule
 * governs what an event *asserts* — its type, its time, its payload — and none
 * of that is ever updated. Which turnaround an event belongs to is this
 * module's own filing decision, and a late `EMPTY_AVAILABLE` genuinely does
 * re-file the events around it. Re-projection therefore rewrites `cycle_id`,
 * and only `cycle_id`.
 */
import { randomUUID } from "crypto";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Logger } from "winston";

import ApiError from "../../../utils/api-error";
import { db, type DB } from "../../../database/connection";
import { ScopedRepository } from "../../../database/scoped-repository";
import {
  rakeCycles,
  rakeEventKeys,
  rakeEvents,
  rakeStates,
  rakes,
  type NewRakeCycle,
  type Rake,
  type RakeCycle,
  type RakeEvent,
  type RakeStateRow,
} from "../../../schema";
import AuditService from "../../audit/services/audit.service";
import EventStreamService, { eventStream } from "./event-stream.service";
import {
  CLEARS_TERMINAL,
  CYCLE_OPENING_EVENT,
} from "../constants/event-type.constants";
import { legalEventsFrom } from "../constants/transitions.constants";
import {
  initialProjection,
  isLegalTransition,
  nextState,
  project,
  type CycleSummary,
  type FoldableEvent,
  type Projection,
} from "./state-machine.service";
import type {
  ApplyEventInput,
  ApplyResult,
  ReprojectResult,
} from "../types/rake-event.types";

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/**
 * Walks the cause chain, because drizzle wraps.
 *
 * A duplicate `idempotency_key` surfaces as a `DrizzleQueryError` whose
 * `cause` is the pg error carrying the SQLSTATE — so a check on the top-level
 * `code` alone silently never matches, and the retry a supervisor's phone
 * makes comes back as a 500 instead of the 409 that tells the client its
 * submission already landed. The loop is bounded because the chain is.
 */
const isUniqueViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      (current as { code?: string }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/** The event row, reduced to what the pure fold needs. */
const foldable = (row: RakeEvent): FoldableEvent => ({
  id: row.id,
  eventType: row.eventType,
  occurredAt: row.occurredAt,
  stationCode: row.stationCode,
  terminalId: row.terminalId,
  cycleId: row.cycleId,
  payload: row.payload as Record<string, unknown>,
});

class ProjectorService {
  constructor(
    private readonly logger: Logger,
    private readonly auditService: AuditService,
    private readonly database: DB = db,
    /**
     * The live feed (Phase 5). Defaulted to the process singleton so every
     * existing call site keeps working, and injectable so a test can assert
     * what was published — including that a rolled-back transaction published
     * **nothing**.
     */
    private readonly stream: EventStreamService = eventStream,
  ) {}

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  /**
   * Append one event and advance the projection, in a single transaction.
   *
   * Six things happen and all six either land together or none does: the
   * idempotency key is claimed, the event is inserted, the projection is
   * updated, the mirror on `rakes` is refreshed, the cycle row is opened or
   * advanced, and — outside the transaction, because it must never fail the
   * request — the audit row is written.
   *
   * The one write that is deliberately *not* in the transaction is the anomaly.
   * An illegal transition has to be both refused and preserved, and a rollback
   * would give up the second half.
   */
  async applyEvent(
    orgId: string,
    input: ApplyEventInput,
  ): Promise<ApplyResult> {
    const rake = await this.requireRake(orgId, input.rakeId);
    const current = await this.ensureProjectionRow(orgId, rake);

    const wasLate =
      current.lastEventAt !== null &&
      input.occurredAt.getTime() < current.lastEventAt.getTime();

    /**
     * A late event is **not** judged against the current state.
     *
     * It did not happen from here — it happened before whatever produced this
     * state, and asking "is DEPARTED_ORIGIN legal from AT_DEST_YARD" about an
     * event that occurred two hours earlier answers the wrong question. Every
     * late event would be refused as illegal, which is precisely the bug an
     * event-sourced spine exists to avoid. It is inserted, the cycle is
     * re-folded, and the fold — which sees the events in the order they
     * happened — decides. If the fold rejects it, it is flipped to
     * `applied = false` below and the caller still gets a 409.
     */
    if (!wasLate && !isLegalTransition(current.state, input.eventType)) {
      await this.recordAnomaly(orgId, rake, current.state, input);
      throw new ApiError(
        409,
        `${input.eventType} is not a legal event for rake ${rake.code}, which is ${current.state}`,
        [
          {
            from: current.state,
            event: input.eventType,
            legal: legalEventsFrom(current.state),
            // Named so the caller knows the attempt was kept, not discarded.
            recordedAs: "anomaly",
          },
        ],
      );
    }

    const cycle = await this.resolveCycle(orgId, rake, current, input, wasLate);

    const eventId = randomUUID();
    const inserted = await this.database
      .transaction(async (tx) => {
        // Claimed first. If this row cannot be written the event must not be
        // either — which is exactly what a retry of a submitted placement is.
        await tx.insert(rakeEventKeys).values({
          idempotencyKey: input.idempotencyKey,
          orgId,
          eventId,
          occurredAt: input.occurredAt,
        });

        const [row] = await tx
          .insert(rakeEvents)
          .values({
            id: eventId,
            orgId,
            rakeId: rake.id,
            cycleId: cycle.id,
            eventType: input.eventType,
            occurredAt: input.occurredAt,
            stationCode: input.stationCode ?? null,
            terminalId: input.terminalId ?? null,
            payload: input.payload ?? {},
            source: input.source,
            sourceRef: input.sourceRef ?? null,
            recordedBy: input.recordedBy ?? null,
            idempotencyKey: input.idempotencyKey,
            applied: true,
            correctsEventId: input.correctsEventId ?? null,
            correlationId: input.correlationId ?? null,
          })
          .returning();

        if (wasLate) {
          // The projection is now a fold over an unsorted list. Flag it here
          // and re-fold below — the flag survives even if the process dies in
          // between, which is the point of writing it inside the transaction.
          await tx
            .update(rakeStates)
            .set({ isDirty: true, updatedAt: new Date() })
            .where(eq(rakeStates.rakeId, rake.id));
        } else {
          await this.advance(tx, orgId, rake, current, row, cycle);
        }

        return row;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ApiError(
            409,
            `An event with idempotency key "${input.idempotencyKey}" already exists`,
          );
        }
        throw error;
      });

    if (wasLate) {
      const rebuild = await this.reprojectRake(orgId, rake.id, {
        quarantine: false,
      });

      if (rebuild.rejectedEventIds.includes(inserted.id)) {
        // The ordered fold refused the event that was just written. Only *this*
        // row is marked — the other refusals in that fold are events whose
        // legalising neighbours may still be in flight, and condemning them on
        // a partial history is how a healthy stream grows phantom anomalies.
        await this.database
          .update(rakeEvents)
          .set({
            applied: false,
            rejectionReason:
              `Illegal at ${input.occurredAt.toISOString()} once ordered`.slice(
                0,
                200,
              ),
          })
          .where(
            and(eq(rakeEvents.orgId, orgId), eq(rakeEvents.id, inserted.id)),
          );

        await this.reprojectRake(orgId, rake.id, { quarantine: false });

        throw new ApiError(
          409,
          `${input.eventType} is not legal at ${input.occurredAt.toISOString()} in rake ${rake.code}'s history`,
          [{ event: input.eventType, recordedAs: "anomaly", wasLate: true }],
        );
      }
    }

    /**
     * **After the commit, and after the late-event re-fold.**
     *
     * The transaction closed several statements ago and the re-projection a
     * late event triggers has already run, so the projection a `rake.state`
     * frame is built from is the one a fresh read would return. Publishing any
     * earlier — inside the transaction, or before the re-fold — would broadcast
     * a position that either does not exist yet or is about to change.
     */
    this.stream.notify(orgId, inserted.id);

    await this.auditService.record({
      orgId,
      actorId: input.recordedBy ?? null,
      action: "rake.event.append",
      entityType: "rake_events",
      entityId: inserted.id,
      after: {
        rakeCode: rake.code,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        source: input.source,
        wasLate,
      },
      correlationId: input.correlationId ?? undefined,
    });

    const [projection, cycleRow] = await Promise.all([
      this.readProjection(orgId, rake.id),
      this.readCycle(orgId, cycle.id),
    ]);

    return {
      event: inserted,
      projection: projection as RakeStateRow,
      cycle: cycleRow,
      wasLate,
      reprojected: wasLate,
    };
  }

  /**
   * All-or-nothing bulk ingest — the simulator's door, and from Phase 11 the
   * extraction-confirm door.
   *
   * Sequential rather than concurrent on purpose: each event's legality is
   * judged against the state the previous one left behind, so a parallel apply
   * would race the projection against itself and reject perfectly legal
   * sequences depending on scheduling. Correctness first; the simulator's
   * throughput is not the constraint here.
   *
   * "All-or-nothing" is honoured by refusing the **whole batch** on the first
   * failure and unwinding what already landed, so a half-written journey never
   * survives. An illegal event inside a batch is a bug in the producer, not a
   * fact about the world.
   */
  async applyBulk(
    orgId: string,
    inputs: readonly ApplyEventInput[],
  ): Promise<ApplyResult[]> {
    const results: ApplyResult[] = [];

    for (const input of inputs) {
      try {
        results.push(await this.applyEvent(orgId, input));
      } catch (error) {
        await this.unwind(
          orgId,
          results.map((result) => result.event),
        );
        throw error;
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Re-projection — §13.2
  // -------------------------------------------------------------------------

  /**
   * Re-fold the turnaround a cycle id names.
   *
   * It resolves the cycle's rake and rebuilds that rake, rather than folding
   * the cycle's events alone. Folding one cycle in isolation needs a seed — the
   * state the rake was in when the cycle opened — and that is only knowable for
   * a cycle that opens with `EMPTY_AVAILABLE`. Every seeded rake's first cycle
   * begins mid-journey, so the isolated path would be wrong for exactly the
   * data the demo runs on, and a seed guessed from `rakes.current_state` would
   * produce a projection that is self-consistent and false.
   *
   * The cost is bounded: a rake's whole history is a few hundred rows, indexed
   * on `(rake_id, occurred_at)`. Phase 8 can revisit it if a cohort re-fold
   * ever needs to be cheaper than correct.
   */
  async reprojectCycle(orgId: string, cycleId: string): Promise<void> {
    const cycle = await this.readCycle(orgId, cycleId);
    if (!cycle) return;

    await this.reprojectRake(orgId, cycle.rakeId);
  }

  /**
   * Rebuild a rake's entire projection from its log and report what moved.
   *
   * This is §13.2's determinism check. On a healthy database `changed` is
   * `false` and `diff` is empty — that is the assertion, and the endpoint
   * exists so it can be made against real data rather than a fixture.
   *
   * The rebuilt state is written regardless. If it differs, the log is right
   * and the cache was wrong; refusing to correct it would leave the product
   * showing a state its own evidence contradicts.
   */
  async reprojectRake(
    orgId: string,
    rakeId: string,
    opts: { quarantine?: boolean } = {},
  ): Promise<ReprojectResult> {
    /**
     * Whether a refusal is written back to the row, or only reported.
     *
     * `true` for the explicit endpoint, which runs against a **complete** log
     * and is entitled to conclude that an event the ordered history does not
     * support is an anomaly. `false` for the automatic re-fold a late event
     * triggers, because that one runs mid-stream: the events that would
     * legalise a crossing may simply not have been delivered yet, and marking
     * it `applied = false` on that evidence is permanent — the next re-fold
     * skips quarantined rows and never reconsiders. The projection is correct
     * either way; only the durable verdict differs.
     */
    const quarantine = opts.quarantine ?? true;
    const rake = await this.requireRake(orgId, rakeId);

    const rows = await this.database
      .select()
      .from(rakeEvents)
      .where(
        and(
          eq(rakeEvents.orgId, orgId),
          eq(rakeEvents.rakeId, rakeId),
          // Rejected attempts are evidence, not history. Folding them would
          // apply transitions the state machine refused.
          eq(rakeEvents.applied, true),
        ),
      )
      .orderBy(asc(rakeEvents.occurredAt), asc(rakeEvents.id));

    const stored = await this.readProjection(orgId, rakeId);

    // A rake whose log starts mid-journey has no EMPTY_AVAILABLE to seed from,
    // so the fold begins at the fleet's resting state and the first real event
    // establishes the truth. `EMPTY_AVAILABLE` is also what `ensureProjectionRow`
    // seeds a never-touched rake with, which is what makes the rebuild reproduce
    // the incremental history rather than a different one.
    const seed = initialProjection(
      rake.stateSince,
      stored?.stationCode ?? rake.currentStation,
    );

    let events = rows.map(foldable);
    let result = project(events, { startFrom: seed });

    /**
     * Quarantine, then re-fold.
     *
     * A fold in `occurred_at` order can refuse an event that was accepted when
     * it arrived — that is exactly what happens when a late event lands between
     * two others and invalidates one of them. The refused rows are flipped to
     * `applied = false` with the reason, and the projection is rebuilt from what
     * survives. Nothing is deleted: the attempt stays queryable at
     * `/api/v1/anomalies`, which is §5.1's requirement.
     */
    const rejectedEventIds = result.rejected.map(({ event }) => event.id);
    if (quarantine && rejectedEventIds.length > 0) {
      for (const { event, reason } of result.rejected) {
        await this.database
          .update(rakeEvents)
          .set({ applied: false, rejectionReason: reason.slice(0, 200) })
          .where(and(eq(rakeEvents.orgId, orgId), eq(rakeEvents.id, event.id)));
      }

      const refused = new Set(rejectedEventIds);
      events = events.filter((event) => !refused.has(event.id));
      result = project(events, { startFrom: seed });

      this.logger.warn(
        `REPROJECTION_QUARANTINED rake=${rake.code} events=${rejectedEventIds.length}`,
      );
    }

    const cycles = await this.persistCycles(orgId, rake, result.cycles);
    const latest = cycles[cycles.length - 1] ?? null;

    const rebuilt: Projection = {
      ...result.projection,
      cycleId: latest?.id ?? result.projection.cycleId,
    };

    const diff = this.diffProjection(stored, rebuilt);

    await this.writeProjection(orgId, rake, rebuilt, { isDirty: false });

    if (Object.keys(diff).length > 0) {
      // Loud, because on a correct system this never fires. When it does, the
      // interesting question is which write bypassed the projector.
      this.logger.warn(
        `REPROJECTION_CHANGED rake=${rake.code} fields=${Object.keys(diff).join(",")}`,
      );
    }

    return {
      rakeId,
      changed: Object.keys(diff).length > 0,
      diff,
      eventCount: events.length,
      cycleCount: cycles.length,
      rejectedEventIds,
    };
  }

  /** Closes an open cycle. Idempotent — closing a closed cycle is a no-op. */
  async closeCycle(
    orgId: string,
    cycleId: string,
    endedAt: Date,
  ): Promise<RakeCycle | null> {
    const [row] = await this.database
      .update(rakeCycles)
      .set({ endedAt, isClosed: true, updatedAt: new Date() })
      .where(
        and(
          eq(rakeCycles.orgId, orgId),
          eq(rakeCycles.id, cycleId),
          eq(rakeCycles.isClosed, false),
        ),
      )
      .returning();

    return row ?? null;
  }

  // -------------------------------------------------------------------------
  // Reads used by the services above and by the query service
  // -------------------------------------------------------------------------

  async readProjection(
    orgId: string,
    rakeId: string,
  ): Promise<RakeStateRow | null> {
    const [row] = await this.database
      .select()
      .from(rakeStates)
      .where(and(eq(rakeStates.orgId, orgId), eq(rakeStates.rakeId, rakeId)))
      .limit(1);
    return row ?? null;
  }

  async readCycle(orgId: string, cycleId: string): Promise<RakeCycle | null> {
    const [row] = await this.database
      .select()
      .from(rakeCycles)
      .where(and(eq(rakeCycles.orgId, orgId), eq(rakeCycles.id, cycleId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The projection row, created on first sight from the Phase 3 seed.
   *
   * `rakes.current_state` is a projection cache that the seed wrote once. This
   * is the single moment it is *read* as an input: the first event a rake ever
   * receives has to be judged against something, and the seeded value is the
   * only statement anybody has made about where that rake stands.
   */
  private async ensureProjectionRow(
    orgId: string,
    rake: Rake,
  ): Promise<RakeStateRow> {
    const existing = await this.readProjection(orgId, rake.id);
    if (existing) return existing;

    const [row] = await this.database
      .insert(rakeStates)
      .values({
        rakeId: rake.id,
        orgId,
        state: rake.currentState,
        previousState: null,
        stationCode: rake.currentStation,
        terminalId: null,
        since: rake.stateSince,
        cycleId: null,
        lastEventId: null,
        lastEventAt: null,
        isDirty: false,
      })
      .onConflictDoNothing()
      .returning();

    return row ?? ((await this.readProjection(orgId, rake.id)) as RakeStateRow);
  }

  private async requireRake(orgId: string, rakeId: string): Promise<Rake> {
    const repo = new ScopedRepository(rakes, orgId, this.database);
    const rake = await repo.findById(rakeId);
    if (!rake) {
      // 404 for "not yours" as well as "does not exist" — the caller cannot
      // tell the two apart, and neither can somebody probing for rake ids.
      throw new ApiError(404, `Rake ${rakeId} was not found`);
    }
    return rake;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Which cycle this event belongs to, opening or closing one if it must.
   *
   * `EMPTY_AVAILABLE` is the boundary: it closes the cycle in progress at the
   * instant it occurred and opens the next. Cycle N's `ended_at` therefore
   * equals cycle N+1's `started_at`, which is what §5.2's `emptyReturn` bucket
   * measures across.
   */
  private async resolveCycle(
    orgId: string,
    rake: Rake,
    current: RakeStateRow,
    input: ApplyEventInput,
    wasLate: boolean,
  ): Promise<RakeCycle> {
    if (input.eventType === CYCLE_OPENING_EVENT && !wasLate) {
      if (current.cycleId) {
        await this.closeCycle(orgId, current.cycleId, input.occurredAt);
      }
      return this.openCycle(orgId, rake, input.occurredAt);
    }

    // A late event belongs to whichever turnaround was in progress when it
    // happened, not to the one in progress now. Filing it under `current` would
    // attach yesterday's placement to today's journey — and Phase 8 computes a
    // TAT per cycle, so that is a wrong number rather than an untidy one.
    const target =
      wasLate || !current.cycleId
        ? await this.findCycleAt(orgId, rake.id, input.occurredAt)
        : await this.readCycle(orgId, current.cycleId);

    if (!target) {
      // A log that starts mid-journey — every rake seeded by Phase 3. The
      // events are real and have to be filed somewhere, so a cycle is opened
      // at this instant rather than the events being orphaned.
      return this.openCycle(orgId, rake, input.occurredAt);
    }

    if (target.isClosed && !input.reopenReason) {
      throw new ApiError(
        409,
        `Cycle ${target.id} closed at ${target.endedAt?.toISOString()} — a completed turnaround is immutable. Resubmit with a reopenReason to write into it.`,
      );
    }

    if (target.isClosed && input.reopenReason) {
      await this.database
        .update(rakeCycles)
        .set({ isClosed: false, updatedAt: new Date() })
        .where(and(eq(rakeCycles.orgId, orgId), eq(rakeCycles.id, target.id)));

      await this.auditService.record({
        orgId,
        actorId: input.recordedBy ?? null,
        action: "rake.cycle.reopen",
        entityType: "rake_cycles",
        entityId: target.id,
        after: { reason: input.reopenReason, rakeCode: rake.code },
      });
    }

    return target;
  }

  /** The cycle whose window contains `at` — used to file a late event. */
  private async findCycleAt(
    orgId: string,
    rakeId: string,
    at: Date,
  ): Promise<RakeCycle | null> {
    // The **latest** cycle that had already started — ordering ascending would
    // return the rake's first ever turnaround for every late event.
    const [row] = await this.database
      .select()
      .from(rakeCycles)
      .where(
        and(
          eq(rakeCycles.orgId, orgId),
          eq(rakeCycles.rakeId, rakeId),
          lte(rakeCycles.startedAt, at),
        ),
      )
      .orderBy(desc(rakeCycles.startedAt))
      .limit(1);

    return row ?? null;
  }

  private async openCycle(
    orgId: string,
    rake: Rake,
    startedAt: Date,
  ): Promise<RakeCycle> {
    const values: NewRakeCycle = {
      orgId,
      rakeId: rake.id,
      startedAt,
      isClosed: false,
      eventCount: 0,
    };
    const [row] = await this.database
      .insert(rakeCycles)
      .values(values)
      .returning();
    return row;
  }

  /**
   * The incremental half of the fold: one event onto a known projection.
   *
   * It must agree with `project()` over the same event — the determinism suite
   * asserts that by folding both ways — which is why the state calculation is
   * delegated to `nextState` rather than reimplemented here.
   */
  private async advance(
    tx: Parameters<Parameters<DB["transaction"]>[0]>[0],
    orgId: string,
    rake: Rake,
    current: RakeStateRow,
    event: RakeEvent,
    cycle: RakeCycle,
  ): Promise<void> {
    const target = nextState(
      current.state,
      event.eventType,
      current.previousState,
    );

    const moved = target !== current.state;
    const isExceptionEntry =
      moved &&
      (target === "DETAINED" ||
        target === "SICK" ||
        target === "DIVERTED" ||
        target === "HELD_FOR_ORDER");

    const stationCode = event.stationCode ?? current.stationCode;
    // Must agree with `project()` over the same event, or an incremental apply
    // and a re-projection would disagree and §13.2's check would fail.
    const terminalId = event.terminalId
      ? event.terminalId
      : CLEARS_TERMINAL.has(event.eventType)
        ? null
        : current.terminalId;

    await tx
      .update(rakeStates)
      .set({
        state: target,
        previousState: isExceptionEntry
          ? current.state
          : moved
            ? null
            : current.previousState,
        stationCode,
        terminalId,
        since: moved ? event.occurredAt : current.since,
        cycleId: cycle.id,
        lastEventId: event.id,
        lastEventAt: event.occurredAt,
        isDirty: false,
        updatedAt: new Date(),
      })
      .where(eq(rakeStates.rakeId, rake.id));

    // The denormalised copy on `rakes`, kept so the allotment board and the
    // master-data screens can filter without replaying events. Written here and
    // nowhere else — see the warning on the columns themselves.
    await tx
      .update(rakes)
      .set({
        currentState: target,
        currentStation: stationCode,
        stateSince: moved ? event.occurredAt : current.since,
        updatedAt: new Date(),
      })
      .where(and(eq(rakes.orgId, orgId), eq(rakes.id, rake.id)));

    const payload = event.payload as {
      netWeightT?: number;
      commodityCode?: string;
    } | null;
    await tx
      .update(rakeCycles)
      .set({
        eventCount: cycle.eventCount + 1,
        originTerminalId:
          event.eventType === "PLACED_FOR_LOADING" && event.terminalId
            ? event.terminalId
            : cycle.originTerminalId,
        destTerminalId:
          event.eventType === "PLACED_FOR_UNLOADING" && event.terminalId
            ? event.terminalId
            : cycle.destTerminalId,
        netWeightT:
          typeof payload?.netWeightT === "number"
            ? payload.netWeightT
            : cycle.netWeightT,
        // Filed from the loading events until Phase 6's indent supersedes it —
        // `freeTime()` is scoped by commodity group, so a cycle that does not
        // know what it is carrying gets the zone-wide default rule.
        commodityCode: payload?.commodityCode ?? cycle.commodityCode,
        updatedAt: new Date(),
      })
      .where(eq(rakeCycles.id, cycle.id));
  }

  /**
   * Persists an illegal attempt and returns.
   *
   * Its own transaction, deliberately: the caller throws a 409 straight after,
   * and a row written inside the failing request's transaction would roll back
   * with it — leaving §5.1's "logged as anomalies" as a comment rather than a
   * fact. A failure to record the anomaly must not mask the 409 either, so it
   * is logged and swallowed.
   */
  private async recordAnomaly(
    orgId: string,
    rake: Rake,
    from: string,
    input: ApplyEventInput,
  ): Promise<void> {
    const reason = `Illegal from ${from}`.slice(0, 200);

    const eventId = randomUUID();

    try {
      await this.database.transaction(async (tx) => {
        await tx.insert(rakeEventKeys).values({
          idempotencyKey: input.idempotencyKey,
          orgId,
          eventId,
          occurredAt: input.occurredAt,
        });
        await tx.insert(rakeEvents).values({
          id: eventId,
          orgId,
          rakeId: rake.id,
          cycleId: null,
          eventType: input.eventType,
          occurredAt: input.occurredAt,
          stationCode: input.stationCode ?? null,
          terminalId: input.terminalId ?? null,
          payload: input.payload ?? {},
          source: input.source,
          sourceRef: input.sourceRef ?? null,
          recordedBy: input.recordedBy ?? null,
          idempotencyKey: input.idempotencyKey,
          applied: false,
          rejectionReason: reason,
          correlationId: input.correlationId ?? null,
        });
      });

      // Its own transaction committed, so the refusal is now a fact and the
      // exception queue is entitled to hear about it. The frame carries
      // `applied: false` and no `rake.state` follows it — nothing moved.
      this.stream.notify(orgId, eventId);
    } catch (error) {
      if (isUniqueViolation(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `ANOMALY_WRITE_FAILED rake=${rake.code} event=${input.eventType} — ${message}`,
      );
    }
  }

  /**
   * Removes events written earlier in a failed bulk, so a batch is all-or-nothing.
   *
   * The only place in this module that deletes from `rake_events`, and the
   * exception that proves the append-only rule rather than breaking it: these
   * rows describe half of a journey the producer has already abandoned, and
   * they were never visible to a reader — the whole batch is one request.
   */
  private async unwind(
    orgId: string,
    events: readonly RakeEvent[],
  ): Promise<void> {
    if (events.length === 0) return;

    const rakeIds = new Set(events.map((event) => event.rakeId));

    for (const event of events) {
      await this.database
        .delete(rakeEvents)
        .where(and(eq(rakeEvents.orgId, orgId), eq(rakeEvents.id, event.id)));
      await this.database
        .delete(rakeEventKeys)
        .where(eq(rakeEventKeys.idempotencyKey, event.idempotencyKey));
    }

    // The projection advanced as the batch went in, so it now describes events
    // that no longer exist. Rebuilding from what is left is the only way back
    // to a state the log supports.
    for (const rakeId of rakeIds) {
      await this.reprojectRake(orgId, rakeId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `UNWIND_REPROJECT_FAILED rake=${rakeId} — ${message}`,
        );
      });
    }
  }

  /**
   * Writes the cycle rows a re-fold produced, and re-files the events under
   * them. Returns the rows in chronological order.
   */
  private async persistCycles(
    orgId: string,
    rake: Rake,
    summaries: readonly CycleSummary[],
  ): Promise<RakeCycle[]> {
    const rows: RakeCycle[] = [];

    for (const summary of summaries) {
      const id = summary.cycleId ?? randomUUID();

      const values: NewRakeCycle = {
        id,
        orgId,
        rakeId: rake.id,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        isClosed: summary.isClosed,
        eventCount: summary.eventCount,
        originTerminalId: summary.originTerminalId,
        destTerminalId: summary.destTerminalId,
        netWeightT: summary.netWeightT,
        commodityCode: summary.commodityCode,
        updatedAt: new Date(),
      };

      const [row] = await this.database
        .insert(rakeCycles)
        .values(values)
        .onConflictDoUpdate({
          target: rakeCycles.id,
          set: {
            startedAt: values.startedAt,
            endedAt: values.endedAt,
            isClosed: values.isClosed,
            eventCount: values.eventCount,
            originTerminalId: values.originTerminalId,
            destTerminalId: values.destTerminalId,
            netWeightT: values.netWeightT,
            commodityCode: values.commodityCode,
            updatedAt: values.updatedAt,
          },
        })
        .returning();

      rows.push(row);

      const misfiled = summary.events.filter((event) => event.cycleId !== id);
      for (const event of misfiled) {
        await this.database
          .update(rakeEvents)
          .set({ cycleId: id })
          .where(and(eq(rakeEvents.orgId, orgId), eq(rakeEvents.id, event.id)));
      }
    }

    return rows;
  }

  private async writeProjection(
    orgId: string,
    rake: Rake,
    projection: Projection,
    opts: { isDirty: boolean },
  ): Promise<void> {
    await this.database
      .insert(rakeStates)
      .values({
        rakeId: rake.id,
        orgId,
        state: projection.state,
        previousState: projection.previousState,
        stationCode: projection.stationCode,
        terminalId: projection.terminalId,
        since: projection.since,
        cycleId: projection.cycleId,
        lastEventId: projection.lastEventId,
        lastEventAt: projection.lastEventAt,
        isDirty: opts.isDirty,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: rakeStates.rakeId,
        set: {
          state: projection.state,
          previousState: projection.previousState,
          stationCode: projection.stationCode,
          terminalId: projection.terminalId,
          since: projection.since,
          cycleId: projection.cycleId,
          lastEventId: projection.lastEventId,
          lastEventAt: projection.lastEventAt,
          isDirty: opts.isDirty,
          updatedAt: new Date(),
        },
      });

    await this.database
      .update(rakes)
      .set({
        currentState: projection.state,
        currentStation: projection.stationCode,
        stateSince: projection.since,
        updatedAt: new Date(),
      })
      .where(and(eq(rakes.orgId, orgId), eq(rakes.id, rake.id)));
  }

  /**
   * What changed between the stored projection and the rebuilt one.
   *
   * Only the fields a fold can produce are compared. `updated_at` and
   * `is_dirty` are excluded because they describe the *cache*, not the state —
   * including them would make every re-projection report a change and the
   * determinism check would never mean anything.
   */
  private diffProjection(
    stored: RakeStateRow | null,
    rebuilt: Projection,
  ): Record<string, { stored: unknown; rebuilt: unknown }> {
    if (!stored) return {};

    const pairs: Record<string, [unknown, unknown]> = {
      state: [stored.state, rebuilt.state],
      previousState: [stored.previousState, rebuilt.previousState],
      stationCode: [stored.stationCode, rebuilt.stationCode],
      terminalId: [stored.terminalId, rebuilt.terminalId],
      since: [
        stored.since?.toISOString() ?? null,
        rebuilt.since?.toISOString() ?? null,
      ],
      cycleId: [stored.cycleId, rebuilt.cycleId],
      lastEventId: [stored.lastEventId, rebuilt.lastEventId],
      lastEventAt: [
        stored.lastEventAt?.toISOString() ?? null,
        rebuilt.lastEventAt?.toISOString() ?? null,
      ],
    };

    const diff: Record<string, { stored: unknown; rebuilt: unknown }> = {};
    for (const [field, [a, b]] of Object.entries(pairs)) {
      if (a !== b) diff[field] = { stored: a, rebuilt: b };
    }
    return diff;
  }
}

export default ProjectorService;

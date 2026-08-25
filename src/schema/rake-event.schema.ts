/**
 * The event spine (DESIGN.md §4.5): an append-only log, the projection it
 * folds into, and the turnaround cycles it groups itself by.
 *
 * Read the three tables as one mechanism. `rake_events` is the truth and is
 * never updated. `rake_states` is a **cache of a fold over that truth** and can
 * be deleted and rebuilt at any moment without losing anything. `rake_cycles`
 * is a per-turnaround summary of the same fold, kept because Phase 8 has to
 * compare thousands of turnarounds and replaying every rake's whole history to
 * do it is not a query, it is a batch job.
 *
 * ---
 *
 * **Two corrections to the phase document, both forced by Postgres.**
 *
 * 1. The projection table is `rake_states`, not `rake_state`. Creating a table
 *    implicitly creates a composite type of the same name, and `rake_state` is
 *    already taken — by the `rake_state` **enum** Phase 3 declared. The plural
 *    also matches every other table here.
 *
 * 2. `idempotency_key` cannot be globally unique on a partitioned table.
 *    Postgres requires every unique constraint on a partitioned table to
 *    include the partition key, so `UNIQUE (idempotency_key)` and
 *    `PARTITION BY RANGE (occurred_at)` are mutually exclusive — and
 *    `UNIQUE (idempotency_key, occurred_at)` would let the same key land twice
 *    with two different timestamps, which is exactly the retry it exists to
 *    stop. The uniqueness therefore lives in `rake_event_keys`, a small
 *    unpartitioned side table written in the same transaction as the event.
 *    §8's guarantee is unchanged: a second insert of the same key fails on a
 *    primary key, in the database, and cannot be flushed.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { commodities } from "./commodity.schema";
import { organizations } from "./organization.schema";
import { rakes } from "./rake.schema";
import { stations } from "./network.schema";
import { terminals } from "./terminal.schema";
import { users } from "./user.schema";
import {
  eventSourceEnum,
  rakeEventTypeEnum,
  rakeStateEnum,
} from "./enums.schema";
import type { RakeEventPayload } from "../types/event-payload.types";

/**
 * Every operational fact, in the order it happened — not the order it arrived.
 *
 * `occurred_at` is the ordering key and `recorded_at` is when the row landed.
 * They are separate columns rather than one because the **gap between them is
 * itself a signal** (§8): a placement recorded eleven hours after it supposedly
 * happened, or one backdated to a suspiciously round hour, is the shape of
 * detention hours being massaged. The rake detail screen renders the divergence
 * as its own column for that reason.
 *
 * Partitioned monthly by `occurred_at` — see the hand-edited migration. The
 * primary key is `(id, occurred_at)` because Postgres requires the partition
 * key in it; `id` alone is still unique in practice, since it is a random uuid.
 */
export const rakeEvents = pgTable(
  "rake_events",
  {
    id: uuid("id").notNull().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    rakeId: uuid("rake_id")
      .notNull()
      .references(() => rakes.id, { onDelete: "restrict" }),
    /**
     * The turnaround this event belongs to. Assigned by the projector at insert
     * time, not by the caller — a client that could choose the cycle could
     * attach a placement to a turnaround that closed last week.
     */
    cycleId: uuid("cycle_id"),
    eventType: rakeEventTypeEnum("event_type").notNull(),

    /** **The ordering key.** Everything folds in this order, always. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Arrival time. Set by the server; a caller cannot backdate this one. */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    stationCode: varchar("station_code", { length: 8 }).references(
      () => stations.code,
      { onDelete: "restrict" },
    ),
    terminalId: uuid("terminal_id").references(() => terminals.id, {
      onDelete: "restrict",
    }),

    payload: jsonb("payload").$type<RakeEventPayload>().notNull().default({}),

    source: eventSourceEnum("source").notNull(),
    /** The simulator's run id, the FOIS message id, the extraction job id. */
    sourceRef: varchar("source_ref", { length: 120 }),
    /**
     * §8: the supervisor's identity on every event. `set null` rather than
     * `restrict` — a departed employee's account can be removed, and the event
     * they recorded must not be removable with it.
     */
    recordedBy: uuid("recorded_by").references(() => users.id, {
      onDelete: "set null",
    }),

    /** Globally unique via `rake_event_keys`; see the file header. */
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),

    /**
     * `false` = the transition was illegal and the attempt was **refused**.
     *
     * The row is kept anyway. §5.1 requires illegal transitions to be "logged
     * as anomalies, never silently applied", and a rejection that leaves no
     * trace is indistinguishable from a request that was never made — which is
     * precisely what somebody covering up a mis-keyed detention would want.
     */
    applied: boolean("applied").notNull().default(true),
    rejectionReason: varchar("rejection_reason", { length: 200 }),

    /** Set on a `CORRECTION`. The corrected row itself is never touched. */
    correctsEventId: uuid("corrects_event_id"),

    correlationId: varchar("correlation_id", { length: 64 }),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.occurredAt] }),
    index("rake_events_rake_id_occurred_at_idx").on(
      table.rakeId,
      table.occurredAt,
    ),
    index("rake_events_cycle_id_idx").on(table.cycleId),
    index("rake_events_org_id_occurred_at_idx").on(
      table.orgId,
      table.occurredAt.desc(),
    ),
    index("rake_events_event_type_idx").on(table.eventType),
    index("rake_events_applied_idx").on(table.applied),
  ],
);

/**
 * The durable half of idempotency (§8).
 *
 * Unpartitioned and tiny — one narrow row per event — so the primary key can be
 * the key alone. Written in the same transaction as the event it names, which
 * makes "the event landed but the key did not" unreachable.
 *
 * The concrete failure this stops: a siding supervisor's phone loses signal
 * mid-submit and retries. Redis (`idempotent()` middleware) catches it in the
 * common case and forgets after a day; this catches it forever. Double-counted
 * detention hours are money.
 */
export const rakeEventKeys = pgTable(
  "rake_event_keys",
  {
    idempotencyKey: varchar("idempotency_key", { length: 120 }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    eventId: uuid("event_id").notNull(),
    /** Together with `event_id`, the composite key needed to find the event. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("rake_event_keys_event_id_idx").on(table.eventId)],
);

/**
 * The projection — one row per rake, derived and disposable.
 *
 * Nothing here is authoritative. `TRUNCATE rake_states` followed by a
 * re-projection of every rake produces byte-identical rows, and §13.2 makes
 * that a check the product exposes as an endpoint rather than a claim in a
 * document.
 *
 * **Keyed on `rake_id`, so it does not use `ScopedRepository`.** That class
 * requires an `id` column, and inventing a surrogate key for a table with
 * exactly one row per rake would be a column that exists to satisfy a type.
 * The projector scopes every read and write here with an explicit
 * `org_id` predicate instead, and the isolation suite asserts against that
 * shape rather than against a repository this table could never use.
 */
export const rakeStates = pgTable(
  "rake_states",
  {
    rakeId: uuid("rake_id")
      .primaryKey()
      .references(() => rakes.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    state: rakeStateEnum("state").notNull(),
    /**
     * Where to go back to when an exception clears.
     *
     * One slot, not a stack — which is why `EXCEPTION_ENTRY` is illegal from an
     * exception state. A second slot would model a rake that is both sick and
     * detained, and nothing downstream knows what to do with that.
     */
    previousState: rakeStateEnum("previous_state"),

    stationCode: varchar("station_code", { length: 8 }).references(
      () => stations.code,
      { onDelete: "restrict" },
    ),
    terminalId: uuid("terminal_id").references(() => terminals.id, {
      onDelete: "restrict",
    }),

    /** When the rake entered `state`. Time-in-state is `now() - since`. */
    since: timestamp("since", { withTimezone: true }).notNull(),

    cycleId: uuid("cycle_id"),
    lastEventId: uuid("last_event_id"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),

    /** Populated from Phase 6, when a rake can be attached to demand. */
    indentId: uuid("indent_id"),

    /**
     * Set when an event arrives with an `occurred_at` earlier than
     * `last_event_at` — the projection is now a fold over a list that was not
     * sorted, so it is wrong until the cycle is re-projected. Cleared by the
     * re-projection. A dirty row is not hidden from the map: a stale position
     * shown as stale beats a position quietly withheld.
     */
    isDirty: boolean("is_dirty").notNull().default(false),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("rake_states_org_id_state_idx").on(table.orgId, table.state),
    index("rake_states_station_code_idx").on(table.stationCode),
    index("rake_states_is_dirty_idx").on(table.isDirty),
  ],
);

/**
 * One turnaround.
 *
 * Opened by an `EMPTY_AVAILABLE` event and closed by the next one. Phase 4
 * opens, closes and counts; `tat_hours` and `buckets` stay null until Phase 8,
 * which is honest — computing them needs `freeTime()` and the cohort machinery,
 * and a column filled with a plausible placeholder is worse than a null.
 */
export const rakeCycles = pgTable(
  "rake_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    rakeId: uuid("rake_id")
      .notNull()
      .references(() => rakes.id, { onDelete: "restrict" }),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Null while open. Equals the next cycle's `started_at` once closed. */
    endedAt: timestamp("ended_at", { withTimezone: true }),

    /** **Phase 8.** Left null here rather than approximated. */
    tatHours: numeric("tat_hours", { precision: 8, scale: 2, mode: "number" }),
    /** **Phase 8** — §5.2's attribution buckets. */
    buckets: jsonb("buckets").$type<Record<string, number>>(),

    originTerminalId: uuid("origin_terminal_id").references(
      () => terminals.id,
      { onDelete: "set null" },
    ),
    destTerminalId: uuid("dest_terminal_id").references(() => terminals.id, {
      onDelete: "set null",
    }),
    commodityCode: varchar("commodity_code", { length: 20 }).references(
      () => commodities.code,
      { onDelete: "set null" },
    ),

    /** Phase 6 fills both. */
    indentId: uuid("indent_id"),
    consignmentId: uuid("consignment_id"),

    netWeightT: numeric("net_weight_t", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),

    isClosed: boolean("is_closed").notNull().default(false),
    eventCount: integer("event_count").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("rake_cycles_org_id_started_at_idx").on(
      table.orgId,
      table.startedAt.desc(),
    ),
    index("rake_cycles_rake_id_started_at_idx").on(
      table.rakeId,
      table.startedAt.desc(),
    ),
    index("rake_cycles_is_closed_idx").on(table.isClosed),
  ],
);

export type RakeEvent = typeof rakeEvents.$inferSelect;
export type NewRakeEvent = typeof rakeEvents.$inferInsert;

export type RakeEventKey = typeof rakeEventKeys.$inferSelect;
export type NewRakeEventKey = typeof rakeEventKeys.$inferInsert;

export type RakeStateRow = typeof rakeStates.$inferSelect;
export type NewRakeStateRow = typeof rakeStates.$inferInsert;

export type RakeCycle = typeof rakeCycles.$inferSelect;
export type NewRakeCycle = typeof rakeCycles.$inferInsert;

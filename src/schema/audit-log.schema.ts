/**
 * audit_log — append-only record of every write that matters (DESIGN.md §4.1, §8).
 *
 * §8 lists Repudiation as a STRIDE category the product must answer for:
 * "decisions are never updated in place". That is enforced here rather than
 * requested — the migration adds DO INSTEAD NOTHING rules for UPDATE and DELETE,
 * so an UPDATE against this table affects zero rows and raises no error. Code
 * that tries to rewrite history does not get an exception; it gets nothing.
 *
 * `before`/`after` are jsonb snapshots rather than a diff, because reading a
 * two-year-old diff requires replaying every diff before it, and by then the
 * column it referenced may not exist.
 */
import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { users } from "./user.schema";
import { organizations } from "./organization.schema";
import { roleNameEnum } from "./enums.schema";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * `restrict`, never `cascade`: deleting a tenant must not erase the record
     * of what that tenant did. If an organization ever has to go, its audit
     * trail is exported first and the delete is a deliberate, manual act.
     */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    /**
     * Null means the actor was the system — the simulator, a cron, a consumer.
     *
     * `restrict`, not `set null`, for two reasons that point the same way.
     *
     * The principled one: blanking the actor on a row in an append-only table
     * *is* a rewrite of history. "Nobody knows who approved this waiver" is a
     * worse answer than "this user cannot be deleted while their actions are on
     * record", and the second is what an audit trail is for.
     *
     * The mechanical one: `set null` is not merely undesirable here, it is
     * **incompatible** with the DO INSTEAD NOTHING rules. Postgres implements
     * the action by issuing an UPDATE against this table, the ON UPDATE rule
     * rewrites that UPDATE to nothing, and the referential-integrity check then
     * fails the whole DELETE with `XX000: ... gave unexpected result`. It fires
     * even when audit_log is empty, because it is the RI query itself that gets
     * rewritten. `restrict` uses a SELECT, which no rule touches.
     *
     * Consequence: emptying this table is `TRUNCATE audit_log` and it must come
     * *before* deleting users or organizations. See scripts/seed.ts.
     */
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "restrict",
    }),

    /**
     * Denormalised on purpose. The question an audit answers is "what was this
     * person allowed to do *at the time*", and a later role change would
     * rewrite that answer if it were resolved through a join.
     */
    actorRole: roleNameEnum("actor_role"),

    /** Dot-namespaced: `indent.approve`, `charge.waive`, `rake.event.ingest`. */
    action: varchar("action", { length: 80 }).notNull(),

    /** The table the action landed on. */
    entityType: varchar("entity_type", { length: 60 }).notNull(),

    /**
     * varchar, not uuid: some entities are keyed by code rather than by id —
     * a station is `KWV`, a charge rule is a circular number.
     */
    entityId: varchar("entity_id", { length: 80 }).notNull(),

    /** Null on create. */
    before: jsonb("before"),
    /** Null on delete. */
    after: jsonb("after"),

    ip: varchar("ip", { length: 64 }),

    /** Threads request → queue → AI call. See middlewares/request-id. */
    correlationId: varchar("correlation_id", { length: 64 }),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The audit viewer's default query: one tenant, newest first.
    index("audit_log_org_id_at_idx").on(table.orgId, table.at.desc()),
    // "Show me everything that happened to this rake."
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
    // "Show me everything this person did."
    index("audit_log_actor_id_idx").on(table.actorId),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;

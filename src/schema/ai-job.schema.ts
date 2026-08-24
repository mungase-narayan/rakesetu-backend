/**
 * ai_jobs — one row per unit of GenAI work (DESIGN.md §4.8).
 *
 * This is the `jobId` in `AiJobBase` (types/queue.types.ts): the backend inserts
 * the row, publishes the id, and the AI service writes its result back against
 * it. The row is the durable half of the queue — a message that dies in a
 * dead-letter queue still leaves a `failed` row explaining what was attempted.
 *
 * `input` is kept so a job can be replayed after a prompt change without the
 * caller reconstructing it, and `prompt_version` is kept because §9.3 scores
 * evals per version: without it, "did the new prompt help?" is unanswerable.
 *
 * Cost is `numeric`, never a float. It is money.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  integer,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { users } from "./user.schema";
import { organizations } from "./organization.schema";
import { aiJobStatusEnum, aiJobTypeEnum } from "./enums.schema";

export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    type: aiJobTypeEnum("type").notNull(),
    status: aiJobStatusEnum("status").notNull().default("queued"),

    /** What the job is about: `allotment` · `detention` · `charge` · `siding_log`. */
    subjectType: varchar("subject_type", { length: 60 }),
    subjectId: varchar("subject_id", { length: 80 }),

    /** Null for scheduled or simulator-triggered work. */
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),

    correlationId: varchar("correlation_id", { length: 64 }),

    provider: varchar("provider", { length: 40 }),
    model: varchar("model", { length: 80 }),
    /** Eval scores are tracked per prompt version (§9.3). */
    promptVersion: varchar("prompt_version", { length: 40 }),

    /** The published payload, verbatim, so the job can be replayed. */
    input: jsonb("input"),
    output: jsonb("output"),

    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    /** numeric, never float — this feeds the per-org budget breaker (§11). */
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    latencyMs: integer("latency_ms"),

    error: text("error"),
    attempts: integer("attempts").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ai_jobs_org_id_created_at_idx").on(
      table.orgId,
      table.createdAt.desc(),
    ),
    index("ai_jobs_status_idx").on(table.status),
    // The review queue's query: "every failed extraction", "everything queued".
    index("ai_jobs_type_status_idx").on(table.type, table.status),
    // "What did the model say about THIS allotment?"
    index("ai_jobs_subject_idx").on(table.subjectType, table.subjectId),
  ],
);

export type AiJob = typeof aiJobs.$inferSelect;
export type NewAiJob = typeof aiJobs.$inferInsert;
export type UpdateAiJob = Partial<NewAiJob>;

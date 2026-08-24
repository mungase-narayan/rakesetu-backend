/**
 * email_jobs — the transactional-mail outbox.
 *
 * The row is written **before** the message is published, exactly as `ai_jobs`
 * is, for the same reason: if the publish then fails, a `queued` row is left
 * with no message — visible, diagnosable and re-sendable. The reverse order
 * loses the email silently, and "why did this person never get their
 * invitation?" becomes unanswerable.
 *
 * ## What must never be written here
 *
 * `payload` holds the **non-secret** render context and nothing else. In
 * particular, not:
 *
 *  - the plaintext token;
 *  - the `url` — it *contains* the token, which is the one people get wrong;
 *  - the rendered `html` or `text`. This is the strongest temptation ("store
 *    what we actually sent, for debugging") and the worst offender, because
 *    both templates deliberately print the URL in the body as visible text as
 *    well as behind the button. Only `subject` is kept.
 *
 * `EnqueueEmailInput` enforces this structurally rather than by convention: the
 * secret-bearing fields are a separate argument that `createJob()` never has in
 * scope. See `modules/email/types/email-job.types.ts`.
 *
 * ## The consequence, stated plainly
 *
 * A token-bearing row is **not replayable from the database** — the link cannot
 * be rebuilt from it. `has_secret` records which rows those are, so a future
 * replay tool refuses them instead of sending a broken link. Recovery is
 * re-issuing (the "Re-send invitation" path), which mints a fresh token and
 * supersedes the old one. That is the right behaviour regardless: the original
 * may be near expiry by the time anyone notices.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { users } from "./user.schema";
import { organizations } from "./organization.schema";
import { emailJobStatusEnum, emailTemplateEnum } from "./enums.schema";

export const emailJobs = pgTable(
  "email_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    /** The recipient, when they are a user of this system. */
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    template: emailTemplateEnum("template").notNull(),
    status: emailJobStatusEnum("status").notNull().default("queued"),

    /** Denormalised and lowercased: the address it was actually sent to. */
    toEmail: varchar("to_email", { length: 254 }).notNull(),
    /** Written by the consumer, from the rendered message. */
    subject: varchar("subject", { length: 255 }),

    /** Non-secret render context. See the note at the top of this file. */
    payload: jsonb("payload").notNull(),

    /**
     * True when the message carried a token-bearing URL, and therefore when
     * this row cannot rebuild the email it describes.
     */
    hasSecret: boolean("has_secret").notNull().default(false),

    attempts: integer("attempts").notNull().default(0),
    /** Stamped from the per-template budget, so the ladder is visible in SQL. */
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),

    /** SMTP's own id — the thread that leads into Mailpit or a provider log. */
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    correlationId: varchar("correlation_id", { length: 64 }),

    /** The admin who triggered it. Null for a self-service password reset. */
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),

    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("email_jobs_org_id_created_at_idx").on(
      table.orgId,
      table.createdAt.desc(),
    ),
    index("email_jobs_status_idx").on(table.status),
    index("email_jobs_template_status_idx").on(table.template, table.status),
    index("email_jobs_user_id_idx").on(table.userId),
    index("email_jobs_correlation_id_idx").on(table.correlationId),
  ],
);

export type EmailJob = typeof emailJobs.$inferSelect;
export type NewEmailJob = typeof emailJobs.$inferInsert;

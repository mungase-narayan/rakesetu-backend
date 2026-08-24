/**
 * Queue topology and message contracts.
 *
 * RakeSetu talks to rakesetu-ai-ml asynchronously: the backend publishes a job,
 * the AI service consumes it, does the LLM work and writes back. Nothing on the
 * request path waits for a model — per DESIGN.md §3, "a GenAI outage degrades
 * the product, never breaks it".
 *
 * One queue per job kind, and one dead-letter queue per consumer (DESIGN.md
 * §12), so a poisoned extraction message can never stall explanations.
 *
 *   ai.exchange (direct) ──ai.extraction──▶ ai.extraction  ──nack──▶ ai.dlx ──▶ ai.extraction.failed
 *                        ──ai.explanation─▶ ai.explanation ──nack──▶ ai.dlx ──▶ ai.explanation.failed
 *                        ──ai.ingest──────▶ ai.ingest      ──nack──▶ ai.dlx ──▶ ai.ingest.failed
 *
 * Transactional email is a **second family on the same connection**:
 *
 *   email.exchange (direct) ──email.send──▶ email.send ──nack──▶ email.dlx ──▶ email.send.failed
 *
 * Note the deliberate asymmetry, because the AI family teaches the opposite
 * lesson and it is easy to copy the wrong one: there is exactly **one** email
 * queue. The template (`invitation`, `password_reset`) is a field in the
 * message, **not** a routing key. Email differs by what it renders, not by who
 * consumes it, so per-template queues would be three bindings that always fan
 * to the same handler.
 */

export const AI_JOB_KINDS = ["extraction", "explanation", "ingest"] as const;

export type AiJobKind = (typeof AI_JOB_KINDS)[number];

export const AI_EXCHANGES = {
  MAIN: "ai.exchange",
  DEAD_LETTER: "ai.dlx",
} as const;

export const AI_QUEUES = {
  extraction: "ai.extraction",
  explanation: "ai.explanation",
  ingest: "ai.ingest",
} as const satisfies Record<AiJobKind, string>;

export const AI_FAILED_QUEUES = {
  extraction: "ai.extraction.failed",
  explanation: "ai.explanation.failed",
  ingest: "ai.ingest.failed",
} as const satisfies Record<AiJobKind, string>;

/**
 * The routing key doubles as the queue name: a direct exchange with one key per
 * kind is all the fan-out RakeSetu needs, and it keeps the binding table
 * readable in the management UI.
 */
export const AI_ROUTING_KEYS = {
  extraction: "ai.extraction",
  explanation: "ai.explanation",
  ingest: "ai.ingest",
} as const satisfies Record<AiJobKind, string>;

/** A message unclaimed for 24 h is stale freight data; dead-letter it. */
export const AI_MESSAGE_TTL_MS = 86_400_000;

/* ------------------------------------------------------------------ email -- */

/**
 * One kind, and that is the point — see the note in the file header.
 *
 * This exists as an array only so the email family can reuse the same
 * `QueueFamily` descriptor the AI family uses, rather than the topology code
 * growing a special case for "the family with one queue".
 */
export const EMAIL_QUEUE_KINDS = ["send"] as const;

export type EmailQueueKind = (typeof EMAIL_QUEUE_KINDS)[number];

export const EMAIL_EXCHANGES = {
  MAIN: "email.exchange",
  DEAD_LETTER: "email.dlx",
} as const;

export const EMAIL_QUEUES = {
  send: "email.send",
} as const satisfies Record<EmailQueueKind, string>;

export const EMAIL_FAILED_QUEUES = {
  send: "email.send.failed",
} as const satisfies Record<EmailQueueKind, string>;

export const EMAIL_ROUTING_KEYS = {
  send: "email.send",
} as const satisfies Record<EmailQueueKind, string>;

/**
 * One hour, not the AI family's twenty-four.
 *
 * Two reasons, and both matter. The message carries a **live token** (see
 * `EmailJobMessage.url`), so the TTL bounds how long a credential sits in the
 * broker's on-disk store. And a password-reset link only lives an hour anyway —
 * a message delivered after a day would put an already-dead link in somebody's
 * inbox, which is worse than dead-lettering it where an operator can see it.
 *
 * Changing this value means deleting the queue first: `assertQueue` with
 * different `arguments` fails PRECONDITION_FAILED and takes startup with it.
 */
export const EMAIL_MESSAGE_TTL_MS = 3_600_000;

interface AiJobBase {
  /** Row id in `ai_jobs`; the AI service writes its result back against this. */
  jobId: string;
  /** Tenant the job belongs to. Every consumer must scope its writes by it. */
  orgId: string;
  /** Threads the request → queue → AI call in the logs (DESIGN.md §12). */
  correlationId: string;
  /** User who triggered the job, or `"system"` for scheduled work. */
  requestedBy: string;
  timestamp: Date;
}

/** Unstructured text (siding log, email indent, RR scan) → structured events. */
export interface AiExtractionJob extends AiJobBase {
  kind: "extraction";
  source: "siding_log" | "email_indent" | "rr_document";
  /** Raw text when it was pasted; empty when `documentUrl` carries the input. */
  text: string;
  /** S3/MinIO key of the uploaded document, when there is one. */
  documentUrl?: string;
}

/** Narrate a decision the deterministic core has *already* made. */
export interface AiExplanationJob extends AiJobBase {
  kind: "explanation";
  subject: "allotment" | "detention" | "charge";
  subjectId: string;
  /** The solver/engine output being explained. The model never recomputes it. */
  facts: Record<string, unknown>;
}

/** Rate circular / policy PDF → chunks + embeddings for RAG. */
export interface AiIngestJob extends AiJobBase {
  kind: "ingest";
  documentUrl: string;
  title: string;
  circularNo?: string;
  effectiveFrom?: string;
}

export type AiJobPayload = AiExtractionJob | AiExplanationJob | AiIngestJob;

export type AiJobHandler = (payload: AiJobPayload) => Promise<void>;

/* ----------------------------------------------------------------- family -- */

/**
 * A topology family: one exchange, one dead-letter exchange, and a queue per
 * kind. Everything `RabbitMQService` needs to assert and address a set of
 * queues, as data rather than as code.
 *
 * This exists so `ai.*` and `email.*` share one connection, one `setup()` and
 * one publish/consume implementation. The variation between them is six strings
 * and a TTL — a record, not a subclass.
 */
export interface QueueFamily<K extends string> {
  /** Selects the inline fallback handler when the broker is disabled. */
  name: "ai" | "email";
  /** Prefix for log events, so `AiJobPublished` and `EmailJobPublished` keep
   *  their existing shapes rather than becoming a generic string. */
  logPrefix: string;
  exchange: string;
  deadLetterExchange: string;
  kinds: readonly K[];
  queues: Record<K, string>;
  failedQueues: Record<K, string>;
  routingKeys: Record<K, string>;
  messageTtlMs: number;
}

/**
 * The minimum every message on either family carries.
 *
 * `AiJobBase` already satisfies this with no edits, which is the evidence that
 * this is the right common shape rather than one invented to fit.
 */
export interface QueueEnvelope<K extends string> {
  kind: K;
  jobId: string;
  orgId: string;
  correlationId: string;
}

export const AI_FAMILY: QueueFamily<AiJobKind> = {
  name: "ai",
  logPrefix: "AiJob",
  exchange: AI_EXCHANGES.MAIN,
  deadLetterExchange: AI_EXCHANGES.DEAD_LETTER,
  kinds: AI_JOB_KINDS,
  queues: AI_QUEUES,
  failedQueues: AI_FAILED_QUEUES,
  routingKeys: AI_ROUTING_KEYS,
  messageTtlMs: AI_MESSAGE_TTL_MS,
};

export const EMAIL_FAMILY: QueueFamily<EmailQueueKind> = {
  name: "email",
  logPrefix: "EmailJob",
  exchange: EMAIL_EXCHANGES.MAIN,
  deadLetterExchange: EMAIL_EXCHANGES.DEAD_LETTER,
  kinds: EMAIL_QUEUE_KINDS,
  queues: EMAIL_QUEUES,
  failedQueues: EMAIL_FAILED_QUEUES,
  routingKeys: EMAIL_ROUTING_KEYS,
  messageTtlMs: EMAIL_MESSAGE_TTL_MS,
};

/**
 * What travels on `email.send`.
 *
 * **`url` is a live credential.** It contains the single-use token that sets an
 * account's password, and it is here rather than in `email_jobs` on purpose:
 * the token cannot be recovered from the row (only its sha256 is stored), so
 * something has to carry it from the request that issued it to the consumer
 * that renders it. A transient message bounded by `EMAIL_MESSAGE_TTL_MS` is a
 * far better place for that than a jsonb column nobody sweeps.
 *
 * The consequence, stated plainly: a dead-lettered email job **cannot be
 * replayed from its database row**. Recovery is re-issuing — the "Re-send
 * invitation" path — which mints a fresh token and supersedes the old one.
 * That is the correct behaviour anyway.
 */
export interface EmailJobMessage extends QueueEnvelope<EmailQueueKind> {
  kind: "send";
  template: EmailTemplateName;
  to: string;
  /** Non-secret render context. Mirrors what `email_jobs.payload` persists. */
  vars: Record<string, unknown>;
  /** The token-bearing link. Never persisted. Absent for templates without one. */
  url?: string;
  /** 1-based. Carried on the message so a retry decision never needs a read. */
  attempt: number;
}

/**
 * Template names, duplicated from the `email_template` pgEnum.
 *
 * Declared here rather than imported from `src/schema` because this file is the
 * wire contract and must not drag the schema (and therefore drizzle, and
 * therefore a database connection) into anything that only wants to publish.
 * `src/schema/enums.schema.ts` asserts the two agree.
 */
export const EMAIL_TEMPLATE_NAMES = ["invitation", "password_reset"] as const;

export type EmailTemplateName = (typeof EMAIL_TEMPLATE_NAMES)[number];

export type EmailJobHandler = (message: EmailJobMessage) => Promise<void>;

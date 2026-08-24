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

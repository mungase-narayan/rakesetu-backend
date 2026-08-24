/**
 * ai-job module type contracts.
 *
 * The point of this file is that `type` and `payload` cannot disagree. A job
 * row typed `extraction` carrying an explanation payload would publish onto the
 * `ai.extraction` routing key and reach a consumer that cannot read it — a
 * routing bug with no compile-time symptom. The mapped type below makes the
 * pair a discriminated union, so that combination does not typecheck.
 */
import type { AiJobKind, AiJobPayload } from "../../../types/queue.types";
import type { AiJob } from "../../../schema";

/** Fields the service fills in itself; a caller never supplies them. */
type AiJobBaseKeys =
  "jobId" | "orgId" | "correlationId" | "requestedBy" | "timestamp" | "kind";

/** The kind-specific half of a payload — what the caller actually knows. */
export type AiJobDetails<K extends AiJobKind = AiJobKind> = Omit<
  Extract<AiJobPayload, { kind: K }>,
  AiJobBaseKeys
>;

export type CreateAiJobInput = {
  [K in AiJobKind]: {
    orgId: string;
    type: K;
    /** Must match `type` — that pairing is the whole reason for this type. */
    payload: AiJobDetails<K>;
    /** What the job is about, for the review queues: `allotment`, `charge`, … */
    subjectType?: string | null;
    subjectId?: string | null;
    /** Null for scheduled or simulator-triggered work. */
    requestedBy?: string | null;
    /** Defaults to the ambient request context's correlation id. */
    correlationId?: string | null;
  };
}[AiJobKind];

/** The result fields a consumer writes back when a job reaches a terminal state. */
export interface MarkJobPatch {
  output?: unknown;
  error?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  tokensIn?: number;
  tokensOut?: number;
  /** A decimal string, not a number — `numeric` columns are not floats. */
  costUsd?: string;
  latencyMs?: number;
}

export type { AiJob };

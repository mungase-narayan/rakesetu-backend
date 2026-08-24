/**
 * The `ai_jobs` producer — and, for now, a placeholder consumer.
 *
 * DESIGN.md §3 makes the backend the **producer**: it inserts an `ai_jobs` row,
 * publishes the id, and rakesetu-ai-ml does the model work and writes the
 * result back against that row. This file was originally written the other way
 * round; see DECISIONS.md D3 for why the inversion was fixed here rather than
 * at Phase 11.
 *
 * `enqueue()` is the only method callers should reach for. It exists as one
 * call precisely because "insert the row" and "publish the id" must not be two
 * things a caller can do independently — publishing an id with no row behind it
 * gives the consumer nothing to write to.
 *
 * The row is inserted **before** the publish. If the publish then fails, a
 * `queued` row is left with no message: visible, replayable, and diagnosable.
 * The reverse order loses the job entirely.
 */
import { eq, sql } from "drizzle-orm";
import { Logger } from "winston";

import { db, type DB } from "../../../database/connection";
import { aiJobs, type AiJob } from "../../../schema";
import RabbitMQService from "../../../utils/rabbitmq";
import { getRequestContext } from "../../../logger/request-context";
import { type AiJobKind, type AiJobPayload } from "../../../types/queue.types";
import type { CreateAiJobInput, MarkJobPatch } from "../types/ai-job.types";

class AiJobService {
  constructor(
    private readonly logger: Logger,
    private broker?: RabbitMQService,
    private readonly database: DB = db,
  ) {}

  /**
   * Late binding for the broker. App constructs this service first — it is the
   * broker's own `fallbackHandler` — so the two cannot be wired in one step
   * without one of them holding a half-built reference to the other.
   */
  setRabbitMQService(service: RabbitMQService): void {
    this.broker = service;
  }

  private requireBroker(): RabbitMQService {
    const broker = this.broker;
    if (!broker) {
      throw new Error(
        "AiJobService has no RabbitMQService — call setRabbitMQService() during startup",
      );
    }
    return broker;
  }

  /** Inserts the row. Status starts at `queued`; nothing is published yet. */
  async createJob(input: CreateAiJobInput): Promise<AiJob> {
    const [job] = await this.database
      .insert(aiJobs)
      .values({
        orgId: input.orgId,
        type: input.type,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        requestedBy: input.requestedBy ?? null,
        correlationId:
          input.correlationId ?? getRequestContext()?.correlationId ?? null,
        // The payload as published, so a replay after a prompt change does not
        // need the original caller to still exist.
        input: input.payload as Record<string, unknown>,
      })
      .returning();

    return job;
  }

  /** Publishes an already-inserted job. Separated for replay of a stuck row. */
  async publish(job: AiJob): Promise<void> {
    const payload = {
      ...(job.input as Record<string, unknown>),
      kind: job.type as AiJobKind,
      jobId: job.id,
      orgId: job.orgId,
      correlationId: job.correlationId ?? job.id,
      requestedBy: job.requestedBy ?? "system",
      timestamp: job.createdAt,
    } as AiJobPayload;

    await this.requireBroker().publishAiJob(payload);
  }

  /**
   * Row + publish. The only method feature code should call.
   *
   * A publish failure marks the row `failed` rather than leaving it `queued`
   * forever: `queued` means "waiting for a consumer", and a job no consumer
   * will ever see is not waiting, it is broken.
   */
  async enqueue(input: CreateAiJobInput): Promise<AiJob> {
    const job = await this.createJob(input);

    try {
      await this.publish(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markFailed(job.id, { error: message });
      this.logger.error(
        `AI_JOB_PUBLISH_FAILED jobId=${job.id} type=${job.type} — ${message}`,
      );
      throw error;
    }

    this.logger.info(
      `AI_JOB_ENQUEUED jobId=${job.id} type=${job.type} orgId=${job.orgId}`,
    );
    return job;
  }

  async markRunning(jobId: string): Promise<void> {
    await this.patch(jobId, { status: "running" }, { bumpAttempts: true });
  }

  async markSucceeded(jobId: string, patch: MarkJobPatch = {}): Promise<void> {
    await this.patch(jobId, { ...patch, status: "succeeded" });
  }

  async markFailed(jobId: string, patch: MarkJobPatch = {}): Promise<void> {
    await this.patch(jobId, { ...patch, status: "failed" });
  }

  /**
   * Low confidence routed to a person (§9.3). A terminal state, and explicitly
   * not a failure — the pipeline did its job by declining to guess.
   */
  async markNeedsHuman(jobId: string, patch: MarkJobPatch = {}): Promise<void> {
    await this.patch(jobId, { ...patch, status: "needs_human" });
  }

  private async patch(
    jobId: string,
    values: MarkJobPatch & { status: AiJob["status"] },
    options: { bumpAttempts?: boolean } = {},
  ): Promise<void> {
    const { output, error, ...rest } = values;

    await this.database
      .update(aiJobs)
      .set({
        ...rest,
        ...(output !== undefined
          ? { output: output as Record<string, unknown> }
          : {}),
        ...(error !== undefined ? { error } : {}),
        ...(options.bumpAttempts
          ? // Incremented in SQL, not read-modify-write: two consumers retrying
            // the same job must not both read 1 and both write 2.
            { attempts: sql`${aiJobs.attempts} + 1` }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiJobs.id, jobId));
  }

  /**
   * Placeholder consumer. Kept alive behind RABBITMQ_CONSUME_AI_JOBS=true so
   * the round trip is observable end to end before any model exists — a queue
   * nothing drains proves only that publishing did not throw.
   *
   * It now closes the loop by marking the row `succeeded`, which is what makes
   * `npm run queue:check` a real assertion about the database.
   */
  async handleJob(payload: AiJobPayload): Promise<void> {
    this.logger.info(
      `AI_JOB_NO_PROCESSOR kind=${payload.kind} jobId=${payload.jobId} ` +
        `orgId=${payload.orgId} correlationId=${payload.correlationId} ` +
        `detail=${this.describe(payload)}`,
    );

    // queue-check publishes synthetic jobs whose ids are not rows. Updating a
    // missing id is a harmless no-op, so this needs no existence check.
    await this.markSucceeded(payload.jobId, {
      output: {
        note: "no processor",
        acceptedBy: "placeholder-consumer",
      },
    }).catch((error: unknown) => {
      // The message has been handled either way; a DB failure here must not
      // nack it into the dead-letter queue.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `AI_JOB_STATUS_UPDATE_FAILED ${payload.jobId}: ${message}`,
      );
    });
  }

  /** One line per kind, so the log says what the job was actually about. */
  private describe(payload: AiJobPayload): string {
    switch (payload.kind) {
      case "extraction":
        return `source=${payload.source} chars=${payload.text.length}`;
      case "explanation":
        return `subject=${payload.subject} subjectId=${payload.subjectId}`;
      case "ingest":
        return `title=${payload.title} url=${payload.documentUrl}`;
    }
  }
}

export default AiJobService;

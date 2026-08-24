/**
 * The ai_jobs publisher (DECISIONS.md D3).
 *
 * Runs with USE_RABBITMQ_SERVICE=false, so publishing goes through the
 * fallback handler inline. That is not a stub — it is the supported serverless
 * mode, and it means these tests exercise `enqueue` → publish → handler →
 * status transition end to end without a broker.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import logger from "../../logger/winston.logger";
import { db } from "../../database/connection";
import { aiJobs, type Organization } from "../../schema";
import RabbitMQService from "../../utils/rabbitmq";
import AiJobService from "../../modules/ai-job/services/ai-job.service";
import { AI_JOB_KINDS } from "../../types/queue.types";
import { AI_JOB_TYPES } from "../../schema";
import { organizationByCode } from "../factories/tenant.factory";

describe("ai job publisher", () => {
  let cr: Organization;
  let service: AiJobService;

  beforeAll(async () => {
    cr = await organizationByCode("CR");

    service = new AiJobService(logger);
    const broker = new RabbitMQService("amqp://unused", {
      enabled: false,
      fallbackHandler: (payload) => service.handleJob(payload),
    });
    service.setRabbitMQService(broker);
  });

  it("keeps the ai_job_type enum identical to the queue's job kinds", () => {
    // A mismatch here is a silent routing bug: a row typed with a value no
    // queue is bound to. Deriving one from the other makes it a compile error;
    // this asserts the derivation actually happened.
    expect([...AI_JOB_TYPES]).toEqual([...AI_JOB_KINDS]);
  });

  it("inserts a queued row and reaches succeeded through the handler", async () => {
    const job = await service.enqueue({
      orgId: cr.id,
      type: "explanation",
      subjectType: "allotment",
      subjectId: "test-allotment",
      payload: {
        subject: "allotment",
        subjectId: "test-allotment",
        facts: { detentionHours: 4.75 },
      },
    });

    const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));

    expect(row.orgId).toBe(cr.id);
    expect(row.type).toBe("explanation");
    // The placeholder consumer ran inline and closed the loop.
    expect(row.status).toBe("succeeded");
    expect(row.output).toMatchObject({ note: "no processor" });
  });

  it("stores the published payload for replay", async () => {
    const job = await service.enqueue({
      orgId: cr.id,
      type: "extraction",
      payload: {
        source: "siding_log",
        text: "RAKE 12345 placed 14:20, released 19:05",
      },
    });

    const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));

    // Kept so a job can be re-run after a prompt change without the original
    // caller still existing.
    expect(row.input).toMatchObject({ source: "siding_log" });
  });

  it("marks the row failed when the publish throws", async () => {
    const failing = new AiJobService(logger);
    // Enabled but never connected: publishAiJob will throw on the missing
    // channel, which is exactly what a broker outage looks like.
    failing.setRabbitMQService(
      new RabbitMQService("amqp://unused", { enabled: true }),
    );

    await expect(
      failing.enqueue({
        orgId: cr.id,
        type: "ingest",
        payload: {
          documentUrl: "s3://rakesetu/circulars/x.pdf",
          title: "Broken publish",
        },
      }),
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(aiJobs)
      .where(eq(aiJobs.status, "failed"));

    // A row that no consumer will ever see is not "queued" — it is broken, and
    // leaving it queued would hide it from every operational query.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.error)).toBe(true);
  });

  it("moves through the status transitions", async () => {
    const job = await service.createJob({
      orgId: cr.id,
      type: "extraction",
      payload: { source: "email_indent", text: "please arrange 42 BOXN" },
    });

    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);

    await service.markRunning(job.id);
    let [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    expect(row.status).toBe("running");
    // Incremented in SQL, so two consumers retrying cannot both write 1.
    expect(row.attempts).toBe(1);

    await service.markNeedsHuman(job.id, { output: { confidence: 0.4 } });
    [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    // A terminal state, and explicitly not a failure — the pipeline did its
    // job by declining to guess.
    expect(row.status).toBe("needs_human");
  });

  it("records cost as an exact decimal, not a float", async () => {
    const job = await service.createJob({
      orgId: cr.id,
      type: "explanation",
      payload: { subject: "charge", subjectId: "c-1", facts: {} },
    });

    await service.markSucceeded(job.id, {
      costUsd: "0.001234",
      tokensIn: 1200,
      tokensOut: 340,
      model: "claude-opus-5",
    });

    const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));

    // numeric round-trips as a string. It is money; a float would round it.
    expect(row.costUsd).toBe("0.001234");
    expect(row.tokensIn).toBe(1200);
  });
});

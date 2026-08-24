/**
 * RabbitMQ round-trip check.
 *
 * Publishes one job of every kind through the real producer path and proves
 * three things in one command:
 *
 *   1. the broker is reachable and the `ai.*` topology is bound correctly;
 *   2. `AiJobService.enqueue` writes an `ai_jobs` row and publishes its id;
 *   3. the placeholder consumer closes the loop, leaving the rows `succeeded`.
 *
 * It then does the same for the **email** family, which is the only automated
 * check that `email.exchange`, `email.send` and their dead-letter side were
 * actually asserted against a real broker — the test suite runs with the broker
 * disabled, so it exercises the handler but never the topology.
 *
 *   npm run queue:check
 *
 * The third point is what makes this an assertion about the *database* and not
 * only about the broker. Before Phase 1 this script published synthetic ids
 * that corresponded to no row, so a successful run said nothing about whether
 * a result could ever be written back.
 *
 * It listens on its own exclusive, auto-deleted queue bound to the same routing
 * keys, so it receives a *copy* of each message rather than competing with a
 * running `npm run dev` for the real ones. That means it gives the same answer
 * whether or not the API is up.
 */
/* eslint-disable no-console */
import amqp from "amqplib";
import { inArray } from "drizzle-orm";

import env from "../src/config/env.config";
import logger from "../src/logger/winston.logger";
import RabbitMQService from "../src/utils/rabbitmq";
import { db, disconnectDatabase } from "../src/database/connection";
import { aiJobs, emailJobs, organizations } from "../src/schema";
import AiJobService from "../src/modules/ai-job/services/ai-job.service";
import type { CreateAiJobInput } from "../src/modules/ai-job/types/ai-job.types";
import { emailJobService } from "../src/modules/email/email.provider";
import {
  AI_EXCHANGES,
  AI_JOB_KINDS,
  AI_ROUTING_KEYS,
  EMAIL_QUEUES,
  type AiJobKind,
  type AiJobPayload,
} from "../src/types/queue.types";

const TIMEOUT_MS = 10_000;

const buildInput = (kind: AiJobKind, orgId: string): CreateAiJobInput => {
  switch (kind) {
    case "extraction":
      return {
        orgId,
        type: "extraction",
        subjectType: "siding_log",
        subjectId: "queue-check",
        payload: {
          source: "siding_log",
          text: "RAKE 12345 placed 14:20, released 19:05, 42 BOXN",
        },
      };
    case "explanation":
      return {
        orgId,
        type: "explanation",
        subjectType: "detention",
        subjectId: "queue-check",
        payload: {
          subject: "detention",
          subjectId: "queue-check",
          facts: { detentionHours: 4.75, freeTimeHours: 5 },
        },
      };
    case "ingest":
      return {
        orgId,
        type: "ingest",
        subjectType: "circular",
        subjectId: "queue-check",
        payload: {
          documentUrl: "s3://rakesetu/circulars/queue-check.pdf",
          title: "Queue check circular",
        },
      };
  }
};

async function main() {
  if (!env.rabbitmq.enabled) {
    console.error(
      "USE_RABBITMQ_SERVICE is false — nothing to check. Set it to true and retry.",
    );
    process.exit(1);
  }

  // A real tenant, because ai_jobs.org_id is a foreign key. Any seeded org will
  // do; the first one keeps this independent of which tenants exist.
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) {
    console.error("No organizations found — run `npm run db:seed` first.");
    process.exit(1);
  }

  console.log(`Connecting to ${env.rabbitmq.url.replace(/:[^:@]*@/, ":***@")}`);
  console.log(`Publishing as organization ${org.code}\n`);

  const service = new RabbitMQService(env.rabbitmq.url);
  await service.connect();

  const aiJobService = new AiJobService(logger, service);

  const probeConnection = await amqp.connect(env.rabbitmq.url);
  const probeChannel = await probeConnection.createChannel();
  const probe = await probeChannel.assertQueue("", {
    exclusive: true,
    autoDelete: true,
  });

  for (const kind of AI_JOB_KINDS) {
    await probeChannel.bindQueue(
      probe.queue,
      AI_EXCHANGES.MAIN,
      AI_ROUTING_KEYS[kind],
    );
  }

  const expected = new Set<string>();
  const received = new Set<string>();

  const allReceived = new Promise<void>((resolve) => {
    void probeChannel.consume(
      probe.queue,
      (msg) => {
        if (!msg) return;
        const payload = JSON.parse(msg.content.toString()) as AiJobPayload;
        probeChannel.ack(msg);

        // Other publishers may share the exchange; only count our own jobs.
        if (!expected.has(payload.jobId)) return;

        void (async () => {
          // Closing the loop from here rather than relying on a running API:
          // the check must give the same answer with or without `npm run dev`.
          await aiJobService.handleJob(payload);
          received.add(payload.jobId);
          console.log(`  ← ${payload.kind.padEnd(11)} ${payload.jobId}`);
          if (received.size === expected.size) resolve();
        })();
      },
      { noAck: false },
    );
  });

  for (const kind of AI_JOB_KINDS) {
    const job = await aiJobService.enqueue(buildInput(kind, org.id));
    expected.add(job.id);
    console.log(`  → ${kind.padEnd(11)} ${job.id}`);
  }

  const timedOut = await Promise.race([
    allReceived.then(() => false),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), TIMEOUT_MS),
    ),
  ]);

  await probeChannel.close();
  await probeConnection.close();
  await service.close();

  if (timedOut) {
    const missing = [...expected].filter((jobId) => !received.has(jobId));
    console.error(
      `\nFAILED — no round trip within ${TIMEOUT_MS / 1000}s for: ${missing.join(", ")}`,
    );
    await disconnectDatabase();
    process.exit(1);
  }

  // The assertion that matters: the rows, not just the messages.
  const rows = await db
    .select({ id: aiJobs.id, type: aiJobs.type, status: aiJobs.status })
    .from(aiJobs)
    .where(inArray(aiJobs.id, [...expected]));

  const succeeded = rows.filter((r) => r.status === "succeeded");

  console.log("");
  for (const row of rows) {
    console.log(`  ai_jobs  ${row.type.padEnd(11)} ${row.status}`);
  }

  if (succeeded.length !== AI_JOB_KINDS.length) {
    console.error(
      `\nFAILED — ${succeeded.length}/${AI_JOB_KINDS.length} ai_jobs rows reached "succeeded".`,
    );
    await disconnectDatabase();
    process.exit(1);
  }

  /* -------------------------------------------------------------- email -- */

  // A second, independent round trip. Unlike the AI half this does not run its
  // own consumer: the API process is the only consumer of `email.send`, so what
  // is proved here is that the topology exists and a publish is accepted. The
  // row reaching `sent` needs `npm run dev` up, and the script says which of
  // the two it observed rather than pretending.
  console.log("\n  publishing one email job…");

  const emailBroker = new RabbitMQService(env.rabbitmq.url);
  await emailBroker.connect();
  emailJobService.setRabbitMQService(emailBroker);

  const emailJob = await emailJobService.enqueue({
    orgId: org.id,
    template: "invitation",
    to: "queue-check@rakesetu.invalid",
    vars: {
      firstName: "Queue",
      organizationName: org.name,
      invitedBy: null,
      ttlHours: 1,
    },
    secrets: { url: `${env.frontendUrl}/auth/invitation/queue-check-probe` },
  });

  // Give a running consumer a moment to pick it up.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await emailBroker.close();

  const [emailRow] = await db
    .select()
    .from(emailJobs)
    .where(inArray(emailJobs.id, [emailJob.id]));

  console.log(
    `  ${EMAIL_QUEUES.send.padEnd(19)} ${emailRow.status}` +
      (emailRow.lastError ? `  (${emailRow.lastError})` : ""),
  );

  await disconnectDatabase();

  if (emailRow.status === "queued") {
    console.error(
      "\nFAILED — the email job was published but nothing consumed it. " +
        "Is `npm run dev` running with RABBITMQ_CONSUME_EMAIL_JOBS=true?",
    );
    process.exit(1);
  }

  console.log(
    `\nOK — ${received.size}/${expected.size} ai jobs round-tripped, ` +
      `${succeeded.length} ai_jobs rows "succeeded", ` +
      `and the email family accepted a job (status "${emailRow.status}").`,
  );
  process.exit(0);
}

main().catch(async (error) => {
  console.error("Queue check failed:", error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});

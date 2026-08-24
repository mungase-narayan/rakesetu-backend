/**
 * The transactional-email outbox: producer, consumer and retry policy.
 *
 * Modelled on `AiJobService` deliberately — row before publish, status writers
 * that bump `attempts` in SQL, a `handleJob` that doubles as the inline fallback
 * when the broker is disabled. Two things differ, and both are on purpose.
 *
 * **`enqueue` never throws**, where `AiJobService.enqueue` rethrows. An AI job's
 * caller can be told "we could not queue that". `POST /users` cannot: the
 * account row already exists, so a 500 would report failure for something that
 * half-succeeded, and the admin would click again and create a duplicate. The
 * row is marked `failed`, logged loudly, and the response says the invitation
 * could not be queued.
 *
 * **Retries live here, not in the broker.** `consumeFrom` has exactly one nack
 * policy — straight to the dead-letter queue — because deciding to retry needs
 * to know whether the failure was transient, and only this handler knows that.
 * Attempts are bounded per template (`EMAIL_MAX_ATTEMPTS`) with a short
 * backoff; when they run out the row is marked `failed` and the message is
 * nacked so an operator can find it in `email.send.failed`.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "winston";

import env from "../../../config/env.config";
import { db, type DB } from "../../../database/connection";
import { emailJobs, type EmailJob } from "../../../schema";
import { getRequestContext } from "../../../logger/request-context";
import type RabbitMQService from "../../../utils/rabbitmq";
import type {
  EmailJobMessage,
  EmailTemplateName,
} from "../../../types/queue.types";
import MailService from "../../mail/services/mail.service";
import { renderEmail } from "../../mail/templates";
import {
  EMAIL_MAX_ATTEMPTS,
  type EnqueueEmailInput,
} from "../types/email-job.types";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

class EmailJobService {
  private broker?: RabbitMQService;

  constructor(
    private readonly logger: Logger,
    private readonly mailService: MailService,
    private readonly database: DB = db,
  ) {}

  /**
   * Late-bound, exactly as `AiJobService`'s is: `App` builds the broker with
   * this service's `handleJob` as the email fallback, so the second edge has to
   * be wired after both objects exist.
   */
  setRabbitMQService(service: RabbitMQService): void {
    this.broker = service;
  }

  /* ------------------------------------------------------------ produce -- */

  /**
   * Writes the row, then publishes. Never throws — see the note at the top.
   *
   * Returns the row so the caller can put its id in an audit entry: that id is
   * the thread from "the admin clicked" to "SMTP accepted it", and it is the
   * only delivery evidence the HTTP response can honestly offer.
   */
  async enqueue<T extends EmailTemplateName>(
    input: EnqueueEmailInput<T>,
  ): Promise<EmailJob> {
    const job = await this.createJob(input);

    try {
      await this.publish(job, input.secrets.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markFailed(job.id, message);
      this.logger.error(
        `EMAIL_JOB_ENQUEUE_FAILED jobId=${job.id} template=${job.template} — ${message}`,
      );
      return { ...job, status: "failed", lastError: message };
    }

    this.logger.info(
      `EMAIL_JOB_ENQUEUED jobId=${job.id} template=${job.template} to=${job.toEmail}`,
    );
    return job;
  }

  /**
   * The insert. Takes `input.vars` and has **no reference to `input.secrets`**
   * in scope — that is what makes "the token is never persisted" a property of
   * the code rather than of somebody's diligence.
   */
  private async createJob<T extends EmailTemplateName>(
    input: EnqueueEmailInput<T>,
  ): Promise<EmailJob> {
    const [row] = await this.database
      .insert(emailJobs)
      .values({
        orgId: input.orgId,
        userId: input.userId ?? null,
        template: input.template,
        toEmail: input.to.trim().toLowerCase(),
        payload: input.vars,
        hasSecret: true,
        maxAttempts: EMAIL_MAX_ATTEMPTS[input.template],
        requestedBy: input.requestedBy ?? null,
        correlationId:
          input.correlationId ?? getRequestContext()?.correlationId ?? null,
      })
      .returning();

    return row;
  }

  private async publish(job: EmailJob, url: string): Promise<void> {
    const message: EmailJobMessage = {
      kind: "send",
      jobId: job.id,
      orgId: job.orgId,
      correlationId: job.correlationId ?? job.id,
      template: job.template,
      to: job.toEmail,
      vars: job.payload as Record<string, unknown>,
      url,
      attempt: 1,
    };

    await this.requireBroker().publishEmailJob(message);
  }

  /* ------------------------------------------------------------ consume -- */

  /**
   * Renders and sends one message. The consumer *and* the inline fallback.
   *
   * Returning normally acks the message; throwing nacks it into
   * `email.send.failed`. So a retry that has been re-published returns, and a
   * terminal failure throws.
   */
  async handleJob(message: EmailJobMessage): Promise<void> {
    const claimed = await this.markSending(message.jobId);

    if (!claimed) {
      // Already `sent`, or the row is gone. At-least-once delivery means this
      // is expected, not exceptional — ack and move on.
      this.logger.info(
        `EMAIL_JOB_ALREADY_HANDLED jobId=${message.jobId} attempt=${message.attempt}`,
      );
      return;
    }

    const maxAttempts = EMAIL_MAX_ATTEMPTS[message.template] ?? 3;

    let rendered;
    try {
      rendered = renderEmail(
        message.template,
        message.to,
        message.vars,
        message.url,
      );
    } catch (error) {
      // A render failure is permanent by construction: the same inputs will
      // fail identically forever. Do not spend retries on it.
      const reason = error instanceof Error ? error.message : String(error);
      await this.markFailed(message.jobId, `render failed: ${reason}`);
      throw error;
    }

    const outcome = await this.mailService.send(rendered);

    if (outcome.delivered) {
      await this.markSent(message.jobId, rendered.subject, outcome.messageId);
      return;
    }

    const exhausted = message.attempt >= maxAttempts;

    if (!outcome.retryable || exhausted) {
      await this.markFailed(message.jobId, outcome.error);
      this.logger.error(
        `EMAIL_JOB_FAILED jobId=${message.jobId} template=${message.template} ` +
          `to=${message.to} attempt=${message.attempt}/${maxAttempts} ` +
          `retryable=${outcome.retryable} — ${outcome.error}`,
      );
      // Throw so the message dead-letters and an operator can find it.
      throw new Error(outcome.error);
    }

    // Transient, with attempts left. Back off briefly and try again in-process.
    // Short by design: this is for a blip or a greylist, not an outage — an
    // outage exhausts the budget in seconds and lands in the DLQ where it
    // belongs, rather than holding a consumer slot for half an hour.
    const delay = env.mail.retryBaseMs * message.attempt;
    this.logger.warn(
      `EMAIL_JOB_RETRY jobId=${message.jobId} attempt=${message.attempt}/${maxAttempts} ` +
        `in=${delay}ms — ${outcome.error}`,
    );
    await this.markRetrying(message.jobId, outcome.error);
    await sleep(delay);

    return this.handleJob({ ...message, attempt: message.attempt + 1 });
  }

  /* ------------------------------------------------------------- status -- */

  /**
   * Claims the job, or reports that somebody already did.
   *
   * The `inArray` guard is the same compare-and-set trick
   * `UserTokenService.consume()` uses: at-least-once delivery means this handler
   * can run twice for one message, and one send is better than two. A duplicate
   * that slips through the window is benign — it carries the *same* token,
   * because the token is on the message rather than re-issued.
   */
  private async markSending(id: string): Promise<boolean> {
    const rows = await this.database
      .update(emailJobs)
      .set({
        status: "sending",
        attempts: sql`${emailJobs.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailJobs.id, id),
          inArray(emailJobs.status, ["queued", "sending"]),
        ),
      )
      .returning({ id: emailJobs.id });

    return rows.length > 0;
  }

  private async markSent(
    id: string,
    subject: string,
    providerMessageId: string,
  ): Promise<void> {
    await this.database
      .update(emailJobs)
      .set({
        status: "sent",
        subject: subject.slice(0, 255),
        providerMessageId: providerMessageId.slice(0, 255),
        sentAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(emailJobs.id, id));
  }

  private async markFailed(id: string, error: string): Promise<void> {
    await this.database
      .update(emailJobs)
      .set({ status: "failed", lastError: error, updatedAt: new Date() })
      .where(eq(emailJobs.id, id));
  }

  /** Back to `queued`, so the next attempt's `markSending` can claim it. */
  private async markRetrying(id: string, error: string): Promise<void> {
    await this.database
      .update(emailJobs)
      .set({ status: "queued", lastError: error, updatedAt: new Date() })
      .where(eq(emailJobs.id, id));
  }

  /* --------------------------------------------------------------- read -- */

  /** The most recent job per user, for the admin users list. Batched. */
  async latestForUsers(
    orgId: string,
    userIds: string[],
  ): Promise<Map<string, EmailJob>> {
    const byUser = new Map<string, EmailJob>();
    if (userIds.length === 0) return byUser;

    const rows = await this.database
      .select()
      .from(emailJobs)
      .where(
        and(eq(emailJobs.orgId, orgId), inArray(emailJobs.userId, userIds)),
      )
      .orderBy(emailJobs.createdAt);

    // Ascending, so the last write per user wins — the most recent job.
    for (const row of rows) {
      if (row.userId) byUser.set(row.userId, row);
    }

    return byUser;
  }

  private requireBroker(): RabbitMQService {
    if (!this.broker) {
      throw new Error(
        "EmailJobService has no broker — call setRabbitMQService() first",
      );
    }
    return this.broker;
  }
}

export default EmailJobService;

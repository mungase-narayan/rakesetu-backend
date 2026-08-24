/**
 * The email outbox: producer, consumer, retry policy.
 *
 * Runs with `USE_RABBITMQ_SERVICE=false`, so publishing goes through the inline
 * fallback and `enqueue → publish → handleJob → send` happens synchronously.
 * That is not a stub — it is the supported serverless mode, the same one
 * `ai-job.test.ts` relies on, and it means these tests exercise the real
 * producer *and* the real consumer with no broker.
 *
 * The transport is a stub so failures can be chosen; everything else is real.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import logger from "../../logger/winston.logger";
import { db } from "../../database/connection";
import { emailJobs, type Organization } from "../../schema";
import RabbitMQService from "../../utils/rabbitmq";
import EmailJobService from "../../modules/email/services/email-job.service";
import type MailService from "../../modules/mail/services/mail.service";
import type {
  MailMessage,
  MailOutcome,
} from "../../modules/mail/services/mail.service";
import { organizationByCode, userByEmail } from "../factories/tenant.factory";

/** A transport whose outcome each test chooses. */
class StubMail {
  sent: MailMessage[] = [];
  enabled = true;
  private outcomes: MailOutcome[] = [];

  /** Queue one outcome per call; the last one repeats once they run out. */
  willReturn(...outcomes: MailOutcome[]) {
    this.outcomes = outcomes;
  }

  async send(message: MailMessage): Promise<MailOutcome> {
    this.sent.push(message);
    const next =
      this.outcomes.length > 1 ? this.outcomes.shift() : this.outcomes[0];
    return next ?? { delivered: true, via: "smtp", messageId: "stub-1" };
  }
}

const build = (mail: StubMail) => {
  const service = new EmailJobService(logger, mail as unknown as MailService);
  const broker = new RabbitMQService("amqp://unused", {
    enabled: false,
    fallbackHandlers: { email: (message) => service.handleJob(message) },
  });
  service.setRabbitMQService(broker);
  return service;
};

const invitationInput = (orgId: string, to: string) => ({
  orgId,
  template: "invitation" as const,
  to,
  vars: {
    firstName: "Probe",
    organizationName: "Central Railway",
    invitedBy: null,
    ttlHours: 168,
  },
  secrets: { url: "http://localhost:5175/auth/invitation/SECRET-TOKEN-VALUE" },
});

const rowFor = async (id: string) => {
  const [row] = await db.select().from(emailJobs).where(eq(emailJobs.id, id));
  return row;
};

describe("email jobs", () => {
  let cr: Organization;
  let counter = 0;
  const to = () => `email.job.${Date.now()}.${counter++}@cr.rakesetu.dev`;

  beforeAll(async () => {
    cr = await organizationByCode("CR");
  });

  describe("producing", () => {
    it("writes the row and sends it, ending sent", async () => {
      const mail = new StubMail();
      const service = build(mail);

      const job = await service.enqueue(invitationInput(cr.id, to()));
      const row = await rowFor(job.id);

      expect(row.status).toBe("sent");
      expect(row.attempts).toBe(1);
      expect(row.sentAt).not.toBeNull();
      expect(row.providerMessageId).toBe("stub-1");
      expect(row.subject).toBeTruthy();
    });

    it("renders a real email carrying the link", async () => {
      const mail = new StubMail();
      const service = build(mail);
      const address = to();

      await service.enqueue(invitationInput(cr.id, address));

      expect(mail.sent).toHaveLength(1);
      // The recipient's copy has the link in the body as text as well as behind
      // the button — which is exactly why the body must never be persisted.
      expect(mail.sent[0].text).toContain("SECRET-TOKEN-VALUE");
      expect(mail.sent[0].to).toBe(address);
    });

    it("never persists the token or the link", async () => {
      const mail = new StubMail();
      const service = build(mail);

      const job = await service.enqueue(invitationInput(cr.id, to()));
      const row = await rowFor(job.id);

      // The whole row, not just payload: this is what catches a future `html`
      // column added "for debugging", which would carry the link.
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("SECRET-TOKEN-VALUE");
      expect(serialized).not.toContain("/auth/invitation");
      expect(row.hasSecret).toBe(true);
    });

    it("stamps the per-template attempt budget onto the row", async () => {
      const mail = new StubMail();
      const service = build(mail);

      const invite = await service.enqueue(invitationInput(cr.id, to()));
      const reset = await service.enqueue({
        orgId: cr.id,
        template: "password_reset",
        to: to(),
        vars: { firstName: "Probe", ttlHours: 1 },
        secrets: { url: "http://localhost:5175/auth/reset-password/X" },
      });

      // A reset link lives an hour; spending an invitation's retry budget on it
      // would deliver mail whose link is nearly dead.
      expect((await rowFor(invite.id)).maxAttempts).toBe(3);
      expect((await rowFor(reset.id)).maxAttempts).toBe(2);
    });

    it("never throws — a created account must not be reported as a 500", async () => {
      const mail = new StubMail();
      const service = new EmailJobService(
        logger,
        mail as unknown as MailService,
      );
      // No broker bound at all: publish cannot possibly work.
      const job = await service.enqueue(invitationInput(cr.id, to()));

      expect(job.status).toBe("failed");
      expect((await rowFor(job.id)).lastError).toMatch(/broker/i);
    });
  });

  describe("retrying", () => {
    it("retries a transient failure and succeeds", async () => {
      const mail = new StubMail();
      mail.willReturn(
        {
          delivered: false,
          via: "smtp",
          error: "ECONNREFUSED",
          retryable: true,
        },
        { delivered: true, via: "smtp", messageId: "stub-2" },
      );
      const service = build(mail);

      const job = await service.enqueue(invitationInput(cr.id, to()));
      const row = await rowFor(job.id);

      expect(mail.sent).toHaveLength(2);
      expect(row.status).toBe("sent");
      expect(row.attempts).toBe(2);
    });

    it("gives up once the budget is spent", async () => {
      const mail = new StubMail();
      mail.willReturn({
        delivered: false,
        via: "smtp",
        error: "ECONNREFUSED",
        retryable: true,
      });
      const service = build(mail);

      const job = await service.enqueue(invitationInput(cr.id, to()));
      const row = await rowFor(job.id);

      // Three attempts for an invitation, then the message dead-letters.
      expect(mail.sent).toHaveLength(3);
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(3);
      expect(row.lastError).toMatch(/ECONNREFUSED/);
    });

    it("does not retry a permanent refusal", async () => {
      const mail = new StubMail();
      mail.willReturn({
        delivered: false,
        via: "smtp",
        error: "550 no such mailbox",
        retryable: false,
      });
      const service = build(mail);

      const job = await service.enqueue(invitationInput(cr.id, to()));
      const row = await rowFor(job.id);

      // A 5xx is a refusal. Sending it again produces the same refusal.
      expect(mail.sent).toHaveLength(1);
      expect(row.status).toBe("failed");
    });

    it("treats a missing transport as a failure, not a success", async () => {
      const mail = new StubMail();
      mail.enabled = false;
      mail.willReturn({
        delivered: false,
        via: "log",
        error: "no SMTP transport configured (SMTP_HOST is unset)",
        retryable: false,
      });
      const service = build(mail);

      const job = await service.enqueue(invitationInput(cr.id, to()));
      const row = await rowFor(job.id);

      // Marking this `sent` would make email_jobs lie about the one thing it
      // exists to record.
      expect(row.status).toBe("failed");
      expect(row.lastError).toMatch(/SMTP transport/);
    });
  });

  describe("at-least-once delivery", () => {
    it("sends once when the same message is handled twice", async () => {
      const mail = new StubMail();
      const service = build(mail);

      const job = await service.enqueue(invitationInput(cr.id, to()));
      expect(mail.sent).toHaveLength(1);

      // A redelivery after the ack was lost.
      await service.handleJob({
        kind: "send",
        jobId: job.id,
        orgId: cr.id,
        correlationId: job.id,
        template: "invitation",
        to: job.toEmail,
        vars: job.payload as Record<string, unknown>,
        url: "http://localhost:5175/auth/invitation/SECRET-TOKEN-VALUE",
        attempt: 1,
      });

      expect(mail.sent).toHaveLength(1);
      expect((await rowFor(job.id)).status).toBe("sent");
    });
  });

  describe("reading", () => {
    it("returns the most recent job per user, batched", async () => {
      const mail = new StubMail();
      const service = build(mail);
      const user = await userByEmail("admin@cr.rakesetu.dev");

      const older = await service.enqueue({
        ...invitationInput(cr.id, to()),
        userId: user.id,
      });
      const newer = await service.enqueue({
        ...invitationInput(cr.id, to()),
        userId: user.id,
      });

      const latest = await service.latestForUsers(cr.id, [user.id]);

      // One entry per user, and it is the newest — this backs the "Invited 2 h
      // ago" hint on the users table, which must not show a stale attempt.
      expect(latest.size).toBe(1);
      expect(latest.get(user.id)?.id).toBe(newer.id);
      expect(latest.get(user.id)?.id).not.toBe(older.id);
    });

    it("scopes to the tenant and tolerates an empty list", async () => {
      const mail = new StubMail();
      const service = build(mail);
      const acc = await organizationByCode("ACC");
      const user = await userByEmail("admin@cr.rakesetu.dev");

      await service.enqueue({
        ...invitationInput(cr.id, to()),
        userId: user.id,
      });

      // A CR job must not surface when asking as ACC.
      expect((await service.latestForUsers(acc.id, [user.id])).size).toBe(0);
      expect((await service.latestForUsers(cr.id, [])).size).toBe(0);
    });
  });
});

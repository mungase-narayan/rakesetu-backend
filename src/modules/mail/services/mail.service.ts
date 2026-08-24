/**
 * Outbound SMTP. One transport, used by the `email.send` consumer.
 *
 * **`send` never throws**, and that has not changed — but who it protects has.
 * It used to run inside the HTTP request, where a 500 would have told an admin
 * nothing happened when an account had in fact been created. It now runs in the
 * queue consumer, where the caller is `EmailJobService.handleJob`: it needs to
 * know *why* a send failed so it can decide between retrying and
 * dead-lettering, and an exception carries that badly. So the outcome is a
 * return value, and it now says whether the failure is worth retrying.
 *
 * **No `SMTP_HOST` is a misconfiguration, not a mode.** It used to be the
 * intended local path — the message was logged and the link handed to the admin
 * through the UI. `docker compose up -d mailpit` replaced that, so a missing
 * transport now produces a `failed` row saying so. Recording it as sent would
 * make `email_jobs` lie about the one thing it exists to record.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { Logger } from "winston";

import env from "../../../config/env.config";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type MailOutcome =
  | { delivered: true; via: "smtp"; messageId: string }
  /**
   * SMTP is unconfigured. The message is logged so a developer is not stuck,
   * but this is a failure — and `retryable: false`, because retrying a missing
   * configuration three times just delays the same answer.
   */
  | { delivered: false; via: "log"; error: string; retryable: false }
  | { delivered: false; via: "smtp"; error: string; retryable: boolean };

/**
 * Whether an SMTP failure is worth trying again.
 *
 * The default for anything unrecognised is **retryable**. An unknown fault
 * retried three times costs a few seconds; an invitation that silently never
 * sends costs somebody their first day.
 *
 * Only classify what came out of `sendMail`. A failure *before* it — an unknown
 * template, a missing variable, a render throw — is permanent by construction
 * and will fail identically forever.
 */
const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EDNS",
]);

export const isRetryableSmtpError = (error: unknown): boolean => {
  const err = error as { code?: string; responseCode?: number };

  // 5xx is a refusal: bad mailbox, rejected sender, message too large. Sending
  // it again produces the same refusal.
  if (typeof err.responseCode === "number") {
    return err.responseCode < 500;
  }
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;

  return true;
};

/**
 * The last few messages handed to `send`, in test runs only.
 *
 * The suite needs the invitation link, and by design it can get it nowhere
 * else: the token is not in the API response, not in `email_jobs`, and
 * `user_tokens` holds only its sha256. Capturing the rendered message is the
 * honest answer — it reads what the recipient would read, which means the
 * templates get exercised too rather than being the one untested file in the
 * flow.
 *
 * Bounded, so a long run cannot grow it without limit, and never populated
 * outside `NODE_ENV=test`.
 */
const TEST_OUTBOX_LIMIT = 50;
const testOutbox: MailMessage[] = [];

/** Every message `send` was given this run, oldest first. Empty in production. */
export const recentMailMessages = (): readonly MailMessage[] => testOutbox;

/** The most recent message to an address, or undefined. */
export const lastMailTo = (to: string): MailMessage | undefined =>
  [...testOutbox]
    .reverse()
    .find((m) => m.to.toLowerCase() === to.toLowerCase());

export const clearMailOutbox = (): void => {
  testOutbox.length = 0;
};

class MailService {
  private transporter: Transporter | null = null;

  constructor(private readonly logger: Logger) {}

  get enabled(): boolean {
    return env.mail.enabled;
  }

  /**
   * Built lazily and once. Creating it at construction would open a socket in
   * every test run and every serverless cold start that never sends anything.
   */
  private getTransporter(): Transporter {
    this.transporter ??= nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.secure,
      auth: env.mail.user
        ? { user: env.mail.user, pass: env.mail.password }
        : undefined,
    });
    return this.transporter;
  }

  async send(message: MailMessage): Promise<MailOutcome> {
    if (env.app.isTest) {
      testOutbox.push(message);
      if (testOutbox.length > TEST_OUTBOX_LIMIT) testOutbox.shift();
    }

    if (!this.enabled) {
      // Logged at warn, not info: with Mailpit one command away, an unset
      // SMTP_HOST is something somebody needs to fix, not a supported setup.
      this.logger.warn(
        `MAIL_NOT_CONFIGURED to=${message.to} subject="${message.subject}"\n` +
          `${message.text}`,
      );
      return {
        delivered: false,
        via: "log",
        error: "no SMTP transport configured (SMTP_HOST is unset)",
        retryable: false,
      };
    }

    try {
      const info = await this.getTransporter().sendMail({
        // `"Name" <address>` — the same composition College-Level uses.
        from: `"${env.mail.fromName}" <${env.mail.fromEmail}>`,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      this.logger.info(
        `MAIL_SENT to=${message.to} subject="${message.subject}" id=${info.messageId}`,
      );
      return { delivered: true, via: "smtp", messageId: info.messageId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Loud, because nobody is watching an inbox that never fills. The caller
      // still succeeds — see the note at the top.
      const retryable = isRetryableSmtpError(error);
      this.logger.error(
        `MAIL_FAILED to=${message.to} subject="${message.subject}" ` +
          `retryable=${retryable} — ${reason}`,
      );
      return { delivered: false, via: "smtp", error: reason, retryable };
    }
  }

  /** Closes the pooled connection, if one was ever opened. */
  close(): void {
    this.transporter?.close();
    this.transporter = null;
  }
}

export default MailService;

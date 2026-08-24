/**
 * Enqueue contracts for transactional email.
 *
 * The `vars` / `secrets` split is the whole point of this file. `vars` is
 * persisted to `email_jobs.payload`; `secrets` is published to the queue and
 * **never reaches a SQL statement**. `EmailJobService.createJob()` is written to
 * take only `vars`, so the token cannot be written to Postgres by accident —
 * the enforcement is structural rather than a comment somebody has to obey.
 */
import type { EmailTemplateName } from "../../../types/queue.types";
import type {
  EmailTemplateSecrets,
  EmailTemplateVars,
} from "../../mail/templates";

export interface EnqueueEmailInput<T extends EmailTemplateName> {
  orgId: string;
  template: T;
  to: string;
  /** Persisted **and** published. Must contain no credential. */
  vars: EmailTemplateVars[T];
  /** Published only. Never persisted. */
  secrets: EmailTemplateSecrets[T];
  /** The recipient, when they are a user of this system. */
  userId?: string | null;
  /** The admin who triggered it. Null for a self-service reset. */
  requestedBy?: string | null;
  correlationId?: string | null;
}

/**
 * Delivery attempts per template, before the message is dead-lettered.
 *
 * Deliberately not one number. A reset link lives **one hour**
 * (`PASSWORD_RESET_TTL_HOURS`), so retrying it for several minutes risks
 * delivering mail whose link is nearly dead — better to fail fast and let the
 * person click "forgot password" again, which mints a fresh one. An invitation
 * lives a week and can afford to keep trying.
 */
export const EMAIL_MAX_ATTEMPTS: Record<EmailTemplateName, number> = {
  invitation: 3,
  password_reset: 2,
};

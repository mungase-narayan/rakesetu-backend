/**
 * The template registry.
 *
 * The message names a template; the consumer looks it up here. That indirection
 * is what lets `email_jobs.payload` hold render *context* rather than a rendered
 * body — which is what keeps the token-bearing URL out of Postgres, since both
 * templates print the link in the body as visible text.
 *
 * `vars` and `secrets` are separate arguments on purpose. `vars` is persisted;
 * `secrets` is published and never written to a SQL statement. Splitting them
 * at the type level means the enforcement is structural rather than a comment
 * somebody has to remember.
 */
import type { EmailTemplateName } from "../../../types/queue.types";
import type { MailMessage } from "../services/mail.service";
import { invitationEmail, passwordResetEmail } from "./auth-emails";

/** Persisted to `email_jobs.payload`. Must contain no credential. */
export interface EmailTemplateVars {
  invitation: {
    firstName: string;
    organizationName: string;
    invitedBy: string | null;
    ttlHours: number;
  };
  password_reset: {
    firstName: string;
    ttlHours: number;
  };
}

/** Published only. Never reaches the database. */
export interface EmailTemplateSecrets {
  invitation: { url: string };
  password_reset: { url: string };
}

type Renderer<T extends EmailTemplateName> = (
  to: string,
  vars: EmailTemplateVars[T],
  secrets: EmailTemplateSecrets[T],
) => MailMessage;

export const EMAIL_RENDERERS: {
  [T in EmailTemplateName]: Renderer<T>;
} = {
  invitation: (to, vars, secrets) =>
    invitationEmail({
      to,
      firstName: vars.firstName,
      organizationName: vars.organizationName,
      invitedBy: vars.invitedBy,
      url: secrets.url,
      ttlHours: vars.ttlHours,
    }),

  password_reset: (to, vars, secrets) =>
    passwordResetEmail({
      to,
      firstName: vars.firstName,
      url: secrets.url,
      ttlHours: vars.ttlHours,
    }),
};

/**
 * Renders by name, with the loose types the consumer has after JSON round-trip.
 *
 * The message arrives off the wire as `Record<string, unknown>`, so precision is
 * already lost by the time the consumer holds it; casting once here is honest
 * about where that happens rather than spreading `as` through the handler.
 */
export const renderEmail = (
  template: EmailTemplateName,
  to: string,
  vars: Record<string, unknown>,
  url: string | undefined,
): MailMessage => {
  const renderer = EMAIL_RENDERERS[template] as Renderer<EmailTemplateName>;

  return renderer(
    to,
    vars as EmailTemplateVars[EmailTemplateName],
    { url: url ?? "" } as EmailTemplateSecrets[EmailTemplateName],
  );
};

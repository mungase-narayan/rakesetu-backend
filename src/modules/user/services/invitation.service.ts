/**
 * The invitation / password-reset workflow: issue a token, then queue the email.
 *
 * It owns the two things that must happen together and in that order, and
 * keeping it out of the controllers means `POST /users` and
 * `POST /users/:id/invite` queue the identical message rather than two that
 * drift.
 *
 * **The token is issued synchronously, in the request.** That is deliberate and
 * worth defending, because deferring it to the consumer looks tidier:
 *
 *  - `expiresAt` is known at request time, so it can be audited and shown;
 *  - `issue()` revokes any live token first, so "any earlier link has stopped
 *    working" is true the moment the admin clicks — not whenever a worker gets
 *    round to it;
 *  - and if the consumer minted it instead, a redelivery would revoke the link
 *    that had already reached the inbox. Silently.
 *
 * The plaintext then travels in the queue message and nowhere else. It cannot
 * go in `email_jobs` (see that schema's header) and it cannot be recovered from
 * `user_tokens`, which stores only a sha256.
 */
import type { Logger } from "winston";

import env from "../../../config/env.config";
import type { User } from "../../../schema";
import EmailJobService from "../../email/services/email-job.service";
import UserTokenService from "./user-token.service";

export interface DispatchedInvitation {
  expiresAt: Date;
  /**
   * The outbox row. Null when the enqueue itself failed — the account still
   * exists, so the caller reports that rather than pretending mail is coming.
   */
  emailJobId: string | null;
  /**
   * Whether the message was accepted for delivery.
   *
   * With a broker this means "published" and the send happens later. With
   * `USE_RABBITMQ_SERVICE=false` the fallback runs the consumer inline, so
   * acceptance *includes* the send and an SMTP fault shows up here. Either way
   * the honest summary is the same — is this invitation going to arrive — and
   * `email_jobs.last_error` carries which of the two actually broke.
   */
  queued: boolean;
}

class InvitationService {
  constructor(
    private readonly userTokenService: UserTokenService,
    private readonly emailJobService: EmailJobService,
    private readonly logger: Logger,
  ) {}

  /**
   * `encodeURIComponent`, deliberately: base64url avoids `+` and `/`, but the
   * frontend route reads a path segment and a stray character there would
   * truncate the token silently rather than fail loudly.
   */
  private link(path: string, token: string): string {
    return `${env.frontendUrl}${path}/${encodeURIComponent(token)}`;
  }

  async dispatchInvitation(input: {
    user: User;
    organizationName: string | null;
    /** The inviting admin's id — recorded on the token and the outbox rows. */
    invitedById?: string | null;
    /** Their display name — shown in the email. Two fields, two purposes. */
    invitedByName?: string | null;
  }): Promise<DispatchedInvitation> {
    const { token, expiresAt } = await this.userTokenService.issue({
      userId: input.user.id,
      orgId: input.user.orgId,
      type: "invitation",
      ttlHours: env.tokens.invitationTtlHours,
      createdBy: input.invitedById ?? null,
    });

    const job = await this.emailJobService.enqueue({
      orgId: input.user.orgId,
      template: "invitation",
      to: input.user.email,
      userId: input.user.id,
      requestedBy: input.invitedById ?? null,
      vars: {
        firstName: input.user.firstName,
        organizationName: input.organizationName ?? "RakeSetu",
        invitedBy: input.invitedByName ?? null,
        ttlHours: env.tokens.invitationTtlHours,
      },
      secrets: { url: this.link("/auth/invitation", token) },
    });

    this.logger.info({
      event: "INVITATION_ISSUED",
      userId: input.user.id,
      emailJobId: job.id,
      queued: job.status !== "failed",
    });

    return {
      expiresAt,
      emailJobId: job.id,
      queued: job.status !== "failed",
    };
  }

  async dispatchPasswordReset(user: User): Promise<DispatchedInvitation> {
    const { token, expiresAt } = await this.userTokenService.issue({
      userId: user.id,
      orgId: user.orgId,
      type: "password_reset",
      ttlHours: env.tokens.passwordResetTtlHours,
    });

    const job = await this.emailJobService.enqueue({
      orgId: user.orgId,
      template: "password_reset",
      to: user.email,
      userId: user.id,
      vars: {
        firstName: user.firstName,
        ttlHours: env.tokens.passwordResetTtlHours,
      },
      secrets: { url: this.link("/auth/reset-password", token) },
    });

    this.logger.info({
      event: "PASSWORD_RESET_ISSUED",
      userId: user.id,
      emailJobId: job.id,
      queued: job.status !== "failed",
    });

    return {
      expiresAt,
      emailJobId: job.id,
      queued: job.status !== "failed",
    };
  }
}

export default InvitationService;

/**
 * The public half of account activation: accepting an invitation, asking for a
 * password reset, and redeeming one.
 *
 * Every handler here is **unauthenticated** — the token is the credential — so
 * three rules apply throughout and are worth stating once:
 *
 *  1. **No enumeration.** `forgotPassword` answers 200 whether or not the
 *     address exists. An endpoint that 404s on an unknown email is an endpoint
 *     that confirms which of a leaked address list are real accounts.
 *  2. **One failure message.** Unknown, expired, revoked and already-used
 *     tokens all produce the same 400. Distinguishing them tells an attacker
 *     which guesses are close.
 *  3. **Redeeming ends every other session.** Setting a password revokes the
 *     user's refresh tokens, because the most common reason to reset one is
 *     that somebody else may have had it.
 */
import type { Logger } from "winston";
import type { Response } from "express";
import { eq } from "drizzle-orm";

import { db } from "../../../database/connection";
import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import { refreshTokens } from "../../../schema";
import type { CustomRequest } from "../../../types/common.types";
import ERROR_MESSAGE from "../../../constants/error-message.constants";

import AuditService from "../../audit/services/audit.service";
import OrganizationService from "../../organization/services/organization.service";
import UserService from "../services/user.service";
import HashService from "../services/hash.service";
import UserTokenService from "../services/user-token.service";
import InvitationService from "../services/invitation.service";
import type {
  IAcceptInvitationBody,
  IForgotPasswordBody,
  IResetPasswordBody,
  TokenPreview,
} from "../types/invitation.types";

/** The single answer every bad token gets. */
const INVALID_TOKEN =
  "This link is invalid, has expired, or has already been used. Ask an administrator for a new one.";

const pathParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

class InvitationController {
  constructor(
    private readonly userService: UserService,
    private readonly hashService: HashService,
    private readonly userTokenService: UserTokenService,
    private readonly invitationService: InvitationService,
    private readonly organizationService: OrganizationService,
    private readonly auditService: AuditService,
    private readonly logger: Logger,
  ) {}

  /**
   * Ends every live session for a user.
   *
   * Called after any password change. Without it, a stolen session survives the
   * very act taken to end it — which is the whole reason the person is here.
   */
  private async revokeSessions(userId: string, reason: string): Promise<void> {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: "admin" })
      .where(eq(refreshTokens.userId, userId));

    this.logger.info({ event: "SESSIONS_REVOKED", userId, reason });
  }

  /** Shared by both preview endpoints — same shape, same refusal. */
  private async preview(
    token: string,
    type: "invitation" | "password_reset",
  ): Promise<TokenPreview> {
    const row = await this.userTokenService.verify(token, type);
    if (!row) throw new ApiError(400, INVALID_TOKEN);

    const user = await this.userService.getUserById(row.userId);
    if (!user) throw new ApiError(400, INVALID_TOKEN);

    const organization = await this.organizationService.getOrganizationById(
      user.orgId,
    );

    return {
      firstName: user.firstName,
      email: user.email,
      organizationName: organization?.name ?? null,
      expiresAt: row.expiresAt,
    };
  }

  /** GET /users/invitations/:token — lets the page greet the invitee. */
  async previewInvitation(req: CustomRequest, res: Response) {
    const data = await this.preview(pathParam(req.params.token), "invitation");

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Invitation is valid."));
  }

  /** POST /users/invitations/:token/accept — first password, account activated. */
  async acceptInvitation(
    req: CustomRequest<IAcceptInvitationBody>,
    res: Response,
  ) {
    const token = pathParam(req.params.token);

    const row = await this.userTokenService.verify(token, "invitation");
    if (!row) throw new ApiError(400, INVALID_TOKEN);

    // Consume before writing the password. If the update then fails the link is
    // spent and the admin re-invites — annoying. The other order lets a double
    // submit set the password twice, and the second one could be an attacker's
    // choice racing the invitee's. Spent-but-safe is the right failure.
    const won = await this.userTokenService.consume(row.id);
    if (!won) throw new ApiError(400, INVALID_TOKEN);

    const user = await this.userService.getUserById(row.userId);
    if (!user) throw new ApiError(400, INVALID_TOKEN);

    const hashPassword = await this.hashService.hashData(req.body.password);

    const updated = await this.userService.updateUser(user.id, {
      hashPassword,
      // The invitation is the proof of address: it was delivered to that inbox
      // and somebody with access to it clicked through.
      status: "active",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    });

    await this.auditService.record({
      orgId: user.orgId,
      actorId: user.id,
      action: "user.invitation.accept",
      entityType: "users",
      entityId: user.id,
      before: { status: user.status, isEmailVerified: user.isEmailVerified },
      after: {
        status: updated.status,
        isEmailVerified: updated.isEmailVerified,
      },
      ip: req.ip ?? null,
    });

    this.logger.info({ event: "INVITATION_ACCEPTED", userId: user.id });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { email: updated.email },
          "Your account is active. You can sign in now.",
        ),
      );
  }

  /**
   * POST /users/password/forgot
   *
   * Always 200. The response says the same thing for a real address, an unknown
   * one, and an account that exists but has never been activated — otherwise
   * this endpoint becomes a way to test whether an address has an account.
   */
  async forgotPassword(req: CustomRequest<IForgotPasswordBody>, res: Response) {
    const email = req.body.email.trim().toLowerCase();
    const user = await this.userService.getUserByEmail(email);

    // An account with no password has never been activated: sending a *reset*
    // would be a second route to activation that skips the invitation, so it
    // gets a fresh invitation instead. The caller is told nothing either way.
    if (user && user.status !== "archived") {
      if (user.hashPassword) {
        await this.invitationService.dispatchPasswordReset(user);
      } else {
        const organization = await this.organizationService.getOrganizationById(
          user.orgId,
        );
        await this.invitationService.dispatchInvitation({
          user,
          organizationName: organization?.name ?? null,
        });
      }

      await this.auditService.record({
        orgId: user.orgId,
        actorId: user.id,
        action: "user.password.forgot",
        entityType: "users",
        entityId: user.id,
        ip: req.ip ?? null,
      });
    } else {
      this.logger.info({ event: "PASSWORD_RESET_UNKNOWN_EMAIL", email });
    }

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          null,
          "If an account exists for that address, a reset link is on its way.",
        ),
      );
  }

  /** GET /users/password/reset/:token — validity check before showing a form. */
  async previewReset(req: CustomRequest, res: Response) {
    const data = await this.preview(
      pathParam(req.params.token),
      "password_reset",
    );

    return res.status(200).json(new ApiResponse(200, data, "Link is valid."));
  }

  /** POST /users/password/reset/:token — sets the new password. */
  async resetPassword(req: CustomRequest<IResetPasswordBody>, res: Response) {
    const token = pathParam(req.params.token);

    const row = await this.userTokenService.verify(token, "password_reset");
    if (!row) throw new ApiError(400, INVALID_TOKEN);

    const won = await this.userTokenService.consume(row.id);
    if (!won) throw new ApiError(400, INVALID_TOKEN);

    const user = await this.userService.getUserById(row.userId);
    if (!user) throw new ApiError(400, INVALID_TOKEN);

    // A reset must not resurrect a suspended or blocked account. Only the
    // invitation flow may change `status`, and only from inactive to active.
    if (user.status !== "active") {
      throw new ApiError(403, ERROR_MESSAGE.ACCOUNT_INACTIVE);
    }

    const hashPassword = await this.hashService.hashData(req.body.password);

    await this.userService.updateUser(user.id, {
      hashPassword,
      // A successful reset clears a lockout: the person has proved control of
      // the mailbox, which is a stronger signal than five bad guesses.
      failedLoginAttempts: 0,
      lockedUntil: null,
    });

    await this.revokeSessions(user.id, "password_reset");

    await this.auditService.record({
      orgId: user.orgId,
      actorId: user.id,
      action: "user.password.reset",
      entityType: "users",
      entityId: user.id,
      // Never the hash, before or after. That it changed is the fact worth
      // recording; the value is not.
      after: { passwordChanged: true, sessionsRevoked: true },
      ip: req.ip ?? null,
    });

    this.logger.info({ event: "PASSWORD_RESET_COMPLETED", userId: user.id });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { email: user.email },
          "Password updated. Every other session has been signed out.",
        ),
      );
  }
}

export default InvitationController;

/**
 * User controller: HTTP handlers for login, refresh, me, updateMe and logout.
 * Orchestrates UserService, HashService and TokenService, enforces the login
 * lockout, and shapes responses with ApiResponse / ApiError.
 */
import { Logger } from "winston";
import { CookieOptions, Response } from "express";

import env from "../../../config/env.config";
import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import { CustomRequest } from "../../../types/common.types";
import ERROR_MESSAGE from "../../../constants/error-message.constants";
import { ILoginBody, IRefreshBody, IUpdateMeBody } from "../types/user.types";

import UserService from "../services/user.service";
import HashService from "../services/hash.service";
import TokenService from "../services/token.service";
import RefreshTokenService from "../services/refresh-token.service";
import UserRoleService from "../../role/services/user-role.service";
import OrganizationService from "../../organization/services/organization.service";
import AuditService from "../../audit/services/audit.service";
import {
  LoginOrganizationDto,
  LoginResponseDto,
  LoginRoleDto,
  LoginUserDto,
} from "../dto/login-response.dto";
import {
  LOCK_DURATION_MINUTES,
  MAX_FAILED_LOGIN_ATTEMPTS,
} from "../constants/user.constants";

/**
 * The access-token cookie. `SameSite=lax` because the SPA also holds a copy in
 * redux and sends it as `Authorization: Bearer` — that is the fallback path for
 * clients where third-party cookies are blocked, and it is what makes the
 * cookie's own strictness a nice-to-have rather than load-bearing.
 */
const accessCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.app.isProd,
  sameSite: "lax",
};

/**
 * The refresh-token cookie, and the *only* place the refresh token appears —
 * it is no longer in any response body (DECISIONS.md D4).
 *
 * `SameSite=strict` rather than lax: this cookie's whole job is to mint access
 * tokens, so it must never ride along on a cross-site request. `path` scopes it
 * to the two endpoints that need it, so it is not attached to every API call
 * that has no use for it.
 */
const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.app.isProd,
  sameSite: "strict",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export const REFRESH_COOKIE = "refreshToken";
export const ACCESS_COOKIE = "accessToken";

class UserController {
  constructor(
    private userService: UserService,
    private hashService: HashService,
    private tokenService: TokenService,
    private userRoleService: UserRoleService,
    private organizationService: OrganizationService,
    private refreshTokenService: RefreshTokenService,
    private auditService: AuditService,
    private logger: Logger,
  ) {}

  async login(req: CustomRequest<ILoginBody>, res: Response) {
    const { email, password } = req.body;

    this.logger.info({ event: "USER_LOGIN_ATTEMPT", email });

    const user = await this.userService.getUserByEmail(email.toLowerCase());
    if (!user) {
      throw new ApiError(404, ERROR_MESSAGE.INVALID_CREDENTIALS);
    }

    if (user.status !== "active") {
      throw new ApiError(403, ERROR_MESSAGE.ACCOUNT_INACTIVE);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ApiError(423, ERROR_MESSAGE.ACCOUNT_LOCKED);
    }

    const isMatch = await this.hashService.hashCompare(
      password,
      user.hashPassword ?? "",
    );

    if (!isMatch) {
      const attempts = user.failedLoginAttempts + 1;
      const shouldLock = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;

      await this.userService.updateUser(user.id, {
        failedLoginAttempts: attempts,
        lockedUntil: shouldLock
          ? new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000)
          : null,
      });

      this.logger.warn({
        event: "USER_LOGIN_FAILED",
        userId: user.id,
        attempts,
        locked: shouldLock,
      });

      // A locked-out attempt should say so, otherwise the user retries
      // forever against an account that cannot succeed.
      if (shouldLock) {
        throw new ApiError(423, ERROR_MESSAGE.ACCOUNT_LOCKED);
      }
      throw new ApiError(404, ERROR_MESSAGE.INVALID_CREDENTIALS);
    }

    const updated = await this.userService.updateUser(user.id, {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: req.ip ?? null,
    });

    const accessToken = await this.tokenService.signAccessToken({
      user: { id: user.id },
    });
    const refreshToken = await this.tokenService.signRefreshToken({
      user: { id: user.id },
    });

    // A login opens a new token family. Rotation appends to it (Phase 13);
    // reuse of any member revokes the whole chain.
    await this.refreshTokenService.issue({
      userId: user.id,
      token: refreshToken,
      expiresAt: this.tokenService.refreshExpiryOf(refreshToken),
      userAgent: req.header("User-Agent") ?? null,
      ip: req.ip ?? null,
    });

    res.cookie(ACCESS_COOKIE, accessToken, accessCookieOptions);
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions);

    const [userRoles, organization] = await Promise.all([
      this.userRoleService.getUserRoles(user.id),
      this.organizationService.getOrganizationById(user.orgId),
    ]);

    await this.auditService.record({
      orgId: user.orgId,
      actorId: user.id,
      actorRole: userRoles[0]?.name ?? null,
      action: "user.login",
      entityType: "users",
      entityId: user.id,
      // No `before`/`after` snapshot: nothing about the user changed that is
      // worth diffing, and the interesting facts are already columns here.
      after: { lastLoginAt: updated.lastLoginAt },
      ip: req.ip ?? null,
    });

    this.logger.info({ event: "USER_LOGIN_SUCCESS", userId: user.id });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          new LoginResponseDto(
            updated,
            organization ?? null,
            userRoles,
            accessToken,
          ),
          "Login successful.",
        ),
      );
  }

  /**
   * Exchanges a live refresh token for a fresh access token.
   *
   * Three things must all hold: the signature verifies, a `refresh_tokens` row
   * exists that is neither revoked nor expired, and the user is still active.
   * The middle one is the reason the table exists — a stateless check cannot
   * tell a logged-out session from a live one, because a signed token stays
   * signed after logout.
   *
   * Rotation is Phase 13. Until then the presented token stays valid and only
   * the access token is re-issued.
   */
  async refresh(req: CustomRequest<IRefreshBody>, res: Response) {
    // The cookie is the transport. `body.refreshToken` is still read so a
    // non-browser client (curl, the test suite, a native app that cannot hold
    // cookies) has a way in; it is not what the SPA uses.
    const token = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;

    if (!token) {
      throw new ApiError(401, ERROR_MESSAGE.REFRESH_TOKEN_REQUIRED);
    }

    let userId: string;
    try {
      const payload = this.tokenService.verifyRefreshToken(token);
      if (!payload.user?.id) {
        throw new ApiError(401, ERROR_MESSAGE.INVALID_REFRESH_TOKEN);
      }
      userId = payload.user.id;
    } catch {
      throw new ApiError(401, ERROR_MESSAGE.INVALID_REFRESH_TOKEN);
    }

    // Revoked, expired, or never issued by us — all 401, all with the same
    // message. Distinguishing them tells an attacker which tokens are real.
    const stored = await this.refreshTokenService.findActive(token);
    if (!stored) {
      this.logger.warn({ event: "REFRESH_TOKEN_REJECTED", userId });
      throw new ApiError(401, ERROR_MESSAGE.INVALID_REFRESH_TOKEN);
    }

    // Re-read the user rather than trusting the token: an account suspended
    // five minutes ago must not be able to mint a new access token.
    const user = await this.userService.getUserById(userId);
    if (!user) {
      throw new ApiError(401, ERROR_MESSAGE.INVALID_REFRESH_TOKEN);
    }
    if (user.status !== "active") {
      throw new ApiError(403, ERROR_MESSAGE.ACCOUNT_INACTIVE);
    }

    const accessToken = await this.tokenService.signAccessToken({
      user: { id: user.id },
    });

    res.cookie(ACCESS_COOKIE, accessToken, accessCookieOptions);

    await this.auditService.record({
      orgId: user.orgId,
      actorId: user.id,
      action: "user.token.refresh",
      entityType: "refresh_tokens",
      entityId: stored.id,
      ip: req.ip ?? null,
    });

    this.logger.info({ event: "TOKEN_REFRESHED", userId: user.id });

    return res
      .status(200)
      .json(
        new ApiResponse(200, { accessToken }, "Token refreshed successfully."),
      );
  }

  /**
   * The authenticated user's own profile, with organization and roles —
   * the same payload shape as login minus the tokens. The SPA calls this on
   * boot to re-validate a persisted session.
   */
  async me(req: CustomRequest, res: Response) {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, ERROR_MESSAGE.UNAUTHORIZED_REQUEST);

    const user = await this.userService.getUserById(userId);
    if (!user) throw new ApiError(404, ERROR_MESSAGE.USER_NOT_FOUND);

    const [userRoles, organization] = await Promise.all([
      this.userRoleService.getUserRoles(user.id),
      this.organizationService.getOrganizationById(user.orgId),
    ]);

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          user: new LoginUserDto(user),
          organization: organization
            ? new LoginOrganizationDto(organization)
            : null,
          roles: userRoles.map((r) => new LoginRoleDto(r)),
        },
        "Profile fetched successfully.",
      ),
    );
  }

  /**
   * Self-service update of the authenticated user's own account fields
   * (username and avatar). Email stays fixed — it is the login identity.
   */
  async updateMe(req: CustomRequest<IUpdateMeBody>, res: Response) {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, ERROR_MESSAGE.UNAUTHORIZED_REQUEST);

    const { username, avatar } = req.body;

    const updates: { username?: string; avatar?: string | null } = {};

    if (username !== undefined) {
      const normalized = username.trim().toLowerCase();
      // Reject duplicates up front for a clean 409 (the DB unique constraint
      // is the ultimate guard — see the 23505 catch below for races).
      const existing = await this.userService.getUserByUsername(normalized);
      if (existing && existing.id !== userId) {
        throw new ApiError(409, ERROR_MESSAGE.USERNAME_TAKEN);
      }
      updates.username = normalized;
    }

    if (avatar !== undefined) {
      updates.avatar = avatar ?? null;
    }

    if (Object.keys(updates).length === 0) {
      throw new ApiError(400, ERROR_MESSAGE.NO_FIELDS_TO_UPDATE);
    }

    try {
      const before = await this.userService.getUserById(userId);
      const updated = await this.userService.updateUser(userId, updates);

      await this.auditService.record({
        orgId: updated.orgId,
        actorId: userId,
        action: "user.update",
        entityType: "users",
        entityId: userId,
        // Only the fields this endpoint can change. Snapshotting the whole row
        // would put the password hash in an append-only table.
        before: before
          ? { username: before.username, avatar: before.avatar }
          : null,
        after: { username: updated.username, avatar: updated.avatar },
        ip: req.ip ?? null,
      });

      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            new LoginUserDto(updated),
            "Profile updated successfully.",
          ),
        );
    } catch (err) {
      // Drizzle wraps the pg driver error, so SQLSTATE can be on err.cause.code.
      const code =
        (err as { code?: string }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") {
        throw new ApiError(409, ERROR_MESSAGE.USERNAME_TAKEN);
      }
      throw err;
    }
  }

  /**
   * Ends the session on the server as well as in the browser.
   *
   * Clearing the cookies alone would leave a signed token that still verifies —
   * anyone who captured it stays logged in until it expires. Revoking the row
   * is what actually ends the session, and it is why logout needs a database
   * write at all.
   */
  async logout(req: CustomRequest, res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];

    if (token) {
      await this.refreshTokenService.revokeByToken(token, "logout");
    }

    // clearCookie only matches when the attributes match the ones it was set
    // with, so these must mirror the options above.
    res.clearCookie(ACCESS_COOKIE, accessCookieOptions);
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);

    if (req.user) {
      await this.auditService.record({
        orgId: req.user.orgId,
        actorId: req.user.id,
        action: "user.logout",
        entityType: "users",
        entityId: req.user.id,
        ip: req.ip ?? null,
      });
    }

    this.logger.info({ event: "USER_LOGOUT", userId: req.user?.id });

    return res
      .status(200)
      .json(new ApiResponse(200, null, "Logged out successfully."));
  }
}

export default UserController;

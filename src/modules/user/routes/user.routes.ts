/**
 * User route definitions: wires the UserController and its service
 * dependencies, and exposes the auth endpoints (/login, /refresh, /logout)
 * plus the profile endpoints (/me) with their validators and JWT guards.
 *
 * POST /login carries the strict rate limiter: it is the one unauthenticated
 * endpoint that is worth guessing at, and the per-account lockout alone does
 * not stop an attacker spraying one password across many accounts.
 *
 * The administration routes are appended **after** `/me`, and the order is
 * load-bearing: Express matches in declaration order, so a `GET /:id` declared
 * first would swallow `GET /me` and answer it with "user `me` not found".
 */
import { Router } from "express";

import { users } from "../../../schema";
import logger from "../../../logger/winston.logger";
import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { withTenant } from "../../../middlewares/tenant.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";

import {
  loginRateLimiter,
  passwordRateLimiter,
  tokenRateLimiter,
} from "../../../middlewares/rate-limit.middleware";

import { emailJobService } from "../../email/email.provider";
import UserService from "../services/user.service";
import HashService from "../services/hash.service";
import TokenService from "../services/token.service";
import RefreshTokenService from "../services/refresh-token.service";
import UserRoleService from "../../role/services/user-role.service";
import OrganizationService from "../../organization/services/organization.service";
import AuditService from "../../audit/services/audit.service";
import UserController from "../controllers/user.controller";
import UserAdminService from "../services/user-admin.service";
import UserTokenService from "../services/user-token.service";
import InvitationService from "../services/invitation.service";
import UserAdminController from "../controllers/user-admin.controller";
import InvitationController from "../controllers/invitation.controller";
import {
  loginValidator,
  refreshValidator,
  updateMeValidator,
} from "../validators/user.validator";
import {
  assignRoleValidator,
  createUserValidator,
  listUsersValidator,
  revokeRoleValidator,
  updateUserValidator,
  userIdValidator,
} from "../validators/user-admin.validator";
import {
  acceptInvitationValidator,
  forgotPasswordValidator,
  resetPasswordValidator,
  tokenParamValidator,
} from "../validators/invitation.validator";

const userRouter: Router = Router();

const userService = new UserService(users);
const hashService = new HashService();
const tokenService = new TokenService();
const userRoleService = new UserRoleService();
const organizationService = new OrganizationService();
const refreshTokenService = new RefreshTokenService();
const auditService = new AuditService(logger);
const userController = new UserController(
  userService,
  hashService,
  tokenService,
  userRoleService,
  organizationService,
  refreshTokenService,
  auditService,
  logger,
);

const userTokenService = new UserTokenService();
// The shared instance from modules/email/email.provider.ts — App late-binds the
// broker onto it. See that file for why it is a singleton rather than built here.
const invitationService = new InvitationService(
  userTokenService,
  emailJobService,
  logger,
);

const userAdminService = new UserAdminService();
const userAdminController = new UserAdminController(
  userAdminService,
  auditService,
  invitationService,
  organizationService,
  logger,
);

const invitationController = new InvitationController(
  userService,
  hashService,
  userTokenService,
  invitationService,
  organizationService,
  auditService,
  logger,
);

/**
 * Guard order is load-bearing: verifyJWT proves who, requirePermission proves
 * may, withTenant binds where. Reordering withTenant before verifyJWT would
 * leave it reading an org off an unauthenticated request.
 */
const readGuards = [verifyJWT, requirePermission("user:read"), withTenant];
const writeGuards = [verifyJWT, requirePermission("user:write"), withTenant];

userRouter.post(
  "/login",
  loginRateLimiter,
  loginValidator,
  validateMiddleware,
  asyncHandler((req, res) => userController.login(req, res)),
);

userRouter.post(
  "/refresh",
  refreshValidator,
  validateMiddleware,
  asyncHandler((req, res) => userController.refresh(req, res)),
);

userRouter.post(
  "/logout",
  verifyJWT,
  asyncHandler((req, res) => userController.logout(req, res)),
);

userRouter.get(
  "/me",
  verifyJWT,
  asyncHandler((req, res) => userController.me(req, res)),
);

userRouter.patch(
  "/me",
  verifyJWT,
  updateMeValidator,
  validateMiddleware,
  asyncHandler((req, res) => userController.updateMe(req, res)),
);

/* ------------------------------------------ invitations & passwords -- */

/**
 * Public by design: the token in the path *is* the credential, so requiring a
 * session would defeat the purpose — nobody accepting an invitation has one
 * yet, and nobody who has forgotten their password can produce one.
 *
 * Declared **before** the `/:id` admin routes below. Express matches in
 * declaration order, and `/users/password/forgot` would otherwise be a
 * plausible read of `GET /users/:id` with an id of "password".
 *
 * Two limiters, not one. `passwordRateLimiter` guards the single endpoint that
 * **sends mail**; `tokenRateLimiter` guards the four that only read or redeem a
 * token. Sharing one strict budget would mean an office onboarding thirty staff
 * behind a NAT locked itself out of its own invitations.
 */
userRouter.get(
  "/invitations/:token",
  tokenRateLimiter,
  tokenParamValidator,
  validateMiddleware,
  asyncHandler((req, res) => invitationController.previewInvitation(req, res)),
);

userRouter.post(
  "/invitations/:token/accept",
  tokenRateLimiter,
  acceptInvitationValidator,
  validateMiddleware,
  asyncHandler((req, res) => invitationController.acceptInvitation(req, res)),
);

userRouter.post(
  "/password/forgot",
  passwordRateLimiter,
  forgotPasswordValidator,
  validateMiddleware,
  asyncHandler((req, res) => invitationController.forgotPassword(req, res)),
);

userRouter.get(
  "/password/reset/:token",
  tokenRateLimiter,
  tokenParamValidator,
  validateMiddleware,
  asyncHandler((req, res) => invitationController.previewReset(req, res)),
);

userRouter.post(
  "/password/reset/:token",
  tokenRateLimiter,
  resetPasswordValidator,
  validateMiddleware,
  asyncHandler((req, res) => invitationController.resetPassword(req, res)),
);

/* ---------------------------------------------------------------- admin -- */

userRouter.get(
  "/",
  ...readGuards,
  listUsersValidator,
  validateMiddleware,
  asyncHandler((req, res) => userAdminController.list(req, res)),
);

userRouter.post(
  "/",
  ...writeGuards,
  createUserValidator,
  validateMiddleware,
  asyncHandler((req, res) => userAdminController.create(req, res)),
);

userRouter.get(
  "/:id",
  ...readGuards,
  userIdValidator,
  validateMiddleware,
  asyncHandler((req, res) => userAdminController.detail(req, res)),
);

userRouter.patch(
  "/:id",
  ...writeGuards,
  updateUserValidator,
  validateMiddleware,
  asyncHandler((req, res) => userAdminController.update(req, res)),
);

userRouter.post(
  "/:id/invite",
  ...writeGuards,
  userIdValidator,
  validateMiddleware,
  asyncHandler((req, res) => userAdminController.resendInvitation(req, res)),
);

userRouter.post(
  "/:id/roles",
  ...writeGuards,
  assignRoleValidator,
  validateMiddleware,
  asyncHandler((req, res) => userAdminController.assignRole(req, res)),
);

userRouter.delete(
  "/:id/roles/:userRoleId",
  ...writeGuards,
  revokeRoleValidator,
  validateMiddleware,
  asyncHandler((req, res) => userAdminController.revokeRole(req, res)),
);

export default userRouter;

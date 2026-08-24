/**
 * User route definitions: wires the UserController and its service
 * dependencies, and exposes the auth endpoints (/login, /refresh, /logout)
 * plus the profile endpoints (/me) with their validators and JWT guards.
 *
 * POST /login carries the strict rate limiter: it is the one unauthenticated
 * endpoint that is worth guessing at, and the per-account lockout alone does
 * not stop an attacker spraying one password across many accounts.
 */
import { Router } from "express";

import { users } from "../../../schema";
import logger from "../../../logger/winston.logger";
import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import { verifyJWT } from "../../../middlewares/auth.middleware";

import { loginRateLimiter } from "../../../middlewares/rate-limit.middleware";

import UserService from "../services/user.service";
import HashService from "../services/hash.service";
import TokenService from "../services/token.service";
import RefreshTokenService from "../services/refresh-token.service";
import UserRoleService from "../../role/services/user-role.service";
import OrganizationService from "../../organization/services/organization.service";
import AuditService from "../../audit/services/audit.service";
import UserController from "../controllers/user.controller";
import {
  loginValidator,
  refreshValidator,
  updateMeValidator,
} from "../validators/user.validator";

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

export default userRouter;

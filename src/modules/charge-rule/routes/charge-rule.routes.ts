/**
 * Charge-rule routes — `/api/v1/charge-rules`.
 *
 * Reads are `masterdata:read`, so a commercial officer can inspect the rule book
 * without being able to edit it; writes are `masterdata:write`.
 */
import { Router } from "express";

import logger from "../../../logger/winston.logger";
import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { withTenant } from "../../../middlewares/tenant.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";

import AuditService from "../../audit/services/audit.service";
import ChargeRuleService from "../services/charge-rule.service";
import ChargeRuleController from "../controllers/charge-rule.controller";
import {
  createChargeRuleValidator,
  listChargeRulesValidator,
  resolveValidator,
  updateChargeRuleValidator,
} from "../validators/charge-rule.validator";

const chargeRuleRouter: Router = Router();

const controller = new ChargeRuleController(
  new ChargeRuleService(),
  new AuditService(logger),
);

const readGuards = [
  verifyJWT,
  requirePermission("masterdata:read"),
  withTenant,
];
const writeGuards = [
  verifyJWT,
  requirePermission("masterdata:write"),
  withTenant,
];

/**
 * Declared before `/:id` — Express matches in declaration order, and `resolve`
 * would otherwise be read as a uuid and fail validation.
 */
chargeRuleRouter.get(
  "/resolve",
  ...readGuards,
  resolveValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.resolve(req, res)),
);

chargeRuleRouter.get(
  "/",
  ...readGuards,
  listChargeRulesValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.list(req, res)),
);

chargeRuleRouter.post(
  "/",
  ...writeGuards,
  createChargeRuleValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.create(req, res)),
);

chargeRuleRouter.patch(
  "/:id",
  ...writeGuards,
  updateChargeRuleValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.update(req, res)),
);

export default chargeRuleRouter;

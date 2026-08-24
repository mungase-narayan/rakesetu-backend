/**
 * Audit routes.
 *
 * Guard order is load-bearing: verifyJWT proves who, requirePermission proves
 * may, withTenant binds where. Reordering withTenant before verifyJWT would
 * leave it reading an org off an unauthenticated request.
 */
import { Router } from "express";

import logger from "../../../logger/winston.logger";
import asyncHandler from "../../../utils/async-handler";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { withTenant } from "../../../middlewares/tenant.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";

import AuditService from "../services/audit.service";
import AuditController from "../controllers/audit.controller";

const auditRouter: Router = Router();

const auditService = new AuditService(logger);
const auditController = new AuditController(auditService);

const guards = [verifyJWT, requirePermission("audit:read"), withTenant];

auditRouter.get(
  "/",
  ...guards,
  asyncHandler((req, res) => auditController.list(req, res)),
);

auditRouter.get(
  "/:entityType/:entityId",
  ...guards,
  asyncHandler((req, res) => auditController.listForEntity(req, res)),
);

export default auditRouter;

/**
 * Commodity routes — `/api/v1/commodities`.
 *
 * Global reference data, so no tenant scoping on the reads; `withTenant` is
 * still mounted on the writes because the audit row needs an org.
 */
import { Router } from "express";

import logger from "../../../logger/winston.logger";
import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { withTenant } from "../../../middlewares/tenant.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";

import AuditService from "../../audit/services/audit.service";
import CommodityService from "../services/commodity.service";
import CustomerService from "../services/customer.service";
import CommercialController from "../controllers/commercial.controller";
import {
  createCommodityValidator,
  listCommoditiesValidator,
  updateCommodityValidator,
} from "../validators/commercial.validator";

const commodityRouter: Router = Router();

const controller = new CommercialController(
  new CommodityService(),
  new CustomerService(),
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

commodityRouter.get(
  "/",
  ...readGuards,
  listCommoditiesValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listCommodities(req, res)),
);

commodityRouter.post(
  "/",
  ...writeGuards,
  createCommodityValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.createCommodity(req, res)),
);

commodityRouter.patch(
  "/:code",
  ...writeGuards,
  updateCommodityValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.updateCommodity(req, res)),
);

export default commodityRouter;

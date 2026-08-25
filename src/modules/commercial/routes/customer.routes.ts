/**
 * Customer routes — `/api/v1/customers`.
 *
 * Tenant-scoped: every read and write goes through `ScopedRepository` on the
 * zone's `org_id`. The customer *portal* reads the same rows through
 * `customer_org_id` and arrives in Phase 6 — see DECISIONS D7.
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
  addSidingValidator,
  createCustomerValidator,
  customerIdValidator,
  listCustomersValidator,
  sidingIdValidator,
  updateCustomerValidator,
} from "../validators/commercial.validator";

const customerRouter: Router = Router();

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

customerRouter.get(
  "/",
  ...readGuards,
  listCustomersValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listCustomers(req, res)),
);

customerRouter.post(
  "/",
  ...writeGuards,
  createCustomerValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.createCustomer(req, res)),
);

customerRouter.get(
  "/:id",
  ...readGuards,
  customerIdValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.getCustomer(req, res)),
);

customerRouter.patch(
  "/:id",
  ...writeGuards,
  updateCustomerValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.updateCustomer(req, res)),
);

customerRouter.get(
  "/:id/sidings",
  ...readGuards,
  customerIdValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listSidings(req, res)),
);

customerRouter.post(
  "/:id/sidings",
  ...writeGuards,
  addSidingValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.addSiding(req, res)),
);

customerRouter.delete(
  "/:id/sidings/:sidingId",
  ...writeGuards,
  sidingIdValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.removeSiding(req, res)),
);

export default customerRouter;

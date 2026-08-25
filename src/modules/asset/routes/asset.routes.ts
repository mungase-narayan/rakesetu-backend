/**
 * Asset routes.
 *
 * Three mount points rather than one, because the resources are three nouns the
 * API surface names separately: `/api/v1/wagon-types`, `/api/v1/wagons` and
 * `/api/v1/rakes`. They share a controller because they share a transaction
 * boundary — replacing a composition touches rakes and wagons together.
 */
import { Router } from "express";

import logger from "../../../logger/winston.logger";
import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { withTenant } from "../../../middlewares/tenant.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";

import AuditService from "../../audit/services/audit.service";
import WagonTypeService from "../services/wagon-type.service";
import WagonService from "../services/wagon.service";
import RakeService from "../services/rake.service";
import AssetController from "../controllers/asset.controller";
import {
  compositionQueryValidator,
  createRakeValidator,
  createWagonTypeValidator,
  createWagonValidator,
  listRakesValidator,
  listWagonTypesValidator,
  listWagonsValidator,
  replaceCompositionValidator,
  updateRakeValidator,
  updateWagonTypeValidator,
  updateWagonValidator,
} from "../validators/asset.validator";

const controller = new AssetController(
  new WagonTypeService(),
  new WagonService(),
  new RakeService(),
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

export const wagonTypeRouter: Router = Router();

wagonTypeRouter.get(
  "/",
  ...readGuards,
  listWagonTypesValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listWagonTypes(req, res)),
);

wagonTypeRouter.post(
  "/",
  ...writeGuards,
  createWagonTypeValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.createWagonType(req, res)),
);

wagonTypeRouter.patch(
  "/:code",
  ...writeGuards,
  updateWagonTypeValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.updateWagonType(req, res)),
);

export const wagonRouter: Router = Router();

wagonRouter.get(
  "/",
  ...readGuards,
  listWagonsValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listWagons(req, res)),
);

wagonRouter.post(
  "/",
  ...writeGuards,
  createWagonValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.createWagon(req, res)),
);

wagonRouter.patch(
  "/:id",
  ...writeGuards,
  updateWagonValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.updateWagon(req, res)),
);

export const rakeRouter: Router = Router();

rakeRouter.get(
  "/",
  ...readGuards,
  listRakesValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listRakes(req, res)),
);

rakeRouter.post(
  "/",
  ...writeGuards,
  createRakeValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.createRake(req, res)),
);

/**
 * Declared before `PATCH /:id` for the same reason `/me` precedes `/:id` in the
 * user router: Express matches in declaration order.
 */
rakeRouter.get(
  "/:id/composition",
  ...readGuards,
  compositionQueryValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.getComposition(req, res)),
);

rakeRouter.put(
  "/:id/composition",
  ...writeGuards,
  replaceCompositionValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.replaceComposition(req, res)),
);

rakeRouter.patch(
  "/:id",
  ...writeGuards,
  updateRakeValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.updateRake(req, res)),
);

export default rakeRouter;

/**
 * `/api/v1/eta/…`
 *
 * Guard order is the Phase 1 order — `verifyJWT` proves who, `requirePermission`
 * proves may, `withTenant` binds where. Nothing here writes, so no
 * `idempotent()`: an estimate asked twice is an estimate asked twice.
 *
 * The permission split is §7's matrix. `rake:read` covers the two operational
 * endpoints because every role that can see a rake can see where it is going;
 * `analytics:read` covers the weight table because that is the inside of the
 * engine and a supervisor has no reason to be handed 360 rows of medians.
 */
import { Router } from "express";

import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { withTenant } from "../../../middlewares/tenant.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";

import EtaController from "../controllers/eta.controller";
import EtaLookupService from "../services/eta-lookup.service";
import SectionWeightService from "../services/section-weight.service";
import {
  estimateValidator,
  rakeEtaValidator,
  sectionWeightsValidator,
} from "../validators/eta.validator";

const sectionWeightService = new SectionWeightService();
const etaLookupService = new EtaLookupService(sectionWeightService);
const controller = new EtaController(etaLookupService, sectionWeightService);

const readGuards = [verifyJWT, requirePermission("rake:read"), withTenant];
const analyticsGuards = [
  verifyJWT,
  requirePermission("analytics:read"),
  withTenant,
];

const etaRouter: Router = Router();

/**
 * Declared before `/rake/:rakeId` would matter only if the paths could collide.
 * They cannot — `section-weights` is a single segment and the other two are
 * two-segment — but the fixed paths stay first out of habit, because the day
 * somebody adds `/eta/:id` is the day the habit pays for itself.
 */
etaRouter.get(
  "/section-weights",
  ...analyticsGuards,
  sectionWeightsValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.sectionWeights(req, res)),
);

etaRouter.post(
  "/estimate",
  ...readGuards,
  estimateValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.estimate(req, res)),
);

etaRouter.get(
  "/rake/:rakeId",
  ...readGuards,
  rakeEtaValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.forRake(req, res)),
);

export { etaLookupService, sectionWeightService };
export default etaRouter;

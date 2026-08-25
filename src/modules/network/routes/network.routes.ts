/**
 * Network routes — `/api/v1/network/*`.
 *
 * Guard order is the Phase 1 order and is load-bearing: `verifyJWT` proves who,
 * `requirePermission` proves may, `withTenant` binds where. Reads need
 * `masterdata:read`, which every operational role holds; writes need
 * `masterdata:write`, which only an admin does.
 *
 * `withTenant` is mounted on the *global* tables' writes too, which looks
 * redundant — nothing here is scoped by org. It is there because the audit row
 * is: `audit_log.org_id` is not nullable, and "which zone's admin edited the
 * national network" is exactly the question the trail has to answer.
 */
import { Router } from "express";

import logger from "../../../logger/winston.logger";
import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { withTenant } from "../../../middlewares/tenant.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";

import AuditService from "../../audit/services/audit.service";
import StationService from "../services/station.service";
import SectionService from "../services/section.service";
import DistanceService from "../services/distance.service";
import ChargeableDistanceService from "../services/chargeable-distance.service";
import NetworkController from "../controllers/network.controller";
import {
  createChargeableDistanceValidator,
  createSectionValidator,
  createStationValidator,
  getDistanceValidator,
  listChargeableDistancesValidator,
  listSectionsValidator,
  listStationsValidator,
  sectionIdValidator,
  updateSectionValidator,
  updateStationValidator,
} from "../validators/network.validator";

const networkRouter: Router = Router();

const distanceService = new DistanceService();
const stationService = new StationService();
const sectionService = new SectionService(distanceService);
const chargeableDistanceService = new ChargeableDistanceService();
const auditService = new AuditService(logger);

const networkController = new NetworkController(
  stationService,
  sectionService,
  chargeableDistanceService,
  distanceService,
  auditService,
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

// ---- stations -------------------------------------------------------------

networkRouter.get(
  "/stations",
  ...readGuards,
  listStationsValidator,
  validateMiddleware,
  asyncHandler((req, res) => networkController.listStations(req, res)),
);

networkRouter.post(
  "/stations",
  ...writeGuards,
  createStationValidator,
  validateMiddleware,
  asyncHandler((req, res) => networkController.createStation(req, res)),
);

networkRouter.patch(
  "/stations/:code",
  ...writeGuards,
  updateStationValidator,
  validateMiddleware,
  asyncHandler((req, res) => networkController.updateStation(req, res)),
);

// ---- sections -------------------------------------------------------------

networkRouter.get(
  "/sections",
  ...readGuards,
  listSectionsValidator,
  validateMiddleware,
  asyncHandler((req, res) => networkController.listSections(req, res)),
);

networkRouter.post(
  "/sections",
  ...writeGuards,
  createSectionValidator,
  validateMiddleware,
  asyncHandler((req, res) => networkController.createSection(req, res)),
);

networkRouter.patch(
  "/sections/:id",
  ...writeGuards,
  updateSectionValidator,
  validateMiddleware,
  asyncHandler((req, res) => networkController.updateSection(req, res)),
);

networkRouter.delete(
  "/sections/:id",
  ...writeGuards,
  sectionIdValidator,
  validateMiddleware,
  asyncHandler((req, res) => networkController.deleteSection(req, res)),
);

// ---- chargeable distances -------------------------------------------------

networkRouter.get(
  "/chargeable-distances",
  ...readGuards,
  listChargeableDistancesValidator,
  validateMiddleware,
  asyncHandler((req, res) =>
    networkController.listChargeableDistances(req, res),
  ),
);

networkRouter.post(
  "/chargeable-distances",
  ...writeGuards,
  createChargeableDistanceValidator,
  validateMiddleware,
  asyncHandler((req, res) =>
    networkController.createChargeableDistance(req, res),
  ),
);

// ---- the distance endpoint ------------------------------------------------

networkRouter.get(
  "/distance",
  ...readGuards,
  getDistanceValidator,
  validateMiddleware,
  asyncHandler((req, res) => networkController.getDistance(req, res)),
);

export default networkRouter;

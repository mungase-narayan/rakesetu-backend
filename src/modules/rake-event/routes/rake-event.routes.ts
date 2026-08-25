/**
 * Event-spine routes.
 *
 * Three routers rather than one, because they mount under three different
 * bases and Express resolves by mount path:
 *
 *  - `rakeEventRouter`  → `/api/v1/rakes/:rakeId/…`
 *  - `networkLiveRouter` → `/api/v1/network/live`
 *  - `anomalyRouter`    → `/api/v1/anomalies`
 *
 * Guard order is the Phase 1 order and stays load-bearing: `verifyJWT` proves
 * who, `requirePermission` proves may, `withTenant` binds where. `idempotent()`
 * comes last on the write, after the tenant is known — the Redis key is built
 * from `req.tenant.orgId`, so mounting it earlier would bucket every tenant's
 * `Idempotency-Key: 1` together.
 */
import { Router } from "express";

import logger from "../../../logger/winston.logger";
import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import {
  verifyJWT,
  verifyStreamJWT,
} from "../../../middlewares/auth.middleware";
import { withTenant } from "../../../middlewares/tenant.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";
import { requireRoles } from "../../../middlewares/role.middleware";
import { idempotent } from "../../../middlewares/idempotency.middleware";

import AuditService from "../../audit/services/audit.service";
import ProjectorService from "../services/projector.service";
import RakeEventService from "../services/rake-event.service";
import RakeEventController from "../controllers/rake-event.controller";
import { eventStream } from "../services/event-stream.service";
import {
  bulkEventsValidator,
  createEventValidator,
  cycleIdParamValidator,
  listAnomaliesValidator,
  listCyclesValidator,
  listEventsValidator,
  listRakeStatesValidator,
  rakeIdParamValidator,
  sectionLoadValidator,
} from "../validators/rake-event.validator";

const auditService = new AuditService(logger);
const projectorService = new ProjectorService(
  logger,
  auditService,
  undefined,
  eventStream,
);
const rakeEventService = new RakeEventService();

const controller = new RakeEventController(
  projectorService,
  rakeEventService,
  eventStream,
);

const readGuards = [verifyJWT, requirePermission("rake:read"), withTenant];

/**
 * The whole division, as opposed to one rake.
 *
 * `rake:read` is not enough on its own here, and the gap is real: a freight
 * customer legitimately holds that permission — Phase 6 gives them tracking of
 * *their own* consignments — but §7's matrix gives them no sight of the network.
 * Without this guard the customer portal could page through every rake in the
 * zone, which is a competitor's freight position.
 *
 * A role guard rather than a new permission, deliberately. The question being
 * asked is genuinely "is this person inside the operating chain", which is what
 * `requireRoles` is for; a `network:read` permission would be a permission that
 * exists only to name a set of roles. Phase 6 revisits this the moment a
 * customer has a scoped view to be given instead.
 */
const divisionWideGuards = [
  verifyJWT,
  requirePermission("rake:read"),
  requireRoles(
    "admin",
    "zonal_manager",
    "freight_controller",
    "terminal_supervisor",
  ),
  withTenant,
];
const writeGuards = [
  verifyJWT,
  requirePermission("rake:event:create"),
  withTenant,
];

// ---- /api/v1/rakes/:rakeId/… ----------------------------------------------

const rakeEventRouter: Router = Router();

rakeEventRouter.post(
  "/:rakeId/events",
  ...writeGuards,
  idempotent(),
  createEventValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.create(req, res)),
);

/**
 * No `idempotent()` here on purpose. The middleware keys on one header for the
 * whole request, and a batch carries one key **per event** — a batch-level
 * replay guard would let a partially-retried simulator run silently drop the
 * events it had not yet written. `rake_event_keys` is the guard for this route.
 */
rakeEventRouter.post(
  "/:rakeId/events/bulk",
  ...writeGuards,
  bulkEventsValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.createBulk(req, res)),
);

rakeEventRouter.get(
  "/:rakeId/events",
  ...readGuards,
  listEventsValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.list(req, res)),
);

rakeEventRouter.get(
  "/:rakeId/state",
  ...readGuards,
  rakeIdParamValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.getState(req, res)),
);

rakeEventRouter.get(
  "/:rakeId/cycles",
  ...readGuards,
  listCyclesValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listCycles(req, res)),
);

rakeEventRouter.get(
  "/:rakeId/cycles/:cycleId",
  ...readGuards,
  cycleIdParamValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.getCycle(req, res)),
);

/**
 * Admin only, and by role rather than by permission.
 *
 * Every operational role holds `rake:read`, and there is no "rebuild the
 * projection" permission to hold — this is a maintenance action on the cache,
 * not an operational act, so the guard that fits is "is this an administrator".
 */
rakeEventRouter.post(
  "/:rakeId/reproject",
  verifyJWT,
  requireRoles("admin"),
  withTenant,
  rakeIdParamValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.reproject(req, res)),
);

// ---- /api/v1/network/live -------------------------------------------------

const networkLiveRouter: Router = Router();

networkLiveRouter.get(
  "/live",
  ...divisionWideGuards,
  asyncHandler((req, res) => controller.networkLive(req, res)),
);

/**
 * The SSE upgrade of `/live` (Phase 5).
 *
 * `verifyStreamJWT` instead of `verifyJWT`, and it is the only route in the
 * product that accepts a token from the query string — `EventSource` cannot set
 * a header. Everything after that is the same chain the polled feed carries,
 * **including `requireRoles`**: a customer holds `rake:read` and still has no
 * business seeing the division's freight position, live or polled.
 *
 * `withTenant` last, as everywhere, so the org is bound from the session and a
 * query parameter cannot choose whose frames arrive.
 */
networkLiveRouter.get(
  "/stream",
  verifyStreamJWT,
  requirePermission("rake:read"),
  requireRoles(
    "admin",
    "zonal_manager",
    "freight_controller",
    "terminal_supervisor",
  ),
  withTenant,
  asyncHandler((req, res) => controller.stream(req, res)),
);

/**
 * The fleet list behind `/app/controller/rakes`. It lives under `/network`
 * rather than `/rakes` because `/api/v1/rakes` is the master-data resource —
 * that endpoint answers "what rakes exist", and this one answers "where is
 * every rake right now", which is a different question with a different guard.
 */
networkLiveRouter.get(
  "/rake-states",
  ...divisionWideGuards,
  listRakeStatesValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listRakeStates(req, res)),
);

networkLiveRouter.get(
  "/section-load",
  ...divisionWideGuards,
  sectionLoadValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.sectionLoad(req, res)),
);

networkLiveRouter.get(
  "/available-count",
  ...divisionWideGuards,
  asyncHandler((req, res) => controller.availableCount(req, res)),
);

// ---- /api/v1/anomalies ----------------------------------------------------

const anomalyRouter: Router = Router();

anomalyRouter.get(
  "/",
  ...divisionWideGuards,
  listAnomaliesValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listAnomalies(req, res)),
);

export { rakeEventRouter, networkLiveRouter, anomalyRouter };
export { projectorService, rakeEventService, eventStream };
export default rakeEventRouter;

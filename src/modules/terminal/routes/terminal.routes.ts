/**
 * Terminal and embargo routes.
 *
 * The permission split is §7's, and it is the reason these two resources share
 * a module but not a guard:
 *
 *   - terminals  → `masterdata:read` / `masterdata:write` (the admin's)
 *   - embargoes  → `masterdata:read` / **`embargo:write`** (the controller's)
 *
 * A freight controller holds `embargo:write` and not `masterdata:write`, so the
 * same person who declares an embargo cannot quietly edit the terminal it names.
 */
import { Router } from "express";

import logger from "../../../logger/winston.logger";
import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { withTenant } from "../../../middlewares/tenant.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";

import AuditService from "../../audit/services/audit.service";
import TerminalService from "../services/terminal.service";
import EmbargoService from "../services/embargo.service";
import TerminalBoardService from "../services/terminal-board.service";
import TerminalController from "../controllers/terminal.controller";
import {
  createEmbargoValidator,
  createTerminalValidator,
  embargoIdValidator,
  listEmbargoesValidator,
  listTerminalsValidator,
  nextEventsValidator,
  previewScopeValidator,
  terminalBoardValidator,
  terminalIdValidator,
  updateEmbargoValidator,
  updateTerminalValidator,
} from "../validators/terminal.validator";

const controller = new TerminalController(
  new TerminalService(),
  new EmbargoService(),
  new AuditService(logger),
  new TerminalBoardService(),
);

const readGuards = [
  verifyJWT,
  requirePermission("masterdata:read"),
  withTenant,
];
const masterDataWriteGuards = [
  verifyJWT,
  requirePermission("masterdata:write"),
  withTenant,
];
const embargoWriteGuards = [
  verifyJWT,
  requirePermission("embargo:write"),
  withTenant,
];

/**
 * The operational half of this module (Phase 5).
 *
 * `terminal:read` rather than `masterdata:read`: the board is an operating
 * screen, and the two permissions genuinely differ — a commercial officer holds
 * `masterdata:read` and has no business on a supervisor's placement board.
 *
 * `terminal:log` guards the legal-events endpoint because it exists solely to
 * build the quick-entry buttons; somebody who cannot write an event has nothing
 * to do with the list of events they could have written.
 */
const boardGuards = [verifyJWT, requirePermission("terminal:read"), withTenant];
const logGuards = [verifyJWT, requirePermission("terminal:log"), withTenant];

export const terminalRouter: Router = Router();

terminalRouter.get(
  "/",
  ...readGuards,
  listTerminalsValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listTerminals(req, res)),
);

/**
 * Declared before `/:id` so `board-options` is never read as a terminal id.
 * Express matches in declaration order and a uuid validator would only turn
 * the collision into a 422 rather than preventing it.
 */
terminalRouter.get(
  "/board-options",
  ...boardGuards,
  asyncHandler((req, res) => controller.boardOptions(req, res)),
);

terminalRouter.get(
  "/:id/board",
  ...boardGuards,
  terminalBoardValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.board(req, res)),
);

terminalRouter.get(
  "/:id/next-events",
  ...logGuards,
  nextEventsValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.nextEvents(req, res)),
);

terminalRouter.post(
  "/",
  ...masterDataWriteGuards,
  createTerminalValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.createTerminal(req, res)),
);

terminalRouter.patch(
  "/:id",
  ...masterDataWriteGuards,
  updateTerminalValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.updateTerminal(req, res)),
);

export const embargoRouter: Router = Router();

embargoRouter.get(
  "/",
  ...readGuards,
  listEmbargoesValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.listEmbargoes(req, res)),
);

/**
 * Declared before `POST /` would matter only if the paths collided — they do
 * not — but before `/:id` routes for the usual reason. Preview is a read
 * dressed as a POST because a scope is too structured for a query string.
 */
embargoRouter.post(
  "/preview",
  ...readGuards,
  previewScopeValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.previewScope(req, res)),
);

embargoRouter.post(
  "/",
  ...embargoWriteGuards,
  createEmbargoValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.createEmbargo(req, res)),
);

embargoRouter.patch(
  "/:id",
  ...embargoWriteGuards,
  updateEmbargoValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.updateEmbargo(req, res)),
);

embargoRouter.delete(
  "/:id",
  ...embargoWriteGuards,
  embargoIdValidator,
  validateMiddleware,
  asyncHandler((req, res) => controller.endEmbargo(req, res)),
);

export { terminalIdValidator };
export default terminalRouter;

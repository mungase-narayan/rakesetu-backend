/**
 * Role route definitions: wires RoleController and its service
 * dependencies behind the JWT guard.
 *
 * Listing roles was authenticated but ungated — any signed-in account could
 * enumerate them. It is not sensitive data, but the roles list is what a
 * user-administration screen is built on, so it takes the same permission that
 * screen does.
 */
import { Router } from "express";

import asyncHandler from "../../../utils/async-handler";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { requirePermission } from "../../../middlewares/permission.middleware";

import RoleService from "../services/role.service";
import RoleController from "../controllers/role.controller";

const roleRouter: Router = Router();

const roleService = new RoleService();
const roleController = new RoleController(roleService);

roleRouter.get(
  "/",
  verifyJWT,
  requirePermission("user:read"),
  asyncHandler((req, res) => roleController.listRoles(req, res)),
);

export default roleRouter;

/**
 * Organization route definitions: wires OrganizationController and its
 * service dependencies, with the JWT guard on both routes and the admin
 * role guard on the directory listing.
 */
import { Router } from "express";

import asyncHandler from "../../../utils/async-handler";
import validateMiddleware from "../../../middlewares/validate.middleware";
import { verifyJWT } from "../../../middlewares/auth.middleware";
import { requireRoles } from "../../../middlewares/role.middleware";

import OrganizationService from "../services/organization.service";
import OrganizationController from "../controllers/organization.controller";
import {
  listOrganizationsValidator,
  organizationIdValidator,
} from "../validators/organization.validator";

const organizationRouter: Router = Router();

const organizationService = new OrganizationService();
const organizationController = new OrganizationController(organizationService);

organizationRouter.get(
  "/",
  verifyJWT,
  requireRoles("admin"),
  listOrganizationsValidator,
  validateMiddleware,
  asyncHandler((req, res) =>
    organizationController.listOrganizations(req, res),
  ),
);

organizationRouter.get(
  "/:id",
  verifyJWT,
  organizationIdValidator,
  validateMiddleware,
  asyncHandler((req, res) => organizationController.getOrganization(req, res)),
);

export default organizationRouter;

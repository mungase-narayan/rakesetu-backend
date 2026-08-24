/**
 * express-validator chains for the organization endpoints.
 */
import { query, param } from "express-validator";

import {
  ORGANIZATION_STATUSES,
  ORGANIZATION_TYPES,
} from "../constants/organization.constants";

export const listOrganizationsValidator = [
  query("type")
    .optional()
    .isIn(ORGANIZATION_TYPES)
    .withMessage(`type must be one of: ${ORGANIZATION_TYPES.join(", ")}`),
  query("status")
    .optional()
    .isIn(ORGANIZATION_STATUSES)
    .withMessage(`status must be one of: ${ORGANIZATION_STATUSES.join(", ")}`),
];

export const organizationIdValidator = [
  param("id").isUUID().withMessage("id must be a valid UUID"),
];

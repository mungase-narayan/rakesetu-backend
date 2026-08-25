/**
 * express-validator chains for the commercial endpoints.
 */
import { body, param, query } from "express-validator";

import { COMMODITY_GROUPS, CUSTOMER_TIERS } from "../../../schema";

export const listCommoditiesValidator = [
  query("search").optional().isString().trim(),
  query("group").optional().isIn(COMMODITY_GROUPS),
  query("isHazardous").optional().isBoolean(),
];

export const createCommodityValidator = [
  body("code").isString().trim().toUpperCase().isLength({ min: 2, max: 20 }),
  body("name").isString().trim().isLength({ min: 2, max: 120 }),
  body("group").isIn(COMMODITY_GROUPS),
  /**
   * Required, with no default. Phase 10's `ratePerTonne(commodityClass, …)`
   * reads this; a commodity that arrived without one prices at nothing, and a
   * zero-rupee freight line is a revenue error that no screen shows as an error.
   */
  body("class")
    .isString()
    .trim()
    .isLength({ min: 1, max: 10 })
    .withMessage("class is required — Phase 10's rating engine reads it"),
  body("minWeightCondition")
    .isString()
    .trim()
    .isLength({ min: 1, max: 20 })
    .withMessage(
      "minWeightCondition is required — it is the §5.7 minimum-weight rule",
    ),
  body("isHazardous").optional().isBoolean(),
];

export const updateCommodityValidator = [
  param("code").isString().trim().toUpperCase(),
  body("name").optional().isString().trim().isLength({ min: 2, max: 120 }),
  body("group").optional().isIn(COMMODITY_GROUPS),
  body("class").optional().isString().trim().isLength({ min: 1, max: 10 }),
  body("minWeightCondition")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 20 }),
  body("isHazardous").optional().isBoolean(),
];

export const listCustomersValidator = [
  query("search").optional().isString().trim(),
  query("tier").optional().isIn(CUSTOMER_TIERS),
  query("isActive").optional().isBoolean(),
];

export const createCustomerValidator = [
  body("code").isString().trim().toUpperCase().isLength({ min: 2, max: 20 }),
  body("name").isString().trim().isLength({ min: 2, max: 200 }),
  body("customerOrgId").optional({ values: "null" }).isUUID(),
  body("gstin")
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ min: 15, max: 15 }),
  body("tier").optional().isIn(CUSTOMER_TIERS),
  body("creditLimit").optional({ values: "null" }).isFloat({ min: 0 }),
  body("contactEmail").optional({ values: "null" }).isEmail().normalizeEmail(),
  body("contactPhone")
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ max: 20 }),
  body("isActive").optional().isBoolean(),
];

export const updateCustomerValidator = [
  param("id").isUUID(),
  body("name").optional().isString().trim().isLength({ min: 2, max: 200 }),
  body("customerOrgId").optional({ values: "null" }).isUUID(),
  body("gstin")
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ min: 15, max: 15 }),
  body("tier").optional().isIn(CUSTOMER_TIERS),
  body("creditLimit").optional({ values: "null" }).isFloat({ min: 0 }),
  body("contactEmail").optional({ values: "null" }).isEmail().normalizeEmail(),
  body("contactPhone")
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ max: 20 }),
  body("isActive").optional().isBoolean(),
];

export const customerIdValidator = [param("id").isUUID()];

export const addSidingValidator = [
  param("id").isUUID(),
  body("terminalId").isUUID(),
  body("commodityCodes")
    .isArray({ min: 1 })
    .withMessage("a siding permits at least one commodity"),
  body("commodityCodes.*").isString().trim().toUpperCase(),
  body("isDefaultLoading").optional().isBoolean(),
  body("isDefaultDest").optional().isBoolean(),
];

export const sidingIdValidator = [
  param("id").isUUID(),
  param("sidingId").isUUID(),
];

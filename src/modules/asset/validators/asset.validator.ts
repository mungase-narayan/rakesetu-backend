/**
 * express-validator chains for the asset endpoints.
 */
import { body, param, query } from "express-validator";

import {
  COMMODITY_GROUPS,
  RAKE_STATES,
  WAGON_OWNERS,
  WAGON_STATUSES,
} from "../../../schema";

export const listWagonTypesValidator = [
  query("search").optional().isString().trim(),
  query("commodityGroup").optional().isIn(COMMODITY_GROUPS),
];

export const createWagonTypeValidator = [
  body("code").isString().trim().toUpperCase().isLength({ min: 2, max: 20 }),
  body("name").isString().trim().isLength({ min: 2, max: 120 }),
  body("tareT").isFloat({ gt: 0, max: 100 }),
  body("ccT").isFloat({ gt: 0, max: 200 }),
  body("ccPlus82T").isFloat({ gt: 0, max: 200 }),
  body("commodityGroups").isArray({ min: 1 }),
  body("commodityGroups.*").isIn(COMMODITY_GROUPS),
  body("lengthM").isFloat({ gt: 0, max: 100 }),
  body("isCovered").optional().isBoolean(),
];

export const updateWagonTypeValidator = [
  param("code").isString().trim().toUpperCase(),
  body("name").optional().isString().trim().isLength({ min: 2, max: 120 }),
  body("tareT").optional().isFloat({ gt: 0, max: 100 }),
  body("ccT").optional().isFloat({ gt: 0, max: 200 }),
  body("ccPlus82T").optional().isFloat({ gt: 0, max: 200 }),
  body("commodityGroups").optional().isArray({ min: 1 }),
  body("commodityGroups.*").optional().isIn(COMMODITY_GROUPS),
  body("lengthM").optional().isFloat({ gt: 0, max: 100 }),
  body("isCovered").optional().isBoolean(),
];

export const listWagonsValidator = [
  query("search").optional().isString().trim(),
  query("status").optional().isIn(WAGON_STATUSES),
  query("typeCode").optional().isString().trim().toUpperCase(),
  query("pohDueBefore").optional().isISO8601(),
];

export const createWagonValidator = [
  body("number").isString().trim().toUpperCase().isLength({ min: 3, max: 20 }),
  body("typeCode")
    .isString()
    .trim()
    .toUpperCase()
    .isLength({ min: 2, max: 20 }),
  body("owner").isIn(WAGON_OWNERS),
  body("ownerOrgId").optional({ values: "null" }).isUUID(),
  /**
   * Both dates are required, and that is the §5.3 constraint speaking: a wagon
   * with no known due date passes every maintenance check silently, which is
   * indistinguishable from a wagon that is fine.
   */
  body("pohDueOn")
    .isISO8601()
    .withMessage("pohDueOn is required — it is the §5.3 solver constraint"),
  body("fitnessDueOn")
    .isISO8601()
    .withMessage("fitnessDueOn is required — it is the §5.3 solver constraint"),
  body("status").optional().isIn(WAGON_STATUSES),
  body("builtYear")
    .optional({ values: "null" })
    .isInt({ min: 1900, max: 2100 }),
];

export const updateWagonValidator = [
  param("id").isUUID(),
  body("typeCode").optional().isString().trim().toUpperCase(),
  body("owner").optional().isIn(WAGON_OWNERS),
  body("ownerOrgId").optional({ values: "null" }).isUUID(),
  body("pohDueOn").optional().isISO8601(),
  body("fitnessDueOn").optional().isISO8601(),
  body("status").optional().isIn(WAGON_STATUSES),
  body("builtYear")
    .optional({ values: "null" })
    .isInt({ min: 1900, max: 2100 }),
];

export const listRakesValidator = [
  query("search").optional().isString().trim(),
  query("state").optional().isIn(RAKE_STATES),
  query("station").optional().isString().trim().toUpperCase(),
  query("wagonType").optional().isString().trim().toUpperCase(),
  query("division").optional().isString().trim(),
  query("isActive").optional().isBoolean(),
];

export const createRakeValidator = [
  body("code").isString().trim().toUpperCase().isLength({ min: 2, max: 20 }),
  body("wagonTypeCode").isString().trim().toUpperCase(),
  body("wagonCount").isInt({ min: 1, max: 120 }),
  body("owner").isIn(WAGON_OWNERS),
  body("homeDivision").isString().trim().isLength({ min: 2, max: 60 }),
  body("currentStation")
    .optional({ values: "null" })
    .isString()
    .trim()
    .toUpperCase(),
  /**
   * Accepted only on create, to seed the first map render. `RakeService.update`
   * strips it, because from Phase 4 the projection is the only writer.
   */
  body("currentState").optional().isIn(RAKE_STATES),
  body("isActive").optional().isBoolean(),
];

export const updateRakeValidator = [
  param("id").isUUID(),
  body("wagonTypeCode").optional().isString().trim().toUpperCase(),
  body("wagonCount").optional().isInt({ min: 1, max: 120 }),
  body("owner").optional().isIn(WAGON_OWNERS),
  body("homeDivision")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 2, max: 60 }),
  body("isActive").optional().isBoolean(),
];

export const rakeIdValidator = [param("id").isUUID()];

export const compositionQueryValidator = [
  param("id").isUUID(),
  query("at").optional().isISO8601(),
];

export const replaceCompositionValidator = [
  param("id").isUUID(),
  body("wagonIds").isArray({ min: 1, max: 120 }),
  body("wagonIds.*").isUUID(),
  body("effectiveFrom").optional().isISO8601(),
];

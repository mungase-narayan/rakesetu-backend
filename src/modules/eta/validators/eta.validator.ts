/**
 * express-validator chains for the ETA surface.
 *
 * `departAt` may be in the **future** here, and that is the difference between
 * this and `rake_events.occurred_at`. An event is an observation and cannot
 * have happened yet; an estimate is a question about a departure that has not
 * happened yet, which is exactly what Phase 7's solver asks.
 */
import { body, param, query } from "express-validator";

export const rakeEtaValidator = [param("rakeId").isUUID()];

export const estimateValidator = [
  body("fromCode").isString().trim().toUpperCase().isLength({ min: 2, max: 8 }),
  body("toCode").isString().trim().toUpperCase().isLength({ min: 2, max: 8 }),
  body("wagonTypeCode")
    .isString()
    .trim()
    .toUpperCase()
    .isLength({ min: 2, max: 20 }),
  body("departAt").optional().isISO8601(),
];

export const sectionWeightsValidator = [
  query("wagonTypeCode").optional().isString().trim().toUpperCase(),
  query("asOf").optional().isISO8601(),
];

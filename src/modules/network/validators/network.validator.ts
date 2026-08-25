/**
 * express-validator chains for the network endpoints.
 *
 * The bulk endpoints validate **each element** of the array (`sections.*.km`
 * style paths) rather than only the envelope. A CSV import that half-lands
 * because row 47 had a blank distance is worse than one that is refused whole.
 */
import { body, param, query } from "express-validator";

import { LINE_TYPES } from "../../../schema";

const stationCode = (value: string) => /^[A-Z0-9]{2,8}$/.test(value);

export const listStationsValidator = [
  query("search").optional().isString().trim(),
  query("division").optional().isString().trim(),
  query("zone").optional().isString().trim(),
];

export const createStationValidator = [
  body("code")
    .isString()
    .trim()
    .toUpperCase()
    .custom(stationCode)
    .withMessage("code must be 2-8 uppercase letters or digits"),
  body("name").isString().trim().isLength({ min: 2, max: 120 }),
  body("division").isString().trim().isLength({ min: 2, max: 60 }),
  body("zone").isString().trim().isLength({ min: 2, max: 10 }),
  body("lat")
    .isFloat({ min: 6, max: 38 })
    .withMessage("lat must be inside India's latitude range"),
  body("lng")
    .isFloat({ min: 68, max: 98 })
    .withMessage("lng must be inside India's longitude range"),
  body("isJunction").optional().isBoolean(),
];

export const updateStationValidator = [
  param("code").isString().trim().toUpperCase().custom(stationCode),
  body("name").optional().isString().trim().isLength({ min: 2, max: 120 }),
  body("division").optional().isString().trim().isLength({ min: 2, max: 60 }),
  body("zone").optional().isString().trim().isLength({ min: 2, max: 10 }),
  body("lat").optional().isFloat({ min: 6, max: 38 }),
  body("lng").optional().isFloat({ min: 68, max: 98 }),
  body("isJunction").optional().isBoolean(),
];

export const stationCodeParamValidator = [
  param("code").isString().trim().toUpperCase().custom(stationCode),
];

export const listSectionsValidator = [
  query("fromCode").optional().isString().trim().toUpperCase(),
  query("toCode").optional().isString().trim().toUpperCase(),
  query("lineType").optional().isIn(LINE_TYPES),
];

/**
 * One chain, applied to both `POST /sections` shapes. `body().custom()` accepts
 * the object or the array and then re-validates each element, which is the only
 * way express-validator can cover both without two routes.
 */
/**
 * Bulk endpoints accept either one object or an array of them, and
 * express-validator cannot express that with field chains: `body("fromCode")`
 * on an array body reads `undefined` and fails, so a chain written for one
 * shape rejects the other. These endpoints therefore validate the payload in a
 * single `body().custom()` that normalises to an array and checks every row,
 * naming the offending index — a ninety-row CSV import that fails must say
 * *which* line was wrong.
 */
type RowCheck = (row: Record<string, unknown>) => string | null;

const validateRows = (check: RowCheck) =>
  body().custom((value: unknown) => {
    const rows = Array.isArray(value) ? value : [value];
    if (rows.length === 0) throw new Error("payload must not be empty");
    if (rows.length > 1000) {
      throw new Error("at most 1000 rows per request");
    }

    rows.forEach((row, index) => {
      if (typeof row !== "object" || row === null) {
        throw new Error(`row ${index}: expected an object`);
      }
      const message = check(row as Record<string, unknown>);
      if (message) {
        // Arrays report the index; a single object has none to report.
        throw new Error(
          Array.isArray(value) ? `row ${index}: ${message}` : message,
        );
      }
    });
    return true;
  });

const isCode = (value: unknown): value is string =>
  typeof value === "string" && stationCode(value.trim().toUpperCase());

const isNumberInRange = (value: unknown, min: number, max: number): boolean => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return (
    typeof parsed === "number" &&
    Number.isFinite(parsed) &&
    parsed > min &&
    parsed <= max
  );
};

export const createSectionValidator = [
  validateRows((row) => {
    if (!isCode(row.fromCode)) return "fromCode must be a station code";
    if (!isCode(row.toCode)) return "toCode must be a station code";
    if (
      String(row.fromCode).toUpperCase() === String(row.toCode).toUpperCase()
    ) {
      // A zero-length self-loop, which Dijkstra would relax forever.
      return "a section cannot start and end at the same station";
    }
    if (!isNumberInRange(row.distanceKm, 0, 500)) {
      return "distanceKm must be between 0 and 500";
    }
    if (!LINE_TYPES.includes(row.lineType as (typeof LINE_TYPES)[number])) {
      return `lineType must be one of: ${LINE_TYPES.join(", ")}`;
    }
    if (!isNumberInRange(row.maxAxleLoadT, 0, 40)) {
      return "maxAxleLoadT must be between 0 and 40";
    }
    if (!isNumberInRange(row.nominalSpeedKmph, 0, 200)) {
      // It is the divisor in the ETA cold start; zero would be an infinity.
      return "nominalSpeedKmph must be between 0 and 200";
    }
    if (
      row.isElectrified !== undefined &&
      typeof row.isElectrified !== "boolean"
    ) {
      return "isElectrified must be a boolean";
    }
    return null;
  }),
];

export const updateSectionValidator = [
  param("id").isUUID(),
  body("distanceKm").optional().isFloat({ gt: 0, max: 500 }),
  body("lineType").optional().isIn(LINE_TYPES),
  body("maxAxleLoadT").optional().isFloat({ gt: 0, max: 40 }),
  body("isElectrified").optional().isBoolean(),
  body("nominalSpeedKmph").optional().isFloat({ gt: 0, max: 200 }),
];

export const sectionIdValidator = [param("id").isUUID()];

export const listChargeableDistancesValidator = [
  query("fromCode").optional().isString().trim().toUpperCase(),
  query("toCode").optional().isString().trim().toUpperCase(),
];

export const createChargeableDistanceValidator = [
  validateRows((row) => {
    if (!isCode(row.fromCode)) return "fromCode must be a station code";
    if (!isCode(row.toCode)) return "toCode must be a station code";
    const km = typeof row.km === "string" ? Number(row.km) : row.km;
    if (
      typeof km !== "number" ||
      !Number.isInteger(km) ||
      km <= 0 ||
      km > 5000
    ) {
      // Tariff tables publish whole kilometres; a fractional value here would
      // be somebody's computed distance sneaking into the lookup table.
      return "km must be a whole number between 1 and 5000";
    }
    if (row.sourceRef !== undefined && typeof row.sourceRef !== "string") {
      return "sourceRef must be a string";
    }
    return null;
  }),
];

export const getDistanceValidator = [
  query("from").isString().trim().toUpperCase().custom(stationCode),
  query("to").isString().trim().toUpperCase().custom(stationCode),
  query("basis")
    .isIn(["tariff", "operational"])
    .withMessage(
      "basis is required and must be 'tariff' or 'operational' — there is no default",
    ),
];

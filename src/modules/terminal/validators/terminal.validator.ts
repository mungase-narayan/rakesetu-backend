/**
 * express-validator chains for terminals and embargoes.
 *
 * The embargo chain enforces the **D8** shape: `v` must be the version this
 * build understands, every present key must be a non-empty array of the right
 * element type, and unknown keys are rejected. Accepting an unknown key would
 * store a restriction the matcher does not read — an embargo that looks enforced
 * and is not.
 */
import { body, param, query } from "express-validator";

import {
  COMMODITY_GROUPS,
  HANDLING_MODES,
  TERMINAL_TYPES,
} from "../../../schema";
import { SELECTOR_VERSION } from "../../../types/selector.types";

export const listTerminalsValidator = [
  query("search").optional().isString().trim(),
  query("type").optional().isIn(TERMINAL_TYPES),
  query("stationCode").optional().isString().trim().toUpperCase(),
  query("commodityGroup").optional().isIn(COMMODITY_GROUPS),
  query("isActive").optional().isBoolean(),
];

export const createTerminalValidator = [
  body("stationCode")
    .isString()
    .trim()
    .toUpperCase()
    .isLength({ min: 2, max: 8 }),
  body("code").isString().trim().toUpperCase().isLength({ min: 2, max: 20 }),
  body("name").isString().trim().isLength({ min: 2, max: 120 }),
  body("type").isIn(TERMINAL_TYPES),
  body("placementLines")
    .isInt({ min: 1, max: 20 })
    .withMessage("placementLines is the server count in the Phase 8 queue"),
  body("isMechanised").optional().isBoolean(),
  body("handlingMode").isIn(HANDLING_MODES),
  body("commodityGroups").isArray({ min: 1 }),
  body("commodityGroups.*").isIn(COMMODITY_GROUPS),
  body("maxRakeLength").isInt({ min: 1, max: 120 }),
  body("avgPlacementMinutes").optional().isInt({ min: 1, max: 2880 }),
  body("operatorOrgId").optional({ values: "null" }).isUUID(),
  body("isActive").optional().isBoolean(),
];

export const updateTerminalValidator = [
  param("id").isUUID(),
  body("name").optional().isString().trim().isLength({ min: 2, max: 120 }),
  body("type").optional().isIn(TERMINAL_TYPES),
  body("placementLines").optional().isInt({ min: 1, max: 20 }),
  body("isMechanised").optional().isBoolean(),
  body("handlingMode").optional().isIn(HANDLING_MODES),
  body("commodityGroups").optional().isArray({ min: 1 }),
  body("commodityGroups.*").optional().isIn(COMMODITY_GROUPS),
  body("maxRakeLength").optional().isInt({ min: 1, max: 120 }),
  body("avgPlacementMinutes").optional().isInt({ min: 1, max: 2880 }),
  body("operatorOrgId").optional({ values: "null" }).isUUID(),
  body("isActive").optional().isBoolean(),
];

export const terminalIdValidator = [param("id").isUUID()];

const SCOPE_KEYS = [
  "v",
  "stations",
  "sections",
  "commodityCodes",
  "wagonTypeCodes",
  "terminalIds",
  "divisions",
] as const;

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === "string" && item.trim() !== "");

/**
 * Validates the D8 shape. Note what it deliberately does **not** reject: a scope
 * with every dimension omitted. `{ v: 1 }` is a total stop — a real thing a zone
 * occasionally declares — and the plain-English preview is what stops it being
 * declared by accident.
 */
export const scopeValidator = body("scope").custom((value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("scope must be an object");
  }
  const scope = value as Record<string, unknown>;

  if (scope.v !== SELECTOR_VERSION) {
    throw new Error(`scope.v must be ${SELECTOR_VERSION}`);
  }

  for (const key of Object.keys(scope)) {
    if (!SCOPE_KEYS.includes(key as (typeof SCOPE_KEYS)[number])) {
      // An unknown key would be stored and never read — a restriction that
      // looks enforced and is not.
      throw new Error(`scope.${key} is not a recognised dimension`);
    }
  }

  for (const key of [
    "stations",
    "commodityCodes",
    "wagonTypeCodes",
    "terminalIds",
    "divisions",
  ] as const) {
    if (scope[key] !== undefined && !isStringArray(scope[key])) {
      throw new Error(`scope.${key} must be a non-empty array of strings`);
    }
  }

  if (scope.sections !== undefined) {
    const sections = scope.sections;
    const valid =
      Array.isArray(sections) &&
      sections.length > 0 &&
      sections.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { from?: unknown }).from === "string" &&
          typeof (item as { to?: unknown }).to === "string",
      );
    if (!valid) {
      throw new Error("scope.sections must be an array of { from, to } pairs");
    }
  }

  return true;
});

export const listEmbargoesValidator = [
  query("activeAt").optional().isISO8601(),
  query("station").optional().isString().trim().toUpperCase(),
  query("commodity").optional().isString().trim().toUpperCase(),
  query("isActive").optional().isBoolean(),
];

export const createEmbargoValidator = [
  scopeValidator,
  body("fromTs").isISO8601(),
  body("toTs")
    .isISO8601()
    .custom((value: string, { req }) => {
      const from = new Date(String(req.body?.fromTs));
      // A window that ends before it starts is in force at no instant, which
      // makes it an embargo nobody enforces and nobody notices.
      if (new Date(value) <= from) {
        throw new Error("toTs must be after fromTs");
      }
      return true;
    }),
  body("reason").isString().trim().isLength({ min: 5, max: 2000 }),
  body("circularRef")
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ max: 120 }),
  body("documentId").optional({ values: "null" }).isUUID(),
];

export const updateEmbargoValidator = [
  param("id").isUUID(),
  body("scope").optional(),
  body("fromTs").optional().isISO8601(),
  body("toTs").optional().isISO8601(),
  body("reason").optional().isString().trim().isLength({ min: 5, max: 2000 }),
  body("circularRef")
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ max: 120 }),
  body("documentId").optional({ values: "null" }).isUUID(),
  body("isActive").optional().isBoolean(),
];

export const embargoIdValidator = [param("id").isUUID()];

export const previewScopeValidator = [scopeValidator];

// ---------------------------------------------------------------------------
// Phase 5 — the supervisor's board.
// ---------------------------------------------------------------------------

/**
 * `asOf` is optional and may be **in the past**, which is the point: the board
 * resolves free time as of a placement, and asking for the board as it stood
 * before a circular changed is how that is demonstrated rather than asserted.
 */
export const terminalBoardValidator = [
  param("id").isUUID(),
  query("asOf").optional().isISO8601(),
];

export const nextEventsValidator = [
  param("id").isUUID(),
  query("rakeId").optional().isUUID(),
];

/**
 * express-validator chains for the charge-rule endpoints.
 *
 * `params` is validated **against `type`**, because a `demurrage` row holding
 * `{ hours: 9 }` parses as valid jsonb, stores cleanly, and prices nothing —
 * a failure that would first surface in Phase 9 as a charge line of zero.
 */
import { body, param, query } from "express-validator";

import {
  CHARGE_RULE_TYPES,
  COMMODITY_GROUPS,
  HANDLING_MODES,
  TERMINAL_TYPES,
} from "../../../schema";
import { SELECTOR_VERSION } from "../../../types/selector.types";

const SELECTOR_KEYS = [
  "v",
  "commodityGroups",
  "terminalTypes",
  "handlingModes",
  "wagonTypeCodes",
  "divisions",
] as const;

const ALLOWED_VALUES: Record<string, readonly string[] | null> = {
  commodityGroups: COMMODITY_GROUPS,
  terminalTypes: TERMINAL_TYPES,
  handlingModes: HANDLING_MODES,
  // Free-form: wagon type codes and divisions are data, not enums.
  wagonTypeCodes: null,
  divisions: null,
};

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** The D8 selector shape, for charge rules. */
export const selectorValidator = body("selector").custom((value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("selector must be an object");
  }
  const selector = value as Record<string, unknown>;

  if (selector.v !== SELECTOR_VERSION) {
    throw new Error(`selector.v must be ${SELECTOR_VERSION}`);
  }

  for (const key of Object.keys(selector)) {
    if (!SELECTOR_KEYS.includes(key as (typeof SELECTOR_KEYS)[number])) {
      throw new Error(`selector.${key} is not a recognised dimension`);
    }
  }

  for (const [key, allowed] of Object.entries(ALLOWED_VALUES)) {
    const dimension = selector[key];
    if (dimension === undefined) continue; // omitted = no restriction
    if (!Array.isArray(dimension) || dimension.length === 0) {
      throw new Error(`selector.${key} must be a non-empty array`);
    }
    for (const item of dimension) {
      if (typeof item !== "string") {
        throw new Error(`selector.${key} must contain strings`);
      }
      if (allowed && !allowed.includes(item)) {
        throw new Error(
          `selector.${key} contains "${item}" — expected one of: ${allowed.join(", ")}`,
        );
      }
    }
  }

  return true;
});

/** `params`, checked against the rule `type` in the same body. */
export const paramsValidator = body("params").custom(
  (value: unknown, { req }) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("params must be an object");
    }
    const params = value as Record<string, unknown>;
    const type = (req.body as { type?: string } | undefined)?.type;

    switch (type) {
      case "free_time":
        if (!isNumber(params.hours) || params.hours < 0) {
          throw new Error("free_time params require { hours: number >= 0 }");
        }
        return true;

      case "demurrage": {
        if (!isNumber(params.baseRatePerWagonHour)) {
          throw new Error("demurrage params require baseRatePerWagonHour");
        }
        if (!Array.isArray(params.slabs) || params.slabs.length === 0) {
          throw new Error("demurrage params require a non-empty slabs array");
        }
        const slabs = params.slabs as Record<string, unknown>[];
        slabs.forEach((slab, index) => {
          if (!isNumber(slab.multiplier)) {
            throw new Error(
              `demurrage slab ${index} needs a numeric multiplier`,
            );
          }
          if (slab.upToHours !== null && !isNumber(slab.upToHours)) {
            throw new Error(
              `demurrage slab ${index}: upToHours must be a number or null`,
            );
          }
        });
        // The last slab must be open-ended, or an overstay longer than the
        // table simply falls off the end and is charged nothing.
        if (slabs[slabs.length - 1].upToHours !== null) {
          throw new Error(
            "the final demurrage slab must have upToHours: null (open-ended)",
          );
        }
        return true;
      }

      case "wharfage":
        if (!isNumber(params.ratePerTonneHour) || !isNumber(params.freeHours)) {
          throw new Error(
            "wharfage params require { ratePerTonneHour, freeHours }",
          );
        }
        return true;

      case "base_rate": {
        if (!Array.isArray(params.slabs) || params.slabs.length === 0) {
          throw new Error("base_rate params require a non-empty slabs array");
        }
        const slabs = params.slabs as Record<string, unknown>[];
        slabs.forEach((slab, index) => {
          if (!isNumber(slab.ratePerTonne)) {
            throw new Error(`base_rate slab ${index} needs ratePerTonne`);
          }
          if (slab.upToKm !== null && !isNumber(slab.upToKm)) {
            throw new Error(
              `base_rate slab ${index}: upToKm must be a number or null`,
            );
          }
        });
        if (slabs[slabs.length - 1].upToKm !== null) {
          throw new Error(
            "the final base_rate slab must have upToKm: null (open-ended)",
          );
        }
        return true;
      }

      case "bsc":
        if (!isNumber(params.percentage)) {
          throw new Error("bsc params require { percentage: number }");
        }
        return true;

      case "dev_charge":
        if (!isNumber(params.perTonne)) {
          throw new Error("dev_charge params require { perTonne: number }");
        }
        return true;

      case "terminal_charge":
        if (!isNumber(params.perWagon)) {
          throw new Error(
            "terminal_charge params require { perWagon: number }",
          );
        }
        if (params.side !== "origin" && params.side !== "destination") {
          throw new Error(
            "terminal_charge params require side: 'origin' | 'destination'",
          );
        }
        return true;

      default:
        throw new Error(`unknown charge rule type "${String(type)}"`);
    }
  },
);

export const listChargeRulesValidator = [
  query("type").optional().isIn(CHARGE_RULE_TYPES),
  query("effectiveAt").optional().isISO8601(),
  query("circularRef").optional().isString().trim(),
];

export const createChargeRuleValidator = [
  body("type").isIn(CHARGE_RULE_TYPES),
  paramsValidator,
  selectorValidator,
  body("effectiveFrom").isISO8601(),
  body("effectiveTo").optional({ values: "null" }).isISO8601(),
  body("circularRef")
    .isString()
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage(
      "circularRef is required — an unattributable charge is not defensible",
    ),
  body("clauseRef")
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ max: 60 }),
  body("documentId").optional({ values: "null" }).isUUID(),
  body("version").optional().isInt({ min: 1 }),
  body("supersedesId").optional({ values: "null" }).isUUID(),
];

export const updateChargeRuleValidator = [
  param("id").isUUID(),
  body("effectiveTo").optional({ values: "null" }).isISO8601(),
  body("clauseRef")
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ max: 60 }),
  body("documentId").optional({ values: "null" }).isUUID(),
  body("version").optional().isInt({ min: 1 }),
];

export const resolveValidator = [
  query("type").isIn(CHARGE_RULE_TYPES),
  query("asOf")
    .isISO8601()
    .withMessage(
      "asOf is required — every lookup names its date, by design (§5.6)",
    ),
  query("commodityGroups").optional().isIn(COMMODITY_GROUPS),
  query("terminalTypes").optional().isIn(TERMINAL_TYPES),
  query("handlingModes").optional().isIn(HANDLING_MODES),
  query("wagonTypeCodes").optional().isString().trim().toUpperCase(),
  query("divisions").optional().isString().trim(),
];

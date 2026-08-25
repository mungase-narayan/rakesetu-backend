/**
 * The `scope` / `selector` jsonb contract, and the `params` shapes that ride
 * alongside it — see **DECISIONS D8**.
 *
 * One rule governs every selector in the product:
 *
 * > **An omitted key means "no restriction on that dimension". Present keys are
 * > AND-ed. Values within one key are OR-ed.**
 *
 * So `{ v: 1 }` matches everything — a legitimate zone-wide default, not an
 * error — and `{ v: 1, commodityGroups: ["cement","steel"], divisions: ["Solapur"] }`
 * matches cement *or* steel, *and* only in Solapur.
 *
 * These live in `src/types/` rather than inside a module because two schema
 * files and three later phases read them, and a shape that a matcher and a
 * writer disagree about is the failure this file exists to prevent.
 */
import type {
  ChargeRuleType,
  CommodityGroup,
  HandlingMode,
  TerminalType,
} from "../schema/enums.schema";

/**
 * The version every selector carries.
 *
 * Present from the very first row so that a change in the *semantics* is a
 * number a matcher can branch on, rather than a silent reinterpretation of rows
 * already written. A matcher that meets an unknown version must throw, not
 * best-effort it: quietly ignoring an embargo you cannot parse is how a solver
 * routes a rake through a blocked section.
 */
export const SELECTOR_VERSION = 1 as const;
export type SelectorVersion = typeof SELECTOR_VERSION;

/** One directed edge of the network, as an embargo names it. */
export interface SectionRef {
  from: string;
  to: string;
}

/** `embargoes.scope`. */
export interface EmbargoScope {
  v: SelectorVersion;
  stations?: string[];
  sections?: SectionRef[];
  commodityCodes?: string[];
  wagonTypeCodes?: string[];
  terminalIds?: string[];
  divisions?: string[];
}

/**
 * `charge_rules.selector`. A different key set from an embargo — a charge is
 * scoped by how a terminal handles freight, not by which sections are blocked —
 * but the same AND/OR/omitted-key rule.
 */
export interface RuleSelector {
  v: SelectorVersion;
  commodityGroups?: CommodityGroup[];
  terminalTypes?: TerminalType[];
  handlingModes?: HandlingMode[];
  wagonTypeCodes?: string[];
  divisions?: string[];
}

/**
 * What a *caller* knows when asking which rule applies: one concrete value per
 * dimension, or nothing at all. The stored selector holds sets; a query holds
 * points. Keeping the two types distinct is what stops
 * `lookupRule(type, storedSelector, asOf)` from type-checking, because that call
 * asks a question nobody means.
 */
export interface RuleSelectorInput {
  commodityGroup?: CommodityGroup;
  terminalType?: TerminalType;
  handlingMode?: HandlingMode;
  wagonTypeCode?: string;
  division?: string;
}

/** The selector dimensions, in one place, so a matcher cannot forget one. */
export const RULE_SELECTOR_DIMENSIONS = [
  "commodityGroups",
  "terminalTypes",
  "handlingModes",
  "wagonTypeCodes",
  "divisions",
] as const satisfies readonly (keyof RuleSelector)[];

export type RuleSelectorDimension = (typeof RULE_SELECTOR_DIMENSIONS)[number];

/** Which query field answers which stored dimension. */
export const DIMENSION_TO_INPUT: Record<
  RuleSelectorDimension,
  keyof RuleSelectorInput
> = {
  commodityGroups: "commodityGroup",
  terminalTypes: "terminalType",
  handlingModes: "handlingMode",
  wagonTypeCodes: "wagonTypeCode",
  divisions: "division",
};

// ---------------------------------------------------------------------------
// `charge_rules.params`, by rule type.
//
// The engines that consume these arrive in Phase 9. The shapes are frozen here
// because the seed writes them now, and a rule whose params a later engine has
// to guess at is a rule that cannot be trusted to price anything.
// ---------------------------------------------------------------------------

/** `free_time` — the hours before detention starts accruing. */
export interface FreeTimeParams {
  hours: number;
}

/**
 * `demurrage` — the progressive slabs of §5.6 rule 3.
 *
 * `upToHours: null` is the open-ended final slab. Slabs are cumulative: an
 * eight-hour overstay pays six hours at ×1 and two at ×2, not eight at ×2.
 */
export interface DemurrageParams {
  slabs: { upToHours: number | null; multiplier: number }[];
  baseRatePerWagonHour: number;
}

/** `wharfage` — goods left in the terminal after the free period. */
export interface WharfageParams {
  ratePerTonneHour: number;
  freeHours: number;
}

/** `base_rate` — the distance-slab freight rate (§5.7). */
export interface BaseRateParams {
  slabs: { upToKm: number | null; ratePerTonne: number }[];
}

/** `bsc` — busy-season charge, a percentage uplift on the base freight. */
export interface PercentageParams {
  percentage: number;
}

/** `dev_charge` — development charge, levied per tonne. */
export interface PerTonneParams {
  perTonne: number;
}

/** `terminal_charge` — levied per wagon, at one end of the journey. */
export interface TerminalChargeParams {
  perWagon: number;
  side: "origin" | "destination";
}

/** The params shape each `charge_rule_type` carries. */
export interface ChargeRuleParamsByType {
  free_time: FreeTimeParams;
  demurrage: DemurrageParams;
  wharfage: WharfageParams;
  bsc: PercentageParams;
  dev_charge: PerTonneParams;
  terminal_charge: TerminalChargeParams;
  base_rate: BaseRateParams;
}

export type ChargeRuleParams =
  ChargeRuleParamsByType[keyof ChargeRuleParamsByType];

export type ParamsFor<T extends ChargeRuleType> = ChargeRuleParamsByType[T];

/**
 * The charge rule book, as versioned data.
 *
 * The set is arranged around **one fixture that later phases prove a property
 * against**: a `free_time` rule for mechanised cement at a private siding,
 * effective January to June 2026, and its replacement from July 2026 with the
 * same selector and fewer hours.
 *
 * That pair is §13.5's temporal trap. Phase 9 demonstrates — with no AI involved
 * — that re-deriving a March bill in September returns the March rule, because
 * every lookup passes an explicit `asOf` and the date filter is SQL. Delete the
 * pair and the demonstration has nothing to demonstrate, which is why the seed
 * test asserts it by circular reference.
 */
import type { ChargeRuleType } from "../../../src/schema";
import type {
  ChargeRuleParams,
  RuleSelector,
} from "../../../src/types/selector.types";

export interface ChargeRuleSeed {
  type: ChargeRuleType;
  params: ChargeRuleParams;
  selector: RuleSelector;
  effectiveFrom: string;
  effectiveTo?: string | null;
  circularRef: string;
  clauseRef?: string;
  version?: number;
}

/** The two halves of the temporal fixture, named so tests cannot mistype them. */
export const SUPERSEDED_FREE_TIME_REF = "RC-11/2025";
export const SUPERSEDING_FREE_TIME_REF = "RC-14/2026";

export const CHARGE_RULES: ChargeRuleSeed[] = [
  // ---- free time ---------------------------------------------------------
  //
  // The temporal-trap pair. Same selector, adjacent windows, different hours.
  {
    type: "free_time",
    params: { hours: 9 },
    selector: {
      v: 1,
      commodityGroups: ["cement"],
      terminalTypes: ["private_siding"],
      handlingModes: ["mechanised"],
    },
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-06-30",
    circularRef: SUPERSEDED_FREE_TIME_REF,
    clauseRef: "3.2(a)",
    version: 1,
  },
  {
    type: "free_time",
    params: { hours: 7 },
    selector: {
      v: 1,
      commodityGroups: ["cement"],
      terminalTypes: ["private_siding"],
      handlingModes: ["mechanised"],
    },
    effectiveFrom: "2026-07-01",
    effectiveTo: null,
    circularRef: SUPERSEDING_FREE_TIME_REF,
    clauseRef: "3.2(a)",
    version: 1,
  },

  // The zone-wide default. Matches everything — `{ v: 1 }` names no dimension —
  // and therefore loses to every rule above on specificity. This is what a
  // "default" looks like under D8.
  {
    type: "free_time",
    params: { hours: 11 },
    selector: { v: 1 },
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    circularRef: "GT-45/II",
    clauseRef: "3.1",
    version: 1,
  },
  {
    type: "free_time",
    params: { hours: 12 },
    selector: { v: 1, handlingModes: ["manual"] },
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    circularRef: "GT-45/II",
    clauseRef: "3.1(b)",
    version: 1,
  },
  {
    type: "free_time",
    params: { hours: 6 },
    selector: {
      v: 1,
      commodityGroups: ["coal"],
      terminalTypes: ["private_siding"],
      handlingModes: ["mechanised"],
    },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-06/2025",
    clauseRef: "3.4",
    version: 1,
  },
  {
    type: "free_time",
    params: { hours: 8 },
    selector: { v: 1, commodityGroups: ["petroleum"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-06/2025",
    clauseRef: "3.5",
    version: 1,
  },
  {
    type: "free_time",
    params: { hours: 10 },
    selector: {
      v: 1,
      commodityGroups: ["foodgrain"],
      terminalTypes: ["goods_shed"],
    },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-06/2025",
    clauseRef: "3.6",
    version: 1,
  },
  {
    type: "free_time",
    params: { hours: 9 },
    selector: { v: 1, terminalTypes: ["port"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-06/2025",
    clauseRef: "3.7",
    version: 1,
  },
  // A version bump rather than a date change: same window, same selector,
  // higher version. This is the *other* tie-break the resolver has to get right.
  {
    type: "free_time",
    params: { hours: 8 },
    selector: { v: 1, divisions: ["Solapur"], handlingModes: ["mixed"] },
    effectiveFrom: "2025-10-01",
    effectiveTo: null,
    circularRef: "ZI-SUR-02/2025",
    clauseRef: "1",
    version: 1,
  },
  {
    type: "free_time",
    params: { hours: 7 },
    selector: { v: 1, divisions: ["Solapur"], handlingModes: ["mixed"] },
    effectiveFrom: "2025-10-01",
    effectiveTo: null,
    circularRef: "ZI-SUR-02/2025 rev.2",
    clauseRef: "1",
    version: 2,
  },

  // ---- demurrage ---------------------------------------------------------
  {
    type: "demurrage",
    params: {
      // Progressive: the first six hours cost once, the next six twice, and
      // everything after that three times. §5.6 rule 3.
      slabs: [
        { upToHours: 6, multiplier: 1 },
        { upToHours: 12, multiplier: 2 },
        { upToHours: null, multiplier: 3 },
      ],
      baseRatePerWagonHour: 150,
    },
    selector: { v: 1 },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-09/2025",
    clauseRef: "4.1",
    version: 1,
  },
  {
    type: "demurrage",
    params: {
      slabs: [
        { upToHours: 6, multiplier: 1 },
        { upToHours: null, multiplier: 2.5 },
      ],
      baseRatePerWagonHour: 210,
    },
    selector: { v: 1, terminalTypes: ["port"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-09/2025",
    clauseRef: "4.3",
    version: 1,
  },
  {
    type: "demurrage",
    params: {
      slabs: [
        { upToHours: 12, multiplier: 1 },
        { upToHours: null, multiplier: 2 },
      ],
      baseRatePerWagonHour: 120,
    },
    selector: { v: 1, commodityGroups: ["foodgrain"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-09/2025",
    clauseRef: "4.4",
    version: 1,
  },
  // A rule that has already expired. Nothing should ever return it for a date
  // after mid-2025 — and `/resolve` must still name it in the rejected list,
  // because "the rule you were thinking of ended in June" is the most useful
  // answer this endpoint gives.
  {
    type: "demurrage",
    params: {
      slabs: [{ upToHours: null, multiplier: 1 }],
      baseRatePerWagonHour: 100,
    },
    selector: { v: 1 },
    effectiveFrom: "2023-04-01",
    effectiveTo: "2025-03-31",
    circularRef: "RC-03/2023",
    clauseRef: "4.1",
    version: 1,
  },

  // ---- wharfage ----------------------------------------------------------
  {
    type: "wharfage",
    params: { ratePerTonneHour: 2.5, freeHours: 12 },
    selector: { v: 1 },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-09/2025",
    clauseRef: "5.1",
    version: 1,
  },
  {
    type: "wharfage",
    params: { ratePerTonneHour: 4.0, freeHours: 6 },
    selector: { v: 1, terminalTypes: ["port"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-09/2025",
    clauseRef: "5.2",
    version: 1,
  },

  // ---- base rate ---------------------------------------------------------
  {
    type: "base_rate",
    params: {
      slabs: [
        { upToKm: 100, ratePerTonne: 420 },
        { upToKm: 250, ratePerTonne: 690 },
        { upToKm: 500, ratePerTonne: 1180 },
        { upToKm: null, ratePerTonne: 1640 },
      ],
    },
    selector: { v: 1 },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-01/2025",
    clauseRef: "2.1",
    version: 1,
  },
  {
    type: "base_rate",
    params: {
      slabs: [
        { upToKm: 100, ratePerTonne: 365 },
        { upToKm: 250, ratePerTonne: 590 },
        { upToKm: 500, ratePerTonne: 980 },
        { upToKm: null, ratePerTonne: 1350 },
      ],
    },
    selector: { v: 1, commodityGroups: ["foodgrain"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-01/2025",
    clauseRef: "2.4",
    version: 1,
  },
  {
    type: "base_rate",
    params: {
      slabs: [
        { upToKm: 100, ratePerTonne: 470 },
        { upToKm: 250, ratePerTonne: 780 },
        { upToKm: 500, ratePerTonne: 1320 },
        { upToKm: null, ratePerTonne: 1810 },
      ],
    },
    selector: { v: 1, commodityGroups: ["petroleum"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-01/2025",
    clauseRef: "2.5",
    version: 1,
  },
  {
    type: "base_rate",
    params: {
      slabs: [
        { upToKm: 100, ratePerTonne: 445 },
        { upToKm: 250, ratePerTonne: 725 },
        { upToKm: 500, ratePerTonne: 1240 },
        { upToKm: null, ratePerTonne: 1720 },
      ],
    },
    selector: { v: 1, commodityGroups: ["cement"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-01/2025",
    clauseRef: "2.2",
    version: 1,
  },
  // Last year's tariff, superseded by RC-01/2025 above. Kept because
  // re-deriving a 2024 invoice must find it.
  {
    type: "base_rate",
    params: {
      slabs: [
        { upToKm: 100, ratePerTonne: 390 },
        { upToKm: 250, ratePerTonne: 640 },
        { upToKm: 500, ratePerTonne: 1090 },
        { upToKm: null, ratePerTonne: 1510 },
      ],
    },
    selector: { v: 1 },
    effectiveFrom: "2024-04-01",
    effectiveTo: "2025-03-31",
    circularRef: "RC-01/2024",
    clauseRef: "2.1",
    version: 1,
  },

  // ---- busy season charge -------------------------------------------------
  //
  // Seasonal by construction: three windows, one per year, none open-ended.
  // A `bsc` lookup in April must find nothing, and that is correct.
  {
    type: "bsc",
    params: { percentage: 15 },
    selector: { v: 1 },
    effectiveFrom: "2025-10-01",
    effectiveTo: "2026-06-30",
    circularRef: "RC-12/2025",
    clauseRef: "6.1",
    version: 1,
  },
  {
    type: "bsc",
    params: { percentage: 15 },
    selector: { v: 1 },
    effectiveFrom: "2026-10-01",
    effectiveTo: "2027-06-30",
    circularRef: "RC-12/2026",
    clauseRef: "6.1",
    version: 1,
  },
  {
    type: "bsc",
    params: { percentage: 0 },
    selector: { v: 1, commodityGroups: ["foodgrain"] },
    effectiveFrom: "2025-10-01",
    effectiveTo: "2026-06-30",
    circularRef: "RC-12/2025",
    clauseRef: "6.2",
    version: 1,
  },

  // ---- development charge -------------------------------------------------
  {
    type: "dev_charge",
    params: { perTonne: 20 },
    selector: { v: 1 },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-02/2025",
    clauseRef: "7.1",
    version: 1,
  },
  {
    type: "dev_charge",
    params: { perTonne: 35 },
    selector: { v: 1, terminalTypes: ["pft", "port"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-02/2025",
    clauseRef: "7.2",
    version: 1,
  },

  // ---- terminal charge ----------------------------------------------------
  {
    type: "terminal_charge",
    params: { perWagon: 750, side: "origin" },
    selector: { v: 1, terminalTypes: ["goods_shed"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-02/2025",
    clauseRef: "8.1",
    version: 1,
  },
  {
    type: "terminal_charge",
    params: { perWagon: 750, side: "destination" },
    selector: { v: 1, terminalTypes: ["goods_shed"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-02/2025",
    clauseRef: "8.2",
    version: 1,
  },
  {
    type: "terminal_charge",
    params: { perWagon: 1100, side: "origin" },
    selector: { v: 1, terminalTypes: ["pft"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-02/2025",
    clauseRef: "8.3",
    version: 1,
  },
  {
    type: "terminal_charge",
    params: { perWagon: 1400, side: "destination" },
    selector: { v: 1, terminalTypes: ["port"] },
    effectiveFrom: "2025-04-01",
    effectiveTo: null,
    circularRef: "RC-02/2025",
    clauseRef: "8.4",
    version: 1,
  },
];

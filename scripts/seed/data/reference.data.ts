/**
 * Global reference data: commodities and wagon types.
 *
 * Both are catalogues, not tenant data, so they are seeded once and shared. The
 * IRCA class and minimum-weight condition on each commodity are what Phase 10's
 * `ratePerTonne` reads; the commodity groups on each wagon type are what Phase
 * 7's compatibility filter reads. Neither is decorative.
 */
import type { CommodityGroup } from "../../../src/schema";

export interface CommoditySeed {
  code: string;
  name: string;
  group: CommodityGroup;
  class: string;
  minWeightCondition: string;
  isHazardous?: boolean;
}

export const COMMODITIES: CommoditySeed[] = [
  {
    code: "CEM",
    name: "Cement (bagged)",
    group: "cement",
    class: "140",
    // Charged on carrying capacity plus the 8-tonne and 2-tonne uplifts —
    // an under-loaded cement rake still pays for the wagon it occupied.
    minWeightCondition: "CC+8+2",
  },
  {
    code: "COAL",
    name: "Coal (non-coking)",
    group: "coal",
    class: "150",
    minWeightCondition: "CC+8+2",
  },
  {
    code: "STL",
    name: "Steel coils and billets",
    group: "steel",
    class: "165",
    minWeightCondition: "CC",
  },
  {
    code: "FOOD",
    name: "Foodgrain",
    group: "foodgrain",
    // The lowest class in the seed: foodgrain is rate-protected, and Phase 10's
    // rating engine needs at least one commodity where that shows.
    class: "100",
    minWeightCondition: "permissible",
  },
  {
    code: "FERT",
    name: "Fertiliser (urea, DAP)",
    group: "fertiliser",
    class: "120",
    minWeightCondition: "CC+8+2",
  },
  {
    code: "POL",
    name: "Petroleum, oil and lubricants",
    group: "petroleum",
    class: "LR1",
    minWeightCondition: "CC",
    isHazardous: true,
  },
];

export interface WagonTypeSeed {
  code: string;
  name: string;
  tareT: number;
  ccT: number;
  ccPlus82T: number;
  commodityGroups: CommodityGroup[];
  lengthM: number;
  isCovered?: boolean;
}

export const WAGON_TYPES: WagonTypeSeed[] = [
  {
    code: "BOXNHL",
    name: "BOXNHL open bogie wagon",
    tareT: 20.6,
    ccT: 71.0,
    ccPlus82T: 81.0,
    commodityGroups: ["coal", "steel", "other"],
    lengthM: 10.71,
  },
  {
    code: "BCNA",
    name: "BCNA covered bogie wagon",
    tareT: 23.0,
    ccT: 61.0,
    ccPlus82T: 71.0,
    commodityGroups: ["cement", "foodgrain", "fertiliser"],
    lengthM: 14.24,
    isCovered: true,
  },
  {
    code: "BCNHL",
    name: "BCNHL covered bogie wagon (high capacity)",
    tareT: 20.4,
    ccT: 65.6,
    ccPlus82T: 75.6,
    commodityGroups: ["cement", "foodgrain", "fertiliser"],
    lengthM: 13.44,
    isCovered: true,
  },
  {
    code: "BTPN",
    name: "BTPN tank wagon",
    tareT: 25.8,
    ccT: 58.0,
    ccPlus82T: 58.0,
    commodityGroups: ["petroleum"],
    lengthM: 12.13,
  },
  {
    code: "BLC",
    name: "BLC container flat wagon",
    tareT: 20.0,
    ccT: 60.0,
    ccPlus82T: 60.0,
    commodityGroups: ["container"],
    lengthM: 13.71,
  },
  {
    code: "BOST",
    name: "BOST open steel-carrying wagon",
    tareT: 21.5,
    ccT: 69.5,
    ccPlus82T: 79.5,
    commodityGroups: ["steel", "other"],
    lengthM: 10.94,
  },
  {
    code: "BOBRN",
    name: "BOBRN bottom-discharge hopper",
    tareT: 22.4,
    ccT: 67.6,
    ccPlus82T: 77.6,
    commodityGroups: ["coal"],
    lengthM: 10.03,
  },
  {
    code: "BRN",
    name: "BRN rail-and-plate flat wagon",
    tareT: 21.9,
    ccT: 63.1,
    ccPlus82T: 63.1,
    commodityGroups: ["steel", "other"],
    lengthM: 13.32,
  },
];

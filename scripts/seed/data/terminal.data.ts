/**
 * Twelve terminals across the belt.
 *
 * One of them is **deliberately congested** — `KWV-GS` has a single placement
 * line and a four-hour average placement. Phase 8's discrete-event simulation
 * models placement lines as servers, and a network where every terminal has
 * spare capacity produces no queue, which makes the congestion twin a screen
 * with nothing on it. See `CONGESTED_TERMINAL_CODE`.
 */
import type {
  CommodityGroup,
  HandlingMode,
  TerminalType,
} from "../../../src/schema";

export interface TerminalSeed {
  code: string;
  name: string;
  stationCode: string;
  type: TerminalType;
  placementLines: number;
  isMechanised: boolean;
  handlingMode: HandlingMode;
  commodityGroups: CommodityGroup[];
  maxRakeLength: number;
  avgPlacementMinutes: number;
}

/** The queue Phase 8 needs. Asserted by the seed test so it cannot be tuned away. */
export const CONGESTED_TERMINAL_CODE = "KWV-GS";

export const TERMINALS: TerminalSeed[] = [
  {
    code: "KWV-GS",
    name: "Kurduvadi Goods Shed",
    stationCode: "KWV",
    type: "goods_shed",
    // One line, four hours a placement: the bottleneck the whole congestion
    // story is told against.
    placementLines: 1,
    isMechanised: false,
    handlingMode: "manual",
    commodityGroups: ["cement", "foodgrain", "fertiliser"],
    maxRakeLength: 42,
    avgPlacementMinutes: 240,
  },
  {
    code: "SUR-PFT",
    name: "Solapur Private Freight Terminal",
    stationCode: "SUR",
    type: "pft",
    placementLines: 4,
    isMechanised: true,
    handlingMode: "mechanised",
    commodityGroups: ["cement", "steel", "container", "other"],
    maxRakeLength: 58,
    avgPlacementMinutes: 65,
  },
  {
    code: "HG-SDG",
    name: "Hotgi Cement Siding",
    stationCode: "HG",
    type: "private_siding",
    placementLines: 2,
    isMechanised: true,
    handlingMode: "mechanised",
    commodityGroups: ["cement"],
    maxRakeLength: 58,
    avgPlacementMinutes: 55,
  },
  {
    code: "PUNE-GS",
    name: "Pune Goods Shed",
    stationCode: "PUNE",
    type: "goods_shed",
    placementLines: 3,
    isMechanised: false,
    handlingMode: "mixed",
    commodityGroups: ["foodgrain", "fertiliser", "other"],
    maxRakeLength: 45,
    avgPlacementMinutes: 130,
  },
  {
    code: "DD-SDG",
    name: "Daund Fertiliser Siding",
    stationCode: "DD",
    type: "private_siding",
    placementLines: 2,
    isMechanised: false,
    handlingMode: "manual",
    commodityGroups: ["fertiliser", "foodgrain"],
    maxRakeLength: 42,
    avgPlacementMinutes: 175,
  },
  {
    code: "JNPT-PORT",
    name: "JNPT Container Terminal",
    stationCode: "JNPT",
    type: "port",
    placementLines: 6,
    isMechanised: true,
    handlingMode: "mechanised",
    commodityGroups: ["container", "other"],
    maxRakeLength: 58,
    avgPlacementMinutes: 45,
  },
  {
    code: "PNVL-PFT",
    name: "Panvel Freight Terminal",
    stationCode: "PNVL",
    type: "pft",
    placementLines: 3,
    isMechanised: true,
    handlingMode: "mechanised",
    commodityGroups: ["container", "steel", "cement"],
    maxRakeLength: 58,
    avgPlacementMinutes: 70,
  },
  {
    code: "NGP-GS",
    name: "Nagpur Goods Shed",
    stationCode: "NGP",
    type: "goods_shed",
    placementLines: 3,
    isMechanised: false,
    handlingMode: "mixed",
    commodityGroups: ["steel", "foodgrain", "other"],
    maxRakeLength: 45,
    avgPlacementMinutes: 145,
  },
  {
    code: "BPQ-SDG",
    name: "Ballarshah Colliery Siding",
    stationCode: "BPQ",
    type: "private_siding",
    placementLines: 4,
    isMechanised: true,
    handlingMode: "mechanised",
    commodityGroups: ["coal"],
    maxRakeLength: 58,
    avgPlacementMinutes: 50,
  },
  {
    code: "CD-SDG",
    name: "Chandrapur Power Siding",
    stationCode: "CD",
    type: "private_siding",
    placementLines: 2,
    isMechanised: true,
    handlingMode: "mechanised",
    commodityGroups: ["coal"],
    maxRakeLength: 58,
    avgPlacementMinutes: 60,
  },
  {
    code: "AK-GS",
    name: "Akola Goods Shed",
    stationCode: "AK",
    type: "goods_shed",
    placementLines: 2,
    isMechanised: false,
    handlingMode: "manual",
    commodityGroups: ["foodgrain", "fertiliser"],
    maxRakeLength: 42,
    avgPlacementMinutes: 190,
  },
  {
    code: "MRJ-SDG",
    name: "Miraj POL Siding",
    stationCode: "MRJ",
    type: "private_siding",
    placementLines: 2,
    isMechanised: true,
    handlingMode: "mechanised",
    commodityGroups: ["petroleum"],
    maxRakeLength: 50,
    avgPlacementMinutes: 85,
  },
];

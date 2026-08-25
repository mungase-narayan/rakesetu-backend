/**
 * Network module type contracts.
 */
import type {
  ChargeableDistance,
  LineType,
  NewChargeableDistance,
  NewSection,
  NewStation,
  Section,
  Station,
} from "../../../schema";
import type { PaginateOptions } from "../../../types/pagination.types";
import type { PathResult } from "../services/graph";

export type {
  Station,
  NewStation,
  Section,
  NewSection,
  ChargeableDistance,
  NewChargeableDistance,
  PathResult,
};

export interface IListStationsQuery extends Partial<PaginateOptions> {
  /** Matches code or name, case-insensitively. */
  search?: string;
  division?: string;
  zone?: string;
}

export interface IListSectionsQuery extends Partial<PaginateOptions> {
  fromCode?: string;
  toCode?: string;
  lineType?: LineType;
}

export interface IListChargeableDistancesQuery extends Partial<PaginateOptions> {
  fromCode?: string;
  toCode?: string;
}

/** Which number the caller is asking for. There is no default — see distance.service. */
export type DistanceBasis = "tariff" | "operational";

export interface DistanceResponse {
  from: string;
  to: string;
  km: number;
  basis: DistanceBasis;
  /** Present only for `operational` — the tariff distance has no path to show. */
  path?: PathResult;
}

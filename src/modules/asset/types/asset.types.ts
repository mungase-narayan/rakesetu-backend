/**
 * Asset module type contracts — wagon types, wagons, rakes, compositions.
 */
import type {
  CommodityGroup,
  NewRake,
  NewWagon,
  NewWagonType,
  Rake,
  RakeComposition,
  RakeState,
  Wagon,
  WagonStatus,
  WagonType,
} from "../../../schema";
import type { PaginateOptions } from "../../../types/pagination.types";

export type {
  WagonType,
  NewWagonType,
  Wagon,
  NewWagon,
  Rake,
  NewRake,
  RakeComposition,
};

export interface IListWagonTypesQuery extends Partial<PaginateOptions> {
  search?: string;
  commodityGroup?: CommodityGroup;
}

export interface IListWagonsQuery extends Partial<PaginateOptions> {
  search?: string;
  status?: WagonStatus;
  typeCode?: string;
  /** "What comes due for overhaul before this date" — the maintenance screen. */
  pohDueBefore?: Date;
}

export interface IListRakesQuery extends Partial<PaginateOptions> {
  search?: string;
  state?: RakeState;
  station?: string;
  wagonType?: string;
  division?: string;
  isActive?: boolean;
}

/**
 * What the Phase 7 solver asks about a rake before it will allot it.
 *
 * Every field is derived from the composition **valid at a moment**, never from
 * "the wagons currently attached" — see `getRakeConstraints`.
 */
export interface RakeConstraints {
  rakeId: string;
  at: Date;
  /** The earliest overhaul date across the composition — the binding one. */
  earliestPohDue: Date | null;
  earliestFitnessDue: Date | null;
  wagonCount: number;
  totalLengthM: number;
}

/** One row of the composition, with the wagon it names. */
export interface CompositionEntry {
  id: string;
  position: number;
  fromTs: Date;
  toTs: Date | null;
  wagonId: string;
  wagonNumber: string;
  typeCode: string;
  pohDueOn: string;
  fitnessDueOn: string;
  status: WagonStatus;
}

/** `PUT /rakes/:id/composition` — positions are implied by array order. */
export interface IReplaceCompositionBody {
  wagonIds: string[];
  /** Defaults to now. Explicit when backfilling a change that already happened. */
  effectiveFrom?: string;
}

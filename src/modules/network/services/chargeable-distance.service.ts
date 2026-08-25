/**
 * chargeable_distances CRUD — the tariff table.
 *
 * Bulk-first by design: tariff distances arrive as a published table of
 * hundreds of pairs, not as one-at-a-time entries, so `createMany` is the
 * primary path and the single-row create exists for corrections.
 *
 * There is no `update` beyond correcting a typo and no recomputation anywhere.
 * A distance in here came out of a circular, and the only legitimate source of
 * a new value is a newer circular.
 */
import { and, asc, eq, type SQL } from "drizzle-orm";

import { chargeableDistances } from "../../../schema";
import { UnscopedRepository } from "../../../database/scoped-repository";
import type { DB } from "../../../database/connection";
import type {
  ChargeableDistance,
  IListChargeableDistancesQuery,
  NewChargeableDistance,
} from "../types/network.types";

class ChargeableDistanceService {
  private readonly repo: UnscopedRepository<typeof chargeableDistances>;

  constructor(database?: DB) {
    this.repo = new UnscopedRepository(
      chargeableDistances,
      chargeableDistances.id,
      database,
    );
  }

  async list(query: IListChargeableDistancesQuery = {}) {
    return this.repo.paginate(
      {
        ...query,
        sort: query.sort ?? "fromCode",
        order: query.order ?? "asc",
      },
      this.filters(query),
    );
  }

  async listAll(): Promise<ChargeableDistance[]> {
    return this.repo.select(undefined, asc(chargeableDistances.fromCode));
  }

  async create(values: NewChargeableDistance): Promise<ChargeableDistance> {
    return this.repo.insert(this.normalise(values));
  }

  /** The bulk POST. A tariff table is loaded, not typed. */
  async createMany(
    values: NewChargeableDistance[],
  ): Promise<ChargeableDistance[]> {
    return this.repo.insertMany(values.map((value) => this.normalise(value)));
  }

  async findPair(
    fromCode: string,
    toCode: string,
  ): Promise<ChargeableDistance | null> {
    return this.repo.selectOne(
      and(
        eq(chargeableDistances.fromCode, fromCode.toUpperCase()),
        eq(chargeableDistances.toCode, toCode.toUpperCase()),
      ) as SQL,
    );
  }

  private normalise(values: NewChargeableDistance): NewChargeableDistance {
    return {
      ...values,
      fromCode: values.fromCode.toUpperCase(),
      toCode: values.toCode.toUpperCase(),
    };
  }

  private filters(query: IListChargeableDistancesQuery): SQL | undefined {
    const conditions: SQL[] = [];
    if (query.fromCode) {
      conditions.push(
        eq(chargeableDistances.fromCode, query.fromCode.toUpperCase()),
      );
    }
    if (query.toCode) {
      conditions.push(
        eq(chargeableDistances.toCode, query.toCode.toUpperCase()),
      );
    }
    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default ChargeableDistanceService;

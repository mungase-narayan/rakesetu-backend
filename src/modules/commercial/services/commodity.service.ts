/**
 * commodities CRUD.
 *
 * Global reference data (`UnscopedRepository`, keyed by `code`): the IRCA class
 * of cement is published by IR, not decided per tenant.
 *
 * `class` and `min_weight_condition` are required on write and there is no
 * default for either. A commodity with a blank class prices at zero in Phase
 * 10, which is a silent revenue error rather than a visible one — refusing the
 * write is the only place that failure is cheap.
 */
import { and, asc, eq, ilike, or, type SQL } from "drizzle-orm";

import { commodities } from "../../../schema";
import { UnscopedRepository } from "../../../database/scoped-repository";
import type { DB } from "../../../database/connection";
import type {
  Commodity,
  IListCommoditiesQuery,
  NewCommodity,
} from "../types/commercial.types";

class CommodityService {
  private readonly repo: UnscopedRepository<typeof commodities>;

  constructor(database?: DB) {
    this.repo = new UnscopedRepository(commodities, commodities.code, database);
  }

  async list(query: IListCommoditiesQuery = {}) {
    return this.repo.paginate(
      { ...query, sort: query.sort ?? "code", order: query.order ?? "asc" },
      this.filters(query),
    );
  }

  async listAll(): Promise<Commodity[]> {
    return this.repo.select(undefined, asc(commodities.code));
  }

  async findByCode(code: string): Promise<Commodity | null> {
    return this.repo.findByKey(code.toUpperCase());
  }

  async create(values: NewCommodity): Promise<Commodity> {
    return this.repo.insert({ ...values, code: values.code.toUpperCase() });
  }

  async update(
    code: string,
    values: Partial<NewCommodity>,
  ): Promise<Commodity | null> {
    // The code is the key that `customer_sidings.commodity_codes[]` and every
    // indent point at; it is not editable.
    const { code: _ignored, ...patch } = values;
    return this.repo.update(code.toUpperCase(), patch);
  }

  private filters(query: IListCommoditiesQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        or(
          ilike(commodities.code, pattern),
          ilike(commodities.name, pattern),
        ) as SQL,
      );
    }
    if (query.group) conditions.push(eq(commodities.group, query.group));
    if (query.isHazardous !== undefined) {
      conditions.push(eq(commodities.isHazardous, query.isHazardous));
    }

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default CommodityService;

/**
 * wagon_types CRUD — the global wagon catalogue.
 *
 * `UnscopedRepository`, keyed by `code`: a BOXNHL has the same tare weight in
 * every zone, and a per-tenant copy of the catalogue would be a data-duplication
 * bug dressed up as a security model.
 */
import { and, asc, ilike, or, sql, type SQL } from "drizzle-orm";

import { wagonTypes } from "../../../schema";
import { UnscopedRepository } from "../../../database/scoped-repository";
import type { DB } from "../../../database/connection";
import type {
  IListWagonTypesQuery,
  NewWagonType,
  WagonType,
} from "../types/asset.types";

class WagonTypeService {
  private readonly repo: UnscopedRepository<typeof wagonTypes>;

  constructor(database?: DB) {
    this.repo = new UnscopedRepository(wagonTypes, wagonTypes.code, database);
  }

  async list(query: IListWagonTypesQuery = {}) {
    return this.repo.paginate(
      { ...query, sort: query.sort ?? "code", order: query.order ?? "asc" },
      this.filters(query),
    );
  }

  async listAll(): Promise<WagonType[]> {
    return this.repo.select(undefined, asc(wagonTypes.code));
  }

  async findByCode(code: string): Promise<WagonType | null> {
    return this.repo.findByKey(code.toUpperCase());
  }

  async create(values: NewWagonType): Promise<WagonType> {
    return this.repo.insert({ ...values, code: values.code.toUpperCase() });
  }

  async update(
    code: string,
    values: Partial<NewWagonType>,
  ): Promise<WagonType | null> {
    const { code: _ignored, ...patch } = values;
    return this.repo.update(code.toUpperCase(), patch);
  }

  private filters(query: IListWagonTypesQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        or(
          ilike(wagonTypes.code, pattern),
          ilike(wagonTypes.name, pattern),
        ) as SQL,
      );
    }
    if (query.commodityGroup) {
      // Array containment, evaluated in SQL. Fetching every type and filtering
      // in JS would be the same answer and a different amount of work.
      conditions.push(
        sql`${wagonTypes.commodityGroups} @> ARRAY[${query.commodityGroup}]::commodity_group[]`,
      );
    }

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default WagonTypeService;

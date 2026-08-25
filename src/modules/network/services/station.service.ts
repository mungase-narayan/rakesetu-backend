/**
 * stations CRUD.
 *
 * `UnscopedRepository`, keyed by `code` — stations are global reference data
 * (see the schema file). The class is the conspicuous marker that this is a
 * deliberate choice and not a forgotten `org_id`.
 */
import { and, asc, eq, ilike, or, type SQL } from "drizzle-orm";

import { stations } from "../../../schema";
import { UnscopedRepository } from "../../../database/scoped-repository";
import type { DB } from "../../../database/connection";
import type {
  IListStationsQuery,
  NewStation,
  Station,
} from "../types/network.types";

class StationService {
  private readonly repo: UnscopedRepository<typeof stations>;

  constructor(database?: DB) {
    this.repo = new UnscopedRepository(stations, stations.code, database);
  }

  async list(query: IListStationsQuery = {}) {
    return this.repo.paginate(
      { ...query, sort: query.sort ?? "code", order: query.order ?? "asc" },
      this.filters(query),
    );
  }

  /** Every station, ordered — for the map, the seed and the CSV export. */
  async listAll(): Promise<Station[]> {
    return this.repo.select(undefined, asc(stations.code));
  }

  async findByCode(code: string): Promise<Station | null> {
    return this.repo.findByKey(code.toUpperCase());
  }

  async create(values: NewStation): Promise<Station> {
    return this.repo.insert({ ...values, code: values.code.toUpperCase() });
  }

  async update(
    code: string,
    values: Partial<NewStation>,
  ): Promise<Station | null> {
    // `code` is the primary key and half the foreign keys in the schema point
    // at it. Renaming a station is a data-migration, not a PATCH.
    const { code: _ignored, ...patch } = values;
    return this.repo.update(code.toUpperCase(), patch);
  }

  private filters(query: IListStationsQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        or(ilike(stations.code, pattern), ilike(stations.name, pattern)) as SQL,
      );
    }
    if (query.division) conditions.push(eq(stations.division, query.division));
    if (query.zone) conditions.push(eq(stations.zone, query.zone));

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default StationService;

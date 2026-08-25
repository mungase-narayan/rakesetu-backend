/**
 * wagons — the physical register. Tenant-scoped.
 */
import { and, asc, eq, ilike, lte, type SQL } from "drizzle-orm";

import { wagons, type Wagon } from "../../../schema";
import { db, type DB } from "../../../database/connection";
import {
  ScopedRepository,
  type ScopedInsert,
} from "../../../database/scoped-repository";
import type { IListWagonsQuery } from "../types/asset.types";

/** Postgres `date` columns are read and written as `YYYY-MM-DD` strings. */
const toDateString = (value: Date): string => value.toISOString().slice(0, 10);

class WagonService {
  constructor(private readonly database: DB = db) {}

  private repo(orgId: string) {
    return new ScopedRepository(wagons, orgId, this.database);
  }

  async list(orgId: string, query: IListWagonsQuery = {}) {
    return this.repo(orgId).paginate(
      { ...query, sort: query.sort ?? "number", order: query.order ?? "asc" },
      this.filters(query),
    );
  }

  async findById(orgId: string, id: string): Promise<Wagon | null> {
    return this.repo(orgId).findById(id);
  }

  async create(
    orgId: string,
    values: ScopedInsert<typeof wagons>,
  ): Promise<Wagon> {
    return this.repo(orgId).insert({
      ...values,
      number: values.number.toUpperCase(),
      typeCode: values.typeCode.toUpperCase(),
    });
  }

  async update(
    orgId: string,
    id: string,
    values: Partial<ScopedInsert<typeof wagons>>,
  ): Promise<Wagon | null> {
    return this.repo(orgId).update(id, values);
  }

  private filters(query: IListWagonsQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.search) {
      conditions.push(ilike(wagons.number, `%${query.search}%`));
    }
    if (query.status) conditions.push(eq(wagons.status, query.status));
    if (query.typeCode) {
      conditions.push(eq(wagons.typeCode, query.typeCode.toUpperCase()));
    }
    if (query.pohDueBefore) {
      conditions.push(lte(wagons.pohDueOn, toDateString(query.pohDueBefore)));
    }

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }

  /** Ordered by number — the CSV export and the composition picker both want it. */
  async listAll(orgId: string): Promise<Wagon[]> {
    return this.repo(orgId).select(undefined, asc(wagons.number));
  }
}

export default WagonService;

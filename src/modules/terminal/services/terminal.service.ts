/**
 * terminals — zone-owned, so `ScopedRepository`.
 */
import { and, asc, eq, ilike, or, sql, type SQL } from "drizzle-orm";

import { terminals, type Terminal } from "../../../schema";
import { db, type DB } from "../../../database/connection";
import {
  ScopedRepository,
  type ScopedInsert,
} from "../../../database/scoped-repository";
import type { IListTerminalsQuery } from "../types/terminal.types";

class TerminalService {
  constructor(private readonly database: DB = db) {}

  private repo(orgId: string) {
    return new ScopedRepository(terminals, orgId, this.database);
  }

  async list(orgId: string, query: IListTerminalsQuery = {}) {
    return this.repo(orgId).paginate(
      { ...query, sort: query.sort ?? "name", order: query.order ?? "asc" },
      this.filters(query),
    );
  }

  async listAll(orgId: string): Promise<Terminal[]> {
    return this.repo(orgId).select(undefined, asc(terminals.name));
  }

  async findById(orgId: string, id: string): Promise<Terminal | null> {
    return this.repo(orgId).findById(id);
  }

  async create(
    orgId: string,
    values: ScopedInsert<typeof terminals>,
  ): Promise<Terminal> {
    return this.repo(orgId).insert({
      ...values,
      code: values.code.toUpperCase(),
      stationCode: values.stationCode.toUpperCase(),
    });
  }

  async update(
    orgId: string,
    id: string,
    values: Partial<ScopedInsert<typeof terminals>>,
  ): Promise<Terminal | null> {
    return this.repo(orgId).update(id, values);
  }

  private filters(query: IListTerminalsQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        or(
          ilike(terminals.code, pattern),
          ilike(terminals.name, pattern),
        ) as SQL,
      );
    }
    if (query.type) conditions.push(eq(terminals.type, query.type));
    if (query.stationCode) {
      conditions.push(
        eq(terminals.stationCode, query.stationCode.toUpperCase()),
      );
    }
    if (query.commodityGroup) {
      conditions.push(
        sql`${terminals.commodityGroups} @> ARRAY[${query.commodityGroup}]::commodity_group[]`,
      );
    }
    if (query.isActive !== undefined) {
      conditions.push(eq(terminals.isActive, query.isActive));
    }

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default TerminalService;

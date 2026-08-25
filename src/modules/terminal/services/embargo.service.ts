/**
 * embargoes — zone-owned, `ScopedRepository`, and the one master-data resource
 * whose writes belong to the **Freight Controller** rather than the admin (§7).
 *
 * Every read decorates the row with `describeScope()`, so the sentence a
 * controller reads on screen is produced by the same code that Phase 7's
 * feasibility filter will match with. A scope and its description cannot drift,
 * because there is only one of them.
 */
import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import { embargoes, type Embargo } from "../../../schema";
import { db, type DB } from "../../../database/connection";
import {
  ScopedRepository,
  type ScopedInsert,
} from "../../../database/scoped-repository";
import type { EmbargoScope } from "../../../types/selector.types";
import type {
  EmbargoWithSummary,
  IListEmbargoesQuery,
} from "../types/terminal.types";
import { assertScopeVersion, describeScope } from "./embargo-scope";

class EmbargoService {
  constructor(private readonly database: DB = db) {}

  private repo(orgId: string) {
    return new ScopedRepository(embargoes, orgId, this.database);
  }

  private decorate(row: Embargo): EmbargoWithSummary {
    return { ...row, summary: describeScope(row.scope) };
  }

  async list(orgId: string, query: IListEmbargoesQuery = {}) {
    const page = await this.repo(orgId).paginate(
      { ...query, sort: query.sort ?? "fromTs", order: query.order ?? "desc" },
      this.filters(query),
    );
    return { ...page, data: page.data.map((row) => this.decorate(row)) };
  }

  /**
   * Everything in force at an instant. This is the read Phase 7's solver makes
   * once per run, before it starts filtering candidates.
   */
  async listActiveAt(orgId: string, at: Date): Promise<EmbargoWithSummary[]> {
    const rows = await this.repo(orgId).select(
      and(
        eq(embargoes.isActive, true),
        lte(embargoes.fromTs, at),
        gte(embargoes.toTs, at),
      ) as SQL,
      asc(embargoes.fromTs),
    );
    return rows.map((row) => this.decorate(row));
  }

  async findById(
    orgId: string,
    id: string,
  ): Promise<EmbargoWithSummary | null> {
    const row = await this.repo(orgId).findById(id);
    return row ? this.decorate(row) : null;
  }

  async create(
    orgId: string,
    values: ScopedInsert<typeof embargoes>,
  ): Promise<EmbargoWithSummary> {
    // Refuses a scope this build cannot parse, before it is ever stored.
    assertScopeVersion(values.scope as EmbargoScope);
    const row = await this.repo(orgId).insert(values);
    return this.decorate(row);
  }

  async update(
    orgId: string,
    id: string,
    values: Partial<ScopedInsert<typeof embargoes>>,
  ): Promise<EmbargoWithSummary | null> {
    if (values.scope) assertScopeVersion(values.scope as EmbargoScope);
    const row = await this.repo(orgId).update(id, values);
    return row ? this.decorate(row) : null;
  }

  /**
   * Ending an embargo is `is_active = false`, not a delete: the solver runs that
   * excluded a rake last week were right to, and the row is the evidence.
   * `DELETE /embargoes/:id` maps here.
   */
  async end(orgId: string, id: string): Promise<EmbargoWithSummary | null> {
    return this.update(orgId, id, { isActive: false });
  }

  private filters(query: IListEmbargoesQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.activeAt) {
      conditions.push(lte(embargoes.fromTs, query.activeAt));
      conditions.push(gte(embargoes.toTs, query.activeAt));
    }
    if (query.station) {
      // Containment against the jsonb array, in SQL. `@>` on a scalar array is
      // what the GIN-indexable form looks like.
      conditions.push(
        sql`${embargoes.scope} -> 'stations' @> ${JSON.stringify([query.station.toUpperCase()])}::jsonb`,
      );
    }
    if (query.commodity) {
      conditions.push(
        sql`${embargoes.scope} -> 'commodityCodes' @> ${JSON.stringify([query.commodity.toUpperCase()])}::jsonb`,
      );
    }
    if (query.isActive !== undefined) {
      conditions.push(eq(embargoes.isActive, query.isActive));
    }

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }

  /** Newest first — what the controller's screen opens on. */
  async listRecent(orgId: string, limit = 20): Promise<EmbargoWithSummary[]> {
    const rows = await this.repo(orgId).select(
      undefined,
      desc(embargoes.fromTs),
    );
    return rows.slice(0, limit).map((row) => this.decorate(row));
  }
}

export default EmbargoService;

/**
 * Tenant scoping, enforced by construction.
 *
 * DESIGN.md §8: *"Tenant scoping is enforced in the repository layer, not
 * controllers — a single missed controller check is a breach, whereas a
 * repository that cannot construct an unscoped query is safe by default."*
 *
 * That sentence is the whole design of this file. The class has no method that
 * can produce SQL without `org_id = :orgId` in the predicate, and no way to
 * construct one without an orgId. Reading a neighbouring tenant's row is not a
 * check that was forgotten — it is a query that cannot be written.
 *
 * Two consequences follow deliberately:
 *
 *  - `insert()` takes values **without** `orgId` and injects the bound one. A
 *    request body carrying someone else's `orgId` writes into the caller's
 *    tenant, not theirs. Not sanitised, not rejected — structurally ignored.
 *  - Globally-shared tables (stations, sections, wagon types, commodities,
 *    charge rules) are not tenant data and do not fit here. They get
 *    `UnscopedRepository`, whose only job is to be conspicuous in review.
 */
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { db, type DB } from "./connection";
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  type Paginated,
  type PaginateOptions,
} from "../types/pagination.types";

/** Every table in this schema keys on `id` and carries the tenant on `org_id`. */
export type ScopedTable = PgTable & { id: PgColumn; orgId: PgColumn };

type Row<T extends ScopedTable> = T["$inferSelect"];
type Insert<T extends ScopedTable> = T["$inferInsert"];

/** What a caller may supply: everything the table wants, minus the tenant. */
export type ScopedInsert<T extends ScopedTable> = Omit<Insert<T>, "orgId">;
/** Updates never touch `id` or `orgId` — moving a row between tenants is not an update. */
export type ScopedUpdate<T extends ScopedTable> = Partial<
  Omit<Insert<T>, "id" | "orgId">
>;

export class ScopedRepository<T extends ScopedTable> {
  private readonly columns: Record<string, PgColumn>;

  constructor(
    private readonly table: T,
    private readonly orgId: string,
    private readonly database: DB = db,
  ) {
    // No default, no null escape, no "system" sentinel. An empty orgId here
    // would AND `org_id = ''` into every query — a UUID column would reject it
    // at the driver, but a clear error at construction beats a 22P02 later.
    if (!orgId) {
      throw new Error(
        "ScopedRepository requires an orgId — use UnscopedRepository for global tables",
      );
    }
    this.columns = getTableColumns(this.table) as Record<string, PgColumn>;
  }

  /**
   * The one place a predicate is built. Everything funnels through it, which is
   * what makes "cannot construct an unscoped query" true rather than aspirational.
   */
  where(...conditions: (SQL | undefined)[]): SQL {
    const scope = eq(this.table.orgId, this.orgId);
    const extra = conditions.filter((c): c is SQL => c !== undefined);
    // `and()` returns SQL | undefined; with `scope` always present it cannot be
    // undefined, but the compiler does not know that.
    return extra.length === 0 ? scope : (and(scope, ...extra) as SQL);
  }

  async select(where?: SQL, orderBy?: SQL): Promise<Row<T>[]> {
    const query = this.database
      .select()
      .from(this.table as PgTable)
      .where(this.where(where));
    const rows = orderBy ? await query.orderBy(orderBy) : await query;
    return rows as Row<T>[];
  }

  async selectOne(where: SQL): Promise<Row<T> | null> {
    const [row] = await this.database
      .select()
      .from(this.table as PgTable)
      .where(this.where(where))
      .limit(1);
    return (row as Row<T>) ?? null;
  }

  /**
   * By-id read. Returns null for "not yours" exactly as it does for "does not
   * exist" — the caller cannot tell the two apart, and neither can an attacker
   * probing for valid ids across tenants.
   */
  async findById(id: string): Promise<Row<T> | null> {
    return this.selectOne(eq(this.table.id, id));
  }

  async insert(values: ScopedInsert<T>): Promise<Row<T>> {
    // Spread first, orgId second: an `orgId` in `values` is overwritten, never
    // honoured. This ordering IS the guarantee — reversing it is a breach.
    const payload = { ...values, orgId: this.orgId } as Insert<T>;

    // `.returning()` on an `any` table widens to a union drizzle cannot
    // destructure; narrow it once here rather than at every call site.
    const rows = (await this.database
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(this.table as any)
      .values(payload)
      .returning()) as Row<T>[];
    return rows[0];
  }

  async insertMany(values: ScopedInsert<T>[]): Promise<Row<T>[]> {
    if (values.length === 0) return [];
    const payload = values.map((v) => ({
      ...v,
      orgId: this.orgId,
    })) as Insert<T>[];

    return (
      (await this.database
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert(this.table as any)
        .values(payload)
        .returning()) as Row<T>[]
    );
  }

  /** Returns null when the row belongs to another tenant — no rows matched. */
  async update(id: string, values: ScopedUpdate<T>): Promise<Row<T> | null> {
    const patch: Record<string, unknown> = { ...values };
    // Every table in this schema carries updated_at; stamp it if it is there.
    if ("updatedAt" in this.columns) patch.updatedAt = new Date();

    const rows = (await this.database
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(this.table as any)
      .set(patch)
      .where(this.where(eq(this.table.id, id)))
      .returning()) as Row<T>[];
    return rows[0] ?? null;
  }

  /** True only if a row in *this* tenant was deleted. */
  async delete(id: string): Promise<boolean> {
    const rows = await this.database
      .delete(this.table as PgTable)
      .where(this.where(eq(this.table.id, id)))
      .returning();
    return rows.length > 0;
  }

  async count(where?: SQL): Promise<number> {
    const [row] = await this.database
      .select({ value: sql<number>`count(*)::int` })
      .from(this.table as PgTable)
      .where(this.where(where));
    return row?.value ?? 0;
  }

  /**
   * One page plus the total. The two queries run concurrently because the count
   * does not depend on the page — serialising them doubles the latency of every
   * list screen for no benefit.
   */
  async paginate(
    opts: Partial<PaginateOptions> = {},
    where?: SQL,
  ): Promise<Paginated<Row<T>>> {
    const page = Math.max(1, Math.trunc(opts.page ?? DEFAULT_PAGE));
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)),
    );
    const predicate = this.where(where);

    const [rows, total] = await Promise.all([
      this.database
        .select()
        .from(this.table as PgTable)
        .where(predicate)
        .orderBy(this.orderBy(opts.sort, opts.order))
        .limit(limit)
        .offset((page - 1) * limit),
      this.count(where),
    ]);

    return {
      data: rows as Row<T>[],
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  /**
   * Resolves `?sort=` against the table's real columns. An unknown name falls
   * back rather than reaching SQL: interpolating a query-string value into an
   * ORDER BY is the classic injection hole in an otherwise parameterised API.
   */
  private orderBy(sort?: string, order: "asc" | "desc" = "desc"): SQL {
    const fallback = this.columns.createdAt ?? this.columns.id ?? this.table.id;
    const column = sort && sort in this.columns ? this.columns[sort] : fallback;
    return order === "asc" ? asc(column) : desc(column);
  }

  /** Escape hatch for a genuinely bespoke query — still pre-scoped. */
  get scope(): SQL {
    return eq(this.table.orgId, this.orgId);
  }
}

/**
 * For tables that are **not** tenant data: the rail network, wagon types,
 * commodities, charge rules. Those are shared reference data — scoping them by
 * organization would mean every tenant seeding its own copy of the Indian rail
 * network, which is not a security model, it is a data-duplication bug.
 *
 * It is deliberately more awkward to reach for than ScopedRepository: a
 * different import, an explicit name, and a class that reads as an assertion.
 * If this appears in a diff on a table with an `org_id` column, that is the
 * review finding.
 *
 * It mirrors ScopedRepository's surface — paginate, update, delete — minus the
 * scope, so a service does not have to switch idioms when it crosses the
 * tenancy line. The one difference is the **key column**: reference tables are
 * keyed by their real code (`stations.code`, `commodities.code`), not by a
 * uuid, so the key is supplied at construction rather than assumed to be `id`.
 */
export class UnscopedRepository<T extends PgTable> {
  private readonly columns: Record<string, PgColumn>;
  private readonly key: PgColumn;

  constructor(
    private readonly table: T,
    /**
     * The primary key. Optional only because most tables really do key on
     * `id`; passing the wrong column here would make `findByKey` silently
     * answer a different question, so it is stated explicitly wherever the key
     * is not `id`.
     */
    keyColumn?: PgColumn,
    private readonly database: DB = db,
  ) {
    this.columns = getTableColumns(this.table) as Record<string, PgColumn>;
    const fallback = this.columns.id;
    if (!keyColumn && !fallback) {
      throw new Error(
        "UnscopedRepository needs a key column — this table has no `id`",
      );
    }
    this.key = keyColumn ?? fallback;
  }

  async select(where?: SQL, orderBy?: SQL): Promise<T["$inferSelect"][]> {
    const query = this.database
      .select()
      .from(this.table as PgTable)
      .where(where);
    const rows = orderBy ? await query.orderBy(orderBy) : await query;
    return rows as T["$inferSelect"][];
  }

  async selectOne(where: SQL): Promise<T["$inferSelect"] | null> {
    const [row] = await this.database
      .select()
      .from(this.table as PgTable)
      .where(where)
      .limit(1);
    return (row as T["$inferSelect"]) ?? null;
  }

  /** By primary key — `id`, or whatever column was named at construction. */
  async findByKey(key: string): Promise<T["$inferSelect"] | null> {
    return this.selectOne(eq(this.key, key));
  }

  async insert(values: T["$inferInsert"]): Promise<T["$inferSelect"]> {
    const rows = (await this.database
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(this.table as any)
      .values(values)
      .returning()) as T["$inferSelect"][];
    return rows[0];
  }

  async insertMany(values: T["$inferInsert"][]): Promise<T["$inferSelect"][]> {
    if (values.length === 0) return [];
    return (
      (await this.database
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert(this.table as any)
        .values(values)
        .returning()) as T["$inferSelect"][]
    );
  }

  async update(
    key: string,
    values: Partial<T["$inferInsert"]>,
  ): Promise<T["$inferSelect"] | null> {
    const patch: Record<string, unknown> = { ...values };
    if ("updatedAt" in this.columns) patch.updatedAt = new Date();

    const rows = (await this.database
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(this.table as any)
      .set(patch)
      .where(eq(this.key, key))
      .returning()) as T["$inferSelect"][];
    return rows[0] ?? null;
  }

  async delete(key: string): Promise<boolean> {
    const rows = await this.database
      .delete(this.table as PgTable)
      .where(eq(this.key, key))
      .returning();
    return rows.length > 0;
  }

  async count(where?: SQL): Promise<number> {
    const [row] = await this.database
      .select({ value: sql<number>`count(*)::int` })
      .from(this.table as PgTable)
      .where(where);
    return row?.value ?? 0;
  }

  /** Same envelope as ScopedRepository.paginate, so list screens are uniform. */
  async paginate(
    opts: Partial<PaginateOptions> = {},
    where?: SQL,
  ): Promise<Paginated<T["$inferSelect"]>> {
    const page = Math.max(1, Math.trunc(opts.page ?? DEFAULT_PAGE));
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)),
    );

    const [rows, total] = await Promise.all([
      this.database
        .select()
        .from(this.table as PgTable)
        .where(where)
        .orderBy(this.orderBy(opts.sort, opts.order))
        .limit(limit)
        .offset((page - 1) * limit),
      this.count(where),
    ]);

    return {
      data: rows as T["$inferSelect"][],
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  /** Resolves `?sort=` against real columns, for the reason ScopedRepository does. */
  private orderBy(sort?: string, order: "asc" | "desc" = "desc"): SQL {
    const fallback = this.columns.createdAt ?? this.key;
    const column = sort && sort in this.columns ? this.columns[sort] : fallback;
    return order === "asc" ? asc(column) : desc(column);
  }
}

/** Binds a factory to one organization. This is what `req.tenant.repo` is. */
export const scopedRepositoryFactory =
  (orgId: string, database: DB = db) =>
  <T extends ScopedTable>(table: T): ScopedRepository<T> =>
    new ScopedRepository(table, orgId, database);

export default ScopedRepository;

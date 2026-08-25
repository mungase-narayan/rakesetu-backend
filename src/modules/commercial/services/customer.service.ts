/**
 * customers and customer_sidings.
 *
 * Tenant-scoped through `ScopedRepository` on `org_id` — the **zone** that holds
 * the relationship. The second scoping column, `customer_org_id`, is the tenant
 * that logs in, and it is queried explicitly rather than through the repository
 * (see **DECISIONS D7**). `findForCustomerOrg` below is that query, written
 * here in Phase 3 so Phase 6's portal inherits it instead of inventing its own
 * predicate against a table it does not own.
 */
import { and, asc, eq, ilike, or, type SQL } from "drizzle-orm";

import {
  customerSidings,
  customers,
  type Customer,
  type CustomerSiding,
} from "../../../schema";
import { db, type DB } from "../../../database/connection";
import {
  ScopedRepository,
  type ScopedInsert,
} from "../../../database/scoped-repository";
import type { IListCustomersQuery } from "../types/commercial.types";

class CustomerService {
  constructor(private readonly database: DB = db) {}

  private repo(orgId: string) {
    return new ScopedRepository(customers, orgId, this.database);
  }

  private sidingRepo(orgId: string) {
    return new ScopedRepository(customerSidings, orgId, this.database);
  }

  async list(orgId: string, query: IListCustomersQuery = {}) {
    return this.repo(orgId).paginate(
      { ...query, sort: query.sort ?? "name", order: query.order ?? "asc" },
      this.filters(query),
    );
  }

  async findById(orgId: string, id: string): Promise<Customer | null> {
    return this.repo(orgId).findById(id);
  }

  /**
   * The **D7** read: which customer row is this signed-in freight-customer
   * tenant? Deliberately not routed through `ScopedRepository`, because the
   * scope it would apply is the zone's `org_id` — the wrong column for this
   * question, and one that would silently return nothing.
   */
  async findForCustomerOrg(customerOrgId: string): Promise<Customer[]> {
    return this.database
      .select()
      .from(customers)
      .where(eq(customers.customerOrgId, customerOrgId))
      .orderBy(asc(customers.name));
  }

  async create(
    orgId: string,
    values: ScopedInsert<typeof customers>,
  ): Promise<Customer> {
    return this.repo(orgId).insert({
      ...values,
      code: values.code.toUpperCase(),
    });
  }

  async update(
    orgId: string,
    id: string,
    values: Partial<ScopedInsert<typeof customers>>,
  ): Promise<Customer | null> {
    return this.repo(orgId).update(id, values);
  }

  // ---- sidings ------------------------------------------------------------

  async listSidings(
    orgId: string,
    customerId: string,
  ): Promise<CustomerSiding[]> {
    return this.sidingRepo(orgId).select(
      eq(customerSidings.customerId, customerId),
      asc(customerSidings.createdAt),
    );
  }

  async addSiding(
    orgId: string,
    customerId: string,
    values: Omit<ScopedInsert<typeof customerSidings>, "customerId">,
  ): Promise<CustomerSiding> {
    return this.sidingRepo(orgId).insert({
      ...values,
      customerId,
      commodityCodes: values.commodityCodes.map((code) => code.toUpperCase()),
    });
  }

  async removeSiding(orgId: string, sidingId: string): Promise<boolean> {
    return this.sidingRepo(orgId).delete(sidingId);
  }

  async findSiding(
    orgId: string,
    sidingId: string,
  ): Promise<CustomerSiding | null> {
    return this.sidingRepo(orgId).findById(sidingId);
  }

  private filters(query: IListCustomersQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        or(
          ilike(customers.code, pattern),
          ilike(customers.name, pattern),
        ) as SQL,
      );
    }
    if (query.tier) conditions.push(eq(customers.tier, query.tier));
    if (query.isActive !== undefined) {
      conditions.push(eq(customers.isActive, query.isActive));
    }

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default CustomerService;

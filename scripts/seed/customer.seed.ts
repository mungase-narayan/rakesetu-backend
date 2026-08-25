/**
 * Customers and their sidings.
 *
 * One customer — Aditya Cement — is linked to the `freight_customer`
 * organization seeded by `tenancy.seed.ts`, through `customers.customer_org_id`.
 * That single row is what makes **DECISIONS D7** real rather than theoretical:
 * the zone reads it through `org_id`, the customer's own portal will read it
 * through `customer_org_id`, and both are looking at the same commercial
 * relationship.
 */
/* eslint-disable no-console */
import { and, eq } from "drizzle-orm";

import { db } from "../../src/database/connection";
import {
  customerSidings,
  customers,
  organizations,
  type Terminal,
} from "../../src/schema";
import { CUSTOMERS } from "./data/customer.data";

export interface CustomerCounts {
  customers: number;
  sidings: number;
  linkedToTenant: number;
}

export const seedCustomers = async (
  orgId: string,
  terminalsByCode: Map<string, Terminal>,
): Promise<CustomerCounts> => {
  let sidingCount = 0;
  let linked = 0;

  for (const seed of CUSTOMERS) {
    let customerOrgId: string | null = null;
    if (seed.linkToTenantCode) {
      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.code, seed.linkToTenantCode));
      customerOrgId = org?.id ?? null;
      if (customerOrgId) linked += 1;
    }

    await db
      .insert(customers)
      .values({
        orgId,
        customerOrgId,
        code: seed.code,
        name: seed.name,
        gstin: seed.gstin,
        tier: seed.tier,
        creditLimit: seed.creditLimit,
        contactEmail: seed.contactEmail,
        contactPhone: seed.contactPhone,
      })
      .onConflictDoNothing();

    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.orgId, orgId), eq(customers.code, seed.code)));

    for (const siding of seed.sidings) {
      const terminal = terminalsByCode.get(siding.terminalCode);
      if (!terminal) continue;

      await db
        .insert(customerSidings)
        .values({
          orgId,
          customerId: customer.id,
          terminalId: terminal.id,
          commodityCodes: siding.commodityCodes,
          isDefaultLoading: siding.isDefaultLoading ?? false,
          isDefaultDest: siding.isDefaultDest ?? false,
        })
        .onConflictDoNothing();
      sidingCount += 1;
    }
  }

  const tiers = new Set(CUSTOMERS.map((customer) => customer.tier));
  console.log(
    `  customers     ${CUSTOMERS.length} across ${tiers.size} tiers, ${sidingCount} sidings, ${linked} linked to a portal tenant`,
  );

  return {
    customers: CUSTOMERS.length,
    sidings: sidingCount,
    linkedToTenant: linked,
  };
};

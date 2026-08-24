/**
 * Organization data-access service: encapsulates Drizzle queries against the
 * organizations table so controllers stay persistence-agnostic.
 */
import { and, asc, eq, type SQL } from "drizzle-orm";

import { db } from "../../../database/connection";
import { organizations, type NewOrganization } from "../../../schema";
import type { IListOrganizationsQuery } from "../types/organization.types";

class OrganizationService {
  async listOrganizations(filters: IListOrganizationsQuery = {}) {
    const conditions: SQL[] = [];
    if (filters.type) conditions.push(eq(organizations.type, filters.type));
    if (filters.status)
      conditions.push(eq(organizations.status, filters.status));

    return db
      .select()
      .from(organizations)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(organizations.name));
  }

  async getOrganizationById(id: string) {
    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id));

    return organization;
  }

  async getOrganizationByCode(code: string) {
    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.code, code));

    return organization;
  }

  async createOrganization(data: NewOrganization) {
    const [organization] = await db
      .insert(organizations)
      .values(data)
      .returning();

    return organization;
  }
}

export default OrganizationService;

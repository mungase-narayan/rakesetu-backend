/**
 * Role data-access service: Drizzle queries against the roles table so
 * controllers stay persistence-agnostic.
 */
import { and, asc, eq } from "drizzle-orm";

import { db } from "../../../database/connection";
import { roles, type NewRole, type RoleName } from "../../../schema";

class RoleService {
  async getRolesByOrg(orgId: string) {
    return db
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.status, "active")))
      .orderBy(asc(roles.name));
  }

  async getRoleById(id: string) {
    const [role] = await db.select().from(roles).where(eq(roles.id, id));
    return role;
  }

  async getRoleByName(orgId: string, name: RoleName) {
    const [role] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.name, name)));

    return role;
  }

  async createRole(data: NewRole) {
    const [role] = await db.insert(roles).values(data).returning();
    return role;
  }
}

export default RoleService;

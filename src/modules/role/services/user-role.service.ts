/**
 * user_roles data-access service.
 *
 * getUserRoles is on the login hot path — it returns the UserRoleContext list
 * that the frontend uses to decide which workspace to open.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../../../database/connection";
import { roles, userRoles, type NewUserRole } from "../../../schema";
import type { UserRoleContext } from "../types/role.types";

class UserRoleService {
  async getUserRoles(userId: string): Promise<UserRoleContext[]> {
    const rows = await db
      .select({
        userRoleId: userRoles.id,
        roleId: roles.id,
        name: roles.name,
        orgId: userRoles.orgId,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(userRoles.status, "active"),
          eq(roles.status, "active"),
        ),
      );

    return rows;
  }

  async assignRole(data: NewUserRole) {
    const [assignment] = await db.insert(userRoles).values(data).returning();
    return assignment;
  }
}

export default UserRoleService;

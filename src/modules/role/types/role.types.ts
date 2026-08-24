/**
 * Role module type contracts.
 *
 * UserRoleContext is what `requireRoles` attaches to req.userRoles: the
 * minimum a handler needs to answer "which role, in which organization".
 */
import type { RoleName } from "../../../schema";

export type { RoleName };

export interface UserRoleContext {
  userRoleId: string;
  roleId: string;
  name: RoleName;
  orgId: string;
}

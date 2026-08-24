/**
 * Shared application types: augments Express with the authenticated user
 * shape and defines CustomRequest/CustomJwtPayload helpers used by
 * controllers and middlewares.
 */
import { Request } from "express";
import { JwtPayload } from "jsonwebtoken";

import { SafeUser } from "../modules/user/types/user.types";
import { UserRoleContext } from "../modules/role/types/role.types";
import type { Permission } from "../constants/permission.constants";
import type { TenantContext } from "./tenant.types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends SafeUser {}

    interface Request {
      userRoles?: UserRoleContext[];
      /** The union of the caller's permissions — set by requirePermission. */
      permissions?: Set<Permission>;
      /** Set by withTenant: the org boundary plus its repository factory. */
      tenant?: TenantContext;
      /** Set by requestId: threads this request through logs and queue jobs. */
      correlationId?: string;
    }
  }
}

export interface CustomJwtPayload extends JwtPayload {
  user: { id: string };
}

export interface CustomRequest<T = null> extends Request {
  body: T;
  user?: Express.User;
  userRoles?: UserRoleContext[];
  permissions?: Set<Permission>;
  tenant?: TenantContext;
  correlationId?: string;
}

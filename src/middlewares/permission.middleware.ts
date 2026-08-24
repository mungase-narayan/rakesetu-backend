/**
 * Permission authorization: the action-level counterpart to requireRoles.
 *
 * Resolves the caller's active role assignments, unions their permissions, and
 * requires **every** permission the route asked for — AND, not OR. A route that
 * lists two permissions is describing one operation that genuinely needs both;
 * if it needs either, that is two routes or one permission, not a looser check.
 *
 * requireRoles is not deprecated — "any admin" is still a legitimate question,
 * and it is the right guard for an admin-console route. New feature routes use
 * requirePermission.
 */
import { and, eq } from "drizzle-orm";
import { NextFunction, Response } from "express";

import { roles, userRoles } from "../schema";
import { db } from "../database/connection";
import ApiError from "../utils/api-error";
import asyncHandler from "../utils/async-handler";
import ERROR_MESSAGE from "../constants/error-message.constants";
import { CustomRequest } from "../types/common.types";
import type { UserRoleContext } from "../modules/role/types/role.types";
import {
  permissionsForRoles,
  type Permission,
} from "../constants/permission.constants";

/**
 * Loads the caller's active assignments. Same query shape as requireRoles —
 * both statuses must be `active`, because revoking a role and deactivating it
 * are different acts and either one has to end the grant.
 */
export const loadUserRoles = async (
  userId: string,
): Promise<UserRoleContext[]> => {
  return db
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
};

export const requirePermission = (...required: Permission[]) =>
  asyncHandler(
    async (req: CustomRequest, _res: Response, next: NextFunction) => {
      if (!req.user?.id) {
        throw new ApiError(401, ERROR_MESSAGE.UNAUTHORIZED_REQUEST);
      }

      const assignments = await loadUserRoles(req.user.id);

      // No active role at all is still 403, not 401: the caller proved who they
      // are, they simply hold nothing. 401 would send the SPA into a refresh
      // loop against a token that is perfectly valid.
      const granted = permissionsForRoles(assignments.map((a) => a.name));

      const missing = required.filter((p) => !granted.has(p));
      if (missing.length > 0) {
        throw new ApiError(403, ERROR_MESSAGE.PERMISSION_DENIED);
      }

      // Populated exactly as requireRoles does, so a handler behind either
      // guard reads the same request.
      req.userRoles = assignments;
      req.permissions = granted;
      next();
    },
  );

export default requirePermission;

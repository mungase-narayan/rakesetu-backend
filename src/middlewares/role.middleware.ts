/**
 * Role authorization middleware factory: returns an Express middleware
 * that ensures the JWT-authenticated user holds at least one active
 * assignment in user_roles matching the allowed role names, and attaches
 * the matching assignments to req.userRoles so downstream handlers can
 * scope by organization.
 */
import { and, eq, inArray } from "drizzle-orm";
import { NextFunction, Response } from "express";

import { roles, userRoles } from "../schema";
import { db } from "../database/connection";
import ApiError from "../utils/api-error";
import asyncHandler from "../utils/async-handler";
import ERROR_MESSAGE from "../constants/error-message.constants";
import { CustomRequest } from "../types/common.types";
import { RoleName, UserRoleContext } from "../modules/role/types/role.types";

export const requireRoles = (...allowed: RoleName[]) =>
  asyncHandler(
    async (req: CustomRequest, _res: Response, next: NextFunction) => {
      if (!req.user?.id) {
        throw new ApiError(401, ERROR_MESSAGE.UNAUTHORIZED_REQUEST);
      }

      const assignments = await db
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
            eq(userRoles.userId, req.user.id),
            eq(userRoles.status, "active"),
            eq(roles.status, "active"),
            inArray(roles.name, allowed),
          ),
        );

      if (assignments.length === 0) {
        throw new ApiError(403, ERROR_MESSAGE.PERMISSION_DENIED);
      }

      req.userRoles = assignments.map((a): UserRoleContext => ({
        userRoleId: a.userRoleId,
        roleId: a.roleId,
        name: a.name,
        orgId: a.orgId,
      }));
      next();
    },
  );

export default requireRoles;

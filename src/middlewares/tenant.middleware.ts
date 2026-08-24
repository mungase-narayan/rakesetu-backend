/**
 * Binds the request to its tenant.
 *
 * Runs after verifyJWT and reads the organization from the **user row**, never
 * from a header, a query parameter or the body. The tenant is an identity fact,
 * so it is settled by the same thing that settled the identity; anything a
 * client can type is an input, and an input is something to be forged.
 *
 * Controllers take `req.tenant.repo(table)` and hand the repository to a
 * service. A service that imports `db` to touch a tenant-scoped table has
 * stepped outside this guarantee — that is the thing to look for in review.
 */
import { NextFunction, Response } from "express";

import ApiError from "../utils/api-error";
import asyncHandler from "../utils/async-handler";
import ERROR_MESSAGE from "../constants/error-message.constants";
import { CustomRequest } from "../types/common.types";
import { scopedRepositoryFactory } from "../database/scoped-repository";

export const withTenant = asyncHandler(
  async (req: CustomRequest, _res: Response, next: NextFunction) => {
    const orgId = req.user?.orgId;

    if (!orgId) {
      throw new ApiError(401, ERROR_MESSAGE.UNAUTHORIZED_REQUEST);
    }

    req.tenant = { orgId, repo: scopedRepositoryFactory(orgId) };
    next();
  },
);

/**
 * Reads the tenant a handler is running under, or throws.
 *
 * Exists so a controller written without `withTenant` mounted fails with a
 * clear 500 at the first line, rather than a `Cannot read properties of
 * undefined` five frames down inside drizzle.
 */
export const requireTenant = (req: CustomRequest) => {
  if (!req.tenant) {
    throw new ApiError(
      500,
      "Tenant context is missing — mount withTenant after verifyJWT on this route",
    );
  }
  return req.tenant;
};

export default withTenant;

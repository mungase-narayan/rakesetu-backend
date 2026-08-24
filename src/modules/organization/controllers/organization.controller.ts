/**
 * Organization controller: an admin-only directory listing, plus a
 * single-organization read that a user may only perform for their OWN
 * organization.
 *
 * The tenant check in getOrganization is the important line here: without it,
 * any authenticated user could read any other tenant's record by guessing a
 * UUID.
 */
import { Response } from "express";

import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import { CustomRequest } from "../../../types/common.types";
import ERROR_MESSAGE from "../../../constants/error-message.constants";
import type { IListOrganizationsQuery } from "../types/organization.types";

import OrganizationService from "../services/organization.service";

class OrganizationController {
  constructor(private organizationService: OrganizationService) {}

  async listOrganizations(req: CustomRequest, res: Response) {
    const filters = req.query as IListOrganizationsQuery;
    const data = await this.organizationService.listOrganizations(filters);

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Organizations fetched successfully."));
  }

  async getOrganization(req: CustomRequest, res: Response) {
    const { id } = req.params;

    // A user may only read their own organization. Admins wanting the whole
    // directory use the list endpoint, which is role-guarded.
    if (req.user?.orgId !== id) {
      throw new ApiError(403, ERROR_MESSAGE.PERMISSION_DENIED);
    }

    const organization = await this.organizationService.getOrganizationById(id);

    if (!organization) {
      throw new ApiError(404, ERROR_MESSAGE.ORGANIZATION_NOT_FOUND);
    }

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          organization,
          "Organization fetched successfully.",
        ),
      );
  }
}

export default OrganizationController;

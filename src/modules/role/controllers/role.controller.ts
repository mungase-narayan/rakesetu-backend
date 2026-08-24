/**
 * Role controller: lists the roles available inside the caller's own
 * organization. Scoped from req.user.orgId — never from a query parameter,
 * so one tenant can't enumerate another's roles.
 */
import { Response } from "express";

import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import { CustomRequest } from "../../../types/common.types";
import ERROR_MESSAGE from "../../../constants/error-message.constants";

import RoleService from "../services/role.service";

class RoleController {
  constructor(private roleService: RoleService) {}

  async listRoles(req: CustomRequest, res: Response) {
    const orgId = req.user?.orgId;
    if (!orgId) throw new ApiError(401, ERROR_MESSAGE.UNAUTHORIZED_REQUEST);

    const data = await this.roleService.getRolesByOrg(orgId);

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Roles fetched successfully."));
  }
}

export default RoleController;

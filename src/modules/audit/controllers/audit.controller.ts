/**
 * Audit controller: reads the trail. There is no write endpoint and there will
 * not be one — rows are written by AuditService as a side effect of the action
 * being audited, and an API that lets a client compose its own audit entry is
 * an API for forging one.
 */
import { Response } from "express";

import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import { toPositiveInt } from "../../../utils/query";
import { CustomRequest } from "../../../types/common.types";
import { requireTenant } from "../../../middlewares/tenant.middleware";
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
} from "../../../types/pagination.types";

import AuditService from "../services/audit.service";
import type { AuditQuery } from "../types/audit.types";

/** `?from=`/`?to=` are ISO dates; an unparseable one is dropped, not fatal. */
const parseDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

class AuditController {
  constructor(private readonly auditService: AuditService) {}

  async list(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const query: AuditQuery = {
      page: toPositiveInt(req.query.page, DEFAULT_PAGE),
      limit: toPositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT),
      entityType: asString(req.query.entityType),
      entityId: asString(req.query.entityId),
      actorId: asString(req.query.actorId),
      action: asString(req.query.action),
      correlationId: asString(req.query.correlationId),
      from: parseDate(req.query.from),
      to: parseDate(req.query.to),
    };

    const result = await this.auditService.list(orgId, query);

    return res
      .status(200)
      .json(new ApiResponse(200, result, "Audit trail fetched successfully."));
  }

  async listForEntity(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const entityType = asString(req.params.entityType);
    const entityId = asString(req.params.entityId);

    if (!entityType || !entityId) {
      throw new ApiError(400, "entityType and entityId are required");
    }

    const entries = await this.auditService.listForEntity(
      orgId,
      entityType,
      entityId,
    );

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          entries,
          "Entity audit trail fetched successfully.",
        ),
      );
  }
}

export default AuditController;

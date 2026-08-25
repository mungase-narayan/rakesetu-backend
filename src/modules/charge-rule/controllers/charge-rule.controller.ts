/**
 * Charge-rule controller.
 *
 * `resolve` is the endpoint worth reading: it takes the selector as ordinary
 * query parameters (`?commodityGroups=cement&terminalTypes=private_siding`) and
 * an explicit `asOf`, and returns the winning rule together with everything that
 * lost and why.
 */
import type { Response } from "express";

import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import type { CustomRequest } from "../../../types/common.types";
import { requireTenant } from "../../../middlewares/tenant.middleware";
import {
  actorRole,
  asString,
  paginationFrom,
  pathParam,
} from "../../../utils/controller";
import type {
  ChargeRuleType,
  CommodityGroup,
  HandlingMode,
  TerminalType,
} from "../../../schema";
import type { RuleSelectorInput } from "../../../types/selector.types";

import AuditService from "../../audit/services/audit.service";
import ChargeRuleService from "../services/charge-rule.service";
import type { NewChargeRule } from "../types/charge-rule.types";

class ChargeRuleController {
  constructor(
    private readonly chargeRuleService: ChargeRuleService,
    private readonly auditService: AuditService,
  ) {}

  async list(req: CustomRequest, res: Response) {
    const data = await this.chargeRuleService.list({
      ...paginationFrom(req),
      type: asString(req.query.type) as ChargeRuleType | undefined,
      effectiveAt: asString(req.query.effectiveAt),
      circularRef: asString(req.query.circularRef),
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Charge rules fetched successfully."));
  }

  async create(req: CustomRequest<NewChargeRule>, res: Response) {
    const { orgId } = requireTenant(req);
    const created = await this.chargeRuleService.create(req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "charge_rule.create",
      entityType: "charge_rules",
      // The circular, not the uuid: this is the identifier a commercial officer
      // recognises two years later when the charge is disputed.
      entityId: created.circularRef,
      after: created,
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Charge rule created successfully."));
  }

  async update(req: CustomRequest<Partial<NewChargeRule>>, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.chargeRuleService.findById(id);
    if (!before) throw new ApiError(404, "Charge rule not found");

    const updated = await this.chargeRuleService.update(id, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "charge_rule.update",
      entityType: "charge_rules",
      entityId: before.circularRef,
      before,
      after: updated,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Charge rule updated successfully."));
  }

  /**
   * `GET /charge-rules/resolve?type=&asOf=&…selector`.
   *
   * `asOf` is required. That is the same decision as `basis` on the distance
   * endpoint: a default would be "today", and "today" is the wrong answer to
   * every question asked about a past shipment.
   */
  async resolve(req: CustomRequest, res: Response) {
    const type = asString(req.query.type) as ChargeRuleType;
    const asOf = asString(req.query.asOf);

    if (!asOf) {
      throw new ApiError(
        422,
        "asOf is required — there is no 'current rule' lookup, by design",
      );
    }

    // The query names one value per dimension: a caller asks about *a* cement
    // consignment at *a* private siding, not about a set.
    const selector: RuleSelectorInput = {
      commodityGroup: asString(req.query.commodityGroups) as
        CommodityGroup | undefined,
      terminalType: asString(req.query.terminalTypes) as
        TerminalType | undefined,
      handlingMode: asString(req.query.handlingModes) as
        HandlingMode | undefined,
      wagonTypeCode: asString(req.query.wagonTypeCodes)?.toUpperCase(),
      division: asString(req.query.divisions),
    };

    const resolution = await this.chargeRuleService.resolve(
      type,
      selector,
      asOf,
    );

    return res
      .status(200)
      .json(new ApiResponse(200, resolution, "Charge rule resolved."));
  }
}

export default ChargeRuleController;

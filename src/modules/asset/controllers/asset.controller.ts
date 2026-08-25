/**
 * Asset controller — wagon types, wagons, rakes and compositions.
 */
import type { Response } from "express";

import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import type { CustomRequest } from "../../../types/common.types";
import { requireTenant } from "../../../middlewares/tenant.middleware";
import {
  actorRole,
  asBoolean,
  asDate,
  asString,
  paginationFrom,
  pathParam,
} from "../../../utils/controller";
import type {
  CommodityGroup,
  NewWagonType,
  RakeState,
  WagonStatus,
  rakes,
  wagons,
} from "../../../schema";
import type { ScopedInsert } from "../../../database/scoped-repository";

import AuditService from "../../audit/services/audit.service";
import WagonTypeService from "../services/wagon-type.service";
import WagonService from "../services/wagon.service";
import RakeService from "../services/rake.service";
import type { IReplaceCompositionBody } from "../types/asset.types";

class AssetController {
  constructor(
    private readonly wagonTypeService: WagonTypeService,
    private readonly wagonService: WagonService,
    private readonly rakeService: RakeService,
    private readonly auditService: AuditService,
  ) {}

  // ---- wagon types -------------------------------------------------------

  async listWagonTypes(req: CustomRequest, res: Response) {
    const data = await this.wagonTypeService.list({
      ...paginationFrom(req),
      search: asString(req.query.search),
      commodityGroup: asString(req.query.commodityGroup) as
        CommodityGroup | undefined,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Wagon types fetched successfully."));
  }

  async createWagonType(req: CustomRequest<NewWagonType>, res: Response) {
    const { orgId } = requireTenant(req);
    const created = await this.wagonTypeService.create(req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "wagon_type.create",
      entityType: "wagon_types",
      entityId: created.code,
      after: created,
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Wagon type created successfully."));
  }

  async updateWagonType(
    req: CustomRequest<Partial<NewWagonType>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const code = pathParam(req.params.code).toUpperCase();

    const before = await this.wagonTypeService.findByCode(code);
    if (!before) throw new ApiError(404, `Wagon type ${code} not found`);

    const updated = await this.wagonTypeService.update(code, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "wagon_type.update",
      entityType: "wagon_types",
      entityId: code,
      before,
      after: updated,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Wagon type updated successfully."));
  }

  // ---- wagons ------------------------------------------------------------

  async listWagons(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const data = await this.wagonService.list(orgId, {
      ...paginationFrom(req),
      search: asString(req.query.search),
      status: asString(req.query.status) as WagonStatus | undefined,
      typeCode: asString(req.query.typeCode),
      pohDueBefore: asDate(req.query.pohDueBefore),
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Wagons fetched successfully."));
  }

  async createWagon(
    req: CustomRequest<ScopedInsert<typeof wagons>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const created = await this.wagonService.create(orgId, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "wagon.create",
      entityType: "wagons",
      entityId: created.id,
      after: created,
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Wagon created successfully."));
  }

  async updateWagon(
    req: CustomRequest<Partial<ScopedInsert<typeof wagons>>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.wagonService.findById(orgId, id);
    if (!before) throw new ApiError(404, "Wagon not found");

    const updated = await this.wagonService.update(orgId, id, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "wagon.update",
      entityType: "wagons",
      entityId: id,
      before,
      after: updated,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Wagon updated successfully."));
  }

  // ---- rakes -------------------------------------------------------------

  async listRakes(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const data = await this.rakeService.list(orgId, {
      ...paginationFrom(req),
      search: asString(req.query.search),
      state: asString(req.query.state) as RakeState | undefined,
      station: asString(req.query.station),
      wagonType: asString(req.query.wagonType),
      division: asString(req.query.division),
      isActive: asBoolean(req.query.isActive),
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Rakes fetched successfully."));
  }

  async createRake(
    req: CustomRequest<ScopedInsert<typeof rakes>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const created = await this.rakeService.create(orgId, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "rake.create",
      entityType: "rakes",
      entityId: created.id,
      after: created,
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Rake created successfully."));
  }

  async updateRake(
    req: CustomRequest<Partial<ScopedInsert<typeof rakes>>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.rakeService.findById(orgId, id);
    if (!before) throw new ApiError(404, "Rake not found");

    const updated = await this.rakeService.update(orgId, id, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "rake.update",
      entityType: "rakes",
      entityId: id,
      before,
      after: updated,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Rake updated successfully."));
  }

  /**
   * The composition **as of** a moment, plus the constraints derived from it.
   * `?at=` defaults to now; passing a past instant is how Phase 7 asks what the
   * rake looked like during a journey it is re-evaluating.
   */
  async getComposition(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);
    const at = asDate(req.query.at) ?? new Date();

    const [composition, constraints] = await Promise.all([
      this.rakeService.getComposition(orgId, id, at),
      this.rakeService.getRakeConstraints(orgId, id, at),
    ]);

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { at, composition, constraints },
          "Composition fetched successfully.",
        ),
      );
  }

  async replaceComposition(
    req: CustomRequest<IReplaceCompositionBody>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);
    const effectiveFrom = req.body.effectiveFrom
      ? new Date(req.body.effectiveFrom)
      : new Date();

    const before = await this.rakeService.getComposition(
      orgId,
      id,
      effectiveFrom,
    );
    const after = await this.rakeService.replaceComposition(
      orgId,
      id,
      req.body.wagonIds,
      effectiveFrom,
    );

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "rake.composition.replace",
      entityType: "rakes",
      entityId: id,
      // Wagon numbers, not the whole join rows: an audit entry has to be
      // readable in two years without re-resolving uuids that may be gone.
      before: { wagons: before.map((entry) => entry.wagonNumber) },
      after: {
        effectiveFrom,
        wagons: after.map((entry) => entry.wagonNumber),
      },
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, after, "Composition replaced successfully."));
  }
}

export default AssetController;

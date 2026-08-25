/**
 * Network controller — stations, sections, chargeable distances, and the
 * distance endpoint that keeps the two bases apart.
 *
 * Every write is audited. `entityId` is the station code or the section uuid,
 * which is why `audit_log.entity_id` is a varchar rather than a uuid.
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

import AuditService from "../../audit/services/audit.service";
import StationService from "../services/station.service";
import SectionService from "../services/section.service";
import DistanceService from "../services/distance.service";
import ChargeableDistanceService from "../services/chargeable-distance.service";
import type {
  DistanceBasis,
  DistanceResponse,
  IListSectionsQuery,
  IListStationsQuery,
  NewChargeableDistance,
  NewSection,
  NewStation,
} from "../types/network.types";
import type { LineType } from "../../../schema";

class NetworkController {
  constructor(
    private readonly stationService: StationService,
    private readonly sectionService: SectionService,
    private readonly chargeableDistanceService: ChargeableDistanceService,
    private readonly distanceService: DistanceService,
    private readonly auditService: AuditService,
  ) {}

  // ---- stations ----------------------------------------------------------

  async listStations(req: CustomRequest, res: Response) {
    const query: IListStationsQuery = {
      ...paginationFrom(req),
      search: asString(req.query.search),
      division: asString(req.query.division),
      zone: asString(req.query.zone),
    };

    const data = await this.stationService.list(query);
    return res
      .status(200)
      .json(new ApiResponse(200, data, "Stations fetched successfully."));
  }

  async createStation(req: CustomRequest<NewStation>, res: Response) {
    const { orgId } = requireTenant(req);
    const created = await this.stationService.create(req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "station.create",
      entityType: "stations",
      entityId: created.code,
      after: created,
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Station created successfully."));
  }

  async updateStation(req: CustomRequest<Partial<NewStation>>, res: Response) {
    const { orgId } = requireTenant(req);
    const code = pathParam(req.params.code).toUpperCase();

    const before = await this.stationService.findByCode(code);
    if (!before) throw new ApiError(404, `Station ${code} not found`);

    const updated = await this.stationService.update(code, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "station.update",
      entityType: "stations",
      entityId: code,
      before,
      after: updated,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Station updated successfully."));
  }

  // ---- sections ----------------------------------------------------------

  async listSections(req: CustomRequest, res: Response) {
    const query: IListSectionsQuery = {
      ...paginationFrom(req),
      fromCode: asString(req.query.fromCode),
      toCode: asString(req.query.toCode),
      lineType: asString(req.query.lineType) as LineType | undefined,
    };

    const data = await this.sectionService.list(query);
    return res
      .status(200)
      .json(new ApiResponse(200, data, "Sections fetched successfully."));
  }

  /**
   * Accepts one section or an array of them. The CSV importer sends ninety at a
   * time, and ninety requests would be ninety cache invalidations for one edit
   * to the graph.
   */
  async createSection(
    req: CustomRequest<NewSection | NewSection[]>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const payload = req.body;

    const created = Array.isArray(payload)
      ? await this.sectionService.createMany(payload)
      : [await this.sectionService.create(payload)];

    for (const section of created) {
      await this.auditService.record({
        orgId,
        actorId: req.user?.id ?? null,
        actorRole: actorRole(req),
        action: "section.create",
        entityType: "sections",
        entityId: section.id,
        after: section,
        ip: req.ip,
      });
    }

    const data = Array.isArray(payload) ? created : created[0];
    return res
      .status(201)
      .json(
        new ApiResponse(
          201,
          data,
          `${created.length} section(s) created successfully.`,
        ),
      );
  }

  async updateSection(req: CustomRequest<Partial<NewSection>>, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.sectionService.findById(id);
    if (!before) throw new ApiError(404, "Section not found");

    const updated = await this.sectionService.update(id, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "section.update",
      entityType: "sections",
      entityId: id,
      before,
      after: updated,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Section updated successfully."));
  }

  async deleteSection(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.sectionService.findById(id);
    if (!before) throw new ApiError(404, "Section not found");

    await this.sectionService.remove(id);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "section.delete",
      entityType: "sections",
      entityId: id,
      before,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, { id }, "Section deleted successfully."));
  }

  // ---- chargeable distances ---------------------------------------------

  async listChargeableDistances(req: CustomRequest, res: Response) {
    const data = await this.chargeableDistanceService.list({
      ...paginationFrom(req),
      fromCode: asString(req.query.fromCode),
      toCode: asString(req.query.toCode),
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          data,
          "Chargeable distances fetched successfully.",
        ),
      );
  }

  /** Bulk-first: a tariff table arrives as a table, not as one row. */
  async createChargeableDistance(
    req: CustomRequest<NewChargeableDistance | NewChargeableDistance[]>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const payload = req.body;

    const created = Array.isArray(payload)
      ? await this.chargeableDistanceService.createMany(payload)
      : [await this.chargeableDistanceService.create(payload)];

    for (const row of created) {
      await this.auditService.record({
        orgId,
        actorId: req.user?.id ?? null,
        actorRole: actorRole(req),
        action: "chargeable_distance.create",
        entityType: "chargeable_distances",
        entityId: `${row.fromCode}-${row.toCode}`,
        after: row,
        ip: req.ip,
      });
    }

    const data = Array.isArray(payload) ? created : created[0];
    return res
      .status(201)
      .json(
        new ApiResponse(
          201,
          data,
          `${created.length} chargeable distance(s) created successfully.`,
        ),
      );
  }

  // ---- the distance endpoint --------------------------------------------

  /**
   * `basis` is **required**. There is no default, because a default would be
   * the answer everybody gets by accident, and one of the two answers belongs
   * on an invoice while the other does not.
   */
  async getDistance(req: CustomRequest, res: Response) {
    const from = (asString(req.query.from) ?? "").toUpperCase();
    const to = (asString(req.query.to) ?? "").toUpperCase();
    const basis = asString(req.query.basis) as DistanceBasis;

    if (basis === "tariff") {
      // Throws 422 when the pair is not on record. Deliberately not caught —
      // falling through to the operational distance here is the exact bug the
      // two-function split exists to make impossible.
      const km = await this.distanceService.tariffKm(from, to);
      const payload: DistanceResponse = { from, to, km, basis };
      return res
        .status(200)
        .json(new ApiResponse(200, payload, "Tariff distance fetched."));
    }

    const path = await this.distanceService.shortestPath(from, to);
    if (!path) {
      throw new ApiError(422, `No route on record between ${from} and ${to}`);
    }

    const payload: DistanceResponse = {
      from,
      to,
      km: path.totalKm,
      basis: "operational",
      path,
    };
    return res
      .status(200)
      .json(new ApiResponse(200, payload, "Operational distance fetched."));
  }
}

export default NetworkController;

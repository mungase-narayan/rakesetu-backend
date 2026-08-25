/**
 * Commercial controller — commodities, customers and sidings.
 *
 * The commodity half writes global reference data; the customer half writes
 * tenant data through `req.tenant.repo`. Both audit, and both take `orgId` from
 * the tenant context rather than from the body.
 */
import type { Response } from "express";

import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import type { CustomRequest } from "../../../types/common.types";
import { requireTenant } from "../../../middlewares/tenant.middleware";
import {
  actorRole,
  asBoolean,
  asString,
  paginationFrom,
  pathParam,
} from "../../../utils/controller";
import type {
  CommodityGroup,
  CustomerTier,
  NewCommodity,
} from "../../../schema";
import type { ScopedInsert } from "../../../database/scoped-repository";
import type { customerSidings, customers } from "../../../schema";

import AuditService from "../../audit/services/audit.service";
import CommodityService from "../services/commodity.service";
import CustomerService from "../services/customer.service";

class CommercialController {
  constructor(
    private readonly commodityService: CommodityService,
    private readonly customerService: CustomerService,
    private readonly auditService: AuditService,
  ) {}

  // ---- commodities -------------------------------------------------------

  async listCommodities(req: CustomRequest, res: Response) {
    const data = await this.commodityService.list({
      ...paginationFrom(req),
      search: asString(req.query.search),
      group: asString(req.query.group) as CommodityGroup | undefined,
      isHazardous: asBoolean(req.query.isHazardous),
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Commodities fetched successfully."));
  }

  async createCommodity(req: CustomRequest<NewCommodity>, res: Response) {
    const { orgId } = requireTenant(req);
    const created = await this.commodityService.create(req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "commodity.create",
      entityType: "commodities",
      entityId: created.code,
      after: created,
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Commodity created successfully."));
  }

  async updateCommodity(
    req: CustomRequest<Partial<NewCommodity>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const code = pathParam(req.params.code).toUpperCase();

    const before = await this.commodityService.findByCode(code);
    if (!before) throw new ApiError(404, `Commodity ${code} not found`);

    const updated = await this.commodityService.update(code, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "commodity.update",
      entityType: "commodities",
      entityId: code,
      before,
      after: updated,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Commodity updated successfully."));
  }

  // ---- customers ---------------------------------------------------------

  async listCustomers(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const data = await this.customerService.list(orgId, {
      ...paginationFrom(req),
      search: asString(req.query.search),
      tier: asString(req.query.tier) as CustomerTier | undefined,
      isActive: asBoolean(req.query.isActive),
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Customers fetched successfully."));
  }

  async getCustomer(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const customer = await this.customerService.findById(orgId, id);
    if (!customer) throw new ApiError(404, "Customer not found");

    const sidings = await this.customerService.listSidings(orgId, id);

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { ...customer, sidings },
          "Customer fetched successfully.",
        ),
      );
  }

  async createCustomer(
    req: CustomRequest<ScopedInsert<typeof customers>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const created = await this.customerService.create(orgId, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "customer.create",
      entityType: "customers",
      entityId: created.id,
      after: created,
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Customer created successfully."));
  }

  async updateCustomer(
    req: CustomRequest<Partial<ScopedInsert<typeof customers>>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.customerService.findById(orgId, id);
    if (!before) throw new ApiError(404, "Customer not found");

    const updated = await this.customerService.update(orgId, id, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "customer.update",
      entityType: "customers",
      entityId: id,
      before,
      after: updated,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Customer updated successfully."));
  }

  // ---- sidings -----------------------------------------------------------

  async listSidings(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const customerId = pathParam(req.params.id);

    const customer = await this.customerService.findById(orgId, customerId);
    if (!customer) throw new ApiError(404, "Customer not found");

    const sidings = await this.customerService.listSidings(orgId, customerId);
    return res
      .status(200)
      .json(new ApiResponse(200, sidings, "Sidings fetched successfully."));
  }

  async addSiding(
    req: CustomRequest<
      Omit<ScopedInsert<typeof customerSidings>, "customerId">
    >,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const customerId = pathParam(req.params.id);

    // Checked rather than left to the foreign key: a cross-tenant customer id
    // would otherwise fail as a 500 from the driver instead of a 404 that says
    // nothing about whether the row exists elsewhere.
    const customer = await this.customerService.findById(orgId, customerId);
    if (!customer) throw new ApiError(404, "Customer not found");

    const created = await this.customerService.addSiding(
      orgId,
      customerId,
      req.body,
    );

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "customer.siding.create",
      entityType: "customer_sidings",
      entityId: created.id,
      after: created,
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Siding added successfully."));
  }

  async removeSiding(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const sidingId = pathParam(req.params.sidingId);

    const before = await this.customerService.findSiding(orgId, sidingId);
    if (!before) throw new ApiError(404, "Siding not found");

    await this.customerService.removeSiding(orgId, sidingId);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "customer.siding.delete",
      entityType: "customer_sidings",
      entityId: sidingId,
      before,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, { id: sidingId }, "Siding removed."));
  }
}

export default CommercialController;

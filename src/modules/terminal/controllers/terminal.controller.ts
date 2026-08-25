/**
 * Terminal controller — terminals and embargoes.
 *
 * The two halves are guarded differently and that is §7 speaking: master data
 * is the admin's, but an embargo is an operating decision and belongs to the
 * Freight Controller. See the routes file.
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
  TerminalType,
  embargoes,
  terminals,
} from "../../../schema";
import type { ScopedInsert } from "../../../database/scoped-repository";
import type { EmbargoScope } from "../../../types/selector.types";

import AuditService from "../../audit/services/audit.service";
import TerminalService from "../services/terminal.service";
import EmbargoService from "../services/embargo.service";
import TerminalBoardService from "../services/terminal-board.service";
import { assertScopeVersion, describeScope } from "../services/embargo-scope";

class TerminalController {
  constructor(
    private readonly terminalService: TerminalService,
    private readonly embargoService: EmbargoService,
    private readonly auditService: AuditService,
    private readonly boardService: TerminalBoardService,
  ) {}

  // ---- the supervisor's board (Phase 5) ----------------------------------

  /**
   * `GET /terminals/:id/board` — inbound, on hand, released today.
   *
   * `asOf` is accepted so the temporal behaviour is demonstrable: asking for
   * the board as it stood before a circular changed must resolve the free time
   * that was in force then. It is not a filter a screen sets casually.
   */
  async board(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const data = await this.boardService.board(
      orgId,
      pathParam(req.params.id),
      asDate(req.query.asOf) ?? new Date(),
    );

    // The clock is running on this screen; an intermediary cache would freeze
    // the very numbers it exists to tick.
    res.setHeader("Cache-Control", "no-store");

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Board fetched successfully."));
  }

  /**
   * `GET /terminals/:id/next-events` — what may legally be logged, per rake.
   *
   * Always the same shape, with or without `rakeId`: one array, one element
   * when a rake is named. A response whose type depends on a query parameter is
   * a response every client has to branch on.
   */
  async nextEvents(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const data = await this.boardService.nextEvents(
      orgId,
      pathParam(req.params.id),
      asString(req.query.rakeId),
    );

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Legal events fetched successfully."));
  }

  /** The terminals this supervisor may pick between, with occupancy. */
  async boardOptions(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const data = await this.boardService.selectableTerminals(orgId);

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Terminals fetched successfully."));
  }

  // ---- terminals ---------------------------------------------------------

  async listTerminals(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const data = await this.terminalService.list(orgId, {
      ...paginationFrom(req),
      search: asString(req.query.search),
      type: asString(req.query.type) as TerminalType | undefined,
      stationCode: asString(req.query.stationCode),
      commodityGroup: asString(req.query.commodityGroup) as
        CommodityGroup | undefined,
      isActive: asBoolean(req.query.isActive),
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Terminals fetched successfully."));
  }

  async createTerminal(
    req: CustomRequest<ScopedInsert<typeof terminals>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const created = await this.terminalService.create(orgId, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "terminal.create",
      entityType: "terminals",
      entityId: created.id,
      after: created,
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Terminal created successfully."));
  }

  async updateTerminal(
    req: CustomRequest<Partial<ScopedInsert<typeof terminals>>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.terminalService.findById(orgId, id);
    if (!before) throw new ApiError(404, "Terminal not found");

    const updated = await this.terminalService.update(orgId, id, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "terminal.update",
      entityType: "terminals",
      entityId: id,
      before,
      after: updated,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Terminal updated successfully."));
  }

  // ---- embargoes ---------------------------------------------------------

  async listEmbargoes(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const data = await this.embargoService.list(orgId, {
      ...paginationFrom(req),
      activeAt: asDate(req.query.activeAt),
      station: asString(req.query.station),
      commodity: asString(req.query.commodity),
      isActive: asBoolean(req.query.isActive),
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Embargoes fetched successfully."));
  }

  async createEmbargo(
    req: CustomRequest<ScopedInsert<typeof embargoes>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const created = await this.embargoService.create(orgId, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "embargo.create",
      entityType: "embargoes",
      entityId: created.id,
      // The summary is audited alongside the scope: in two years the sentence
      // is what a reader understands, and the jsonb is what the solver obeyed.
      after: { ...created, summary: created.summary },
      ip: req.ip,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, created, "Embargo created successfully."));
  }

  async updateEmbargo(
    req: CustomRequest<Partial<ScopedInsert<typeof embargoes>>>,
    res: Response,
  ) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.embargoService.findById(orgId, id);
    if (!before) throw new ApiError(404, "Embargo not found");

    const updated = await this.embargoService.update(orgId, id, req.body);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "embargo.update",
      entityType: "embargoes",
      entityId: id,
      before,
      after: updated,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "Embargo updated successfully."));
  }

  /**
   * Ends an embargo. `DELETE` in the API, `is_active = false` in the database —
   * the row is the evidence for every solver run that honoured it.
   */
  async endEmbargo(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.embargoService.findById(orgId, id);
    if (!before) throw new ApiError(404, "Embargo not found");

    const ended = await this.embargoService.end(orgId, id);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: actorRole(req),
      action: "embargo.end",
      entityType: "embargoes",
      entityId: id,
      before,
      after: ended,
      ip: req.ip,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, ended, "Embargo ended successfully."));
  }

  /**
   * The scope builder's live preview.
   *
   * Server-side so the sentence a controller reads before saving comes from the
   * same function that describes it afterwards — and, more importantly, from the
   * same module as the matcher Phase 7 will run. A preview computed separately in
   * the SPA would be a second opinion about what an embargo means.
   */
  async previewScope(
    req: CustomRequest<{ scope: EmbargoScope }>,
    res: Response,
  ) {
    const { scope } = req.body;
    assertScopeVersion(scope);

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { summary: describeScope(scope) },
          "Scope preview.",
        ),
      );
  }
}

export default TerminalController;

/**
 * User-administration controller.
 *
 * Every mutation here writes to `audit_log`, and every one of them writes a
 * `before`/`after` pair narrow enough to be safe to keep forever — never the
 * whole row, which would put a password hash into an append-only table nobody
 * can redact. The audit viewer this phase ships is the reason the pairs are
 * shaped this way: a diff of two objects with the same three keys reads as a
 * change, while a diff of two whole rows reads as noise.
 */
import type { Logger } from "winston";
import type { Response } from "express";

import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import { toPositiveInt } from "../../../utils/query";
import type { CustomRequest } from "../../../types/common.types";
import ERROR_MESSAGE from "../../../constants/error-message.constants";
import { requireTenant } from "../../../middlewares/tenant.middleware";
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
} from "../../../types/pagination.types";
import type { RoleName, UserStatus } from "../../../schema";

import AuditService from "../../audit/services/audit.service";
import InvitationService from "../services/invitation.service";
import OrganizationService from "../../organization/services/organization.service";
import UserAdminService, {
  RoleAlreadyAssignedError,
  RoleNotFoundError,
} from "../services/user-admin.service";
import type {
  IAssignRoleBody,
  ICreateUserBody,
  IListUsersQuery,
  IUpdateUserBody,
} from "../types/user-admin.types";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * Express 5 types `req.params.x` as `string | string[]` because a pattern *can*
 * declare the same name twice. These routes do not, so the array case is
 * unreachable — narrowed once here rather than cast at nine call sites.
 */
const pathParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

class UserAdminController {
  constructor(
    private readonly userAdminService: UserAdminService,
    private readonly auditService: AuditService,
    private readonly invitationService: InvitationService,
    private readonly organizationService: OrganizationService,
    private readonly logger: Logger,
  ) {}

  /** The role in force on this request — denormalised onto every audit row. */
  private actorRole<T>(req: CustomRequest<T>): RoleName | null {
    return req.userRoles?.[0]?.name ?? null;
  }

  async list(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const query: IListUsersQuery = {
      page: toPositiveInt(req.query.page, DEFAULT_PAGE),
      limit: toPositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT),
      sort: asString(req.query.sort),
      order: req.query.order === "asc" ? "asc" : "desc",
      search: asString(req.query.search),
      status: asString(req.query.status) as UserStatus | undefined,
      role: asString(req.query.role) as RoleName | undefined,
    };

    const result = await this.userAdminService.list(orgId, query);

    return res
      .status(200)
      .json(new ApiResponse(200, result, "Users fetched successfully."));
  }

  async detail(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);

    const user = await this.userAdminService.findById(
      orgId,
      pathParam(req.params.id),
    );
    // 404 rather than 403 for a user in another tenant. Telling the caller the
    // id is real but off-limits confirms the id — which is the one fact they
    // did not have.
    if (!user) throw new ApiError(404, ERROR_MESSAGE.USER_NOT_FOUND);

    return res
      .status(200)
      .json(new ApiResponse(200, user, "User fetched successfully."));
  }

  async create(req: CustomRequest<ICreateUserBody>, res: Response) {
    const { orgId } = requireTenant(req);

    if (await this.userAdminService.emailExists(req.body.email)) {
      throw new ApiError(409, ERROR_MESSAGE.USER_ALREADY_EXISTS);
    }

    let created;
    try {
      created = await this.userAdminService.create(orgId, req.body);
    } catch (error) {
      throw this.translate(error);
    }

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: this.actorRole(req),
      action: "user.create",
      entityType: "users",
      entityId: created.id,
      after: {
        email: created.email,
        fullName: created.fullName,
        status: created.status,
        roles: created.roles.map((r) => r.name),
      },
      ip: req.ip ?? null,
    });

    this.logger.info({
      event: "USER_CREATED",
      userId: created.id,
      actorId: req.user?.id,
    });

    // The account exists whatever happens next. Queueing is best-effort by
    // design — see EmailJobService.enqueue — so a dead broker produces a created
    // user and an honest "it could not be queued", never a 500 that hides the
    // row and makes the admin click again.
    //
    // Note what this response deliberately does NOT claim: delivery. The send
    // happens in a consumer, so nothing here can honestly say "emailed".
    const invitation = await this.invite(req, orgId, created.id, "user.invite");

    return res
      .status(201)
      .json(
        new ApiResponse(
          201,
          { ...created, invitation },
          invitation?.queued
            ? `User created. An invitation is on its way to ${created.email}.`
            : "User created, but the invitation could not be sent. Check the email job, then use Resend.",
        ),
      );
  }

  /**
   * Issues an invitation and audits it.
   *
   * Shared by create and resend so the two send the identical email and record
   * the identical row. Returns null when the user vanished between the two
   * calls, which the callers treat as "no invitation", not as an error.
   */
  private async invite<T>(
    req: CustomRequest<T>,
    orgId: string,
    userId: string,
    action: string,
  ): Promise<{
    queued: boolean;
    expiresAt: Date;
    emailJobId: string | null;
  } | null> {
    const user = await this.userAdminService.rowById(orgId, userId);
    if (!user) return null;

    const organization =
      await this.organizationService.getOrganizationById(orgId);

    const dispatched = await this.invitationService.dispatchInvitation({
      user,
      organizationName: organization?.name ?? null,
      invitedById: req.user?.id ?? null,
      invitedByName: req.user?.fullName ?? null,
    });

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: this.actorRole(req),
      action,
      entityType: "users",
      entityId: userId,
      // The token is never audited — an append-only table nobody can redact is
      // the last place a live credential should be written. `emailJobId` is the
      // thread that leads to the delivery outcome, which is unknowable here now
      // that the send is asynchronous.
      after: {
        email: user.email,
        template: "invitation",
        emailJobId: dispatched.emailJobId,
        expiresAt: dispatched.expiresAt,
      },
      ip: req.ip ?? null,
    });

    return {
      queued: dispatched.queued,
      expiresAt: dispatched.expiresAt,
      emailJobId: dispatched.emailJobId,
    };
  }

  /**
   * POST /users/:id/invite — re-send, which also supersedes the previous link.
   *
   * Refused for an already-active account: that person has a password, and the
   * flow for having forgotten it is the reset, not a fresh invitation. Allowing
   * it here would give an admin a way to hand out a password-setting link for a
   * live account.
   */
  async resendInvitation(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const user = await this.userAdminService.rowById(orgId, id);
    if (!user) throw new ApiError(404, ERROR_MESSAGE.USER_NOT_FOUND);

    if (user.hashPassword) {
      throw new ApiError(
        409,
        "This account is already activated. Ask the user to reset their password instead.",
      );
    }

    const invitation = await this.invite(req, orgId, id, "user.invite.resend");

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          invitation,
          invitation?.queued
            ? `A new invitation is on its way to ${user.email}. Any earlier link has stopped working.`
            : "Invitation re-issued, but it could not be sent. Check the email job, then try again.",
        ),
      );
  }

  async update(req: CustomRequest<IUpdateUserBody>, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const before = await this.userAdminService.rowById(orgId, id);
    if (!before) throw new ApiError(404, ERROR_MESSAGE.USER_NOT_FOUND);

    if (Object.keys(req.body ?? {}).length === 0) {
      throw new ApiError(400, ERROR_MESSAGE.NO_FIELDS_TO_UPDATE);
    }

    const updated = await this.userAdminService.update(orgId, id, req.body);
    if (!updated) throw new ApiError(404, ERROR_MESSAGE.USER_NOT_FOUND);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: this.actorRole(req),
      action: "user.update",
      entityType: "users",
      entityId: id,
      before: {
        firstName: before.firstName,
        middleName: before.middleName,
        lastName: before.lastName,
        phone: before.phone,
        gender: before.gender,
        status: before.status,
      },
      after: {
        firstName: updated.firstName,
        middleName: updated.middleName,
        lastName: updated.lastName,
        phone: updated.phone,
        gender: req.body.gender ?? before.gender,
        status: updated.status,
      },
      ip: req.ip ?? null,
    });

    return res
      .status(200)
      .json(new ApiResponse(200, updated, "User updated successfully."));
  }

  async assignRole(req: CustomRequest<IAssignRoleBody>, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);

    const target = await this.userAdminService.rowById(orgId, id);
    if (!target) throw new ApiError(404, ERROR_MESSAGE.USER_NOT_FOUND);

    let grant;
    try {
      grant = await this.userAdminService.assignRole(orgId, id, req.body.role);
    } catch (error) {
      throw this.translate(error);
    }

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: this.actorRole(req),
      action: "user.role.assign",
      entityType: "user_roles",
      entityId: grant.userRoleId,
      after: { userId: id, role: grant.name, status: "active" },
      ip: req.ip ?? null,
    });

    this.logger.info({
      event: "USER_ROLE_ASSIGNED",
      userId: id,
      role: grant.name,
      actorId: req.user?.id,
    });

    const user = await this.userAdminService.findById(orgId, id);

    return res
      .status(201)
      .json(new ApiResponse(201, user, `Role ${grant.name} assigned.`));
  }

  async revokeRole(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const id = pathParam(req.params.id);
    const userRoleId = pathParam(req.params.userRoleId);

    const revoked = await this.userAdminService.revokeRole(
      orgId,
      id,
      userRoleId,
    );
    if (!revoked) throw new ApiError(404, ERROR_MESSAGE.ROLE_NOT_FOUND);

    await this.auditService.record({
      orgId,
      actorId: req.user?.id ?? null,
      actorRole: this.actorRole(req),
      action: "user.role.revoke",
      entityType: "user_roles",
      entityId: userRoleId,
      before: { userId: id, role: revoked.name, status: "active" },
      after: { userId: id, role: revoked.name, status: "revoked" },
      ip: req.ip ?? null,
    });

    this.logger.info({
      event: "USER_ROLE_REVOKED",
      userId: id,
      role: revoked.name,
      actorId: req.user?.id,
    });

    const user = await this.userAdminService.findById(orgId, id);

    return res
      .status(200)
      .json(new ApiResponse(200, user, `Role ${revoked.name} revoked.`));
  }

  /** Service-level failures that are client mistakes, not server faults. */
  private translate(error: unknown): unknown {
    if (error instanceof RoleNotFoundError) {
      return new ApiError(404, ERROR_MESSAGE.ROLE_NOT_FOUND);
    }
    if (error instanceof RoleAlreadyAssignedError) {
      return new ApiError(409, ERROR_MESSAGE.ROLE_ALREADY_ASSIGNED);
    }
    const code =
      (error as { code?: string }).code ??
      (error as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") {
      return new ApiError(409, ERROR_MESSAGE.USER_ALREADY_EXISTS);
    }
    return error;
  }
}

export default UserAdminController;

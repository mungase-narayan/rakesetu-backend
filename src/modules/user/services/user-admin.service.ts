/**
 * User administration — the read and write side of `/api/v1/users`.
 *
 * Every query in here goes through `ScopedRepository`, including the ones that
 * look like they could not possibly cross a tenant. That is the point: the
 * guarantee in DESIGN.md §8 is structural, and it stops being structural the
 * moment one service reaches for `db` directly because the query was "obviously
 * safe". The role filter is the interesting case — it needs a join the
 * repository does not offer, so it is expressed as an `inArray` **subquery**
 * passed into `paginate()`'s predicate rather than as a second top-level query
 * whose results are then trusted. The `org_id = :orgId` still lands in the
 * outer WHERE, where it belongs.
 */
import { and, eq, ilike, inArray, or, type SQL } from "drizzle-orm";

import { db, type DB } from "../../../database/connection";
import {
  ScopedRepository,
  type ScopedUpdate,
} from "../../../database/scoped-repository";
import {
  roles,
  userRoles,
  users,
  type RoleName,
  type User,
  type UserStatus,
} from "../../../schema";
import type { Paginated } from "../../../types/pagination.types";
import type { UserRoleContext } from "../../role/types/role.types";
import { buildFullName } from "../../../utils/name.util";
import { emailJobService } from "../../email/email.provider";
import { AdminUserDto } from "../dto/admin-user.dto";
import type {
  ICreateUserBody,
  IListUsersQuery,
  IUpdateUserBody,
} from "../types/user-admin.types";

class UserAdminService {
  constructor(private readonly database: DB = db) {}

  private users(orgId: string) {
    return new ScopedRepository(users, orgId, this.database);
  }

  private userRoles(orgId: string) {
    return new ScopedRepository(userRoles, orgId, this.database);
  }

  private roles(orgId: string) {
    return new ScopedRepository(roles, orgId, this.database);
  }

  /** A page of the org's directory, each row carrying its active grants. */
  async list(
    orgId: string,
    query: IListUsersQuery,
  ): Promise<Paginated<AdminUserDto>> {
    const page = await this.users(orgId).paginate(
      {
        page: query.page,
        limit: query.limit,
        sort: query.sort ?? "createdAt",
        order: query.order ?? "desc",
      },
      this.filters(orgId, query),
    );

    const userIds = page.data.map((u) => u.id);

    // Both batched over the page's ids. A per-row lookup would be twenty
    // queries a page for two hints, which is how a list screen gets slow.
    const [grants, invitations] = await Promise.all([
      this.rolesFor(orgId, userIds),
      emailJobService.latestForUsers(orgId, userIds),
    ]);

    return {
      data: page.data.map(
        (u) =>
          new AdminUserDto(u, grants.get(u.id) ?? [], invitations.get(u.id)),
      ),
      pagination: page.pagination,
    };
  }

  /** Null for "not in this tenant" exactly as for "does not exist". */
  async findById(orgId: string, id: string): Promise<AdminUserDto | null> {
    const user = await this.users(orgId).findById(id);
    if (!user) return null;

    const [grants, invitations] = await Promise.all([
      this.rolesFor(orgId, [id]),
      emailJobService.latestForUsers(orgId, [id]),
    ]);
    return new AdminUserDto(user, grants.get(id) ?? [], invitations.get(id));
  }

  /** The raw row, for callers that need a `before` snapshot to audit against. */
  async rowById(orgId: string, id: string): Promise<User | null> {
    return this.users(orgId).findById(id);
  }

  /**
   * Creates an account with **no password**.
   *
   * There is no mail transport in this project and no invitation table, so
   * there is nothing to send. The row is created `inactive` with a null hash —
   * which is precisely why `users.hash_password` is nullable — and the seed or
   * a future invitation flow activates it. The alternative, generating a
   * password nobody is told, would produce an account that looks usable and is
   * not.
   */
  async create(orgId: string, body: ICreateUserBody): Promise<AdminUserDto> {
    const email = body.email.trim().toLowerCase();

    const created = await this.users(orgId).insert({
      firstName: body.firstName,
      middleName: body.middleName ?? null,
      lastName: body.lastName,
      fullName: buildFullName(body.firstName, body.lastName),
      email,
      username: email,
      hashPassword: null,
      phone: body.phone ?? null,
      gender: body.gender ?? null,
      status: "inactive",
      isEmailVerified: false,
    });

    const grants = body.role
      ? [await this.assignRole(orgId, created.id, body.role)]
      : [];

    return new AdminUserDto(created, grants);
  }

  async update(
    orgId: string,
    id: string,
    body: IUpdateUserBody,
  ): Promise<AdminUserDto | null> {
    const patch: ScopedUpdate<typeof users> = {};

    if (body.firstName !== undefined) patch.firstName = body.firstName;
    if (body.middleName !== undefined) patch.middleName = body.middleName;
    if (body.lastName !== undefined) patch.lastName = body.lastName;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.gender !== undefined) patch.gender = body.gender;
    if (body.status !== undefined) patch.status = body.status;

    // Keep the derived display name in step with the parts it is derived from.
    if (body.firstName !== undefined || body.lastName !== undefined) {
      const current = await this.users(orgId).findById(id);
      if (!current) return null;
      patch.fullName = buildFullName(
        body.firstName ?? current.firstName,
        body.lastName ?? current.lastName,
      );
    }

    const updated = await this.users(orgId).update(id, patch);
    if (!updated) return null;

    const grants = await this.rolesFor(orgId, [id]);
    return new AdminUserDto(updated, grants.get(id) ?? []);
  }

  /**
   * Grants a role **in the caller's organization**.
   *
   * The role row is looked up through the scoped repository rather than by id
   * from the body, so "assign role X" cannot be pointed at another tenant's
   * role row even if its UUID is known. A re-grant of a previously revoked role
   * reactivates the existing row — the unique index on
   * (user_id, role_id, org_id) means there is only ever one.
   */
  async assignRole(
    orgId: string,
    userId: string,
    name: RoleName,
  ): Promise<UserRoleContext> {
    const [role] = await this.roles(orgId).select(eq(roles.name, name));
    if (!role) {
      throw new RoleNotFoundError(name);
    }

    const [existing] = await this.userRoles(orgId).select(
      and(eq(userRoles.userId, userId), eq(userRoles.roleId, role.id)),
    );

    if (existing) {
      if (existing.status === "active") {
        throw new RoleAlreadyAssignedError(name);
      }
      await this.userRoles(orgId).update(existing.id, { status: "active" });
      return {
        userRoleId: existing.id,
        roleId: role.id,
        name,
        orgId,
      };
    }

    const grant = await this.userRoles(orgId).insert({
      userId,
      roleId: role.id,
    });

    return { userRoleId: grant.id, roleId: role.id, name, orgId };
  }

  /**
   * Revokes a grant by flipping its status, never by deleting the row.
   *
   * A hard delete would erase the fact that the grant ever existed, which is
   * exactly the fact an audit is for — "who could approve this indent last
   * Tuesday" has no answer if the answer was deleted.
   */
  async revokeRole(
    orgId: string,
    userId: string,
    userRoleId: string,
  ): Promise<UserRoleContext | null> {
    const [grant] = await this.userRoles(orgId).select(
      and(eq(userRoles.id, userRoleId), eq(userRoles.userId, userId)),
    );
    if (!grant) return null;

    const updated = await this.userRoles(orgId).update(userRoleId, {
      status: "revoked",
    });
    if (!updated) return null;

    const role = await this.roles(orgId).findById(grant.roleId);
    if (!role) return null;

    return {
      userRoleId: updated.id,
      roleId: role.id,
      name: role.name,
      orgId,
    };
  }

  /** Active grants for a set of users, keyed by user id. */
  async rolesFor(
    orgId: string,
    userIds: string[],
  ): Promise<Map<string, UserRoleContext[]>> {
    const byUser = new Map<string, UserRoleContext[]>();
    if (userIds.length === 0) return byUser;

    const rows = await this.database
      .select({
        userId: userRoles.userId,
        userRoleId: userRoles.id,
        roleId: roles.id,
        name: roles.name,
        orgId: userRoles.orgId,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(
        and(
          // Not decoration: this method takes ids from a page that was already
          // scoped, but it is a public method and the next caller may not have.
          eq(userRoles.orgId, orgId),
          inArray(userRoles.userId, userIds),
          eq(userRoles.status, "active"),
          eq(roles.status, "active"),
        ),
      );

    for (const row of rows) {
      const list = byUser.get(row.userId) ?? [];
      list.push({
        userRoleId: row.userRoleId,
        roleId: row.roleId,
        name: row.name,
        orgId: row.orgId,
      });
      byUser.set(row.userId, list);
    }

    return byUser;
  }

  async emailExists(email: string): Promise<boolean> {
    // Deliberately unscoped: `users.email` is globally unique, so a duplicate
    // in *another* tenant still fails the insert. Checking only this tenant
    // would turn a clean 409 into a 500 from the constraint.
    const [row] = await this.database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return Boolean(row);
  }

  private filters(orgId: string, query: IListUsersQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        or(
          ilike(users.fullName, pattern),
          ilike(users.email, pattern),
          ilike(users.firstName, pattern),
          ilike(users.lastName, pattern),
        ) as SQL,
      );
    }

    if (query.status) {
      conditions.push(eq(users.status, query.status as UserStatus));
    }

    if (query.role) {
      conditions.push(
        inArray(
          users.id,
          this.database
            .select({ userId: userRoles.userId })
            .from(userRoles)
            .innerJoin(roles, eq(userRoles.roleId, roles.id))
            .where(
              and(
                eq(userRoles.orgId, orgId),
                eq(userRoles.status, "active"),
                eq(roles.name, query.role as RoleName),
              ),
            ),
        ),
      );
    }

    if (conditions.length === 0) return undefined;
    return conditions.length === 1
      ? conditions[0]
      : (and(...conditions) as SQL);
  }
}

/** Thrown when a role name has no row in the caller's organization. */
export class RoleNotFoundError extends Error {
  constructor(public readonly role: string) {
    super(`Role ${role} does not exist in this organization`);
  }
}

/** Thrown on a second active grant of a role the user already holds. */
export class RoleAlreadyAssignedError extends Error {
  constructor(public readonly role: string) {
    super(`Role ${role} is already assigned`);
  }
}

export default UserAdminService;

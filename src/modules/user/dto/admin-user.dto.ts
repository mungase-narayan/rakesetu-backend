/**
 * The shape the user-administration screens read.
 *
 * `LoginUserDto` is the *self* view — what a person is told about themselves.
 * This is the *directory* view: the same person as seen by an admin, with the
 * operational columns a list screen needs (phone, last login, role grants) and
 * still without a single field the table happens to carry and nobody asked for.
 * Two DTOs rather than one widened DTO, because "add a column to `users`" must
 * not be able to widen an API response by accident.
 */
import type { EmailJob, User } from "../../../schema";
import type { UserRoleContext } from "../../role/types/role.types";

export class AdminUserRoleDto {
  userRoleId: string;
  roleId: string;
  name: string;

  constructor(role: UserRoleContext) {
    this.userRoleId = role.userRoleId;
    this.roleId = role.roleId;
    this.name = role.name;
  }
}

/**
 * What became of the most recent invitation email.
 *
 * The account's own `hasPassword` already answers the question that matters —
 * did they get in — so this exists for the one it cannot: *why not*. An
 * invitation that failed to send looks identical to one nobody has opened yet,
 * and only one of those is the administrator's problem to fix.
 */
export class AdminUserInvitationDto {
  status: string;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;

  constructor(job: EmailJob) {
    this.status = job.status;
    this.attempts = job.attempts;
    this.lastError = job.lastError;
    this.sentAt = job.sentAt;
    this.createdAt = job.createdAt;
  }
}

export class AdminUserDto {
  id: string;
  orgId: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  fullName: string | null;
  email: string;
  username: string;
  phone: string | null;
  status: string;
  isEmailVerified: boolean;
  /**
   * Null when the account has never been activated — the create endpoint sets
   * no password, so this is how the UI knows to say "invitation pending"
   * instead of implying the person simply has not signed in yet.
   */
  hasPassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: AdminUserRoleDto[];
  /** Null when no invitation has ever been queued for this account. */
  lastInvitation: AdminUserInvitationDto | null;

  constructor(
    user: User,
    roles: readonly UserRoleContext[] = [],
    lastInvitation?: EmailJob | null,
  ) {
    this.id = user.id;
    this.orgId = user.orgId;
    this.firstName = user.firstName;
    this.middleName = user.middleName;
    this.lastName = user.lastName;
    this.fullName = user.fullName;
    this.email = user.email;
    this.username = user.username;
    this.phone = user.phone;
    this.status = user.status;
    this.isEmailVerified = user.isEmailVerified;
    this.hasPassword = Boolean(user.hashPassword);
    this.lastLoginAt = user.lastLoginAt;
    this.createdAt = user.createdAt;
    this.roles = roles.map((r) => new AdminUserRoleDto(r));
    this.lastInvitation = lastInvitation
      ? new AdminUserInvitationDto(lastInvitation)
      : null;
  }
}

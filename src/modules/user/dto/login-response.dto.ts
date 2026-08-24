/**
 * Login response shaping.
 *
 * These DTOs are the contract the frontend types mirror one-for-one
 * (rakesetu-frontend/src/types/user.types.ts). They exist so a new column on
 * `users` — a password hash, an internal flag — can never leak into an API
 * response just by being added to the table.
 */
import type { Organization, User } from "../../../schema";
import type { UserRoleContext } from "../../role/types/role.types";

export class LoginUserDto {
  id: string;
  orgId: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  fullName: string | null;
  email: string;
  username: string;
  isEmailVerified: boolean;
  avatar: string | null;
  status: string;

  constructor(user: User) {
    this.id = user.id;
    this.orgId = user.orgId;
    this.firstName = user.firstName;
    this.middleName = user.middleName;
    this.lastName = user.lastName;
    this.fullName = user.fullName;
    this.email = user.email;
    this.username = user.username;
    this.isEmailVerified = user.isEmailVerified;
    this.avatar = user.avatar;
    this.status = user.status;
  }
}

export class LoginOrganizationDto {
  id: string;
  code: string;
  name: string;
  type: string;
  status: string;

  constructor(organization: Organization) {
    this.id = organization.id;
    this.code = organization.code;
    this.name = organization.name;
    this.type = organization.type;
    this.status = organization.status;
  }
}

export class LoginRoleDto {
  name: string;
  userRoleId: string;

  constructor(role: UserRoleContext) {
    this.name = role.name;
    this.userRoleId = role.userRoleId;
  }
}

/**
 * The access token only. The refresh token travels as an httpOnly cookie and is
 * deliberately absent from every response body — see DECISIONS.md D4. Adding it
 * back here would put it in redux-persist and therefore in localStorage, which
 * is the precise exposure the cookie exists to close.
 */
export class LoginTokensDto {
  accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }
}

export class LoginResponseDto {
  user: LoginUserDto;
  organization: LoginOrganizationDto | null;
  roles: LoginRoleDto[];
  tokens: LoginTokensDto;

  constructor(
    user: User,
    organization: Organization | null,
    roles: UserRoleContext[],
    accessToken: string,
  ) {
    this.user = new LoginUserDto(user);
    this.organization = organization
      ? new LoginOrganizationDto(organization)
      : null;
    this.roles = roles.map((r) => new LoginRoleDto(r));
    this.tokens = new LoginTokensDto(accessToken);
  }
}

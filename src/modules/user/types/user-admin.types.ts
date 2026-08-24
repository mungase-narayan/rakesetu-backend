/**
 * Request contracts for the user-administration endpoints.
 *
 * Note what is *not* here: `orgId` and `password`. The tenant is settled by the
 * caller's identity and injected by `ScopedRepository`, so a body field for it
 * would be a field with no effect and an invitation to think otherwise. The
 * password is absent because this API cannot set one — see the create service.
 */
import type { Gender, RoleName, UserStatus } from "../../../schema";

export interface IListUsersQuery {
  page?: number;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
  search?: string;
  status?: UserStatus;
  role?: RoleName;
}

export interface ICreateUserBody {
  firstName: string;
  middleName?: string | null;
  lastName: string;
  email: string;
  phone?: string | null;
  gender?: Gender | null;
  /** Optional: an account may be created before anyone decides what it does. */
  role?: RoleName;
}

export interface IUpdateUserBody {
  firstName?: string;
  middleName?: string | null;
  lastName?: string;
  phone?: string | null;
  gender?: Gender | null;
  status?: UserStatus;
}

export interface IAssignRoleBody {
  role: RoleName;
}

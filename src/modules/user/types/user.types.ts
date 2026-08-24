/**
 * User module type contracts: SafeUser (User without hashPassword) and the
 * request body interfaces consumed by the user controller endpoints.
 */
import type { User, UserStatus } from "../../../schema";

export type { UserStatus };

/** The user shape that is safe to attach to req.user and to serialize. */
export type SafeUser = Omit<User, "hashPassword">;

export interface ILoginBody {
  email: string;
  password: string;
}

export interface IRefreshBody {
  refreshToken?: string;
}

export interface IUpdateMeBody {
  username?: string;
  avatar?: string | null;
}

/**
 * JWT authentication middleware: pulls the access token from cookies or
 * the Authorization header, verifies it, loads the matching user from the
 * database, and attaches a sanitized user (no hashPassword) to req.user.
 */
import { eq } from "drizzle-orm";
import { NextFunction, Response, Request } from "express";

import { users } from "../schema";
import { db } from "../database/connection";
import ApiError from "../utils/api-error";
import asyncHandler from "../utils/async-handler";
import ERROR_MESSAGE from "../constants/error-message.constants";
import { CustomJwtPayload, CustomRequest } from "../types/common.types";

import TokenService from "../modules/user/services/token.service";

const tokenService = new TokenService();

const extractToken = (req: Request): string | undefined => {
  return (
    req.cookies?.accessToken ||
    req.header("Authorization")?.replace("Bearer ", "")
  );
};

/**
 * The same extraction, plus `?token=` — **for `EventSource` and nothing else.**
 *
 * The browser's `EventSource` cannot set an `Authorization` header and does not
 * send credentials cross-origin by default, so a token in the query string is
 * the only way to authenticate an SSE subscription from a SPA on another
 * origin. That is a real constraint, not a shortcut, and it is confined to the
 * one middleware below rather than folded into `extractToken` — a URL is
 * logged by proxies and kept in browser history, and widening the rule would
 * silently put every request's token in both.
 *
 * Everything after extraction is identical: the same verification, the same
 * user load, the same `req.user`. In particular the **tenant is still read off
 * the user row** by `withTenant`, so nothing in the query string decides which
 * organization's frames a subscriber receives.
 */
const extractStreamToken = (req: Request): string | undefined => {
  const fromQuery = req.query?.token;
  if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;
  return extractToken(req);
};

const validateDecodedUser = (decodedToken: CustomJwtPayload): void => {
  if (!decodedToken.user?.id) {
    throw new ApiError(401, ERROR_MESSAGE.INVALID_JWT_TOKEN);
  }
};

const authenticate = async (
  req: CustomRequest,
  next: NextFunction,
  accessToken: string | undefined,
): Promise<void> => {
  if (!accessToken) {
    throw new ApiError(401, ERROR_MESSAGE.UNAUTHORIZED_REQUEST);
  }

  try {
    const decodedToken = tokenService.verifyAccessToken(accessToken);
    validateDecodedUser(decodedToken);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, decodedToken.user.id));

    if (!user) {
      throw new ApiError(401, ERROR_MESSAGE.INVALID_JWT_TOKEN);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { hashPassword, ...safeUser } = user;
    req.user = safeUser;
    next();
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      throw error;
    }
    const errorMessage =
      error instanceof Error ? error.message : ERROR_MESSAGE.INVALID_JWT_TOKEN;

    throw new ApiError(401, errorMessage);
  }
};

export const verifyJWT = asyncHandler(
  async (req: CustomRequest, _res: Response, next: NextFunction) =>
    authenticate(req, next, extractToken(req)),
);

/**
 * `verifyJWT` for a route an `EventSource` opens. Accepts `?token=` as well as
 * the header and the cookie; everything downstream is unchanged.
 *
 * Mount it **only** on `text/event-stream` routes.
 */
export const verifyStreamJWT = asyncHandler(
  async (req: CustomRequest, _res: Response, next: NextFunction) =>
    authenticate(req, next, extractStreamToken(req)),
);

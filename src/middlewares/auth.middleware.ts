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

const validateDecodedUser = (decodedToken: CustomJwtPayload): void => {
  if (!decodedToken.user?.id) {
    throw new ApiError(401, ERROR_MESSAGE.INVALID_JWT_TOKEN);
  }
};

export const verifyJWT = asyncHandler(
  async (req: CustomRequest, _res: Response, next: NextFunction) => {
    const accessToken = extractToken(req);

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
        error instanceof Error
          ? error.message
          : ERROR_MESSAGE.INVALID_JWT_TOKEN;

      throw new ApiError(401, errorMessage);
    }
  },
);

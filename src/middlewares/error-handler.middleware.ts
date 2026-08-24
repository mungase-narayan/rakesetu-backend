/**
 * Global Express error handler: normalizes any thrown error into an
 * ApiError, logs it, and returns a JSON response (with the stack trace
 * included only in development).
 */
import { NextFunction, Request, Response } from "express";

import env from "../config/env.config";
import logger from "../logger/winston.logger";
import ApiError from "../utils/api-error";
import ERROR_MESSAGE from "../constants/error-message.constants";

/**
 * Postgres SQLSTATEs worth translating into a meaningful HTTP status. Drizzle
 * wraps the driver error, so the code sits on `cause`, not the error itself.
 */
const PG_ERRORS: Record<string, { status: number; message: string }> = {
  "23503": { status: 409, message: ERROR_MESSAGE.RESOURCE_IN_USE }, // foreign_key_violation
  "23505": { status: 409, message: ERROR_MESSAGE.DUPLICATE_RECORD }, // unique_violation
  "23502": { status: 400, message: ERROR_MESSAGE.INVALID_REFERENCE }, // not_null_violation
  "22P02": { status: 400, message: ERROR_MESSAGE.INVALID_REFERENCE }, // invalid_text_representation
};

const pgErrorCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
};

const errorHandlerMiddleware = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  let error = err;

  if (!(error instanceof ApiError)) {
    const mapped = PG_ERRORS[pgErrorCode(err) ?? ""];

    // Never surface a raw driver message: drizzle puts the full SQL and the
    // bound parameters in `message`, which would leak the schema to callers.
    const statusCode = mapped?.status ?? error.statusCode ?? 500;
    const message =
      mapped?.message ??
      (error.statusCode && error.statusCode < 500
        ? error.message
        : ERROR_MESSAGE.SERVER_ERROR);

    error = new ApiError(statusCode, message, error?.errors || [], err.stack);
  }

  logger.error(`${error.message}`, {
    cause: err?.cause,
    pgCode: pgErrorCode(err),
    // The driver message is useful in logs even though it never leaves here.
    original: err?.message,
  });

  const response = {
    ...error,
    message: error.message,
    ...(env.app.isDev ? { stack: error.stack } : {}),
  };

  return res.status(error.statusCode).json(response);
};

export default errorHandlerMiddleware;

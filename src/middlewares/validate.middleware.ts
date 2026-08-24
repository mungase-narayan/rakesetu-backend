/**
 * Validation guard: runs express-validator results, collects any field
 * errors, and throws a 422 ApiError so the global handler can format
 * the response.
 */
import { Request, Response, NextFunction } from "express";
import { ValidationError, validationResult } from "express-validator";

import ApiError from "../utils/api-error";

const validateMiddleware = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }
  const extractedErrors: unknown[] = [];
  errors.array().forEach((err: ValidationError) => {
    if (err.type === "field") {
      extractedErrors.push({ [err.path]: err.msg });
    } else {
      extractedErrors.push({ error: err.msg });
    }
  });

  throw new ApiError(422, "Received data is not valid", extractedErrors);
};

export default validateMiddleware;

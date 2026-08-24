/**
 * Wraps an async Express route handler so any rejected promise is
 * forwarded to next(err), letting the global error middleware handle it
 * instead of crashing on unhandled rejections.
 */
import { Request, Response, NextFunction } from "express";

const asyncHandler = (
  requestHandler: (req: Request, res: Response, next: NextFunction) => void,
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(requestHandler(req, res, next)).catch((err) => {
      return next(err);
    });
  };
};

export default asyncHandler;

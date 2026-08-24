/**
 * Correlation id: one identifier per request, threaded through the logs, the
 * audit trail and the AI queue (DESIGN.md §12).
 *
 * An inbound `X-Request-Id` is honoured so a trace started by a gateway, the
 * SPA or a load test stays one trace across services. It is echoed back on the
 * response so a user reporting a failure can quote the id off their network tab
 * and land on the exact request.
 *
 * Must be mounted before the loggers — a line written before this runs has no
 * id to carry.
 */
import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";

import { runWithContext } from "../logger/request-context";
import { CustomRequest } from "../types/common.types";

export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * An inbound id is client-controlled, so it is bounded and stripped of anything
 * that is not id-shaped before it reaches a log line or a varchar(64) column.
 */
const sanitize = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/[^A-Za-z0-9._:-]/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : undefined;
};

export const requestId = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const correlationId = sanitize(req.header(REQUEST_ID_HEADER)) ?? randomUUID();

  (req as CustomRequest).correlationId = correlationId;
  res.setHeader(REQUEST_ID_HEADER, correlationId);

  // Everything downstream — handlers, services, the audit write, the queue
  // publish — runs inside this store and can read the id without being handed it.
  runWithContext({ correlationId }, () => next());
};

export default requestId;

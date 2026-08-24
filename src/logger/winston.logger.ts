/**
 * Application logger: configures Winston with custom levels, colors, and
 * a timestamped console transport. Default export used throughout the app.
 *
 * Every line carries the correlation id of the request that produced it, read
 * from AsyncLocalStorage rather than passed in — see logger/request-context.ts.
 * That is what makes "show me everything that happened during this request"
 * a grep instead of an investigation.
 */
import winston from "winston";

import { getCorrelationId } from "./request-context";

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const colors = {
  error: "red",
  warn: "yellow",
  info: "blue",
  http: "magenta",
  debug: "white",
};

winston.addColors(colors);

/**
 * Stamps the active request's correlation id onto the log info object. Winston
 * formats are applied at log time, on the same async chain as the call site, so
 * the store is still the right one here.
 */
const correlation = winston.format((info) => {
  const correlationId = getCorrelationId();
  if (correlationId) info.correlationId = correlationId;
  return info;
});

/** Objects are logged as objects; `${}` would render them as "[object Object]". */
const renderMessage = (message: unknown): string =>
  typeof message === "string" ? message : JSON.stringify(message);

const format = winston.format.combine(
  correlation(),
  winston.format.timestamp({ format: "DD MMM, YYYY - HH:mm:ss:ms" }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    // Short prefix rather than the full uuid: enough to eyeball two interleaved
    // requests apart in a dev console, and the full id is in the response header
    // and the audit row when the exact value is needed.
    const trace = info.correlationId
      ? ` [${String(info.correlationId).slice(0, 8)}]`
      : "";
    return `[${info.timestamp}]${trace} ${info.level}: ${renderMessage(info.message)}`;
  }),
);

const transports = [new winston.transports.Console()];

const logger = winston.createLogger({
  // LOG_LEVEL exists so the integration suite can run at "error" — a failing
  // assertion should be the loudest thing on screen, not the quietest.
  level: process.env.LOG_LEVEL || "debug",
  levels,
  format,
  transports,
});

export default logger;

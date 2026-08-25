/**
 * express-validator chains for the event spine.
 *
 * Two rules here are worth calling out because they are refusals, not
 * normalisations:
 *
 *  - **`recordedAt` is never accepted from a client.** It is the arrival time,
 *    the server owns it, and the gap between it and `occurredAt` is §8's
 *    tampering signal. A caller who could set both could set them equal.
 *  - **`occurredAt` may not be in the future.** A placement that has not
 *    happened yet is not an observation, and accepting one lets somebody start
 *    a demurrage clock before the rake arrives.
 */
import { body, param, query } from "express-validator";

import { EVENT_SOURCES, RAKE_EVENT_TYPES, RAKE_STATES } from "../../../schema";
import {
  EXCEPTION_REASON_CODES,
  REASON_BEARING_EVENTS,
  isExceptionReasonCode,
} from "../../../constants/exception-reason.constants";

/**
 * Reads `events[3].eventType` out of a body.
 *
 * Needed because the reason-code rule below is a statement about **two fields
 * of the same event**, and on the bulk route those two fields live inside an
 * array element. express-validator hands the custom validator the path it is
 * checking, so the sibling is one string substitution away — which is less
 * machinery than splitting the chain into a single and a bulk variant that
 * could drift apart.
 */
const valueAtPath = (body: unknown, path: string): unknown => {
  let cursor: unknown = body;
  for (const segment of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

/** A little slack for clock skew between a siding tablet and the server. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const notInFuture = (value: string): boolean =>
  new Date(value).getTime() <= Date.now() + FUTURE_TOLERANCE_MS;

const eventBody = (prefix = "") => [
  body(`${prefix}eventType`)
    .isIn(RAKE_EVENT_TYPES)
    .withMessage(`eventType must be one of: ${RAKE_EVENT_TYPES.join(", ")}`),
  body(`${prefix}occurredAt`)
    .isISO8601()
    .withMessage("occurredAt must be an ISO-8601 timestamp")
    .bail()
    .custom(notInFuture)
    .withMessage("occurredAt cannot be in the future"),
  body(`${prefix}stationCode`)
    .optional({ values: "null" })
    .isString()
    .trim()
    .toUpperCase()
    .isLength({ min: 2, max: 8 }),
  body(`${prefix}terminalId`).optional({ values: "null" }).isUUID(),
  body(`${prefix}payload`).optional().isObject(),
  /**
   * **An exception must say why, in the shared vocabulary.**
   *
   * `DETAINED`, `MARKED_SICK` and `HELD_FOR_ORDER` are the three events Phase
   * 10 adjudicates waivers from, and it can only do that if the reason is one
   * of the six codes in `exception-reason.constants.ts`. Free text is still
   * accepted alongside — in `payload.note` — because a supervisor always knows
   * something the taxonomy does not. What is refused is a *code* nobody
   * downstream can map.
   */
  body(`${prefix}payload.reasonCode`).custom((value, { req, path }) => {
    const eventType = valueAtPath(
      (req as { body?: unknown }).body,
      path.replace(/payload\.reasonCode$/, "eventType"),
    );

    if (
      !REASON_BEARING_EVENTS.includes(
        eventType as (typeof REASON_BEARING_EVENTS)[number],
      )
    ) {
      return true;
    }

    if (!isExceptionReasonCode(value)) {
      throw new Error(
        `${String(eventType)} needs a payload.reasonCode — one of: ${EXCEPTION_REASON_CODES.join(", ")}`,
      );
    }
    return true;
  }),
  body(`${prefix}payload.note`)
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ max: 500 }),
  body(`${prefix}source`).optional().isIn(EVENT_SOURCES),
  body(`${prefix}sourceRef`)
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ max: 120 }),
  body(`${prefix}correctsEventId`).optional({ values: "null" }).isUUID(),
  body(`${prefix}reopenReason`)
    .optional({ values: "null" })
    .isString()
    .trim()
    .isLength({ min: 5, max: 200 })
    .withMessage("reopenReason must say why — at least five characters"),
];

export const rakeIdParamValidator = [param("rakeId").isUUID()];

export const createEventValidator = [...rakeIdParamValidator, ...eventBody()];

export const bulkEventsValidator = [
  ...rakeIdParamValidator,
  body("events")
    .isArray({ min: 1, max: 500 })
    .withMessage("events must be an array of 1-500 entries"),
  ...eventBody("events.*."),
  // Each element needs its own key: the batch is one HTTP request, but it is
  // many facts, and a retry has to be able to land the ones that are missing.
  body("events.*.idempotencyKey")
    .isString()
    .trim()
    .isLength({ min: 8, max: 120 }),
];

export const listEventsValidator = [
  ...rakeIdParamValidator,
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("eventType").optional().isIn(RAKE_EVENT_TYPES),
  query("includeRejected").optional().isBoolean(),
];

export const listCyclesValidator = [
  ...rakeIdParamValidator,
  query("isClosed").optional().isBoolean(),
];

export const cycleIdParamValidator = [
  ...rakeIdParamValidator,
  param("cycleId").isUUID(),
];

export const listAnomaliesValidator = [
  query("rakeId").optional().isUUID(),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
];

export const listRakeStatesValidator = [
  query("state").optional().isIn(RAKE_STATES),
  query("search").optional().isString().trim(),
];

/** The traversal window. Capped at a month — beyond that it is analytics, not a map. */
export const sectionLoadValidator = [
  query("hours").optional().isInt({ min: 1, max: 720 }).toInt(),
];

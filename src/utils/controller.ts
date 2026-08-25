/**
 * Small shared helpers for controllers.
 *
 * These three appeared verbatim in the Phase 1 user-administration controller
 * and were about to appear in six more with the master-data modules. They are
 * lifted here rather than copied because two of them encode a decision — the
 * pagination clamp and the `order` default — that must not drift between
 * screens: a list that silently allows `?limit=100000` on one resource and not
 * another is a hole, not an inconsistency.
 */
import type { CustomRequest } from "../types/common.types";
import type { RoleName } from "../schema";
import { toPositiveInt } from "./query";
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  type PaginateOptions,
} from "../types/pagination.types";

/** A non-empty trimmed query value, or undefined. Blank strings are not filters. */
export const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * Express 5 types `req.params.x` as `string | string[]` because a pattern *can*
 * declare the same name twice. These routes do not, so the array case is
 * unreachable — narrowed once here rather than cast at every call site.
 */
export const pathParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

/** `page`, `limit`, `sort`, `order` off the query string, clamped. */
export const paginationFrom = <T>(req: CustomRequest<T>): PaginateOptions => ({
  page: toPositiveInt(req.query.page, DEFAULT_PAGE),
  limit: toPositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT),
  sort: asString(req.query.sort),
  order: req.query.order === "asc" ? "asc" : "desc",
});

/**
 * The role in force on this request — denormalised onto every audit row so a
 * later role change cannot rewrite what somebody was allowed to do at the time.
 */
export const actorRole = <T>(req: CustomRequest<T>): RoleName | null =>
  req.userRoles?.[0]?.name ?? null;

/** A repeatable query parameter — `?commodityGroups=cement&commodityGroups=coal`. */
export const asStringArray = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const values = value.map(asString).filter((v): v is string => Boolean(v));
    return values.length > 0 ? values : undefined;
  }
  const single = asString(value);
  if (!single) return undefined;
  // Also accept the comma-separated spelling, which is what a hand-written curl
  // and the frontend's query-string builder both tend to produce.
  const parts = single
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
};

/** A date query parameter. Invalid input is treated as absent, not as epoch. */
export const asDate = (value: unknown): Date | undefined => {
  const raw = asString(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

/** A boolean query parameter, tolerant of `true`/`false` strings. */
export const asBoolean = (value: unknown): boolean | undefined => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
};

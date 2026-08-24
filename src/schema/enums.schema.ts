/**
 * Literal value sets and their matching pgEnums.
 *
 * The `as const` arrays are the single source of truth: the pgEnum is built
 * from them, the TypeScript unions are derived from them, and the
 * express-validator chains validate against them. Adding a value here is the
 * only edit needed (plus a migration).
 */
import { pgEnum } from "drizzle-orm/pg-core";

import { AI_JOB_KINDS } from "../types/queue.types";

/** Who a tenant is. Drives which parts of the product they see. */
export const ORGANIZATION_TYPES = [
  "railway_zone",
  "freight_customer",
  "terminal_operator",
] as const;

export const ORGANIZATION_STATUSES = [
  "active",
  "inactive",
  "suspended",
] as const;

export const USER_STATUSES = [
  "active",
  "inactive",
  "suspended",
  "blocked",
  "archived",
] as const;

export const GENDERS = [
  "male",
  "female",
  "other",
  "prefer_not_to_say",
] as const;

/**
 * The six RakeSetu personas. `freight_customer` belongs to a customer
 * organization; the rest belong to a railway zone or terminal operator.
 */
export const ROLE_NAMES = [
  "admin",
  "zonal_manager",
  "freight_controller",
  "terminal_supervisor",
  "commercial_officer",
  "freight_customer",
] as const;

export const ROLE_STATUSES = ["active", "inactive"] as const;

export const USER_ROLE_STATUSES = ["active", "inactive", "revoked"] as const;

/**
 * The job kinds `ai_jobs.type` can hold. Derived from AI_JOB_KINDS rather than
 * retyped: the routing key, the queue name and this column must agree, and a
 * typo here would be a silent routing bug — a job written with a type no
 * consumer is bound to. The `satisfies` is the compile-time proof they match.
 */
export const AI_JOB_TYPES = AI_JOB_KINDS satisfies readonly [
  string,
  ...string[],
];

/**
 * `needs_human` is a terminal state, not a failure: §9.3's review queues exist
 * because a low-confidence extraction is routed to a person, and that is a
 * successful outcome for the pipeline even though no value was written.
 */
export const AI_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "needs_human",
] as const;

export const organizationTypeEnum = pgEnum(
  "organization_type",
  ORGANIZATION_TYPES,
);
export const organizationStatusEnum = pgEnum(
  "organization_status",
  ORGANIZATION_STATUSES,
);
export const userStatusEnum = pgEnum("user_status", USER_STATUSES);
export const genderEnum = pgEnum("gender", GENDERS);
export const roleNameEnum = pgEnum("role_name", ROLE_NAMES);
export const roleStatusEnum = pgEnum("role_status", ROLE_STATUSES);
export const userRoleStatusEnum = pgEnum(
  "user_role_status",
  USER_ROLE_STATUSES,
);
export const aiJobTypeEnum = pgEnum("ai_job_type", AI_JOB_TYPES);
export const aiJobStatusEnum = pgEnum("ai_job_status", AI_JOB_STATUSES);

export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];
export type Gender = (typeof GENDERS)[number];
export type RoleName = (typeof ROLE_NAMES)[number];
export type RoleStatus = (typeof ROLE_STATUSES)[number];
export type UserRoleStatus = (typeof USER_ROLE_STATUSES)[number];
export type AiJobType = (typeof AI_JOB_TYPES)[number];
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

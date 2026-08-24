/**
 * Literal value sets and their matching pgEnums.
 *
 * The `as const` arrays are the single source of truth: the pgEnum is built
 * from them, the TypeScript unions are derived from them, and the
 * express-validator chains validate against them. Adding a value here is the
 * only edit needed (plus a migration).
 */
import { pgEnum } from "drizzle-orm/pg-core";

import { AI_JOB_KINDS, EMAIL_TEMPLATE_NAMES } from "../types/queue.types";

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
 * What a `user_tokens` row lets its holder do.
 *
 * `invitation` sets a first password and activates the account; `password_reset`
 * replaces an existing one. They are separate values rather than one "set the
 * password" token because the two carry different authority: an invitation
 * flips `status` to active, and a reset must never be able to reactivate an
 * account an administrator has suspended.
 */
export const USER_TOKEN_TYPES = ["invitation", "password_reset"] as const;

/**
 * Which email an `email_jobs` row renders.
 *
 * These are **templates, not queue kinds.** There is one queue (`email.send`);
 * the template is a field in the message. Do not copy `AI_JOB_TYPES`' pattern of
 * routing key === queue name === enum value here — mail differs by what it
 * renders, not by who consumes it, and per-template queues would be three
 * bindings that always fan to the same handler.
 *
 * The wire contract declares the same list independently
 * (`EMAIL_TEMPLATE_NAMES` in types/queue.types.ts) so publishing does not have
 * to import the schema. The assertion below is what keeps the two honest.
 */
export const EMAIL_TEMPLATES = EMAIL_TEMPLATE_NAMES satisfies readonly [
  string,
  ...string[],
];

/**
 * Four states, and the two that are missing are deliberate. There is no
 * `needs_human` — a failed send needs a resend, not adjudication. There is no
 * `cancelled` — you cannot un-send an email, so the state would be a lie about
 * a message that may already be in flight.
 */
export const EMAIL_JOB_STATUSES = [
  "queued",
  "sending",
  "sent",
  "failed",
] as const;

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
export const userTokenTypeEnum = pgEnum("user_token_type", USER_TOKEN_TYPES);
export const emailTemplateEnum = pgEnum("email_template", EMAIL_TEMPLATES);
export const emailJobStatusEnum = pgEnum(
  "email_job_status",
  EMAIL_JOB_STATUSES,
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
export type UserTokenType = (typeof USER_TOKEN_TYPES)[number];
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];
export type EmailJobStatus = (typeof EMAIL_JOB_STATUSES)[number];
export type AiJobType = (typeof AI_JOB_TYPES)[number];
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

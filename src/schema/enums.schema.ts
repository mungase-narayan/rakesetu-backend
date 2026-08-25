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

// ---------------------------------------------------------------------------
// Phase 3 — master data, network and documents.
//
// Same `as const` + pgEnum + derived-union pattern as everything above. They are
// grouped here rather than interleaved by topic so the migration that adds ten
// types reads as one block, and so a later phase can see at a glance which
// vocabulary arrived with the reference tables.
// ---------------------------------------------------------------------------

/** `sections.line_type` — how many running lines the section carries. */
export const LINE_TYPES = ["single", "double", "multiple"] as const;

export const TERMINAL_TYPES = [
  "goods_shed",
  "private_siding",
  "pft",
  "port",
] as const;

/**
 * Who owns a wagon. `WIS`/`GPWIS` are the two wagon-investment schemes; they are
 * distinct from `private` because the scheme, not the owner, decides the freight
 * rebate — which Phase 10's rating engine has to see.
 */
export const WAGON_OWNERS = ["IR", "WIS", "GPWIS", "private"] as const;

export const WAGON_STATUSES = [
  "available",
  "in_use",
  "sick",
  "poh_due",
  "condemned",
] as const;

/**
 * The twelve lifecycle states followed by DESIGN.md §5.1's four exception states.
 *
 * §5.1 draws eleven boxes and then closes the loop with an arrow back to
 * `EMPTY_AVAILABLE`. `EMPTY_RETURNING` is the twelfth, and it is not padding:
 * §5.2's attribution buckets include `emptyReturn = NEXT_EMPTY_AVAILABLE −
 * UNLOAD_RELEASE`, which is a span of time the rake has to be *in* some state.
 * Without it the empty haul is indistinguishable from a rake sitting available
 * at the destination, and Phase 8 would attribute the return leg to idle stock.
 *
 * **Defined here, driven in Phase 4.** This phase seeds `rakes.current_state`
 * once; from Phase 4 onward the only writer is the event projection. Adding a
 * value here without adding it to that phase's legal-transition table produces a
 * state nothing can ever leave.
 */
export const RAKE_STATES = [
  "EMPTY_AVAILABLE",
  "ALLOTTED",
  "MOVING_TO_LOADING",
  "PLACED_FOR_LOADING",
  "LOADING",
  "LOADED_RELEASED",
  "IN_TRANSIT_LOADED",
  "AT_DEST_YARD",
  "PLACED_FOR_UNLOADING",
  "UNLOADING",
  "UNLOADED_RELEASED",
  "EMPTY_RETURNING",
  // Exception states — reachable from many points in the cycle, terminal in none.
  "DETAINED",
  "SICK",
  "DIVERTED",
  "HELD_FOR_ORDER",
] as const;

/** Cold-starts the solver's `slaRisk()` before any history exists (Phase 7). */
export const CUSTOMER_TIERS = [
  "platinum",
  "gold",
  "silver",
  "standard",
] as const;

/**
 * What a `charge_rules` row governs. The engine that consumes each of these
 * lands in Phase 9; the rules themselves are reference data and live here.
 */
export const CHARGE_RULE_TYPES = [
  "free_time",
  "demurrage",
  "wharfage",
  "bsc",
  "dev_charge",
  "terminal_charge",
  "base_rate",
] as const;

/**
 * Corpus types (the first six) and transactional types (the rest) share one
 * table. `documents.is_corpus` — not this enum — is what decides whether Phase
 * 12 chunks and embeds a row.
 */
export const DOCUMENT_TYPES = [
  "rate_circular",
  "goods_tariff",
  "commodity_classification",
  "demurrage_rule",
  "embargo_notice",
  "zonal_instruction",
  "forwarding_note",
  "rr",
  "waiver_evidence",
  "other",
] as const;

/** Drives `freeTime()` — mechanised handling earns less free time than manual. */
export const HANDLING_MODES = ["mechanised", "manual", "mixed"] as const;

/**
 * The join between `commodities`, `terminals.commodity_groups[]` and
 * `wagon_types.commodity_groups[]`. Coarser than `commodities.code` on purpose:
 * compatibility is a property of the group, tariff is a property of the commodity.
 */
export const COMMODITY_GROUPS = [
  "cement",
  "coal",
  "steel",
  "foodgrain",
  "fertiliser",
  "petroleum",
  "container",
  "other",
] as const;

export const lineTypeEnum = pgEnum("line_type", LINE_TYPES);
export const terminalTypeEnum = pgEnum("terminal_type", TERMINAL_TYPES);
export const wagonOwnerEnum = pgEnum("wagon_owner", WAGON_OWNERS);
export const wagonStatusEnum = pgEnum("wagon_status", WAGON_STATUSES);
export const rakeStateEnum = pgEnum("rake_state", RAKE_STATES);
export const customerTierEnum = pgEnum("customer_tier", CUSTOMER_TIERS);
export const chargeRuleTypeEnum = pgEnum("charge_rule_type", CHARGE_RULE_TYPES);
export const documentTypeEnum = pgEnum("document_type", DOCUMENT_TYPES);
export const handlingModeEnum = pgEnum("handling_mode", HANDLING_MODES);
export const commodityGroupEnum = pgEnum("commodity_group", COMMODITY_GROUPS);

export type LineType = (typeof LINE_TYPES)[number];
export type TerminalType = (typeof TERMINAL_TYPES)[number];
export type WagonOwner = (typeof WAGON_OWNERS)[number];
export type WagonStatus = (typeof WAGON_STATUSES)[number];
export type RakeState = (typeof RAKE_STATES)[number];
export type CustomerTier = (typeof CUSTOMER_TIERS)[number];
export type ChargeRuleType = (typeof CHARGE_RULE_TYPES)[number];
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type HandlingMode = (typeof HANDLING_MODES)[number];
export type CommodityGroup = (typeof COMMODITY_GROUPS)[number];

// ---------------------------------------------------------------------------
// Phase 4 — the event spine.
// ---------------------------------------------------------------------------

/**
 * Every kind of thing that can happen to a rake (DESIGN.md §5.1).
 *
 * The list is the *vocabulary*; `transitions.constants.ts` is the grammar. A
 * value added here without an entry in `TARGET_STATE` fails to compile, which
 * is the point of keeping the two in different files with a `Record` between
 * them — an event nothing knows how to apply would otherwise be accepted by the
 * API and silently ignored by the projection.
 *
 * Two entries are **corrections to §5.1's table** and both close a hole the
 * design leaves open:
 *
 *  - `DEPARTED_EMPTY_RETURN` is the only way into `EMPTY_RETURNING`. §5.2's
 *    attribution needs the empty haul to be a state the rake is *in*, the state
 *    enum already carries it, and without an entry event it would be a state
 *    nothing can reach.
 *  - `DIVERSION_CLEARED` is the pair §5.1 gives `DETAINED`, `MARKED_SICK` and
 *    `HELD_FOR_ORDER` but forgets to give `DIVERTED`. Without it a diverted rake
 *    is stuck forever — an exception state with no exit is a fleet leak.
 */
export const RAKE_EVENT_TYPES = [
  // The loaded cycle, in order.
  "ALLOTTED",
  "DEPARTED_EMPTY",
  "ARRIVED_LOADING_YARD",
  "PLACED_FOR_LOADING",
  "LOADING_STARTED",
  "LOADING_COMPLETE",
  "LOADED_RELEASED",
  "DEPARTED_ORIGIN",
  "SECTION_PASSED",
  "ARRIVED_DEST",
  "PLACED_FOR_UNLOADING",
  "UNLOADING_STARTED",
  "UNLOADING_COMPLETE",
  "UNLOADED_RELEASED",
  "DEPARTED_EMPTY_RETURN",
  "EMPTY_AVAILABLE",

  // Exceptions, and the four events that clear them.
  "DETAINED",
  "DETENTION_CLEARED",
  "MARKED_SICK",
  "SICK_CLEARED",
  "DIVERTED",
  "DIVERSION_CLEARED",
  "HELD_FOR_ORDER",
  "HOLD_RELEASED",

  // §5.1's corrective event. Never mutates the row it corrects.
  "CORRECTION",
] as const;

/**
 * Where an event came from — and therefore how much it is trusted.
 *
 * `simulator` exists in the enum rather than being hidden behind a flag because
 * §14's mitigation for "there is no live FOIS feed" is to make the synthetic
 * source a first-class adapter. A demo whose data is indistinguishable from
 * production data is a demo nobody can audit; `source = 'simulator'` on the row
 * is what keeps the distinction queryable.
 */
export const EVENT_SOURCES = [
  "simulator",
  "manual",
  "fois",
  "ai_extraction",
  "correction",
] as const;

export const rakeEventTypeEnum = pgEnum("rake_event_type", RAKE_EVENT_TYPES);
export const eventSourceEnum = pgEnum("event_source", EVENT_SOURCES);

export type RakeEventType = (typeof RAKE_EVENT_TYPES)[number];
export type EventSource = (typeof EVENT_SOURCES)[number];

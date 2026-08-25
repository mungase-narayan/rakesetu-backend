/**
 * Why a rake was detained, held or marked sick — **one list, shared by three
 * phases**.
 *
 * The validator behind `/rakes/:id/events` reads it, the supervisor's exception
 * screen renders it, and Phase 10's waiver adjudication keys off it. That last
 * consumer is the reason it is a constant rather than a free-text field with a
 * placeholder: a claim for a rain stoppage can only be adjudicated against a
 * rule about rain stoppages if the event said `rain_stoppage`, and an ad-hoc
 * list now is a pile of unmappable claims in five phases' time.
 *
 * Kept in `src/constants/` beside `permission.constants.ts` for the same reason
 * that file is not a table: nothing in the product lets an administrator edit
 * it, so a table would be a table of constants with a migration in front of it.
 *
 * **Attributability is a column, not a comment.** Phase 10 has to answer "is
 * this the railway's fault or the customer's?", and deciding it there — from a
 * string — would put the commercial judgement in the adjudication screen rather
 * than in the vocabulary. `attribution` records it once, here.
 */

export const EXCEPTION_REASON_CODES = [
  "rain_stoppage",
  "power_failure",
  "labour_unavailable",
  "wagon_defect",
  "customer_delay",
  "railway_delay",
] as const;

export type ExceptionReasonCode = (typeof EXCEPTION_REASON_CODES)[number];

/** Who the delay is charged against when a waiver is weighed. */
export type ReasonAttribution = "railway" | "customer" | "force_majeure";

export interface ExceptionReason {
  code: ExceptionReasonCode;
  label: string;
  /** One sentence a supervisor can pick from without guessing. */
  description: string;
  attribution: ReasonAttribution;
  /** The event types this reason is a sensible answer for. */
  appliesTo: readonly ("DETAINED" | "MARKED_SICK" | "HELD_FOR_ORDER")[];
}

export const EXCEPTION_REASONS: readonly ExceptionReason[] = [
  {
    code: "rain_stoppage",
    label: "Rain stoppage",
    description: "Handling suspended by weather.",
    attribution: "force_majeure",
    appliesTo: ["DETAINED", "HELD_FOR_ORDER"],
  },
  {
    code: "power_failure",
    label: "Power failure",
    description: "Terminal plant or lighting down.",
    attribution: "force_majeure",
    appliesTo: ["DETAINED", "HELD_FOR_ORDER"],
  },
  {
    code: "labour_unavailable",
    label: "Labour unavailable",
    description: "No gang at the siding to load or unload.",
    attribution: "customer",
    appliesTo: ["DETAINED"],
  },
  {
    code: "wagon_defect",
    label: "Wagon defect",
    description: "A wagon is unfit to run — hot axle, brake, body.",
    attribution: "railway",
    appliesTo: ["MARKED_SICK", "DETAINED"],
  },
  {
    code: "customer_delay",
    label: "Customer delay",
    description: "Trucks, storage or paperwork not ready at the siding.",
    attribution: "customer",
    appliesTo: ["DETAINED", "HELD_FOR_ORDER"],
  },
  {
    code: "railway_delay",
    label: "Railway delay",
    description: "No line, no path, or an operating restriction.",
    attribution: "railway",
    appliesTo: ["DETAINED", "HELD_FOR_ORDER"],
  },
];

const BY_CODE = new Map(
  EXCEPTION_REASONS.map((reason) => [reason.code, reason]),
);

export const isExceptionReasonCode = (
  value: unknown,
): value is ExceptionReasonCode =>
  typeof value === "string" && BY_CODE.has(value as ExceptionReasonCode);

export const exceptionReason = (code: ExceptionReasonCode): ExceptionReason =>
  BY_CODE.get(code) as ExceptionReason;

/** The events that take a reason code at all. */
export const REASON_BEARING_EVENTS = [
  "DETAINED",
  "MARKED_SICK",
  "HELD_FOR_ORDER",
] as const;

export const reasonsFor = (
  eventType: (typeof REASON_BEARING_EVENTS)[number],
): ExceptionReason[] =>
  EXCEPTION_REASONS.filter((reason) => reason.appliesTo.includes(eventType));

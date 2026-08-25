/**
 * Charge-rule module type contracts.
 */
import type {
  ChargeRule,
  ChargeRuleType,
  NewChargeRule,
} from "../../../schema";
import type { PaginateOptions } from "../../../types/pagination.types";
import type { RuleSelectorInput } from "../../../types/selector.types";
import type { RejectionReason } from "../services/rule-matcher";

export type { ChargeRule, NewChargeRule, RuleSelectorInput };

export interface IListChargeRulesQuery extends Partial<PaginateOptions> {
  type?: ChargeRuleType;
  /** In force on this date. Note it is a *date*, not an instant — rules are daily. */
  effectiveAt?: string;
  circularRef?: string;
}

/** A matched candidate, with the score that decided the contest. */
export interface RuleCandidate {
  rule: ChargeRule;
  specificity: number;
}

/** A candidate that lost, and why — the whole point of `/resolve`. */
export interface RuleRejection {
  rule: ChargeRule;
  reason: RejectionReason;
}

/**
 * What `/charge-rules/resolve` returns.
 *
 * The rejected list is not decoration. Phase 9's charge explainer has to answer
 * "why this rule and not that one", and a resolver that returns only its winner
 * makes that question unanswerable without a debugger.
 */
export interface RuleResolution {
  type: ChargeRuleType;
  asOf: string;
  selector: RuleSelectorInput;
  winner: RuleCandidate | null;
  rejected: RuleRejection[];
  /** Set when two rules tied and `lookupRule` would have thrown. */
  ambiguity?: { rules: ChargeRule[]; detail: string };
}

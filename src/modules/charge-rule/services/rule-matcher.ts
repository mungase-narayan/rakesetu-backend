/**
 * Selector matching and tie-breaking for `charge_rules` — pure, no I/O.
 *
 * The date filter is **not** here: it belongs in SQL, and putting it in a JS
 * predicate is the mistake this module is arranged to make impossible. What is
 * here is the part SQL cannot express cleanly — the **DECISIONS D8** omitted-key
 * semantics and the specificity ordering that follows from them.
 */
import {
  DIMENSION_TO_INPUT,
  RULE_SELECTOR_DIMENSIONS,
  SELECTOR_VERSION,
  type RuleSelector,
  type RuleSelectorDimension,
  type RuleSelectorInput,
} from "../../../types/selector.types";

/** Why a candidate rule did not win. The resolve endpoint returns these verbatim. */
export type RejectionReason =
  | { kind: "out_of_window"; detail: string }
  | {
      kind: "selector_mismatch";
      dimension: RuleSelectorDimension;
      detail: string;
    }
  | { kind: "unknown_version"; detail: string }
  | { kind: "less_specific"; detail: string }
  | { kind: "lower_version"; detail: string };

export interface MatchOutcome {
  matched: boolean;
  /**
   * How many selector dimensions the rule *constrained* and the query
   * satisfied. A rule with no constraints scores 0 and loses to anything that
   * names the case explicitly — which is exactly what "a default" should do.
   */
  specificity: number;
  reason?: RejectionReason;
}

/**
 * Does this rule's selector cover this query?
 *
 * The rule, once more: an omitted key is no restriction; present keys are AND-ed;
 * values within a key are OR-ed. The consequence worth stating is the one that
 * surprises people — a rule that names `commodityGroups` does **not** match a
 * query that says nothing about commodity. The rule constrains that dimension,
 * so a query that cannot satisfy it is not covered by it.
 */
export const matchSelector = (
  selector: RuleSelector,
  input: RuleSelectorInput,
): MatchOutcome => {
  if (selector.v !== SELECTOR_VERSION) {
    return {
      matched: false,
      specificity: 0,
      reason: {
        kind: "unknown_version",
        detail: `selector version ${String(selector.v)} is not v${SELECTOR_VERSION}`,
      },
    };
  }

  let specificity = 0;

  for (const dimension of RULE_SELECTOR_DIMENSIONS) {
    const allowed = selector[dimension] as readonly string[] | undefined;
    if (!allowed || allowed.length === 0) continue; // no restriction

    const value = input[DIMENSION_TO_INPUT[dimension]];
    if (value === undefined) {
      return {
        matched: false,
        specificity,
        reason: {
          kind: "selector_mismatch",
          dimension,
          detail: `rule restricts ${dimension} to [${allowed.join(", ")}] but the query did not say which`,
        },
      };
    }
    if (!allowed.includes(value)) {
      return {
        matched: false,
        specificity,
        reason: {
          kind: "selector_mismatch",
          dimension,
          detail: `rule restricts ${dimension} to [${allowed.join(", ")}], query asked for "${value}"`,
        },
      };
    }
    specificity += 1;
  }

  return { matched: true, specificity };
};

/**
 * Orders matched candidates: **specificity first, then version**, both
 * descending. Returns a negative number when `a` should win.
 */
export const compareCandidates = (
  a: { specificity: number; version: number },
  b: { specificity: number; version: number },
): number => b.specificity - a.specificity || b.version - a.version;

/**
 * True when two candidates are genuinely indistinguishable — same specificity,
 * same version. `lookupRule` throws on this rather than picking, because a
 * silent choice between two equally-authoritative rules produces a charge
 * nobody can explain and nobody can reproduce.
 */
export const isAmbiguous = (
  a: { specificity: number; version: number },
  b: { specificity: number; version: number },
): boolean => a.specificity === b.specificity && a.version === b.version;

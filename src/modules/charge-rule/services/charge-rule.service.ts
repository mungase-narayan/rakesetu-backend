/**
 * `charge_rules` reads and writes, and the **`asOf` resolver** that makes the
 * temporal story testable from Phase 3 onward.
 *
 * Three rules govern this file and none of them is negotiable (§5.6):
 *
 * 1. **The date filter is SQL.** `WHERE effective_from <= :asOf AND
 *    (effective_to IS NULL OR effective_to >= :asOf)` — never a JS `.filter()`
 *    after the fetch. A post-fetch date filter is correct until the table grows
 *    past one page, and then it is silently wrong.
 *
 * 2. **There is no `lookupCurrentRule()`.** Every call site passes an explicit
 *    `asOf`. Not offering the convenience is the entire mechanism that stops
 *    "current" leaking into a 2031 re-derivation of a 2026 bill — a method that
 *    does not exist cannot be called by a hurried Phase 9.
 *
 * 3. **Ties break on specificity, then version, then throw.** A genuine
 *    ambiguity is a data bug, and answering it with a coin flip produces an
 *    invoice nobody can reproduce.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNull,
  lte,
  or,
  type SQL,
} from "drizzle-orm";

import { chargeRules, type ChargeRule } from "../../../schema";
import ApiError from "../../../utils/api-error";
import { db, type DB } from "../../../database/connection";
import { UnscopedRepository } from "../../../database/scoped-repository";
import type { ChargeRuleType } from "../../../schema";
import type {
  RuleSelector,
  RuleSelectorInput,
} from "../../../types/selector.types";
import { compareCandidates, isAmbiguous, matchSelector } from "./rule-matcher";
import type {
  IListChargeRulesQuery,
  NewChargeRule,
  RuleCandidate,
  RuleRejection,
  RuleResolution,
} from "../types/charge-rule.types";

/** `charge_rules.effective_from` is a `date`; `asOf` is normalised to match. */
const toDateString = (value: Date | string): string =>
  typeof value === "string"
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);

class ChargeRuleService {
  private readonly repo: UnscopedRepository<typeof chargeRules>;

  constructor(private readonly database: DB = db) {
    this.repo = new UnscopedRepository(
      chargeRules,
      chargeRules.id,
      this.database,
    );
  }

  // ---- CRUD ---------------------------------------------------------------

  async list(query: IListChargeRulesQuery = {}) {
    return this.repo.paginate(
      {
        ...query,
        sort: query.sort ?? "effectiveFrom",
        order: query.order ?? "desc",
      },
      this.filters(query),
    );
  }

  async findById(id: string): Promise<ChargeRule | null> {
    return this.repo.findByKey(id);
  }

  async create(values: NewChargeRule): Promise<ChargeRule> {
    return this.repo.insert(values);
  }

  async update(
    id: string,
    values: Partial<NewChargeRule>,
  ): Promise<ChargeRule | null> {
    return this.repo.update(id, values);
  }

  // ---- the resolver -------------------------------------------------------

  /**
   * The single rule in force for this selector on this date.
   *
   * Throws 404 when nothing matches and 409 when two rules are genuinely
   * indistinguishable. Both are the right answer: the first says the rule book
   * has a hole, the second says it has a contradiction, and a charge engine must
   * not paper over either.
   */
  async lookupRule(
    type: ChargeRuleType,
    selector: RuleSelectorInput,
    asOf: Date | string,
  ): Promise<ChargeRule> {
    const candidates = await this.lookupRules(type, selector, asOf);

    if (candidates.length === 0) {
      throw new ApiError(
        404,
        `No ${type} rule in force on ${toDateString(asOf)} for this selector`,
      );
    }

    const [winner, runnerUp] = candidates;
    if (
      runnerUp &&
      isAmbiguous(
        { specificity: winner.specificity, version: winner.rule.version },
        { specificity: runnerUp.specificity, version: runnerUp.rule.version },
      )
    ) {
      throw new ApiError(
        409,
        `Ambiguous ${type} rules on ${toDateString(asOf)}: ${winner.rule.circularRef} and ${runnerUp.rule.circularRef} are equally specific at the same version`,
      );
    }

    return winner.rule;
  }

  /**
   * Every rule that matches, best first. Exposed because a few call sites want
   * to see the runners-up — the charge explainer, and the resolve endpoint.
   */
  async lookupRules(
    type: ChargeRuleType,
    selector: RuleSelectorInput,
    asOf: Date | string,
  ): Promise<RuleCandidate[]> {
    const inWindow = await this.inWindow(type, asOf);

    const matched: RuleCandidate[] = [];
    for (const rule of inWindow) {
      const outcome = matchSelector(rule.selector as RuleSelector, selector);
      if (outcome.matched) {
        matched.push({ rule, specificity: outcome.specificity });
      }
    }

    return matched.sort((a, b) =>
      compareCandidates(
        { specificity: a.specificity, version: a.rule.version },
        { specificity: b.specificity, version: b.rule.version },
      ),
    );
  }

  /**
   * The debugging tool: the winner **and every rule that lost, with a reason**.
   *
   * This is what makes Phase 9 tractable. "The bill says nine free hours and I
   * expected six" is otherwise a database session; here it is one request that
   * names the losing circular and the dimension that excluded it.
   */
  async resolve(
    type: ChargeRuleType,
    selector: RuleSelectorInput,
    asOf: Date | string,
  ): Promise<RuleResolution> {
    const asOfDate = toDateString(asOf);

    // Deliberately unfiltered by date: a rule that expired last month is the
    // single most likely explanation for a surprising answer, so it has to
    // appear in the rejected list rather than vanish.
    const all = await this.repo.select(
      eq(chargeRules.type, type),
      desc(chargeRules.effectiveFrom),
    );

    const rejected: RuleRejection[] = [];
    const matched: RuleCandidate[] = [];

    for (const rule of all) {
      const from = rule.effectiveFrom;
      const to = rule.effectiveTo;
      if (from > asOfDate || (to !== null && to < asOfDate)) {
        rejected.push({
          rule,
          reason: {
            kind: "out_of_window",
            detail: `in force ${from} → ${to ?? "open"}, which does not cover ${asOfDate}`,
          },
        });
        continue;
      }

      const outcome = matchSelector(rule.selector as RuleSelector, selector);
      if (!outcome.matched) {
        rejected.push({
          rule,
          reason: outcome.reason ?? {
            kind: "selector_mismatch",
            dimension: "divisions",
            detail: "selector did not match",
          },
        });
        continue;
      }
      matched.push({ rule, specificity: outcome.specificity });
    }

    matched.sort((a, b) =>
      compareCandidates(
        { specificity: a.specificity, version: a.rule.version },
        { specificity: b.specificity, version: b.rule.version },
      ),
    );

    const [winner, ...losers] = matched;

    for (const loser of losers) {
      const lostOnSpecificity =
        winner && loser.specificity < winner.specificity;
      rejected.push({
        rule: loser.rule,
        reason: lostOnSpecificity
          ? {
              kind: "less_specific",
              detail: `matched ${loser.specificity} selector dimension(s) against the winner's ${winner.specificity}`,
            }
          : {
              kind: "lower_version",
              detail: `equally specific but version ${loser.rule.version} < ${winner.rule.version}`,
            },
      });
    }

    const ambiguity =
      winner &&
      losers[0] &&
      isAmbiguous(
        { specificity: winner.specificity, version: winner.rule.version },
        { specificity: losers[0].specificity, version: losers[0].rule.version },
      )
        ? {
            rules: [winner.rule, losers[0].rule],
            detail:
              "two rules are equally specific at the same version — lookupRule throws rather than choosing",
          }
        : undefined;

    return {
      type,
      asOf: asOfDate,
      selector,
      winner: winner ?? null,
      rejected,
      ...(ambiguity ? { ambiguity } : {}),
    };
  }

  /**
   * The SQL date predicate, in one place so there is one of it.
   *
   * `effective_to IS NULL` is the open-ended case and has to be an explicit
   * disjunct — `effective_to >= :asOf` alone would silently exclude every rule
   * that is still in force, which is most of them.
   */
  private async inWindow(
    type: ChargeRuleType,
    asOf: Date | string,
  ): Promise<ChargeRule[]> {
    const asOfDate = toDateString(asOf);

    return this.database
      .select()
      .from(chargeRules)
      .where(
        and(
          eq(chargeRules.type, type),
          lte(chargeRules.effectiveFrom, asOfDate),
          or(
            isNull(chargeRules.effectiveTo),
            gte(chargeRules.effectiveTo, asOfDate),
          ),
        ),
      )
      .orderBy(desc(chargeRules.version), asc(chargeRules.effectiveFrom));
  }

  private filters(query: IListChargeRulesQuery): SQL | undefined {
    const conditions: SQL[] = [];

    if (query.type) conditions.push(eq(chargeRules.type, query.type));
    if (query.effectiveAt) {
      // Same predicate as `inWindow`, and for the same reason it is SQL: the
      // as-of picker on the admin screen is the temporal story made visible,
      // and a client-side filter would make it a lie on page two.
      const asOfDate = toDateString(query.effectiveAt);
      conditions.push(lte(chargeRules.effectiveFrom, asOfDate));
      conditions.push(
        or(
          isNull(chargeRules.effectiveTo),
          gte(chargeRules.effectiveTo, asOfDate),
        ) as SQL,
      );
    }
    if (query.circularRef) {
      conditions.push(eq(chargeRules.circularRef, query.circularRef));
    }

    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }
}

export default ChargeRuleService;

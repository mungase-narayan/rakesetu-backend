/**
 * The charge rule book.
 *
 * Idempotency here needs a word, because `charge_rules` has no natural unique
 * key — two rules may legitimately share a circular reference and a clause.
 * The seeder therefore checks for an existing row with the same
 * `(type, circular_ref, effective_from, version)` before inserting, rather than
 * leaning on a constraint that does not exist. Adding a unique index instead
 * would forbid a real case: one circular that sets free time for cement *and*
 * for coal is two rows with the same reference and the same date.
 */
/* eslint-disable no-console */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../src/database/connection";
import { chargeRules } from "../../src/schema";
import { CHARGE_RULES } from "./data/charge-rule.data";

export const seedChargeRules = async (): Promise<number> => {
  let inserted = 0;

  for (const rule of CHARGE_RULES) {
    const existing = await db
      .select({ id: chargeRules.id })
      .from(chargeRules)
      .where(
        and(
          eq(chargeRules.type, rule.type),
          eq(chargeRules.circularRef, rule.circularRef),
          eq(chargeRules.effectiveFrom, rule.effectiveFrom),
          eq(chargeRules.version, rule.version ?? 1),
          // `isNull` rather than comparing to "": a null clause and an empty
          // string are different, and `= ''` never matches a null, which would
          // make the re-run insert a duplicate instead of skipping it.
          rule.clauseRef
            ? eq(chargeRules.clauseRef, rule.clauseRef)
            : isNull(chargeRules.clauseRef),
        ),
      )
      .limit(1);

    if (existing.length > 0) continue;

    await db.insert(chargeRules).values({
      type: rule.type,
      params: rule.params,
      selector: rule.selector,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo ?? null,
      circularRef: rule.circularRef,
      clauseRef: rule.clauseRef ?? null,
      version: rule.version ?? 1,
    });
    inserted += 1;
  }

  console.log(
    `  charge rules  ${CHARGE_RULES.length} defined, ${inserted} inserted this run`,
  );
  return CHARGE_RULES.length;
};

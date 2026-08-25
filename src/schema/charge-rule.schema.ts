/**
 * charge_rules — the commercial rule book **as versioned data** (DESIGN.md §4.6).
 *
 * Moved forward from the charge phase because §5.2's turnaround maths subtracts
 * `freeTime()`, which is a lookup against this table. The rules are reference
 * data; the demurrage engine that spends them still waits for Phase 9.
 *
 * Two things make this table worth reading carefully.
 *
 * **It is temporal.** A rule is in force between `effective_from` and
 * `effective_to`, and re-deriving a 2026 invoice in 2031 must find the 2026 row,
 * not today's. Every read therefore passes an explicit `asOf` — see
 * `charge-rule.service.ts`, which deliberately offers no "current rule" helper.
 *
 * **It is selector-matched**, per DECISIONS D8: an omitted `selector` key means
 * "no restriction on that dimension", so several rules can match one query and
 * ties break on specificity, then `version`, then an exception.
 *
 * Global reference data — `UnscopedRepository`. A zone does not get its own
 * private copy of a national circular; a zone-specific rule is expressed by
 * putting the division in the selector.
 */
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { documents } from "./document.schema";
import { chargeRuleTypeEnum } from "./enums.schema";
import type { ChargeRuleParams, RuleSelector } from "../types/selector.types";

export const chargeRules = pgTable(
  "charge_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: chargeRuleTypeEnum("type").notNull(),

    /**
     * The numbers this rule carries. The shape depends on `type` — see
     * `ChargeRuleParamsByType` in types/selector.types.ts, which is the
     * authority. Validators check the shape against the type on write, because
     * a `demurrage` row holding `{ hours: 9 }` would parse fine and price
     * nothing.
     */
    params: jsonb("params").$type<ChargeRuleParams>().notNull(),

    /**
     * What the rule applies to, per **DECISIONS D8**:
     *
     * ```jsonc
     * { "v": 1, "commodityGroups": ["cement"], "terminalTypes": ["private_siding"],
     *   "handlingModes": ["mechanised"], "wagonTypeCodes": ["BOXNHL"],
     *   "divisions": ["Solapur"] }
     * ```
     *
     * **An omitted key means "no restriction on that dimension". Present keys
     * are AND-ed; values within a key are OR-ed.** `{"v":1}` is the zone-wide
     * default that matches everything.
     */
    selector: jsonb("selector").$type<RuleSelector>().notNull(),

    effectiveFrom: date("effective_from").notNull(),
    /** Null = still in force. */
    effectiveTo: date("effective_to"),

    /** Which circular says so. Not nullable: an unattributable charge is not defensible. */
    circularRef: varchar("circular_ref", { length: 120 }).notNull(),
    /**
     * The stored PDF behind `circular_ref`. **Phase 12 upgrades the Charge
     * Explainer through this column** — a computed charge line stops saying
     * "per circular 14 of 2024" and starts linking the clause it came from.
     */
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    clauseRef: varchar("clause_ref", { length: 60 }),

    /** Breaks a specificity tie in `lookupRule`. Higher wins. */
    version: integer("version").notNull().default(1),
    /**
     * The rule this one replaced. Optional and informational — supersession is
     * expressed by the *dates*, and a resolver that trusted this pointer instead
     * would return nothing for a period neither row covers.
     */
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => chargeRules.id,
      { onDelete: "set null" },
    ),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The resolver's exact predicate: one type, filtered by date.
    index("charge_rules_type_effective_from_idx").on(
      table.type,
      table.effectiveFrom,
    ),
    // Containment queries on the selector — "which rules mention cement at all".
    index("charge_rules_selector_gin_idx").using(
      "gin",
      sql`${table.selector} jsonb_path_ops`,
    ),
  ],
);

export type ChargeRule = typeof chargeRules.$inferSelect;
export type NewChargeRule = typeof chargeRules.$inferInsert;
export type UpdateChargeRule = Partial<NewChargeRule>;

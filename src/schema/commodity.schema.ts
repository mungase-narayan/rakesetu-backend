/**
 * commodities — **a table DESIGN.md does not have.**
 *
 * §4 carries free-floating `commodity_code` strings and `commodity_groups[]`
 * arrays with nothing to join them to, and then §5.6 defines
 * `freeTime({ commodityGroup, … })` and §5.7 defines
 * `ratePerTonne(commodityClass, …)`. Both take attributes that no table
 * supplies. This is that table.
 *
 * Global reference data: the IRCA classification of cement is not a per-tenant
 * opinion. `UnscopedRepository`.
 */
import { boolean, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

import { commodityGroupEnum } from "./enums.schema";

export const commodities = pgTable("commodities", {
  /** `CEM`, `COAL`, `STL`, `FOOD`, `FERT`, `POL` — keyed by code for the same reasons stations are. */
  code: varchar("code", { length: 20 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  /**
   * The coarse bucket that joins `terminals.commodity_groups[]` and
   * `wagon_types.commodity_groups[]`. Compatibility is decided at group level;
   * money is decided at commodity level. Keeping the two apart is why the
   * solver does not need a rate table and the rating engine does not need a
   * wagon catalogue.
   *
   * `group` is a reserved word in SQL, so the column is `commodity_group`.
   */
  group: commodityGroupEnum("commodity_group").notNull(),
  /**
   * IRCA classification — `100`, `140`, `LR1`. Drives `ratePerTonne` in Phase
   * 10. varchar rather than an enum because the class list is published by IR
   * and changes by circular; a new class must be a row edit, not a migration.
   */
  class: varchar("class", { length: 10 }).notNull(),
  /**
   * `CC`, `CC+8+2`, `permissible` — the §5.7 minimum-weight rule. Freight is
   * charged on the *chargeable* weight, which is the greater of what was loaded
   * and what this condition implies, so an under-loaded rake still pays for the
   * capacity it occupied.
   */
  minWeightCondition: varchar("min_weight_condition", { length: 20 }).notNull(),
  isHazardous: boolean("is_hazardous").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Commodity = typeof commodities.$inferSelect;
export type NewCommodity = typeof commodities.$inferInsert;
export type UpdateCommodity = Partial<NewCommodity>;

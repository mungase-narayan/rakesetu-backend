/**
 * customers and customer_sidings (DESIGN.md §4.4).
 *
 * The tenancy here is the subtle one, and **DECISIONS D7** is the entry to read
 * before changing anything: a customer is simultaneously a row in a zone's book
 * of business and — sometimes — a tenant with its own login. Two columns, two
 * questions. `org_id` is the zone and is what `ScopedRepository` scopes on;
 * `customer_org_id` is the tenant that signs in and is queried explicitly.
 */
import {
  boolean,
  index,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { terminals } from "./terminal.schema";
import { organizations } from "./organization.schema";
import { customerTierEnum } from "./enums.schema";

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The **zone** that holds the commercial relationship. This is the tenant scope. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /**
     * The `freight_customer` organization that logs in, per D7. Nullable,
     * because most customers never get a portal account — a siding that files
     * indents by telephone is a real customer with no tenant behind it.
     */
    customerOrgId: uuid("customer_org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    gstin: varchar("gstin", { length: 15 }),
    /**
     * **Cold-starts the solver's `slaRisk()` in Phase 7.** Before there is any
     * delivery history to learn from, the tier is the only signal available for
     * "how expensive is it to disappoint this customer".
     */
    tier: customerTierEnum("tier").notNull().default("standard"),
    creditLimit: numeric("credit_limit", {
      precision: 14,
      scale: 2,
      mode: "number",
    }),
    contactEmail: varchar("contact_email", { length: 254 }),
    contactPhone: varchar("contact_phone", { length: 20 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("customers_org_id_code_key").on(table.orgId, table.code),
    // The Phase 6 portal's lookup: "which customer is this signed-in tenant?"
    index("customers_customer_org_id_idx").on(table.customerOrgId),
  ],
);

/** Where a customer may load or receive, and what they may put in a wagon there. */
export const customerSidings = pgTable(
  "customer_sidings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    terminalId: uuid("terminal_id")
      .notNull()
      .references(() => terminals.id, { onDelete: "restrict" }),
    /**
     * Commodity codes rather than groups: a siding permit is issued for what a
     * customer actually handles, and "cement" would silently authorise clinker.
     */
    commodityCodes: varchar("commodity_codes", { length: 20 })
      .array()
      .notNull(),
    isDefaultLoading: boolean("is_default_loading").notNull().default(false),
    isDefaultDest: boolean("is_default_dest").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_sidings_customer_id_terminal_id_key").on(
      table.customerId,
      table.terminalId,
    ),
  ],
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type UpdateCustomer = Partial<NewCustomer>;

export type CustomerSiding = typeof customerSidings.$inferSelect;
export type NewCustomerSiding = typeof customerSidings.$inferInsert;
export type UpdateCustomerSiding = Partial<NewCustomerSiding>;

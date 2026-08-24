/**
 * organizations — the tenant boundary.
 *
 * Every user, role assignment and (later) every freight record hangs off an
 * organization. Scoping queries by org_id is what keeps one freight customer
 * from seeing another's volumes, so the column is non-null everywhere it
 * appears.
 */
import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";

import { organizationStatusEnum, organizationTypeEnum } from "./enums.schema";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: organizationTypeEnum("type").notNull(),
  /** Short human handle, e.g. "CR" for Central Railway. */
  code: varchar("code", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  status: organizationStatusEnum("status").notNull().default("active"),
  gstin: varchar("gstin", { length: 15 }),
  contactEmail: varchar("contact_email", { length: 254 }),
  contactPhone: varchar("contact_phone", { length: 20 }),
  address: text("address"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type UpdateOrganization = Partial<NewOrganization>;

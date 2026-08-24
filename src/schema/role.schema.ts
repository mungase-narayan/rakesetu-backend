/**
 * roles + user_roles — RBAC, scoped to an organization.
 *
 * A role is defined per organization rather than globally so a freight
 * customer's "admin" is a different row (and a different grant) from a railway
 * zone's "admin". `user_roles` is the join, and it carries `org_id` explicitly
 * so a role check and a tenant check can be answered by one query.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { users } from "./user.schema";
import { organizations } from "./organization.schema";
import {
  roleNameEnum,
  roleStatusEnum,
  userRoleStatusEnum,
} from "./enums.schema";

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Nullable to leave room for a future platform-wide role. Every role the
     * seed creates is org-scoped, so in practice this is always set — note
     * that Postgres treats NULLs as distinct in a unique index, so global
     * roles would need their own guard if they are ever introduced.
     */
    orgId: uuid("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    name: roleNameEnum("name").notNull(),
    description: text("description"),
    status: roleStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("roles_org_id_name_key").on(table.orgId, table.name)],
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: userRoleStatusEnum("status").notNull().default("active"),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("user_roles_user_id_role_id_org_id_key").on(
      table.userId,
      table.roleId,
      table.orgId,
    ),
    index("user_roles_user_id_idx").on(table.userId),
  ],
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type UpdateRole = Partial<NewRole>;

export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
export type UpdateUserRole = Partial<NewUserRole>;

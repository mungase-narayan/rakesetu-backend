/**
 * users — one row per person who can sign in.
 *
 * There is no public signup: accounts are created by the seed script (and, in a
 * later pass, by an admin invitation flow). `hashPassword` is therefore
 * nullable — an invited-but-not-yet-activated user has no password.
 *
 * `failedLoginAttempts` / `lockedUntil` back the login lockout in the user
 * controller; they live on the user row rather than in a cache so a lockout
 * survives a restart.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  index,
} from "drizzle-orm/pg-core";

import { organizations } from "./organization.schema";
import { userStatusEnum, genderEnum } from "./enums.schema";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    firstName: varchar("first_name", { length: 100 }).notNull(),
    middleName: varchar("middle_name", { length: 100 }),
    lastName: varchar("last_name", { length: 100 }).notNull(),
    /** Derived display name (first + last only) — see utils/name.util.ts. */
    fullName: varchar("full_name", { length: 201 }),

    email: varchar("email", { length: 254 }).notNull().unique(),
    /** Defaults to the email; users can change it later. Globally unique. */
    username: varchar("username", { length: 254 }).notNull().unique(),
    hashPassword: text("hash_password"),

    phone: varchar("phone", { length: 20 }),
    gender: genderEnum("gender"),
    avatar: text("avatar"),

    status: userStatusEnum("status").notNull().default("active"),
    isEmailVerified: boolean("is_email_verified").notNull().default(false),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),

    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastLoginIp: varchar("last_login_ip", { length: 64 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("users_org_id_idx").on(table.orgId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UpdateUser = Partial<NewUser>;

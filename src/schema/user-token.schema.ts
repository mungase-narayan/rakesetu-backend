/**
 * user_tokens — single-use, expiring links sent to a person by email.
 *
 * One table for both an invitation and a password reset, because they are the
 * same object: a bearer secret, scoped to one user, valid until a deadline,
 * consumable exactly once. Two tables would mean two copies of the expiry
 * check, the consumption check and the revocation sweep, and the second copy is
 * where the bug lives.
 *
 * Three properties are load-bearing:
 *
 *  - **The token is never stored.** Only `sha256(token)`, exactly as
 *    `refresh_tokens` does. A dump of this table is a list of digests, not a
 *    set of working password-reset links. sha256 rather than bcrypt because the
 *    input is already 256 bits of `randomBytes` — there is nothing to
 *    brute-force and no reason to pay a work factor on every click.
 *  - **Consumption is a column, not a delete.** `consumed_at` records that a
 *    link was used and when. Deleting the row would erase the fact that an
 *    invitation was ever accepted, which is precisely what an audit is for.
 *  - **Issuing supersedes.** A second invitation revokes the first, so an old
 *    link forwarded to the wrong person stops working the moment a new one is
 *    sent.
 */
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { users } from "./user.schema";
import { organizations } from "./organization.schema";
import { userTokenTypeEnum } from "./enums.schema";

export const userTokens = pgTable(
  "user_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /**
     * Carried so the audit rows these flows write have a tenant, and so a
     * future admin view of outstanding invitations can be scoped like every
     * other list in the product.
     */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    type: userTokenTypeEnum("type").notNull(),

    /** sha256 of the token, hex. Unique, so a collision is a constraint error. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /** Set the moment the link is redeemed. A second redemption finds it set. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),

    /** Set when a newer token of the same type supersedes this one. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    /** Who sent the invitation. Null for a self-service password reset. */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The lookup on every redemption: by hash, and nothing else.
    uniqueIndex("user_tokens_token_hash_key").on(table.tokenHash),
    index("user_tokens_user_id_type_idx").on(table.userId, table.type),
    index("user_tokens_org_id_idx").on(table.orgId),
  ],
);

export type UserToken = typeof userTokens.$inferSelect;
export type NewUserToken = typeof userTokens.$inferInsert;

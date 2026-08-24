/**
 * refresh_tokens — one row per issued refresh token, grouped into families.
 *
 * DESIGN.md §8 asks for reuse detection that "revokes the family", which a
 * stateless JWT cannot do: nothing stateless can tell a second use of a token
 * from the first. So each login opens a family, every rotation appends to the
 * chain via `replaced_by_id`, and presenting an already-rotated token means the
 * token was stolen — the whole family is revoked and the session dies.
 *
 * Phase 1 writes rows on login and revokes them on logout; the shape is what
 * matters now. Rotation and reuse detection are Phase 13 (DECISIONS.md D4).
 *
 * The token itself is never stored — only `sha256(token)`. A dump of this table
 * is a list of hashes, not a set of working credentials.
 */
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { users } from "./user.schema";

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Constant across a rotation chain. Reuse revokes every row sharing it. */
    familyId: uuid("family_id").notNull(),

    /** sha256 of the token, hex. Unique, so a collision is a constraint error. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),

    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** `rotated` · `reuse_detected` · `logout` · `admin`. */
    revokedReason: varchar("revoked_reason", { length: 40 }),

    /**
     * The next token in the chain. Self-referential, so the type annotation is
     * required — TypeScript cannot infer a table's own column while defining it.
     */
    replacedById: uuid("replaced_by_id").references(
      (): AnyPgColumn => refreshTokens.id,
      { onDelete: "set null" },
    ),

    /** Recorded so a revocation notice can say which device was signed out. */
    userAgent: varchar("user_agent", { length: 200 }),
    ip: varchar("ip", { length: 64 }),
  },
  (table) => [
    index("refresh_tokens_user_id_idx").on(table.userId),
    index("refresh_tokens_family_id_idx").on(table.familyId),
  ],
);

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;

/** The reasons a row can be revoked for. Widening this is a schema decision. */
export const REFRESH_TOKEN_REVOKE_REASONS = [
  "rotated",
  "reuse_detected",
  "logout",
  "admin",
] as const;

export type RefreshTokenRevokeReason =
  (typeof REFRESH_TOKEN_REVOKE_REASONS)[number];

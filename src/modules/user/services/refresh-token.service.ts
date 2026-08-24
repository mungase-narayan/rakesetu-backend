/**
 * refresh_tokens data access.
 *
 * The token is hashed on the way in and looked up by hash on the way out — the
 * plaintext is never stored, so a dump of this table is a list of sha256 digests
 * rather than a set of working sessions. sha256 and not bcrypt: the input is
 * already 200+ bits of signed JWT, so there is nothing to brute-force and no
 * reason to pay a work factor on every refresh.
 *
 * Phase 1 covers issue and revoke. Rotation and reuse detection are Phase 13;
 * `revokeFamily` is written now because it is what reuse detection will call and
 * it is trivial to get subtly wrong later (revoking the token, not the family).
 */
import { createHash, randomUUID } from "crypto";
import { and, eq, isNull } from "drizzle-orm";

import { db, type DB } from "../../../database/connection";
import {
  refreshTokens,
  type RefreshToken,
  type RefreshTokenRevokeReason,
} from "../../../schema";

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

interface IssueInput {
  userId: string;
  token: string;
  expiresAt: Date;
  /** Omit to open a new family; pass one to append to an existing chain. */
  familyId?: string;
  userAgent?: string | null;
  ip?: string | null;
}

class RefreshTokenService {
  constructor(private readonly database: DB = db) {}

  async issue(input: IssueInput): Promise<RefreshToken> {
    const [row] = await this.database
      .insert(refreshTokens)
      .values({
        userId: input.userId,
        // A login with no family opens one. crypto.randomUUID is fine here —
        // the family id is an identifier, not a secret.
        familyId: input.familyId ?? randomUUID(),
        tokenHash: hashToken(input.token),
        expiresAt: input.expiresAt,
        userAgent: input.userAgent?.slice(0, 200) ?? null,
        ip: input.ip ?? null,
      })
      .returning();

    return row;
  }

  /** The row for a presented token, whatever its state. */
  async findByToken(token: string): Promise<RefreshToken | null> {
    const [row] = await this.database
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(token)))
      .limit(1);

    return row ?? null;
  }

  /**
   * The row for a token that is still usable — present, not revoked, not
   * expired. Returns null for all three so the caller answers 401 once rather
   * than leaking which of the three it was.
   */
  async findActive(token: string): Promise<RefreshToken | null> {
    const row = await this.findByToken(token);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }

  async revoke(id: string, reason: RefreshTokenRevokeReason): Promise<void> {
    await this.database
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      // Only revoke what is live: re-revoking would overwrite the reason a
      // reuse-detection sweep wrote with a later, less interesting one.
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)));
  }

  async revokeByToken(
    token: string,
    reason: RefreshTokenRevokeReason,
  ): Promise<void> {
    await this.database
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(refreshTokens.tokenHash, hashToken(token)),
          isNull(refreshTokens.revokedAt),
        ),
      );
  }

  /**
   * Kills a whole rotation chain. This is the response to reuse detection
   * (Phase 13): a replayed token means someone else has a copy, and every
   * descendant of it is therefore suspect — not just the one presented.
   */
  async revokeFamily(
    familyId: string,
    reason: RefreshTokenRevokeReason,
  ): Promise<number> {
    const rows = await this.database
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(refreshTokens.familyId, familyId),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ id: refreshTokens.id });

    return rows.length;
  }
}

export default RefreshTokenService;

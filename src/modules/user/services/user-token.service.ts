/**
 * Issuing and redeeming the single-use links behind invitations and password
 * resets.
 *
 * The security properties live here rather than in the controller, because a
 * controller is where one of them gets forgotten:
 *
 *  - **The plaintext token exists exactly once**, in the return value of
 *    `issue()`, on its way into an email. What is stored is `sha256(token)`.
 *  - **Issuing supersedes.** A new token of the same type revokes every live
 *    one for that user, so an invitation forwarded to the wrong inbox stops
 *    working the moment a replacement is sent.
 *  - **Redemption is atomic-ish and single-use.** `consume()` sets
 *    `consumed_at` only where it is still null, and reports whether it won —
 *    so two clicks on the same link race safely and the second one loses.
 *  - **`verify()` collapses every failure into one answer.** Unknown, expired,
 *    revoked and already-used all return null, because telling a caller which
 *    one it was tells an attacker which tokens are real.
 */
import { createHash, randomBytes } from "crypto";
import { and, eq, isNull } from "drizzle-orm";

import { db, type DB } from "../../../database/connection";
import {
  userTokens,
  type UserToken,
  type UserTokenType,
} from "../../../schema";

/** sha256, hex — same discipline as refresh_tokens, same reasoning. */
export const hashUserToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * 32 bytes of CSPRNG, base64url.
 *
 * Not a UUID: a v4 UUID carries 122 bits and is widely assumed to be
 * non-secret, so it is the wrong primitive for something that is, on its own,
 * enough to take over an account. base64url so it survives a URL path segment
 * and a double-click selection intact.
 */
export const generateToken = (): string =>
  randomBytes(32).toString("base64url");

interface IssueInput {
  userId: string;
  orgId: string;
  type: UserTokenType;
  ttlHours: number;
  createdBy?: string | null;
}

export interface IssuedToken {
  /** The plaintext. This is the only time it exists — put it in the email. */
  token: string;
  row: UserToken;
  expiresAt: Date;
}

class UserTokenService {
  constructor(private readonly database: DB = db) {}

  async issue(input: IssueInput): Promise<IssuedToken> {
    // Supersede first, so a crash between the two leaves the user with no live
    // token rather than two. Erring toward "the link stopped working" over
    // "an old link still works" is the right way round for a credential.
    await this.revokeLive(input.userId, input.type);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60 * 1000);

    const [row] = await this.database
      .insert(userTokens)
      .values({
        userId: input.userId,
        orgId: input.orgId,
        type: input.type,
        tokenHash: hashUserToken(token),
        expiresAt,
        createdBy: input.createdBy ?? null,
      })
      .returning();

    return { token, row, expiresAt };
  }

  /**
   * The row for a token that is still redeemable, or null.
   *
   * `type` is checked here and not merely trusted from the route: a password
   * reset presented at the invitation endpoint would otherwise activate a
   * suspended account, which is exactly the escalation the two types exist to
   * prevent.
   */
  async verify(token: string, type: UserTokenType): Promise<UserToken | null> {
    if (!token) return null;

    const [row] = await this.database
      .select()
      .from(userTokens)
      .where(eq(userTokens.tokenHash, hashUserToken(token)))
      .limit(1);

    if (!row) return null;
    if (row.type !== type) return null;
    if (row.consumedAt) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;

    return row;
  }

  /**
   * Marks a token used. Returns false when it had already been consumed —
   * the `isNull` guard is what makes a double submit safe rather than a second
   * password change.
   */
  async consume(id: string): Promise<boolean> {
    const rows = await this.database
      .update(userTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(userTokens.id, id), isNull(userTokens.consumedAt)))
      .returning({ id: userTokens.id });

    return rows.length > 0;
  }

  /** Revokes every live token of one type for a user. Returns how many. */
  async revokeLive(userId: string, type: UserTokenType): Promise<number> {
    const rows = await this.database
      .update(userTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userTokens.userId, userId),
          eq(userTokens.type, type),
          isNull(userTokens.consumedAt),
          isNull(userTokens.revokedAt),
        ),
      )
      .returning({ id: userTokens.id });

    return rows.length;
  }
}

export default UserTokenService;

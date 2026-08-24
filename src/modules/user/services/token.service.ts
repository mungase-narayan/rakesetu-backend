/**
 * JWT token service: signs and verifies access and refresh tokens using
 * the secrets and TTLs configured in env, with HS256.
 *
 * Signature verification is only half the refresh check now: RefreshTokenService
 * holds the other half, the `refresh_tokens` row that says whether this
 * particular token is still live. Rotation and reuse detection are Phase 13 and
 * slot in behind the same interface (DECISIONS.md D4).
 */
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";

import env from "../../../config/env.config";
import { CustomJwtPayload } from "../../../types/common.types";

class TokenService {
  async signAccessToken(
    payload: object,
    exp: string | number = env.jwt.accessExpiresIn,
  ) {
    return jwt.sign(payload, env.jwt.accessSecret, {
      expiresIn: exp,
      algorithm: "HS256",
    } as jwt.SignOptions);
  }

  verifyAccessToken(token: string) {
    return jwt.verify(token, env.jwt.accessSecret) as CustomJwtPayload;
  }

  /**
   * Every refresh token carries a `jti`.
   *
   * Without one, two logins by the same user in the same second produce
   * byte-identical tokens — same payload, same `iat` at second resolution, same
   * signature — and therefore the same sha256. The second one then violates the
   * unique index on `refresh_tokens.token_hash` and the login fails with a 409,
   * which is exactly what happens when a user opens two tabs or a client
   * retries. The `jti` makes each issued token distinct by construction, and it
   * is what Phase 13's rotation chain will identify a token by anyway.
   */
  async signRefreshToken(
    payload: object,
    exp: string | number = env.jwt.refreshExpiresIn,
  ) {
    return jwt.sign({ ...payload, jti: randomUUID() }, env.jwt.refreshSecret, {
      expiresIn: exp,
      algorithm: "HS256",
    } as jwt.SignOptions);
  }

  verifyRefreshToken(token: string) {
    return jwt.verify(token, env.jwt.refreshSecret) as CustomJwtPayload;
  }

  /**
   * When the configured refresh TTL runs out, as an absolute instant.
   *
   * `refresh_tokens.expires_at` must agree with the JWT's own `exp` or the two
   * halves of the check disagree: a row that outlives its token is a row that
   * never gets cleaned up, and a token that outlives its row is a 401 the user
   * cannot explain. Read from the signed token itself rather than re-parsing
   * the "7d" string, so there is one source of truth.
   */
  refreshExpiryOf(token: string): Date {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    if (decoded?.exp) return new Date(decoded.exp * 1000);

    // Unreachable for a token this service just signed; a sane fallback beats a
    // NOT NULL violation if it ever is reached.
    return new Date(Date.now() + DEFAULT_REFRESH_TTL_MS);
  }
}

/** Only used if a signed token somehow carries no `exp`. */
const DEFAULT_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default TokenService;

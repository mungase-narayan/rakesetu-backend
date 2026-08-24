/**
 * Authentication: cookie transport, the refresh_tokens row, and the lockout.
 *
 * The headline assertion is a negative one — the refresh token is **not** in
 * the response body (DECISIONS.md D4). Negative assertions rot quietly, so it
 * is written against the whole serialised body rather than one field: adding
 * the token back under a different name would still fail this test.
 */
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import type { Application } from "express";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "../../database/connection";
import { refreshTokens, users, type Organization } from "../../schema";
import { hashToken } from "../../modules/user/services/refresh-token.service";
import { createLoginRateLimiter } from "../../middlewares/rate-limit.middleware";
import errorHandlerMiddleware from "../../middlewares/error-handler.middleware";
import { getTestApp } from "../helpers/app";
import {
  cookieValue,
  findCookie,
  loginAs,
  parseCookies,
  DEMO_PASSWORD,
} from "../helpers/auth";
import { createUser, organizationByCode } from "../factories/tenant.factory";

describe("authentication", () => {
  let app: Application;
  let cr: Organization;

  beforeAll(async () => {
    app = await getTestApp();
    cr = await organizationByCode("CR");
  });

  describe("login", () => {
    it("returns the access token and never the refresh token", async () => {
      const response = await request(app)
        .post("/api/v1/users/login")
        .send({
          email: "freight_controller@cr.rakesetu.dev",
          password: DEMO_PASSWORD,
        })
        .expect(200);

      const tokens = response.body.data.tokens;
      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toBeUndefined();

      // The cookie value must not appear anywhere in the body under any name.
      const refreshCookie = cookieValue(
        parseCookies(response.headers["set-cookie"]),
        "refreshToken",
      );
      expect(refreshCookie).toBeTruthy();
      expect(JSON.stringify(response.body)).not.toContain(refreshCookie);
    });

    it("sets an httpOnly, SameSite=Strict refresh cookie", async () => {
      const response = await request(app)
        .post("/api/v1/users/login")
        .send({
          email: "terminal_supervisor@cr.rakesetu.dev",
          password: DEMO_PASSWORD,
        })
        .expect(200);

      const cookies = parseCookies(response.headers["set-cookie"]);
      const refresh = findCookie(cookies, "refreshToken");

      expect(refresh).toBeDefined();
      expect(refresh).toMatch(/HttpOnly/i);
      expect(refresh).toMatch(/SameSite=Strict/i);
    });

    it("writes a refresh_tokens row holding a hash, never the token", async () => {
      const response = await request(app)
        .post("/api/v1/users/login")
        .send({
          email: "commercial_officer@cr.rakesetu.dev",
          password: DEMO_PASSWORD,
        })
        .expect(200);

      const token = cookieValue(
        parseCookies(response.headers["set-cookie"]),
        "refreshToken",
      );
      if (!token) throw new Error("no refresh cookie");

      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(token)));

      expect(row).toBeDefined();
      expect(row.revokedAt).toBeNull();
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
      // A dump of this table must not be a set of working credentials.
      expect(row.tokenHash).not.toBe(token);
      expect(row.tokenHash).toHaveLength(64);
      // A login opens a family; rotation (Phase 13) appends to it.
      expect(row.familyId).toBeTruthy();
    });

    it("allows two logins in the same second", async () => {
      // Two tabs, or a client retrying. Before refresh tokens carried a jti,
      // both produced the same signature and the second violated the unique
      // index on token_hash — a 409 on a perfectly valid login.
      const credentials = {
        email: "zonal_manager@cr.rakesetu.dev",
        password: DEMO_PASSWORD,
      };

      const [first, second] = await Promise.all([
        request(app).post("/api/v1/users/login").send(credentials),
        request(app).post("/api/v1/users/login").send(credentials),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it("rejects a wrong password", async () => {
      await request(app)
        .post("/api/v1/users/login")
        .send({ email: "admin@cr.rakesetu.dev", password: "wrong-password" })
        .expect(404);
    });
  });

  describe("refresh", () => {
    it("succeeds from the cookie alone", async () => {
      const session = await loginAs(app, "freight_customer", "CR");

      const response = await request(app)
        .post("/api/v1/users/refresh")
        // No Authorization header, no body — the cookie is the whole request.
        .set("Cookie", session.cookies)
        .expect(200);

      expect(response.body.data.accessToken).toBeTruthy();
      expect(response.body.data.refreshToken).toBeUndefined();
    });

    it("rejects a request with no cookie and no body", async () => {
      await request(app).post("/api/v1/users/refresh").expect(401);
    });

    it("rejects a well-formed token that was never issued here", async () => {
      // Signed with the right secret but never stored — which is exactly what a
      // stateless check would wave through, and the reason the table exists.
      const forged = jwt.sign(
        { user: { id: randomUUID() }, jti: randomUUID() },
        process.env.JWT_REFRESH_SECRET as string,
        { expiresIn: "7d", algorithm: "HS256" },
      );

      await request(app)
        .post("/api/v1/users/refresh")
        .set("Cookie", [`refreshToken=${forged}`])
        .expect(401);
    });
  });

  describe("logout", () => {
    it("revokes the row, so the token stops working", async () => {
      const session = await loginAs(app, "admin", "CR");
      const token = cookieValue(session.cookies, "refreshToken");
      if (!token) throw new Error("no refresh cookie");

      // It works before logout.
      await request(app)
        .post("/api/v1/users/refresh")
        .set("Cookie", session.cookies)
        .expect(200);

      await request(app)
        .post("/api/v1/users/logout")
        .set(session.authHeader)
        .set("Cookie", session.cookies)
        .expect(200);

      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(token)));

      expect(row.revokedAt).not.toBeNull();
      expect(row.revokedReason).toBe("logout");

      // And the still-valid JWT is now worthless. Clearing cookies alone would
      // have left this at 200.
      await request(app)
        .post("/api/v1/users/refresh")
        .set("Cookie", session.cookies)
        .expect(401);
    });
  });

  describe("account lockout", () => {
    it("locks after five wrong passwords and stays locked for the right one", async () => {
      const user = await createUser({
        orgId: cr.id,
        role: "freight_customer",
        password: DEMO_PASSWORD,
      });

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await request(app)
          .post("/api/v1/users/login")
          .send({ email: user.email, password: "wrong" })
          .expect(404);
      }

      // The fifth trips the lock, and says so rather than repeating "invalid
      // credentials" — otherwise the user retries forever against an account
      // that cannot succeed.
      await request(app)
        .post("/api/v1/users/login")
        .send({ email: user.email, password: "wrong" })
        .expect(423);

      // Even the correct password is refused while locked.
      await request(app)
        .post("/api/v1/users/login")
        .send({ email: user.email, password: DEMO_PASSWORD })
        .expect(423);

      const [row] = await db.select().from(users).where(eq(users.id, user.id));

      expect(row.failedLoginAttempts).toBe(5);
      expect(row.lockedUntil).not.toBeNull();
      // Fifteen minutes, give or take the time the test took to run.
      const remainingMinutes =
        ((row.lockedUntil as Date).getTime() - Date.now()) / 60_000;
      expect(remainingMinutes).toBeGreaterThan(14);
      expect(remainingMinutes).toBeLessThanOrEqual(15);
    });

    it("resets the counter on a successful login", async () => {
      const user = await createUser({
        orgId: cr.id,
        role: "freight_customer",
        password: DEMO_PASSWORD,
      });

      await request(app)
        .post("/api/v1/users/login")
        .send({ email: user.email, password: "wrong" })
        .expect(404);

      await request(app)
        .post("/api/v1/users/login")
        .send({ email: user.email, password: DEMO_PASSWORD })
        .expect(200);

      const [row] = await db.select().from(users).where(eq(users.id, user.id));

      expect(row.failedLoginAttempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
    });
  });

  describe("login rate limiting", () => {
    it("answers 429 once the per-IP-and-email budget is spent", async () => {
      // A limiter built from the factory with a small limit, mounted on a
      // throwaway app. The suite itself runs with the limit turned up, so this
      // is the only place the real behaviour can be observed.
      const limited = express();
      limited.use(express.json());
      limited.post("/login", createLoginRateLimiter(10), (_req, res) => {
        res.status(200).json({ ok: true });
      });
      limited.use(errorHandlerMiddleware);

      const email = `ratelimit-${randomUUID()}@test.rakesetu.dev`;

      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await request(limited).post("/login").send({ email }).expect(200);
      }

      await request(limited).post("/login").send({ email }).expect(429);

      // A different email from the same IP is a different bucket — one office
      // behind a shared NAT must not lock out its colleagues.
      await request(limited)
        .post("/login")
        .send({ email: `other-${email}` })
        .expect(200);
    });
  });

  describe("token families", () => {
    it("gives each login its own family", async () => {
      const first = await loginAs(app, "terminal_supervisor", "CR");
      const second = await loginAs(app, "terminal_supervisor", "CR");

      const firstToken = cookieValue(first.cookies, "refreshToken");
      const secondToken = cookieValue(second.cookies, "refreshToken");
      if (!firstToken || !secondToken) throw new Error("missing cookies");

      const [a] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(firstToken)));
      const [b] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(secondToken)));

      // Signing out of one device must not sign out of the other, which is
      // only true if the two sessions are in different families.
      expect(a.familyId).not.toBe(b.familyId);
    });
  });
});

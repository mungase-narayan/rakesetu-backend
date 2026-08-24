/**
 * The invitation and password-reset flow, end to end over HTTP.
 *
 * **The token is read out of the rendered email**, which is the only place it
 * exists outside the queue message: it is not in the API response (deliberately
 * — that was the copy-link hole this flow was built to close), not in
 * `email_jobs`, and `user_tokens` stores only its sha256.
 *
 * That constraint turns out to be a feature. Scraping the link from the message
 * the recipient would actually receive means these tests exercise the template
 * rendering too, and it makes "the link in the inbox opens the account" a
 * property the suite proves rather than assumes.
 *
 * `hashUserToken` is used only to *find* the row for a token already in hand.
 * Nothing here reverses a hash, because nothing can.
 */
import request from "supertest";
import express, { type Application } from "express";
import { and, desc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "../../database/connection";
import { refreshTokens, userTokens, users } from "../../schema";
import UserTokenService, {
  hashUserToken,
} from "../../modules/user/services/user-token.service";
import { createPasswordRateLimiter } from "../../middlewares/rate-limit.middleware";
import errorHandlerMiddleware from "../../middlewares/error-handler.middleware";
import {
  clearMailOutbox,
  lastMailTo,
} from "../../modules/mail/services/mail.service";
import { emailJobs } from "../../schema";
import { getTestApp } from "../helpers/app";
import { loginAs, DEMO_PASSWORD, type Session } from "../helpers/auth";

const GOOD_PASSWORD = "Rakesetu@2026";

let counter = 0;
const uniqueEmail = () =>
  `invite.probe.${Date.now()}.${counter++}@cr.rakesetu.dev`;

/** The most recent live token of a type for a user, as the mailer would see it. */
const liveToken = async (
  userId: string,
  type: "invitation" | "password_reset",
) => {
  const [row] = await db
    .select()
    .from(userTokens)
    .where(and(eq(userTokens.userId, userId), eq(userTokens.type, type)))
    .orderBy(desc(userTokens.createdAt))
    .limit(1);
  return row ?? null;
};

describe("invitations and password resets", () => {
  let app: Application;
  let admin: Session;
  const tokenService = new UserTokenService();

  /** Creates a user through the API. Nothing about the token comes back. */
  const createUser = async () => {
    const email = uniqueEmail();
    const created = await request(app)
      .post("/api/v1/users")
      .set(admin.authHeader)
      .send({ firstName: "Invite", lastName: "Probe", email })
      .expect(201);

    return {
      email,
      userId: created.body.data.id as string,
      body: created.body,
    };
  };

  /** Pulls the link out of the message the recipient would have received. */
  const tokenFromMailTo = (email: string): string => {
    const message = lastMailTo(email);
    if (!message) throw new Error(`no email was rendered for ${email}`);

    const match = message.text.match(/\/auth\/invitation\/(\S+)/);
    if (!match) throw new Error(`no invitation link in the email to ${email}`);

    return decodeURIComponent(match[1]);
  };

  /** Creates a user and returns the token from their invitation email. */
  const invite = async () => {
    const { email, userId, body } = await createUser();
    return { email, userId, body, token: tokenFromMailTo(email) };
  };

  beforeAll(async () => {
    app = await getTestApp();
    admin = await loginAs(app, "admin", "CR");
  });

  beforeEach(() => {
    // Each test reads "the last message to this address"; a shared buffer
    // across tests would make that ambiguous the moment two reuse an address.
    clearMailOutbox();
  });

  describe("issuing", () => {
    it("creates an invitation token when a user is created", async () => {
      const { userId } = await invite();

      const row = await liveToken(userId, "invitation");
      expect(row).not.toBeNull();
      expect(row?.consumedAt).toBeNull();
      expect(row?.revokedAt).toBeNull();
      expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("stores only a hash — never the token itself", async () => {
      const { userId, token } = await invite();
      const row = await liveToken(userId, "invitation");

      expect(token.length).toBeGreaterThan(20);
      expect(row?.tokenHash).toBe(hashUserToken(token));
      expect(row?.tokenHash).not.toBe(token);
      // 64 hex characters, i.e. sha256.
      expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("never returns the invitation link over HTTP", async () => {
      // The regression this whole change exists to prevent. The link used to
      // come back in the response body whenever SMTP was unconfigured, and the
      // frontend showed it in a "copy this and send it yourself" dialog — a
      // password-setting credential travelling through a response, a browser,
      // and every log that touched either.
      const { body, email } = await createUser();

      expect(JSON.stringify(body)).not.toContain("/auth/invitation");
      expect(body.data.invitation.url).toBeUndefined();

      // …and it is genuinely absent, not merely renamed: the token exists, it
      // is just only in the email.
      expect(tokenFromMailTo(email).length).toBeGreaterThan(20);
    });

    it("reports the job id and expiry, but never claims delivery", async () => {
      const { body, userId } = await createUser();

      // `delivered` is gone and cannot come back: the send happens in a
      // consumer, so no response can honestly claim it.
      expect(body.data.invitation.delivered).toBeUndefined();
      expect(body.data.invitation.emailJobId).toBeTruthy();
      expect(body.data.invitation.expiresAt).toBeTruthy();

      // The suite runs with SMTP_HOST unset and USE_RABBITMQ_SERVICE=false, so
      // the fallback sends inline and fails for want of a transport — which is
      // exactly what a production box with a broken SMTP config would do, and
      // the response says so rather than promising mail that is not coming.
      expect(body.data.invitation.queued).toBe(false);
      expect(body.message).toMatch(/could not be sent/);

      const [row] = await db
        .select()
        .from(emailJobs)
        .where(eq(emailJobs.userId, userId));
      expect(row.status).toBe("failed");
      expect(row.lastError).toMatch(/SMTP transport/);
    });

    it("writes one email_jobs row per invitation", async () => {
      const { userId, email } = await createUser();

      const rows = await db
        .select()
        .from(emailJobs)
        .where(eq(emailJobs.userId, userId));

      expect(rows).toHaveLength(1);
      expect(rows[0].template).toBe("invitation");
      expect(rows[0].toEmail).toBe(email.toLowerCase());
      expect(rows[0].hasSecret).toBe(true);
      expect(rows[0].requestedBy).toBe(admin.userId);
    });

    it("never writes the token or the link into email_jobs", async () => {
      const { userId, email } = await createUser();
      const token = tokenFromMailTo(email);

      const [row] = await db
        .select()
        .from(emailJobs)
        .where(eq(emailJobs.userId, userId));

      // Assert on the WHOLE row, not just payload — that is what catches
      // somebody later adding a helpful `html` column "for debugging", which
      // would carry the link, because both templates print it as visible text.
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain("/auth/invitation");
    });

    it("records who sent it", async () => {
      const { userId } = await invite();
      const row = await liveToken(userId, "invitation");
      expect(row?.createdBy).toBe(admin.userId);
    });

    it("supersedes the previous link when re-sent", async () => {
      const { userId, token: first } = await invite();

      await request(app)
        .post(`/api/v1/users/${userId}/invite`)
        .set(admin.authHeader)
        .expect(200);

      // The first link must be dead the moment the second is issued.
      expect(await tokenService.verify(first, "invitation")).toBeNull();

      const rows = await db
        .select()
        .from(userTokens)
        .where(eq(userTokens.userId, userId));
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    });

    it("refuses to re-invite an already activated account", async () => {
      const { userId, token } = await invite();

      await request(app)
        .post(`/api/v1/users/invitations/${encodeURIComponent(token)}/accept`)
        .send({ password: GOOD_PASSWORD })
        .expect(200);

      // That person has a password now; the flow for losing it is the reset.
      await request(app)
        .post(`/api/v1/users/${userId}/invite`)
        .set(admin.authHeader)
        .expect(409);
    });
  });

  describe("accepting an invitation", () => {
    it("previews the invitee without requiring a session", async () => {
      const { token, email } = await invite();

      const response = await request(app)
        .get(`/api/v1/users/invitations/${encodeURIComponent(token)}`)
        .expect(200);

      expect(response.body.data.email).toBe(email);
      expect(response.body.data.firstName).toBe("Invite");
      expect(response.body.data.organizationName).toBe("Central Railway");
    });

    it("activates the account and lets the person sign in", async () => {
      const { token, email, userId } = await invite();

      const [before] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));
      expect(before.status).toBe("inactive");
      expect(before.hashPassword).toBeNull();

      await request(app)
        .post(`/api/v1/users/invitations/${encodeURIComponent(token)}/accept`)
        .send({ password: GOOD_PASSWORD })
        .expect(200);

      const [after] = await db.select().from(users).where(eq(users.id, userId));
      expect(after.status).toBe("active");
      expect(after.hashPassword).not.toBeNull();
      expect(after.isEmailVerified).toBe(true);

      // The whole point of the flow.
      await request(app)
        .post("/api/v1/users/login")
        .send({ email, password: GOOD_PASSWORD })
        .expect(200);
    });

    it("is single-use — a second submit is refused", async () => {
      const { token } = await invite();

      await request(app)
        .post(`/api/v1/users/invitations/${encodeURIComponent(token)}/accept`)
        .send({ password: GOOD_PASSWORD })
        .expect(200);

      await request(app)
        .post(`/api/v1/users/invitations/${encodeURIComponent(token)}/accept`)
        .send({ password: "Different@2026" })
        .expect(400);
    });

    it("rejects an unknown token with the same message as a used one", async () => {
      const unknown = await request(app)
        .get(`/api/v1/users/invitations/${"a".repeat(43)}`)
        .expect(400);

      const { token } = await invite();
      await request(app)
        .post(`/api/v1/users/invitations/${encodeURIComponent(token)}/accept`)
        .send({ password: GOOD_PASSWORD })
        .expect(200);

      const used = await request(app)
        .get(`/api/v1/users/invitations/${encodeURIComponent(token)}`)
        .expect(400);

      // Identical wording: distinguishing them tells an attacker which guesses
      // are close.
      expect(unknown.body.message).toBe(used.body.message);
    });

    it("rejects an expired token", async () => {
      const { userId } = await invite();
      const row = await liveToken(userId, "invitation");

      await db
        .update(userTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(userTokens.id, row!.id));

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      expect(user.status).toBe("inactive");

      // Issue a fresh known token so the suite can present *something* whose
      // hash matches an expired row.
      const issued = await tokenService.issue({
        userId,
        orgId: user.orgId,
        type: "invitation",
        ttlHours: -1,
      });
      expect(await tokenService.verify(issued.token, "invitation")).toBeNull();
    });

    it("will not accept a password-reset token at the invitation endpoint", async () => {
      const { userId, token: inviteToken } = await invite();

      await request(app)
        .post(
          `/api/v1/users/invitations/${encodeURIComponent(inviteToken)}/accept`,
        )
        .send({ password: GOOD_PASSWORD })
        .expect(200);

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      const reset = await tokenService.issue({
        userId,
        orgId: user.orgId,
        type: "password_reset",
        ttlHours: 1,
      });

      // A reset token must never be able to flip `status` — that is the whole
      // reason the two types are distinct values.
      await request(app)
        .post(
          `/api/v1/users/invitations/${encodeURIComponent(reset.token)}/accept`,
        )
        .send({ password: "Another@2026" })
        .expect(400);
    });

    it("enforces the password policy", async () => {
      const { token } = await invite();

      for (const weak of [
        "short1A",
        "alllowercase1",
        "ALLUPPERCASE1",
        "NoDigitsHere",
      ]) {
        await request(app)
          .post(`/api/v1/users/invitations/${encodeURIComponent(token)}/accept`)
          .send({ password: weak })
          .expect(422);
      }

      // …and the token survives the rejections, because none of them consumed it.
      await request(app)
        .post(`/api/v1/users/invitations/${encodeURIComponent(token)}/accept`)
        .send({ password: GOOD_PASSWORD })
        .expect(200);
    });
  });

  describe("forgotten password", () => {
    it("answers 200 for an unknown address, revealing nothing", async () => {
      const unknown = await request(app)
        .post("/api/v1/users/password/forgot")
        .send({ email: "nobody.here@cr.rakesetu.dev" })
        .expect(200);

      const known = await request(app)
        .post("/api/v1/users/password/forgot")
        .send({ email: admin.email })
        .expect(200);

      expect(unknown.body.message).toBe(known.body.message);
    });

    it("never returns the reset link, even with no mail transport", async () => {
      const response = await request(app)
        .post("/api/v1/users/password/forgot")
        .send({ email: admin.email })
        .expect(200);

      // Unlike the admin-triggered invitation, this endpoint is public — a link
      // in the body would let anyone reset any account by asking.
      expect(JSON.stringify(response.body)).not.toContain(
        "/auth/reset-password",
      );
      expect(response.body.data).toBeNull();
    });

    it("issues an invitation, not a reset, for a never-activated account", async () => {
      const { userId, email } = await invite();

      await request(app)
        .post("/api/v1/users/password/forgot")
        .send({ email })
        .expect(200);

      // A reset would be a second path to activation that skips the invitation.
      expect(await liveToken(userId, "password_reset")).toBeNull();
      expect(await liveToken(userId, "invitation")).not.toBeNull();
    });
  });

  describe("resetting a password", () => {
    /** An activated user with a known live reset token. */
    const activated = async () => {
      const { token, userId, email } = await invite();
      await request(app)
        .post(`/api/v1/users/invitations/${encodeURIComponent(token)}/accept`)
        .send({ password: GOOD_PASSWORD })
        .expect(200);

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      const issued = await tokenService.issue({
        userId,
        orgId: user.orgId,
        type: "password_reset",
        ttlHours: 1,
      });
      return { userId, email, token: issued.token };
    };

    it("changes the password and signs every other session out", async () => {
      const { userId, email, token } = await activated();

      // A live session to be killed.
      await request(app)
        .post("/api/v1/users/login")
        .send({ email, password: GOOD_PASSWORD })
        .expect(200);

      const before = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, userId));
      expect(before.filter((r) => r.revokedAt === null).length).toBeGreaterThan(
        0,
      );

      await request(app)
        .post(`/api/v1/users/password/reset/${encodeURIComponent(token)}`)
        .send({ password: "Changed@2026" })
        .expect(200);

      const after = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, userId));
      expect(after.every((r) => r.revokedAt !== null)).toBe(true);

      await request(app)
        .post("/api/v1/users/login")
        .send({ email, password: "Changed@2026" })
        .expect(200);

      await request(app)
        .post("/api/v1/users/login")
        .send({ email, password: GOOD_PASSWORD })
        .expect(404);
    });

    it("is single-use", async () => {
      const { token } = await activated();

      await request(app)
        .post(`/api/v1/users/password/reset/${encodeURIComponent(token)}`)
        .send({ password: "Changed@2026" })
        .expect(200);

      await request(app)
        .post(`/api/v1/users/password/reset/${encodeURIComponent(token)}`)
        .send({ password: "Again@2026" })
        .expect(400);
    });

    it("cannot reactivate a suspended account", async () => {
      const { userId, token } = await activated();

      await request(app)
        .patch(`/api/v1/users/${userId}`)
        .set(admin.authHeader)
        .send({ status: "suspended" })
        .expect(200);

      await request(app)
        .post(`/api/v1/users/password/reset/${encodeURIComponent(token)}`)
        .send({ password: "Changed@2026" })
        .expect(403);

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      expect(user.status).toBe("suspended");
    });

    it("clears a lockout — mailbox control beats five bad guesses", async () => {
      const { userId, email, token } = await activated();

      for (let i = 0; i < 5; i += 1) {
        await request(app)
          .post("/api/v1/users/login")
          .send({ email, password: "wrong-password" });
      }

      const [locked] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));
      expect(locked.lockedUntil).not.toBeNull();

      await request(app)
        .post(`/api/v1/users/password/reset/${encodeURIComponent(token)}`)
        .send({ password: "Changed@2026" })
        .expect(200);

      const [after] = await db.select().from(users).where(eq(users.id, userId));
      expect(after.lockedUntil).toBeNull();
      expect(after.failedLoginAttempts).toBe(0);
    });
  });

  describe("audit trail", () => {
    it("records the invitation and its acceptance", async () => {
      const { token, userId } = await invite();

      await request(app)
        .post(`/api/v1/users/invitations/${encodeURIComponent(token)}/accept`)
        .send({ password: GOOD_PASSWORD })
        .expect(200);

      const trail = await request(app)
        .get(`/api/v1/audit/users/${userId}`)
        .set(admin.authHeader)
        .expect(200);

      const actions = (trail.body.data as { action: string }[]).map(
        (e) => e.action,
      );
      expect(actions).toContain("user.create");
      expect(actions).toContain("user.invite");
      expect(actions).toContain("user.invitation.accept");
    });

    it("never writes a token into the audit log", async () => {
      const { token, userId } = await invite();

      const trail = await request(app)
        .get(`/api/v1/audit/users/${userId}`)
        .set(admin.authHeader)
        .expect(200);

      // audit_log is append-only and nobody can redact it, so a credential
      // written there is written forever.
      expect(JSON.stringify(trail.body)).not.toContain(token);
    });
  });

  describe("rate limiting", () => {
    it("answers 429 once the per-IP budget is spent", async () => {
      // Built from the factory with a small limit on a throwaway app: the suite
      // runs with the limit turned up, so this is the only place the real
      // behaviour is observable. Two jobs at once — capping token guessing, and
      // stopping the API being used to mail-bomb somebody else's inbox.
      const limited = express();
      limited.use(express.json());
      limited.post("/forgot", createPasswordRateLimiter(5), (_req, res) => {
        res.status(200).json({ ok: true });
      });
      limited.use(errorHandlerMiddleware);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await request(limited)
          .post("/forgot")
          .send({ email: `spam-${attempt}@cr.rakesetu.dev` })
          .expect(200);
      }

      // Keyed on IP alone, so varying the address does not buy a fresh budget —
      // which is the whole point when the target is somebody else's inbox.
      await request(limited)
        .post("/forgot")
        .send({ email: "someone-else@cr.rakesetu.dev" })
        .expect(429);
    });
  });

  describe("guards", () => {
    it("keeps re-sending behind user:write", async () => {
      const { userId } = await invite();
      const controller = await loginAs(app, "freight_controller", "CR");

      await request(app)
        .post(`/api/v1/users/${userId}/invite`)
        .set(controller.authHeader)
        .expect(403);
    });

    it("cannot re-invite a user in another tenant", async () => {
      const { userId } = await invite();
      const accAdmin = await loginAs(app, "admin", "ACC");

      await request(app)
        .post(`/api/v1/users/${userId}/invite`)
        .set(accAdmin.authHeader)
        .expect(404);
    });

    it("leaves the seeded accounts able to sign in", async () => {
      // A sanity check on the whole suite: none of the above should have
      // touched the fixtures every other file depends on.
      await request(app)
        .post("/api/v1/users/login")
        .send({ email: admin.email, password: DEMO_PASSWORD })
        .expect(200);
    });
  });
});

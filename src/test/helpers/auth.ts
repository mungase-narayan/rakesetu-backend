/**
 * Signing in as a seeded persona.
 *
 * `loginAs("freight_controller")` goes through the real `POST /users/login` —
 * validators, lockout, cookie, `refresh_tokens` row and all — rather than
 * minting a JWT directly. A hand-signed token would skip exactly the code a
 * cross-tenant or permission test is trying to exercise, and would keep passing
 * after login started handing out the wrong claims.
 */
import request from "supertest";
import type { Application } from "express";

import type { RoleName } from "../../schema";
import { DEMO_PASSWORD, TENANTS } from "../../../scripts/fixtures/tenants";

export type TenantCode = "CR" | "ACC";

export interface Session {
  token: string;
  /** The `Authorization` header value, ready to spread into `.set()`. */
  authHeader: { Authorization: string };
  /** Raw Set-Cookie values, for tests that need the refresh cookie back. */
  cookies: string[];
  userId: string;
  orgId: string;
  email: string;
}

export const emailFor = (code: TenantCode, role: RoleName): string => {
  const tenant = TENANTS.find((t) => t.code === code);
  const user = tenant?.users.find((u) => u.role === role);
  if (!user) throw new Error(`No seeded ${role} in tenant ${code}`);
  return user.email;
};

export const loginAs = async (
  app: Application,
  role: RoleName,
  code: TenantCode = "CR",
): Promise<Session> => {
  const email = emailFor(code, role);

  const response = await request(app)
    .post("/api/v1/users/login")
    .send({ email, password: DEMO_PASSWORD });

  if (response.status !== 200) {
    throw new Error(
      `loginAs(${role}, ${code}) failed with ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }

  const body = response.body.data;

  return {
    token: body.tokens.accessToken,
    authHeader: { Authorization: `Bearer ${body.tokens.accessToken}` },
    cookies: parseCookies(response.headers["set-cookie"]),
    userId: body.user.id,
    orgId: body.user.orgId,
    email,
  };
};

/** supertest types this as string | string[] depending on the header count. */
export const parseCookies = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return [raw];
  return [];
};

/** Pulls one cookie's attributes out of a Set-Cookie list. */
export const findCookie = (
  cookies: string[],
  name: string,
): string | undefined => cookies.find((c) => c.startsWith(`${name}=`));

/** Just the value, for replaying a cookie on a later request. */
export const cookieValue = (
  cookies: string[],
  name: string,
): string | undefined => {
  const cookie = findCookie(cookies, name);
  return cookie?.split(";")[0]?.split("=").slice(1).join("=");
};

export { DEMO_PASSWORD };

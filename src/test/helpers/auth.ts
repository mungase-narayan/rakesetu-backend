/**
 * `loginAs(role, orgCode)` — a real login against the real endpoint.
 *
 * Deliberately not a hand-minted JWT. The token a test carries should have come
 * through the same code that issues one in production, or the suite proves
 * nothing about the guard chain it is about to exercise: a hand-signed token
 * with the right claims would pass `verifyJWT` even if login were broken.
 */
import type { RoleName } from "../../schema";
import { DEMO_PASSWORD, TENANTS } from "../../../scripts/fixtures/tenants";
import { api } from "./app";

export interface Session {
  token: string;
  userId: string;
  orgId: string;
  email: string;
  /** A supertest request with the Authorization header already attached. */
  get: (url: string) => ReturnType<ReturnType<typeof api>["get"]>;
  post: (url: string) => ReturnType<ReturnType<typeof api>["post"]>;
  patch: (url: string) => ReturnType<ReturnType<typeof api>["patch"]>;
  put: (url: string) => ReturnType<ReturnType<typeof api>["put"]>;
  delete: (url: string) => ReturnType<ReturnType<typeof api>["delete"]>;
}

const emailFor = (orgCode: string, role: RoleName): string => {
  const tenant = TENANTS.find((candidate) => candidate.code === orgCode);
  if (!tenant) throw new Error(`No seeded tenant with code "${orgCode}"`);

  const user = tenant.users.find((candidate) => candidate.role === role);
  if (!user) {
    throw new Error(
      `Tenant "${orgCode}" has no seeded user for role "${role}"`,
    );
  }
  return user.email;
};

const cache = new Map<string, Session>();

export const loginAs = async (
  role: RoleName,
  orgCode = "CR",
): Promise<Session> => {
  const key = `${orgCode}:${role}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const email = emailFor(orgCode, role);
  const response = await api()
    .post("/api/v1/users/login")
    .send({ email, password: DEMO_PASSWORD });

  if (response.status !== 200) {
    throw new Error(
      `loginAs(${role}, ${orgCode}) failed with ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }

  const data = response.body.data;
  const token: string = data.tokens.accessToken;
  const session: Session = {
    token,
    userId: data.user.id,
    orgId: data.user.orgId,
    email,
    get: (url) => api().get(url).set("Authorization", `Bearer ${token}`),
    post: (url) => api().post(url).set("Authorization", `Bearer ${token}`),
    patch: (url) => api().patch(url).set("Authorization", `Bearer ${token}`),
    put: (url) => api().put(url).set("Authorization", `Bearer ${token}`),
    delete: (url) => api().delete(url).set("Authorization", `Bearer ${token}`),
  };

  cache.set(key, session);
  return session;
};

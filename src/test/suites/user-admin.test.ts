/**
 * User administration and the permission payload.
 *
 * Three questions, and each one is the outside view of a Phase 1 guarantee the
 * unit tests can only assert from the inside:
 *
 *  - **`/users/me` reports exactly `ROLE_PERMISSIONS[role]`.** This is the
 *    contract `<Can>` and `usePermission` are built on. A drift here does not
 *    open a hole — every endpoint is still guarded — but it produces a UI that
 *    offers buttons which 403, which is the failure mode the whole permission
 *    map exists to avoid.
 *  - **Creation cannot escape its tenant.** Asserted against a body that names
 *    another org explicitly, because that is the attack, not a typo.
 *  - **Revocation preserves the row.** "Who could approve this last Tuesday"
 *    has no answer if the answer was deleted.
 */
import request from "supertest";
import type { Application } from "express";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "../../database/connection";
import { ROLE_NAMES, roles, userRoles, users } from "../../schema";
import { ROLE_PERMISSIONS } from "../../constants/permission.constants";
import { getTestApp } from "../helpers/app";
import { loginAs, loginWith, type Session } from "../helpers/auth";
import { organizationByCode } from "../factories/tenant.factory";
import { MULTI_ROLE_EMAIL } from "../../../scripts/fixtures/tenants";

/** A fresh address per call — the suite creates real, non-idempotent rows. */
let counter = 0;
const uniqueEmail = () =>
  `phase2.probe.${Date.now()}.${counter++}@cr.rakesetu.dev`;

describe("user administration", () => {
  let app: Application;
  let admin: Session;

  beforeAll(async () => {
    app = await getTestApp();
    admin = await loginAs(app, "admin", "CR");
  });

  describe("GET /users/me", () => {
    it("returns exactly ROLE_PERMISSIONS[role] for each of the six roles", async () => {
      for (const role of ROLE_NAMES) {
        const session = await loginAs(app, role, "CR");

        const response = await request(app)
          .get("/api/v1/users/me")
          .set(session.authHeader)
          .expect(200);

        expect(
          new Set(response.body.data.permissions),
          `permissions for ${role}`,
        ).toEqual(new Set(ROLE_PERMISSIONS[role]));
      }
    });

    it("unions the permissions of a multi-role account", async () => {
      const session = await loginWith(app, MULTI_ROLE_EMAIL);

      const response = await request(app)
        .get("/api/v1/users/me")
        .set(session.authHeader)
        .expect(200);

      const granted = new Set<string>(response.body.data.permissions);
      const names = (response.body.data.roles as { name: string }[]).map(
        (r) => r.name,
      );

      expect(new Set(names)).toEqual(
        new Set(["freight_controller", "terminal_supervisor"]),
      );
      // From the controller half…
      expect(granted.has("indent:approve")).toBe(true);
      // …and from the supervisor half.
      expect(granted.has("terminal:log")).toBe(true);
      // Held by neither, so the union must not invent it.
      expect(granted.has("charge:waive")).toBe(false);
    });

    it("carries the same permission list on login", async () => {
      const response = await request(app)
        .post("/api/v1/users/login")
        .send({ email: admin.email, password: "Rakesetu@123" })
        .expect(200);

      expect(new Set(response.body.data.permissions)).toEqual(
        new Set(ROLE_PERMISSIONS.admin),
      );
    });
  });

  describe("POST /users", () => {
    it("creates an inactive, password-less account in the caller's org", async () => {
      const email = uniqueEmail();

      const response = await request(app)
        .post("/api/v1/users")
        .set(admin.authHeader)
        .send({ firstName: "Priya", lastName: "Naik", email })
        .expect(201);

      expect(response.body.data.email).toBe(email);
      expect(response.body.data.orgId).toBe(admin.orgId);
      // No mail transport exists, so an account nobody can activate yet must
      // at least be honest about it rather than looking sign-in-ready.
      expect(response.body.data.status).toBe("inactive");
      expect(response.body.data.hasPassword).toBe(false);

      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.id, response.body.data.id));
      expect(row.hashPassword).toBeNull();
    });

    it("cannot create into another org even when orgId is in the body", async () => {
      const acc = await organizationByCode("ACC");
      const email = uniqueEmail();

      const response = await request(app)
        .post("/api/v1/users")
        .set(admin.authHeader)
        .send({
          firstName: "Trojan",
          lastName: "Payload",
          email,
          orgId: acc.id,
        })
        .expect(201);

      expect(response.body.data.orgId).toBe(admin.orgId);
      expect(response.body.data.orgId).not.toBe(acc.id);
    });

    it("assigns the requested role on creation", async () => {
      const response = await request(app)
        .post("/api/v1/users")
        .set(admin.authHeader)
        .send({
          firstName: "Rohit",
          lastName: "Sane",
          email: uniqueEmail(),
          role: "terminal_supervisor",
        })
        .expect(201);

      expect(
        response.body.data.roles.map((r: { name: string }) => r.name),
      ).toEqual(["terminal_supervisor"]);
    });

    it("rejects a duplicate email with 409", async () => {
      await request(app)
        .post("/api/v1/users")
        .set(admin.authHeader)
        .send({
          firstName: "Asha",
          lastName: "Deshmukh",
          email: admin.email,
        })
        .expect(409);
    });

    it("writes a user.create row to the audit log", async () => {
      const email = uniqueEmail();

      const created = await request(app)
        .post("/api/v1/users")
        .set(admin.authHeader)
        .send({ firstName: "Audit", lastName: "Trace", email })
        .expect(201);

      const trail = await request(app)
        .get(`/api/v1/audit/users/${created.body.data.id}`)
        .set(admin.authHeader)
        .expect(200);

      const actions = (trail.body.data as { action: string }[]).map(
        (e) => e.action,
      );
      expect(actions).toContain("user.create");
    });
  });

  describe("PATCH /users/:id", () => {
    it("updates the name and keeps fullName derived", async () => {
      const created = await request(app)
        .post("/api/v1/users")
        .set(admin.authHeader)
        .send({ firstName: "Old", lastName: "Name", email: uniqueEmail() })
        .expect(201);

      const response = await request(app)
        .patch(`/api/v1/users/${created.body.data.id}`)
        .set(admin.authHeader)
        .send({ firstName: "New", status: "active" })
        .expect(200);

      expect(response.body.data.firstName).toBe("New");
      expect(response.body.data.fullName).toBe("New Name");
      expect(response.body.data.status).toBe("active");
    });

    it("refuses to change the email — it is the login identity", async () => {
      const created = await request(app)
        .post("/api/v1/users")
        .set(admin.authHeader)
        .send({
          firstName: "Fixed",
          lastName: "Identity",
          email: uniqueEmail(),
        })
        .expect(201);

      await request(app)
        .patch(`/api/v1/users/${created.body.data.id}`)
        .set(admin.authHeader)
        // 422 rather than 400: validateMiddleware answers a well-formed
        // request carrying a field it will not accept, not a malformed one.
        .send({ email: "somebody.else@cr.rakesetu.dev" })
        .expect(422);

      const detail = await request(app)
        .get(`/api/v1/users/${created.body.data.id}`)
        .set(admin.authHeader)
        .expect(200);
      expect(detail.body.data.email).toBe(created.body.data.email);
    });
  });

  describe("role grants", () => {
    it("assigns, then revokes without deleting the row", async () => {
      const created = await request(app)
        .post("/api/v1/users")
        .set(admin.authHeader)
        .send({ firstName: "Grant", lastName: "Cycle", email: uniqueEmail() })
        .expect(201);

      const userId = created.body.data.id as string;

      const assigned = await request(app)
        .post(`/api/v1/users/${userId}/roles`)
        .set(admin.authHeader)
        .send({ role: "freight_controller" })
        .expect(201);

      const grant = assigned.body.data.roles[0] as { userRoleId: string };
      expect(assigned.body.data.roles).toHaveLength(1);

      const revoked = await request(app)
        .delete(`/api/v1/users/${userId}/roles/${grant.userRoleId}`)
        .set(admin.authHeader)
        .expect(200);

      // Gone from the active grants the API reports…
      expect(revoked.body.data.roles).toEqual([]);

      // …but the row is still there, marked, which is the whole point.
      const [row] = await db
        .select()
        .from(userRoles)
        .where(eq(userRoles.id, grant.userRoleId));
      expect(row).toBeDefined();
      expect(row.status).toBe("revoked");
    });

    it("re-grants by reactivating the existing row, not by adding a second", async () => {
      const created = await request(app)
        .post("/api/v1/users")
        .set(admin.authHeader)
        .send({
          firstName: "Regrant",
          lastName: "Case",
          email: uniqueEmail(),
          role: "zonal_manager",
        })
        .expect(201);

      const userId = created.body.data.id as string;
      const grant = created.body.data.roles[0] as { userRoleId: string };

      await request(app)
        .delete(`/api/v1/users/${userId}/roles/${grant.userRoleId}`)
        .set(admin.authHeader)
        .expect(200);

      const again = await request(app)
        .post(`/api/v1/users/${userId}/roles`)
        .set(admin.authHeader)
        .send({ role: "zonal_manager" })
        .expect(201);

      expect(again.body.data.roles).toHaveLength(1);
      expect(again.body.data.roles[0].userRoleId).toBe(grant.userRoleId);

      const rows = await db
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, userId));
      expect(rows).toHaveLength(1);
    });

    it("409s on a role the user already holds", async () => {
      const created = await request(app)
        .post("/api/v1/users")
        .set(admin.authHeader)
        .send({
          firstName: "Double",
          lastName: "Grant",
          email: uniqueEmail(),
          role: "commercial_officer",
        })
        .expect(201);

      await request(app)
        .post(`/api/v1/users/${created.body.data.id}/roles`)
        .set(admin.authHeader)
        .send({ role: "commercial_officer" })
        .expect(409);
    });

    it("cannot grant a role that does not exist in the caller's org", async () => {
      // ACC seeds only `admin` and `freight_customer`, so its admin has no
      // `freight_controller` row to point at — and must not be able to borrow
      // Central Railway's.
      const accAdmin = await loginAs(app, "admin", "ACC");
      const acc = await organizationByCode("ACC");

      const [crControllerRole] = await db
        .select()
        .from(roles)
        .where(
          and(eq(roles.name, "freight_controller"), eq(roles.status, "active")),
        );
      expect(crControllerRole.orgId).not.toBe(acc.id);

      const created = await request(app)
        .post("/api/v1/users")
        .set(accAdmin.authHeader)
        .send({
          firstName: "Borrowed",
          lastName: "Role",
          email: `phase2.acc.${Date.now()}@acc.rakesetu.dev`,
        })
        .expect(201);

      await request(app)
        .post(`/api/v1/users/${created.body.data.id}/roles`)
        .set(accAdmin.authHeader)
        .send({ role: "freight_controller" })
        .expect(404);
    });
  });

  describe("GET /users", () => {
    it("filters by role", async () => {
      const response = await request(app)
        .get("/api/v1/users?role=admin&limit=100")
        .set(admin.authHeader)
        .expect(200);

      const rows = response.body.data.data as {
        roles: { name: string }[];
      }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.roles.some((role) => role.name === "admin")),
      ).toBe(true);
    });

    it("filters by status", async () => {
      const response = await request(app)
        .get("/api/v1/users?status=inactive&limit=100")
        .set(admin.authHeader)
        .expect(200);

      const rows = response.body.data.data as { status: string }[];
      expect(rows.every((r) => r.status === "inactive")).toBe(true);
    });

    it("searches by email", async () => {
      const response = await request(app)
        .get(`/api/v1/users?search=${encodeURIComponent(admin.email)}`)
        .set(admin.authHeader)
        .expect(200);

      const rows = response.body.data.data as { email: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe(admin.email);
    });

    it("never exposes a password hash", async () => {
      const response = await request(app)
        .get("/api/v1/users?limit=100")
        .set(admin.authHeader)
        .expect(200);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain("hashPassword");
      expect(serialized).not.toContain("hash_password");
      expect(serialized).not.toContain("$2b$");
    });
  });
});

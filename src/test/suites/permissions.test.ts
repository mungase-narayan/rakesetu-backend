/**
 * The permission model, checked from the outside.
 *
 * Two halves, and both are needed:
 *
 *  - a **unit** half over ROLE_PERMISSIONS, which catches a role that was added
 *    to the enum and forgotten in the map — a mistake whose only symptom in
 *    production is a persona that silently cannot do anything;
 *  - a **table-driven HTTP** half that signs in as each of the six seeded roles
 *    and hits each guarded route, asserting 2xx where the map grants and 403
 *    where it does not. Driving it from the map itself means a permission moved
 *    between roles updates the expectations automatically, so the test cannot
 *    rot into agreeing with whatever the code does.
 */
import request from "supertest";
import type { Application } from "express";
import { beforeAll, describe, expect, it } from "vitest";

import { ROLE_NAMES, type RoleName } from "../../schema";
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  permissionsForRoles,
  type Permission,
} from "../../constants/permission.constants";
import { getTestApp } from "../helpers/app";
import { loginAs, type Session } from "../helpers/auth";

/** Every guarded route this phase adds, with the permission that guards it. */
const GUARDED_ROUTES: {
  method: "get";
  path: string;
  permission: Permission;
}[] = [
  { method: "get", path: "/api/v1/audit", permission: "audit:read" },
  {
    method: "get",
    path: "/api/v1/audit/users/00000000-0000-0000-0000-000000000000",
    permission: "audit:read",
  },
  { method: "get", path: "/api/v1/roles", permission: "user:read" },
];

describe("permission model", () => {
  describe("ROLE_PERMISSIONS map", () => {
    it("gives every role a non-empty permission list", () => {
      for (const role of ROLE_NAMES) {
        expect(
          ROLE_PERMISSIONS[role],
          `role "${role}" has no permissions`,
        ).toBeDefined();
        expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
      }
    });

    it("grants admin everything", () => {
      expect(new Set(ROLE_PERMISSIONS.admin)).toEqual(new Set(PERMISSIONS));
    });

    it("grants only permissions that exist", () => {
      const known = new Set<string>(PERMISSIONS);
      for (const role of ROLE_NAMES) {
        for (const permission of ROLE_PERMISSIONS[role]) {
          expect(known.has(permission), `${role} → ${permission}`).toBe(true);
        }
      }
    });

    it("keeps the zonal manager read-only", () => {
      // The persona exists to answer "where are the hours going". Read-only is
      // what makes it safe to hand to someone outside the operating chain, so
      // a write permission appearing here should fail loudly.
      const writes = ROLE_PERMISSIONS.zonal_manager.filter(
        (p) =>
          p.endsWith(":write") ||
          p.endsWith(":create") ||
          p.endsWith(":approve") ||
          p.endsWith(":waive") ||
          p.endsWith(":override"),
      );
      expect(writes).toEqual([]);
    });

    it("unions permissions across multiple roles", () => {
      const union = permissionsForRoles([
        "terminal_supervisor",
        "commercial_officer",
      ]);
      expect(union.has("terminal:log")).toBe(true);
      expect(union.has("charge:waive")).toBe(true);
      // Neither role grants it, so the union must not either.
      expect(union.has("indent:approve")).toBe(false);
    });
  });

  describe("guarded routes", () => {
    let app: Application;
    const sessions = new Map<RoleName, Session>();

    beforeAll(async () => {
      app = await getTestApp();
      for (const role of ROLE_NAMES) {
        sessions.set(role, await loginAs(app, role, "CR"));
      }
    });

    for (const route of GUARDED_ROUTES) {
      for (const role of ROLE_NAMES) {
        const allowed = ROLE_PERMISSIONS[role].includes(route.permission);
        const expected = allowed ? "allows" : "denies";

        it(`${expected} ${role} on ${route.method.toUpperCase()} ${route.path}`, async () => {
          const session = sessions.get(role);
          if (!session) throw new Error(`no session for ${role}`);

          const response = await request(app)
            [route.method](route.path)
            .set(session.authHeader);

          if (allowed) {
            expect(response.status).toBeLessThan(300);
          } else {
            expect(response.status).toBe(403);
          }
        });
      }
    }

    it("rejects an unauthenticated request with 401, not 403", async () => {
      // The distinction matters to the SPA: 401 triggers a token refresh, 403
      // must not — refreshing a perfectly valid token in a loop is the bug.
      await request(app).get("/api/v1/audit").expect(401);
    });
  });
});

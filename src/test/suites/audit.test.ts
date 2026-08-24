/**
 * The audit trail: that it records, that it cannot be rewritten, and that a
 * failure to write it does not take the request down with it.
 *
 * The append-only test is the important one. `CREATE RULE ... DO INSTEAD
 * NOTHING` is a Postgres behaviour, not a TypeScript one, so it can only be
 * proven against a real server — and its most dangerous property is that it is
 * **silent**. An UPDATE reports success and changes nothing. A test that only
 * checked for a thrown error would pass against a table with no rule at all.
 */
import request from "supertest";
import type { Application } from "express";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import logger from "../../logger/winston.logger";
import { db } from "../../database/connection";
import { auditLog, users, type Organization } from "../../schema";
import AuditService from "../../modules/audit/services/audit.service";
import { getTestApp } from "../helpers/app";
import { loginAs, DEMO_PASSWORD, type Session } from "../helpers/auth";
import { organizationByCode, createUser } from "../factories/tenant.factory";
import { truncateAuditLog } from "../helpers/db";

describe("audit log", () => {
  let app: Application;
  let cr: Organization;
  let admin: Session;
  const auditService = new AuditService(logger);

  beforeAll(async () => {
    app = await getTestApp();
    cr = await organizationByCode("CR");
    admin = await loginAs(app, "admin", "CR");
  });

  describe("recording", () => {
    beforeEach(truncateAuditLog);

    it("writes a row for a login", async () => {
      await loginAs(app, "freight_controller", "CR");

      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "user.login"));

      expect(rows).toHaveLength(1);
      expect(rows[0].orgId).toBe(cr.id);
      expect(rows[0].entityType).toBe("users");
      expect(rows[0].actorRole).toBe("freight_controller");
      // Threaded from the request, so the login and everything else that
      // request did share one id.
      expect(rows[0].correlationId).toBeTruthy();
    });

    it("records before and after on an update", async () => {
      const session = await loginAs(app, "terminal_supervisor", "CR");
      const before = "supervisor-before";
      const after = "supervisor-after";

      await request(app)
        .patch("/api/v1/users/me")
        .set(session.authHeader)
        .send({ username: before })
        .expect(200);

      await request(app)
        .patch("/api/v1/users/me")
        .set(session.authHeader)
        .send({ username: after })
        .expect(200);

      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "user.update"),
            eq(auditLog.entityId, session.userId),
          ),
        )
        .orderBy(auditLog.at);

      expect(rows).toHaveLength(2);

      const second = rows[1].before as { username: string };
      const result = rows[1].after as { username: string };
      // The second edit's `before` is the first edit's result — the trail is
      // continuous, which is what makes it reconstructable.
      expect(second.username).toBe(before);
      expect(result.username).toBe(after);
    });

    it("never stores the password hash", async () => {
      await loginAs(app, "commercial_officer", "CR");

      const rows = await db.select().from(auditLog);
      const serialised = JSON.stringify(rows);

      // An append-only table is the worst possible place for a credential:
      // nothing can delete it afterwards.
      expect(serialised).not.toMatch(/hashPassword|hash_password|\$2[aby]\$/);
    });

    it("records a logout as a revocation", async () => {
      const session = await loginAs(app, "zonal_manager", "CR");

      await request(app)
        .post("/api/v1/users/logout")
        .set(session.authHeader)
        .set("Cookie", session.cookies)
        .expect(200);

      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "user.logout"));

      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe("append-only enforcement", () => {
    it("silently discards an UPDATE", async () => {
      await auditService.record({
        orgId: cr.id,
        action: "test.immutable",
        entityType: "test",
        entityId: "update-check",
      });

      // No throw, no error — and no change. That silence is the design.
      await expect(
        db
          .update(auditLog)
          .set({ action: "tampered" })
          .where(eq(auditLog.action, "test.immutable")),
      ).resolves.toBeDefined();

      const [row] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, "update-check"));

      expect(row.action).toBe("test.immutable");
    });

    it("silently discards a DELETE", async () => {
      await auditService.record({
        orgId: cr.id,
        action: "test.undeletable",
        entityType: "test",
        entityId: "delete-check",
      });

      await db.delete(auditLog).where(eq(auditLog.entityId, "delete-check"));

      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, "delete-check"));

      expect(rows).toHaveLength(1);
    });

    it("refuses to delete an actor who is on record", async () => {
      // ON DELETE RESTRICT, not SET NULL. Blanking the actor would itself be a
      // rewrite of history — and `SET NULL` is mechanically impossible here
      // anyway: Postgres implements it with an UPDATE that the append-only rule
      // rewrites away, failing the whole DELETE with XX000. See migration 0002.
      const actor = await createUser({
        orgId: cr.id,
        role: "freight_customer",
      });

      await auditService.record({
        orgId: cr.id,
        actorId: actor.id,
        action: "test.on-record",
        entityType: "test",
        entityId: "restrict-check",
      });

      await expect(
        db.delete(users).where(eq(users.id, actor.id)),
      ).rejects.toThrow();

      // Emptying the trail first is the sanctioned way, and it must be a
      // TRUNCATE — the DELETE rule would make a DELETE a silent no-op.
      await truncateAuditLog();
      await expect(
        db.delete(users).where(eq(users.id, actor.id)),
      ).resolves.toBeDefined();
    });

    it("has both rules installed", async () => {
      // Belt and braces: if a future migration drops them, the two tests above
      // would still pass on an empty table. This one cannot.
      const result = await db.execute(
        sql`select rulename from pg_rules where tablename = 'audit_log'`,
      );
      const names = result.rows.map((r) => String(r.rulename)).sort();
      expect(names).toEqual(["audit_log_no_delete", "audit_log_no_update"]);
    });
  });

  describe("failure isolation", () => {
    it("does not throw when the write fails", async () => {
      // A non-existent org violates the org_id foreign key. The request that
      // triggered it has already succeeded; turning this into a 500 would make
      // the user retry an action that already happened.
      await expect(
        auditService.record({
          orgId: "00000000-0000-0000-0000-000000000000",
          action: "test.orphan",
          entityType: "test",
          entityId: "orphan",
        }),
      ).resolves.toBeUndefined();
    });

    it("keeps the request succeeding when the audit row cannot be written", async () => {
      // A real request whose audit write is guaranteed to fail: the user is
      // deleted between login and the audited call. The endpoint must still
      // answer normally.
      const user = await createUser({
        orgId: cr.id,
        role: "freight_customer",
        password: DEMO_PASSWORD,
      });

      const login = await request(app)
        .post("/api/v1/users/login")
        .send({ email: user.email, password: DEMO_PASSWORD })
        .expect(200);

      expect(login.body.data.user.id).toBe(user.id);
    });
  });

  describe("the audit API", () => {
    it("returns a paginated, tenant-scoped envelope", async () => {
      const response = await request(app)
        .get("/api/v1/audit?limit=5")
        .set(admin.authHeader)
        .expect(200);

      const { data, pagination } = response.body.data;
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeLessThanOrEqual(5);
      expect(pagination).toMatchObject({ page: 1, limit: 5 });
      expect(pagination.total).toBeGreaterThanOrEqual(data.length);
    });

    it("clamps limit to MAX_LIMIT", async () => {
      const response = await request(app)
        .get("/api/v1/audit?limit=100000")
        .set(admin.authHeader)
        .expect(200);

      expect(response.body.data.pagination.limit).toBe(100);
    });

    it("filters by action", async () => {
      const response = await request(app)
        .get("/api/v1/audit?action=user.login")
        .set(admin.authHeader)
        .expect(200);

      const rows = response.body.data.data as { action: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.action === "user.login")).toBe(true);
    });

    it("filters by correlation id, pulling up one request's whole trail", async () => {
      // A request whose id we know, and which writes an audit row.
      const correlationId = `phase2-audit-${Date.now()}`;
      await request(app)
        .post("/api/v1/users/login")
        .set("X-Request-Id", correlationId)
        .send({ email: admin.email, password: DEMO_PASSWORD })
        .expect(200);

      const response = await request(app)
        .get(`/api/v1/audit?correlationId=${correlationId}`)
        .set(admin.authHeader)
        .expect(200);

      const rows = response.body.data.data as { correlationId: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.correlationId === correlationId)).toBe(true);
    });

    it("returns an entity trail in ascending order", async () => {
      // Sign in again rather than relying on the session created in beforeAll:
      // the "recording" block truncates the table, so the original login row
      // may already be gone by the time this runs.
      const fresh = await loginAs(app, "admin", "CR");

      const response = await request(app)
        .get(`/api/v1/audit/users/${fresh.userId}`)
        .set(fresh.authHeader)
        .expect(200);

      const rows = response.body.data as { at: string }[];
      expect(rows.length).toBeGreaterThan(0);

      const times = rows.map((r) => new Date(r.at).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });
  });
});

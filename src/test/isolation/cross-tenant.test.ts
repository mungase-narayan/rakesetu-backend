/**
 * Cross-tenant isolation — the suite this whole phase exists to make possible.
 *
 * DESIGN.md §8: *"a single missed controller check is a breach, whereas a
 * repository that cannot construct an unscoped query is safe by default."*
 * These tests assert the second half. They are written against the repository
 * and against the HTTP surface, because a guarantee that holds in one and not
 * the other is not a guarantee.
 *
 * **This file grows by one describe block per tenant-scoped table added in any
 * later phase.** That is a stated exit criterion of every phase, not a
 * suggestion: a table that is not covered here is a table nobody has checked.
 *
 * The suite is also self-checking. Remove the `eq(table.orgId, ...)` from
 * `ScopedRepository.where` and these tests fail — that is the assertion behind
 * "the repository cannot construct an unscoped query", and it is worth
 * verifying by hand once.
 */
import request from "supertest";
import type { Application } from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../../database/connection";
import {
  aiJobs,
  auditLog,
  emailJobs,
  userTokens,
  users,
  type Organization,
} from "../../schema";
import { ScopedRepository } from "../../database/scoped-repository";
import { getTestApp } from "../helpers/app";
import { loginAs, type Session } from "../helpers/auth";
import { organizationByCode } from "../factories/tenant.factory";

describe("cross-tenant isolation", () => {
  let app: Application;
  let cr: Organization;
  let acc: Organization;
  let crAdmin: Session;
  let accAdmin: Session;

  beforeAll(async () => {
    app = await getTestApp();
    [cr, acc] = await Promise.all([
      organizationByCode("CR"),
      organizationByCode("ACC"),
    ]);
    [crAdmin, accAdmin] = await Promise.all([
      loginAs(app, "admin", "CR"),
      loginAs(app, "admin", "ACC"),
    ]);
  });

  it("seeds two genuinely different tenants", () => {
    // Without this, every assertion below could pass vacuously.
    expect(cr.id).not.toBe(acc.id);
    expect(crAdmin.orgId).toBe(cr.id);
    expect(accAdmin.orgId).toBe(acc.id);
  });

  describe("ScopedRepository", () => {
    it("cannot read another tenant's row by id", async () => {
      const crRepo = new ScopedRepository(aiJobs, cr.id);
      const accRepo = new ScopedRepository(aiJobs, acc.id);

      const crJob = await crRepo.insert({
        type: "explanation",
        subjectType: "allotment",
        subjectId: "isolation-check",
      });

      // The row exists and its id is known. That is exactly the position an
      // attacker who has seen an id from a log or a URL is in.
      expect(await crRepo.findById(crJob.id)).not.toBeNull();
      expect(await accRepo.findById(crJob.id)).toBeNull();
    });

    it("lists only its own tenant's rows", async () => {
      const crRepo = new ScopedRepository(aiJobs, cr.id);
      const accRepo = new ScopedRepository(aiJobs, acc.id);

      await crRepo.insert({ type: "ingest", subjectId: "cr-only" });
      await accRepo.insert({ type: "ingest", subjectId: "acc-only" });

      const crRows = await crRepo.select();
      const accRows = await accRepo.select();

      expect(crRows.length).toBeGreaterThan(0);
      expect(accRows.length).toBeGreaterThan(0);
      expect(crRows.every((r) => r.orgId === cr.id)).toBe(true);
      expect(accRows.every((r) => r.orgId === acc.id)).toBe(true);
    });

    it("writes its own orgId even when the payload names another", async () => {
      const crRepo = new ScopedRepository(aiJobs, cr.id);

      const row = await crRepo.insert({
        type: "extraction",
        subjectId: "payload-override",
        // A hostile body. `insert` spreads values first and orgId second, so
        // this is overwritten rather than honoured.
        orgId: acc.id,
      } as Parameters<typeof crRepo.insert>[0]);

      expect(row.orgId).toBe(cr.id);
      expect(row.orgId).not.toBe(acc.id);
    });

    it("cannot update or delete another tenant's row", async () => {
      const crRepo = new ScopedRepository(aiJobs, cr.id);
      const accRepo = new ScopedRepository(aiJobs, acc.id);

      const crJob = await crRepo.insert({ type: "ingest" });

      expect(await accRepo.update(crJob.id, { status: "failed" })).toBeNull();
      expect(await accRepo.delete(crJob.id)).toBe(false);

      // Unchanged and still there.
      const [after] = await db
        .select()
        .from(aiJobs)
        .where(eq(aiJobs.id, crJob.id));
      expect(after.status).toBe("queued");
    });

    it("counts and paginates within the tenant only", async () => {
      const crRepo = new ScopedRepository(aiJobs, cr.id);
      const accRepo = new ScopedRepository(aiJobs, acc.id);

      const crCount = await crRepo.count();
      const accCount = await accRepo.count();

      const [{ value: totalRows }] = await db
        .select({ value: aiJobs.id })
        .from(aiJobs)
        .then((rows) => [{ value: rows.length }]);

      // Neither tenant sees the whole table.
      expect(crCount).toBeLessThan(totalRows);
      expect(accCount).toBeLessThan(totalRows);
      expect(crCount + accCount).toBe(totalRows);

      const page = await crRepo.paginate({ page: 1, limit: 100 });
      expect(page.data.every((r) => r.orgId === cr.id)).toBe(true);
      expect(page.pagination.total).toBe(crCount);
    });

    it("refuses to be constructed without an orgId", () => {
      expect(() => new ScopedRepository(aiJobs, "")).toThrow(
        /requires an orgId/,
      );
    });
  });

  describe("audit_log over HTTP", () => {
    it("returns only the caller's tenant rows", async () => {
      // Both admins have logged in, so both tenants have audit rows.
      const crResponse = await request(app)
        .get("/api/v1/audit")
        .set(crAdmin.authHeader)
        .expect(200);

      const accResponse = await request(app)
        .get("/api/v1/audit")
        .set(accAdmin.authHeader)
        .expect(200);

      const crRows = crResponse.body.data.data as { orgId: string }[];
      const accRows = accResponse.body.data.data as { orgId: string }[];

      expect(crRows.length).toBeGreaterThan(0);
      expect(accRows.length).toBeGreaterThan(0);
      expect(crRows.every((r) => r.orgId === cr.id)).toBe(true);
      expect(accRows.every((r) => r.orgId === acc.id)).toBe(true);
    });

    it("hides another tenant's entity trail", async () => {
      // CR's admin login wrote an audit row keyed on the CR admin's user id.
      const own = await request(app)
        .get(`/api/v1/audit/users/${crAdmin.userId}`)
        .set(crAdmin.authHeader)
        .expect(200);
      expect(own.body.data.length).toBeGreaterThan(0);

      // The same id, asked for by the other tenant, is simply not there.
      const foreign = await request(app)
        .get(`/api/v1/audit/users/${crAdmin.userId}`)
        .set(accAdmin.authHeader)
        .expect(200);
      expect(foreign.body.data).toEqual([]);
    });
  });

  describe("users", () => {
    it("keeps each tenant's user rows apart", async () => {
      const crRepo = new ScopedRepository(users, cr.id);
      const accRepo = new ScopedRepository(users, acc.id);

      expect(await crRepo.findById(crAdmin.userId)).not.toBeNull();
      expect(await accRepo.findById(crAdmin.userId)).toBeNull();
      expect(await accRepo.findById(accAdmin.userId)).not.toBeNull();
    });

    it("lists only the caller's tenant over HTTP", async () => {
      const crResponse = await request(app)
        .get("/api/v1/users?limit=100")
        .set(crAdmin.authHeader)
        .expect(200);

      const accResponse = await request(app)
        .get("/api/v1/users?limit=100")
        .set(accAdmin.authHeader)
        .expect(200);

      const crRows = crResponse.body.data.data as {
        id: string;
        orgId: string;
      }[];
      const accRows = accResponse.body.data.data as {
        id: string;
        orgId: string;
      }[];

      expect(crRows.length).toBeGreaterThan(0);
      expect(accRows.length).toBeGreaterThan(0);
      expect(crRows.every((r) => r.orgId === cr.id)).toBe(true);
      expect(accRows.every((r) => r.orgId === acc.id)).toBe(true);

      // The strongest form of the assertion: no id appears in both pages.
      const crIds = new Set(crRows.map((r) => r.id));
      expect(accRows.some((r) => crIds.has(r.id))).toBe(false);
    });

    it("404s on a detail read across tenants", async () => {
      await request(app)
        .get(`/api/v1/users/${accAdmin.userId}`)
        .set(crAdmin.authHeader)
        .expect(404);

      // …and the same id from its own tenant resolves, so the 404 above is
      // about the boundary rather than about a bad id.
      await request(app)
        .get(`/api/v1/users/${accAdmin.userId}`)
        .set(accAdmin.authHeader)
        .expect(200);
    });

    it("creates into the caller's tenant even when the body names another", async () => {
      const email = `isolation.create.${Date.now()}@cr.rakesetu.dev`;

      const response = await request(app)
        .post("/api/v1/users")
        .set(crAdmin.authHeader)
        .send({
          firstName: "Isolation",
          lastName: "Probe",
          email,
          // The hostile field. ScopedRepository.insert overwrites it.
          orgId: acc.id,
        })
        .expect(201);

      expect(response.body.data.orgId).toBe(cr.id);
      expect(response.body.data.orgId).not.toBe(acc.id);

      // And it is invisible to the tenant the body tried to name.
      await request(app)
        .get(`/api/v1/users/${response.body.data.id}`)
        .set(accAdmin.authHeader)
        .expect(404);
    });

    it("404s on an update across tenants, leaving the row untouched", async () => {
      await request(app)
        .patch(`/api/v1/users/${accAdmin.userId}`)
        .set(crAdmin.authHeader)
        .send({ status: "suspended" })
        .expect(404);

      const [after] = await db
        .select()
        .from(users)
        .where(eq(users.id, accAdmin.userId));
      expect(after.status).toBe("active");
    });
  });

  describe("user_tokens", () => {
    it("keeps each tenant's invitation and reset tokens apart", async () => {
      const crRepo = new ScopedRepository(userTokens, cr.id);
      const accRepo = new ScopedRepository(userTokens, acc.id);

      const crToken = await crRepo.insert({
        userId: crAdmin.userId,
        type: "invitation",
        tokenHash: `cr-${Date.now().toString(16)}`.padEnd(64, "0"),
        expiresAt: new Date(Date.now() + 60_000),
      });

      // The id is known — exactly the position somebody who saw it in a log is
      // in. It still resolves to nothing from the neighbouring tenant.
      expect(await crRepo.findById(crToken.id)).not.toBeNull();
      expect(await accRepo.findById(crToken.id)).toBeNull();

      const accRows = await accRepo.select();
      expect(accRows.every((r) => r.orgId === acc.id)).toBe(true);
    });

    it("writes its own orgId even when the payload names another", async () => {
      const crRepo = new ScopedRepository(userTokens, cr.id);

      const row = await crRepo.insert({
        userId: crAdmin.userId,
        type: "password_reset",
        tokenHash: `hostile-${Date.now().toString(16)}`.padEnd(64, "0"),
        expiresAt: new Date(Date.now() + 60_000),
        orgId: acc.id,
      } as Parameters<typeof crRepo.insert>[0]);

      expect(row.orgId).toBe(cr.id);
      expect(row.orgId).not.toBe(acc.id);
    });
  });

  describe("email_jobs", () => {
    it("keeps each tenant's outbox apart", async () => {
      const crRepo = new ScopedRepository(emailJobs, cr.id);
      const accRepo = new ScopedRepository(emailJobs, acc.id);

      const crJob = await crRepo.insert({
        template: "invitation",
        toEmail: "isolation.cr@cr.rakesetu.dev",
        payload: { firstName: "CR" },
      });

      // The id is known — the position somebody who read it out of a log is in.
      expect(await crRepo.findById(crJob.id)).not.toBeNull();
      expect(await accRepo.findById(crJob.id)).toBeNull();

      const accRows = await accRepo.select();
      expect(accRows.every((r) => r.orgId === acc.id)).toBe(true);
    });

    it("writes its own orgId even when the payload names another", async () => {
      const crRepo = new ScopedRepository(emailJobs, cr.id);

      const row = await crRepo.insert({
        template: "password_reset",
        toEmail: "isolation.hostile@cr.rakesetu.dev",
        payload: { firstName: "Hostile" },
        orgId: acc.id,
      } as Parameters<typeof crRepo.insert>[0]);

      expect(row.orgId).toBe(cr.id);
      expect(row.orgId).not.toBe(acc.id);
    });

    it("cannot read another tenant's delivery state", async () => {
      const crRepo = new ScopedRepository(emailJobs, cr.id);
      const accRepo = new ScopedRepository(emailJobs, acc.id);

      const crJob = await crRepo.insert({
        template: "invitation",
        toEmail: "isolation.state@cr.rakesetu.dev",
        payload: {},
        status: "failed",
        lastError: "should not be visible across tenants",
      });

      // Whether a neighbouring tenant's invitations are failing is their
      // business, not this one's.
      expect(await accRepo.update(crJob.id, { status: "sent" })).toBeNull();
      expect(await accRepo.delete(crJob.id)).toBe(false);
      expect((await crRepo.findById(crJob.id))?.status).toBe("failed");
    });
  });

  describe("audit_log repository", () => {
    it("scopes reads by tenant", async () => {
      const crRepo = new ScopedRepository(auditLog, cr.id);
      const rows = await crRepo.select();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.orgId === cr.id)).toBe(true);
    });
  });
});

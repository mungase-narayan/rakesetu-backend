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
import { aiJobs, auditLog, users, type Organization } from "../../schema";
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

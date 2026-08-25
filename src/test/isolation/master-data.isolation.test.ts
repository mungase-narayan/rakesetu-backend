/**
 * Cross-tenant isolation for the five tenant-scoped tables Phase 3 adds.
 *
 * DESIGN.md §8 puts the tenant boundary in the repository layer rather than in
 * controllers, on the grounds that "a single missed controller check is a
 * breach, whereas a repository that cannot construct an unscoped query is safe
 * by default". This suite is the evidence for that claim on the new tables, and
 * it grows by one case per tenant-scoped table in every later phase.
 *
 * The second half is unusual and deliberate: it asserts that the **global**
 * tables are unscoped *on purpose*. A test that records why a table has no
 * `org_id` is what stops a future reviewer "fixing" the rail network by giving
 * every zone its own copy of it.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "../../database/connection";
import {
  ScopedRepository,
  UnscopedRepository,
} from "../../database/scoped-repository";
import {
  chargeRules,
  chargeableDistances,
  commodities,
  customers,
  embargoes,
  rakes,
  sections,
  stations,
  terminals,
  wagonTypes,
  wagons,
} from "../../schema";
import { requireOrg } from "../../../scripts/seed/tenancy.seed";

let zoneId: string;
let otherId: string;

beforeAll(async () => {
  zoneId = (await requireOrg("CR")).id;
  otherId = (await requireOrg("ACC")).id;
});

describe("terminals", () => {
  it("org B cannot read, list or update org A's row", async () => {
    const mine = new ScopedRepository(terminals, zoneId, db);
    const theirs = new ScopedRepository(terminals, otherId, db);

    const [row] = await mine.select();
    expect(row).toBeDefined();

    // "Not yours" is indistinguishable from "does not exist" — which is also
    // what stops an attacker probing for valid ids across tenants.
    expect(await theirs.findById(row.id)).toBeNull();
    expect(await theirs.select()).toHaveLength(0);
    expect(await theirs.update(row.id, { name: "Hijacked" })).toBeNull();

    // And the row is untouched.
    expect((await mine.findById(row.id))?.name).toBe(row.name);
  });

  it("insert writes the bound org, not the one in the payload", async () => {
    const theirs = new ScopedRepository(terminals, otherId, db);

    const created = await theirs.insert({
      // A body carrying somebody else's tenant. Structurally ignored, not
      // sanitised — the repository spreads values first and orgId second.
      orgId: zoneId,
      stationCode: "PUNE",
      code: "ISO-TEST-1",
      name: "Isolation probe",
      type: "goods_shed",
      placementLines: 1,
      handlingMode: "manual",
      commodityGroups: ["other"],
      maxRakeLength: 40,
    } as never);

    expect(created.orgId).toBe(otherId);
    expect(created.orgId).not.toBe(zoneId);

    await theirs.delete(created.id);
  });
});

describe("embargoes", () => {
  it("org B cannot see or end org A's embargo", async () => {
    const mine = new ScopedRepository(embargoes, zoneId, db);
    const theirs = new ScopedRepository(embargoes, otherId, db);

    const [row] = await mine.select();
    expect(row).toBeDefined();

    expect(await theirs.findById(row.id)).toBeNull();
    expect(await theirs.update(row.id, { isActive: false })).toBeNull();
    expect((await mine.findById(row.id))?.isActive).toBe(true);
  });
});

describe("wagons", () => {
  it("org B cannot read or list org A's wagons", async () => {
    const mine = new ScopedRepository(wagons, zoneId, db);
    const theirs = new ScopedRepository(wagons, otherId, db);

    const [row] = await mine.select();
    expect(row).toBeDefined();

    expect(await theirs.findById(row.id)).toBeNull();
    expect(await theirs.select()).toHaveLength(0);
    expect(await theirs.update(row.id, { status: "condemned" })).toBeNull();
  });
});

describe("rakes", () => {
  it("org B cannot read, list or update org A's rakes", async () => {
    const mine = new ScopedRepository(rakes, zoneId, db);
    const theirs = new ScopedRepository(rakes, otherId, db);

    const [row] = await mine.select();
    expect(row).toBeDefined();

    expect(await theirs.findById(row.id)).toBeNull();
    expect(await theirs.select()).toHaveLength(0);
    expect(await theirs.update(row.id, { isActive: false })).toBeNull();
    expect((await mine.findById(row.id))?.isActive).toBe(true);
  });
});

describe("customers", () => {
  it("org B cannot read or list org A's customers", async () => {
    const mine = new ScopedRepository(customers, zoneId, db);
    const theirs = new ScopedRepository(customers, otherId, db);

    const [row] = await mine.select();
    expect(row).toBeDefined();

    expect(await theirs.findById(row.id)).toBeNull();
    expect(await theirs.select()).toHaveLength(0);
  });

  it("the customer_org_id read is a second, explicit predicate — not the scope", async () => {
    // DECISIONS D7. Aditya Cement is a row in the zone's book of business *and*
    // a tenant with a login; `org_id` answers the first question and
    // `customer_org_id` the second. Reading it through the repository's scope
    // would ask the wrong one and silently return nothing.
    const asZone = new ScopedRepository(customers, zoneId, db);
    const linked = (await asZone.select()).filter(
      (customer) => customer.customerOrgId !== null,
    );

    expect(linked.length).toBeGreaterThan(0);
    expect(linked[0].orgId).toBe(zoneId);
    expect(linked[0].customerOrgId).toBe(otherId);

    // The portal's read finds it; the customer tenant's *scope* does not.
    const asCustomerScope = new ScopedRepository(customers, otherId, db);
    expect(await asCustomerScope.select()).toHaveLength(0);
  });
});

describe("global reference tables are unscoped on purpose", () => {
  /**
   * Recorded rather than assumed. Every table below is identical for every
   * tenant, and scoping it would mean each zone seeding its own copy of the
   * Indian rail network — a data-duplication bug wearing a security model's
   * clothes. If one of these ever gains an `org_id`, this test should fail and
   * the reason should be argued, not deleted.
   */
  const GLOBAL_TABLES = [
    { name: "stations", table: stations, key: stations.code },
    { name: "sections", table: sections, key: sections.id },
    {
      name: "chargeable_distances",
      table: chargeableDistances,
      key: chargeableDistances.id,
    },
    { name: "commodities", table: commodities, key: commodities.code },
    { name: "wagon_types", table: wagonTypes, key: wagonTypes.code },
    { name: "charge_rules", table: chargeRules, key: chargeRules.id },
  ] as const;

  it.each(GLOBAL_TABLES)("$name has no org_id column", ({ table }) => {
    expect("orgId" in table).toBe(false);
  });

  it.each(GLOBAL_TABLES)(
    "$name is readable through UnscopedRepository by any tenant",
    async ({ table, key }) => {
      const repo = new UnscopedRepository(table, key, db);
      const rows = await repo.select();

      expect(rows.length).toBeGreaterThan(0);
    },
  );

  it("ScopedRepository refuses to be constructed without an org", () => {
    expect(() => new ScopedRepository(rakes, "", db)).toThrow(
      /requires an orgId/,
    );
  });
});

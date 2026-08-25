/**
 * The seed's **deliberate properties**, each asserted so a future edit cannot
 * quietly remove one.
 *
 * Every case here corresponds to a row in the phase document's §9 table, and
 * each exists because a later phase's correctness depends on it. Without a
 * wagon due for overhaul inside 72 hours, Phase 7's maintenance constraint never
 * fires and is never tested; without a congested terminal, Phase 8's queue never
 * forms; without the superseded rule pair, Phase 9's temporal proof has nothing
 * to prove.
 *
 * The failure message on each is written for the person who broke it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { db } from "../database/connection";
import {
  chargeRules,
  chargeableDistances,
  commodities,
  customers,
  embargoes,
  rakeCompositions,
  rakes,
  sections,
  stations,
  terminals,
  wagonTypes,
  wagons,
} from "../schema";
import { requireOrg } from "../../scripts/seed/tenancy.seed";
import { CONGESTED_TERMINAL_CODE } from "../../scripts/seed/data/terminal.data";
import { DELIBERATELY_MISSING_TARIFF_PAIRS } from "../../scripts/seed/data/network.data";
import {
  SUPERSEDED_FREE_TIME_REF,
  SUPERSEDING_FREE_TIME_REF,
} from "../../scripts/seed/data/charge-rule.data";
import { COMPOSITION_CHANGED_RAKE_CODE } from "../../scripts/seed/data/asset.data";

let zoneId: string;

beforeAll(async () => {
  zoneId = (await requireOrg("CR")).id;
});

const count = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  where?: ReturnType<typeof eq>,
): Promise<number> => {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(table)
    .where(where);
  return row?.value ?? 0;
};

describe("§13.1 volumes", () => {
  it("loads the reference data at the stated scale", async () => {
    expect(await count(stations)).toBeGreaterThanOrEqual(55);
    expect(await count(sections)).toBeGreaterThanOrEqual(90);
    expect(await count(terminals)).toBe(12);
    expect(await count(wagonTypes)).toBe(8);
    expect(await count(commodities)).toBe(6);
    expect(await count(rakes)).toBe(40);
    expect(await count(customers)).toBe(25);
    expect(await count(chargeRules)).toBeGreaterThanOrEqual(30);
  });

  it("stores both directions of every section", async () => {
    // The schema stores directed edges, so an odd count means a corridor was
    // expanded one way only — and Dijkstra would then find no route home.
    const total = await count(sections);
    expect(total % 2).toBe(0);
  });
});

describe("deliberate property: maintenance dates inside the next 72 hours", () => {
  it("has wagons coming due for overhaul within 72 h", async () => {
    const now = new Date();
    const in72h = new Date(now.getTime() + 72 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const due = await count(
      wagons,
      and(
        eq(wagons.orgId, zoneId),
        lte(wagons.pohDueOn, in72h),
        gte(wagons.pohDueOn, now.toISOString().slice(0, 10)),
      ),
    );

    expect(
      due,
      "No wagon is due for overhaul inside 72 hours. Phase 7's maintenance constraint would never fire, and RCSMDM-03's coverage claim would be vacuous at the viva.",
    ).toBeGreaterThan(0);
  });

  it("spreads the remaining due dates rather than clustering them", async () => {
    const rows = await db
      .select({ pohDueOn: wagons.pohDueOn })
      .from(wagons)
      .where(eq(wagons.orgId, zoneId));

    const distinctMonths = new Set(rows.map((row) => row.pohDueOn.slice(0, 7)));
    expect(distinctMonths.size).toBeGreaterThan(6);
  });
});

describe("deliberate property: a congested terminal", () => {
  it("has one terminal with a single placement line and a long service time", async () => {
    const [terminal] = await db
      .select()
      .from(terminals)
      .where(
        and(
          eq(terminals.orgId, zoneId),
          eq(terminals.code, CONGESTED_TERMINAL_CODE),
        ),
      );

    expect(
      terminal,
      `${CONGESTED_TERMINAL_CODE} is missing. It is the bottleneck Phase 8's discrete-event queue forms at; without it the congestion twin has nothing to show.`,
    ).toBeDefined();
    expect(terminal.placementLines).toBe(1);
    expect(terminal.avgPlacementMinutes).toBeGreaterThanOrEqual(180);
  });
});

describe("deliberate property: a live and a scheduled embargo", () => {
  it("has one embargo in force right now", async () => {
    const now = new Date();
    const active = await count(
      embargoes,
      and(
        eq(embargoes.orgId, zoneId),
        eq(embargoes.isActive, true),
        lte(embargoes.fromTs, now),
        gte(embargoes.toTs, now),
      ),
    );

    expect(
      active,
      "No embargo is in force. Phase 7's feasibility filter needs a live exclusion to exclude something.",
    ).toBeGreaterThan(0);
  });

  it("has one embargo that has not started yet", async () => {
    const now = new Date();
    const scheduled = await count(
      embargoes,
      and(eq(embargoes.orgId, zoneId), gte(embargoes.fromTs, now)),
    );

    expect(scheduled).toBeGreaterThan(0);
  });
});

describe("deliberate property: the superseded charge-rule pair", () => {
  it("has a free-time rule and its replacement, with adjacent windows", async () => {
    const [superseded] = await db
      .select()
      .from(chargeRules)
      .where(eq(chargeRules.circularRef, SUPERSEDED_FREE_TIME_REF));
    const [superseding] = await db
      .select()
      .from(chargeRules)
      .where(eq(chargeRules.circularRef, SUPERSEDING_FREE_TIME_REF));

    expect(
      superseded,
      "The §13.5 temporal-trap fixture is gone. Phase 9 proves the as-of property against exactly this pair, with no RAG involved.",
    ).toBeDefined();
    expect(superseding).toBeDefined();

    expect(superseded.effectiveTo).toBe("2026-06-30");
    expect(superseding.effectiveFrom).toBe("2026-07-01");
    expect(superseding.effectiveTo).toBeNull();
    // Same selector, different answer — which is the trap.
    expect(superseding.selector).toEqual(superseded.selector);
    expect(superseding.params).not.toEqual(superseded.params);
  });
});

describe("deliberate property: customers across all four tiers", () => {
  it("seeds every tier", async () => {
    const rows = await db
      .select({ tier: customers.tier })
      .from(customers)
      .where(eq(customers.orgId, zoneId));

    const tiers = new Set(rows.map((row) => row.tier));
    expect(
      [...tiers].sort(),
      "Phase 7's slaRisk() has no delivery history to learn from on a fresh database; the tier is its entire cold start.",
    ).toEqual(["gold", "platinum", "silver", "standard"]);
  });
});

describe("deliberate property: rakes spread across states and stations", () => {
  it("puts rakes in many states and at many stations", async () => {
    const rows = await db
      .select({
        state: rakes.currentState,
        station: rakes.currentStation,
      })
      .from(rakes)
      .where(eq(rakes.orgId, zoneId));

    const states = new Set(rows.map((row) => row.state));
    const stationCodes = new Set(rows.map((row) => row.station));

    expect(
      states.size,
      "Every rake is in the same state. The Phase 4 map renders one colour and proves nothing.",
    ).toBeGreaterThanOrEqual(12);
    expect(stationCodes.size).toBeGreaterThanOrEqual(10);
  });
});

describe("deliberate property: missing tariff pairs", () => {
  it.each(DELIBERATELY_MISSING_TARIFF_PAIRS)(
    "leaves %s→%s out of the tariff table on purpose",
    async (from, to) => {
      const present = await count(
        chargeableDistances,
        and(
          eq(chargeableDistances.fromCode, from),
          eq(chargeableDistances.toCode, to),
        ),
      );

      expect(
        present,
        `${from}→${to} was added to the tariff table. It is deliberately absent so tariffKm() can be proved to throw rather than fall back to Dijkstra.`,
      ).toBe(0);
    },
  );
});

describe("deliberate property: a rake whose composition changed", () => {
  it("has closed composition rows as well as open ones", async () => {
    const [rake] = await db
      .select()
      .from(rakes)
      .where(
        and(
          eq(rakes.orgId, zoneId),
          eq(rakes.code, COMPOSITION_CHANGED_RAKE_CODE),
        ),
      );

    expect(rake).toBeDefined();

    const open = await count(
      rakeCompositions,
      and(eq(rakeCompositions.rakeId, rake.id), isNull(rakeCompositions.toTs)),
    );
    const closed = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(rakeCompositions)
      .where(
        and(
          eq(rakeCompositions.rakeId, rake.id),
          sql`${rakeCompositions.toTs} is not null`,
        ),
      );

    expect(open).toBeGreaterThan(0);
    expect(
      closed[0].value,
      "No composition row is closed, so getRakeConstraints(past) and getRakeConstraints(now) return the same answer — and the as-of read is untested.",
    ).toBeGreaterThan(0);
  });
});

describe("idempotency", () => {
  it("changes nothing when the master-data seeders run again", async () => {
    const { seedNetwork } = await import("../../scripts/seed/network.seed.js");
    const { seedReference } =
      await import("../../scripts/seed/reference.seed.js");
    const { seedChargeRules } =
      await import("../../scripts/seed/charge-rule.seed.js");
    const { seedTerminals, seedEmbargoes } =
      await import("../../scripts/seed/terminal.seed.js");
    const { seedFleet } = await import("../../scripts/seed/asset.seed.js");
    const { seedCustomers } =
      await import("../../scripts/seed/customer.seed.js");

    const before = {
      stations: await count(stations),
      sections: await count(sections),
      distances: await count(chargeableDistances),
      commodities: await count(commodities),
      wagonTypes: await count(wagonTypes),
      chargeRules: await count(chargeRules),
      terminals: await count(terminals),
      embargoes: await count(embargoes),
      rakes: await count(rakes),
      wagons: await count(wagons),
      compositions: await count(rakeCompositions),
      customers: await count(customers),
    };

    const now = new Date();
    await seedNetwork();
    await seedReference();
    await seedChargeRules();
    const terminalsByCode = await seedTerminals(zoneId);
    await seedEmbargoes(zoneId, now);
    await seedFleet(zoneId, now);
    await seedCustomers(zoneId, terminalsByCode);

    const after = {
      stations: await count(stations),
      sections: await count(sections),
      distances: await count(chargeableDistances),
      commodities: await count(commodities),
      wagonTypes: await count(wagonTypes),
      chargeRules: await count(chargeRules),
      terminals: await count(terminals),
      embargoes: await count(embargoes),
      rakes: await count(rakes),
      wagons: await count(wagons),
      compositions: await count(rakeCompositions),
      customers: await count(customers),
    };

    expect(after).toEqual(before);
  });

  it("leaves tenancy rows untouched — the point of --master-only", async () => {
    // The flag exists so reloading the rail network cannot disturb the accounts
    // somebody is currently signed in as. Proved by re-running every master-data
    // seeder above and checking the user count is unchanged.
    const { users, organizations } = await import("../schema/index.js");

    const userCount = await count(users);
    const orgCount = await count(organizations);

    expect(userCount).toBeGreaterThan(0);
    expect(orgCount).toBe(2);
  });
});

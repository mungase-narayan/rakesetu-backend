/**
 * `lookupRule` — the suite the phase calls "the important one".
 *
 * Everything here is a property of the temporal story: the same question asked
 * with two different `asOf` values must return two different rules, an expired
 * rule must never come back, specificity must beat generality, and a genuine tie
 * must throw rather than be resolved by whichever row Postgres returned first.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import ChargeRuleService from "./charge-rule.service";
import { db } from "../../../database/connection";
import { chargeRules } from "../../../schema";
import {
  SUPERSEDED_FREE_TIME_REF,
  SUPERSEDING_FREE_TIME_REF,
} from "../../../../scripts/seed/data/charge-rule.data";
import type { RuleSelectorInput } from "../../../types/selector.types";

const service = new ChargeRuleService();

/** Mechanised cement at a private siding — the seeded temporal fixture. */
const CEMENT_AT_SIDING: RuleSelectorInput = {
  commodityGroup: "cement",
  terminalType: "private_siding",
  handlingMode: "mechanised",
};

describe("lookupRule — the asOf property", () => {
  it("returns different rules for the same selector on either side of a supersession", async () => {
    const march = await service.lookupRule(
      "free_time",
      CEMENT_AT_SIDING,
      "2026-03-01",
    );
    const september = await service.lookupRule(
      "free_time",
      CEMENT_AT_SIDING,
      "2026-09-01",
    );

    expect(march.circularRef).toBe(SUPERSEDED_FREE_TIME_REF);
    expect(september.circularRef).toBe(SUPERSEDING_FREE_TIME_REF);
    expect(march.id).not.toBe(september.id);
    expect(march.params).toEqual({ hours: 9 });
    expect(september.params).toEqual({ hours: 7 });
  });

  it("never returns a rule whose effective_to has passed", async () => {
    // The Jan–Jun rule is invisible in September, no matter how specific it is.
    const candidates = await service.lookupRules(
      "free_time",
      CEMENT_AT_SIDING,
      "2026-09-01",
    );

    expect(
      candidates.map((candidate) => candidate.rule.circularRef),
    ).not.toContain(SUPERSEDED_FREE_TIME_REF);
  });

  it("returns nothing for a date before any rule was in force", async () => {
    await expect(
      service.lookupRule("free_time", CEMENT_AT_SIDING, "2020-01-01"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("lookupRule — tie-breaking", () => {
  it("prefers the more specific rule over the zone-wide default", async () => {
    // The default `{ v: 1 }` rule matches everything at 11 hours. The cement
    // rule names three dimensions, so it wins — which is what makes a "default"
    // behave like one.
    const winner = await service.lookupRule(
      "free_time",
      CEMENT_AT_SIDING,
      "2026-09-01",
    );

    expect(winner.params).toEqual({ hours: 7 });

    const unnamed = await service.lookupRule(
      "free_time",
      { commodityGroup: "container" },
      "2026-09-01",
    );
    expect(unnamed.params).toEqual({ hours: 11 });
  });

  it("breaks an equal-specificity tie on the higher version", async () => {
    // Two Solapur/mixed rules share a window and a selector; only the version
    // separates them.
    const winner = await service.lookupRule(
      "free_time",
      { division: "Solapur", handlingMode: "mixed" },
      "2026-09-01",
    );

    expect(winner.version).toBe(2);
    expect(winner.circularRef).toBe("ZI-SUR-02/2025 rev.2");
  });

  it("does not match a rule whose dimension the query left unanswered", async () => {
    // A rule that restricts `commodityGroups` is not a rule about "any
    // commodity" — a query that does not say which cannot satisfy it.
    const candidates = await service.lookupRules(
      "free_time",
      { terminalType: "private_siding" },
      "2026-09-01",
    );

    for (const candidate of candidates) {
      expect(candidate.rule.selector.commodityGroups).toBeUndefined();
    }
  });
});

describe("lookupRule — genuine ambiguity", () => {
  it("throws rather than choosing between two identical-authority rules", async () => {
    // Created here rather than seeded: a contradictory rule book is a data bug,
    // and shipping one in the seed would mean every developer's first run has a
    // broken rule in it. The property still has to be proved, so the test makes
    // the contradiction, asserts the refusal, and removes it again.
    const shared = {
      type: "wharfage" as const,
      params: { ratePerTonneHour: 3, freeHours: 4 },
      selector: {
        v: 1 as const,
        commodityGroups: ["fertiliser" as const],
        divisions: ["Pune"],
      },
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      version: 1,
    };

    const first = await service.create({ ...shared, circularRef: "AMBIG-A" });
    const second = await service.create({ ...shared, circularRef: "AMBIG-B" });

    try {
      await expect(
        service.lookupRule(
          "wharfage",
          { commodityGroup: "fertiliser", division: "Pune" },
          "2026-06-01",
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      // `resolve` does not throw — it reports the tie, which is what makes the
      // data bug findable rather than merely fatal.
      const resolution = await service.resolve(
        "wharfage",
        { commodityGroup: "fertiliser", division: "Pune" },
        "2026-06-01",
      );
      expect(resolution.ambiguity?.rules).toHaveLength(2);
    } finally {
      await db.delete(chargeRules).where(eq(chargeRules.id, first.id));
      await db.delete(chargeRules).where(eq(chargeRules.id, second.id));
    }
  });
});

describe("resolve — the debugging tool", () => {
  it("names the winner and why each loser lost", async () => {
    const resolution = await service.resolve(
      "free_time",
      CEMENT_AT_SIDING,
      "2026-09-01",
    );

    expect(resolution.winner?.rule.circularRef).toBe(SUPERSEDING_FREE_TIME_REF);
    expect(resolution.rejected.length).toBeGreaterThan(0);

    // The expired half of the supersession is the single most useful thing this
    // endpoint reports, so it must appear with an out-of-window reason rather
    // than silently vanishing.
    const expired = resolution.rejected.find(
      (entry) => entry.rule.circularRef === SUPERSEDED_FREE_TIME_REF,
    );
    expect(expired?.reason.kind).toBe("out_of_window");
    expect(expired?.reason.detail).toContain("2026-06-30");

    const mismatched = resolution.rejected.find(
      (entry) => entry.reason.kind === "selector_mismatch",
    );
    expect(mismatched?.reason.detail).toMatch(/rule restricts/);
  });

  it("reports the losing default as less specific, not as a mismatch", async () => {
    const resolution = await service.resolve(
      "free_time",
      CEMENT_AT_SIDING,
      "2026-09-01",
    );

    const zoneDefault = resolution.rejected.find(
      (entry) =>
        entry.rule.circularRef === "GT-45/II" && entry.rule.clauseRef === "3.1",
    );
    expect(zoneDefault?.reason.kind).toBe("less_specific");
  });
});

describe("the shape of the service itself", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "charge-rule.service.ts"),
    "utf8",
  );

  it("offers no lookupCurrentRule", () => {
    // Not offering the convenience is the mechanism that stops "current" from
    // leaking into a 2031 re-derivation of a 2026 bill. If this ever fails,
    // read §5.6 before deleting the test.
    // Matches a declaration or a call, not the header comment that explains
    // why there is none — the comment is the documentation this test enforces.
    expect(source).not.toMatch(/^\s*(async\s+)?lookupCurrentRule\s*\(/m);
    expect(source).not.toMatch(/\.lookupCurrentRule\(/);
  });

  it("filters dates in SQL, never with a JS .filter()", () => {
    // A post-fetch date filter is correct until the table grows past one page,
    // and then it is silently wrong.
    const dateFilteringInJs =
      /\.filter\([^)]*(effectiveFrom|effectiveTo|asOf)/.test(source);
    expect(dateFilteringInJs).toBe(false);
    expect(source).toMatch(/lte\(chargeRules\.effectiveFrom/);
    expect(source).toMatch(/isNull\(chargeRules\.effectiveTo\)/);
  });
});

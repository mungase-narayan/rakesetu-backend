/**
 * The embargo scope contract — **DECISIONS D8**.
 *
 * Phase 7 writes the feasibility filter that consumes this; the shape and its
 * semantics are frozen here, so that phase inherits a contract rather than
 * inventing one. Pure functions, no database.
 */
import { describe, expect, it } from "vitest";

import {
  assertScopeVersion,
  describeScope,
  matchesScope,
} from "./embargo-scope";
import type { EmbargoScope } from "../../../types/selector.types";

const cementAtKwv = {
  stationCodes: ["KWV"],
  commodityCode: "CEM",
  wagonTypeCode: "BOXNHL",
  division: "Solapur",
};

describe("matchesScope — the omitted-key rule", () => {
  it("matches everything when no dimension is named", () => {
    // `{ v: 1 }` is a total stop. Legitimate, and the reason the create form
    // shows a plain-English preview before saving.
    expect(matchesScope({ v: 1 }, cementAtKwv)).toBe(true);
    expect(
      matchesScope({ v: 1 }, { commodityCode: "COAL", division: "Nagpur" }),
    ).toBe(true);
  });

  it("ORs the values within one key", () => {
    const scope: EmbargoScope = { v: 1, commodityCodes: ["CEM", "STL"] };

    expect(matchesScope(scope, cementAtKwv)).toBe(true);
    expect(matchesScope(scope, { commodityCode: "STL" })).toBe(true);
    expect(matchesScope(scope, { commodityCode: "COAL" })).toBe(false);
  });

  it("ANDs across keys", () => {
    const scope: EmbargoScope = {
      v: 1,
      commodityCodes: ["CEM"],
      wagonTypeCodes: ["BOXNHL"],
    };

    expect(matchesScope(scope, cementAtKwv)).toBe(true);
    // Right commodity, wrong wagon: both keys must be satisfied.
    expect(
      matchesScope(scope, { commodityCode: "CEM", wagonTypeCode: "BCNA" }),
    ).toBe(false);
  });

  it("matches a section only when the movement traverses it", () => {
    const scope: EmbargoScope = {
      v: 1,
      sections: [{ from: "WRR", to: "PLO" }],
    };

    expect(
      matchesScope(scope, { sections: [{ from: "WRR", to: "PLO" }] }),
    ).toBe(true);
    // Direction matters: sections are directed rows, and a block on the up line
    // is not a block on the down line.
    expect(
      matchesScope(scope, { sections: [{ from: "PLO", to: "WRR" }] }),
    ).toBe(false);
  });

  it("throws on a version it does not understand", () => {
    // Silently treating an unparseable embargo as "matches nothing" would route
    // a rake straight through a blocked section.
    expect(() =>
      matchesScope({ v: 2 } as unknown as EmbargoScope, cementAtKwv),
    ).toThrow(/Unsupported embargo scope version/);
    expect(() => assertScopeVersion({ v: 1 })).not.toThrow();
  });
});

describe("describeScope", () => {
  it("reads back the dimensions a scope names", () => {
    const summary = describeScope({
      v: 1,
      commodityCodes: ["CEM"],
      wagonTypeCodes: ["BOXNHL"],
      stations: ["KWV"],
    });

    expect(summary).toContain("CEM");
    expect(summary).toContain("BOXNHL wagons");
    expect(summary).toContain("through KWV");
  });

  it("says so, in words, when a scope restricts nothing", () => {
    // The empty form produces this. It has to read as the total stop it is.
    expect(describeScope({ v: 1 })).toContain("all traffic, everywhere");
  });

  it("joins several values with 'and'", () => {
    expect(describeScope({ v: 1, commodityCodes: ["CEM", "STL"] })).toContain(
      "CEM and STL",
    );
  });
});

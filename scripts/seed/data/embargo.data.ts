/**
 * Two embargoes: one **in force right now** and one **scheduled**.
 *
 * Phase 7's feasibility filter needs a live exclusion to exclude something, and
 * the scheduled one exists so the controller screen has both states to render —
 * "active" and "starts on Tuesday" look different and are reasoned about
 * differently.
 *
 * Windows are relative to the seed run, because an embargo with a hard-coded
 * 2026 window stops being "active" the moment the calendar moves past it, and
 * then the demo quietly has no live exclusion at all.
 */
import type { EmbargoScope } from "../../../src/types/selector.types";

export interface EmbargoSeed {
  scope: EmbargoScope;
  fromDaysFromNow: number;
  toDaysFromNow: number;
  reason: string;
  circularRef: string;
}

export const EMBARGOES: EmbargoSeed[] = [
  {
    // Active: started three days ago, runs for another eight.
    scope: {
      v: 1,
      commodityCodes: ["CEM"],
      wagonTypeCodes: ["BOXNHL"],
      stations: ["KWV"],
    },
    fromDaysFromNow: -3,
    toDaysFromNow: 8,
    reason:
      "Goods shed reconstruction at Kurduvadi — no open-wagon cement loading until the new apron is commissioned.",
    circularRef: "EMB-SUR-17/2026",
  },
  {
    // Scheduled: starts in twelve days.
    scope: {
      v: 1,
      sections: [{ from: "WRR", to: "PLO" }],
      divisions: ["Nagpur"],
    },
    fromDaysFromNow: 12,
    toDaysFromNow: 26,
    reason:
      "Third-line connection work between Wardha and Pulgaon — traffic block on the up line.",
    circularRef: "EMB-NGP-04/2026",
  },
];

/**
 * ETA module barrel — the deterministic Tier 1 engine of DESIGN.md §5.4.
 *
 * Phase 8 adds Tier 2 (statistical bands) beside this, not inside it: the
 * deterministic point estimate stays the thing the solver optimises against and
 * the thing that answers when there is no cohort to draw a band from.
 */
export { default as etaRouter } from "./routes/eta.routes";
export { default as EtaLookupService } from "./services/eta-lookup.service";
export { default as SectionWeightService } from "./services/section-weight.service";
export { estimateEta, NoRouteError } from "./services/eta.service";
export * from "./constants/eta.constants";
export type * from "./types/eta.types";

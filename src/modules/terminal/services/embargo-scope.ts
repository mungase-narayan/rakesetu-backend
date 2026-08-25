/**
 * The embargo `scope` contract, as code (**DECISIONS D8**).
 *
 * Pure functions, no I/O — the same rule DESIGN.md §5 applies to the engines,
 * for the same reason: Phase 7's feasibility filter will call `matchesScope`
 * inside a loop over every rake × indent pair, and it has to be testable against
 * a hand-built scope with no database anywhere near it.
 *
 * The rule, restated once here because everything below is an expression of it:
 *
 * > **An omitted key means "no restriction on that dimension". Present keys are
 * > AND-ed. Values within one key are OR-ed.**
 */
import ApiError from "../../../utils/api-error";
import {
  SELECTOR_VERSION,
  type EmbargoScope,
  type SectionRef,
} from "../../../types/selector.types";

/** What a candidate movement offers up to be matched against a scope. */
export interface EmbargoCandidate {
  stationCodes?: string[];
  sections?: SectionRef[];
  commodityCode?: string;
  wagonTypeCode?: string;
  terminalId?: string;
  division?: string;
}

/**
 * Rejects a scope this build does not understand.
 *
 * Throwing rather than ignoring is the important half: an embargo whose version
 * cannot be parsed is a restriction nobody is enforcing, and silently treating
 * it as "matches nothing" routes rakes straight through a blocked section.
 */
export const assertScopeVersion = (scope: EmbargoScope): void => {
  if (scope.v !== SELECTOR_VERSION) {
    throw new ApiError(
      422,
      `Unsupported embargo scope version ${String(scope.v)} — this build understands v${SELECTOR_VERSION}`,
    );
  }
};

const overlaps = (
  allowed: readonly string[] | undefined,
  candidates: readonly (string | undefined)[],
): boolean => {
  // Omitted key: no restriction on this dimension. Matches by definition.
  if (!allowed || allowed.length === 0) return true;
  return candidates.some(
    (candidate) => candidate !== undefined && allowed.includes(candidate),
  );
};

const sameSection = (a: SectionRef, b: SectionRef): boolean =>
  a.from === b.from && a.to === b.to;

/**
 * Does this embargo apply to this movement?
 *
 * The matcher proper lands in Phase 7, which will call it over the solver's
 * candidate matrix. It is written here because the *contract* is settled here,
 * and a shape with no reference implementation is a shape two phases will read
 * differently.
 */
export const matchesScope = (
  scope: EmbargoScope,
  candidate: EmbargoCandidate,
): boolean => {
  assertScopeVersion(scope);

  if (!overlaps(scope.stations, candidate.stationCodes ?? [])) return false;
  if (!overlaps(scope.commodityCodes, [candidate.commodityCode])) return false;
  if (!overlaps(scope.wagonTypeCodes, [candidate.wagonTypeCode])) return false;
  if (!overlaps(scope.terminalIds, [candidate.terminalId])) return false;
  if (!overlaps(scope.divisions, [candidate.division])) return false;

  if (scope.sections && scope.sections.length > 0) {
    const traversed = candidate.sections ?? [];
    const hit = scope.sections.some((blocked) =>
      traversed.some((used) => sameSection(blocked, used)),
    );
    if (!hit) return false;
  }

  return true;
};

const list = (values: readonly string[]): string =>
  values.length === 1
    ? values[0]
    : `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;

/**
 * The plain-English sentence the controller screen shows.
 *
 * Server-side rather than in the SPA, and the create form asks for it through
 * `POST /embargoes/preview`, so there is exactly one implementation of "what
 * does this scope mean". A wrong `scope` makes the Phase 7 solver quietly
 * infeasible; the sentence is the only place a human catches it beforehand, so
 * it must not be able to drift from the matcher above.
 */
export const describeScope = (scope: EmbargoScope): string => {
  const clauses: string[] = [];

  if (scope.commodityCodes?.length) {
    clauses.push(list(scope.commodityCodes));
  }
  if (scope.wagonTypeCodes?.length) {
    clauses.push(`in ${list(scope.wagonTypeCodes)} wagons`);
  }
  if (scope.stations?.length) {
    clauses.push(`through ${list(scope.stations)}`);
  }
  if (scope.sections?.length) {
    clauses.push(
      `over ${list(scope.sections.map((section) => `${section.from}→${section.to}`))}`,
    );
  }
  if (scope.terminalIds?.length) {
    const count = scope.terminalIds.length;
    clauses.push(`at ${count} terminal${count === 1 ? "" : "s"}`);
  }
  if (scope.divisions?.length) {
    clauses.push(`in ${list(scope.divisions)} division`);
  }

  // Every key omitted. Legitimate — a total stop — but it must read as one,
  // because it is also what an empty form produces.
  if (clauses.length === 0) {
    return "This embargo blocks: all traffic, everywhere (no dimension was restricted)";
  }

  return `This embargo blocks: ${clauses.join(" ")}`;
};

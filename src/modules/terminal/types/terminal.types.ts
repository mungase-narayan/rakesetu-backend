/**
 * Terminal module type contracts.
 */
import type {
  CommodityGroup,
  Embargo,
  HandlingMode,
  NewEmbargo,
  NewTerminal,
  RakeEventType,
  RakeState,
  Terminal,
  TerminalType,
} from "../../../schema";
import type { PaginateOptions } from "../../../types/pagination.types";

export type { Terminal, NewTerminal, Embargo, NewEmbargo };

export interface IListTerminalsQuery extends Partial<PaginateOptions> {
  search?: string;
  type?: TerminalType;
  stationCode?: string;
  commodityGroup?: CommodityGroup;
  isActive?: boolean;
}

export interface IListEmbargoesQuery extends Partial<PaginateOptions> {
  /** In force at this instant — `from_ts <= activeAt <= to_ts`. */
  activeAt?: Date;
  station?: string;
  commodity?: string;
  isActive?: boolean;
}

/** An embargo as the API returns it: the row plus its plain-English reading. */
export interface EmbargoWithSummary extends Embargo {
  summary: string;
}

// ---------------------------------------------------------------------------
// Phase 5 — the supervisor's board and quick entry.
// ---------------------------------------------------------------------------

/**
 * Which free-time rule answered, and **on what date it was asked**.
 *
 * `resolvedAsOf` is on the wire rather than implied because the whole claim the
 * board makes is that it resolved at the placement, not at now. A screen that
 * can render the date is a screen a supervisor can check, and Phase 9's charge
 * explainer shows the same three fields for the same reason.
 */
export interface FreeTimeResolution {
  /** Null when the rule book has no rule for this selector — not an error here. */
  hours: number | null;
  circularRef: string | null;
  clauseRef: string | null;
  effectiveFrom: string | null;
  resolvedAsOf: string;
}

export interface BoardTerminal {
  id: string;
  code: string;
  name: string;
  type: TerminalType;
  handlingMode: HandlingMode;
  placementLines: number;
  isMechanised: boolean;
  stationCode: string;
  stationName: string;
  division: string;
  commodityGroups: CommodityGroup[];
}

/** A rake standing on one of this terminal's lines. */
export interface BoardOnHand {
  rakeId: string;
  code: string;
  wagonTypeCode: string;
  wagonCount: number;
  state: RakeState;
  previousState: RakeState | null;
  stateGroup: "empty" | "moving" | "at_terminal" | "exception";
  since: string;
  hoursInState: number;
  cycleId: string | null;
  commodityGroup: CommodityGroup | null;
  lineNumber: string | null;
  /** When it was placed. Null when no placement is on record at this terminal. */
  placedAt: string | null;
  hoursOnHand: number | null;
  freeTime: FreeTimeResolution;
  /** Negative while inside the free time. Null when either input is unknown. */
  hoursOverFree: number | null;
  status: "ok" | "approaching" | "over" | "unknown";
}

/** A rake on its way here, with the estimate and how much of it is measured. */
export interface BoardInbound {
  rakeId: string;
  code: string;
  wagonTypeCode: string;
  state: RakeState;
  fromCode: string;
  arrivalAt: string;
  totalMinutes: number;
  totalKm: number;
  legs: number;
  confidence: "low" | "medium" | "high";
  observedShare: number;
  isOverdue: boolean;
}

export interface BoardReleased {
  rakeId: string;
  code: string;
  wagonCount: number;
  eventType: RakeEventType;
  releasedAt: string;
  placedAt: string | null;
  /** Placement to release. **Not a charge** — no free time has been subtracted. */
  detentionHours: number | null;
  cycleId: string | null;
}

export interface TerminalBoard {
  terminal: BoardTerminal;
  asOf: string;
  occupancy: { onHand: number; placementLines: number; ratio: number };
  inbound: BoardInbound[];
  onHand: BoardOnHand[];
  releasedToday: BoardReleased[];
  totals: {
    inbound: number;
    onHand: number;
    releasedToday: number;
    detentionHoursToday: number;
    overFreeTime: number;
  };
}

/**
 * What the quick-entry screen may offer for one rake.
 *
 * **Driven by the transition table, not by the screen.** The buttons are built
 * from `legal`, so an illegal option is never rendered — and when the table
 * changes, the UI changes with it rather than drifting into offering an event
 * the API will refuse.
 */
export interface NextEvents {
  rakeId: string;
  code: string;
  state: RakeState;
  previousState: RakeState | null;
  since: string;
  hoursInState: number;
  terminalId: string | null;
  /** Everything the state machine permits from here, exception entries included. */
  legal: RakeEventType[];
  /** The happy-path step — the primary button. Null in an exception state. */
  primary: RakeEventType | null;
  /** The events that clear an exception this rake is currently in. */
  clearing: RakeEventType[];
}

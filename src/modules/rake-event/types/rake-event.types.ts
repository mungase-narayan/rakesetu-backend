/**
 * Wire and service types for the event spine.
 */
import type {
  EventSource,
  RakeCycle,
  RakeEvent,
  RakeEventType,
  RakeState,
  RakeStateRow,
} from "../../../schema";
import type { RakeEventPayload } from "../../../types/event-payload.types";
import type { PaginateOptions } from "../../../types/pagination.types";

export type { RakeEventPayload };

/** One event as it arrives at `applyEvent` — before any of it is trusted. */
export interface ApplyEventInput {
  rakeId: string;
  eventType: RakeEventType;
  occurredAt: Date;
  stationCode?: string | null;
  terminalId?: string | null;
  payload?: RakeEventPayload;
  source: EventSource;
  sourceRef?: string | null;
  recordedBy?: string | null;
  /** Globally unique. Enforced by `rake_event_keys`, not by the caller. */
  idempotencyKey: string;
  correctsEventId?: string | null;
  correlationId?: string | null;
  /**
   * Present only when the caller has explicitly asked to write into a **closed**
   * cycle. Without it that write is a 409: a completed turnaround is immutable,
   * and Phase 8 will have computed a TAT from it.
   */
  reopenReason?: string | null;
}

export interface ApplyResult {
  event: RakeEvent;
  projection: RakeStateRow;
  cycle: RakeCycle | null;
  /** True when the event's `occurred_at` preceded the projection's last event. */
  wasLate: boolean;
  /** True when a late event forced the cycle to be re-folded. */
  reprojected: boolean;
}

/** What `POST /reproject` answers — §13.2's determinism check as an endpoint. */
export interface ReprojectResult {
  rakeId: string;
  changed: boolean;
  /** Field-by-field, only where the rebuilt projection differs from the stored one. */
  diff: Record<string, { stored: unknown; rebuilt: unknown }>;
  eventCount: number;
  cycleCount: number;
  /**
   * Events the re-fold refused and quarantined as anomalies. Empty on a healthy
   * log — a non-empty list means the incremental apply had accepted something
   * the ordered history does not support.
   */
  rejectedEventIds: string[];
}

export interface IListEventsQuery extends PaginateOptions {
  from?: Date;
  to?: Date;
  eventType?: RakeEventType;
  /** Rejected attempts are hidden unless asked for — they are not history. */
  includeRejected?: boolean;
}

export interface IListAnomaliesQuery extends PaginateOptions {
  from?: Date;
  to?: Date;
  rakeId?: string;
}

export interface IListCyclesQuery extends PaginateOptions {
  isClosed?: boolean;
}

/** One rake on the map feed. */
export interface LiveRake {
  rakeId: string;
  code: string;
  wagonTypeCode: string;
  wagonCount: number;
  homeDivision: string;
  state: RakeState;
  previousState: RakeState | null;
  stateGroup: "empty" | "moving" | "at_terminal" | "exception";
  since: string;
  hoursInState: number;
  stationCode: string | null;
  stationName: string | null;
  /** Null when the rake's station has no coordinates — the map skips it. */
  lat: number | null;
  lng: number | null;
  terminalId: string | null;
  cycleId: string | null;
  lastEventAt: string | null;
  isDirty: boolean;
}

export interface LiveTerminal {
  id: string;
  code: string;
  name: string;
  stationCode: string;
  lat: number;
  lng: number;
  placementLines: number;
  isMechanised: boolean;
}

export interface NetworkLive {
  /** Server time, so the "last updated" label is not the browser's opinion. */
  asOf: string;
  rakes: LiveRake[];
  terminals: LiveTerminal[];
  counts: Record<string, number>;
}

/** One section, with how much traffic it carried and where to draw it. */
export interface SectionLoadRow {
  sectionId: string;
  fromCode: string;
  toCode: string;
  distanceKm: number;
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  /** `SECTION_PASSED` events in the window. Zero is a real answer. */
  traversals: number;
}

export interface SectionLoad {
  asOf: string;
  windowHours: number;
  /** The busiest section, so line widths scale against the whole network. */
  maxTraversals: number;
  sections: SectionLoadRow[];
}

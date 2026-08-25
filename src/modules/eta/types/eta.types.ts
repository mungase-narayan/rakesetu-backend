/**
 * ETA module contracts (DESIGN.md §5.4, Tier 1).
 *
 * The one type worth reading carefully is `EtaResult.confidence`. It is a
 * **coverage label**, not a statistic, and the distinction is the difference
 * between a defensible estimate and a fabricated one — see the field's own
 * comment and §2 of the phase document.
 */
import type { NetworkGraph } from "../../network/services/graph";
import type { HourBand } from "../constants/eta.constants";

export type { HourBand };

/** Where one section's minutes came from. */
export type WeightSource = "observed" | "nominal" | "blended";

/** One cell of the weight table: a section, in a wagon type, in an hour band. */
export interface SectionWeight {
  sectionId: string;
  band: HourBand;
  /** Minutes to traverse. Always positive — a zero-minute section is a bug. */
  minutes: number;
  source: WeightSource;
  /** Traversals behind `minutes`. Zero means the timetable answered. */
  samples: number;
  /** `distance_km / nominal_speed_kmph × 60`. Kept so the blend is auditable. */
  nominalMinutes: number;
  /** The median of the observations, before blending. Null when there are none. */
  observedMedianMinutes: number | null;
}

/**
 * Keyed by `weightKey(sectionId, band)`.
 *
 * Holds **only cells with at least one observation**. A section the fleet has
 * never crossed is absent, and the estimator falls back to the graph edge's
 * nominal speed — which keeps the cached payload proportional to what has
 * actually been observed rather than to `sections × 4`.
 */
export type SectionWeightMap = Map<string, SectionWeight>;

/** One leg of an estimate, with the provenance of its number. */
export interface EtaLeg {
  sectionId: string;
  fromCode: string;
  toCode: string;
  distanceKm: number;
  minutes: number;
  source: WeightSource;
  samples: number;
  /** The band the rake **enters** this section in. */
  band: HourBand;
  /** Cumulative minutes from the departure point to the far end of this leg. */
  elapsedMinutes: number;
}

export interface EtaInput {
  fromCode: string;
  toCode: string;
  departAt: Date;
  wagonTypeCode: string;
  graph: NetworkGraph;
  weights: SectionWeightMap;
}

export interface EtaResult {
  fromCode: string;
  toCode: string;
  departAt: Date;
  arrivalAt: Date;
  totalMinutes: number;
  totalKm: number;
  path: EtaLeg[];
  /**
   * **A coverage label, not a probability.**
   *
   * `high` when at least 80% of the estimate's minutes rest on observed
   * running, `low` under 40%. It answers "how much of this is history and how
   * much is the timetable", which is a question this phase can answer honestly.
   * It does **not** answer "how likely is this time", which needs the residual
   * model Phase 8 builds — and the UI must never render it as if it did.
   */
  confidence: "low" | "medium" | "high";
  /** The share behind the label, 0–1. Exposed so the UI can say why. */
  observedShare: number;
  wagonTypeCode: string;
}

/** Why there is no estimate. Never a fabricated time — see §3.3. */
export type EtaUnavailableReason =
  "not_in_transit" | "no_position" | "no_destination" | "no_route" | "no_cycle";

export interface EtaUnavailable {
  eta: null;
  reason: EtaUnavailableReason;
  /** A sentence a screen can render verbatim. */
  detail: string;
}

/** An estimate for a specific rake, with the identity a screen needs. */
export interface RakeEta {
  eta: EtaResult;
  rakeId: string;
  rakeCode: string;
  state: string;
  /** The named destination and how it was learnt. */
  destinationStationCode: string;
  destinationName: string | null;
  destinationTerminalId: string | null;
  /** True when `arrivalAt` is already in the past. */
  isOverdue: boolean;
}

export type RakeEtaAnswer = RakeEta | EtaUnavailable;

export const isUnavailable = (
  answer: RakeEtaAnswer,
): answer is EtaUnavailable => answer.eta === null;

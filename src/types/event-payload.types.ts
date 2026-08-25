/**
 * The shapes `rake_events.payload` can hold, discriminated on `event_type`.
 *
 * Lives in `src/types` rather than in the rake-event module for the same reason
 * `selector.types.ts` does: `schema/rake-event.schema.ts` needs the union to
 * type the `jsonb` column, and a schema file importing from a feature module
 * would invert the dependency every other table respects.
 *
 * The column is `jsonb` and not a set of nullable columns on purpose. Fourteen
 * of the twenty-four event types carry nothing; three carry a weight; one
 * carries a section triple. Flattening that into columns produces a table that
 * is mostly NULL and a migration every time a payload gains a field — and the
 * fields are *evidence about one event*, never something a query filters a
 * whole fleet by.
 */

/** Nothing to say beyond "it happened". Most events. */
export type EmptyPayload = Record<string, never>;

/**
 * Where a rake has been told to go.
 *
 * **Phase 5's correction to the event vocabulary.** §5.4 asks for an ETA "from
 * the current position to the current destination", and until this was added
 * nothing in the log said where a moving rake was headed: the loading terminal
 * first appears on `PLACED_FOR_LOADING`, which is the event that fires when the
 * rake has already arrived. An engine that has to wait for arrival to predict
 * arrival is not an engine.
 *
 * It rides on the three events that genuinely carry an intention — the
 * allotment, the release against a railway receipt, and the departure of an
 * empty return — rather than on a column, because it is a *statement made at
 * that moment* and not a property of the rake. Phase 6 supersedes the values
 * with the indent's and the consignment's, and the shape does not change.
 *
 * Both fields are optional: a history simulated before this existed is still
 * valid history, and `etaForRake` answers `no_destination` for it rather than
 * inventing a terminal.
 */
export interface DestinationPayload {
  /** Where the rake is bound. A `stations.code`. */
  toStationCode?: string;
  /** The terminal at that station, when the destination is one. */
  toTerminalId?: string;
}

export interface AllottedPayload extends DestinationPayload {
  /** Null until Phase 6 — the solver has nothing to point at before indents exist. */
  indentId?: string | null;
  solverRunId?: string | null;
}

export interface PlacedForLoadingPayload {
  lineNumber?: string;
  /** Free text: the siding staff's own name for whoever placed it. */
  placedBy?: string;
}

export interface LoadingCompletePayload {
  netWeightT: number;
  wagonsLoaded: number;
  /**
   * What is in the wagons.
   *
   * **Phase 5 needs this and Phase 6 owns it.** `rake_cycles.commodity_code`
   * exists and is documented as Phase 6's, filled from the indent — but until
   * an indent exists, nothing tells the cycle what it is carrying, and
   * `freeTime()` is scoped by commodity group. Without it every placement
   * resolves the zone-wide default rule, and the terminal board silently gives
   * cement and coal the same free hours. So the loading events carry it, the
   * projector files it, and Phase 6 supersedes the value with the indent's
   * without changing the shape.
   */
  commodityCode?: string;
}

export interface LoadedReleasedPayload extends DestinationPayload {
  netWeightT: number;
  /** Phase 6 fills this when the state machine issues the railway receipt. */
  rrNumber?: string;
  /** See `LoadingCompletePayload.commodityCode`. */
  commodityCode?: string;
}

/** `DEPARTED_EMPTY_RETURN` — the empty haul home names where home is. */
export type EmptyReturnPayload = DestinationPayload;

export interface SectionPassedPayload {
  fromCode: string;
  toCode: string;
  sectionId: string;
}

export interface DetainedPayload {
  reasonCode: string;
  note?: string;
}

/**
 * §5.1's corrective event.
 *
 * `fields` is what the corrected event *should have said*. Applying it is
 * re-projection, not an UPDATE — the row named by `correctsEventId` is never
 * touched, which is the property that makes the log admissible evidence in a
 * demurrage dispute.
 */
export interface CorrectionPayload {
  correctsEventId: string;
  reason: string;
  fields: Record<string, unknown>;
}

export type RakeEventPayload =
  | EmptyPayload
  | DestinationPayload
  | AllottedPayload
  | PlacedForLoadingPayload
  | LoadingCompletePayload
  | LoadedReleasedPayload
  | SectionPassedPayload
  | DetainedPayload
  | CorrectionPayload;

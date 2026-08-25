/**
 * The `EventSource` seam (DESIGN.md §3, §14).
 *
 * RakeSetu has no live FOIS feed and will not get one. §14 asks for that to be
 * presented as a design decision rather than a compromise, and this interface
 * is what makes the claim true instead of rhetorical: the product ingests
 * events from *an adapter*, the synthetic one is the adapter that exists, and a
 * real FOIS reader is a file that implements three methods.
 *
 * Kept deliberately narrow. Every method a source is allowed to have is a
 * method the real one would have to fake, and an interface shaped around what
 * the simulator can conveniently do is not a seam, it is a simulator with extra
 * steps.
 */
import type {
  EventSource as EventSourceName,
  RakeEventType,
} from "../../../schema";
import type { RakeEventPayload } from "../../../types/event-payload.types";

/** One fact, as a source reports it — before the projector judges it. */
export interface IncomingEvent {
  rakeId: string;
  eventType: RakeEventType;
  occurredAt: Date;
  stationCode?: string | null;
  terminalId?: string | null;
  payload?: RakeEventPayload;
  source: EventSourceName;
  sourceRef?: string | null;
  /**
   * The source's own idea of "this exact fact".
   *
   * The source mints it, not the ingest: only the source knows that message
   * 4471 redelivered by the broker is the same fact as message 4471 the first
   * time. A key generated at ingest would make every redelivery a new event.
   */
  idempotencyKey: string;
}

export interface EventSource {
  readonly name: string;

  /** Begin streaming. Resolves once the stream is running, not when it ends. */
  start(handler: (event: IncomingEvent) => Promise<void>): Promise<void>;

  stop(): Promise<void>;

  /**
   * Replay a closed window, oldest first.
   *
   * An `AsyncIterable` rather than an array because a month of a real feed does
   * not fit in memory, and because the caller wants to start writing before the
   * producer has finished — which is what makes `--days 30 --speed 100` finish
   * in minutes rather than after a long silent buffer.
   */
  backfill(from: Date, to: Date): AsyncIterable<IncomingEvent>;
}

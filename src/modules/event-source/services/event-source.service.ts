/**
 * Chooses the adapter and pumps it into the projector.
 *
 * **Swapping sources is the one line below.** That is the acceptance criterion
 * for T4.10 and the whole point of the seam: nothing above this file knows
 * whether an event was invented by the simulator or read off a FOIS feed, and
 * the day a real feed exists the change is `EVENT_SOURCE=fois`.
 */
import type { Logger } from "winston";

import ProjectorService from "../../rake-event/services/projector.service";
import SimulatorSource, {
  type SimulatorOptions,
} from "../adapters/simulator.source";
import FoisSource from "../adapters/fois.source";
import type { EventSource, IncomingEvent } from "../types/event-source.types";

export type EventSourceKind = "simulator" | "fois";

export interface IngestSummary {
  accepted: number;
  rejected: number;
  /** Illegal transitions the projector refused, by reason. */
  reasons: Record<string, number>;
}

class EventSourceService {
  constructor(
    private readonly logger: Logger,
    private readonly projector: ProjectorService,
  ) {}

  /** The one line. */
  createSource(kind: EventSourceKind, options: SimulatorOptions): EventSource {
    return kind === "fois" ? new FoisSource() : new SimulatorSource(options);
  }

  /**
   * Drains a backfill into the projector.
   *
   * Rejections are counted and carried on from, not thrown. A backfill is a
   * bulk historical load, and stopping the whole month because one event was
   * refused would leave the database in a state neither the operator nor the
   * log can explain. Each refusal is already durable as an anomaly row.
   */
  async ingestBackfill(
    orgId: string,
    source: EventSource,
    from: Date,
    to: Date,
    onProgress?: (accepted: number) => void,
  ): Promise<IngestSummary> {
    const summary: IngestSummary = { accepted: 0, rejected: 0, reasons: {} };

    for await (const event of source.backfill(from, to)) {
      const outcome = await this.ingestOne(orgId, event);
      if (outcome === null) {
        summary.accepted += 1;
        if (summary.accepted % 500 === 0) onProgress?.(summary.accepted);
      } else {
        summary.rejected += 1;
        summary.reasons[outcome] = (summary.reasons[outcome] ?? 0) + 1;
      }
    }

    return summary;
  }

  /** Live mode. Same handler, released against a compressed clock. */
  async startLive(orgId: string, source: EventSource): Promise<void> {
    await source.start(async (event) => {
      await this.ingestOne(orgId, event);
    });
    this.logger.info(`Event source "${source.name}" is live`);
  }

  /** Returns null on success, or a short reason on refusal. */
  private async ingestOne(
    orgId: string,
    event: IncomingEvent,
  ): Promise<string | null> {
    try {
      await this.projector.applyEvent(orgId, {
        rakeId: event.rakeId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        stationCode: event.stationCode ?? null,
        terminalId: event.terminalId ?? null,
        payload: event.payload ?? {},
        source: event.source,
        sourceRef: event.sourceRef ?? null,
        recordedBy: null,
        idempotencyKey: event.idempotencyKey,
      });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // First clause only — the full message carries a rake code and a
      // timestamp, and a histogram keyed on those has one entry per event.
      return message.split(" — ")[0].slice(0, 80);
    }
  }
}

export default EventSourceService;

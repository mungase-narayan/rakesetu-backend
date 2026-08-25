/**
 * The FOIS adapter — a documented stub.
 *
 * It exists to prove the seam, and it is more useful unimplemented than absent:
 * a reviewer can see exactly what a real integration would have to provide, and
 * `event-source.service.ts` can be switched to it in one line to demonstrate
 * that nothing above the adapter knows which source it is reading.
 *
 * What a real implementation would need, none of which is available:
 *
 *  - credentials for CRIS's FOIS message bus, which are issued to railway
 *    zones and not to a college project;
 *  - a mapping from FOIS's rake identifiers to `rakes.id`;
 *  - a translation from FOIS message types to `RAKE_EVENT_TYPES`, which is not
 *    one-to-one — FOIS reports interchange at divisional boundaries, which this
 *    model treats as `SECTION_PASSED`;
 *  - a durable read offset, so a restart does not replay a week.
 *
 * Throwing rather than silently returning nothing is the point. A stub that
 * yields an empty stream looks like a working integration against a quiet feed,
 * and that is the failure mode worth refusing.
 */
import ApiError from "../../../utils/api-error";
import type { EventSource, IncomingEvent } from "../types/event-source.types";

const NOT_IMPLEMENTED =
  "FoisSource is a documented stub — there is no live FOIS feed for this deployment. Use SimulatorSource (EVENT_SOURCE=simulator).";

class FoisSource implements EventSource {
  readonly name = "fois";

  async start(): Promise<void> {
    throw new ApiError(501, NOT_IMPLEMENTED);
  }

  async stop(): Promise<void> {
    // Deliberately not a throw: stopping something that never started is a
    // no-op everywhere else in this codebase, and a shutdown handler should not
    // be the thing that raises.
  }

  // eslint-disable-next-line require-yield
  async *backfill(): AsyncIterable<IncomingEvent> {
    throw new ApiError(501, NOT_IMPLEMENTED);
  }
}

export default FoisSource;

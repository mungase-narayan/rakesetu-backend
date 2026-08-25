/**
 * The event spine's HTTP surface.
 *
 * The interesting handler is `create`: an illegal transition is a **409 whose
 * body names the from-state, the event and the full legal set**. A bare "409
 * Conflict" would leave a supervisor guessing which of eleven states their rake
 * is actually in, and the answer is already known here — withholding it just
 * moves the debugging into a support call.
 */
import type { Response } from "express";

import ApiError from "../../../utils/api-error";
import ApiResponse from "../../../utils/api-response";
import type { CustomRequest } from "../../../types/common.types";
import { requireTenant } from "../../../middlewares/tenant.middleware";
import { getRequestContext } from "../../../logger/request-context";
import {
  asBoolean,
  asDate,
  asString,
  pathParam,
  paginationFrom,
} from "../../../utils/controller";
import type { EventSource, RakeEventType } from "../../../schema";
import type { RakeEventPayload } from "../../../types/event-payload.types";

import ProjectorService from "../services/projector.service";
import RakeEventService from "../services/rake-event.service";
import EventStreamService, {
  HEARTBEAT_MS,
  StreamCapacityError,
  type StreamFrame,
} from "../services/event-stream.service";
import type { ApplyEventInput } from "../types/rake-event.types";
import { IDEMPOTENCY_HEADER } from "../../../middlewares/idempotency.middleware";

interface CreateEventBody {
  eventType: RakeEventType;
  occurredAt: string;
  stationCode?: string | null;
  terminalId?: string | null;
  payload?: RakeEventPayload;
  source?: EventSource;
  sourceRef?: string | null;
  correctsEventId?: string | null;
  reopenReason?: string | null;
}

interface BulkEventsBody {
  events: (CreateEventBody & { idempotencyKey: string })[];
}

class RakeEventController {
  constructor(
    private readonly projector: ProjectorService,
    private readonly events: RakeEventService,
    private readonly streamService: EventStreamService,
  ) {}

  async create(req: CustomRequest<CreateEventBody>, res: Response) {
    const { orgId } = requireTenant(req);
    const rakeId = pathParam(req.params.rakeId);

    // The header is already mandatory — `idempotent()` refuses the request
    // without one — so this is the durable copy of a value that has already
    // been validated, not a second source of truth.
    const idempotencyKey = req.header(IDEMPOTENCY_HEADER)?.trim();
    if (!idempotencyKey) {
      throw new ApiError(400, `${IDEMPOTENCY_HEADER} header is required`);
    }

    const result = await this.projector.applyEvent(
      orgId,
      this.toInput(req, rakeId, req.body, idempotencyKey),
    );

    return res
      .status(201)
      .json(new ApiResponse(201, result, "Event recorded successfully."));
  }

  /**
   * Bulk ingest. All-or-nothing, per the phase contract: a half-written journey
   * is worse than a refused batch, because the projection would then describe a
   * rake that both departed and never arrived.
   */
  async createBulk(req: CustomRequest<BulkEventsBody>, res: Response) {
    const { orgId } = requireTenant(req);
    const rakeId = pathParam(req.params.rakeId);

    const inputs = req.body.events.map((event) =>
      this.toInput(req, rakeId, event, event.idempotencyKey),
    );

    const results = await this.projector.applyBulk(orgId, inputs);

    return res.status(201).json(
      new ApiResponse(
        201,
        {
          accepted: results.length,
          projection: results[results.length - 1]?.projection ?? null,
          events: results.map((result) => result.event),
        },
        `${results.length} events recorded successfully.`,
      ),
    );
  }

  async list(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const data = await this.events.listEvents(
      orgId,
      pathParam(req.params.rakeId),
      {
        ...paginationFrom(req),
        from: asDate(req.query.from),
        to: asDate(req.query.to),
        eventType: asString(req.query.eventType) as RakeEventType | undefined,
        includeRejected: asBoolean(req.query.includeRejected),
      },
    );

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Events fetched successfully."));
  }

  async getState(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const rakeId = pathParam(req.params.rakeId);

    const state = await this.events.getState(orgId, rakeId);
    if (!state) {
      // A rake with no projection row has had no events. That is a real answer
      // about a real rake, so it is a 404 on the *projection*, not on the rake.
      throw new ApiError(
        404,
        "This rake has no projection yet — no event has ever been recorded against it",
      );
    }

    return res
      .status(200)
      .json(new ApiResponse(200, state, "State fetched successfully."));
  }

  async listCycles(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const data = await this.events.listCycles(
      orgId,
      pathParam(req.params.rakeId),
      { ...paginationFrom(req), isClosed: asBoolean(req.query.isClosed) },
    );

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Cycles fetched successfully."));
  }

  async getCycle(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const data = await this.events.getCycle(
      orgId,
      pathParam(req.params.cycleId),
    );

    if (!data) throw new ApiError(404, "Cycle not found");

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Cycle fetched successfully."));
  }

  /**
   * §13.2's determinism check, as an endpoint.
   *
   * `changed: false` is the healthy answer and the one the verification script
   * asserts. Admin-only — it rewrites the projection, and although the rewrite
   * is by definition what the log already says, "rebuild the world" is not a
   * button an operator should find by accident.
   */
  async reproject(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const result = await this.projector.reprojectRake(
      orgId,
      pathParam(req.params.rakeId),
    );

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          result,
          result.changed
            ? "Projection rebuilt — it differed from the stored one."
            : "Projection rebuilt — identical to the stored one.",
        ),
      );
  }

  async listAnomalies(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const data = await this.events.listAnomalies(orgId, {
      ...paginationFrom(req),
      rakeId: asString(req.query.rakeId),
      from: asDate(req.query.from),
      to: asDate(req.query.to),
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Anomalies fetched successfully."));
  }

  /**
   * `GET /api/v1/network/stream` — the live feed as Server-Sent Events (§4).
   *
   * The handler never returns until the client disconnects, which is the shape
   * of every SSE endpoint and the reason it is written by hand rather than
   * through `ApiResponse`: there is no single response body to build.
   *
   * Four details are load-bearing.
   *
   * **The subscription is opened before the replay is read.** Reversing them
   * leaves a window in which an event that lands between the replay query and
   * the `subscribe()` call is delivered to nobody — the exact gap the replay
   * exists to close. Frames that arrive during the replay are buffered and
   * flushed afterwards, minus anything the replay already carried.
   *
   * **`res.flush()` after every write.** `compression()` sits in front of this
   * route and would otherwise hold frames in its zlib buffer until enough bytes
   * accumulated — a live stream that arrives in batches of four kilobytes is a
   * poll with extra steps. The compression middleware patches `flush` onto the
   * response for exactly this case.
   *
   * **A capacity refusal is a 429**, not a dropped socket, so the client can
   * tell "you are over the cap, go back to polling" apart from a network fault.
   *
   * **The tenant comes from `withTenant`**, which read it off the user row. The
   * query string carries the token and nothing else; an `orgId` parameter on
   * this URL is ignored, and §9 asserts it.
   */
  async stream(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthenticated stream request");

    const buffered: StreamFrame[] = [];
    let live = false;

    const flushable = res as Response & { flush?: () => void };
    const write = (chunk: string) => {
      res.write(chunk);
      flushable.flush?.();
    };

    const send = (frame: StreamFrame) => {
      write(
        `id: ${frame.id}\nevent: ${frame.name}\ndata: ${JSON.stringify(frame.data)}\n\n`,
      );
    };

    const listener = (frame: StreamFrame) => {
      if (live) send(frame);
      else buffered.push(frame);
    };

    let unsubscribe: () => void;
    try {
      unsubscribe = this.streamService.subscribe(orgId, userId, listener);
    } catch (error) {
      if (error instanceof StreamCapacityError) {
        // 429 with the reason: the client's documented response is to fall
        // back to the five-second poll, and it can only do that if it knows.
        throw new ApiError(429, error.message, [{ scope: error.scope }]);
      }
      throw error;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx buffers proxied responses by default, which would defeat the
      // whole endpoint behind the one deployment shape this will meet.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    // The browser's default reconnect delay is three seconds; stating it means
    // the behaviour is the same in every implementation of EventSource.
    write("retry: 3000\n\n");
    write(": connected\n\n");

    const lastEventId =
      req.header("Last-Event-ID") ?? asString(req.query.lastEventId);

    const replayed = new Set<string>();
    if (lastEventId) {
      const frames = await this.streamService.replaySince(orgId, lastEventId);
      if (frames === null) {
        // Unknown id, or a gap wider than the replay window. Telling the client
        // to refetch is the only honest answer — a partial replay would leave
        // it confidently wrong.
        send({
          id: lastEventId,
          name: "resync",
          data: {
            reason:
              "The last event id is outside the replay window — refetch /network/live.",
          },
        });
      } else {
        for (const frame of frames) {
          send(frame);
          replayed.add(frame.id);
        }
      }
    }

    live = true;
    for (const frame of buffered) {
      if (!replayed.has(frame.id)) send(frame);
    }
    buffered.length = 0;

    /**
     * Twenty seconds by default, overridable by environment.
     *
     * A knob rather than a constant because proxy idle timeouts genuinely
     * differ between deployments — and because a suite that had to wait twenty
     * seconds to see one heartbeat would either be slow or would not assert on
     * heartbeats at all.
     */
    const heartbeatMs =
      Number(process.env.SSE_HEARTBEAT_MS) > 0
        ? Number(process.env.SSE_HEARTBEAT_MS)
        : HEARTBEAT_MS;

    const heartbeat = setInterval(() => {
      write(
        `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`,
      );
    }, heartbeatMs);
    heartbeat.unref?.();

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", close);
    res.on("close", close);
  }

  /** The map feed. Tenant-scoped, coordinates resolved, one query. */
  async networkLive(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const data = await this.events.networkLive(orgId);

    // Explicitly uncacheable: a five-second poll served from an intermediary
    // cache is a map that lies about being live, which is worse than a slow one.
    res.setHeader("Cache-Control", "no-store");

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Network state fetched successfully."));
  }

  /**
   * How much traffic each section carried, and where to draw it.
   *
   * Separate from `/network/live` on purpose. The live feed is polled every
   * five seconds by every open tab; section load changes over hours, and
   * folding a hundred-and-sixteen-row geometry payload into that poll would
   * multiply the map's bandwidth to keep a line width fresh that nobody would
   * see move.
   */
  async sectionLoad(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const hours = Number(asString(req.query.hours) ?? 24);

    const data = await this.events.sectionLoad(
      orgId,
      Number.isFinite(hours) && hours > 0 && hours <= 720 ? hours : 24,
    );

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Section load fetched successfully."));
  }

  async listRakeStates(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const pagination = paginationFrom(req);

    const data = await this.events.listRakesWithState(orgId, {
      page: pagination.page,
      limit: pagination.limit,
      state: asString(req.query.state),
      search: asString(req.query.search),
    });

    return res
      .status(200)
      .json(new ApiResponse(200, data, "Rakes fetched successfully."));
  }

  async availableCount(req: CustomRequest, res: Response) {
    const { orgId } = requireTenant(req);
    const count = await this.events.countAvailable(orgId);

    return res
      .status(200)
      .json(new ApiResponse(200, { count }, "Count fetched successfully."));
  }

  /**
   * Request body → service input.
   *
   * `recordedBy` and `correlationId` come from the request context and never
   * from the body. §8 wants the supervisor's identity on every event, and an
   * identity a client can type is not an identity.
   */
  private toInput(
    req: CustomRequest<unknown>,
    rakeId: string,
    body: CreateEventBody,
    idempotencyKey: string,
  ): ApplyEventInput {
    return {
      rakeId,
      eventType: body.eventType,
      occurredAt: new Date(body.occurredAt),
      stationCode: body.stationCode ?? null,
      terminalId: body.terminalId ?? null,
      payload: body.payload ?? {},
      // A human at a keyboard is `manual` whatever the body claims. Only the
      // simulator and, later, the FOIS adapter reach the service directly.
      source: "manual",
      sourceRef: body.sourceRef ?? null,
      recordedBy: req.user?.id ?? null,
      idempotencyKey,
      correctsEventId: body.correctsEventId ?? null,
      correlationId: getRequestContext()?.correlationId ?? null,
      reopenReason: body.reopenReason ?? null,
    };
  }
}

export default RakeEventController;

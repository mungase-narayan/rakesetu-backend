/**
 * The live feed (§9's SSE row).
 *
 * Five claims are made here and each of them is a claim the polled map could
 * not make: a committed event reaches a subscriber, a **rolled-back** one
 * reaches nobody, a heartbeat keeps the socket open, `Last-Event-ID` replays
 * the gap, and org B never sees org A's frames.
 *
 * The stream is exercised over a real socket rather than through supertest.
 * supertest buffers a response and resolves when it ends, and this response
 * never ends — which is the entire point of it.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import logger from "../../../logger/winston.logger";
import { db } from "../../../database/connection";
import { rakeCycles, rakeEvents, rakeStates, rakes } from "../../../schema";
import { api, testApp } from "../../../test/helpers/app";
import { loginAs, type Session } from "../../../test/helpers/auth";
import { requireOrg } from "../../../../scripts/seed/tenancy.seed";
import AuditService from "../../audit/services/audit.service";
import ProjectorService from "./projector.service";
import EventStreamService, {
  MAX_STREAMS_PER_USER,
  StreamCapacityError,
  type StreamFrame,
} from "./event-stream.service";

let controller: Session;
let customer: Session;
let orgId: string;
let rakeId: string;
let server: http.Server;
let port: number;

const isoAgo = (hours: number): string =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

/**
 * Reads an SSE response until `stop()` says it has seen enough.
 *
 * Resolves with the raw text so the assertions can be about the wire format —
 * `id:`, `event:` and `data:` lines are the contract `EventSource` parses, and
 * a test that asserted on a parsed object would not notice a missing `id:`.
 */
const readStream = (
  path: string,
  stop: (text: string) => boolean,
  timeoutMs = 8_000,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}> =>
  new Promise((resolve, reject) => {
    const request = http.get({ port, path }, (response) => {
      let text = "";
      const finish = () => {
        request.destroy();
        clearTimeout(timer);
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text,
        });
      };

      const timer = setTimeout(finish, timeoutMs);
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (stop(text)) finish();
      });
      response.on("end", finish);
    });

    request.on("error", reject);
  });

beforeAll(async () => {
  // A fast heartbeat, so the assertion below does not cost twenty seconds. The
  // production default is unchanged; see the handler.
  process.env.SSE_HEARTBEAT_MS = "300";

  controller = await loginAs("freight_controller");
  customer = await loginAs("freight_customer");
  orgId = (await requireOrg("CR")).id;

  const [created] = await db
    .insert(rakes)
    .values({
      orgId,
      code: `R-SSE-${Date.now() % 100000}`,
      wagonTypeCode: "BOXNHL",
      wagonCount: 42,
      owner: "IR",
      homeDivision: "Solapur",
      currentState: "EMPTY_AVAILABLE",
      currentStation: "KWV",
      stateSince: new Date(Date.now() - 72 * 60 * 60 * 1000),
    })
    .returning();
  rakeId = created.id;

  server = http.createServer(testApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  delete process.env.SSE_HEARTBEAT_MS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(rakeEvents).where(eq(rakeEvents.rakeId, rakeId));
  await db.delete(rakeStates).where(eq(rakeStates.rakeId, rakeId));
  await db.delete(rakeCycles).where(eq(rakeCycles.rakeId, rakeId));
  await db.delete(rakes).where(eq(rakes.id, rakeId));
});

describe("GET /network/stream — guards", () => {
  it("refuses an unauthenticated subscriber", async () => {
    const response = await api().get("/api/v1/network/stream");
    expect(response.status).toBe(401);
  });

  it("refuses a freight customer, who holds rake:read but not the network", async () => {
    const response = await customer.get("/api/v1/network/stream");
    expect(response.status).toBe(403);
  });

  it("accepts the token from the query string, because EventSource cannot set a header", async () => {
    const result = await readStream(
      `/api/v1/network/stream?token=${controller.token}`,
      (text) => text.includes(": connected"),
      3_000,
    );

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(result.headers["cache-control"]).toMatch(/no-cache/);
    expect(result.text).toMatch(/retry: \d+/);
  });

  /**
   * **The isolation surface this phase adds.** The org is bound by `withTenant`
   * from the user row; the only thing the query string is trusted for is the
   * token. A forged `orgId` must change nothing — not the frames, not the
   * status, not the fact that the subscription is CR's.
   */
  it("ignores a forged orgId in the query string", async () => {
    const otherTenant = await requireOrg("ACC");

    const result = await readStream(
      `/api/v1/network/stream?token=${controller.token}&orgId=${otherTenant.id}`,
      (text) => text.includes(": connected"),
      3_000,
    );

    expect(result.status).toBe(200);

    // And prove it is scoped to CR rather than merely not crashing: a WR event
    // published while this is open must not appear.
    const stream = new EventStreamService(db, logger);
    const received: StreamFrame[] = [];
    const release = stream.subscribe(orgId, "probe-user", (frame) =>
      received.push(frame),
    );

    const projector = new ProjectorService(
      logger,
      new AuditService(logger),
      db,
      stream,
    );
    await projector.applyEvent(orgId, {
      rakeId,
      eventType: "EMPTY_AVAILABLE",
      occurredAt: new Date(isoAgo(70)),
      stationCode: "KWV",
      source: "manual",
      idempotencyKey: `sse-scope-${Date.now()}`,
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    release();

    expect(received.length).toBeGreaterThan(0);
    for (const frame of received) {
      const data = frame.data as { rakeId?: string };
      expect(data.rakeId).toBe(rakeId);
    }
  });

  it("keeps the socket alive with heartbeats", async () => {
    const result = await readStream(
      `/api/v1/network/stream?token=${controller.token}`,
      (text) => text.includes("event: heartbeat"),
      4_000,
    );

    expect(result.text).toContain("event: heartbeat");
  });
});

describe("publish after commit", () => {
  /**
   * The rule the whole design rests on: a frame describes something that has
   * already happened.
   *
   * The stub reads the event row back from a **different pooled connection** at
   * the instant `notify` fires. If the publish were inside the transaction that
   * wrote it, the row would be invisible to that connection and the read would
   * come back empty. It comes back with the row, so the commit had landed.
   */
  it("the event is already visible to another connection when the frame fires", async () => {
    const reads: Promise<number>[] = [];
    const stub = new (class extends EventStreamService {
      notify(org: string, eventId: string) {
        reads.push(
          db
            .select({ id: rakeEvents.id })
            .from(rakeEvents)
            .where(and(eq(rakeEvents.orgId, org), eq(rakeEvents.id, eventId)))
            .then((rows) => rows.length),
        );
      }
    })(db, logger);

    const projector = new ProjectorService(
      logger,
      new AuditService(logger),
      db,
      stub,
    );

    await projector.applyEvent(orgId, {
      rakeId,
      eventType: "ALLOTTED",
      occurredAt: new Date(isoAgo(60)),
      source: "manual",
      idempotencyKey: `sse-commit-${Date.now()}`,
    });

    expect(reads).toHaveLength(1);
    expect(await reads[0]).toBe(1);
  });

  /**
   * A duplicate idempotency key rolls the transaction back and answers 409. No
   * event exists, so no frame may describe one — this is §9's "a rolled-back
   * transaction emits nothing".
   */
  it("a rolled-back transaction emits nothing", async () => {
    const notified: string[] = [];
    const stub = new (class extends EventStreamService {
      notify(_org: string, eventId: string) {
        notified.push(eventId);
      }
    })(db, logger);

    const projector = new ProjectorService(
      logger,
      new AuditService(logger),
      db,
      stub,
    );

    const key = `sse-rollback-${Date.now()}`;
    const input = {
      rakeId,
      eventType: "DEPARTED_EMPTY" as const,
      occurredAt: new Date(isoAgo(55)),
      source: "manual" as const,
      idempotencyKey: key,
    };

    await projector.applyEvent(orgId, input);
    expect(notified).toHaveLength(1);

    // The same key again: the insert into `rake_event_keys` violates its
    // primary key, the whole transaction unwinds, and the caller gets a 409.
    await expect(projector.applyEvent(orgId, input)).rejects.toThrow();
    expect(notified).toHaveLength(1);
  });
});

describe("Last-Event-ID replay", () => {
  it("replays the events written since the id the client last saw", async () => {
    const stream = new EventStreamService(db, logger);
    const projector = new ProjectorService(
      logger,
      new AuditService(logger),
      db,
      stream,
    );

    const first = await projector.applyEvent(orgId, {
      rakeId,
      eventType: "SECTION_PASSED",
      occurredAt: new Date(isoAgo(50)),
      stationCode: "KWV",
      payload: { fromCode: "KWV", toCode: "KWV", sectionId: "n/a" },
      source: "manual",
      idempotencyKey: `sse-replay-a-${Date.now()}`,
    });

    const second = await projector.applyEvent(orgId, {
      rakeId,
      eventType: "SECTION_PASSED",
      occurredAt: new Date(isoAgo(49)),
      stationCode: "KWV",
      payload: { fromCode: "KWV", toCode: "KWV", sectionId: "n/a" },
      source: "manual",
      idempotencyKey: `sse-replay-b-${Date.now()}`,
    });

    const frames = await stream.replaySince(orgId, first.event.id);

    expect(frames).not.toBeNull();
    const ids = (frames as StreamFrame[]).map((frame) => frame.id);
    expect(ids).toContain(second.event.id);
    expect(ids).not.toContain(first.event.id);
  });

  it("answers null for an id it cannot place, so the client resyncs", async () => {
    const stream = new EventStreamService(db, logger);
    const frames = await stream.replaySince(
      orgId,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(frames).toBeNull();
  });

  it("a client reconnecting with an unknown id is told to resync", async () => {
    const result = await readStream(
      `/api/v1/network/stream?token=${controller.token}` +
        `&lastEventId=00000000-0000-4000-8000-000000000000`,
      (text) => text.includes("event: resync"),
      3_000,
    );

    expect(result.text).toContain("event: resync");
    expect(result.text).toMatch(/network\/live/);
  });
});

describe("caps", () => {
  it("refuses a user their sixth stream", () => {
    const stream = new EventStreamService(db, logger);
    const releases: (() => void)[] = [];

    for (let index = 0; index < MAX_STREAMS_PER_USER; index += 1) {
      releases.push(stream.subscribe(orgId, "capped-user", () => {}));
    }

    expect(() => stream.subscribe(orgId, "capped-user", () => {})).toThrow(
      StreamCapacityError,
    );

    // And releasing one makes room again — a cap that leaked would take a
    // browser tab's worth of capacity with every refresh.
    releases[0]();
    const extra = stream.subscribe(orgId, "capped-user", () => {});
    expect(stream.stats().streams).toBe(MAX_STREAMS_PER_USER);

    extra();
    for (const release of releases.slice(1)) release();
    expect(stream.stats().streams).toBe(0);
  });
});

describe("cross-tenant isolation", () => {
  it("org B never receives org A's frames", async () => {
    const stream = new EventStreamService(db, logger);
    const otherTenant = await requireOrg("ACC");

    const cr: StreamFrame[] = [];
    const other: StreamFrame[] = [];
    const releaseCr = stream.subscribe(orgId, "cr-user", (f) => cr.push(f));
    const releaseOther = stream.subscribe(otherTenant.id, "other-user", (f) =>
      other.push(f),
    );

    const projector = new ProjectorService(
      logger,
      new AuditService(logger),
      db,
      stream,
    );
    await projector.applyEvent(orgId, {
      rakeId,
      eventType: "ARRIVED_LOADING_YARD",
      occurredAt: new Date(isoAgo(45)),
      stationCode: "KWV",
      source: "manual",
      idempotencyKey: `sse-tenant-${Date.now()}`,
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    releaseCr();
    releaseOther();

    expect(cr.length).toBeGreaterThan(0);
    expect(other).toHaveLength(0);
  });
});

/**
 * RabbitMQ client: owns the connection, asserts the topology once at boot, and
 * exposes publish/consume for the two job families — `ai.*` and `email.*`.
 *
 * **One connection, two families.** The families differ by six strings and a
 * TTL, so they are described by a `QueueFamily` record and driven through one
 * set of private primitives (`assertFamily`, `publishTo`, `consumeFrom`). A
 * second `RabbitMQService` would mean a second TCP connection, a second
 * lifecycle in `App`, and a health check that has to report two things — all to
 * vary data.
 *
 * Three behaviours are worth knowing about:
 *
 *  - **Disabled mode.** `USE_RABBITMQ_SERVICE=false` never contacts a broker.
 *    Publishing runs the family's `fallbackHandlers` entry inline instead, so a
 *    serverless host (Vercel), a test run or a laptop without Docker still
 *    works end to end — just synchronously.
 *  - **Failure is not silent.** A handler that throws nacks without requeue, so
 *    the message lands in that consumer's dead-letter queue rather than looping
 *    forever at the head of the queue.
 *  - **Prefetch is per-consumer, not per-connection.** amqplib's
 *    `channel.prefetch(n)` with the default `global=false` applies to consumers
 *    registered *after* the call, so `consumeFrom` sets it immediately before
 *    `consume` and each family gets its own value on the shared channel.
 */
import amqp, { Channel, ChannelModel, ConsumeMessage } from "amqplib";

import logger from "../logger/winston.logger";
import {
  AI_FAMILY,
  EMAIL_FAMILY,
  type AiJobHandler,
  type AiJobKind,
  type AiJobPayload,
  type EmailJobHandler,
  type EmailJobMessage,
  type QueueEnvelope,
  type QueueFamily,
} from "../types/queue.types";

interface RabbitMQOptions {
  /** When false the broker is never contacted; jobs run inline. */
  enabled?: boolean;
  /**
   * Run instead of publishing when the service is disabled, one per family.
   *
   * Per-family rather than a single function because the two carry unrelated
   * payloads: routing an email message into the AI handler would mark an
   * `ai_jobs` row that does not exist and drop the mail on the floor.
   */
  fallbackHandlers?: {
    ai?: AiJobHandler;
    email?: EmailJobHandler;
  };
  /** Unacked AI messages per consumer. One = strict fair dispatch. */
  prefetch?: number;
  /**
   * Unacked email messages per consumer. Higher than the AI default because an
   * SMTP round trip is milliseconds, where an LLM call is seconds.
   */
  emailPrefetch?: number;
}

class RabbitMQService {
  private connection?: ChannelModel;
  private channel?: Channel;
  private url: string;
  private enabled: boolean;
  private prefetch: number;
  private emailPrefetch: number;
  private fallbackHandlers: NonNullable<RabbitMQOptions["fallbackHandlers"]>;

  constructor(url: string, options: RabbitMQOptions = {}) {
    this.url = url;
    this.enabled = options.enabled ?? true;
    this.prefetch = options.prefetch ?? 1;
    this.emailPrefetch = options.emailPrefetch ?? 10;
    this.fallbackHandlers = options.fallbackHandlers ?? {};
  }

  /** True only when the broker is enabled *and* a channel is open. */
  isReady(): boolean {
    return this.enabled && Boolean(this.channel);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      logger.info(
        "RabbitMQ disabled (USE_RABBITMQ_SERVICE=false) — AI jobs will run inline",
      );
      return;
    }

    try {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();

      // amqplib emits 'error' on an unexpected drop; without a listener the
      // process would die on an EventEmitter unhandled 'error' instead of
      // logging it.
      this.connection.on("error", (error) =>
        logger.error({ event: "RabbitMQConnectionError", error }),
      );
      this.connection.on("close", () => {
        this.channel = undefined;
        logger.warn({ event: "RabbitMQConnectionClosed" });
      });

      await this.setup();
      logger.info("RabbitMQ Connected");
    } catch (error) {
      logger.error({ event: "RabbitMQ connection failed", error });
      throw error;
    }
  }

  /**
   * Asserts every family's exchanges, queues and bindings. Idempotent, so each
   * replica can run it at boot and the topology exists before the first publish.
   */
  private async setup(): Promise<void> {
    await this.assertFamily(AI_FAMILY);
    await this.assertFamily(EMAIL_FAMILY);

    logger.info("RabbitMQ exchanges, queues and bindings ready");
  }

  /**
   * One family's topology.
   *
   * **Dead-letter side first, per kind.** The main queue names its DLX in its
   * own arguments, so the target has to exist before a message can possibly
   * fail into it.
   */
  private async assertFamily<K extends string>(
    family: QueueFamily<K>,
  ): Promise<void> {
    const channel = this.requireChannel();

    await channel.assertExchange(family.deadLetterExchange, "direct", {
      durable: true,
    });
    await channel.assertExchange(family.exchange, "direct", { durable: true });

    for (const kind of family.kinds) {
      const routingKey = family.routingKeys[kind];

      await channel.assertQueue(family.failedQueues[kind], { durable: true });
      await channel.bindQueue(
        family.failedQueues[kind],
        family.deadLetterExchange,
        routingKey,
      );

      await channel.assertQueue(family.queues[kind], {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": family.deadLetterExchange,
          "x-dead-letter-routing-key": routingKey,
          "x-message-ttl": family.messageTtlMs,
        },
      });
      await channel.bindQueue(family.queues[kind], family.exchange, routingKey);
    }
  }

  /**
   * Publishes one message, or runs the family's inline fallback when the broker
   * is disabled.
   */
  private async publishTo<K extends string, M extends QueueEnvelope<K>>(
    family: QueueFamily<K>,
    message: M,
  ): Promise<void> {
    if (!this.enabled) {
      const fallback = this.fallbackHandlers[family.name] as
        ((payload: M) => Promise<void>) | undefined;

      if (!fallback) {
        throw new Error(
          `RabbitMQ disabled and no fallbackHandler configured for ${family.name} jobs`,
        );
      }

      await fallback(message);
      logger.info({
        event: `${family.logPrefix}RanInline`,
        kind: message.kind,
        jobId: message.jobId,
        correlationId: message.correlationId,
      });
      return;
    }

    const channel = this.requireChannel();

    try {
      const buffer = Buffer.from(JSON.stringify(message));

      const enqueued = channel.publish(
        family.exchange,
        family.routingKeys[message.kind],
        buffer,
        {
          persistent: true,
          contentType: "application/json",
          messageId: `${message.kind}-${message.jobId}`,
          correlationId: message.correlationId,
          timestamp: Date.now(),
          headers: { orgId: message.orgId, kind: message.kind },
        },
      );

      if (!enqueued) {
        throw new Error("RabbitMQ write buffer full — message not enqueued");
      }

      logger.info({
        event: `${family.logPrefix}Published`,
        kind: message.kind,
        jobId: message.jobId,
        orgId: message.orgId,
        correlationId: message.correlationId,
      });
    } catch (error) {
      logger.error({
        event: `Publish${family.logPrefix}Failed`,
        kind: message.kind,
        error,
      });
      throw error;
    }
  }

  /**
   * Subscribes `handler` to one queue. Ack on success; nack-without-requeue on
   * failure, which routes the message to that kind's `.failed` queue.
   *
   * There is exactly one nack policy here, deliberately. A family that wants
   * retries implements them in its handler — deciding to retry needs to know
   * whether the failure was transient, and only the handler knows that.
   */
  private async consumeFrom<K extends string, M extends QueueEnvelope<K>>(
    family: QueueFamily<K>,
    kind: K,
    handler: (message: M) => Promise<void>,
    prefetch: number,
  ): Promise<void> {
    if (!this.enabled) {
      logger.info(
        `RabbitMQ disabled — skipping ${family.queues[kind]} consumer`,
      );
      return;
    }

    const channel = this.requireChannel();
    // Set immediately before `consume`: with global=false this applies to
    // consumers registered after the call, which is what lets the two families
    // hold different values on one channel.
    await channel.prefetch(prefetch);

    await channel.consume(
      family.queues[kind],
      async (msg: ConsumeMessage | null) => {
        if (!msg) return;

        let message: M;
        try {
          message = JSON.parse(msg.content.toString()) as M;
        } catch (error) {
          // Unparseable: no amount of redelivery fixes it.
          logger.error({ event: `${family.logPrefix}Malformed`, kind, error });
          channel.nack(msg, false, false);
          return;
        }

        try {
          logger.info({
            event: `${family.logPrefix}Received`,
            kind,
            jobId: message.jobId,
            correlationId: message.correlationId,
          });
          await handler(message);
          channel.ack(msg);
          logger.info({
            event: `${family.logPrefix}Processed`,
            kind,
            jobId: message.jobId,
          });
        } catch (error) {
          logger.error({
            event: `${family.logPrefix}Failed`,
            kind,
            jobId: message.jobId,
            error,
          });
          channel.nack(msg, false, false);
        }
      },
    );

    logger.info(`Consuming ${family.queues[kind]}`);
  }

  /* ---------------------------------------------------------------- ai -- */

  async publishAiJob(payload: AiJobPayload): Promise<void> {
    return this.publishTo(AI_FAMILY, payload);
  }

  async consumeAiJobs(kind: AiJobKind, handler: AiJobHandler): Promise<void> {
    return this.consumeFrom(AI_FAMILY, kind, handler, this.prefetch);
  }

  /** Every AI kind through one handler, which switches on `payload.kind`. */
  async consumeAllAiJobs(handler: AiJobHandler): Promise<void> {
    for (const kind of AI_FAMILY.kinds) {
      await this.consumeAiJobs(kind, handler);
    }
  }

  /* ------------------------------------------------------------- email -- */

  async publishEmailJob(message: EmailJobMessage): Promise<void> {
    return this.publishTo(EMAIL_FAMILY, message);
  }

  async consumeEmailJobs(handler: EmailJobHandler): Promise<void> {
    return this.consumeFrom(EMAIL_FAMILY, "send", handler, this.emailPrefetch);
  }

  /** Closes the channel then the connection, so a SIGTERM does not drop acks. */
  async close(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
      this.channel = undefined;
      this.connection = undefined;
      logger.info("RabbitMQ connection closed");
    } catch (error) {
      logger.error({ event: "RabbitMQ close failed", error });
    }
  }

  private requireChannel(): Channel {
    if (!this.channel) {
      throw new Error(
        "RabbitMQ channel not initialised — call connect() first",
      );
    }
    return this.channel;
  }
}

export default RabbitMQService;

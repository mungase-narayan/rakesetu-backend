/**
 * RabbitMQ client: owns the connection, asserts the topology once at boot, and
 * exposes publish/consume for AI jobs.
 *
 * Two behaviours are worth knowing about:
 *
 *  - **Disabled mode.** `USE_RABBITMQ_SERVICE=false` never contacts a broker.
 *    Publishing runs `fallbackHandler` inline instead, so a serverless host
 *    (Vercel), a test run or a laptop without Docker still works end to end —
 *    just synchronously.
 *  - **Failure is not silent.** A handler that throws nacks without requeue, so
 *    the message lands in that consumer's dead-letter queue rather than looping
 *    forever at the head of the queue.
 */
import amqp, { Channel, ChannelModel, ConsumeMessage } from "amqplib";

import logger from "../logger/winston.logger";
import {
  AI_EXCHANGES,
  AI_FAILED_QUEUES,
  AI_JOB_KINDS,
  AI_MESSAGE_TTL_MS,
  AI_QUEUES,
  AI_ROUTING_KEYS,
  type AiJobHandler,
  type AiJobKind,
  type AiJobPayload,
} from "../types/queue.types";

interface RabbitMQOptions {
  /** When false the broker is never contacted; jobs run via fallbackHandler. */
  enabled?: boolean;
  /** Called instead of publishing when the service is disabled. */
  fallbackHandler?: AiJobHandler;
  /** Unacked messages allowed per consumer. One = strict fair dispatch. */
  prefetch?: number;
}

class RabbitMQService {
  private connection?: ChannelModel;
  private channel?: Channel;
  private url: string;
  private enabled: boolean;
  private prefetch: number;
  private fallbackHandler?: AiJobHandler;

  constructor(url: string, options: RabbitMQOptions = {}) {
    this.url = url;
    this.enabled = options.enabled ?? true;
    this.prefetch = options.prefetch ?? 1;
    this.fallbackHandler = options.fallbackHandler;
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
   * Asserts exchanges, queues and bindings. Idempotent, so every replica can
   * run it at boot and the topology exists before the first publish.
   */
  private async setup(): Promise<void> {
    const channel = this.requireChannel();

    await channel.assertExchange(AI_EXCHANGES.DEAD_LETTER, "direct", {
      durable: true,
    });
    await channel.assertExchange(AI_EXCHANGES.MAIN, "direct", {
      durable: true,
    });

    for (const kind of AI_JOB_KINDS) {
      const routingKey = AI_ROUTING_KEYS[kind];

      // Dead-letter side first: the main queue names it as its DLX, so it has
      // to be bound before a message can possibly fail.
      await channel.assertQueue(AI_FAILED_QUEUES[kind], { durable: true });
      await channel.bindQueue(
        AI_FAILED_QUEUES[kind],
        AI_EXCHANGES.DEAD_LETTER,
        routingKey,
      );

      await channel.assertQueue(AI_QUEUES[kind], {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": AI_EXCHANGES.DEAD_LETTER,
          "x-dead-letter-routing-key": routingKey,
          "x-message-ttl": AI_MESSAGE_TTL_MS,
        },
      });
      await channel.bindQueue(AI_QUEUES[kind], AI_EXCHANGES.MAIN, routingKey);
    }

    logger.info("RabbitMQ exchanges, queues and bindings ready");
  }

  async publishAiJob(payload: AiJobPayload): Promise<void> {
    if (!this.enabled) {
      if (!this.fallbackHandler) {
        throw new Error(
          "RabbitMQ disabled and no fallbackHandler configured for AI jobs",
        );
      }

      await this.fallbackHandler(payload);
      logger.info({
        event: "AiJobRanInline",
        kind: payload.kind,
        jobId: payload.jobId,
        correlationId: payload.correlationId,
      });
      return;
    }

    const channel = this.requireChannel();

    try {
      const buffer = Buffer.from(JSON.stringify(payload));

      const enqueued = channel.publish(
        AI_EXCHANGES.MAIN,
        AI_ROUTING_KEYS[payload.kind],
        buffer,
        {
          persistent: true,
          contentType: "application/json",
          messageId: `${payload.kind}-${payload.jobId}`,
          correlationId: payload.correlationId,
          timestamp: Date.now(),
          headers: { orgId: payload.orgId, kind: payload.kind },
        },
      );

      if (!enqueued) {
        throw new Error("RabbitMQ write buffer full — message not enqueued");
      }

      logger.info({
        event: "AiJobPublished",
        kind: payload.kind,
        jobId: payload.jobId,
        orgId: payload.orgId,
        correlationId: payload.correlationId,
      });
    } catch (error) {
      logger.error({ event: "PublishAiJobFailed", kind: payload.kind, error });
      throw error;
    }
  }

  /**
   * Subscribes `handler` to one job kind. Ack on success; nack-without-requeue
   * on failure, which routes the message to `ai.<kind>.failed`.
   */
  async consumeAiJobs(kind: AiJobKind, handler: AiJobHandler): Promise<void> {
    if (!this.enabled) {
      logger.info(`RabbitMQ disabled — skipping ${kind} consumer`);
      return;
    }

    const channel = this.requireChannel();
    await channel.prefetch(this.prefetch);

    await channel.consume(
      AI_QUEUES[kind],
      async (msg: ConsumeMessage | null) => {
        if (!msg) return;

        let payload: AiJobPayload;
        try {
          payload = JSON.parse(msg.content.toString());
        } catch (error) {
          // Unparseable content will never parse on a retry — dead-letter it now.
          logger.error({ event: "AiJobMalformed", kind, error });
          channel.nack(msg, false, false);
          return;
        }

        try {
          logger.info({
            event: "AiJobReceived",
            kind,
            jobId: payload.jobId,
            correlationId: payload.correlationId,
          });

          await handler(payload);
          channel.ack(msg);

          logger.info({
            event: "AiJobProcessed",
            kind,
            jobId: payload.jobId,
            correlationId: payload.correlationId,
          });
        } catch (error) {
          logger.error({
            event: "AiJobFailed",
            kind,
            jobId: payload.jobId,
            correlationId: payload.correlationId,
            error,
          });
          channel.nack(msg, false, false);
        }
      },
    );

    logger.info(`Consuming ${AI_QUEUES[kind]} events`);
  }

  /** Registers the same handler for every job kind. */
  async consumeAllAiJobs(handler: AiJobHandler): Promise<void> {
    for (const kind of AI_JOB_KINDS) {
      await this.consumeAiJobs(kind, handler);
    }
  }

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

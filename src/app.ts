/**
 * Express application bootstrap: wires global middleware, connects Postgres,
 * Redis and the RabbitMQ broker used for AI jobs, registers feature routers and
 * the error handler, and exposes start()/shutdown()/getApp() for the entrypoint
 * and tests.
 *
 * **Middleware order is load-bearing**, and the two that matter most are at the
 * front: `requestId` runs before every logger so no line is written without a
 * correlation id, and `helmet` runs before anything that can produce a response
 * so no response escapes without its headers.
 */
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import express, { Application, Request, Response } from "express";

import env from "./config/env.config";
import logger from "./logger/winston.logger";
import RabbitMQService from "./utils/rabbitmq";
import { connectDatabase, disconnectDatabase } from "./database/connection";
import { connectRedis, disconnectRedis } from "./database/redis";
import morganMiddleware from "./middlewares/morgan.middleware";
import requestId from "./middlewares/request-id.middleware";
import { globalRateLimiter } from "./middlewares/rate-limit.middleware";
import errorHandlerMiddleware from "./middlewares/error-handler.middleware";

import AiJobService from "./modules/ai-job/services/ai-job.service";
import { emailJobService } from "./modules/email/email.provider";
import HealthController from "./modules/health/health.controller";

import userRouter from "./modules/user/routes/user.routes";
import roleRouter from "./modules/role/routes/role.routes";
import auditRouter from "./modules/audit/routes/audit.routes";
import organizationRouter from "./modules/organization/routes/organization.routes";

// Phase 3 — master data, network and documents.
import networkRouter from "./modules/network/routes/network.routes";
import chargeRuleRouter from "./modules/charge-rule/routes/charge-rule.routes";
import documentRouter from "./modules/document/routes/document.routes";
import commodityRouter from "./modules/commercial/routes/commodity.routes";
import customerRouter from "./modules/commercial/routes/customer.routes";
import {
  wagonTypeRouter,
  wagonRouter,
  rakeRouter,
} from "./modules/asset/routes/asset.routes";
import {
  terminalRouter,
  embargoRouter,
} from "./modules/terminal/routes/terminal.routes";

// Phase 4 — the event spine and the digital twin.
import {
  rakeEventRouter,
  networkLiveRouter,
  anomalyRouter,
} from "./modules/rake-event/routes/rake-event.routes";

// Phase 5 — the live read side.
import etaRouter from "./modules/eta/routes/eta.routes";

export class App {
  static readonly instanceId = process.env.INSTANCE_ID || "local";

  private app: Application;
  private rabbitmqService: RabbitMQService;
  private aiJobService: AiJobService;
  private healthController: HealthController;

  constructor() {
    this.app = express();
    this.initializeMiddlewares();

    this.aiJobService = new AiJobService(logger);
    this.rabbitmqService = new RabbitMQService(env.rabbitmq.url, {
      enabled: env.rabbitmq.enabled,
      prefetch: env.rabbitmq.prefetch,
      emailPrefetch: env.rabbitmq.emailPrefetch,
      fallbackHandlers: {
        ai: (payload) => this.aiJobService.handleJob(payload),
        email: (message) => emailJobService.handleJob(message),
      },
    });
    // These reference each other — the broker calls the services as its
    // fallback handlers, and the services publish through the broker — so the
    // second edge is wired after both exist.
    this.aiJobService.setRabbitMQService(this.rabbitmqService);
    emailJobService.setRabbitMQService(this.rabbitmqService);

    this.healthController = new HealthController(
      this.rabbitmqService,
      App.instanceId,
    );
  }

  private initializeMiddlewares() {
    const corsOption: cors.CorsOptions = {
      origin: env.frontendUrl,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        // Both are client-set on requests the API accepts; omitting them from
        // this list makes the browser reject the preflight, not the server.
        "Idempotency-Key",
        "X-Request-Id",
      ],
      // Without this the SPA cannot read the id off a response, which is the
      // whole point of echoing it.
      exposedHeaders: ["X-Request-Id", "X-Instance-Id", "Idempotent-Replay"],
    };

    // First, so every log line and every error carries the id.
    this.app.use(requestId);

    this.app.use(
      helmet({
        // CSP off in dev only: Vite's dev server injects inline scripts, and a
        // policy that has to be disabled to work is a policy nobody trusts.
        contentSecurityPolicy: env.app.isDev ? false : undefined,
        // The SPA is served from a different origin; the default `same-origin`
        // would block it from reading responses it is entitled to.
        crossOriginResourcePolicy: { policy: "cross-origin" },
      }),
    );

    this.app.options("/{*path}", cors(corsOption));
    this.app.use(cors(corsOption));
    this.app.use(compression());
    this.app.use(cookieParser());
    this.app.use(express.json({ limit: "50MB" }));
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(morganMiddleware);
    this.app.use(express.static("public"));

    // req.ip is stamped onto users.last_login_ip and keys the rate limiters;
    // without this it would be the proxy's address in every deployment that
    // sits behind one, which would make one limiter bucket for the whole world.
    this.app.set("trust proxy", 1);

    // After trust proxy, so it keys on the real client address.
    this.app.use(globalRateLimiter);

    // Makes "which replica answered?" visible once there is more than one.
    this.app.use((_req, res, next) => {
      res.setHeader("X-Instance-Id", App.instanceId);
      next();
    });
  }

  private root = (_req: Request, res: Response) => {
    return res.status(200).json({
      status: 200,
      message: "RakeSetu API is running",
    });
  };

  private initializeRoutes() {
    this.app.get("/", this.root);

    // Liveness and readiness (§10). /health and /api/v1/health are kept for
    // whatever is already polling them.
    this.app.get("/healthz", this.healthController.live);
    this.app.get("/readyz", this.healthController.ready);
    this.app.get("/health", this.healthController.legacy);
    this.app.get("/api/v1/health", this.healthController.legacy);

    this.app.use("/api/v1/users", userRouter);
    this.app.use("/api/v1/organizations", organizationRouter);
    this.app.use("/api/v1/roles", roleRouter);
    this.app.use("/api/v1/audit", auditRouter);

    // Master data (Phase 3). Reference data first, then the assets and
    // commercial parties that point at it.
    this.app.use("/api/v1/network", networkRouter);
    this.app.use("/api/v1/commodities", commodityRouter);
    this.app.use("/api/v1/wagon-types", wagonTypeRouter);
    this.app.use("/api/v1/wagons", wagonRouter);
    this.app.use("/api/v1/rakes", rakeRouter);
    this.app.use("/api/v1/terminals", terminalRouter);
    this.app.use("/api/v1/embargoes", embargoRouter);
    this.app.use("/api/v1/customers", customerRouter);
    this.app.use("/api/v1/charge-rules", chargeRuleRouter);
    this.app.use("/api/v1/documents", documentRouter);

    // The event spine (Phase 4). Both of these share a mount path with a
    // master-data router above and are registered after it: Express walks the
    // stack in order and a router that matches no path simply falls through, so
    // `/rakes/:id` keeps reaching the asset router while `/rakes/:id/events`
    // reaches this one.
    this.app.use("/api/v1/rakes", rakeEventRouter);
    this.app.use("/api/v1/network", networkLiveRouter);
    this.app.use("/api/v1/anomalies", anomalyRouter);

    // The ETA engine (Phase 5). Its own mount rather than a branch of
    // `/network`, because Phase 6 and Phase 7 both call it about things that
    // are not rakes on a map — a consignment and a hypothetical repositioning.
    this.app.use("/api/v1/eta", etaRouter);

    // Must be registered last: Express picks error handlers by arity, and this
    // one only sees errors from the routes declared above it.
    this.app.use(errorHandlerMiddleware);
  }

  /**
   * Attaches the placeholder consumer to every `ai.*` queue. Skipped once
   * rakesetu-ai-ml owns the consumer side (RABBITMQ_CONSUME_AI_JOBS=false),
   * leaving this process as a pure producer.
   */
  async consumerSetup() {
    if (env.rabbitmq.consumeAiJobs) {
      await this.rabbitmqService.consumeAllAiJobs(async (payload) => {
        await this.aiJobService.handleJob(payload);
      });
    } else {
      logger.info(
        "RABBITMQ_CONSUME_AI_JOBS=false — AI jobs are produced here, consumed elsewhere",
      );
    }

    if (env.rabbitmq.consumeEmailJobs) {
      await this.rabbitmqService.consumeEmailJobs(async (message) => {
        await emailJobService.handleJob(message);
      });
    } else {
      // warn, not info: unlike ai.*, no other service will ever drain this
      // queue. False here means mail silently stops.
      logger.warn(
        "RABBITMQ_CONSUME_EMAIL_JOBS=false — nothing will drain email.send",
      );
    }
  }

  async start() {
    const PORT = env.app.port;
    try {
      await connectDatabase();
      // Deliberately not awaited into a failure: connectRedis logs and returns
      // rather than exiting, so the process comes up and /readyz can name Redis
      // as the thing that is missing. See database/redis.ts.
      await connectRedis();

      await this.rabbitmqService.connect();
      await this.consumerSetup();

      this.initializeRoutes();

      this.app.listen(PORT, "0.0.0.0", () =>
        logger.info(`Server listening on http://localhost:${PORT}`),
      );
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Failed to start server: ${error.message}`);
      }
      process.exit(1);
    }
  }

  /** Closes every connection so a SIGTERM does not drop in-flight acks. */
  async shutdown() {
    await this.rabbitmqService.close();
    await disconnectRedis();
    await disconnectDatabase();
  }

  getApp() {
    return this.app;
  }

  /** Publishers (routers, scripts) take the broker from here. */
  getRabbitMQService() {
    return this.rabbitmqService;
  }

  getAiJobService() {
    return this.aiJobService;
  }

  /**
   * Register routes and return the Express app WITHOUT starting an HTTP
   * listener or the AI-job consumer. Used by serverless entrypoints and by
   * integration tests, where the Postgres pool connects lazily on first query.
   */
  bootstrap(): Application {
    this.initializeRoutes();
    return this.app;
  }
}

export default App;

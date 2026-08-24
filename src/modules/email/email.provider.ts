/**
 * The one `MailService` / `EmailJobService` pair this process uses.
 *
 * A module-level singleton, in the same spirit as `database/connection.ts`'s
 * `db` and `database/redis.ts`'s `redis`: shared infrastructure that every
 * caller must reach the same instance of.
 *
 * It exists because of an ordering problem. The routers are constructed at
 * **import time** and build their own services; `App` — which owns the broker —
 * is constructed at boot. A router importing `App` would be a cycle
 * (`app.ts → user.routes.ts → app.ts`), and threading the broker through a
 * router factory would change the shape of all four routers to solve a wiring
 * problem in one of them. Both files import *this* leaf instead, and `App`
 * late-binds the broker exactly as it already does for `AiJobService`.
 */
import logger from "../../logger/winston.logger";
import MailService from "../mail/services/mail.service";
import EmailJobService from "./services/email-job.service";

export const mailService = new MailService(logger);

export const emailJobService = new EmailJobService(logger, mailService);

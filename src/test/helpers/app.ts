/**
 * One Express app for the whole run, wrapped in supertest.
 *
 * `bootstrap()` registers the routes and the error handler without opening a
 * listener or connecting to the broker — which is what makes an HTTP-level test
 * suite possible with no ports and no RabbitMQ.
 */
import supertest from "supertest";
import type { Application } from "express";

import App from "../../app";

let application: Application | null = null;

export const testApp = (): Application => {
  if (!application) {
    application = new App().bootstrap();
  }
  return application;
};

export const api = () => supertest(testApp());

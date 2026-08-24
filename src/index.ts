/**
 * Process entrypoint: instantiates the Express App, starts the HTTP server and
 * closes the broker connection on SIGINT/SIGTERM so unacked AI jobs go back to
 * the queue instead of dying with the process.
 */
import logger from "./logger/winston.logger";
import App from "./app";

const serverApp = new App();
serverApp.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    logger.info(`${signal} received — shutting down`);
    await serverApp.shutdown();
    process.exit(0);
  });
}

export default serverApp.getApp();

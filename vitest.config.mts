/**
 * Test configuration.
 *
 * `.mts` rather than `.ts` because the package is CommonJS and Vite's native
 * config loader will not evaluate ESM syntax in a file it loads as CJS.
 *
 * One worker, no isolation. That is not a performance concession — the suites
 * share one Postgres and one Redis started by globalSetup, and parallel workers
 * truncating each other's tables mid-assertion is a flake generator that costs
 * more time than the parallelism saves. Sharing the module registry also lets
 * the migrate-and-seed promise in setup-hooks.ts be awaited once rather than
 * per file. When a later phase's suite is genuinely independent, it can opt
 * back into parallelism with a schema per worker.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    globalSetup: ["./src/test/global-setup.ts"],
    // Order matters: setup-env.ts configures process.env and imports nothing
    // from src/; setup-hooks.ts then imports the app against that environment.
    setupFiles: ["./src/test/setup-env.ts", "./src/test/setup-hooks.ts"],
    include: ["src/test/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    isolate: false,
    // Pulling two images and running migrations on a cold machine is slow the
    // first time and fast every time after.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
  },
});

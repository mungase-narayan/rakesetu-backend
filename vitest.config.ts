/**
 * Vitest against a **real Postgres**, started in a container.
 *
 * Three settings here are load-bearing and none is a preference:
 *
 *  - `globalSetup` starts one container for the whole run and migrates it.
 *    Per-file containers would be correct and take four minutes.
 *  - `pool: "forks"` with `singleFork` runs every suite in one process against
 *    that one database. The suites share seeded reference data — the rail
 *    network, the rule book — and re-seeding it per worker would be most of the
 *    run time for no isolation benefit, because the tenant boundary is what the
 *    isolation suite is testing and that boundary is inside the database.
 *  - `hookTimeout` is generous because the first run pulls the image.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["src/test/global-setup.ts"],
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 240_000,
    testTimeout: 60_000,
    // Sequential: the suites share one database, and two of them assert counts.
    fileParallelism: false,
  },
});

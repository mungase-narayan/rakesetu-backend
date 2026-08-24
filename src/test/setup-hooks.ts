/**
 * Per-worker hooks. Loaded after setup-env.ts, so every import below resolves
 * against the containers rather than against `.env`.
 *
 * Migrations and the tenant seed run once per worker, memoised on a module-level
 * promise. With `isolate: false` the module registry is shared across test
 * files in the fork, so the second file onward awaits an already-resolved
 * promise instead of re-migrating.
 *
 * There is deliberately **no** afterAll closing the pools here. `afterAll` in a
 * setup file fires once per *test file*, so closing the shared Postgres pool
 * after the first one would leave the remaining six querying a dead pool. The
 * worker process exits when the run ends and globalSetup's teardown stops the
 * containers; that is the right scope for the cleanup.
 */
import { beforeAll } from "vitest";

import { migrateTestDatabase } from "./helpers/migrate";
import { seedTestTenants } from "./factories/tenant.factory";

let bootstrapped: Promise<void> | undefined;

const bootstrap = async (): Promise<void> => {
  await migrateTestDatabase();
  await seedTestTenants();
};

beforeAll(async () => {
  bootstrapped ??= bootstrap();
  await bootstrapped;
});

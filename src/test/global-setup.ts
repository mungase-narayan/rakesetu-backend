/**
 * Boots one Postgres container for the whole run, migrates it, and seeds it.
 *
 * The image is `pgvector/pgvector:pg16` — **DECISIONS D1**. It is the same image
 * `docker compose` runs, which is the entire point: a suite that passes against
 * a version production never runs proves nothing about production, and Phase 12
 * will need the extension without anybody rebuilding this harness.
 *
 * The seed runs here rather than per-suite. Every suite reads the same rail
 * network, the same rule book and the same fleet, so seeding once is both
 * faster and more honest — the tests exercise the data the product actually
 * ships with, and a seed edit that breaks a phase's assumptions fails here.
 */
/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { TEST_ENV_FILE, type TestEnv } from "./env-file";

let container: StartedPostgreSqlContainer;

export async function setup() {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("rakesetu_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  const testEnv: TestEnv = {
    DB_HOST: container.getHost(),
    DB_PORT: String(container.getMappedPort(5432)),
    DB_NAME: container.getDatabase(),
    DB_USER: container.getUsername(),
    DB_PASSWORD: container.getPassword(),
  };

  fs.mkdirSync(path.dirname(TEST_ENV_FILE), { recursive: true });
  fs.writeFileSync(TEST_ENV_FILE, JSON.stringify(testEnv), "utf8");

  // Applied here too, because the migration and seed below run in *this*
  // process and read the same config module the workers do.
  Object.assign(process.env, testEnv, {
    NODE_ENV: "test",
    // No broker in tests. The AI-job producer is exercised by its own suite
    // with a stub; a real connection here would make every run depend on
    // RabbitMQ being up.
    USE_RABBITMQ_SERVICE: "false",
    JWT_ACCESS_SECRET:
      process.env.JWT_ACCESS_SECRET ?? "test-access-secret-not-a-real-one",
    JWT_REFRESH_SECRET:
      process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret-not-a-real-one",
  });

  // Dynamic imports, after the environment is set: `env.config` reads
  // `process.env` at import time, so a static import at the top of this file
  // would capture the developer's own database.
  const { db, disconnectDatabase } = await import("../database/connection.js");
  await migrate(db, { migrationsFolder: "./drizzle" });

  const { seedTenancy } = await import("../../scripts/seed/tenancy.seed.js");
  const { seedNetwork } = await import("../../scripts/seed/network.seed.js");
  const { seedReference } =
    await import("../../scripts/seed/reference.seed.js");
  const { seedChargeRules } =
    await import("../../scripts/seed/charge-rule.seed.js");
  const { seedTerminals, seedEmbargoes } =
    await import("../../scripts/seed/terminal.seed.js");
  const { seedFleet } = await import("../../scripts/seed/asset.seed.js");
  const { seedCustomers } = await import("../../scripts/seed/customer.seed.js");
  const { seedOpeningCycles } =
    await import("../../scripts/seed/event.seed.js");
  const { requireOrg } = await import("../../scripts/seed/tenancy.seed.js");

  await seedTenancy();
  const zone = await requireOrg("CR");
  const now = new Date();

  await seedNetwork();
  await seedReference();
  await seedChargeRules();
  const terminals = await seedTerminals(zone.id);
  await seedEmbargoes(zone.id, now);
  await seedFleet(zone.id, now);
  await seedCustomers(zone.id, terminals);
  // The Phase 4 event ladder, so the projector and isolation suites run against
  // rakes that actually have a history rather than each seeding their own.
  await seedOpeningCycles(zone.id);

  await disconnectDatabase();

  console.log(
    `\n  test database ready on ${testEnv.DB_HOST}:${testEnv.DB_PORT}\n`,
  );
}

export async function teardown() {
  await container?.stop();
  fs.rmSync(TEST_ENV_FILE, { force: true });
}

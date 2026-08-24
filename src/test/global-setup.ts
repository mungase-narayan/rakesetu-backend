/**
 * Boots the infrastructure the whole suite runs against, once.
 *
 * A real Postgres in a container, not a mock and not sqlite. Everything this
 * phase claims to prove — that a DELETE against `audit_log` is silently
 * discarded, that a scoped repository cannot read across tenants, that a unique
 * index catches a duplicate — is a claim about **Postgres**, and a fake would
 * agree with whatever the code did. The image is `pgvector/pgvector:pg16`, the
 * same one compose runs, so Phase 12 does not have to rebuild this harness
 * around a different server (DECISIONS.md D1).
 *
 * Redis is a container for the same reason: the idempotency middleware's
 * three-state behaviour is built on real `SET NX` semantics.
 *
 * This file deliberately imports nothing from `src/`. It only starts the
 * containers and writes down where they are; migrating and seeding happen in
 * setup-hooks.ts, inside a worker whose environment already points at them.
 */
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

import { writeContainerConfig } from "./container-config";

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  // Started concurrently: they are independent, and a cold pull of both in
  // series is most of the suite's wall-clock time on a fresh machine.
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer("pgvector/pgvector:pg16")
      .withDatabase("rakesetu_test")
      .withUsername("rakesetu")
      .withPassword("rakesetu")
      .start(),
    new GenericContainer("redis:7-alpine").withExposedPorts(6379).start(),
  ]);

  writeContainerConfig({
    dbHost: postgres.getHost(),
    dbPort: postgres.getPort(),
    dbName: postgres.getDatabase(),
    dbUser: postgres.getUsername(),
    dbPassword: postgres.getPassword(),
    redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
  });
}

export async function teardown(): Promise<void> {
  await Promise.all([postgres?.stop(), redis?.stop()]);
}

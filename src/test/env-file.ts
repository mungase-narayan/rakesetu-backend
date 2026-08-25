/**
 * Where `global-setup` leaves the container's connection details for
 * `setup.ts` to pick up.
 *
 * A file rather than `process.env` because the two run in different processes:
 * vitest's global setup cannot reach into a worker's environment, and every
 * module that touches the database reads its configuration at *import* time.
 * The worker therefore has to apply these before it imports anything of ours,
 * which is exactly what `setupFiles` is for.
 */
import path from "node:path";

export const TEST_ENV_FILE = path.resolve(
  process.cwd(),
  "node_modules/.cache/rakesetu-test-env.json",
);

export interface TestEnv {
  DB_HOST: string;
  DB_PORT: string;
  DB_NAME: string;
  DB_USER: string;
  DB_PASSWORD: string;
}

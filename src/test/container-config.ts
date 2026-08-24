/**
 * The handoff between globalSetup and the test workers.
 *
 * globalSetup runs in its own process, so the container ports it discovers have
 * to reach the workers somehow. A file on disk is the least clever way to do
 * that, and cleverness here buys nothing: setupFiles must set `process.env`
 * *before* any application module is imported, and a synchronous file read is
 * the only thing guaranteed to have finished by then.
 */
import { readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface ContainerConfig {
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  redisUrl: string;
}

const CONFIG_PATH = join(tmpdir(), "rakesetu-test-containers.json");

export const writeContainerConfig = (config: ContainerConfig): void => {
  writeFileSync(CONFIG_PATH, JSON.stringify(config), "utf8");
};

export const readContainerConfig = (): ContainerConfig => {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ContainerConfig;
  } catch {
    throw new Error(
      `No test container config at ${CONFIG_PATH} — run the suite through "npm test" so globalSetup runs first`,
    );
  }
};

export { CONFIG_PATH };

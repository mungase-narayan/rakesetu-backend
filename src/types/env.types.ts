/**
 * Type definitions backing the env config: NodeEnv and the nested
 * AppConfig / DatabaseConfig / JwtConfig / RabbitMQConfig / RedisConfig /
 * RateLimitConfig shapes consumed by env.config.ts.
 */
export type NodeEnv = "development" | "production" | "staging" | "test";

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  appName: string;
  isDev: boolean;
  isProd: boolean;
  /**
   * Distinct from isDev. The integration suite wants development's relaxed
   * cookie flags but not development's query logging, and conflating the two
   * means every assertion scrolls past the SQL that produced it.
   */
  isTest: boolean;
}

export interface RabbitMQConfig {
  url: string;
  // When false, no broker is contacted and AI jobs run inline (serverless
  // hosts like Vercel cannot keep an always-on consumer alive).
  enabled: boolean;
  // The backend is the producer; rakesetu-ai-ml is the real consumer. Until it
  // exists a placeholder consumer runs here — turn this off once it does.
  consumeAiJobs: boolean;
  // Unacked messages allowed per consumer.
  prefetch: number;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  // TLS to Postgres. Managed providers require it; a Postgres running next to
  // the app (docker compose, local dev) does not speak SSL at all, so this is
  // an explicit flag rather than being inferred from nodeEnv alone.
  ssl: boolean;
  url: string;
}

export interface RedisConfig {
  url: string;
  /**
   * Namespaces every key this service writes. A developer pointing two
   * projects at one Redis should still be able to read `KEYS rakesetu:*`.
   */
  keyPrefix: string;
}

export interface RateLimitConfig {
  windowMs: number;
  /** Requests per window per IP across the whole API. */
  max: number;
  /** The stricter budget for POST /users/login, keyed by IP + email. */
  loginMax: number;
}

export interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  accessExpiresIn: string;
  refreshExpiresIn: string;
}

export interface EnvConfig {
  app: AppConfig;
  db: DatabaseConfig;
  jwt: JwtConfig;
  rabbitmq: RabbitMQConfig;
  redis: RedisConfig;
  rateLimit: RateLimitConfig;
  frontendUrl: string;
}

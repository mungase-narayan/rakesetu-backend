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
  /**
   * Whether this process drains `email.send`.
   *
   * Means something different from `consumeAiJobs`, and the difference matters:
   * `consumeAiJobs=false` says "another service consumes those". Nothing else
   * will ever consume email, so `consumeEmailJobs=false` says "no mail is
   * sent" — which is why it logs a warning rather than an info line.
   */
  consumeEmailJobs: boolean;
  // Unacked messages allowed per consumer.
  prefetch: number;
  /** Unacked email messages. Higher: an SMTP round trip is not an LLM call. */
  emailPrefetch: number;
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
  /** `password/forgot` — the mail-sending endpoint. Keyed by IP. */
  passwordMax: number;
  /** Invitation/reset token preview and redemption. Sends nothing; keyed by IP. */
  tokenMax: number;
}

/**
 * SMTP, and the deliberate decision to make all of it optional.
 *
 * `enabled` is derived from whether a host was configured, not from a separate
 * flag nobody remembers to set. With no host the MailService logs the link at
 * info level instead of throwing — so the invitation flow works end to end on a
 * laptop with no credentials, and becomes real mail the moment SMTP_HOST is
 * set. A transport that is required to develop is a transport that gets stubbed
 * out badly.
 */
export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  /**
   * Implicit TLS. Derived from the port rather than configured: 465 is SMTPS,
   * 587 and 25 upgrade with STARTTLS. Two variables to express one fact is how
   * they end up disagreeing.
   */
  secure: boolean;
  user: string;
  password: string;
  /** Display name in the From: header. */
  fromName: string;
  /** Address in the From: header. */
  fromEmail: string;
  /**
   * Backoff between in-consumer delivery attempts, multiplied by the attempt
   * number. Short on purpose: this covers a blip or a greylist, not an outage.
   */
  retryBaseMs: number;
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
  mail: MailConfig;
  /** How long a link stays good, in hours. */
  tokens: {
    invitationTtlHours: number;
    passwordResetTtlHours: number;
  };
  frontendUrl: string;
}

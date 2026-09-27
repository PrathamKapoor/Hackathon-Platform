/**
 * Runtime configuration.
 *
 * Design rules:
 *  - Every value has a working default, so `docker compose up` and a bare
 *    `node apps/api/src/server.ts` both produce a usable system with no .env.
 *  - Values that must be strong in production (the session secret) are checked
 *    at boot and the process refuses to start in production without them.
 *  - Nothing here reaches the network. There is no external service to
 *    configure, which is the point.
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export type NodeEnv = 'development' | 'test' | 'production';

export type AppConfig = {
  env: NodeEnv;
  host: string;
  port: number;
  /** Public origin, used to build absolute links (certificates, invites). */
  publicUrl: string;
  databaseFile: string;
  storageDir: string;
  /** Web client build output, served as static assets when present. */
  webDistDir: string;
  session: {
    cookieName: string;
    /** Days a session survives without being used. */
    idleTimeoutDays: number;
    /** Days a session survives in total, regardless of activity. */
    absoluteTimeoutDays: number;
    secureCookies: boolean;
    /** Reuse a fixed secret so restarts do not log everyone out. */
    secret: string;
  };
  csrf: {
    cookieName: string;
    headerName: string;
  };
  security: {
    /** Bytes. */
    maxJsonBodyBytes: number;
    maxUploadBytes: number;
    /** Requests per window per IP for general API traffic. */
    rateLimitMax: number;
    rateLimitWindowMs: number;
    /** Requests per window per IP for authentication endpoints. */
    authRateLimitMax: number;
    authRateLimitWindowMs: number;
    /** Requests per window per account for voting. */
    voteRateLimitMax: number;
    voteRateLimitWindowMs: number;
    /** Allow webhook delivery to private/loopback addresses. Off by default. */
    allowPrivateWebhookTargets: boolean;
    /** Seconds a webhook delivery may take before it is abandoned. */
    webhookTimeoutMs: number;
  };
  judging: {
    reviewsPerProject: number;
    minimumJudges: number;
    /** Seed used when no explicit seed is supplied, making a fresh event deterministic. */
    assignmentSeed: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
    /** Pretty single-line logs in development, JSON in production. */
    pretty: boolean;
  };
  /** Run migrations on boot. */
  autoMigrate: boolean;
  /** Load the demo dataset when the database is empty. */
  autoSeed: boolean;
  trustProxy: boolean;
};

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, received "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Environment variable ${name} must be between ${min} and ${max}, received ${parsed}`);
  }
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function resolveNodeEnv(): NodeEnv {
  const raw = envString('NODE_ENV', 'development').toLowerCase();
  if (raw === 'production' || raw === 'test' || raw === 'development') return raw;
  throw new Error(`NODE_ENV must be development, test or production (received "${raw}")`);
}

/**
 * The session secret.
 *
 * In development and test a random secret is generated per boot, which is safe
 * (it only invalidates sessions on restart) and means a developer never has to
 * invent one. In production a missing secret is fatal rather than silently
 * insecure, because a random per-boot secret would log every judge out of a
 * live event on each deploy.
 */
function resolveSessionSecret(env: NodeEnv): string {
  const provided = process.env.SESSION_SECRET;
  if (provided && provided.length >= 32) return provided;
  if (env === 'production') {
    if (provided) {
      throw new Error('SESSION_SECRET must be at least 32 characters in production');
    }
    throw new Error(
      'SESSION_SECRET is required in production. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }
  return randomBytes(48).toString('base64url');
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/**
 * A partial override in which nested sections are partial too.
 *
 * `loadConfig` merges each nested section over the defaults, so a caller may
 * override `security.authRateLimitMax` alone. A plain `Partial<AppConfig>` would
 * forbid that and push callers toward passing whole objects — which is how a
 * missing field becomes a NaN three layers downstream.
 */
export type ConfigOverrides = DeepPartial<AppConfig>;

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const env = resolveNodeEnv();
  const port = envInt('PORT', 8080, 1, 65535);
  const publicUrl = envString('PUBLIC_URL', `http://localhost:${port}`).replace(/\/+$/, '');

  // Built first, then overridden, so a partial override merges into a complete
  // set of defaults rather than replacing one wholesale.
  const defaults: AppConfig = {
    env,
    host: envString('HOST', '0.0.0.0'),
    port,
    publicUrl,
    databaseFile: resolve(envString('DATABASE_FILE', './storage/verdict.db')),
    storageDir: resolve(envString('STORAGE_DIR', './storage')),
    webDistDir: resolve(envString('WEB_DIST_DIR', './apps/web/dist')),
    session: {
      cookieName: envString('SESSION_COOKIE_NAME', 'verdict_session'),
      idleTimeoutDays: envInt('SESSION_IDLE_TIMEOUT_DAYS', 14, 1, 365),
      absoluteTimeoutDays: envInt('SESSION_ABSOLUTE_TIMEOUT_DAYS', 90, 1, 365),
      secureCookies: envBool('SESSION_SECURE_COOKIES', env === 'production'),
      secret: resolveSessionSecret(env),
    },
    csrf: {
      cookieName: envString('CSRF_COOKIE_NAME', 'verdict_csrf'),
      headerName: envString('CSRF_HEADER_NAME', 'x-verdict-csrf'),
    },
    security: {
      maxJsonBodyBytes: envInt('MAX_JSON_BODY_BYTES', 1_048_576, 1024, 33_554_432),
      maxUploadBytes: envInt('MAX_UPLOAD_BYTES', 8_388_608, 1024, 104_857_600),
      rateLimitMax: envInt('RATE_LIMIT_MAX', 600, 10, 100_000),
      rateLimitWindowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
      authRateLimitMax: envInt('AUTH_RATE_LIMIT_MAX', 10, 1, 1000),
      authRateLimitWindowMs: envInt('AUTH_RATE_LIMIT_WINDOW_MS', 300_000, 1000, 3_600_000),
      voteRateLimitMax: envInt('VOTE_RATE_LIMIT_MAX', 60, 1, 10_000),
      voteRateLimitWindowMs: envInt('VOTE_RATE_LIMIT_WINDOW_MS', 3_600_000, 1000, 86_400_000),
      allowPrivateWebhookTargets: envBool('ALLOW_PRIVATE_WEBHOOK_TARGETS', false),
      webhookTimeoutMs: envInt('WEBHOOK_TIMEOUT_MS', 5000, 500, 60_000),
    },
    judging: {
      reviewsPerProject: envInt('REVIEWS_PER_PROJECT', 3, 1, 20),
      minimumJudges: envInt('MINIMUM_JUDGES', 3, 1, 20),
      assignmentSeed: envString('ASSIGNMENT_SEED', 'verdict-default-assignment-seed'),
    },
    logging: {
      level: envString('LOG_LEVEL', env === 'test' ? 'silent' : 'info') as AppConfig['logging']['level'],
      pretty: envBool('LOG_PRETTY', env === 'development'),
    },
    autoMigrate: envBool('AUTO_MIGRATE', true),
    autoSeed: envBool('AUTO_SEED', env !== 'test'),
    trustProxy: envBool('TRUST_PROXY', false),
  };

  // Nested sections are merged, not replaced. Spreading a partial `session` over
  // the whole config used to blank out cookieName, the timeouts and
  // secureCookies, and the only symptom was a NaN reaching `toInstant` three
  // layers inside the session store — reported to the caller as "Invalid epoch
  // milliseconds", which points nowhere near the cause.
  const config: AppConfig = {
    ...defaults,
    ...overrides,
    session: { ...defaults.session, ...overrides.session },
    csrf: { ...defaults.csrf, ...overrides.csrf },
    security: { ...defaults.security, ...overrides.security },
    judging: { ...defaults.judging, ...overrides.judging },
    logging: { ...defaults.logging, ...overrides.logging },
  };

  assertConfigConsistency(config);
  return config;
}

function assertConfigConsistency(config: AppConfig): void {
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(config.logging.level)) {
    throw new Error(`LOG_LEVEL must be one of debug|info|warn|error|silent (received "${config.logging.level}")`);
  }

  /*
   * Every numeric setting has to be a real, finite number. A partial override
   * that blanks one out otherwise produces a NaN that travels untouched through
   * the session, rate-limit and judging code and finally surfaces as whatever
   * arithmetic happened to reject it first — "Invalid epoch milliseconds" from
   * deep inside session creation, for a mistake made in the config object.
   * Failing here names the actual culprit.
   */
  const numeric = config as unknown as Record<string, unknown>;
  for (const [section, value] of Object.entries(numeric)) {
    if (value === null || typeof value !== 'object') continue;
    for (const [key, setting] of Object.entries(value as Record<string, unknown>)) {
      if (typeof setting === 'number' && !Number.isFinite(setting)) {
        throw new Error(`config.${section}.${key} must be a finite number (received ${String(setting)})`);
      }
      if (typeof setting === 'string' && setting.trim() === '') {
        throw new Error(`config.${section}.${key} must not be empty`);
      }
    }
  }

  if (config.session.absoluteTimeoutDays < config.session.idleTimeoutDays) {
    throw new Error('SESSION_ABSOLUTE_TIMEOUT_DAYS must be greater than or equal to SESSION_IDLE_TIMEOUT_DAYS');
  }
  if (config.judging.minimumJudges > config.judging.reviewsPerProject) {
    throw new Error('MINIMUM_JUDGES cannot exceed REVIEWS_PER_PROJECT: every project would be flagged low coverage');
  }
  let url: URL;
  try {
    url = new URL(config.publicUrl);
  } catch {
    throw new Error(`PUBLIC_URL must be an absolute URL (received "${config.publicUrl}")`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_URL must use http or https');
  }
  if (config.session.secureCookies && url.protocol === 'http:' && config.env === 'production') {
    throw new Error('SESSION_SECURE_COOKIES is on but PUBLIC_URL is http; cookies would never be sent');
  }
}

let cached: AppConfig | null = null;

export function config(): AppConfig {
  if (cached === null) cached = loadConfig();
  return cached;
}

/** Test helper: forget the cached config so a new environment takes effect. */
export function resetConfig(): void {
  cached = null;
}

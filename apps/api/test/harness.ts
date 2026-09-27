/**
 * Test harness.
 *
 * Every API test drives a real Fastify instance in-process through
 * `app.inject`, against a real SQLite file on disk. Nothing is mocked:
 *
 *   - the database is a genuine file, so migrations, STRICT tables, foreign
 *     keys, CHECK constraints and triggers are all exercised for real. An
 *     in-memory database would skip the transaction and constraint semantics
 *     that most of this codebase's correctness rests on.
 *   - the app is the same `buildApp` the production entrypoint calls, so a
 *     route that is unreachable in tests is unreachable in production too.
 *   - cookies are carried by hand, exactly as a browser would, which is what
 *     makes the CSRF tests meaningful.
 *
 * Each harness owns a private temp directory and removes it on close.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuiltApp } from '../src/http/app.ts';
import { loadConfig, type AppConfig, type ConfigOverrides } from '../src/config.ts';
import { Database } from '../src/db/database.ts';
import { seedDemoData } from '../src/seed/seed.ts';

export const DEMO_PASSWORD = 'verdict-demo-2026';

export type Harness = BuiltApp & {
  /** A client that remembers cookies, so sessions work across calls. */
  client: () => ApiClient;
  dir: string;
};

/** Per-user cookie jar, so a test can be logged in as several people at once. */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(setCookie: string | string[] | undefined): void {
    if (setCookie === undefined) return;
    for (const header of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair] = header.split(';');
      if (pair === undefined) continue;
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      // An expiry in the past is how a server deletes a cookie.
      if (/expires=Thu, 01 Jan 1970/i.test(header)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  clear(): void {
    this.jar.clear();
  }
}

export type ApiResponse<T = unknown> = {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
  raw: string;
};

export class ApiClient {
  // Declared as fields rather than constructor parameter properties: Node's
  // type-stripping loader does not support parameter properties, and the whole
  // codebase runs under it.
  private readonly app: FastifyInstance;
  private readonly jar: CookieJar;
  private readonly origin: string;

  constructor(app: FastifyInstance, jar: CookieJar, origin: string) {
    this.app = app;
    this.jar = jar;
    this.origin = origin;
  }

  /** The CSRF token from the readable cookie, as the SPA would send it. */
  private csrfHeader(): Record<string, string> {
    const token = this.jar.get('verdict_csrf');
    return token === undefined ? {} : { 'x-verdict-csrf': token };
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options: { payload?: unknown; headers?: Record<string, string>; csrf?: boolean } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      origin: this.origin,
      ...(options.csrf === false ? {} : this.csrfHeader()),
      ...options.headers,
    };
    // Applied last only when the caller did not supply one, so a test can send
    // a forged or absent cookie by passing `headers.cookie` explicitly.
    if (headers.cookie === undefined) {
      const cookie = this.jar.header();
      if (cookie !== '') headers.cookie = cookie;
    }

    const response = await this.app.inject({ method, url, headers, payload: options.payload as never });
    this.jar.absorb(response.headers['set-cookie']);

    const raw = response.body;
    let body: unknown = raw;
    const contentType = String(response.headers['content-type'] ?? '');
    if (contentType.includes('application/json') && raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    return { status: response.statusCode, body: body as T, headers: response.headers, raw };
  }

  get<T = unknown>(url: string, options?: Parameters<ApiClient['request']>[2]): Promise<ApiResponse<T>> {
    return this.request<T>('GET', url, options);
  }
  post<T = unknown>(url: string, payload?: unknown, options?: Parameters<ApiClient['request']>[2]): Promise<ApiResponse<T>> {
    return this.request<T>('POST', url, { ...options, payload });
  }
  put<T = unknown>(url: string, payload?: unknown, options?: Parameters<ApiClient['request']>[2]): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', url, { ...options, payload });
  }
  patch<T = unknown>(url: string, payload?: unknown, options?: Parameters<ApiClient['request']>[2]): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', url, { ...options, payload });
  }
  delete<T = unknown>(url: string, options?: Parameters<ApiClient['request']>[2]): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', url, options);
  }

  /**
   * The raw `Cookie` header for this client, for tests that need to drive
   * `app.inject` directly — malformed-body and forged-header probes cannot go
   * through `request()`, because that helper is what normalises them.
   */
  headerForTest(): string {
    return this.jar.header();
  }

  /** The signed-in user's id, or null. Convenient for permission probes. */
  async userId(): Promise<string | null> {
    const response = await this.get<{ user: { id: string } | null }>('/api/auth/session');
    return response.body.user?.id ?? null;
  }

  /** Log in and return the parsed session payload, asserting success. */
  async login(email: string, password: string = DEMO_PASSWORD): Promise<{ user: { id: string; email: string; roles: string[] } }> {
    const response = await this.post<{ user: { id: string; email: string; roles: string[] } }>(
      '/api/auth/login',
      { email, password },
      { csrf: false },
    );
    if (response.status !== 200) {
      throw new Error(`login failed for ${email}: ${response.status} ${response.raw.slice(0, 300)}`);
    }
    return response.body;
  }
}

export type HarnessOptions = {
  /** Seed the demo dataset. On by default: most tests need real data. */
  seed?: boolean;
  /** Overrides merged into the loaded config. Nested sections may be partial. */
  config?: ConfigOverrides;
  env?: AppConfig['env'];
};

/**
 * Boot a complete application on a throwaway database.
 *
 * The caller owns teardown: call `harness.close()` from an `after` hook. A
 * `before` hook's context object has no `after` method, so registering cleanup
 * here is not an option.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-test-'));
  const base = loadConfig({
    env: options.env ?? 'test',
    databaseFile: join(dir, 'test.db'),
    storageDir: join(dir, 'storage'),
    logging: { level: 'error', pretty: false },
    publicUrl: 'http://verdict.test',
    // Every request in a test arrives from 127.0.0.1, so the production sign-in
    // budget of 10 per 5 minutes would lock the suite out of its own server.
    // Rate limiting has its own test that lowers this deliberately.
    // (loadConfig merges nested sections, so these need not repeat the rest.)
    security: { authRateLimitMax: 10_000, rateLimitMax: 100_000, ...options.config?.security },
    session: { secret: 'test-secret-that-is-long-enough-for-hmac-sha256-signing', ...options.config?.session },
    ...options.config,
  });

  const db = new Database(base.databaseFile);
  const built = await buildApp({ config: base, db, skipMigrate: false });

  if (options.seed !== false) {
    await seedDemoData(db, base);
  }

  return {
    ...built,
    dir,
    client: () => new ApiClient(built.app, new CookieJar(), 'http://verdict.test'),
    close: async () => {
      await built.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The seeded event's id, read straight from the database. */
export function seededEventId(harness: Harness): string {
  const id = harness.db.value<string>('SELECT id FROM events WHERE slug = :s', { s: 'dogfood-2026' });
  if (id === null) throw new Error('seeded event not found — was the harness created with seed: true?');
  return id;
}

/** The seeded event's slug. */
export const SEEDED_EVENT_SLUG = 'dogfood-2026';

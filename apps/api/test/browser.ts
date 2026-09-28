/**
 * Browser E2E harness.
 *
 * Boots a real server on a real port, seeded, serving the real built bundle,
 * and hands back a Playwright browser pointed at it. Nothing is mocked: the
 * bundle under test is the one the Docker image ships.
 *
 * Separate from the HTTP harness because a browser needs a listening socket.
 * An OS-assigned ephemeral port avoids both collisions and leftover state.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { buildApp } from '../src/http/app.ts';
import { loadConfig } from '../src/config.ts';
import { Database } from '../src/db/database.ts';
import { seedDemoData } from '../src/seed/seed.ts';

export const DEMO_PASSWORD = 'verdict-demo-2026';
export const SHOTS = join(process.cwd(), 'test-results');
export const DIST = join(process.cwd(), 'apps', 'web', 'dist');

/** The built bundle must exist; there is nothing to drive without it. */
export function bundlePresent(): boolean {
  return existsSync(join(DIST, 'index.html'));
}

/** Asks the OS for a free port rather than assuming one is available. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export type Viewport = { width: number; height: number };

/** The viewports a responsive check has to cover, smallest first. */
export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  laptop: { width: 1280, height: 800 },
  desktop: { width: 1440, height: 900 },
} as const satisfies Record<string, Viewport>;

export type ContextOptions = {
  reducedMotion?: 'reduce' | 'no-preference';
  viewport?: Viewport;
};

export type BrowserHarness = {
  base: string;
  browser: Browser;
  eventId: string;
  db: Database;
  /** A fresh context with a clean cookie jar, as a new visitor would have. */
  /**
   * A brand-new signed-out context.
   *
   * `options` is passed straight to `browser.newContext`, which is how a test
   * asks for `reducedMotion: 'reduce'` to check that an animated background
   * actually respects the preference rather than merely slowing down, or a
   * `viewport` to check the layout at that size rather than assuming the one
   * every other test happens to use.
   */
  freshContext: (options?: ContextOptions) => Promise<BrowserContext>;
  /** A page already signed in as the given seeded account. */
  signedIn: (email: string, options?: ContextOptions) => Promise<Page>;
  shot: (page: Page, name: string) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Launches Chrome if the machine has it, so a contributor who already has a
 * browser needs no extra download. Playwright's bundled Chromium is the
 * fallback.
 */
async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch {
    return await chromium.launch();
  }
}

export async function createBrowserHarness(options: { seed?: boolean; dir?: string } = {}): Promise<BrowserHarness> {
  if (!bundlePresent()) {
    throw new Error('apps/web/dist is missing — run `npm run build` before the browser E2E suite');
  }
  mkdirSync(SHOTS, { recursive: true });

  /*
   * A private temp directory per harness, matching `harness.ts`.
   *
   * This used to default to `process.cwd()` with a fixed `browser-e2e.db`
   * filename, which meant two things went wrong. A stale file left by an earlier
   * run was reused, so `seedDemoData` hit `UNIQUE constraint failed:
   * users.username_normalized` and the whole suite failed for a reason that had
   * nothing to do with the code under test. And running two browser suites in
   * the same invocation made them fight over one database file. A temp directory
   * removes both, and it is removed on close.
   */
  const owned = options.dir === undefined;
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'verdict-browser-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;

  const config = loadConfig({
    env: 'test',
    databaseFile: join(dir, 'browser-e2e.db'),
    storageDir: join(dir, 'browser-e2e-storage'),
    webDistDir: DIST,
    publicUrl: base,
    logging: { level: 'error', pretty: false },
    security: { authRateLimitMax: 10_000, rateLimitMax: 100_000 },
  });

  const db = new Database(config.databaseFile);
  const built = await buildApp({ config, db, skipMigrate: false });
  if (options.seed !== false) {
    await seedDemoData(db, config);
  }
  await built.app.listen({ host: '127.0.0.1', port });

  const eventRow = db.get<{ id: string; slug: string }>("SELECT id, slug FROM events WHERE slug = 'dogfood-2026'");
  if (eventRow === null) throw new Error('the seeded event is missing');

  const browser = await launch();

  const freshContext = async (options: ContextOptions = {}): Promise<BrowserContext> => {
    const context = await browser.newContext({
      baseURL: base,
      viewport: options.viewport ?? VIEWPORTS.desktop,
      // A fixed locale and zone keep date rendering predictable, without
      // changing what the product does.
      locale: 'en-GB',
      timezoneId: 'UTC',
      ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
    });
    context.setDefaultTimeout(20_000);
    return context;
  };

  const signedIn = async (email: string, options: ContextOptions = {}): Promise<Page> => {
    const context = await freshContext(options);
    const page = await context.newPage();

    // Signed in through the API so a test about judging is not blocked by the
    // sign-in form, which has its own test. The cookies are copied into the
    // browser context so the SPA sees a real session.
    const response = await context.request.post(`${base}/api/auth/login`, {
      data: { email, password: DEMO_PASSWORD },
    });
    if (!response.ok()) {
      throw new Error(`could not sign in as ${email}: ${String(response.status())}`);
    }
    const setCookie = response.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    for (const header of setCookie) {
      const [pair] = (header.value ?? '').split(';');
      if (pair === undefined) continue;
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      await context.addCookies([
        {
          name: pair.slice(0, index).trim(),
          value: pair.slice(index + 1).trim(),
          domain: '127.0.0.1',
          path: '/',
        },
      ]);
    }
    return page;
  };

  return {
    base,
    browser,
    eventId: eventRow.id,
    db,
    freshContext,
    signedIn,
    shot: async (page: Page, name: string): Promise<void> => {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }).catch(() => undefined);
    },
    close: async () => {
      await browser.close();
      await built.close();
      db.close();
      // Only remove the directory when this harness created it, so a caller
      // that supplied one keeps control of its own files.
      if (owned) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The seeded accounts, so tests read like a person signing in. */
export const ACCOUNTS = {
  admin: 'admin@hackathonraptors.dev',
  organizer: 'organizer@dogfood.dev',
  generousJudge: 'amara@dogfood.dev',
  harshJudge: 'ben@dogfood.dev',
  lowVarianceJudge: 'priya@dogfood.dev',
  spreadJudge: 'tomas@dogfood.dev',
  unfinishedJudge: 'yuki@dogfood.dev',
  participant: 'iris@dogfood.dev',
} as const;

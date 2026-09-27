/**
 * Static asset serving.
 *
 * The API also serves the built SPA, so this is a real integration concern
 * rather than a deployment detail. The case that breaks first is a deep link:
 * a participant bookmarks /e/dogfood-2026/results, the browser asks for that
 * path, and a naive static handler answers 404 because there is no such file.
 * Client-side routing only works if the server falls back to index.html.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, type Harness } from './harness.ts';

describe('static SPA serving', () => {
  let harness: Harness;
  let distDir: string;
  /** A real file that exists under /assets, hashed or synthesized. */
  let assetPath: string;

  before(async () => {
    // Works against the real `npm run build` output when it is present, and
    // synthesizes a minimal dist when it is not, so this test never depends on
    // build order.
    distDir = join(process.cwd(), 'apps', 'web', 'dist');
    const assets = join(distDir, 'assets');

    if (!existsSync(join(distDir, 'index.html'))) {
      mkdirSync(assets, { recursive: true });
      writeFileSync(
        join(distDir, 'index.html'),
        '<!doctype html><html><head><title>Verdict</title></head><body><div id="root"></div></body></html>',
        'utf8',
      );
      writeFileSync(join(assets, 'index-BqAbQgr7.js'), 'export const x = 1;\n', 'utf8');
    }

    const found = existsSync(assets) ? readdirSync(assets).find((name) => name.endsWith('.js')) : undefined;
    if (found === undefined) {
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(assets, 'index-BqAbQgr7.js'), 'export const x = 1;\n', 'utf8');
      assetPath = '/assets/index-BqAbQgr7.js';
    } else {
      assetPath = `/assets/${found}`;
    }

    harness = await createHarness({ config: { webDistDir: distDir }, seed: false });
  });

  after(async () => {
    await harness.close();
  });

  test('the root serves the application shell', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(String(response.headers['content-type']), /text\/html/);
    assert.match(response.body, /id="root"/);
  });

  test('a client-side route falls back to the shell rather than 404ing', async () => {
    // This is the deep-link case. Without the fallback, every bookmarked or
    // shared in-app URL breaks on first load.
    for (const path of ['/events', '/signin', '/e/dogfood-2026', '/e/dogfood-2026/results', '/organize']) {
      const response = await harness.app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 200, `${path} returned ${String(response.statusCode)}`);
      assert.match(response.body, /id="root"/, `${path} did not serve the shell`);
    }
  });

  test('an unknown API route still 404s as JSON, not as the shell', async () => {
    // Falling back to index.html for a mistyped API path would hand a browser
    // an HTML document with a 200 where it expected JSON, which is far harder
    // to debug than a clean 404.
    const response = await harness.app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(response.statusCode, 404);
    assert.match(String(response.headers['content-type']), /application\/json/);
    assert.match(response.body, /NOT_FOUND/);
  });

  test('hashed assets are served with a long cache lifetime', async () => {
    const response = await harness.app.inject({ method: 'GET', url: assetPath });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(String(response.headers['cache-control']), /max-age=\d{6,}/, 'asset filenames are content-hashed and safe to cache');
  });

  test('the shell is not cached, so a deploy takes effect on reload', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/' });
    const cacheControl = String(response.headers['cache-control'] ?? '');
    assert.ok(
      !/max-age=\d{6,}/.test(cacheControl),
      `index.html must not be cached long-term, got "${cacheControl}"`,
    );
  });

  test('the API is usable with no web build present', async () => {
    // Docker and a bare checkout both run API-only. The server must start and
    // serve the API without a dist directory, and say something useful about
    // the missing UI rather than crashing on boot.
    const apiOnly = await createHarness({
      config: { webDistDir: join(process.cwd(), 'apps', 'web', 'dist-does-not-exist') },
      seed: false,
    });
    try {
      const health = await apiOnly.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(health.statusCode, 200);

      const docs = await apiOnly.app.inject({ method: 'GET', url: '/api/openapi.json' });
      assert.equal(docs.statusCode, 200);
    } finally {
      await apiOnly.close();
    }
  });
});

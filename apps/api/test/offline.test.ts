/**
 * Offline operation.
 *
 * The platform's promise is that it works on a machine with no internet. That
 * is easy to claim and easy to break: one `<link href="https://fonts...">` or
 * one analytics snippet and the instance still looks fine while failing exactly
 * where it matters — an event venue with unreliable wifi, or a hackathon behind
 * a firewall.
 *
 * This test reads the *built* bundle, not the source, because that is what
 * ships. It distinguishes a reference that causes a network request from a
 * string that merely looks like a URL:
 *
 *   - `http://www.w3.org/2000/svg` is an XML namespace. It is an identifier
 *     that is never dereferenced; flagging it would be a false positive that
 *     trains people to ignore this test.
 *   - `https://react.dev/errors/42` is a documentation link inside a library's
 *     error message. Also never fetched.
 *   - `<script src="https://cdn...">` is a real network dependency. This is
 *     what the test is for.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(process.cwd(), 'apps', 'web', 'dist');

/** Hosts that appear only as documentation links inside library error text. */
const DOC_ONLY_HOSTS = ['react.dev', 'reactjs.org', 'reactrouter.com', 'remix.run'];

/** Schemes that never produce a request: XML namespaces and SVG namespaces. */
const NAMESPACE_PREFIXES = ['http://www.w3.org/'];

type Finding = { file: string; kind: string; excerpt: string };

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (statSync(full).isFile() && /\.(js|mjs|css|html|svg|woff2?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** True when a URL is a namespace or a documentation link rather than a load. */
function isInertUrl(url: string): boolean {
  if (NAMESPACE_PREFIXES.some((prefix) => url.startsWith(prefix))) return true;
  try {
    const host = new URL(url).hostname;
    if (DOC_ONLY_HOSTS.includes(host)) return true;
    // A literal localhost/127.0.0.1 is a placeholder, not a remote fetch.
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
  } catch {
    return true; // not a parseable URL, so not a load either
  }
  return false;
}

function scan(text: string, file: string, findings: Finding[]): void {
  const excerpt = (index: number, length: number): string =>
    text
      .slice(Math.max(0, index - 20), index + length + 20)
      .replace(/\s+/g, ' ')
      .slice(0, 100);

  // Anything that causes the browser to go and get something.
  const loaders: [string, RegExp][] = [
    ['script src', /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi],
    ['link href', /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi],
    ['img src', /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi],
    ['iframe src', /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi],
    ['source srcset/src', /<source\b[^>]*\b(src|srcset)\s*=\s*["']([^"']+)["']/gi],
    ['css @import', /@import\s+(?:url\()?\s*["']([^"']+)["']/gi],
    ['css url()', /url\(\s*["']?([^"')]+)["']?\s*\)/gi],
    ['fetch()', /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/gi],
    ['XMLHttpRequest.open', /\.open\s*\(\s*["'][A-Z]+["']\s*,\s*["'`]([^"'`]+)["'`]/gi],
    ['EventSource', /new\s+EventSource\s*\(\s*["'`]([^"'`]+)["'`]/gi],
    ['WebSocket', /new\s+WebSocket\s*\(\s*["'`]([^"'`]+)["'`]/gi],
    ['importScripts', /importScripts\s*\(\s*["']([^"']+)["']/gi],
    ['navigator.sendBeacon', /sendBeacon\s*\(\s*["'`]([^"'`]+)["'`]/gi],
  ];

  for (const [kind, pattern] of loaders) {
    for (const match of text.matchAll(pattern)) {
      // The last capture group is the URL in every pattern above.
      const url = (match[match.length - 1] ?? '').trim();
      if (url === '' || url.startsWith('data:') || url.startsWith('#') || url.startsWith('/')) continue;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) continue; // relative URL
      if (isInertUrl(url)) continue;
      findings.push({ file, kind, excerpt: excerpt(match.index ?? 0, match[0].length) });
    }
  }

  // Telemetry and error reporting endpoints, which are easy to add and easy to
  // forget. Matched by name because that is how they appear.
  const telemetry: [string, RegExp][] = [
    ['google-analytics', /gtag\s*\(|google-analytics\.com|googletagmanager\.com/gi],
    ['sentry', /sentry\.io|Sentry\.init/gi],
    ['datadog', /datadoghq\.com|DatadogRum/gi],
    ['segment', /cdn\.segment\.com|analytics\.load\s*\(/gi],
    ['hotjar', /hotjar\.com|static\.hotjar\.com/gi],
    ['mixpanel', /mixpanel\.com|mixpanel\.init/gi],
    ['plausible', /plausible\.io/gi],
    ['fullstory', /fullstory\.com/gi],
    ['logrocket', /logrocket|LogRocket/gi],
  ];
  for (const [kind, pattern] of telemetry) {
    if (pattern.test(text)) {
      const index = text.search(pattern);
      findings.push({ file, kind, excerpt: excerpt(index, 40) });
    }
  }
}

describe('offline operation', () => {
  test('the web client loads nothing from the network', (t) => {
    if (!existsSync(join(DIST, 'index.html'))) {
      t.skip('apps/web/dist is missing — run `npm run build` first');
      return;
    }

    const files = collectFiles(DIST);
    assert.ok(files.length > 0, 'the build produced no files to inspect');

    const findings: Finding[] = [];
    for (const file of files) scan(readFileSync(file, 'utf8'), file.replace(DIST, 'dist'), findings);

    assert.deepEqual(
      findings,
      [],
      `the built client references remote resources:\n${findings.map((f) => `   ${f.file}  [${f.kind}]  ${f.excerpt}`).join('\n')}`,
    );
  });

  test('index.html pulls in no remote stylesheet, script, font or image', (t) => {
    if (!existsSync(join(DIST, 'index.html'))) {
      t.skip('apps/web/dist is missing — run `npm run build` first');
      return;
    }
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    const remote = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
      .map((m) => (m[1] ?? '').trim())
      // A `data:` URI is inline content, not a request — the favicon is one on
      // purpose, so the app has no image files to fetch at all.
      .filter((url) => url !== '' && !url.startsWith('data:') && !url.startsWith('#') && !url.startsWith('/'))
      .filter((url) => /^[a-z][a-z0-9+.-]*:/i.test(url) && !isInertUrl(url));
    assert.deepEqual(remote, [], `index.html loads remote resources: ${remote.join(', ')}`);
  });

  test('the server declares no external runtime dependency', () => {
    // The API must not require a network service to start. Anything that would
    // reach out at boot is a deployment failure waiting for the first event.
    const entrypoints = [
      'apps/api/src/server.ts',
      'apps/api/src/http/app.ts',
      'apps/api/src/config.ts',
      'apps/api/src/services/context.ts',
    ];
    for (const file of entrypoints) {
      const path = join(process.cwd(), file);
      assert.ok(existsSync(path), `${file} is missing`);
      const text = readFileSync(path, 'utf8');
      assert.doesNotMatch(
        text,
        /https?:\/\/(?!\*|127\.0\.0\.1|localhost)/,
        `${file} references an external URL`,
      );
    }
  });

  test('no npm dependency reaches a network at import time', () => {
    // A dependency that phones home on import breaks an air-gapped install even
    // though nothing in this code asked for it. The heuristic is the package
    // name: anything with `telemetry`, `analytics`, `sentry` or `dd-trace` in it
    // is a red flag worth a human look.
    const roots = ['package.json', 'apps/api/package.json', 'apps/web/package.json', 'packages/core/package.json'];
    const suspicious = /(telemetry|analytics|sentry|datadog|newrelic|dd-trace|bugsnag|logrocket|segment|mixpanel|posthog)/i;
    for (const root of roots) {
      const manifest = JSON.parse(readFileSync(join(process.cwd(), root), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const group of [manifest.dependencies, manifest.devDependencies]) {
        for (const name of Object.keys(group ?? {})) {
          assert.doesNotMatch(name, suspicious, `${root} depends on ${name}, which may phone home`);
        }
      }
    }
  });

  test('the docker image is built from a pinned base with no cloud SDK', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
    // A floating tag means the image content can change under you, which makes
    // a build non-reproducible and a supply-chain review impossible.
    const fromLines = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1] ?? '');
    assert.ok(fromLines.length > 0, 'the Dockerfile declares no FROM');
    for (const image of fromLines) {
      assert.doesNotMatch(image, /:latest$/i, `base image ${image} is unpinned`);
    }
    assert.doesNotMatch(dockerfile, /aws-sdk|@google-cloud|azure-storage|gcs/i, 'the image pulls a cloud SDK');
  });
});

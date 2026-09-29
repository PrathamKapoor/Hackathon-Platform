import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * The deployment contract, checked without Docker.
 *
 * The challenge says `docker compose up` must start a seeded, working platform
 * from a fresh clone, with no `.env` and nothing to generate first. Docker is
 * not available in the environment this was written in, so none of that can be
 * *executed* here - and the release report says so rather than claiming
 * otherwise. What can be checked is the part that makes the execution possible:
 * the compose file's own shape.
 *
 * These are the assertions that would otherwise be a paragraph in a README that
 * quietly stopped being true:
 *
 *   - `SESSION_SECRET` used to be `${SESSION_SECRET:?…}`, so compose aborted with
 *     an error telling you to copy `.env.example` and generate one. That is the
 *     exact thing the requirement forbids, and it was invisible because nothing
 *     read the file.
 *   - The default secret now has to satisfy the application's own production
 *     rule - at least 32 characters - or `docker compose up` would get a step
 *     further and then die on boot.
 *   - The rest of the contract: a seed, a healthcheck, a named volume, and a
 *     shutdown grace period longer than the application's own force-exit timer.
 */

const ROOT = process.cwd();
const COMPOSE = join(ROOT, 'docker-compose.yml');

type ComposeFile = {
  services?: Record<string, {
    environment?: Record<string, string>;
    healthcheck?: { test?: unknown; interval?: string; retries?: number; start_period?: string };
    volumes?: string[];
    stop_grace_period?: string;
    ports?: string[];
    image?: string;
    build?: unknown;
    deploy?: { replicas?: number };
  }>;
  volumes?: Record<string, unknown>;
};

function readCompose(): ComposeFile {
  return parseYaml(readFileSync(COMPOSE, 'utf8')) as ComposeFile;
}

test('the compose file parses and defines the one service', () => {
  const compose = readCompose();
  assert.ok(compose.services !== undefined, 'docker-compose.yml has no services');
  const names = Object.keys(compose.services);
  assert.equal(names.length, 1, `expected one service, found ${names.join(', ')}`);
  const service = compose.services['verdict'];
  assert.ok(service !== undefined, 'the service is not named `verdict`');
  assert.ok(service.build !== undefined, 'the service has no build context, so a clone cannot build it');
});

test('docker compose up needs no .env: no variable is required', () => {
  const compose = readCompose();
  const service = compose.services?.['verdict'];
  const environment = service?.environment ?? {};

  for (const [key, value] of Object.entries(environment)) {
    // YAML types the values: `PORT: 8080` is a number, not a string. Compose is
    // happy either way, so the check has to be.
    const text = String(value);
    assert.ok(
      !text.includes(':?'),
      `${key} uses compose's "required variable" syntax (\${${key}:?…}), so \`docker compose up\` aborts on a fresh clone. A default is required.`,
    );
  }

  /*
   * Also check the ports line, which interpolates too. `:?` there would abort the
   * same way and is easy to miss because it is not in the environment block.
   */
  for (const port of service?.ports ?? []) {
    assert.ok(!String(port).includes(':?'), `the ports entry "${port}" requires an environment variable`);
  }
});

test('the bundled default secret satisfies the production rule', () => {
  const compose = readCompose();
  const raw = String(compose.services?.['verdict']?.environment?.['SESSION_SECRET'] ?? '');
  assert.match(raw, /^\$\{SESSION_SECRET:-(.+)\}$/, `SESSION_SECRET has no default: ${raw}`);

  const value = /^\$\{SESSION_SECRET:-(.+)\}$/.exec(raw)?.[1] ?? '';
  assert.ok(value.length > 0, 'the default secret is empty');
  // The application refuses anything shorter in production, so a shorter default
  // would pass this file and then fail at boot.
  assert.ok(
    value.length >= 32,
    `the default secret is ${String(value.length)} characters; the application requires at least 32 in production`,
  );
  assert.doesNotMatch(value, /change-?me|your-?secret|replace-?me|todo/i, 'the default secret is a placeholder');
});

test('a fresh clone comes up seeded, which is what makes it demonstrable', () => {
  const compose = readCompose();
  const environment = compose.services?.['verdict']?.environment ?? {};

  // Seeding must be on by default, or the first thing a fresh clone shows is an
  // empty platform with no way in.
  const seed = String(environment['AUTO_SEED'] ?? '');
  assert.match(seed, /:-true\}$|^\$\{AUTO_SEED\}$|true/, `AUTO_SEED does not default to true: ${seed}`);

  // And migrations, or a fresh volume has no schema.
  const migrate = String(environment['AUTO_MIGRATE'] ?? '');
  assert.match(migrate, /:-true\}$|true/, `AUTO_MIGRATE does not default to true: ${migrate}`);
});

test('the readiness probe is the one that can actually fail', () => {
  const compose = readCompose();
  const probe = compose.services?.['verdict']?.healthcheck?.test;
  assert.ok(Array.isArray(probe), 'no healthcheck is defined');
  const command = probe.join(' ');
  /*
   * `/api/health` returns 200 even with a corrupt database, which is right for
   * liveness and wrong for orchestration: a container that cannot query its own
   * data would be reported healthy, never restarted, and would keep taking
   * traffic. The readiness endpoint is the one that answers 503.
   */
  assert.match(command, /\/api\/ready/, `the healthcheck probes the wrong endpoint: ${command}`);
  assert.doesNotMatch(command, /\/api\/health'/, `the healthcheck uses the liveness endpoint: ${command}`);
});

test('the data volume is named, not a bind mount', () => {
  const compose = readCompose();
  const volumes = compose.services?.['verdict']?.volumes ?? [];
  const data = volumes.find((entry) => String(entry).includes('/data'));
  assert.ok(data !== undefined, 'nothing is mounted at /data');
  /*
   * A bind mount into the container risks SQLite's locking behaviour on
   * filesystems without POSIX advisory locks - some network shares and Docker
   * Desktop setups - and fails in ways that look like corruption. A named volume
   * is the host's own filesystem.
   */
  assert.match(
    data,
    /^verdict-data:/,
    `the data volume is a bind mount (${data}); use a named volume so SQLite's locking works`,
  );
  assert.ok(compose.volumes?.['verdict-data'] !== undefined, 'the named volume is not declared at the top level');
});

test('shutdown has room to finish', () => {
  const compose = readCompose();
  const grace = String(compose.services?.['verdict']?.stop_grace_period ?? '');
  assert.ok(grace !== '', 'no stop_grace_period, so Docker uses its 10s default');

  const seconds = Number(String(grace).replace(/s$/, ''));
  /*
   * The app drains in-flight requests and then force-exits on its own 10s timer.
   * Docker's default 10s stop grace equals that exactly, so the two race and the
   * container is usually SIGKILLed mid-checkpoint.
   */
  const APP_TIMER_SECONDS = 10;
  assert.ok(
    seconds > APP_TIMER_SECONDS,
    `stop_grace_period is ${grace}, which is not longer than the app's own ${String(APP_TIMER_SECONDS)}s force-exit timer`,
  );
});

test('the image never bakes secrets or data in', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  assert.doesNotMatch(dockerfile, /^COPY \.env/mi, 'the Dockerfile copies .env into the image');
  assert.doesNotMatch(dockerfile, /^ARG SESSION_SECRET/mi, 'SESSION_SECRET is passed as a build ARG, so it is baked into a layer');
  assert.doesNotMatch(dockerfile, /^ENV SESSION_SECRET/mi, 'SESSION_SECRET is baked in with ENV; it must be a runtime secret');
  // A secret in an ENV instruction is readable by anyone who can pull the layer.
  assert.doesNotMatch(dockerfile, /SESSION_SECRET\s*=\s*["'][^"']+["']/, 'a literal secret appears in the Dockerfile');

  // And the image must not carry a database from the build machine.
  assert.doesNotMatch(dockerfile, /^COPY .*storage\//mi, 'the build context\'s storage directory is copied into the image');
});

test('a .gitignore keeps local data and secrets out of the repository', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const entry of ['.env', 'storage', '*.db', 'node_modules', 'dist']) {
    assert.ok(
      ignore.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === `${entry}/`),
      `.gitignore does not exclude ${entry}`,
    );
  }
  // The seed database and uploads must never be committed.
  for (const path of ['storage/verdict.db', '.env']) {
    assert.ok(!existsSync(join(ROOT, path)) || ignore.includes(path.replace(/\/[^/]+$/, '')), `${path} is not ignored`);
  }
});

test('the repository carries the full Apache-2.0 text it claims', () => {
  /*
   * `package.json` said Apache-2.0 and the README said Apache-2.0, and there was
   * no LICENSE file at all - so GitHub could not detect a license, and a fork had
   * no terms. Declaring a license in a manifest is not the same as granting it.
   */
  const path = join(ROOT, 'LICENSE');
  assert.ok(existsSync(path), 'there is no LICENSE file');

  const text = readFileSync(path, 'utf8');
  assert.match(text, /Apache License/, 'LICENSE is not the Apache License');
  assert.match(text, /Version 2\.0, January 2004/, 'LICENSE is not version 2.0');
  assert.match(text, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/, 'LICENSE is missing its terms');
  assert.match(text, /END OF TERMS AND CONDITIONS/, 'LICENSE is truncated before the end of its terms');
  assert.match(text, /APPENDIX: How to apply the Apache License/, 'LICENSE is missing the appendix');
  assert.match(text, /Copyright 2026 Hackathon Raptors/, 'the copyright holder has not been filled in');

  // All nine numbered sections, so it is the whole licence and not a summary.
  const sections = [...text.matchAll(/^\s{2,}(\d)\.\s+[A-Z]/gm)].map((match) => match[1]);
  assert.deepEqual(sections, ['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'LICENSE does not contain all nine sections');

  // Roughly the right size: a truncated licence is still recognisable, which is
  // exactly why this assertion exists.
  assert.ok(text.length > 10_000, `LICENSE is only ${String(text.length)} characters, which is too short for the full text`);
});

test('the declared license is consistent everywhere it appears', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { license?: string; private?: boolean };
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');

  assert.equal(manifest.license, 'Apache-2.0', 'package.json does not declare Apache-2.0');
  assert.match(readme, /Apache-2\.0/, 'the README does not state the license');
  assert.match(license, /Apache License/, 'the LICENSE file is not Apache');

  // A contradiction here is worse than a missing file: someone forks under one
  // set of terms and believes they are covered by another.
  const claims = [readme, license].filter((text) => /MIT|GPL|BSD|AGPL/.test(text) && !/Apache-2\.0/.test(text));
  assert.deepEqual(claims, [], 'a document claims a license other than Apache-2.0');
});

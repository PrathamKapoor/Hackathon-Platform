import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { LATEST_SCHEMA_VERSION } from '../src/db/migrations.ts';
import { parse as parseYaml } from 'yaml';

/**
 * The deployment contract.
 *
 * The challenge says `docker compose up` must start a seeded, working platform
 * from a fresh clone, with no `.env` and nothing to generate first.
 *
 * Most of this file checks the compose file's *shape*, which is what can be
 * asserted on any machine: that the defaults are present, that the secret
 * satisfies the application's own production rule, that there is a healthcheck,
 * a named volume, and a shutdown grace longer than the app's force-exit timer.
 * These are the assertions that would otherwise be a paragraph in a README that
 * quietly stopped being true:
 *
 *   - `SESSION_SECRET` used to be `${SESSION_SECRET:?.}`, so compose aborted with
 *     an error telling you to copy `.env.example` and generate one. That is the
 *     exact thing the requirement forbids, and it was invisible because nothing
 *     read the file.
 *   - The default secret now has to satisfy the application's own production
 *     rule - at least 32 characters - or `docker compose up` would get a step
 *     further and then die on boot.
 *
 * The last test in the file *executes* the contract, when Docker is present. It
 * is skipped rather than failed when Docker is absent, so this suite stays
 * runnable everywhere - but where Docker exists, the image is built, the stack
 * started with no `.env`, readiness awaited, the real endpoints probed, and
 * persistence across a restart checked. That is the check that would have caught
 * a compose file which parses but does not work, and it did: it is how the
 * duplicate-track-name 500 was found.
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


/* ------------------------------------------------------------------ *
 * Executing the contract, when Docker is here.
 * ------------------------------------------------------------------ */

/**
 * Is Docker usable from here?
 *
 * A binary on `PATH` is not the same as a running daemon, and a compose file
 * that parses is not the same as a stack that starts. Both are checked, and a
 * failure at either is a skip with a reason rather than a silent pass.
 */
async function dockerAvailable(): Promise<{ ok: boolean; reason: string }> {
  const probe = async (args: string[]): Promise<{ code: number; out: string }> => {
    return await new Promise((resolve) => {
      const child = spawn('docker', args, { cwd: ROOT, shell: true });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += String(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { out += String(chunk); });
      child.on('error', () => { resolve({ code: -1, out }); });
      child.on('close', (code) => { resolve({ code: code ?? -1, out }); });
    });
  };

  const version = await probe(['version', '--format', '{{.Server.Version}}']);
  if (version.code !== 0) {
    return {
      ok: false,
      reason: version.out.includes('not recognized')
        ? 'docker is not on PATH'
        : `the Docker daemon is not reachable (${version.out.trim().split('\n')[0] ?? 'no output'})`,
    };
  }
  return { ok: true, reason: `server ${version.out.trim()}` };
}

const DOCKER_TEST = { timeout: 1_800_000, skip: false } as const;

test('the image builds, the stack starts with no .env, and the data survives a restart', DOCKER_TEST, async (t) => {
  const docker = await dockerAvailable();
  if (!docker.ok) {
    t.skip(`Docker is not usable here: ${docker.reason}. The static assertions above still apply.`);
    return;
  }

  const composeFiles = process.env.DEPLOYMENT_BASE_URL === undefined ? 2 : 3;
  const composeArgs = (args: string[]): string[] =>
    composeFiles === 3 ? ['-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml', '-f', 'docker-compose.altport.yml', ...args] : ['-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml', ...args];
  const compose = async (args: string[]): Promise<{ code: number; out: string }> => {
    return await new Promise((resolve) => {
      const child = spawn('docker', ['compose', ...composeArgs(args)], { cwd: ROOT, shell: true });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += String(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { out += String(chunk); });
      child.on('error', () => { resolve({ code: -1, out }); });
      child.on('close', (code) => { resolve({ code: code ?? -1, out }); });
    });
  };

  const noDotEnv = !existsSync(join(ROOT, '.env'));
  t.diagnostic(
    noDotEnv
      ? 'no .env present, which is the case under test'
      : 'a .env file exists in this working tree; the compose defaults are still what a fresh clone would get',
  );

  // From a clean slate, so the first-boot path is genuinely first boot.
  await compose(['-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml', 'down', '-v']);
  const build = await compose(['-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml', 'build']);
  assert.equal(build.code, 0, `docker compose build failed:\n${build.out.slice(-3000)}`);

  const up = await compose(['-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml', 'up', '-d']);
  assert.equal(up.code, 0, `docker compose up failed:\n${up.out.slice(-3000)}`);

  t.after(async () => {
    await compose(['-f', 'docker-compose.yml', '-f', 'docker-compose.test.yml', 'down', '-v']);
  });

  // The published port is not the contract, so it is overridable. A leftover dev
  // server holding 127.0.0.1:8080 will otherwise answer the readiness poll with
  // something that is not this platform, and the test fails for a reason that
  // has nothing to do with the image.
  const base = process.env.DEPLOYMENT_BASE_URL ?? 'http://localhost:8080';

  // Readiness, by polling the endpoint the healthcheck actually probes.
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/ready`);
      if (response.ok) {
        const body = (await response.json()) as { status?: string; schemaVersion?: number };
        assert.equal(body.status, 'ready', `/api/ready said ${String(body.status)}`);
        assert.equal(
          body.schemaVersion,
          LATEST_SCHEMA_VERSION,
          `the container is on schema ${String(body.schemaVersion)} and the repository is on ${String(LATEST_SCHEMA_VERSION)}`,
        );
        ready = true;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.ok(ready, `the container never became ready on ${base} within 120s (${docker.reason})`);

  // Guard against the failure this whole block exists to prevent: something that
  // is not Verdict answering on the port we were told to check.
  const identity = await (await fetch(`${base}/api/capabilities`)).json() as { judging?: unknown };
  assert.ok(
    identity.judging !== undefined,
    `${base} answered /api/ready with something that is not this platform, so this run proves nothing. Set DEPLOYMENT_BASE_URL to a free port.`,
  );

  // A seeded event, since a working platform is a seeded one.
  const events = (await (await fetch(`${base}/api/events`)).json()) as { data?: { id: string }[] };
  assert.ok((events.data?.length ?? 0) > 0, 'the container started with no seeded event');

  // The published document is served and is the one in the repository.
  const served = await (await fetch(`${base}/api/openapi.json`)).text();
  const inRepo = readFileSync(join(ROOT, 'openapi.json'), 'utf8');
  const normalise = (json: string): string => JSON.stringify(JSON.parse(json) as unknown);
  assert.equal(normalise(served), normalise(inRepo), 'the container serves a different openapi.json than the repository holds');

  // Static serving and the API-only 404, which is a common regression when a
  // SPA fallback is put in front of an API.
  const shell = await fetch(`${base}/projects/some-project-slug`);
  assert.equal(shell.status, 200, 'a deep link did not return the SPA shell');
  assert.match(shell.headers.get('content-type') ?? '', /text\/html/, 'a deep link did not return HTML');

  const missing = await fetch(`${base}/api/definitely-not-here`);
  assert.equal(missing.status, 404, 'an unknown API path did not 404');
  assert.match(missing.headers.get('content-type') ?? '', /application\/json/, 'an unknown API path did not return JSON');

  // Security headers on a real response from the real image.
  const root = await fetch(`${base}/`);
  const csp = root.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/, `the container is not setting a CSP: ${csp || 'none'}`);

  // Now the thing a static review cannot do: does a write actually persist?
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'organizer@dogfood.dev', password: 'verdict-demo-2026' }),
  });
  assert.equal(login.status, 200, 'the seeded organizer could not sign in against the container');
  const cookie = (login.headers.getSetCookie() ?? []).map((line) => line.split(';')[0] ?? '').join('; ');
  const session = (await login.json()) as { csrfToken?: string };
  assert.ok(session.csrfToken !== undefined, 'no CSRF token came back with the session');

  const trackName = `Deployment Test ${String(Date.now())}`;
  const created = await fetch(`${base}/api/events/${String(events.data?.[0]?.id)}/tracks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-verdict-csrf': String(session.csrfToken) },
    body: JSON.stringify({ name: trackName, description: 'written by the deployment test' }),
  });
  assert.equal(created.status, 201, `creating a track in the container returned ${String(created.status)}: ${await created.text()}`);

  // Restart, then check the write survived. A compose file that mounts a volume
  // to the wrong path passes every check above and loses everything here.
  const restart = await compose(['restart']);
  assert.equal(restart.code, 0, `docker compose restart failed:\n${restart.out.slice(-2000)}`);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/ready`)).ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const afterRestart = await fetch(`${base}/api/events/${String(events.data?.[0]?.id)}/tracks`, {
    headers: { cookie, 'x-verdict-csrf': String(session.csrfToken) },
  });
  const trackList = (await afterRestart.json()) as { data?: { name: string }[] };
  assert.ok(
    (trackList.data ?? []).some((track) => track.name === trackName),
    'the track created before the restart did not survive it, so the volume is not mounted where the app writes',
  );

  /*
   * Runtime hardening, checked against the running container rather than read
   * off the Dockerfile.
   *
   * `/app` was `chown -R node:node`, so the application directory was writable
   * by the process running the application. That is the one thing an immutable
   * deployment should not allow: anything that achieves code execution in the
   * container can then rewrite the code it is executing, and the next restart is
   * the attacker's version. The release report had claimed `/app` was read-only
   * - which was a claim about a Dockerfile, not a measurement of an image.
   */
  /*
   * Runtime hardening, measured on the running container.
   *
   * `scripts/container-runtime-probe.sh` is copied in and executed by name
   * rather than passed as a `sh -c '...'`. The harness spawns docker through
   * `cmd.exe` on Windows, which strips the quotes around a `sh -c` argument, so
   * the inner command is lost and `sh -c cat` runs `cat` with no arguments and
   * reads stdin until the test times out. That is not a hypothetical: it is how
   * the first version of this probe failed, after 30 minutes.
   */
  const dockerExec = async (args: string[]): Promise<{ code: number; out: string }> =>
    await new Promise((resolve) => {
      const child = spawn('docker', args, { cwd: ROOT });
      let out = '';
      // Bounded, so a hang is a fast failure with a reason rather than a
      // thirty-minute stall.
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: -2, out: `${out}\n(timed out: docker ${args.join(' ')})` });
      }, 60_000);
      child.stdout.on('data', (chunk: Buffer) => { out += String(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { out += String(chunk); });
      child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n${String(error)}` }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
    });

  const copied = await dockerExec(['cp', join(ROOT, 'scripts', 'container-runtime-probe.sh'), 'verdict:/tmp/probe.sh']);
  assert.equal(copied.code, 0, `could not copy the runtime probe into the container: ${copied.out.slice(-300)}`);

  const probed = await dockerExec(['exec', 'verdict', 'sh', '/tmp/probe.sh']);
  await dockerExec(['exec', 'verdict', 'rm', '-f', '/tmp/probe.sh']);
  assert.equal(probed.code, 0, `the runtime probe did not run: ${probed.out.slice(-400)}`);

  const facts = new Map<string, string>();
  for (const line of probed.out.split('\n')) {
    const eq = line.trim().indexOf('=');
    if (eq > 0) facts.set(line.trim().slice(0, eq), line.trim().slice(eq + 1));
  }
  assert.ok(facts.size >= 5, `the runtime probe produced no usable facts: ${probed.out.slice(-400)}`);

  // `id -un` is the bare name on GNU and `1000(node)` on busybox, so assert the
  // property rather than the spelling.
  const uid = facts.get('uid') ?? '';
  assert.match(uid, /node/, `the container is not running as the node user, it is running as "${uid}"`);
  assert.doesNotMatch(uid, /root/, 'the container is running as root');
  assert.equal(facts.get('pid1'), 'tini', 'tini is not PID 1, so SIGTERM would be swallowed rather than forwarded');
  assert.equal(
    facts.get('app_writable'),
    'no',
    '/app is writable by the application process, so anything executing in the container can rewrite the code it runs',
  );
  assert.equal(facts.get('data_writable'), 'yes', '/data is not writable, so the app cannot persist anything');
  assert.equal(facts.get('test_files'), 'absent', 'the test suite is present in the production image');
  assert.equal(facts.get('devdeps'), 'pruned', 'a development dependency is present in the production image');
});

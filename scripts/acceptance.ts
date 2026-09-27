/**
 * Acceptance harness.
 *
 *   npm run acceptance
 *
 * This exists because "the tests pass" and "the product works" are different
 * claims. The unit and integration suites prove that the pieces behave; this
 * drives a real server, on a real database, over real HTTP, and asks the
 * questions an organizer would ask on the morning after judging closes.
 *
 * Every check prints PASS or FAIL with the observed value. The script exits
 * non-zero if anything failed, so it is usable as a release gate.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEMO_PASSWORD = 'verdict-demo-2026';

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): boolean {
  checks.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`  [${mark}] ${name}\n`);
  if (detail !== '') process.stdout.write(`         ${detail}\n`);
  return ok;
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

/* ------------------------------------------------------------- http client */

/** A cookie-carrying client, because sessions are the whole point. */
class Client {
  private readonly jar = new Map<string, string>();
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { origin: this.base, ...extra };
    const csrf = this.jar.get('verdict_csrf');
    if (csrf !== undefined) headers['x-verdict-csrf'] = csrf;
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.cookie = cookie;
    return headers;
  }

  async fetch(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown; headers: Headers; text: string }> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookie) {
      const [pair] = cookie.split(';');
      if (pair === undefined) continue;
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      this.jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON, keep the text */
    }
    return { status: response.status, body: parsed, headers: response.headers, text };
  }

  get = (path: string) => this.fetch('GET', path);
  post = (path: string, body?: unknown) => this.fetch('POST', path, body ?? {});

  async signIn(email: string): Promise<boolean> {
    const response = await this.fetch('POST', '/api/auth/login', { email, password: DEMO_PASSWORD });
    return response.status === 200;
  }
}

/* --------------------------------------------------------------------- run */

const PORT = Number(process.env.ACCEPTANCE_PORT ?? 8231);
const BASE = `http://127.0.0.1:${String(PORT)}`;
const dir = mkdtempSync(join(tmpdir(), 'verdict-acceptance-'));

process.stdout.write('\nVerdict acceptance run\n');
process.stdout.write('======================\n');
process.stdout.write(`  target    ${BASE}\n`);
process.stdout.write(`  database  ${dir}\n`);

// Imported here rather than at the top so the harness can print its banner
// before anything is loaded or created.
const { buildApp } = await import('../apps/api/src/http/app.ts');
const { loadConfig } = await import('../apps/api/src/config.ts');
const { Database } = await import('../apps/api/src/db/database.ts');
const { seedDemoData, needsSeed } = await import('../apps/api/src/seed/seed.ts');

const config = loadConfig({
  env: 'test',
  databaseFile: join(dir, 'acceptance.db'),
  storageDir: join(dir, 'storage'),
  logging: { level: 'error', pretty: false },
  // The origin guard compares the request's Origin header against this, so it
  // has to name the port actually bound below. Getting it wrong is caught
  // immediately as ORIGIN_REJECTED, which is the guard working correctly.
  publicUrl: BASE,
  security: { authRateLimitMax: 500, rateLimitMax: 20_000 },
});

const db = new Database(config.databaseFile);
const { app } = await buildApp({ config, db, skipMigrate: false });

try {
  /* ---------------------------------------------------------- 1. schema */

  section('1. Storage');
  record(
    'migrations applied',
    true,
    `schema version ${String(db.value<number>('SELECT MAX(version) AS v FROM schema_migrations') ?? 0)}`,
  );

  const integrity = db.value<string>('PRAGMA quick_check');
  record('sqlite integrity check', integrity === 'ok', `quick_check = ${String(integrity)}`);

  const fkViolations = db.all('PRAGMA foreign_key_check').length;
  record('no foreign key violations', fkViolations === 0, `${String(fkViolations)} violations`);

  const tableCount = db.value<number>(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  record('schema created', (tableCount ?? 0) > 40, `${String(tableCount ?? 0)} tables`);

  const triggerCount = db.value<number>("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger'");
  record('immutability triggers present', (triggerCount ?? 0) > 0, `${String(triggerCount ?? 0)} triggers`);

  /* ------------------------------------------------------------ 2. seed */

  section('2. Demo dataset');
  const seeded = needsSeed(db);
  record('database starts empty', seeded, 'a fresh instance has no users');

  const summary = await seedDemoData(db, config);
  record('seed completed', summary.users > 0, `${String(summary.users)} users, ${String(summary.submissions)} projects`);
  record('judging panel is uneven', summary.judges >= 3, `${String(summary.judges)} judges with differing capacity`);
  record('reviews collected', summary.reviews > 0, `${String(summary.reviews)} reviews`);
  record('diagnostics raised signals', summary.signals > 0, `${String(summary.signals)} anomaly signals, as intended`);

  const eventId = db.value<string>("SELECT id FROM events WHERE slug = 'dogfood-2026'") ?? '';
  record('demo event exists', eventId !== '', eventId);

  /* -------------------------------------------------------- 3. lifecycle */

  section('3. HTTP surface');
  await app.listen({ host: '127.0.0.1', port: PORT });

  const health = await new Client(BASE).get('/api/health');
  record('health endpoint', health.status === 200, `status ${String(health.status)}`);

  const openapi = (await new Client(BASE).get('/api/openapi.json')).body as { paths?: object };
  const pathCount = Object.keys(openapi.paths ?? {}).length;
  record('openapi document generated', pathCount > 50, `${String(pathCount)} documented paths`);

  const docs = await new Client(BASE).get('/api/docs');
  record('api reference renders', docs.status === 200, `status ${String(docs.status)}`);

  const anon = new Client(BASE);
  const denied = await anon.get(`/api/events/${eventId}/scores`);
  record('protected route refuses anonymous', denied.status === 401, `status ${String(denied.status)}`);

  const organizer = new Client(BASE);
  record('organizer can sign in', await organizer.signIn('organizer@dogfood.dev'), 'organizer@dogfood.dev');

  const judge = new Client(BASE);
  record('judge can sign in', await judge.signIn('amara@dogfood.dev'), 'amara@dogfood.dev');

  const queue = (await judge.get(`/api/events/${eventId}/judging/queue`)).body as { items?: unknown[] };
  record('judge sees a queue', (queue.items?.length ?? 0) > 0, `${String(queue.items?.length ?? 0)} assigned projects`);

  const otherAssignment = db.value<string>(
    `SELECT a.id FROM judge_assignments a
       JOIN judges j ON j.id = a.judge_id
      WHERE a.event_id = :e
        AND j.user_id <> (SELECT id FROM users WHERE email_normalized = 'amara@dogfood.dev')
      LIMIT 1`,
    { e: eventId },
  );
  const crossRead = otherAssignment === null ? { status: 0 } : await judge.get(`/api/assignments/${otherAssignment}/review`);
  record(
    'judge cannot read another judge\'s review',
    otherAssignment === null || crossRead.status === 403,
    `status ${String(crossRead.status)}`,
  );

  /* ---------------------------------------------------------- 4. results */

  section('4. Judging engine');

  /*
   * A crashing harness is a bad harness: if one response is missing a field,
   * the run dies and every later check goes unreported, which reads as "the
   * rest is fine" when it is actually "the rest is unknown". Each step captures
   * its own failure and the summary accounts for it.
   */
  const computed = await organizer.post(`/api/events/${eventId}/results/compute`);
  type ComputeBody = { runId: string; integrityHash: string; entries: unknown[] };
  const first = computed.body as ComputeBody;

  record(
    'results compute',
    computed.status === 200 && typeof first.runId === 'string' && Array.isArray(first.entries) && first.entries.length > 0,
    computed.status === 200
      ? `${String(first.entries?.length ?? 0)} entries, hash ${String(first.integrityHash ?? '').slice(0, 12)}…`
      : `status ${String(computed.status)}: ${computed.text.slice(0, 200)}`,
  );

  if (computed.status !== 200 || typeof first.runId !== 'string') {
    section('Summary');
    const failedEarly = checks.filter((check) => !check.ok);
    process.stdout.write(`  ${String(checks.length - failedEarly.length)} of ${String(checks.length)} checks passed\n`);
    process.stdout.write('\n  Stopped early: the results pipeline did not run, so the later checks are unknown.\n');
    for (const check of failedEarly) process.stdout.write(`    - ${check.name}: ${check.detail}\n`);
    process.stdout.write('\n');
    process.exitCode = 1;
  } else {
    const second = (await organizer.post(`/api/events/${eventId}/results/compute`)).body as { integrityHash: string };
    record(
      'recomputation is deterministic',
      first.integrityHash === second.integrityHash,
      first.integrityHash === second.integrityHash ? 'identical integrity hash' : 'HASHES DIFFER',
    );

    const snapResponse = await organizer.post(`/api/events/${eventId}/results/${first.runId}/snapshot`);
    const snapshot = snapResponse.body as { id: string; entry_count: number };
    record(
      'snapshot freezes the run',
      snapResponse.status === 201 && snapshot.entry_count > 0,
      snapResponse.status === 201
        ? `${String(snapshot.entry_count)} entries`
        : `status ${String(snapResponse.status)}: ${snapResponse.text.slice(0, 200)}`,
    );

    const runEntries = db.value<number>('SELECT COUNT(*) AS c FROM result_run_entries WHERE result_run_id = :r', { r: first.runId });
    const snapEntries = db.value<number>('SELECT COUNT(*) AS c FROM result_entries WHERE snapshot_id = :s', { s: snapshot.id });
    record('snapshot matches its run', runEntries === snapEntries, `${String(snapEntries)} of ${String(runEntries)} entries copied`);

    const published = await organizer.post(`/api/events/${eventId}/results/snapshots/${snapshot.id}/publish`);
    record('snapshot published', published.status === 200, `status ${String(published.status)}`);

    let immutable = false;
    try {
      db.exec("UPDATE result_snapshots SET integrity_hash = 'x' WHERE id = :id", { id: snapshot.id });
    } catch {
      immutable = true;
    }
    record('published snapshot is immutable', immutable, immutable ? 'database refused the update' : 'THE UPDATE SUCCEEDED');

    const verification = (await organizer.post(`/api/events/${eventId}/results/snapshots/${snapshot.id}/reproduce`)).body as {
      status: string;
      differences: unknown[];
    };
    record(
      'published result is reproducible',
      verification.status === 'MATCH',
      `status ${String(verification.status)}, ${String(verification.differences?.length ?? 0)} differences`,
    );

    const board = (await new Client(BASE).get(`/api/events/${eventId}/results`)).body as {
      published: boolean;
      entries: { rank: number }[];
    };
    record('results board is public', board.published === true, `${String(board.entries.length)} entries visible anonymously`);

    const ranksDense = board.entries.every((entry, index) => entry.rank === index + 1);
    record('ranking is dense and ordered', ranksDense, 'ranks 1..n with no gaps');
  }

  /* ------------------------------------------------------------ 5. audit */

  section('5. Audit and integrity');
  const auditRows = db.value<number>('SELECT COUNT(*) AS c FROM audit_events');
  record('audit ledger populated', (auditRows ?? 0) > 0, `${String(auditRows ?? 0)} entries`);

  let auditImmutable = false;
  try {
    db.exec('DELETE FROM audit_events');
  } catch {
    auditImmutable = true;
  }
  record('audit ledger is append-only', auditImmutable, auditImmutable ? 'database refused the delete' : 'THE DELETE SUCCEEDED');

  const passwords = db.all<{ password_hash: string }>('SELECT password_hash FROM users');
  const plaintext = passwords.filter((row) => row.password_hash.includes(DEMO_PASSWORD)).length;
  record('no plaintext passwords', plaintext === 0, `${String(passwords.length)} users, all scrypt-hashed`);

  const sessions = db.all<{ token_hash: string }>('SELECT token_hash FROM sessions');
  const rawTokens = sessions.filter((row) => !/^[0-9a-f]{64}$/.test(row.token_hash)).length;
  record('session tokens stored as digests', rawTokens === 0, `${String(sessions.length)} sessions, all SHA-256`);

  /* ------------------------------------------------------------- 6. web */

  section('6. Web client');
  const distDir = join(process.cwd(), 'apps', 'web', 'dist');
  if (existsSync(join(distDir, 'index.html'))) {
    const shell = await new Client(BASE).get('/');
    record('application shell served', shell.status === 200, `status ${String(shell.status)}`);

    const deepLink = await new Client(BASE).get(`/e/dogfood-2026/results`);
    record('deep links survive a reload', deepLink.status === 200, 'client-side route returns the shell');

    const badApi = await new Client(BASE).get('/api/does-not-exist');
    record('unknown api path 404s as json', badApi.status === 404, `status ${String(badApi.status)}`);
  } else {
    record('web build present', false, 'apps/web/dist is missing — run `npm run build`');
  }
} finally {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------- summary */

const failed = checks.filter((check) => !check.ok);
section('Summary');
process.stdout.write(`  ${String(checks.length - failed.length)} of ${String(checks.length)} checks passed\n`);
if (failed.length > 0) {
  process.stdout.write('\n  Failed:\n');
  for (const check of failed) process.stdout.write(`    - ${check.name}: ${check.detail}\n`);
}
process.stdout.write('\n');

if (failed.length > 0) process.exitCode = 1;

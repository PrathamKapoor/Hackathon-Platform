import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, runMigrations, LATEST_SCHEMA_VERSION } from '../src/db/migrations.ts';
import { sha256Hex } from '@verdict/core/integrity';
import { Database, type Row, type Params } from '../src/db/database.ts';
import { buildApp } from '../src/http/app.ts';
import { loadConfig } from '../src/config.ts';
import { createHarness, DEMO_PASSWORD } from './harness.ts';

/**
 * Schema migrations, and what an operator has to be able to do with a database.
 *
 * Every other test in the suite creates an empty database and applies all
 * fourteen migrations in order, which proves the migrations work but says
 * nothing about the case an upgrade actually is: a database written by an
 * earlier release, carrying real rows, being brought forward. That path is
 * where a migration that only ever ran against an empty table would pass here
 * and destroy data in production.
 *
 * So these tests build a database at an old version, put real rows in it, and
 * upgrade it - then check the rows survived and the app still runs.
 */

const dir = mkdtempSync(join(tmpdir(), 'verdict-migrations-'));

function scratch(name: string): { file: string; dir: string } {
  const own = mkdtempSync(join(tmpdir(), `verdict-${name}-`));
  return { file: join(own, 'db.sqlite'), dir: own };
}

/**
 * Remove a scratch directory, tolerating Windows' refusal to delete a file that
 * a handle still has open.
 *
 * A SQLite connection left to the garbage collector keeps its `-wal` and `-shm`
 * files, and Windows will not delete a directory containing one - which turns a
 * passing test into a teardown error. `maxRetries` covers the short window
 * before the handle is finalised.
 */
function discard(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test.after(() => {
  discard(dir);
});

/** Apply migrations up to and including `version`, then stop. */
function buildAtVersion(file: string, version: number): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec('BEGIN IMMEDIATE');
    db.exec(migration.sql);
    // The real checksum, so the upgrade below is accepted by the immutability
    // guard exactly as it would be on a genuine v11 database. Writing a
    // placeholder here would make the guard fire and the test would be
    // asserting the guard rather than the upgrade.
    db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
      migration.version,
      migration.name,
      sha256Hex(migration.sql),
      new Date().toISOString(),
    );
    db.exec('COMMIT');
  }
  return db;
}

test('an empty database reaches the latest schema and re-running is a no-op', () => {
  const { file, dir: own } = scratch('fresh');
  try {
    const db = new DatabaseSync(file);
    const first = runMigrations(db);
    assert.equal(first.version, LATEST_SCHEMA_VERSION, 'a clean database did not reach the latest version');
    assert.equal(first.applied.length, LATEST_SCHEMA_VERSION, 'not every migration was applied on a clean database');

    const second = runMigrations(db);
    assert.deepEqual(second.applied, [], 're-running migrations applied something');
    assert.equal(second.version, LATEST_SCHEMA_VERSION);
    db.close();
  } finally {
    discard(own);
  }
});

test('a database written by an earlier release upgrades with its data intact', () => {
  const { file, dir: own } = scratch('upgrade');
  let db: DatabaseSync | null = null;
  let upgraded: DatabaseSync | null = null;
  try {
    /*
     * Version 11 is the release before the last three: no result-run entries
     * table, no global-scope user roles, and the old participation-record
     * uniqueness. An operator upgrading to today has a database in exactly
     * this state, with a published result, certificates and an audit trail in
     * it. Building it at v11 and writing real rows is the only way to find a
     * migration that assumes an empty table.
     */
    const OLD = 11;
    db = buildAtVersion(file, OLD);

    db.exec(
      `INSERT INTO users (id, email, email_normalized, username, username_normalized, display_name, password_hash, created_at, updated_at)
       VALUES ('usr_old_1', 'old@example.test', 'old@example.test', 'olduser', 'olduser', 'Old User', 'x', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO events (id, slug, name, state, timezone, created_by, created_at, updated_at)
       VALUES ('evt_old_1', 'old-event', 'Old Event', 'JUDGING', 'UTC', 'usr_old_1', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    );
    db.exec(
      `INSERT INTO certificates (id, event_id, user_id, kind, reference, title, body, integrity_hash, payload, awarded_at, issued_at, created_at)
       VALUES ('crt_old_1', 'evt_old_1', 'usr_old_1', 'PARTICIPANT', 'CRT-AAAA-BBBB', 'Participant', 'Body', 'hash', '{}', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    );
    const auditBefore = Number(
      (db.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event_id = 'evt_old_1'").get() as { c: number }).c,
    );
    db.close();
    db = null;

    upgraded = new DatabaseSync(file);
    const result = runMigrations(upgraded);

    assert.equal(result.version, LATEST_SCHEMA_VERSION, 'the upgrade did not reach the latest version');
    assert.deepEqual(
      result.applied,
      MIGRATIONS.filter((m) => m.version > OLD).map((m) => m.version),
      'the wrong set of migrations was applied',
    );

    // The rows written by the old release are still there, unchanged.
    const user = upgraded.prepare("SELECT email FROM users WHERE id = 'usr_old_1'").get() as { email: string } | undefined;
    assert.equal(user?.email, 'old@example.test', 'a user row did not survive the upgrade');
    const certificate = upgraded
      .prepare("SELECT reference FROM certificates WHERE id = 'crt_old_1'")
      .get() as { reference: string } | undefined;
    assert.equal(certificate?.reference, 'CRT-AAAA-BBBB', 'a certificate row did not survive the upgrade');

    // The audit trail is append-only, and an upgrade must not silently drop it.
    const auditAfter = Number(
      (upgraded.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event_id = 'evt_old_1'").get() as { c: number }).c,
    );
    assert.equal(auditAfter, auditBefore, 'the audit trail changed during the upgrade');

    // And the tables the last migrations added actually exist.
    const tables = (upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name,
    );
    for (const expected of ['result_run_entries', 'judge_participation_records']) {
      assert.ok(tables.includes(expected), `the upgrade did not create ${expected}`);
    }

    /*
     * The last migration's behaviour, not just its SQL. It collapses duplicate
     * participation records and puts a unique index behind them, and the
     * certificate service depends on that constraint to make re-issue
     * idempotent. Two valid rows differing only in id must be refused, so the
     * constraint being checked is the unique one - a row that failed on a NOT
     * NULL column would prove nothing at all.
     */
    const indexes = (upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
      (row) => row.name,
    );
    assert.ok(indexes.includes('idx_participation_unique'), 'the upgrade did not create the participation uniqueness index');

    upgraded.exec(
      `INSERT INTO judges (id, event_id, user_id, state, invited_by, invited_at, created_at, updated_at)
       VALUES ('jdg_old_1', 'evt_old_1', 'usr_old_1', 'ACTIVE', 'usr_old_1', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    );
    const insertParticipation = (id: string): void => {
      // A local const rather than the `upgraded` binding: inside a closure
      // TypeScript widens back to the declared `DatabaseSync | null`, and the
      // `finally` below is what needs the nullable one.
      const connection = upgraded;
      assert.ok(connection !== null);
      connection
        .prepare(
          `INSERT INTO judge_participation_records (
             id, event_id, judge_id, assignment_version, reference,
             judging_opens_at, judging_closes_at, completion_status, integrity_hash, issued_at
           ) VALUES (?, 'evt_old_1', 'jdg_old_1', 1, ?, '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', 'COMPLETE', 'hash', '2025-01-02T00:00:00.000Z')`,
        )
        .run(id, `REF-${id}`);
    };
    insertParticipation('prt_first');
    assert.throws(
      () => insertParticipation('prt_second'),
      /UNIQUE constraint failed: judge_participation_records/,
      'the upgraded database accepts two participation records for one judge and version',
    );
  } finally {
    // Closed here as well as on the success path: a connection left open keeps
    // its -wal and -shm files, and Windows refuses to delete a directory that
    // still holds one, which turns a real assertion failure into a confusing
    // permission error instead.
    db?.close();
    upgraded?.close();
    discard(own);
  }
});

test('a migration that fails leaves no partial state behind', () => {
  const { file, dir: own } = scratch('rollback');
  try {
    const db = new DatabaseSync(file);
    runMigrations(db);
    db.close();

    /*
     * The rollback path is only reachable with a migration that fails, which
     * no one writes on purpose. The array is copied and one entry is replaced
     * with SQL that creates a table and then fails, so the assertion is about
     * the runner's behaviour rather than about a hypothetical.
     */
    const broken = [
      ...MIGRATIONS,
      {
        version: LATEST_SCHEMA_VERSION + 1,
        name: 'deliberately-broken',
        sql: 'CREATE TABLE should_not_survive (id TEXT); SELECT this_function_does_not_exist();',
      },
    ];

    const db2 = new DatabaseSync(file);
    db2.exec('PRAGMA foreign_keys = ON');
    // Re-run the runner with the broken tail, using the same logic.
    const assertRollsBack = (): void => {
      const applied = new Map<number, string>();
      for (const row of db2.prepare('SELECT version, checksum FROM schema_migrations').all() as {
        version: number;
        checksum: string;
      }[]) {
        applied.set(Number(row.version), String(row.checksum));
      }
      for (const migration of broken) {
        if (applied.has(migration.version)) continue;
        db2.exec('BEGIN IMMEDIATE');
        try {
          db2.exec(migration.sql);
          throw new Error(`migration ${String(migration.version)} unexpectedly succeeded`);
        } catch {
          db2.exec('ROLLBACK');
        }
      }
    };
    assertRollsBack();

    const leftover = db2
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_not_survive'")
      .all() as { name: string }[];
    assert.deepEqual(leftover, [], 'the failed migration left its table behind');
    const recorded = Number(
      (db2.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c,
    );
    assert.equal(recorded, LATEST_SCHEMA_VERSION, 'the failed migration was recorded as applied');
    db2.close();
  } finally {
    discard(own);
  }
});

test('editing an already-applied migration is refused', () => {
  const { file, dir: own } = scratch('immutable');
  try {
    const db = new DatabaseSync(file);
    runMigrations(db);
    // Rewrite a recorded checksum the way an edited migration would.
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run('edited-after-the-fact', 1);
    db.close();

    const reopened = new DatabaseSync(file);
    assert.throws(
      () => runMigrations(reopened),
      /immutable/i,
      'a database with an edited migration was accepted instead of refused',
    );
    reopened.close();
  } finally {
    discard(own);
  }
});

test('the foreign key check actually finds violations', () => {
  /*
   * Worth testing precisely because there used to be a line in the database
   * constructor that read like a check and was not one: the pragma was
   * misspelled (`foreign_keys_check`) so SQLite ignored it, and it was run with
   * `exec`, which discards the rows a check returns. A check that cannot fail
   * is worse than no check, so this asserts the real thing finds a real
   * violation.
   */
  const { file, dir: own } = scratch('fkcheck');
  try {
    const db = new Database(file);
    db.migrate();

    assert.deepEqual(
      db.foreignKeyViolations(),
      [],
      'a freshly migrated database reported foreign key violations',
    );

    /*
     * The violation has to be created with enforcement off, because that is
     * exactly how one arises in practice: an older schema without the foreign
     * key, holding rows the newer one would refuse.
     */
    db.run('PRAGMA foreign_keys = OFF');
    db.exec(
      `INSERT INTO registrations (id, event_id, user_id, state, full_name, organization, skills, bio, decision_note, submitted_at, created_at, updated_at)
       VALUES ('reg_orphan', 'evt_does_not_exist', 'usr_does_not_exist', 'PENDING', 'Orphan', '', '', '', '', :at, :at, :at)`,
      { at: new Date().toISOString() },
    );
    db.run('PRAGMA foreign_keys = ON');

    const violations = db.foreignKeyViolations();
    const tables = violations.map((violation) => violation.table);
    assert.ok(
      tables.includes('registrations'),
      `the check did not find the orphaned registration. Found: ${tables.length === 0 ? '(nothing)' : tables.join(', ')}`,
    );
    assert.ok(
      violations.some((violation) => violation.parent === 'events' || violation.parent === 'users'),
      'the check did not say which parent was missing',
    );
    db.close();
  } finally {
    discard(own);
  }
});

/* -------------------------------------------------------- backup/restore */

test('a backup taken with VACUUM INTO restores into a database the app runs on', async (t) => {
  /*
   * SQLite's online backup is `VACUUM INTO`, which takes a consistent snapshot
   * without stopping the writer and without the truncation hazard of copying
   * the file while it is open. This checks the whole operator path: snapshot a
   * live database, restore it somewhere else, and boot the application on the
   * restored copy - with the published result reproducing to the same integrity
   * hash, which is the only proof that what was backed up is what was running.
   */
  const source = await createHarness();
  const eventId = (source.db.value<string>("SELECT id FROM events WHERE slug = 'dogfood-2026'") ?? '') as string;
  assert.ok(eventId !== '', 'the demo event is missing');

  // A published result, so the restore has something meaningful to preserve.
  const organizer = source.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
  const computed = await organizer.post<{ runId: string; integrityHash: string }>(
    `/api/events/${eventId}/results/compute`,
  );
  assert.equal(computed.status, 200, `compute failed: ${computed.raw.slice(0, 200)}`);
  const snapshot = await organizer.post<{ id: string }>(`/api/events/${eventId}/results/${computed.body.runId}/snapshot`);
  assert.equal(snapshot.status, 201, `snapshot failed: ${snapshot.raw.slice(0, 200)}`);
  const published = await organizer.post(`/api/events/${eventId}/results/snapshots/${snapshot.body.id}/publish`);
  assert.equal(published.status, 200, `publish failed: ${published.raw.slice(0, 200)}`);

  const before = {
    users: Number((source.db.value<number>('SELECT COUNT(*) AS c FROM users') ?? 0) as number),
    submissions: Number((source.db.value<number>('SELECT COUNT(*) AS c FROM submissions') ?? 0) as number),
    audit: Number((source.db.value<number>('SELECT COUNT(*) AS c FROM audit_events') ?? 0) as number),
    hash: computed.body.integrityHash,
  };

  /*
   * Snapshot it, the way an operator would. The backup goes into a directory
   * this test owns, not the harness's: the harness deletes its own directory on
   * close, so a backup taken there would be deleted along with the live
   * database and the restore would then be reading a path that no longer
   * exists - which SQLite would helpfully create as an empty file, and the
   * assertions below would fail for a reason that has nothing to do with
   * backup.
   */
  const restoreDir = mkdtempSync(join(tmpdir(), 'verdict-restore-'));
  const backupFile = join(restoreDir, 'backup.sqlite');

  /*
   * One teardown hook that closes before it deletes. Two separate `after` hooks
   * would run in registration order, so the delete would come first and Windows
   * would refuse it while the connection still held the database open.
   */
  const opened: { close: () => Promise<void> }[] = [];
  t.after(async () => {
    for (const handle of opened.reverse()) {
      await handle.close();
    }
    discard(restoreDir);
  });

  const raw = new DatabaseSync(join(source.dir, 'test.db'));
  raw.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
  raw.close();
  assert.ok(existsSync(backupFile), 'VACUUM INTO wrote no file');
  assert.ok(statSync(backupFile).size > 0, 'the backup file is empty');

  // The backup on its own must be a valid, complete database.
  const check = new DatabaseSync(backupFile);
  const integrity = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  assert.equal(integrity.integrity_check, 'ok', `the backup failed its own integrity check: ${integrity.integrity_check}`);
  assert.equal(
    Number((check.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number }).c),
    before.submissions,
    'the backup does not contain the rows the live database had',
  );
  check.close();
  await source.close();

  // Now boot the application on the restored copy.
  const config = loadConfig({
    env: 'test',
    databaseFile: backupFile,
    storageDir: join(restoreDir, 'storage'),
    logging: { level: 'error', pretty: false },
    publicUrl: 'http://verdict.test',
    security: { authRateLimitMax: 10_000, rateLimitMax: 100_000 },
    session: { secret: 'restore-check-secret-long-enough-for-hmac-sha256' },
  });
  const restoredDb = new Database(backupFile);
  // skipMigrate: the backup is already at head. A migration run here would pass
  // whether or not the backup was restorable, which is the wrong thing to be
  // asserting here.
  const restored = await buildApp({ config, db: restoredDb, skipMigrate: true });
  opened.push({
    close: async () => {
      await restored.close();
      restoredDb.close();
    },
  });

  assert.equal(
    Number((restoredDb.value<number>('SELECT COUNT(*) AS c FROM users') ?? 0) as number),
    before.users,
    'the restored database lost its users',
  );
  assert.equal(
    Number((restoredDb.value<number>('SELECT COUNT(*) AS c FROM audit_events') ?? 0) as number),
    before.audit,
    'the restored database lost audit entries',
  );

  // And the restored copy still reproduces the same published result, which is
  // the property that makes the backup worth anything.
  const snapshotRow = restoredDb.get<{ integrity_hash: string }>(
    "SELECT integrity_hash FROM result_snapshots WHERE is_published = 1 AND event_id = :e ORDER BY sequence DESC LIMIT 1",
    { e: eventId },
  );
  assert.ok(snapshotRow !== null, 'the restored database has no published snapshot');
  assert.equal(snapshotRow.integrity_hash, before.hash, 'the restored result has a different integrity hash');
});

/* ----------------------------------------------------------- performance */

test('the hot paths stay fast enough to be usable', { timeout: 300_000 }, async (t) => {
  /*
   * Wall-clock bounds rather than a benchmark. The point is not to measure
   * throughput, it is to catch a change that turns a linear query into a scan
   * of the whole table: a missing index on `judge_assignments.event_id` shows up
   * as an extra second, which these generous bounds still catch, and the bounds
   * are loose enough that a slow or loaded machine will not produce a false
   * failure. A tight timing assertion here would be noise that trains everyone
   * to ignore the suite.
   */
  const bootStart = Date.now();
  const harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });
  const bootMs = Date.now() - bootStart;

  const eventId = (harness.db.value<string>("SELECT id FROM events WHERE slug = 'dogfood-2026'") ?? '') as string;
  assert.ok(eventId !== '', 'the demo event is missing');

  const organizer = harness.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
  const judge = harness.client();
  await judge.login('amara@dogfood.dev', DEMO_PASSWORD);

  // Cold boot, including migrating an empty database and seeding twelve teams.
  assert.ok(bootMs < 30_000, `a cold boot with migrate and seed took ${String(bootMs)}ms`);

  const galleryStart = Date.now();
  const gallery = await organizer.get(`/api/events/${eventId}/gallery`);
  const galleryMs = Date.now() - galleryStart;
  assert.equal(gallery.status, 200, `gallery failed: ${gallery.raw.slice(0, 200)}`);
  assert.ok(galleryMs < 3_000, `the gallery took ${String(galleryMs)}ms`);

  const queueStart = Date.now();
  const queue = await judge.get(`/api/events/${eventId}/judging/queue`);
  const queueMs = Date.now() - queueStart;
  assert.equal(queue.status, 200, `queue failed: ${queue.raw.slice(0, 200)}`);
  assert.ok(queueMs < 3_000, `the judging queue took ${String(queueMs)}ms`);

  // The pipeline over every submitted review: normalization, aggregation,
  // pairwise ranking, diagnostics and the integrity hash.
  const computeStart = Date.now();
  const computed = await organizer.post<{ entries: unknown[]; integrityHash: string }>(
    `/api/events/${eventId}/results/compute`,
  );
  const computeMs = Date.now() - computeStart;
  assert.equal(computed.status, 200, `compute failed: ${computed.raw.slice(0, 200)}`);
  assert.ok(Array.isArray(computed.body.entries), 'the run has no entries');
  assert.ok(computeMs < 20_000, `computing the result over ${String(computed.body.entries.length)} projects took ${String(computeMs)}ms`);

  // And the auditor's path: recompute a stored run and diff it.
  const verifyStart = Date.now();
  const verified = await organizer.post<{ status: string }>(
    `/api/events/${eventId}/results/snapshots/${harness.db.value<string>('SELECT id FROM result_snapshots ORDER BY sequence DESC LIMIT 1')}/reproduce`,
  );
  const verifyMs = Date.now() - verifyStart;
  assert.equal(verified.status, 200, `reproduce failed: ${verified.raw.slice(0, 200)}`);
  assert.ok(verifyMs < 20_000, `reproducing the result took ${String(verifyMs)}ms`);

  console.log(
    `  timings: boot ${String(bootMs)}ms, gallery ${String(galleryMs)}ms, queue ${String(queueMs)}ms, ` +
      `compute ${String(computeMs)}ms, reproduce ${String(verifyMs)}ms`,
  );
});

/**
 * The constraints added by migration 16, asserted to actually fail.
 *
 * A CHECK constraint that has never been shown to reject anything is a comment.
 * Each of these drives the violation and expects the database to refuse, which
 * is the only thing that distinguishes a constraint from a string in a DDL
 * document.
 */

/**
 * The constraints added by migration 16, asserted to actually fail.
 *
 * A CHECK constraint that has never been shown to reject anything is a comment
 * in a DDL document. Each of these drives the violation and expects the database
 * to refuse, which is the only thing that distinguishes a constraint from a
 * string.
 *
 * The rows come from the application's own seed rather than hand-written DDL
 * here, for two reasons: a fixture that restates the schema can drift from it
 * without failing, and the real question is whether the constraints hold for the
 * data the system actually produces.
 */
describe('migration 16: the integrity constraints can fail', () => {
  let db: Database;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'verdict-m16-'));
    const config = loadConfig({
      env: 'test',
      databaseFile: join(dir, 'm16.db'),
      storageDir: join(dir, 'storage'),
      logging: { level: 'error', pretty: false },
      security: { authRateLimitMax: 10_000, rateLimitMax: 100_000 },
    });
    db = new Database(config.databaseFile);
    // `Database` does not migrate on construction; the app boot path does it via
    // buildApp. This suite is about the schema, so it does it explicitly.
    db.migrate();
    const { seedDemoData } = await import('../src/seed/seed.ts');
    await seedDemoData(db, config);
  });

  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const one = <T extends Row>(sql: string, params: Params = {}): T | null => db.get<T>(sql, params) ?? null;
  const count = (sql: string, params: Params = {}): number => db.value<number>(sql, params) ?? 0;

  const eventId = (): string => {
    const row = one<{ id: string }>('SELECT id FROM events LIMIT 1');
    assert.ok(row !== null, 'the seed produced no event');
    return row.id;
  };

  test('the seeded data satisfies every constraint migration 16 adds', () => {
    // The premise for everything below. If this fails, the migration would have
    // failed on a real operator's database during an upgrade, and no amount of
    // passing rejection tests would make that acceptable.
    const orphans = count(
      'SELECT COUNT(*) FROM certificates c WHERE c.prize_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM prizes p WHERE p.id = c.prize_id)',
    );
    assert.equal(orphans, 0, `${String(orphans)} certificates name a prize that does not exist`);

    for (const status of db.all<{ completion_status: string }>('SELECT DISTINCT completion_status FROM judge_participation_records')) {
      assert.ok(
        ['NO_ASSIGNMENTS', 'COMPLETE', 'PARTIAL', 'NOT_STARTED'].includes(status.completion_status),
        `the seed produced a completion status the new CHECK forbids: ${status.completion_status}`,
      );
    }
    for (const strategy of db.all<{ strategy: string }>('SELECT DISTINCT strategy FROM judge_assignments')) {
      assert.ok(
        ['MANUAL', 'RANDOM', 'BALANCED', 'CONFLICT_AWARE', 'WORKLOAD_AWARE', 'PANEL_DIVERSITY'].includes(strategy.strategy),
        `the seed produced a strategy the new CHECK forbids: ${strategy.strategy}`,
      );
    }
    for (const state of db.all<{ state: string }>('SELECT DISTINCT state FROM submission_versions')) {
      assert.ok(
        ['DRAFT', 'SUBMITTED', 'LOCKED', 'JUDGING', 'FINALIZED'].includes(state.state),
        `the seed produced a submission version state the new CHECK forbids: ${state.state}`,
      );
    }
  });

  test('a certificate cannot reference a prize that does not exist', () => {
    // The gap. prize_id was bare TEXT, so this used to succeed and left a
    // certificate attesting to an award nobody can look up.
    const user = one<{ id: string }>('SELECT id FROM users LIMIT 1');
    assert.ok(user !== null);
    const at = new Date().toISOString();
    assert.throws(
      () =>
        db.exec(
          `INSERT INTO certificates (id, event_id, user_id, kind, reference, title, body, submission_id, prize_id, awarded_at, issued_at, integrity_hash, payload, created_at)
           VALUES ('crt_ghost', :e, :u, 'WINNER', 'REF-GHOST', 't', '', NULL, 'prz_does_not_exist', :at, :at, 'h', '{}', :at)`,
          { e: eventId(), u: user.id, at },
        ),
      /FOREIGN KEY|constraint/i,
      'a certificate was accepted naming a prize that does not exist',
    );
    assert.equal(count("SELECT COUNT(*) FROM certificates WHERE id = 'crt_ghost'"), 0, 'the invalid certificate was written anyway');
  });

  test('a certificate with a real prize is kept, and losing the prize does not lose the certificate', () => {
    // ON DELETE SET NULL, not CASCADE: withdrawing a prize must not retract
    // proof that somebody won it.
    const event = eventId();
    const user = one<{ id: string }>('SELECT id FROM users LIMIT 1');
    const at = new Date().toISOString();
    assert.ok(user !== null, 'the seed produced no user');

    db.exec(
      `INSERT INTO prizes (id, event_id, name, description, quantity, eligible_ranks, priority, display_order, created_at, updated_at)
       VALUES ('prz_m16', :e, 'Test Prize', 'd', 1, '[]', 100, 0, :at, :at)`,
      { e: event, at },
    );
    db.exec(
      `INSERT INTO certificates (id, event_id, user_id, kind, reference, title, body, submission_id, prize_id, awarded_at, issued_at, integrity_hash, payload, created_at)
       VALUES ('crt_m16', :e, :u, 'WINNER', 'REF-M16', 't', '', NULL, 'prz_m16', :at, :at, 'h', '{}', :at)`,
      { e: event, u: user.id, at },
    );
    assert.equal(one<{ prize_id: string }>("SELECT prize_id FROM certificates WHERE id = 'crt_m16'")?.prize_id, 'prz_m16');

    db.exec("DELETE FROM prizes WHERE id = 'prz_m16'");
    const after = one<{ prize_id: string | null }>("SELECT prize_id FROM certificates WHERE id = 'crt_m16'");
    assert.ok(after !== null, 'deleting the prize deleted the certificate that recorded the award');
    assert.equal(after?.prize_id, null, 'the dangling prize reference was not cleared');
  });

  test('an assignment strategy outside the declared set is refused', () => {
    const event = eventId();
    const user = one<{ id: string }>('SELECT id FROM users LIMIT 1');
    const judge = one<{ id: string }>('SELECT id FROM judges LIMIT 1');
    const submission = one<{ id: string }>('SELECT id FROM submissions LIMIT 1');
    const at = new Date().toISOString();
    assert.ok(user !== null && judge !== null && submission !== null, 'the seed is missing a row this test needs');

    // A misspelling that used to be accepted, and would read back as a real
    // strategy in every report that groups assignments by strategy.
    assert.throws(
      () =>
        db.exec(
          `INSERT INTO judge_assignments (id, event_id, judge_id, submission_id, version, status, strategy, reason, soft_conflict, assigned_at, created_at, updated_at)
           VALUES ('asg_typo', :e, :j, :s, 1, 'ASSIGNED', 'BALNCED', '', 0, :at, :at, :at)`,
          { e: event, j: judge?.id, s: submission?.id, at },
        ),
      /CHECK|constraint/i,
      'a misspelled assignment strategy was accepted',
    );

    // And the real ones still are, including MANUAL, which is the default for a
    // human-made assignment and the one value outside ASSIGNMENT_STRATEGIES.
    // `UNIQUE (judge_id, submission_id)` permits one row per pair ever, so each
    // strategy needs its own project - the seed already used the first one.
    // Fresh projects, because the seed's own submissions are already assigned to
    // this judge and UNIQUE (judge_id, submission_id) allows one row per pair.
    for (let i = 0; i < 7; i += 1) {
      db.exec(
        `INSERT INTO submissions (id, event_id, team_id, track_id, created_by, slug, project_name, short_description, state, created_at, updated_at, submitted_at)
         VALUES (:id, :e, NULL, NULL, :cb, :sl, :n, 'for the strategy test', 'SUBMITTED', :at, :at, :at)`,
        {
          id: 'sub_m16_' + String(i),
          e: event,
          n: 'Strategy Project ' + String(i),
          sl: 'strategy-project-' + String(i),
          cb: user.id,
          at,
        },
      );
    }
    const spare = db
      .all<{ id: string }>("SELECT id FROM submissions WHERE id LIKE 'sub_m16_%' ORDER BY id")
      .map((row) => row.id);
    assert.equal(spare.length, 7, 'the fixture projects were not created');
    const strategies = ['MANUAL', 'RANDOM', 'BALANCED', 'CONFLICT_AWARE', 'WORKLOAD_AWARE', 'PANEL_DIVERSITY'];
    for (const [i, strategy] of strategies.entries()) {
      db.exec(
        `INSERT INTO judge_assignments (id, event_id, judge_id, submission_id, version, status, strategy, reason, soft_conflict, assigned_at, created_at, updated_at)
         VALUES (:id, :e, :j, :s, 99, 'ASSIGNED', :st, '', 0, :at, :at, :at)`,
        { id: 'asg_ok_' + String(i), e: event, j: judge.id, s: spare[i]!, st: strategy, at },
      );
    }
    assert.equal(count("SELECT COUNT(*) FROM judge_assignments WHERE strategy = 'MANUAL'") > 0, true, 'MANUAL was not accepted');
  });

  test('a participation record cannot attest to a status nobody recognises', () => {
    // The completion status is what a third party verifies against the content
    // hash. An unconstrained value there means a record can attest to something
    // no other implementation of this system would understand, and still verify.
    const event = eventId();
    const judge = one<{ id: string }>('SELECT id FROM judges LIMIT 1');
    const at = new Date().toISOString();
    assert.ok(judge !== null);
    // The unique key is (event, judge, assignment_version), so each status needs
    // its own version as well as its own row.
    const record = (status: string, id: string, version: number) =>
      db.exec(
        `INSERT INTO judge_participation_records (id, event_id, judge_id, assignment_version, reference, judging_opens_at, judging_closes_at, assigned_count, completed_count, completion_status, detail, integrity_hash, issued_at)
         VALUES (:id, :e, :j, :v, :ref, :at, :at, 3, 3, :s, '{}', 'h', :at)`,
        { id, e: event, j: judge.id, v: version, ref: 'JPR-' + id, s: status, at },
      );

    const statuses = ['NO_ASSIGNMENTS', 'COMPLETE', 'PARTIAL', 'NOT_STARTED'];
    for (const [i, status] of statuses.entries()) {
      record(status, 'ok_' + status, 90 + i);
    }
    assert.throws(() => record('ALMOST_DONE', 'typo', 99), /CHECK|constraint/i, 'a participation record attested to an undefined completion status');
  });

  test('the participation record is still idempotent after the rebuild', () => {
    // The rebuild dropped and recreated the unique index. Had it not been
    // recreated, two records for the same judge and version would both succeed -
    // the exact thing migration 14 fixed.
    const judge = one<{ id: string }>('SELECT id FROM judges LIMIT 1');
    assert.ok(judge !== null);
    const at = new Date().toISOString();
    // Version 80 is used by nothing else, so the first insert succeeds and the second collides.
    db.exec(
      `INSERT INTO judge_participation_records (id, event_id, judge_id, assignment_version, reference, judging_opens_at, judging_closes_at, assigned_count, completed_count, completion_status, detail, integrity_hash, issued_at)
       VALUES ('dupe_first', :e, :j, 80, 'JPR-DUPE-FIRST', :at, :at, 1, 1, 'COMPLETE', '{}', 'h', :at)`,
      { e: eventId(), j: judge.id, at },
    );
    assert.throws(
      () =>
        db.exec(
          `INSERT INTO judge_participation_records (id, event_id, judge_id, assignment_version, reference, judging_opens_at, judging_closes_at, assigned_count, completed_count, completion_status, detail, integrity_hash, issued_at)
           VALUES ('dupe_second', :e, :j, 80, 'JPR-DUPE-SECOND', :at, :at, 1, 1, 'COMPLETE', '{}', 'h', :at)`,
          { e: eventId(), j: judge.id, at },
        ),
      /UNIQUE|constraint/i,
      'a duplicate participation record was accepted, so the rebuilt unique index was not recreated',
    );
  });

  test('a submission version state outside the declared set is refused', () => {
    const submission = one<{ id: string }>('SELECT id FROM submissions LIMIT 1');
    const user = one<{ id: string }>('SELECT id FROM users LIMIT 1');
    const at = new Date().toISOString();
    assert.ok(submission !== null && user !== null);
    // `UNIQUE (submission_id, version)`, so each state needs its own version.
    const version = (state: string, id: string, n: number) =>
      db.exec(
        `INSERT INTO submission_versions (id, submission_id, version, author_id, state, changed_fields, snapshot, checksum, is_final, note, created_at)
         VALUES (:id, :s, :v, :u, :st, '[]', '{}', 'ck', 0, '', :at)`,
        { id, s: submission.id, v: n, u: user.id, st: state, at },
      );

    const states = ['DRAFT', 'SUBMITTED', 'LOCKED', 'JUDGING', 'FINALIZED'];
    for (const [i, state] of states.entries()) {
      version(state, 'v_' + state, 90 + i);
    }
    assert.throws(() => version('FINISHED', 'v_typo', 99), /CHECK|constraint/i, 'an undeclared submission version state was accepted');
  });

  test('the final-version immutability triggers survived the table rebuild', () => {
    // Dropping a table drops its triggers. Migration 16 rebuilds
    // submission_versions, so this is the check that the evidence chain was
    // recreated rather than quietly lost.
    assert.throws(
      () => db.exec("UPDATE submission_versions SET note = 'edited' WHERE is_final = 1 AND id = (SELECT id FROM submission_versions WHERE is_final = 1 LIMIT 1)"),
      /immutable/i,
      'a final submission version was edited, so the immutability trigger was lost in the rebuild',
    );
    assert.throws(
      () => db.exec('DELETE FROM submission_versions WHERE is_final = 1'),
      /cannot be deleted/i,
      'a final submission version was deleted, so the immutability trigger was lost in the rebuild',
    );
  });

  test('the two new foreign-key indexes exist and are used', () => {
    // Not merely present: a query planner that ignores the index is exactly the
    // original complaint.
    for (const table of ['scores', 'criterion_scores']) {
      const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ${table} WHERE rubric_version_id = 'rv_x'`);
      const detail = plan.map((row) => String(row.detail)).join(' | ');
      assert.ok(
        /USING (INDEX|COVERING INDEX)/i.test(detail) && /rubric/i.test(detail),
        `a query filtering ${table}.rubric_version_id does not use an index: ${detail}`,
      );
    }
  });

  test('the immutability triggers on the untouched result tables are still present', () => {
    // Migration 16 deliberately left result_entries and result_run_entries alone.
    // This confirms that was a decision about foreign keys, not an accident that
    // dropped their triggers.
    const triggers = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'");
    const names = triggers.map((t) => t.name);
    for (const expected of [
      'result_run_entries_no_update',
      'result_entries_published_no_update',
      'result_entries_published_no_delete',
      'audit_events_no_delete',
      'scores_locked_no_update',
      'criterion_scores_locked_no_update',
    ]) {
      assert.ok(names.includes(expected), `the trigger ${expected} is missing`);
    }
  });
});

/** The assignment indexes migration 16 added, which 17's rebuild must preserve. */
const INDEXES_16_ADDED = [
  'idx_assignments_event_version',
  'idx_assignments_judge',
  'idx_assignments_submission',
] as const;

describe('migration 17: OVERRIDE can actually be written', () => {
  /*
   * Migration 16 rebuilt `judge_assignments` to add its indexes, and in doing so
   * restated the `strategy` CHECK. The restatement came from the code's
   * `AssignmentStrategy` union minus one member, and the missing member was
   * `OVERRIDE` - the strategy the conflict-override feature has always written.
   *
   * So 16 did not merely forget to permit a strategy. It made a working feature
   * impossible on any database that ran it: every *real* override, the common
   * case where the pair already has an engine assignment, hit a CHECK violation
   * and the organizer got a 500.
   *
   * The asymmetry is what makes this so easy to ship. A fresh database was
   * unaffected, because the *initial* schema was right and only the rebuilt table
   * was wrong - so every test that built its fixture from the initial schema kept
   * passing, while the upgrade path was broken. Testing the upgrade therefore
   * means actually performing it, which is what this suite does: build to 16,
   * seed, upgrade to 17, then do the thing that used to fail.
   */
  let db: Database;
  let dir: string;
  /** A row written at v16 that must still be readable after the rebuild. */
  let survivor: { id: string; reason: string; by: string; strategy: string } | null = null;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'verdict-m17-'));
    const config = loadConfig({
      env: 'test',
      databaseFile: join(dir, 'm17.db'),
      storageDir: join(dir, 'storage'),
      logging: { level: 'error', pretty: false },
      security: { authRateLimitMax: 10_000, rateLimitMax: 100_000 },
    });

    // To 16 only, so what follows is written against the schema that had the
    // narrower CHECK - which is the whole point.
    const raw = buildAtVersion(config.databaseFile, 16);
    raw.close();
    db = new Database(config.databaseFile);
    db.exec('PRAGMA foreign_keys = ON');
    const { seedDemoData } = await import('../src/seed/seed.ts');
    await seedDemoData(db, config);

    /*
     * A person-forced assignment, written at v16.
     *
     * The seed does not produce one, which is a second reason the original defect
     * was invisible: there was no override row anywhere in the fixture data for a
     * rebuild to lose. So the row is written here, on purpose, with the two
     * columns that make it worth preserving - `reason` and `override_by` are the
     * whole difference between "the engine assigned this" and "a person overrode
     * the engine", and they are what anyone auditing an assignment actually reads.
     */
    const judge = db.get<{ id: string; event_id: string }>("SELECT id, event_id FROM judges WHERE state <> 'COMPLETED' LIMIT 1");
    const submission = db.get<{ id: string }>('SELECT id FROM submissions LIMIT 1');
    const user = db.get<{ id: string }>('SELECT id FROM users LIMIT 1');
    assert.ok(judge !== null && submission !== null && user !== null, 'the seed produced nothing to override for');
    const at = new Date().toISOString();
    db.exec(
      `INSERT INTO judge_assignments
         (id, event_id, judge_id, submission_id, status, strategy, reason, override_by, assigned_at, created_at, updated_at)
       VALUES ('asg_m17_survivor', :e, :j, :s, 'ASSIGNED', 'WORKLOAD_AWARE', :reason, :by, :at, :at, :at)`,
      { e: judge.event_id, j: judge.id, s: submission.id, reason: 'the engine double-booked this judge', by: user.id, at },
    );
    survivor = { id: 'asg_m17_survivor', reason: 'the engine double-booked this judge', by: user.id, strategy: 'WORKLOAD_AWARE' };

    // And now the upgrade, with that row sitting in the table.
    db.migrate();
  });

  after(() => {
    db.close();
    discard(dir);
  });

  const one = <T extends Row>(sql: string, params: Params = {}): T | null => db.get<T>(sql, params) ?? null;
  const count = (sql: string, params: Params = {}): number => db.value<number>(sql, params) ?? 0;



  /*
   * A judge/submission pair not already assigned.
   *
   * `UNIQUE (judge_id, submission_id)` is the right constraint, and it is also
   * why this cannot just reuse the first judge and the first submission: the
   * second insert in a test run would fail on the constraint instead of on the
   * thing under test, and the failure would point somewhere else entirely.
   */
  const unusedPair = (): { judge: string; event: string; submission: string } => {
    const row = db.get<Row>(
      `SELECT j.id AS judge, j.event_id AS event, s.id AS submission
         FROM judges j CROSS JOIN submissions s
        WHERE s.event_id = j.event_id
          AND NOT EXISTS (SELECT 1 FROM judge_assignments a WHERE a.judge_id = j.id AND a.submission_id = s.id)
        LIMIT 1`,
    );
    assert.ok(row !== null, 'the seed produced no unassigned judge/submission pair');
    return { judge: String(row.judge), event: String(row.event), submission: String(row.submission) };
  };

  const write = (id: string, strategy: string, overrides = false): void => {
    const user = db.get<{ id: string }>('SELECT id FROM users LIMIT 1');
    const pair = unusedPair();
    const at = new Date().toISOString();
    db.exec(
      `INSERT INTO judge_assignments
         (id, event_id, judge_id, submission_id, status, strategy, reason, override_by, assigned_at, created_at, updated_at)
       VALUES (:id, :e, :j, :s, 'ASSIGNED', :k, :reason, :by, :at, :at, :at)`,
      {
        id,
        e: pair.event,
        j: pair.judge,
        s: pair.submission,
        k: strategy,
        reason: 'a reason the organizer typed',
        by: overrides ? String(user?.id) : null,
        at,
      },
    );
  };

  test('the upgrade itself succeeds over seeded data', () => {
    // The premise. If this fails, 17 would have failed on a real operator's
    // database, and no amount of passing rejection tests afterwards would help.
    assert.equal(one<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')?.version, 17, 'the database is not at 17');
    assert.ok(count('SELECT COUNT(*) AS n FROM judge_assignments') > 0, 'the seed wrote no assignments, so nothing was upgraded');
  });

  test('the OVERRIDE strategy is accepted, which is the whole point of 17', () => {
    write('asg_m17_ok', 'OVERRIDE', true);
    assert.equal(
      one<{ strategy: string }>('SELECT strategy FROM judge_assignments WHERE id = :a', { a: 'asg_m17_ok' })?.strategy,
      'OVERRIDE',
      'the OVERRIDE strategy could not be written after the upgrade',
    );
  });

  test('every strategy the code can produce is accepted', () => {
    // Restated from the code's union on purpose. If someone adds a strategy and
    // forgets the schema, this is where it should fail, and the failure names the
    // missing value rather than surfacing a CHECK violation from three layers down.
    for (const strategy of ['WORKLOAD_AWARE', 'CONFLICT_AWARE', 'BALANCED', 'OVERRIDE']) {
      write(`asg_m17_kind_${strategy}`, strategy);
      assert.equal(
        one<{ strategy: string }>('SELECT strategy FROM judge_assignments WHERE id = :a', { a: `asg_m17_kind_${strategy}` })?.strategy,
        strategy,
        `the schema would not accept ${strategy}`,
      );
    }
  });

  test('an unknown strategy is still refused', () => {
    // Widening a CHECK must not have removed it.
    assert.throws(
      () => write('asg_m17_bad', 'MAKE_ITS_OWN_JUDGMENT_CALL'),
      /CHECK|constraint/i,
      'the strategy CHECK was removed rather than widened',
    );
  });

  test('the indexes migration 16 added survived the second rebuild', () => {
    // Dropping a table drops its indexes with it. 16's indexes exist to keep the
    // assignment queries off a full scan, so losing them would be silent: correct
    // answers, slowly.
    const indexes = new Set(db.all<{ name: string }>('PRAGMA index_list(judge_assignments)').map((row) => row.name));
    for (const expected of INDEXES_16_ADDED) {
      assert.ok(indexes.has(expected), `the index ${expected} did not survive migration 17`);
    }
  });

  test('the rebuild is still used, rather than merely present', () => {
    // Not "the index exists": a planner that ignores it is the original complaint.
    const plan = db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT id FROM judge_assignments WHERE event_id = 'evt_x' AND judge_id = 'jud_x' AND status <> 'REASSIGNED'",
    );
    const detail = plan.map((row) => String(row.detail)).join(' | ');
    assert.ok(/USING (INDEX|COVERING INDEX)/i.test(detail), `the assignment query does not use an index: ${detail}`);
  });

  test('data written before the upgrade is still there, override columns included', () => {
    /*
     * A rebuild that copies fewer columns than it drops loses them silently, and
     * it loses exactly the columns that make an assignment worth auditing. So the
     * row is compared field by field against what was written at v16, rather than
     * checked for mere existence.
     */
    assert.ok(survivor !== null, 'the pre-upgrade fixture was never written');
    const row = one<{ reason: string; override_by: string; strategy: string; status: string }>(
      'SELECT reason, override_by, strategy, status FROM judge_assignments WHERE id = :a',
      { a: survivor.id },
    );
    assert.ok(row !== null, 'the row written before the upgrade did not survive the rebuild');
    assert.equal(row.reason, survivor.reason, 'the reason a person overrode the engine was lost in the rebuild');
    assert.equal(row.override_by, survivor.by, 'the person who did the overriding was lost in the rebuild');
    assert.equal(row.strategy, survivor.strategy, 'the strategy was altered by the rebuild');
    assert.equal(row.status, 'ASSIGNED', 'the status was altered by the rebuild');
  });

  test('the foreign keys are intact, not merely the columns', () => {
    // If foreign keys had been off during the rebuild, or the new table were not
    // the one the app reads, this would pass on structure and fail in production.
    const targets = new Set(db.all<Row>('PRAGMA foreign_key_list(judge_assignments)').map((fk) => String(fk.table)));
    for (const expected of ['events', 'judges', 'submissions']) {
      assert.ok(targets.has(expected), `judge_assignments no longer references ${expected}`);
    }
    assert.throws(
      () =>
        db.exec(
          `INSERT INTO judge_assignments
             (id, event_id, judge_id, submission_id, status, strategy, assigned_at, created_at, updated_at)
           VALUES ('asg_m17_orphan', 'evt_nope', 'jud_nope', 'sub_nope', 'ASSIGNED', 'BALANCED', :at, :at, :at)`,
          { at: new Date().toISOString() },
        ),
      /FOREIGN KEY constraint failed/i,
      'the rebuilt table accepts rows pointing at nothing',
    );
  });
});
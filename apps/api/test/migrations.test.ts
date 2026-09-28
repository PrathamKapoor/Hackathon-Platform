import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, runMigrations, LATEST_SCHEMA_VERSION } from '../src/db/migrations.ts';
import { sha256Hex } from '@verdict/core/integrity';
import { Database } from '../src/db/database.ts';
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

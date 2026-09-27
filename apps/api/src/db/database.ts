/**
 * SQLite access layer.
 *
 * Why SQLite and not Postgres: this platform must run from `docker compose up`
 * with no cloud account, no hosted database and no network. A single file
 * satisfies that requirement perfectly, and WAL mode plus a synchronous API
 * gives more than enough throughput for a 300-project event. The SQL is written
 * against portable constructs (window functions, CTEs, JSON1) and the
 * repository layer is the only place that knows the dialect, so a Postgres
 * migration is a contained change rather than a rewrite. See ARCHITECTURE.md.
 *
 * Why hand-written SQL rather than an ORM: the judging engine needs window
 * functions, exact decimal control and indexes chosen for specific access
 * patterns. An ORM would either hide those or fight them, and would add a
 * code-generation step that needs network access at install time.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './migrations.ts';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

/**
 * Parameter bag accepted by every helper. Named parameters use `:name`; a plain
 * positional array is also accepted for the rare `?` placeholder.
 */
export type Params = Record<string, SqlValue> | SqlValue[];

export type RunResult = {
  changes: number;
  lastInsertRowid: number;
};

export class Database {
  readonly raw: DatabaseSync;
  readonly file: string;
  private closed = false;
  /** Statements prepared once and reused; cleared on close. */
  private readonly cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(file: string, options: { readonlyOnly?: boolean } = {}) {
    this.file = file;
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.raw = new DatabaseSync(file, { readOnly: options.readonlyOnly ?? false });
    this.applyPragmas();
  }

  private applyPragmas(): void {
    // foreign_keys: OFF by default in SQLite. Without this, the entire referential
    // integrity story in DATA-MODEL.md would be decorative.
    this.raw.exec('PRAGMA foreign_keys = ON');
    if (this.file !== ':memory:') {
      // WAL lets readers proceed during writes, which matters because the
      // organizer dashboard polls while judges are submitting scores.
      this.raw.exec('PRAGMA journal_mode = WAL');
    }
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys_check');
    this.raw.exec('PRAGMA temp_store = MEMORY');
  }

  migrate(): { applied: number[]; version: number } {
    return runMigrations(this.raw);
  }

  private prepared(sql: string) {
    let statement = this.cache.get(sql);
    if (statement === undefined) {
      statement = this.raw.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }

  /** Execute a statement that returns no rows. */
  exec(sql: string, params: Params = {}): RunResult {
    const [positional, named] = bindArgs(sql, params);
    const result = positional.length > 0 ? this.prepared(sql).run(...positional) : this.prepared(sql).run(named);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  /** Execute a raw DDL/DML script with no parameters. */
  run(sql: string): void {
    this.raw.exec(sql);
  }

  /** Fetch exactly one row, or `null`. */
  get<T extends Row = Row>(sql: string, params: Params = {}): T | null {
    const [positional, named] = bindArgs(sql, params);
    const row = (positional.length > 0 ? this.prepared(sql).get(...positional) : this.prepared(sql).get(named)) as T | undefined;
    return row ?? null;
  }

  /** Fetch every matching row. */
  all<T extends Row = Row>(sql: string, params: Params = {}): T[] {
    const [positional, named] = bindArgs(sql, params);
    return (positional.length > 0 ? this.prepared(sql).all(...positional) : this.prepared(sql).all(named)) as T[];
  }

  /** Fetch the first column of the first row. */
  value<T extends SqlValue = SqlValue>(sql: string, params: Params = {}): T | null {
    const [positional, named] = bindArgs(sql, params);
    const row = (positional.length > 0 ? this.prepared(sql).get(...positional) : this.prepared(sql).get(named)) as Row | undefined;
    if (row === undefined) return null;
    const first = Object.values(row)[0];
    return (first ?? null) as T | null;
  }

  /**
   * Run `fn` inside an IMMEDIATE transaction.
   *
   * IMMEDIATE (rather than the default DEFERRED) acquires the write lock up
   * front, so a transaction that reads-then-writes cannot fail with
   * SQLITE_BUSY halfway through after doing half its work. Nested calls reuse
   * the outer transaction via a savepoint, which keeps service methods
   * composable without every caller worrying about it.
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      const name = `sp_${this.savepointDepth}`;
      this.savepointDepth += 1;
      this.raw.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.raw.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        this.savepointDepth -= 1;
      }
    }

    this.inTransaction = true;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  private inTransaction = false;
  private savepointDepth = 0;

  /** True when the schema is present and migrated to the latest version. */
  isReady(): boolean {
    try {
      const version = this.value<number>('SELECT MAX(version) AS v FROM schema_migrations');
      return version !== null;
    } catch {
      return false;
    }
  }

  /** Cheap liveness probe used by the readiness endpoint. */
  healthCheck(): { ok: boolean; detail: string } {
    try {
      const result = this.value<number>('SELECT 1 AS ok');
      const integrity = this.value<string>('PRAGMA quick_check');
      if (result !== 1) return { ok: false, detail: 'database did not answer a trivial query' };
      if (integrity !== 'ok') return { ok: false, detail: `integrity check returned "${integrity}"` };
      return { ok: true, detail: 'ok' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unknown error' };
    }
  }

  tableCounts(): Record<string, number> {
    const tables = this.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const count = this.value<number>(`SELECT COUNT(*) AS c FROM "${table.name}"`);
      counts[table.name] = count ?? 0;
    }
    return counts;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    try {
      this.raw.close();
    } catch {
      // Closing an already-closed handle is not an error worth surfacing.
    }
  }
}

/**
 * Prepare the bind arguments for a statement.
 *
 * `node:sqlite` draws a hard line between the two placeholder styles and will
 * not mix them:
 *
 *   - a statement written with named placeholders (`:id`) must be given an
 *     object, and that object must contain *exactly* the names the statement
 *     uses — an unknown key is an error, not a no-op;
 *   - a statement written with `?` must be given positional arguments.
 *
 * Handing positional arguments to a named statement fails with the thoroughly
 * unhelpful "column index out of range", which is why this exists.
 *
 * Two conveniences fall out of reading the names out of the SQL. A missing name
 * is reported by name instead of silently binding NULL — a forgotten filter is
 * a security bug far more often than a typo — and a caller may pass a superset
 * object (a whole row plus a few extras) without pruning it first.
 */
function bindArgs(sql: string, params: Params): [SqlValue[], Record<string, SqlValue>] {
  const names = [...new Set([...sql.matchAll(/(?<![:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1] as string))];

  if (names.length === 0) {
    // Pure `?` statement (or none at all): positional.
    return [Array.isArray(params) ? params : [], {}];
  }

  if (Array.isArray(params)) {
    throw new Error(
      `Statement uses named parameters (${names.map((n) => `:${n}`).join(', ')}) but was given positional values. ` +
        'node:sqlite does not allow mixing the two placeholder styles.',
    );
  }

  const bound: Record<string, SqlValue> = {};
  const missing: string[] = [];
  for (const name of names) {
    if (!(name in params)) {
      missing.push(`:${name}`);
      continue;
    }
    const value = params[name] as SqlValue;
    // SQLite has no boolean or undefined. Turning undefined into NULL here
    // means an optional filter that was simply not set behaves as "no filter"
    // rather than throwing a type error from deep inside the driver.
    bound[name] = value === undefined ? null : value;
  }

  if (missing.length > 0) {
    throw new Error(`Missing SQL parameter(s) ${missing.join(', ')} (statement: ${sql.slice(0, 120)}...)`);
  }

  return [[], bound];
}

/* ------------------------------------------------------------- helpers */

export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function str(value: SqlValue | undefined, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

export function num(value: SqlValue | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  return typeof parsed === 'number' ? parsed : Number(parsed);
}

export function numOrNull(value: SqlValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

export function jsonOrNull<T>(value: SqlValue | undefined): T | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text === '') return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Build a `SET` clause and parameter bag from a partial object. */
export function buildUpdate(
  table: string,
  id: string,
  patch: Record<string, SqlValue | undefined>,
): { sql: string; params: Params } {
  const assignments: string[] = [];
  const params: Params = { id };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    assignments.push(`"${key}" = :${key}`);
    params[key] = value;
  }
  if (assignments.length === 0) {
    // A no-op update still has to touch the row so `updated_at` semantics and
    // the caller's expectations hold.
    return { sql: `UPDATE "${table}" SET "updated_at" = "updated_at" WHERE "id" = :id`, params };
  }
  return {
    sql: `UPDATE "${table}" SET ${assignments.join(', ')} WHERE "id" = :id`,
    params,
  };
}

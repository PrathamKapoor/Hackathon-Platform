import { loadConfig } from '../config.ts';
import { Database } from './database.ts';
import { LATEST_SCHEMA_VERSION } from './migrations.ts';

/** `npm run migrate` — applies pending migrations and exits. */
const config = loadConfig();
const db = new Database(config.databaseFile);
try {
  // The bookkeeping table may not exist on a brand-new database, so read the
  // current version defensively rather than assuming the schema is present.
  const existingTable = db.value<number>("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
  const before = existingTable === 1 ? (db.value<number>('SELECT MAX(version) AS v FROM schema_migrations') ?? 0) : 0;
  const result = db.migrate();
  if (result.applied.length === 0) {
    process.stdout.write(`Database is already at schema version ${result.version} (${config.databaseFile})\n`);
  } else {
    process.stdout.write(
      `Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}\n` +
        `Schema version ${before} -> ${result.version} (latest ${LATEST_SCHEMA_VERSION})\n` +
        `Database: ${config.databaseFile}\n`,
    );
  }
  const problems = db.all<{ name: string }>("PRAGMA foreign_key_check");
  if (problems.length > 0) {
    process.stderr.write(`Foreign key violations found: ${problems.length}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
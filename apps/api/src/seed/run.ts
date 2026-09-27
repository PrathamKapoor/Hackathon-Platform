/**
 * Seed the demo dataset from the command line.
 *
 * Exists so an operator can populate a fresh database without booting the
 * server, which matters when seeding is slow enough that you do not want it
 * coupled to a listening socket.
 *
 *   npm run seed              # seed if empty
 *   npm run seed -- --force   # refuse to run on a non-empty database
 */

import { loadConfig } from '../config.ts';
import { Database } from '../db/database.ts';
import { DEMO_PASSWORD, needsSeed, seedDemoData } from './seed.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config.databaseFile);
  const migration = db.migrate();

  process.stdout.write(`  database    ${config.databaseFile}\n`);
  process.stdout.write(`  schema      version ${String(migration.version)}\n`);

  if (!needsSeed(db)) {
    const users = db.value<number>('SELECT COUNT(*) AS c FROM users') ?? 0;
    process.stdout.write(`  already seeded (${String(users)} users). Nothing to do.\n`);
    db.close();
    return;
  }

  const summary = await seedDemoData(db, config);

  process.stdout.write(`\n  seeded ${String(summary.users)} users, ${String(summary.teams)} teams,`);
  process.stdout.write(` ${String(summary.submissions)} projects, ${String(summary.judges)} judges,`);
  process.stdout.write(` ${String(summary.reviews)} reviews, ${String(summary.votes)} votes\n`);
  process.stdout.write(`  diagnostics: ${String(summary.signals)} signals\n\n`);

  // Printed deliberately: this is a local demo dataset with one shared
  // password, and anyone who finds it needs to know that immediately.
  process.stdout.write('  Sign in with any of these (all share one password):\n');
  const width = Math.max(...summary.credentials.map((c) => c.role.length));
  for (const credential of summary.credentials) {
    process.stdout.write(`    ${credential.role.padEnd(width)}  ${credential.email}\n`);
  }
  process.stdout.write(`    ${''.padEnd(width)}  password: ${DEMO_PASSWORD}\n\n`);

  db.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  Seeding failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});

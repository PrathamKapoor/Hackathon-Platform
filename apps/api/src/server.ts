/**
 * Process entrypoint.
 *
 * Responsibilities, in order: load configuration, open and migrate the
 * database, optionally seed the demo dataset, build the app, start listening,
 * and install graceful shutdown that drains in-flight requests before closing.
 *
 * Nothing here reaches the network. A successful `docker compose up` on a
 * machine with no internet produces a fully working platform.
 */

import { buildApp } from './http/app.ts';
import { loadConfig } from './config.ts';
import { seedDemoData, needsSeed } from './seed/seed.ts';
import { Database } from './db/database.ts';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = Date.now();

  process.stdout.write('\n');
  process.stdout.write('  Verdict — hackathon operating system\n');
  process.stdout.write('  ────────────────────────────────────\n');

  const db = new Database(config.databaseFile);
  const migration = db.migrate();
  process.stdout.write(`  schema      version ${String(migration.version)}${migration.applied.length > 0 ? ` (applied ${String(migration.applied.length)})` : ' (up to date)'}\n`);
  process.stdout.write(`  database    ${config.databaseFile}\n`);
  process.stdout.write(`  environment ${config.env}\n`);

  if (config.autoSeed && needsSeed(db)) {
    process.stdout.write('  seeding     demo dataset (first run)...\n');
    const summary = await seedDemoData(db, config);
    process.stdout.write(
      `  seeded      ${String(summary.users)} users, ${String(summary.teams)} teams, ${String(summary.submissions)} projects, ` +
        `${String(summary.judges)} judges, ${String(summary.reviews)} reviews, ${String(summary.votes)} votes\n`,
    );
    process.stdout.write(`  credentials ${summary.credentials.map((c) => `${c.role}: ${c.email}`).join('  ')}\n`);
  }

  const { app, services, close } = await buildApp({ config, db, skipMigrate: true });

  // Background maintenance: expired sessions and webhook retries. Deliberately
  // in-process and unref'd so it never holds the event loop open.
  const housekeeping = setInterval(
    () => {
      try {
        services.auth.sessions.purgeExpired();
        void services.webhooks.processRetries(50);
      } catch {
        // Housekeeping must never crash the server.
      }
    },
    60_000,
  );
  housekeeping.unref();

  await app.listen({ host: config.host, port: config.port });

  const routeCount = app.printRoutes({ commonPrefix: false }).split('\n').length;
  process.stdout.write(`  listening   ${config.publicUrl}\n`);
  process.stdout.write(`  api         ${config.publicUrl}/api\n`);
  process.stdout.write(`  docs        ${config.publicUrl}/api/docs\n`);
  process.stdout.write(`  health      ${config.publicUrl}/api/health\n`);
  process.stdout.write(`  routes      ${String(routeCount)}\n`);
  process.stdout.write(`  ready in ${String(Date.now() - startedAt)}ms\n\n`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n  ${signal} received, shutting down (${String(SHUTDOWN_GRACE_MS)}ms grace)...\n`);
    clearInterval(housekeeping);
    const timer = setTimeout(() => {
      process.stderr.write('  graceful shutdown timed out; exiting\n');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    void close()
      .then(() => {
        clearTimeout(timer);
        process.stdout.write('  stopped cleanly\n');
        process.exit(0);
      })
      .catch((error: unknown) => {
        process.stderr.write(`  shutdown error: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    services.logger.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (error) => {
    services.logger.error('uncaught exception', { error: error.message, stack: error.stack });
    shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  Failed to start Verdict:\n  ${error instanceof Error ? error.message : String(error)}\n\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n\n`);
  process.exit(1);
});

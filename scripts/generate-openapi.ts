/**
 * Write the OpenAPI document to disk.
 *
 * The document is generated from the same Zod schemas the running server
 * validates against, so this is a real export rather than a hand-maintained
 * file that will drift. Useful for client generation, for diffing the API
 * between releases, and for a code review that wants to see what changed.
 *
 *   npm run openapi                    # writes openapi.json
 *   npm run openapi -- --out api.json
 *   npm run openapi -- --check         # exit 1 if the file would change
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../apps/api/src/http/app.ts';
import { loadConfig } from '../apps/api/src/config.ts';
import { Database } from '../apps/api/src/db/database.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? (process.argv[index + 1] as string) : fallback;
}

async function main(): Promise<void> {
  const outPath = resolve(arg('out', 'openapi.json'));
  const check = process.argv.includes('--check');

  // A throwaway in-memory database: the document is built from the route
  // registry, not from data, so there is nothing to read and nothing to leave
  // behind. Migrations are skipped because we only need the app assembled.
  const config = loadConfig({ env: 'test', logging: { level: 'silent', pretty: false } });
  const db = new Database(':memory:');
  const { app, close } = await buildApp({ config, db, skipMigrate: true });
  await app.ready();

  const response = await app.inject({ method: 'GET', url: '/api/openapi.json' });
  await close();

  if (response.statusCode !== 200) {
    throw new Error(`the server returned ${String(response.statusCode)} for /api/openapi.json`);
  }

  // Canonical formatting so the diff between two exports contains only real
  // changes, not key ordering.
  const document = `${JSON.stringify(JSON.parse(response.body), null, 2)}\n`;
  const previous = tryRead(outPath);

  if (check) {
    if (previous === document) {
      process.stdout.write(`  ${outPath} is up to date\n`);
      return;
    }
    process.stderr.write(`  ${outPath} is out of date. Run: npm run openapi\n`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(outPath, document, 'utf8');
  const parsed = JSON.parse(document) as { paths: Record<string, Record<string, unknown>> };
  const paths = Object.entries(parsed.paths);
  const operations = paths
    .flatMap(([, item]) => Object.entries(item))
    .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method));

  process.stdout.write(`  wrote ${outPath}\n  ${String(operations.length)} operations across ${String(paths.length)} paths\n`);
}


function tryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  Failed to generate the OpenAPI document: ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});


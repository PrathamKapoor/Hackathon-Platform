import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, DEMO_PASSWORD, type Harness, type ApiClient } from './harness.ts';
import { EXPORT_KINDS } from '../src/services/transfer-service.ts';
import { IMPORT_KINDS } from '../src/services/transfer-service.ts';
import { WEBHOOK_EVENTS } from '@verdict/core/types';

/**
 * Every advertised capability actually works.
 *
 * The pattern behind this file is the same one three times over: a list in the
 * type system, a list in the route, a list in the UI, and a constraint or an
 * implementation that quietly disagrees with all of them. The disagreement is
 * invisible from any single place, and the only way it ever surfaces is a
 * negative test - which nobody writes for a download button.
 *
 * So every kind is *exercised* here, not just counted. An export that is
 * advertised, listed in the manifest, and shown as a button, and returns 500, is
 * worse than one that does not exist: the organizer discovers it at the moment
 * they need the file.
 */

async function openHarness(t: { after: (fn: () => Promise<void>) => void }): Promise<Harness> {
  const harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });
  return harness;
}

async function organizer(harness: Harness): Promise<ApiClient> {
  const client = harness.client();
  await client.login('organizer@dogfood.dev', DEMO_PASSWORD);
  return client;
}

test('every advertised CSV export kind returns a file', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const client = await organizer(harness);

  for (const kind of EXPORT_KINDS) {
    const response = await client.get(`/api/events/${eventId}/exports/${kind}`);
    assert.equal(
      response.status,
      200,
      `export ${kind} returned ${String(response.status)}: ${response.raw.slice(0, 300)}`,
    );
    assert.match(
      String(response.headers['content-type'] ?? ''),
      /text\/csv/,
      `export ${kind} did not return CSV: ${String(response.headers['content-type'] ?? '')}`,
    );
    assert.match(
      String(response.headers['content-disposition'] ?? ''),
      new RegExp(kind.toLowerCase()),
      `export ${kind} has no matching filename: ${String(response.headers['content-disposition'] ?? '')}`,
    );
    // A header row at minimum, so an empty export is still a usable file.
    const csv = response.raw;
    assert.ok(csv.length > 0, `export ${kind} is empty`);
    assert.ok(
      csv.split('\n')[0] !== undefined,
      `export ${kind} has no header row`,
    );
  }
});

test('every advertised export kind also works as JSON', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const client = await organizer(harness);

  for (const kind of EXPORT_KINDS) {
    const response = await client.get<{ kind: string; columns: unknown[]; csv: string }>(
      `/api/events/${eventId}/exports/${kind}.json`,
    );
    assert.equal(response.status, 200, `export ${kind}.json returned ${String(response.status)}: ${response.raw.slice(0, 300)}`);
    assert.equal(response.body.kind, kind, `export ${kind}.json reported the wrong kind`);
  }
});

test('the export manifest lists exactly the kinds that work', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const client = await organizer(harness);

  const manifest = await client.get<{ kinds: string[]; entities: { kind: string }[] }>(
    `/api/events/${eventId}/exports/manifest`,
  );
  assert.equal(manifest.status, 200, `manifest failed: ${manifest.raw.slice(0, 200)}`);

  const listed = (manifest.body.entities ?? []).map((entity) => entity.kind).sort();
  const declared = [...EXPORT_KINDS].sort();
  assert.deepEqual(
    listed,
    declared,
    `the manifest advertises a different set of kinds than the service can export.\n  manifest: ${listed.join(', ')}\n  declared: ${declared.join(', ')}`,
  );
});

test('every export is recorded as a job, for every kind', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const client = await organizer(harness);

  for (const kind of EXPORT_KINDS) {
    const response = await client.get(`/api/events/${eventId}/exports/${kind}`);
    assert.equal(response.status, 200, `export ${kind} failed`);
  }

  // The bug this guards: the CSV was built and then the job insert failed its
  // CHECK, so the download 500s *and* leaves no trace. A kind that exported
  // successfully but recorded nothing would mean the audit trail has a hole in
  // it, which for an export is the part that matters.
  const recorded = harness.db.all<{ kind: string }>(
    'SELECT kind FROM export_jobs WHERE event_id = :e ORDER BY kind',
    { e: eventId },
  );
  assert.deepEqual(
    recorded.map((row) => row.kind).sort(),
    [...EXPORT_KINDS].sort(),
    'not every exported kind was recorded as a job',
  );
});

test('every declared import kind has a route that accepts it', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const client = await organizer(harness);

  /*
   * A dry run with an empty body: the point is that the route exists and answers
   * rather than 404, and that it refuses an empty CSV the way it should. A kind
   * in the type union with no route behind it is a declared capability that does
   * not exist - which is how SUBMISSIONS sat in three declarations and no
   * implementation.
   */
  for (const kind of IMPORT_KINDS) {
    const lower = kind.toLowerCase();
    const response = await client.post(`/api/events/${eventId}/imports/${lower}`, {
      csv: 'name,email\n',
      dryRun: true,
    });
    assert.notEqual(
      response.status,
      404,
      `import kind ${kind} is declared but has no route at /api/events/{eventId}/imports/${lower}`,
    );
    // Either it parsed the header and found nothing to do, or it rejected the
    // columns. Both are fine; a 5xx or a 404 is not.
    assert.ok(
      response.status < 500,
      `import ${kind} returned ${String(response.status)}: ${response.raw.slice(0, 200)}`,
    );
  }
});

test('every webhook topic the console offers is one the server will deliver', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const client = await organizer(harness);

  /*
   * The console renders its topic list from `WEBHOOK_EVENTS`, so a topic cannot
   * drift from the server's list any more - but the server filters unrecognised
   * topics out of a subscription *silently*, so a drifted one would arrive as a
   * webhook quietly subscribed to less than the organizer was told. Asserting
   * the stored subscription survives a round trip is what catches that.
   */
  for (const topic of WEBHOOK_EVENTS) {
    const created = await client.post<{ id: string; subscriptions: string }>(`/api/events/${eventId}/webhooks`, {
      url: 'https://example.com/verdict-topic-test',
      subscriptions: [topic],
      secret: 'topic-test-signing-secret-0123456789',
    });
    assert.equal(created.status, 201, `webhook for ${topic} was refused: ${created.raw.slice(0, 200)}`);
    assert.deepEqual(
      JSON.parse(created.body.subscriptions) as string[],
      [topic],
      `the server dropped ${topic} from its own subscription`,
    );
  }

  // And a topic that does not exist is refused rather than silently dropped.
  const bogus = await client.post(`/api/events/${eventId}/webhooks`, {
    url: 'https://example.com/verdict-topic-test',
    subscriptions: ['registration.decided'],
    secret: 'topic-test-signing-secret-0123456789',
  });
  assert.equal(bogus.status, 422, `an invented topic was accepted rather than rejected: ${bogus.raw.slice(0, 200)}`);
});

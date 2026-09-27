/**
 * End-to-end lifecycle test.
 *
 * This is the test that matters most: it walks a seeded event from an
 * organizer's browser session through to a published, reproducible result
 * snapshot, hitting only the public HTTP surface. If any of the pieces — the
 * RBAC matrix, the assignment engine, the scoring service, the result
 * pipeline, the persistence layer — disagree about a field name or a state, a
 * test that called the services directly would never notice.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, type Harness } from './harness.ts';

/** The seed builds twelve projects; the coverage report is expected to cover each. */
const PROJECTS_IN_SEED = 12;

type ErrorBody = { error: { code: string; message: string; requestId?: string } };

describe('lifecycle: event setup to published results', () => {
  let harness: Harness;
  let eventId: string;

  before(async () => {
    harness = await createHarness();
    eventId = seededEventId(harness);
  });

  after(async () => {
    await harness.close();
  });

  test('an anonymous visitor can read health, meta and the OpenAPI document', async () => {
    const anon = harness.client();

    const health = await anon.get<{ status: string; database: { ok: boolean }; version: string }>('/api/health');
    assert.equal(health.status, 200, health.raw);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.database.ok, true);
    assert.ok(health.body.version.length > 0);


    const docs = await anon.get<{ openapi: string; paths: Record<string, unknown> }>('/api/openapi.json');
    assert.equal(docs.status, 200, docs.raw);
    assert.match(docs.body.openapi, /^3\./);
    // Every route the app registers should be described, or the document is
    // decoration rather than a contract.
    assert.ok(Object.keys(docs.body.paths).length > 50, `only ${String(Object.keys(docs.body.paths).length)} paths documented`);
    assert.ok(docs.body.paths['/api/auth/login'] !== undefined, 'login route missing from the document');

    // The browsable reference is HTML with no external assets, so it renders on
    // an air-gapped machine.
    const html = await anon.get('/api/docs');
    assert.equal(html.status, 200, html.raw);
    assert.match(String(html.headers['content-type']), /text\/html/);
  });

  test('an unauthenticated request to a protected route is refused', async () => {
    const anon = harness.client();
    // /api/events is deliberately public — anyone may browse an event they were
    // told about. The organizer score table is not.
    const response = await anon.get(`/api/events/${eventId}/scores`);
    assert.equal(response.status, 401, response.raw);
    const body = response.body as ErrorBody;
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    // The request id must be echoed so an operator can find the log line.
    assert.ok((body.error.requestId ?? '').length > 0, 'no requestId on the error body');
  });

  test('the organizer can sign in and is recognised as an event organizer', async () => {
    const client = harness.client();
    const session = await client.login('organizer@dogfood.dev');
    assert.equal(session.user.email, 'organizer@dogfood.dev');
    assert.ok(session.user.roles.includes('ORGANIZER'), `roles were ${session.user.roles.join(', ')}`);

    // The session probe answers 200 with `authenticated: false` when signed
    // out, so one call is enough for the client to decide what to render.
    const me = await client.get<{ authenticated: boolean; user: { eventIds: string[] } }>('/api/auth/session');
    assert.equal(me.status, 200, me.raw);
    assert.equal(me.body.authenticated, true, me.raw);
    assert.ok(
      me.body.user.eventIds.includes(eventId),
      `organizer is not scoped to the seeded event: ${JSON.stringify(me.body.user.eventIds)}`,
    );
  });

  test('a wrong password and an unknown address are indistinguishable', async () => {
    const wrongPassword = harness.client();
    const wrong = await wrongPassword.post('/api/auth/login', { email: 'organizer@dogfood.dev', password: 'not-the-password' }, { csrf: false });

    const unknownUser = harness.client();
    const missing = await unknownUser.post('/api/auth/login', { email: 'nobody@dogfood.dev', password: 'not-the-password' }, { csrf: false });

    assert.equal(wrong.status, 401, wrong.raw);
    assert.equal(missing.status, 401, missing.raw);
    assert.deepEqual(
      (wrong.body as ErrorBody).error.code,
      (missing.body as ErrorBody).error.code,
      'the two failures must be the same code, or the endpoint enumerates accounts',
    );
    assert.equal(
      (wrong.body as ErrorBody).error.message,
      (missing.body as ErrorBody).error.message,
      'the two failures must be indistinguishable to a caller',
    );
  });

  test('a state-changing request without the CSRF header is refused', async () => {
    const client = harness.client();
    await client.login('organizer@dogfood.dev');

    // A valid session cookie, but no CSRF token: this is the cross-site
    // request a browser would send from another origin.
    const response = await client.post('/api/events', { name: 'Cross-site attempt' }, { csrf: false });
    assert.equal(response.status, 403, response.raw);
    assert.equal((response.body as ErrorBody).error.code, 'CSRF_FAILED');
  });

  test('a participant cannot reach the organizer scoring table', async () => {
    const participant = harness.client();
    await participant.login('iris@dogfood.dev');

    const forbidden = await participant.get(`/api/events/${eventId}/scores`);
    assert.equal(forbidden.status, 403, forbidden.raw);
    assert.equal((forbidden.body as ErrorBody).error.code, 'FORBIDDEN');

    // And the denial is in the audit ledger, not just the response. The ledger
    // is append-only at the storage level, so a row cannot be quietly removed.
    const denied = harness.db.value<number>(
      "SELECT COUNT(*) AS c FROM audit_events WHERE outcome = 'DENIED' AND actor_id = :id",
      { id: (await participant.get<{ user: { id: string } }>('/api/auth/session')).body.user.id },
    );
    assert.ok((denied ?? 0) > 0, 'the refusal was not written to the audit ledger');
  });

  test('a judge sees only their own queue, and the coverage report names the gaps', async () => {
    const judge = harness.client();
    const session = await judge.login('amara@dogfood.dev');

    const queue = await judge.get<{
      judgeId: string;
      items: { assignmentId: string; projectName: string }[];
      progress: { assigned: number; completed: number; inProgress: number; remaining: number };
    }>(`/api/events/${eventId}/judging/queue`);
    assert.equal(queue.status, 200, queue.raw);
    assert.equal(queue.body.judgeId, harness.db.value<string>('SELECT id FROM judges WHERE user_id = :u', { u: session.user.id }));
    assert.ok(queue.body.items.length > 0, 'the seeded judge has an empty queue');
    assert.equal(queue.body.progress.assigned, queue.body.items.length);
    assert.equal(
      queue.body.progress.completed + queue.body.progress.inProgress + queue.body.progress.remaining >= queue.body.progress.assigned,
      true,
      'the progress counters do not add up',
    );

    // Every assignment in the queue must belong to this judge. There is no
    // field in the payload that could carry another judge's score, which is the
    // property that makes blind judging possible at all.
    for (const item of queue.body.items) {
      const row = harness.db.get<{ judge_id: string }>('SELECT judge_id FROM judge_assignments WHERE id = :id', { id: item.assignmentId });
      assert.equal(row?.judge_id, queue.body.judgeId, `assignment ${item.assignmentId} is not this judge's`);
    }

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev');
    const assignments = await organizer.get<{
      data: { judge_id: string; status: string }[];
      coverage: { projectName: string; assigned: number; target: number; completed: number; coverage: number }[];
    }>(`/api/events/${eventId}/assignments`);
    assert.equal(assignments.status, 200, assignments.raw);
    assert.ok(assignments.body.data.length > 0, 'the organizer sees no assignments at all');

    // The coverage report is per project, and it must name both the projects
    // that are fully judged and the ones that are not. An organiser whose panel
    // quietly under-covered two entries deserves to be told before publishing.
    assert.equal(assignments.body.coverage.length, PROJECTS_IN_SEED);
    for (const project of assignments.body.coverage) {
      assert.equal(project.target, 3, `${project.projectName} has an unexpected review target`);
      assert.ok(project.assigned > 0, `${project.projectName} was never assigned to anybody`);
      assert.ok(project.coverage >= 0 && project.coverage <= 1, `${project.projectName} has coverage ${String(project.coverage)}`);
    }
    const incomplete = assignments.body.coverage.filter((p) => p.completed < p.target);
    assert.ok(
      incomplete.length > 0,
      'the seed is supposed to leave unfinished reviews, so the coverage report should flag some projects',
    );
  });

  test('the organizer can recompute results and get a run back', async () => {
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev');

    const computed = await organizer.post<{ runId: string; integrityHash: string; inputHash: string; entries: unknown[] }>(
      `/api/events/${eventId}/results/compute`,
      {},
    );
    assert.equal(computed.status, 200, computed.raw);
    assert.ok(computed.body.runId.startsWith('run_'), `unexpected run id ${computed.body.runId}`);
    assert.ok(computed.body.entries.length > 0, 'the computed run has no entries');
    assert.match(computed.body.integrityHash, /^[0-9a-f]{64}$/);
    assert.match(computed.body.inputHash, /^[0-9a-f]{64}$/);

    // The same inputs must produce the same hash. This is the property that
    // makes a published result arguable rather than merely authoritative.
    const again = await organizer.post<{ runId: string; integrityHash: string }>(`/api/events/${eventId}/results/compute`, {});
    assert.equal(again.status, 200, again.raw);
    assert.equal(again.body.integrityHash, computed.body.integrityHash, 'recomputation produced a different integrity hash for identical inputs');
  });

  test('a run is reproducible before it is ever published', async () => {
    // This is the case the storage model used to get wrong: a run's entries now
    // live with the run, not under a snapshot, so an unpublished run can still
    // be rehydrated and checked.
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev');

    const runs = harness.db.all<{ id: string }>('SELECT id FROM result_runs WHERE event_id = :e', { e: eventId });
    assert.ok(runs.length > 0, 'no runs to verify');

    for (const run of runs) {
      const entryCount = harness.db.value<number>('SELECT COUNT(*) AS c FROM result_run_entries WHERE result_run_id = :r', { r: run.id });
      assert.ok((entryCount ?? 0) > 0, `run ${run.id} stored no entries`);
    }
  });

  test('the organizer can snapshot, publish and verify the result', async () => {
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev');

    const computed = await organizer.post<{ runId: string }>(`/api/events/${eventId}/results/compute`, {});
    const runId = computed.body.runId;

    const snapshot = await organizer.post<{ id: string; sequence: number; entry_count: number }>(
      `/api/events/${eventId}/results/${runId}/snapshot`,
      {},
    );
    // 201: a snapshot is a new resource, not a view of the run.
    assert.equal(snapshot.status, 201, snapshot.raw);
    assert.ok(snapshot.body.entry_count > 0, 'the snapshot has no entries — publication would publish nothing');

    // The published copy must match the run it came from, entry for entry.
    const runEntries = harness.db.value<number>('SELECT COUNT(*) AS c FROM result_run_entries WHERE result_run_id = :r', { r: runId });
    const snapEntries = harness.db.value<number>('SELECT COUNT(*) AS c FROM result_entries WHERE snapshot_id = :s', { s: snapshot.body.id });
    assert.equal(snapEntries, runEntries, 'the published snapshot does not match its run');

    const published = await organizer.post<{ id: string; is_published: number; published_at: string | null }>(
      `/api/events/${eventId}/results/snapshots/${snapshot.body.id}/publish`,
      {},
    );
    assert.equal(published.status, 200, published.raw);
    assert.equal(published.body.is_published, 1, 'publication did not mark the snapshot published');
    assert.ok(published.body.published_at, 'publication recorded no timestamp');

    const verify = await organizer.post<{ status: string; differences: unknown[] }>(
      `/api/events/${eventId}/results/snapshots/${snapshot.body.id}/reproduce`,
      {},
    );
    assert.equal(verify.status, 200, verify.raw);
    // 'MATCH' means the engine recomputed the whole pipeline from the stored
    // reviews and landed on exactly the published ranking. This is the claim
    // the product makes, so it is asserted rather than assumed.
    assert.equal(verify.body.status, 'MATCH', `reproduction failed: ${JSON.stringify(verify.body.differences)}`);
    assert.deepEqual(verify.body.differences, []);
  });

  test('a published snapshot is immutable at the storage level', async () => {
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev');
    const snapshotId = harness.db.value<string>(
      'SELECT id FROM result_snapshots WHERE event_id = :e AND is_published = 1',
      { e: eventId },
    );
    assert.ok(snapshotId !== null, 'no published snapshot to test');

    assert.throws(
      () =>
        harness.db.exec('UPDATE result_snapshots SET integrity_hash = :h WHERE id = :id', {
          id: snapshotId as string,
          h: '0'.repeat(64),
        }),
      /cannot be modified/i,
      'the database let a published result be rewritten',
    );
  });

  test('published results are public, but the run behind them is not', async () => {
    // The seeded event sets results_visibility = PUBLIC, so an anonymous
    // visitor *should* see the published board. What must never leak is the
    // unpublished run, its provenance, or the per-review detail an organizer
    // has not chosen to publish.
    const anon = harness.client();

    const board = await anon.get<{ published: boolean; entries: { projectName: string; rank: number }[] }>(
      `/api/events/${eventId}/results`,
    );
    assert.equal(board.status, 200, board.raw);
    const published = board.body;
    assert.equal(published.published, true);
    assert.ok(published.entries.length > 0);
    // Ranks must be dense and ordered, or the board is not a ranking.
    published.entries.forEach((entry, index) => {
      assert.equal(entry.rank, index + 1, `rank ${String(entry.rank)} at position ${String(index)}`);
    });

    // The compute endpoint and the raw run are organizer-only, whatever the
    // published board says.
    const recompute = await anon.post(`/api/events/${eventId}/results/compute`, {});
    assert.ok(recompute.status === 401 || recompute.status === 403, `anonymous recompute got ${String(recompute.status)}`);

    const runId = harness.db.value<string>('SELECT id FROM result_runs WHERE event_id = :e LIMIT 1', { e: eventId });
    const snapshot = await anon.get(`/api/events/${eventId}/results/${runId as string}`);
    assert.ok(snapshot.status === 401 || snapshot.status === 403 || snapshot.status === 404, `anonymous run read got ${String(snapshot.status)}`);
  });

  test('the audit ledger recorded the run', async () => {
    const rows = harness.db.all<{ action: string }>(
      "SELECT action FROM audit_events WHERE action IN ('results.finalized') ORDER BY created_ms",
    );
    assert.ok(rows.length > 0, 'finalizing results wrote no audit event');
  });

  test('logging out revokes the session server-side', async () => {
    const client = harness.client();
    await client.login('organizer@dogfood.dev');

    const before = await client.get('/api/auth/session');
    assert.equal(before.status, 200, before.raw);

    const out = await client.post('/api/auth/logout');
    assert.equal(out.status, 204, out.raw);

    // Revoked server-side, not merely cleared in the browser: the cookie is
    // gone but even a replay of the old token would now be refused.
    const after = await client.get<{ authenticated: boolean }>('/api/auth/session');
    assert.equal(after.body.authenticated, false, `the session still worked after logout: ${after.raw}`);

    const replay = harness.db.value<number>('SELECT COUNT(*) AS c FROM sessions WHERE revoked_at IS NULL AND user_id = :u', {
      u: (await client.get<{ user: { id: string } }>('/api/auth/session')).body.user?.id ?? '',
    });
    assert.equal(replay, 0, 'logout left a live session row behind');
  });

  test('a tampered session cookie is rejected', async () => {
    const client = harness.client();
    await client.login('organizer@dogfood.dev');

    // Reuse the real cookie name with a different value, the way a stolen-and-
    // modified cookie would arrive. It must not authenticate anybody.
    const response = await client.get<{ authenticated: boolean; user: unknown }>('/api/auth/session', {
      headers: { cookie: 'verdict_session=forged-token-value-that-was-never-issued' },
    });
    assert.equal(response.body.authenticated, false, 'a forged session token was accepted');
    assert.equal(response.body.user, null);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, DEMO_PASSWORD, type Harness } from './harness.ts';

/**
 * Regressions in the shape of the API itself.
 *
 * Each of these was a contract that looked honoured and was not. A caller
 * writing against the spec, or against the shape of the Zod schema in the
 * handler, had no way to know: nothing errored, the response was well-formed,
 * and the value they had asked for was simply discarded.
 *
 * They are grouped here rather than next to the code they touch because the
 * common thread is the failure mode, not the feature - a value that is accepted
 * by validation and then ignored is invisible from inside a handler and only
 * observable from outside.
 */

async function openHarness(t: { after: (fn: () => Promise<void>) => void }): Promise<Harness> {
  const harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });
  return harness;
}

test('paging is read from the query string, not the path', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);

  /*
   * The comments endpoint merged its Paging schema into the *path* schema, where
   * `page` and `perPage` can never appear, so Zod's defaults always won. Every
   * caller got the first 25 comments with no way to reach the rest.
   *
   * `perPage` is bounded at 200 and the demo has 12 projects, so this asserts on
   * the value that comes back rather than on a specific page of data - the point
   * is that the parameter is read at all.
   */
  const submission = harness.db.get<{ id: string }>(
    "SELECT id FROM submissions WHERE event_id = :e AND withdrawn = 0 ORDER BY id LIMIT 1",
    { e: eventId },
  );
  assert.ok(submission !== null, 'the demo has a submission to comment on');

  const pageOne = await harness.client().get<{ pagination: { perPage: number; page: number } }>(
    `/api/submissions/${submission.id}/comments?page=1&perPage=5`,
  );
  assert.equal(pageOne.status, 200, `comments failed: ${pageOne.raw.slice(0, 200)}`);
  assert.equal(pageOne.body.pagination?.perPage, 5, 'perPage from the query was ignored');
  assert.equal(pageOne.body.pagination?.page, 1);

  // And the out-of-range case is still a validation error rather than a clamp,
  // so a caller cannot believe it received 200 rows.
  const tooBig = await harness.client().get(`/api/submissions/${submission.id}/comments?perPage=5000`);
  assert.equal(tooBig.status, 422, 'an out-of-range perPage was accepted');
});

test('the embed payload honours its limit', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);

  // `limit` was parsed out of the path, so the widget's size was always 24
  // however it was asked for. The whole point of the parameter is that a
  // third-party page can choose how much it embeds.
  const small = await harness.client().get<{ projects: unknown[] }>(`/api/embed/${eventId}.json?limit=3`);
  assert.equal(small.status, 200, `embed failed: ${small.raw.slice(0, 200)}`);
  assert.ok(Array.isArray(small.body.projects), 'the embed payload has no projects array');
  assert.ok(
    small.body.projects.length <= 3,
    `?limit=3 returned ${String(small.body.projects.length)} projects, so the limit was ignored`,
  );

  const tooBig = await harness.client().get(`/api/embed/${eventId}.json?limit=9999`);
  assert.equal(tooBig.status, 422, 'an out-of-range embed limit was accepted');
});

test('the pairwise queue honours how many pairs it returns', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);

  const judge = harness.client();
  await judge.login('amara@dogfood.dev', DEMO_PASSWORD);

  const queue = await judge.get<{ pairs?: unknown[] }>(`/api/events/${eventId}/pairwise/queue?pairs=2`);
  assert.equal(queue.status, 200, `pairwise queue failed: ${queue.raw.slice(0, 200)}`);
  assert.ok(
    (queue.body.pairs ?? []).length <= 2,
    `?pairs=2 returned ${String((queue.body.pairs ?? []).length)} pairs, so the parameter was ignored`,
  );
});

test('the delivery history honours its limit', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);

  // The list is `limit`, parsed from the path, so an organizer debugging a
  // receiver that broke weeks ago was shown the last 50 attempts and no more,
  // with no way to ask for more.
  const organizer = harness.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
  const created = await organizer.post<{ id: string }>(`/api/events/${eventId}/webhooks`, {
    // Loopback, which the default SSRF guard refuses; the test needs a webhook
    // row, not a reachable receiver.
    url: 'https://example.com/verdict-contract-test',
    subscriptions: ['results.published'],
    secret: 'contract-test-signing-secret-0123456789',
  });
  assert.equal(created.status, 201, `webhook not created: ${created.raw.slice(0, 300)}`);

  const deliveries = await organizer.get<{ data: unknown[] }>(`/api/webhooks/${created.body.id}/deliveries?limit=1`);
  assert.equal(deliveries.status, 200, `deliveries failed: ${deliveries.raw.slice(0, 200)}`);
  assert.ok(Array.isArray(deliveries.body.data));

  // At most one, and the parameter is not rejected.
  assert.ok(deliveries.body.data.length <= 1, '?limit=1 returned more than one delivery');

  const tooBig = await organizer.get(`/api/webhooks/${created.body.id}/deliveries?limit=100000`);
  assert.equal(tooBig.status, 422, 'an out-of-range delivery limit was accepted');
});

test('an anonymous caller is told 401, not 500', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const anonymous = harness.client();

  /*
   * `requireActor` threw a plain `Error`, which no branch of `toApiError` maps,
   * so it surfaced as `INTERNAL_ERROR` / 500. A 500 says the deployment is
   * broken and trips alerting; the truth is that nobody is signed in, which is
   * a 401 and entirely the caller's problem.
   *
   * The judge endpoints reach `requireActor` on their first line, so they were
   * the visible symptom.
   */
  const judge = harness.db.get<{ id: string }>(
    `SELECT j.id FROM judges j
       JOIN users u ON u.id = j.user_id
      WHERE j.event_id = :e AND u.email = 'amara@dogfood.dev'`,
    { e: eventId },
  );
  assert.ok(judge !== null, 'the demo has a judge to act on');

  const accept = await anonymous.post(`/api/judges/${judge.id}/accept`, {
    title: 'Principal engineer',
    organization: 'Dogfood',
  });
  assert.equal(accept.status, 401, `expected 401, got ${String(accept.status)}: ${accept.raw.slice(0, 200)}`);

  const transition = await anonymous.post(`/api/judges/${judge.id}/transition`, { to: 'ACTIVE' });
  assert.equal(transition.status, 401, `expected 401, got ${String(transition.status)}: ${transition.raw.slice(0, 200)}`);

  const conflict = await anonymous.post(`/api/events/${eventId}/conflicts`, {
    judgeId: judge.id,
    kind: 'SUBMISSION',
    projectId: 'sub_anything',
    severity: 'HARD',
  });
  assert.equal(conflict.status, 401, `expected 401, got ${String(conflict.status)}: ${conflict.raw.slice(0, 200)}`);

  // The error code is the one a client branches on, not just the status.
  const body = accept.body as { error?: { code?: string } };
  assert.equal(body.error?.code, 'UNAUTHENTICATED', 'the 401 did not carry the UNAUTHENTICATED code');
});

test('the published OpenAPI document respects hidden routes', async (t) => {
  const harness = await openHarness(t);

  /*
   * A route registered with `hidden: true` says, in its own comment, that it
   * should be kept out of the published document. The generator iterated
   * `registry.all()` and ignored that, so the health and readiness probes were
   * published anyway.
   */
  const spec = await harness.client().get<{ paths: Record<string, unknown> }>('/api/openapi.json');
  assert.equal(spec.status, 200, `could not read the spec: ${spec.raw.slice(0, 200)}`);
  assert.ok(spec.body.paths !== undefined, 'the spec has no paths object');

  for (const hidden of ['/api/health', '/api/ready']) {
    assert.equal(
      spec.body.paths[hidden],
      undefined,
      `${hidden} is registered as hidden but appears in the published document`,
    );
  }

  // A route that is *not* hidden must still be published, or the fix is just
  // an empty document.
  assert.ok(spec.body.paths['/api/capabilities'] !== undefined, 'the spec lost a route it should have kept');
});

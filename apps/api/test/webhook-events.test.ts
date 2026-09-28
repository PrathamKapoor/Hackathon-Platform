import test from 'node:test';
import assert from 'node:assert/strict';
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_META } from '@verdict/core/types';
import { createHarness, seededEventId, DEMO_PASSWORD, type Harness, type ApiClient } from './harness.ts';

/**
 * Every webhook topic actually fires.
 *
 * The webhook engine itself was fine: signing, replay defence, SSRF re-checks,
 * timeouts, retry with backoff, auto-disable and manual redelivery were all
 * implemented. What did not exist was the wiring. `dispatch` had exactly one
 * caller, in the certificate service, so ten of the eleven advertised topics
 * never fired. An organizer could subscribe to `score.submitted`, watch the
 * delivery list stay empty forever, and get no indication that the topic they
 * had been sold did not exist.
 *
 * Nothing in the type system catches that. The topic list, the console's
 * checkbox list and the dispatch call sites were three separate things that had
 * to agree, and nothing made them agree. So each test here drives the real HTTP
 * API for one topic and asserts a delivery row was persisted for a webhook
 * subscribed to all of them. The assertion is on the queued row rather than on
 * the HTTP response, because delivery is deliberately asynchronous and
 * best-effort: a receiver being down must not fail the operation that caused
 * the delivery, and equally must not be mistaken for the topic never firing.
 */

/**
 * Port 9 is the discard port, so the connection is refused immediately. Nothing
 * leaves the machine, which is what the offline test suite requires, and the
 * attempt fails fast instead of waiting out the delivery timeout.
 */
const HOOK_URL = 'http://127.0.0.1:9/verdict-webhook';
const SIGNING_SECRET = 'test-signing-secret-0123456789abcdef';

async function openHarness(t: { after: (fn: () => Promise<void>) => void }): Promise<Harness> {
  const harness = await createHarness({
    // Private targets are refused by default, which is the correct production
    // behaviour. The tests need loopback, so they ask for it explicitly here
    // rather than weakening the default anywhere else.
    config: { security: { allowPrivateWebhookTargets: true, webhookTimeoutMs: 500 } },
  });
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

/** A webhook subscribed to every topic, so no test can pass by omission. */
async function subscribeToEverything(harness: Harness, eventId: string): Promise<string> {
  const client = await organizer(harness);
  const created = await client.post<{ id: string }>(`/api/events/${eventId}/webhooks`, {
    url: HOOK_URL,
    subscriptions: [...WEBHOOK_EVENTS],
    secret: SIGNING_SECRET,
  });
  assert.equal(created.status, 201, `webhook not created: ${created.raw.slice(0, 300)}`);
  return created.body.id;
}

function topicsDelivered(harness: Harness, webhookId: string): string[] {
  return harness.db
    .all<{ event_type: string }>(
      'SELECT event_type FROM webhook_deliveries WHERE webhook_id = :w ORDER BY created_at, id',
      { w: webhookId },
    )
    .map((row) => row.event_type);
}

function assertDelivered(topics: string[], expected: string, action: string): void {
  assert.ok(
    topics.includes(expected),
    `${action} queued no "${expected}" delivery. Queued: ${topics.length === 0 ? '(nothing)' : topics.join(', ')}`,
  );
}

/* -------------------------------------------------------------- structure */

test('every topic the console offers is a topic the server can deliver', () => {
  // The drift this guards against already happened: the Integrations panel
  // hard-coded its own list and offered `result.corrected` and
  // `registration.decided`, neither of which has ever been a real topic. The
  // server filters unrecognised topics out of a subscription without erroring,
  // so the organizer's webhook was quietly subscribed to less than the console
  // said it was.
  for (const topic of WEBHOOK_EVENTS) {
    const meta = WEBHOOK_EVENT_META[topic];
    assert.ok(meta !== undefined, `${topic} has no metadata for the console to render`);
    assert.ok(meta.label.length > 0, `${topic} has an empty label`);
    assert.ok(meta.description.length > 10, `${topic} has no description for the console to show`);
  }

  // A webhook belongs to an event, so the event it would name does not exist
  // yet when the event is created. The topic could never deliver.
  assert.ok(
    !WEBHOOK_EVENTS.includes('event.created' as never),
    'event.created cannot be delivered by a webhook scoped to the event being created',
  );
});

/* ----------------------------------------------------------------- events */

test('a registration acceptance is announced', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const webhookId = await subscribeToEverything(harness, eventId);

  /*
   * The demo seeds all 18 registrations as already ACCEPTED, so there is
   * nothing to decide, and the unique (event, user) constraint means a second
   * application cannot be added either. The applicant is one of the few users
   * the demo leaves unregistered, which is what makes this a real application
   * rather than a rewritten one. `POST /registration` is not used because the
   * demo event's registration window closed in February 2026 and its state is
   * JUDGING, so the endpoint is refused on both counts. Everything after the
   * insert goes through the real API.
   */
  const applicant = harness.db.get<{ id: string }>(
    `SELECT id FROM users WHERE email = 'priya@dogfood.dev'
       AND id NOT IN (SELECT user_id FROM registrations WHERE event_id = :e)`,
    { e: eventId },
  );
  assert.ok(applicant !== null, 'the demo has an unregistered applicant to accept');
  const registrationId = 'reg_webhook_probe';
  harness.db.exec(
    `INSERT INTO registrations (id, event_id, user_id, state, full_name, organization, skills, bio, decision_note, submitted_at, created_at, updated_at)
     VALUES (:id, :e, :u, 'PENDING', 'Priya Raman', '', '', '', '', :at, :at, :at)`,
    { id: registrationId, e: eventId, u: applicant.id, at: new Date().toISOString() },
  );

  const decision = await (await organizer(harness)).post(`/api/events/${eventId}/registrations/${registrationId}/decision`, {
    to: 'ACCEPTED',
    note: 'accepted by the webhook test',
  });
  assert.equal(decision.status, 200, `decision failed: ${decision.raw.slice(0, 300)}`);

  assertDelivered(topicsDelivered(harness, webhookId), 'registration.accepted', 'accepting a registration');
});

test('a bulk acceptance is announced too', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const webhookId = await subscribeToEverything(harness, eventId);

  // `bulkDecide` funnels through `decide`; this is the assertion that stops
  // someone from later "optimising" the bulk path to bypass the single one.
  const applicant = harness.db.get<{ id: string }>(
    `SELECT id FROM users WHERE email = 'tomas@dogfood.dev'
       AND id NOT IN (SELECT user_id FROM registrations WHERE event_id = :e)`,
    { e: eventId },
  );
  assert.ok(applicant !== null);
  const registrationId = 'reg_webhook_bulk_probe';
  harness.db.exec(
    `INSERT INTO registrations (id, event_id, user_id, state, full_name, organization, skills, bio, decision_note, submitted_at, created_at, updated_at)
     VALUES (:id, :e, :u, 'PENDING', 'Tomas Vidal', '', '', '', '', :at, :at, :at)`,
    { id: registrationId, e: eventId, u: applicant.id, at: new Date().toISOString() },
  );

  const bulk = await (await organizer(harness)).post(`/api/events/${eventId}/registrations/bulk`, {
    ids: [registrationId],
    to: 'ACCEPTED',
  });
  assert.equal(bulk.status, 200, `bulk decision failed: ${bulk.raw.slice(0, 300)}`);

  assertDelivered(topicsDelivered(harness, webhookId), 'registration.accepted', 'bulk-accepting a registration');
});

test('creating a team is announced', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const webhookId = await subscribeToEverything(harness, eventId);

  const created = await (await organizer(harness)).post(`/api/events/${eventId}/teams`, {
    name: 'Webhook Probe Team',
    description: 'Created by the webhook topic test.',
  });
  assert.equal(created.status, 201, `team not created: ${created.raw.slice(0, 300)}`);

  assertDelivered(topicsDelivered(harness, webhookId), 'team.created', 'creating a team');
});

/** A complete project: `validateForSubmission` checks every one of these. */
const COMPLETE_PROJECT = {
  projectName: 'Webhook Probe Project',
  shortDescription: 'A short description that comfortably clears the twenty character minimum.',
  fullDescription:
    'A full description that comfortably clears the one hundred character minimum, repeated so the length check is passed with room to spare for the validation rule under test.',
  problem: 'A problem statement long enough to satisfy the twenty character rule.',
  solution: 'A solution statement long enough to satisfy the twenty character rule.',
  technologies: ['typescript', 'node'],
  repositoryUrl: 'https://example.com/webhook-probe',
};

/** The demo's team captains, who may create their team's submission. */
function captains(harness: Harness): { email: string; team_id: string }[] {
  return harness.db.all<{ email: string; team_id: string }>(
    `SELECT u.email, t.id AS team_id
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       JOIN teams t ON t.id = tm.team_id
      WHERE t.event_id = (SELECT id FROM events WHERE slug = 'dogfood-2026') AND tm.role = 'CAPTAIN'`,
  );
}

test('submitting a project is announced, and creating a draft is not', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const webhookId = await subscribeToEverything(harness, eventId);

  const captain = captains(harness)[0];
  assert.ok(captain !== undefined, 'the demo has a team captain who can submit');
  const client = harness.client();
  await client.login(captain.email, DEMO_PASSWORD);

  const created = await client.post<{ id: string }>(`/api/events/${eventId}/submissions`, {
    ...COMPLETE_PROJECT,
    teamId: captain.team_id,
  });
  assert.equal(created.status, 201, `submission not created: ${created.raw.slice(0, 300)}`);

  /*
   * The deliberate part of this test. A draft is a private working copy that may
   * never be entered, so announcing it would put projects into a receiver's
   * records that were never in the contest. `submission.created` fires on the
   * draft-to-submitted change instead.
   */
  assert.deepEqual(
    topicsDelivered(harness, webhookId),
    [],
    'creating a draft queued a delivery, which would announce a project that was never entered',
  );

  /*
   * The demo's submission window closed in February 2026, so the transition
   * needs the organizer override the state machine already offers. The override
   * flag is what makes the window irrelevant, and it is audited.
   */
  const submitted = await client.post(`/api/submissions/${created.body.id}/submit`, {
    override: true,
    reason: 'webhook topic test',
  });
  assert.equal(submitted.status, 200, `submission not submitted: ${submitted.raw.slice(0, 300)}`);

  assertDelivered(topicsDelivered(harness, webhookId), 'submission.created', 'submitting a project');
});

test('locking a submission is announced', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const webhookId = await subscribeToEverything(harness, eventId);

  const captain = captains(harness)[0];
  assert.ok(captain !== undefined);
  const owner = harness.client();
  await owner.login(captain.email, DEMO_PASSWORD);
  const created = await owner.post<{ id: string }>(`/api/events/${eventId}/submissions`, {
    ...COMPLETE_PROJECT,
    teamId: captain.team_id,
  });
  assert.equal(created.status, 201, `submission not created: ${created.raw.slice(0, 300)}`);
  const submitted = await owner.post(`/api/submissions/${created.body.id}/submit`, { override: true, reason: 'lock test' });
  assert.equal(submitted.status, 200, `submission not submitted: ${submitted.raw.slice(0, 300)}`);

  const locked = await (await organizer(harness)).post(`/api/submissions/${created.body.id}/transition`, { to: 'LOCKED' });
  assert.equal(locked.status, 200, `lock failed: ${locked.raw.slice(0, 300)}`);

  const topics = topicsDelivered(harness, webhookId);
  assertDelivered(topics, 'submission.locked', 'locking a submission');
  assert.ok(topics.includes('submission.created'), 'the earlier submit was lost while locking');
});

test('committing an assignment plan is announced', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const webhookId = await subscribeToEverything(harness, eventId);
  const client = await organizer(harness);

  const preview = await client.post<{ inputHash: string }>(`/api/events/${eventId}/assignments/preview`, {
    strategy: 'BALANCED',
  });
  assert.equal(preview.status, 200, `preview failed: ${preview.raw.slice(0, 300)}`);

  const committed = await client.post(`/api/events/${eventId}/assignments/commit`, {
    strategy: 'BALANCED',
    inputHash: preview.body.inputHash,
    confirmWarnings: true,
  });
  assert.equal(committed.status, 200, `commit failed: ${committed.raw.slice(0, 300)}`);

  const topics = topicsDelivered(harness, webhookId);
  assertDelivered(topics, 'judge.assigned', 'committing an assignment plan');
});

/** The two reviews the demo leaves outstanding, each with the judge who owns it. */
function outstandingReviews(harness: Harness): { assignmentId: string; email: string }[] {
  return harness.db.all<{ assignmentId: string; email: string }>(
    `SELECT a.id AS assignmentId, u.email
       FROM judge_assignments a
       JOIN judges j ON j.id = a.judge_id
       JOIN users u ON u.id = j.user_id
      WHERE a.event_id = (SELECT id FROM events WHERE slug = 'dogfood-2026')
        AND a.status <> 'REASSIGNED'
        AND a.id NOT IN (
          SELECT assignment_id FROM scores WHERE state IN ('SUBMITTED','LOCKED')
        )`,
  );
}

/** A full set of criterion answers for whichever rubric is live. */
async function answersFor(assignmentId: string, client: ApiClient) {
  const opened = await client.get<{ rubric: { criteria: { id: string; required: boolean; maxValue: number }[] } }>(
    `/api/assignments/${assignmentId}/review`,
  );
  assert.equal(opened.status, 200, `could not open the review: ${opened.raw.slice(0, 300)}`);
  const criteria = opened.body.rubric.criteria;
  assert.ok(Array.isArray(criteria) && criteria.length > 0, 'the live rubric has no criteria');
  return criteria.map((criterion, index) => ({
    criterionId: criterion.id,
    // Deterministic and inside every criterion's scale, including the seeded
    // rubric's "would I use this on Monday" question.
    value: index === 0 ? 4 : 3,
    comment: null,
  }));
}

test('a submitted review is announced, and the last one also announces that judging is done', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const webhookId = await subscribeToEverything(harness, eventId);

  const outstanding = outstandingReviews(harness);
  assert.ok(outstanding.length > 0, 'the demo leaves at least one review outstanding');

  for (const [index, review] of outstanding.entries()) {
    const client = harness.client();
    await client.login(review.email, DEMO_PASSWORD);
    const answers = await answersFor(review.assignmentId, client);

    const result = await client.post(`/api/assignments/${review.assignmentId}/review/submit`, {
      criteria: answers,
      durationMs: 60_000,
    });
    assert.equal(result.status, 200, `review ${index} not submitted: ${result.raw.slice(0, 300)}`);

    const topics = topicsDelivered(harness, webhookId);
    assertDelivered(topics, 'score.submitted', `submitting review ${index}`);

    const isLast = index === outstanding.length - 1;
    assert.equal(
      topics.includes('judging.completed'),
      isLast,
      isLast
        ? 'the final review did not announce that judging was complete'
        : `judging was announced complete after review ${index} of ${outstanding.length - 1}`,
    );
  }
});

test('a computed result is announced as finalized, and a published snapshot as published', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const webhookId = await subscribeToEverything(harness, eventId);
  const client = await organizer(harness);

  const computed = await client.post<{ runId: string }>(`/api/events/${eventId}/results/compute`);
  assert.equal(computed.status, 200, `compute failed: ${computed.raw.slice(0, 300)}`);
  assertDelivered(topicsDelivered(harness, webhookId), 'results.finalized', 'finalizing a result run');

  const snapshot = await client.post<{ id: string }>(`/api/events/${eventId}/results/${computed.body.runId}/snapshot`);
  assert.equal(snapshot.status, 201, `snapshot failed: ${snapshot.raw.slice(0, 300)}`);
  assert.ok(
    !topicsDelivered(harness, webhookId).includes('results.published'),
    'creating a snapshot published results; publication is a separate, deliberate act',
  );

  const published = await client.post(`/api/events/${eventId}/results/snapshots/${snapshot.body.id}/publish`);
  assert.equal(published.status, 200, `publish failed: ${published.raw.slice(0, 300)}`);
  assertDelivered(topicsDelivered(harness, webhookId), 'results.published', 'publishing a result');
});

test('issuing a certificate is announced, and re-requesting one is not', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const webhookId = await subscribeToEverything(harness, eventId);

  /*
   * FINALIST is the one kind the demo never seeds - it ships PARTICIPANT, JUDGE
   * and WINNER certificates for everyone it knows about. Issuing a FINALIST one
   * therefore always creates something, which is what this test needs:
   * `issue` returns the existing certificate when the recipient already holds
   * one of that kind and announces nothing, because nothing was created.
   */
  const userId = harness.db.value<string>("SELECT id FROM users WHERE email = 'priya@dogfood.dev'");
  assert.ok(userId !== null, 'the demo has a participant to certify');
  const client = await organizer(harness);
  const issued = await client.post<{ id: string }>(`/api/events/${eventId}/certificates`, {
    userId,
    kind: 'FINALIST',
    title: 'Finalist',
  });
  assert.equal(issued.status, 201, `certificate not issued: ${issued.raw.slice(0, 300)}`);

  const topics = topicsDelivered(harness, webhookId);
  assert.ok(
    topics.filter((topic) => topic === 'certificate.generated').length === 1,
    `issuing one certificate announced it ${topics.filter((t) => t === 'certificate.generated').length} times`,
  );

  const again = await client.post(`/api/events/${eventId}/certificates`, { userId, kind: 'FINALIST' });
  assert.equal(again.status, 201, `re-request failed: ${again.raw.slice(0, 300)}`);
  assert.equal(
    topicsDelivered(harness, webhookId).filter((topic) => topic === 'certificate.generated').length,
    1,
    'a re-request that issued nothing announced a second certificate',
  );
});

/* ----------------------------------------------------------------- secrecy */

test('no delivery body carries a judge\'s scores or an applicant\'s name', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const webhookId = await subscribeToEverything(harness, eventId);

  const outstanding = outstandingReviews(harness);
  const review = outstanding.at(0);
  assert.ok(review !== undefined, 'the demo leaves at least one review outstanding');
  const client = harness.client();
  await client.login(review.email, DEMO_PASSWORD);
  const answers = await answersFor(review.assignmentId, client);
  const result = await client.post(`/api/assignments/${review.assignmentId}/review/submit`, { criteria: answers });
  assert.equal(result.status, 200, `review not submitted: ${result.raw.slice(0, 300)}`);

  /*
   * A webhook body is written into a third party's logs the moment it is sent,
   * usually forwarded to a chat channel. The payload carries the ids and the
   * counts, and the receiver reads anything more from the API under its own
   * credentials. This test is what stops a future "let me just include the
   * scores" from shipping quietly.
   */
  const payload = harness.db.value<string>(
    "SELECT payload FROM webhook_deliveries WHERE webhook_id = :w AND event_type = 'score.submitted'",
    { w: webhookId },
  );
  assert.ok(typeof payload === 'string' && payload.length > 0, 'the score.submitted delivery has no payload');

  const parsed = JSON.parse(payload) as { data: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(parsed.data).sort(),
    ['assignmentId', 'durationMs', 'judgeId', 'rubricVersionId', 'submissionId'],
    'the score.submitted payload grew a field that was not reviewed for leakage',
  );
  assert.ok(!payload.includes('rawScore'), 'the score.submitted payload leaked a score');
  assert.ok(!payload.includes('totalScore'), 'the score.submitted payload leaked a total');
});

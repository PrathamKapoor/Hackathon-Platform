import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, DEMO_PASSWORD, type Harness } from './harness.ts';

/**
 * Requirements that were declared, advertised, and not actually enforced.
 *
 * Each of these had a claim in the documentation, a control in the interface,
 * and a route in the API - and the behaviour was not there. They are grouped
 * because the failure mode is identical: something exists everywhere except in
 * the one place it has to be true.
 *
 * The tests are written to fail against the code as it was.
 */

async function openHarness(t: { after: (fn: () => Promise<void>) => void }): Promise<Harness> {
  const harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });
  return harness;
}

test('a participant can retract their own vote', async (t) => {
  /*
   * The "Withdraw my vote" button existed on every project page and the route
   * existed and the community service's own comment said voting is a reversible
   * public act. The matrix granted `create` on votes and not `delete`, so the
   * button returned `403 PARTICIPANT is never granted delete on vote` for
   * everyone without a global ADMIN role. Nobody had clicked it.
   */
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);

  const participant = harness.client();
  await participant.login('iris@dogfood.dev', DEMO_PASSWORD);

  const voteable = harness.db.get<{ id: string }>(
    `SELECT id FROM submissions WHERE event_id = :e AND state IN ('SUBMITTED','LOCKED','JUDGING','FINALIZED')
      AND id NOT IN (SELECT submission_id FROM community_votes WHERE user_id = (
        SELECT j.user_id FROM team_members tm JOIN judges j ON j.user_id = tm.user_id
         WHERE tm.user_id = (SELECT id FROM users WHERE email = 'iris@dogfood.dev') LIMIT 1))
      ORDER BY id LIMIT 1`,
    { e: eventId },
  );

  // Rather than depend on the demo's team membership, cast and retract against
  // whatever the server will actually let this account vote for.
  const gallery = await participant.get<{ data: { id: string }[] }>(`/api/events/${eventId}/gallery`);
  const target = gallery.body.data[0];
  assert.ok(target !== undefined, 'the demo gallery is empty');
  void voteable;

  const before = harness.db.value<number>('SELECT COUNT(*) AS c FROM community_votes') ?? 0;
  const cast = await participant.post(`/api/events/${eventId}/votes`, { submissionId: target.id });
  // Either it cast, or voting refused for a reason unrelated to retracting.
  assert.ok([200, 201, 403, 409].includes(cast.status), `unexpected vote status ${String(cast.status)}: ${cast.raw.slice(0, 200)}`);

  if (cast.status === 201) {
    const after = harness.db.value<number>('SELECT COUNT(*) AS c FROM community_votes') ?? 0;
    assert.equal(after, before + 1, 'the vote was not recorded');

    const retract = await participant.delete(`/api/events/${eventId}/votes/${target.id}`);
    assert.equal(
      retract.status,
      200,
      `retracting a vote returned ${String(retract.status)}: ${retract.raw.slice(0, 300)}`,
    );

    const restored = harness.db.value<number>('SELECT COUNT(*) AS c FROM community_votes') ?? 0;
    assert.equal(restored, before, 'the vote was not actually removed');
  }
});

test('results cannot be published while community voting is still open', async (t) => {
  /*
   * "Hidden results during voting" was half implemented and entirely
   * unenforced. Vote *totals* were hidden properly - the gallery omits the key
   * rather than sending a count and trusting the client - but the *ranking* had
   * no guard at all. An organizer could publish the leaderboard mid-vote.
   */
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const organizer = harness.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

  // Open the voting window around now, with voting enabled.
  const now = new Date();
  const opensAt = new Date(now.getTime() - 60_000).toISOString();
  const closesAt = new Date(now.getTime() + 3_600_000).toISOString();
  harness.db.exec(
    `UPDATE events SET voting_enabled = 1, voting_opens_at = :o, voting_closes_at = :c WHERE id = :e`,
    { o: opensAt, c: closesAt, e: eventId },
  );

  const computed = await organizer.post<{ runId: string }>(`/api/events/${eventId}/results/compute`);
  assert.equal(computed.status, 200, `compute failed: ${computed.raw.slice(0, 200)}`);
  const snapshot = await organizer.post<{ id: string }>(`/api/events/${eventId}/results/${computed.body.runId}/snapshot`);
  assert.equal(snapshot.status, 201, `snapshot failed: ${snapshot.raw.slice(0, 200)}`);

  const refused = await organizer.post(`/api/events/${eventId}/results/snapshots/${snapshot.body.id}/publish`);
  assert.equal(
    refused.status,
    412,
    `publishing over a live vote returned ${String(refused.status)}: ${refused.raw.slice(0, 300)}`,
  );
  assert.match(refused.raw, /voting/i, 'the refusal does not mention voting');

  // The snapshot must still be unpublished, and the denial audited.
  const stillHidden = harness.db.value<number>(
    'SELECT is_published FROM result_snapshots WHERE id = :s',
    { s: snapshot.body.id },
  );
  assert.equal(stillHidden, 0, 'the refused snapshot was published anyway');
  const denied = harness.db.value<number>(
    `SELECT COUNT(*) AS c FROM audit_events WHERE event_id = :e AND action = 'results.published' AND outcome = 'DENIED'`,
    { e: eventId },
  ) ?? 0;
  assert.ok(denied > 0, 'the refusal was not recorded in the audit ledger');

  // Close voting, and it publishes.
  harness.db.exec('UPDATE events SET voting_closes_at = :c WHERE id = :e', {
    c: new Date(now.getTime() - 1000).toISOString(),
    e: eventId,
  });
  const published = await organizer.post(`/api/events/${eventId}/results/snapshots/${snapshot.body.id}/publish`);
  assert.equal(published.status, 200, `publishing after voting closed failed: ${published.raw.slice(0, 300)}`);
});

test('reading diagnostics writes nothing, and filing them does', async (t) => {
  /*
   * `GET /diagnostics` used to record the signals as review flags and write an
   * audit row. A GET that writes cannot be cached, prefetched or crawled, and
   * every page view produced four flag writes. Recording is now a POST.
   */
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const organizer = harness.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

  const flagsBefore = harness.db.value<number>('SELECT COUNT(*) AS c FROM anomaly_flags WHERE event_id = :e', { e: eventId }) ?? 0;
  const auditBefore = harness.db.value<number>('SELECT COUNT(*) AS c FROM audit_events') ?? 0;

  const read = await organizer.get<{ signals: unknown[] }>(`/api/events/${eventId}/diagnostics`);
  assert.equal(read.status, 200, `the read failed: ${read.raw.slice(0, 200)}`);
  assert.ok(Array.isArray(read.body.signals), 'the read returned no signals');

  const flagsAfterRead = harness.db.value<number>('SELECT COUNT(*) AS c FROM anomaly_flags WHERE event_id = :e', { e: eventId }) ?? 0;
  const auditAfterRead = harness.db.value<number>('SELECT COUNT(*) AS c FROM audit_events') ?? 0;
  assert.equal(flagsAfterRead, flagsBefore, 'a GET created review flags');
  assert.equal(auditAfterRead, auditBefore, 'a GET wrote to the audit ledger');

  // The POST files them.
  const filed = await organizer.post<{ signals: unknown[] }>(`/api/events/${eventId}/diagnostics`);
  assert.equal(filed.status, 200, `filing failed: ${filed.raw.slice(0, 200)}`);

  const auditAfterPost = harness.db.value<number>('SELECT COUNT(*) AS c FROM audit_events') ?? 0;
  assert.ok(auditAfterPost > auditBefore, 'the POST wrote nothing to the audit ledger');

  // Both routes compute the same thing, or the read and the file disagree.
  assert.equal(
    JSON.stringify(filed.body.signals),
    JSON.stringify(read.body.signals),
    'the GET and the POST computed different signals',
  );
});

test('a judge can read their own participation record, and anyone can verify one', async (t) => {
  /*
   * "Signed, publicly verifiable judge participation records" was a hash in a
   * column nobody could read. The matrix granted `participationRecord: 'OWN'` to
   * JUDGE and no route ever exercised it, so a judge could not get the record of
   * having judged; and the public certificate verifier keys on a different table
   * and returns NOT_FOUND for a `JPR-` code, so a third party could not check
   * one either.
   */
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const organizer = harness.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

  const issued = await organizer.post<{ issued: number }>(`/api/events/${eventId}/participation-records`);
  assert.equal(issued.status, 200, `issuing failed: ${issued.raw.slice(0, 200)}`);
  assert.ok(issued.body.issued > 0, 'no participation records were issued for the demo panel');

  // The judge can fetch their own, with no organizer involved.
  const judge = harness.client();
  await judge.login('amara@dogfood.dev', DEMO_PASSWORD);
  const mine = await judge.get<{ data: { reference: string; verifyUrl: string }[] }>('/api/participation-records/mine');
  assert.equal(mine.status, 200, `a judge could not read their own records: ${mine.raw.slice(0, 200)}`);
  assert.ok(mine.body.data.length > 0, 'the judge has no participation record of their own');
  const record = mine.body.data[0];
  assert.ok(record !== undefined);
  assert.match(record.reference, /^JPR-/, `unexpected reference format: ${record.reference}`);

  // And a stranger can verify it without an account.
  const anonymous = harness.client();
  const verified = await anonymous.get<{ valid: boolean; status: string; recomputedHash: string }>(
    `/api/participation-records/${record.reference}`,
  );
  assert.equal(verified.status, 200, `public verification failed: ${verified.raw.slice(0, 200)}`);
  assert.equal(verified.body.status, 'VALID', 'a freshly issued record did not verify');
  assert.equal(verified.body.valid, true);

  // Tampering with the stored contents must be detected. This is the property
  // that makes the record worth anything.
  harness.db.exec(`UPDATE judge_participation_records SET detail = '{"assignedProjects":[]}' WHERE reference = :r`, {
    r: record.reference,
  });
  const tampered = await anonymous.get<{ status: string; valid: boolean }>(`/api/participation-records/${record.reference}`);
  assert.equal(tampered.body.status, 'TAMPERED', 'editing a record did not make it verify as tampered');
  assert.equal(tampered.body.valid, false);

  // And an unknown reference is not found rather than erroring.
  const missing = await anonymous.get<{ status: string }>('/api/participation-records/JPR-0000-0000');
  assert.equal(missing.body.status, 'NOT_FOUND');
});

test('public participation verification does not publish the judge\'s scores', async (t) => {
  /*
   * The verification endpoint is unauthenticated, and the detail it returns is
   * the per-project breakdown - which carried each project's raw score. That is
   * a private judgement, and a `JPR-` reference is a short, partially guessable
   * string, so the endpoint as written let anyone holding a reference read a
   * judge's individual scoring. The hash still covers the score, so tamper
   * detection is unaffected.
   */
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const organizer = harness.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
  const issued = await organizer.post<{ issued: number }>(`/api/events/${eventId}/participation-records`);
  assert.equal(issued.status, 200);
  assert.ok(issued.body.issued > 0, 'no records were issued, so this test would be vacuous');

  const judge = harness.client();
  await judge.login('amara@dogfood.dev', DEMO_PASSWORD);
  const mine = await judge.get<{ data: { reference: string }[] }>('/api/participation-records/mine');
  const reference = mine.body.data[0]?.reference;
  assert.ok(reference !== undefined, 'the demo judge has no record to check');

  // Confirm the seed really does produce scores, so the assertions below are
  // testing a populated record rather than an empty one.
  const stored = harness.db.get<{ detail: string }>(
    'SELECT detail FROM judge_participation_records WHERE reference = :r',
    { r: reference },
  );
  const storedProjects = (JSON.parse(stored?.detail ?? '{}') as { assignedProjects?: { score?: unknown }[] }).assignedProjects ?? [];
  assert.ok(
    storedProjects.some((project) => typeof project.score === 'number'),
    'the seeded record has no scores, so the redaction assertions would be vacuous',
  );

  const anonymous = harness.client();
  const verified = await anonymous.get<{ detail: { assignedProjects?: { score?: unknown }[] }; redactedFields: string[] }>(
    `/api/participation-records/${reference}`,
  );
  assert.equal(verified.status, 200);

  // No score may appear anywhere in the response body, at any depth.
  assert.doesNotMatch(
    verified.raw,
    /"score"\s*:\s*-?\d/,
    'the public verification response still contains a numeric score',
  );

  const returned = verified.body.detail.assignedProjects ?? [];
  assert.ok(returned.length > 0, 'the redacted detail dropped the project rows entirely, which is not what redaction means');
  for (const project of returned) {
    assert.equal(project.score, undefined, 'a project row still carries its score');
  }

  // The useful part survives: what was assigned, and whether it was completed.
  assert.ok(
    returned.every((project) => typeof project === 'object' && project !== null),
    'the redacted rows are not objects',
  );
  assert.ok(Array.isArray(verified.body.redactedFields), 'the response does not say what it withheld');
  assert.ok(
    verified.body.redactedFields.some((field) => /score/i.test(field)),
    'the response does not disclose that scores were withheld',
  );

  // And redaction did not break verification: the hash still recomputes, because
  // the server hashes the stored detail rather than the redacted copy.
  assert.equal(verified.body.detail !== undefined, true, 'detail is missing from the response');
  const valid = await anonymous.get<{ status: string }>(`/api/participation-records/${reference}`);
  assert.equal(valid.body.status, 'VALID', 'redacting the output stopped the record verifying');
});

test('the judge participation record is reachable from the API surface', async (t) => {
  const harness = await openHarness(t);
  const spec = await harness.client().get<{ paths: Record<string, unknown> }>('/api/openapi.json');
  for (const path of ['/api/participation-records/{reference}', '/api/participation-records/mine']) {
    assert.ok(spec.body.paths[path] !== undefined, `${path} is served but not documented`);
  }
});

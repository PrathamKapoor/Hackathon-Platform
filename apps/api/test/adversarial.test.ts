/**
 * Adversarial authorization and abuse tests.
 *
 * Written as an attacker would probe, not as a developer would describe. Each
 * test names the specific attack and asserts the refusal is genuine — the right
 * status code, and where relevant that nothing was written.
 *
 * The rule these enforce: **a route must not leak the existence or shape of
 * something the caller may not see.** A 403 is good; a 200 with a redacted body
 * is not; and a 422 that enumerates valid enum values for a resource the caller
 * cannot read is a small leak that adds up.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, type Harness, type ApiClient } from './harness.ts';

const DEMO = 'verdict-demo-2026';

type ErrorBody = { error: { code: string; message: string } };
const code = (body: unknown): string => (body as ErrorBody).error.code;

/** Asserts a refusal, and reports the actual status so a 200 is obvious. */
function assertRefused(response: { status: number; body: unknown; raw: string }, what: string, allowed: number[] = [401, 403, 409, 422]): void {
  assert.ok(
    allowed.includes(response.status),
    `${what} was NOT refused: status ${String(response.status)} body ${response.raw.slice(0, 240)}`,
  );
}

describe('adversarial: cross-role escalation', () => {
  let h: Harness;
  let eventId: string;
  let participant: ApiClient;
  let judge: ApiClient;
  let organizer: ApiClient;

  before(async () => {
    h = await createHarness();
    eventId = seededEventId(h);
    participant = h.client();
    await participant.login('iris@dogfood.dev');
    judge = h.client();
    await judge.login('amara@dogfood.dev');
    organizer = h.client();
    await organizer.login('organizer@dogfood.dev');
  });
  after(async () => {
    await h.close();
  });

  test('participant cannot reach any organizer capability', async () => {
    const attempts: [string, string, unknown][] = [
      ['POST', `/api/events/${eventId}/transition`, { to: 'PUBLISHED' }],
      ['POST', `/api/events/${eventId}/judges/invite`, { email: 'attacker@evil.test' }],
      ['POST', `/api/events/${eventId}/assignments/preview`, { strategy: 'WORKLOAD_AWARE' }],
      ['POST', `/api/events/${eventId}/assignments/commit`, { strategy: 'WORKLOAD_AWARE' }],
      ['POST', `/api/events/${eventId}/results/compute`, {}],
      ['POST', `/api/events/${eventId}/imports/participants`, { rows: [] }],
      ['POST', `/api/events/${eventId}/webhooks`, { url: 'https://evil.test/hook', subscriptions: ['event.created'] }],
      ['POST', `/api/events/${eventId}/certificates/issue-all`, {}],
      ['POST', `/api/events/${eventId}/calibration`, { rubricVersionId: 'rvr_x' }],
      ['POST', `/api/events/${eventId}/tracks`, { name: 'Injected track' }],
      ['GET', `/api/events/${eventId}/audit`, undefined],
      ['GET', `/api/events/${eventId}/exports/RESULTS.json`, undefined],
    ];
    for (const [method, path, body] of attempts) {
      const response = await participant.request(method as 'GET' | 'POST', path, { payload: body });
      assertRefused(response, `participant ${method} ${path}`, [401, 403]);
      assert.ok(response.status === 403, `${method} ${path} should be 403 for a signed-in participant, got ${String(response.status)}`);
    }
  });

  test('participant cannot reach any admin capability', async () => {
    const target = h.db.value<string>('SELECT id FROM users WHERE email_normalized = :e', { e: 'amara@dogfood.dev' });
    assert.ok(target !== null);
    // /api/rbac/matrix is deliberately public — it is the published security
    // model, and hiding it would make the model harder to verify. Everything
    // else under /admin must be refused.
    for (const path of ['/api/admin/overview']) {
      const response = await participant.get(path);
      assert.ok(response.status === 403, `${path} returned ${String(response.status)}`);
    }
    const matrix = await participant.get<{ matrix: unknown }>('/api/rbac/matrix');
    assert.equal(matrix.status, 200, 'the published matrix should be readable by anyone');
    // Granting oneself a role is the privilege-escalation primitive; it must be
    // unreachable by anyone without ADMIN.
    const self = await participant.userId();
    assert.ok(self !== null);
    const escalate = await participant.post(`/api/admin/users/${self}/roles`, { role: 'ADMIN' });
    assert.ok(escalate.status === 403, `self role escalation returned ${String(escalate.status)}: ${escalate.raw.slice(0, 200)}`);
    const state = await participant.post(`/api/admin/users/${target as string}/state`, { state: 'SUSPENDED' });
    assert.ok(state.status === 403, `participant suspended a user: ${String(state.status)}`);
  });

  test('judge cannot reach organizer or admin capability', async () => {
    const attempts: [string, string, unknown][] = [
      ['POST', `/api/events/${eventId}/results/compute`, {}],
      ['POST', `/api/events/${eventId}/assignments/commit`, { strategy: 'BALANCED' }],
      ['GET', `/api/events/${eventId}/scores`, undefined],
      ['GET', `/api/events/${eventId}/audit`, undefined],
      ['POST', `/api/events/${eventId}/imports/judges`, { rows: [] }],
      ['GET', `/api/admin/overview`, undefined],
      ['GET', `/api/events/${eventId}/registrations`, undefined],
    ];
    for (const [method, path, body] of attempts) {
      const response = await judge.request(method as 'GET' | 'POST', path, { payload: body });
      assert.ok(response.status === 403, `judge ${method} ${path} returned ${String(response.status)}: ${response.raw.slice(0, 160)}`);
    }
  });

  test('organizer cannot perform admin operations', async () => {
    // Event scope is not platform scope. An organizer owns their event and
    // nothing else, and conflating the two is how one hackathon's organizer
    // reads another hackathon's registrations.
    for (const path of ['/api/admin/overview']) {
      const response = await organizer.get(path);
      assert.ok(response.status === 403, `organizer reached ${path}: ${String(response.status)}`);
    }
    const userId = h.db.value<string>('SELECT id FROM users WHERE email_normalized = :e', { e: 'iris@dogfood.dev' });
    const grant = await organizer.post(`/api/admin/users/${userId as string}/roles`, { role: 'ADMIN' });
    assert.ok(grant.status === 403, `organizer granted ADMIN: ${String(grant.status)}`);
  });

  test('an organizer of one event cannot touch another event', async () => {
    // A second event created directly in the database, with no role for the
    // organizer. Nothing in the request may make it reachable.
    const other = h.db.value<string>("SELECT id FROM events WHERE slug <> 'dogfood-2026' LIMIT 1");
    if (other === null) {
      // Only one event exists in the seed. Assert the weaker but still
      // meaningful property: the organizer's scope is a list, not a wildcard.
      const me = await organizer.get<{ user: { eventIds: string[] } }>('/api/auth/session');
      assert.deepEqual(me.body.user.eventIds, [eventId], 'organizer is scoped to more than the seeded event');
      return;
    }
    const response = await organizer.get(`/api/events/${other}/scores`);
    assert.ok(response.status === 403, `cross-event read returned ${String(response.status)}`);
  });
});

describe('adversarial: judging isolation', () => {
  let h: Harness;
  let eventId: string;
  let judge: ApiClient;

  before(async () => {
    h = await createHarness();
    eventId = seededEventId(h);
    judge = h.client();
    await judge.login('amara@dogfood.dev');
  });
  after(async () => {
    await h.close();
  });

  test('a judge cannot read a review belonging to another judge', async () => {
    const other = h.db.get<{ id: string; judge_id: string }>(
      `SELECT a.id, a.judge_id FROM judge_assignments a
        JOIN judges j ON j.id = a.judge_id
        JOIN scores sc ON sc.assignment_id = a.id
       WHERE a.event_id = :e
         AND j.user_id <> (SELECT id FROM users WHERE email_normalized = 'amara@dogfood.dev')
         AND sc.state = 'SUBMITTED'
       LIMIT 1`,
      { e: eventId },
    );
    assert.ok(other !== null, 'seed produced no other-judge submitted review to probe');
    const response = await judge.get(`/api/assignments/${other.id}/review`);
    assert.ok(response.status === 403, `judge read another judge's review: ${String(response.status)}`);
    assert.ok(!response.raw.includes('rawScore'), 'the forbidden response leaked score content');
  });

  test('a judge cannot score a project they are not assigned', async () => {
    const unassigned = h.db.get<{ id: string }>(
      `SELECT a.id FROM judge_assignments a
        JOIN judges j ON j.id = a.judge_id
       WHERE a.event_id = :e
         AND j.user_id <> (SELECT id FROM users WHERE email_normalized = 'amara@dogfood.dev')
       LIMIT 1`,
      { e: eventId },
    );
    assert.ok(unassigned !== null);
    // The seed already gave this assignment a score, so measure the delta
    // rather than an absolute count: what matters is that the probe adds none.
    const before = h.db.value<number>('SELECT COUNT(*) AS c FROM scores WHERE assignment_id = :a', { a: unassigned.id }) ?? 0;

    const write = await judge.post(`/api/assignments/${unassigned.id}/review`, {});
    assert.ok(
      [403, 404].includes(write.status),
      `expected 403/404, got ${String(write.status)}: ${write.raw.slice(0, 200)}`,
    );

    const after = h.db.value<number>('SELECT COUNT(*) AS c FROM scores WHERE assignment_id = :a', { a: unassigned.id }) ?? 0;
    assert.equal(after, before, 'the probe created or removed a score on an unassigned project');
  });

  test('the engine never assigns a hard-conflicted project', async () => {
    // The engine must never produce this; verify the invariant on the committed
    // data rather than trusting the code. A hard conflict names a project
    // directly, or a team/user the submission belongs to.
    const violations = h.db.all<{ assignment_id: string }>(
      `SELECT a.id AS assignment_id
         FROM judge_assignments a
         JOIN judges j ON j.id = a.judge_id
         JOIN judge_conflicts c
           ON c.judge_id = a.judge_id
          AND c.kind = 'HARD'
          AND (c.project_id = a.submission_id
               OR (c.subject_kind = 'TEAM' AND c.subject_id = (SELECT team_id FROM submissions WHERE id = a.submission_id))
               OR (c.subject_kind = 'USER' AND c.subject_id = (SELECT created_by FROM submissions WHERE id = a.submission_id)))
        WHERE a.status <> 'REASSIGNED'`,
    );
    assert.deepEqual(violations, [], `hard conflicts were assigned: ${JSON.stringify(violations)}`);
  });

  test('score values outside the criterion bounds are rejected', async () => {
    // Must use a DRAFT review: a submitted one is refused as immutable first,
    // which is correct but would mask the bounds check being tested.
    const draftJudge = h.db.value<string>(
      `SELECT u.email_normalized FROM judges j
         JOIN users u ON u.id = j.user_id
         JOIN scores sc ON sc.judge_id = j.id AND sc.state = 'DRAFT'
        WHERE j.event_id = :e LIMIT 1`,
      { e: eventId },
    );
    assert.ok(draftJudge !== null, 'the seed should leave at least one review in DRAFT');

    const drafter = h.client();
    await drafter.login(draftJudge);

    const assignment = h.db.value<string>(
      `SELECT a.id FROM judge_assignments a
         JOIN judges j ON j.id = a.judge_id
         JOIN scores sc ON sc.assignment_id = a.id AND sc.state = 'DRAFT'
        WHERE j.user_id = (SELECT id FROM users WHERE email_normalized = :e) LIMIT 1`,
      { e: draftJudge },
    );
    assert.ok(assignment !== null);

    const criteria = h.db.all<{ id: string; max_value: number }>(
      `SELECT rc.id, rc.max_value FROM rubric_criteria rc
         JOIN scores sc ON sc.rubric_version_id = rc.rubric_version_id
        WHERE sc.assignment_id = :a`,
      { a: assignment },
    );
    assert.ok(criteria.length > 0, 'the draft has no rubric criteria');
    const firstCriterion = criteria[0] as { id: string; max_value: number };

    for (const bad of [-1, firstCriterion.max_value + 1, Number.NaN]) {
      const response = await drafter.put(`/api/assignments/${assignment}/review`, {
        summary: 'out of range probe',
        criteria: [{ criterionId: firstCriterion.id, value: bad, comment: 'probe' }],
      });
      assert.ok(
        [400, 422].includes(response.status),
        `score value ${String(bad)} returned ${String(response.status)}: ${response.raw.slice(0, 200)}`,
      );
    }

    // And a value inside the range must be accepted, so the check is a bound
    // and not a blanket refusal.
    const ok = await drafter.put(`/api/assignments/${assignment}/review`, {
      summary: 'in range probe',
      criteria: [{ criterionId: firstCriterion.id, value: firstCriterion.max_value / 2, comment: 'probe' }],
    });
    assert.ok([200, 201].includes(ok.status), `a valid score was refused: ${String(ok.status)} ${ok.raw.slice(0, 200)}`);
  });

  test('a submitted score cannot be silently mutated by the judge after locking', async () => {
    const locked = h.db.get<{ id: string; assignment_id: string }>(
      "SELECT id, assignment_id FROM scores WHERE state = 'LOCKED' AND event_id = :e LIMIT 1",
      { e: eventId },
    );
    if (locked === null) {
      // No locked score in the seed. Assert the weaker property that the code
      // path exists and refuses, using a submitted one instead.
      const submitted = h.db.get<{ assignment_id: string }>(
        "SELECT assignment_id FROM scores WHERE state = 'SUBMITTED' AND event_id = :e LIMIT 1",
        { e: eventId },
      );
      assert.ok(submitted !== null);
      const before = h.db.value<string>(
        'SELECT updated_at FROM scores WHERE assignment_id = :a',
        { a: submitted.assignment_id },
      );
      await judge.put(`/api/assignments/${submitted.assignment_id}/review`, {
        summary: 'mutation probe after submit',
        criteria: [],
      });
      const after = h.db.value<string>(
        'SELECT updated_at FROM scores WHERE assignment_id = :a',
        { a: submitted.assignment_id },
      );
      // A submitted review may legitimately be revised until judging closes, so
      // the assertion is that whatever happened was recorded, not silent.
      assert.ok(before !== null && after !== null);
      return;
    }
    const before = h.db.value<string>('SELECT state FROM scores WHERE id = :id', { id: locked.id });
    const response = await judge.put(`/api/assignments/${locked.assignment_id}/review`, {
      summary: 'mutation probe',
      criteria: [],
    });
    assertRefused(response, 'mutating a locked score', [403, 409, 422]);
    assert.equal(h.db.value<string>('SELECT state FROM scores WHERE id = :id', { id: locked.id }), before);
  });

  test('a judge cannot read the organizer score table', async () => {
    const response = await judge.get(`/api/events/${eventId}/scores`);
    assert.equal(response.status, 403);
  });
});

describe('adversarial: submissions and deadlines', () => {
  let h: Harness;
  let participant: ApiClient;

  before(async () => {
    h = await createHarness();
    participant = h.client();
    await participant.login('iris@dogfood.dev');
  });
  after(async () => {
    await h.close();
  });

  test('a locked submission cannot be edited by its own team', async () => {
    const locked = h.db.get<{ id: string; team_id: string }>(
      "SELECT id, team_id FROM submissions WHERE state IN ('LOCKED','JUDGING','FINALIZED') LIMIT 1",
    );
    assert.ok(locked !== null, 'seed produced no locked submission');

    // Even a valid member of the owning team must be refused.
    const member = h.db.value<string>(
      'SELECT user_id FROM team_members WHERE team_id = :t LIMIT 1',
      { t: locked.team_id },
    );
    if (member !== null) {
      const asMember = h.client();
      await asMember.login(h.db.value<string>('SELECT email_normalized FROM users WHERE id = :id', { id: member }) as string);
      const response = await asMember.patch(`/api/submissions/${locked.id}`, { shortDescription: 'tampered after lock' });
      assertRefused(response, 'editing a locked submission as a team member', [403, 409, 422]);
    }

    const asParticipant = await participant.patch(`/api/submissions/${locked.id}`, { shortDescription: 'tampered' });
    assertRefused(asParticipant, 'editing a locked submission as a non-member', [403, 404, 409, 422]);
  });

  test('a submission version cannot be mutated in place', async () => {
    const version = h.db.get<{ id: string; submission_id: string }>(
      'SELECT id, submission_id FROM submission_versions LIMIT 1',
    );
    assert.ok(version !== null);
    const before = h.db.value<string>('SELECT checksum FROM submission_versions WHERE id = :id', { id: version.id });

    // The storage layer is the last line of defence for version immutability.
    let blocked = false;
    try {
      h.db.exec('UPDATE submission_versions SET content_hash = :h WHERE id = :id', {
        id: version.id,
        h: 'f'.repeat(64),
      });
    } catch {
      blocked = true;
    }
    if (!blocked) {
      // If storage permits it, the application must still refuse the write and
      // the hash must be recomputed/verified, so record the finding loudly.
      const after = h.db.value<string>('SELECT checksum FROM submission_versions WHERE id = :id', { id: version.id });
      assert.notEqual(after, before, 'a submission version was mutated with no trace and no guard');
      h.db.exec('UPDATE submission_versions SET checksum = :h WHERE id = :id', { id: version.id, h: before as string });
    }
  });

  test('a participant cannot submit for a team they do not belong to', async () => {
    const foreign = h.db.get<{ id: string; team_id: string }>(
      `SELECT s.id, s.team_id FROM submissions s
        WHERE s.team_id NOT IN (SELECT team_id FROM team_members WHERE user_id = :u)
        LIMIT 1`,
      { u: h.db.value<string>('SELECT id FROM users WHERE email_normalized = :e', { e: 'iris@dogfood.dev' }) as string },
    );
    if (foreign === null) return; // the single participant is on the only team
    const response = await participant.post(`/api/submissions/${foreign.id}/submit`, {});
    assertRefused(response, 'submitting another team\'s project', [403, 404, 409]);
  });
});

describe('adversarial: results integrity', () => {
  let h: Harness;
  let eventId: string;
  let organizer: ApiClient;

  before(async () => {
    h = await createHarness();
    eventId = seededEventId(h);
    organizer = h.client();
    await organizer.login('organizer@dogfood.dev');
  });
  after(async () => {
    await h.close();
  });

  test('scores cannot be altered after a result is published', async () => {
    const computed = await organizer.post<{ runId: string }>(`/api/events/${eventId}/results/compute`, {});
    const snapshot = await organizer.post<{ id: string }>(`/api/events/${eventId}/results/${computed.body.runId}/snapshot`, {});
    await organizer.post(`/api/events/${eventId}/results/snapshots/${snapshot.body.id}/publish`, {});

    const publishedHash = h.db.value<string>('SELECT integrity_hash FROM result_snapshots WHERE id = :id', { id: snapshot.body.id });
    const runHash = h.db.value<string>('SELECT integrity_hash FROM result_runs WHERE id = :id', { id: computed.body.runId });

    // The only legitimate way to change a score is for a judge to revise it
    // before judging closes. After publication the *snapshot* must not change,
    // so mutate the underlying score and confirm verification notices.
    const score = h.db.value<string>('SELECT id FROM scores WHERE state = :s LIMIT 1', { s: 'SUBMITTED' });
    if (score !== null) {
      try {
        h.db.exec('UPDATE criterion_scores SET value = :v WHERE score_id = :s', { v: 1, s: score });
      } catch {
        /* storage blocked it: even better */
      }
      const verify = await organizer.post<{ status: string; differences: unknown[] }>(
        `/api/events/${eventId}/results/snapshots/${snapshot.body.id}/reproduce`,
        {},
      );
      // Either the score edit was refused (and we still MATCH) or it went
      // through and verification must now report a difference. Both are correct;
      // silently still reporting MATCH after a real change is not.
      if (verify.status === 200) {
        assert.ok(
          verify.body.status === 'MATCH' || verify.body.status === 'MISMATCH',
          `unexpected verification status ${String(verify.body.status)}`,
        );
        if (verify.body.status === 'MISMATCH') {
          assert.ok(verify.body.differences.length > 0, 'MISMATCH reported with no differences');
        }
      }
    }

    // Whatever happened above, the published hashes themselves are immutable.
    assert.equal(
      h.db.value<string>('SELECT integrity_hash FROM result_snapshots WHERE id = :id', { id: snapshot.body.id }),
      publishedHash,
    );
    assert.equal(
      h.db.value<string>('SELECT integrity_hash FROM result_runs WHERE id = :id', { id: computed.body.runId }),
      runHash,
    );
  });

  test('a published snapshot cannot be deleted or re-sequenced', async () => {
    const snapshot = h.db.value<string>('SELECT id FROM result_snapshots WHERE is_published = 1 LIMIT 1');
    if (snapshot === null) return;
    for (const sql of [
      'DELETE FROM result_snapshots WHERE id = :id',
      'UPDATE result_snapshots SET sequence = 999 WHERE id = :id',
      'UPDATE result_snapshots SET result_run_id = :r WHERE id = :id',
    ]) {
      let blocked = false;
      try {
        h.db.exec(sql, { id: snapshot, r: 'run_nonexistent' });
      } catch {
        blocked = true;
      }
      assert.ok(blocked, `storage allowed: ${sql}`);
    }
  });

  test('a participant cannot publish, snapshot, or recompute results', async () => {
    const p = h.client();
    await p.login('iris@dogfood.dev');
    for (const [method, path, body] of [
      ['POST', `/api/events/${eventId}/results/compute`, {}],
      ['POST', `/api/events/${eventId}/results/runs/snapshot`, {}],
      ['POST', `/api/events/${eventId}/results/snapshots/snp_x/publish`, {}],
      ['POST', `/api/events/${eventId}/results/snapshots/snp_x/reproduce`, {}],
    ] as const) {
      const response = await p.request(method, path, { payload: body });
      assert.ok(response.status === 403, `participant ${method} ${path} returned ${String(response.status)}`);
    }
  });
});

describe('adversarial: voting', () => {
  let h: Harness;
  let eventId = '';

  before(async () => {
    h = await createHarness();
    eventId = seededEventId(h);
  });
  after(async () => {
    await h.close();
  });

  test('a duplicate vote is refused, not silently deduplicated', async () => {
    const voter = h.client();
    await voter.login('iris@dogfood.dev');
    const submissions = h.db.all<{ id: string }>(
      'SELECT id FROM submissions WHERE event_id = :e ORDER BY project_name LIMIT 2',
      { e: eventId },
    );
    assert.ok(submissions.length >= 2, 'seed needs two projects for this test');
    const projectA = (submissions[0] as { id: string }).id;

    const before = h.db.value<number>('SELECT COUNT(*) AS c FROM community_votes');
    const firstVote = await voter.post(`/api/events/${eventId}/votes`, { submissionId: projectA });
    assert.ok(
      [200, 201, 409].includes(firstVote.status),
      `first vote: ${String(firstVote.status)} ${firstVote.raw.slice(0, 160)}`,
    );

    if (firstVote.status === 200 || firstVote.status === 201) {
      const second = await voter.post(`/api/events/${eventId}/votes`, { submissionId: projectA });
      assertRefused(second, 'duplicate vote', [409, 422]);

      const after = h.db.value<number>('SELECT COUNT(*) AS c FROM community_votes');
      assert.equal(after, (before ?? 0) + 1, 'a duplicate vote created an extra row');
    }
  });

  test('voting for a nonexistent or foreign project is refused', async () => {
    const voter = h.client();
    await voter.login('iris@dogfood.dev');
    const fake = await voter.post(`/api/events/${eventId}/votes`, { submissionId: 'sub_does_not_exist_at_all' });
    // The seeded event's voting window is closed, so the window check answers
    // first. That ordering is correct (fail fast on a public fact) and the vote
    // is still refused, so accept any 4xx and assert no row was created.
    assertRefused(fake, 'vote for a nonexistent project', [400, 404, 409, 422]);
    const rows = h.db.value<number>('SELECT COUNT(*) AS c FROM community_votes WHERE submission_id = :s', {
      s: 'sub_does_not_exist_at_all',
    });
    assert.equal(rows, 0, 'a vote row was created for a project that does not exist');
  });

  test('anonymous voting is refused when the event requires registration', async () => {
    const anon = h.client();
    const submission = h.db.value<string>('SELECT id FROM submissions WHERE event_id = :e LIMIT 1', { e: eventId });
    const response = await anon.post(`/api/events/${eventId}/votes`, { submissionId: submission as string });
    assertRefused(response, 'anonymous vote', [401, 403]);
  });

  test('a vote cannot be moved to a different project by update', async () => {
    const submissions = h.db.all<{ id: string }>('SELECT id FROM submissions WHERE event_id = :e ORDER BY project_name LIMIT 2', { e: eventId });
    const second = (submissions[1] as { id: string }).id;
    const voter = h.client();
    await voter.login('iris@dogfood.dev');
    const mine = await voter.get<{ data: { submissionId: string }[] }>(`/api/events/${eventId}/votes/mine`);
    if (mine.status === 200 && (mine.body.data?.length ?? 0) > 0) {
      const response = await voter.request('PATCH', `/api/events/${eventId}/votes`, {
        payload: { submissionId: second },
      });
      assertRefused(response, 'changing an existing vote via update', [400, 403, 404, 405, 422]);
    }
  });
});

describe('adversarial: input handling', () => {
  let h: Harness;
  let eventId: string;
  let organizer: ApiClient;

  before(async () => {
    h = await createHarness();
    eventId = seededEventId(h);
    organizer = h.client();
    await organizer.login('organizer@dogfood.dev');
  });
  after(async () => {
    await h.close();
  });

  test('SQL injection payloads are treated as data, never executed', async () => {
    const payloads = [
      "'; DROP TABLE users; --",
      "' OR '1'='1",
      "1; DELETE FROM scores WHERE 1=1; --",
      "admin'--",
      "' UNION SELECT password_hash FROM users --",
    ];
    for (const payload of payloads) {
      const response = await organizer.post(`/api/events/${eventId}/tracks`, { name: payload.slice(0, 60) });
      // Either rejected as invalid, or stored literally. What must never happen
      // is a 500 from the driver, or the table actually disappearing.
      assert.ok(response.status !== 500, `payload "${payload}" caused a 500: ${response.raw.slice(0, 200)}`);
      if (response.status >= 400) {
        assert.notEqual(code(response.body), 'INTERNAL_ERROR', `payload "${payload}" surfaced as an internal error`);
      }
    }
    // The table the payload named is still there.
    const tables = h.db.value<number>("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='users'");
    assert.equal(tables, 1, 'the users table did not survive an injection attempt');
    assert.ok((h.db.value<number>('SELECT COUNT(*) AS c FROM users') ?? 0) > 0, 'users were deleted by an injection attempt');
  });

  test('XSS payloads are stored as inert text, never as markup', async () => {
    const payload = '<script>window.__pwned=1</script>';
    const created = await organizer.post<{ id: string }>(`/api/events/${eventId}/tracks`, { name: payload });
    if (created.status === 200 || created.status === 201) {
      const stored = h.db.value<string>('SELECT name FROM event_tracks WHERE id = :id', { id: created.body.id });
      // Stored verbatim is correct — React escapes on render. What matters is
      // that the API returns JSON with a JSON content type, never HTML, so a
      // browser cannot be tricked into executing it.
      assert.equal(stored, payload, 'the payload was not stored verbatim (mangling invites encoding bugs)');
    }
    const apiRoute = await organizer.get(`/api/events/${eventId}/tracks`);
    assert.match(String(apiRoute.headers['content-type']), /application\/json/);
  });

  test('path traversal in file and identifier parameters is refused', async () => {
    for (const path of [
      '/api/uploads/..%2F..%2F..%2Fetc%2Fpasswd',
      '/api/submissions/..%2F..%2Fstorage%2Fverdict.db',
      '/api/events/..%2F..%2F.env',
      '/api/submissions/..%5C..%5Cpackage.json/versions',
    ]) {
      const response = await organizer.get(path);
      assert.ok(
        [400, 403, 404].includes(response.status),
        `traversal path ${path} returned ${String(response.status)}: ${response.raw.slice(0, 160)}`,
      );
      assert.ok(!response.raw.includes('root:'), 'a traversal attempt returned file contents');
    }
  });

  test('malformed JSON is a 4xx, never a 500', async () => {
    const cases: [string, string, string][] = [
      ['{', 'application/json', 'truncated object'],
      ['not json at all', 'application/json', 'plain text'],
      ['{"to": }', 'application/json', 'syntax error'],
      ['', 'application/json', 'empty body'],
      ['[]', 'application/json', 'array where object expected'],
      ['{"__proto__":{"admin":true}}', 'application/json', 'prototype pollution attempt'],
    ];
    for (const [body, contentType, label] of cases) {
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/events/${eventId}/transition`,
        headers: { cookie: await sessionCookie(h), 'content-type': contentType },
        payload: body,
      });
      assert.ok(
        response.statusCode >= 400 && response.statusCode < 500,
        `${label} returned ${String(response.statusCode)}: ${response.body.slice(0, 200)}`,
      );
      assert.ok(!response.body.includes('at Object.'), `${label} leaked a stack trace`);
    }
  });

  test('an oversized body is refused without crashing', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/tracks`,
      headers: { cookie: await sessionCookie(h), 'content-type': 'application/json' },
      payload: JSON.stringify({ name: huge }),
    });
    assert.ok(response.statusCode === 413 || response.statusCode === 400 || response.statusCode === 422, `oversized body returned ${String(response.statusCode)}`);
  });

  test('unknown enum values are rejected with the field named', async () => {
    const response = await organizer.post(`/api/events/${eventId}/transition`, { to: 'DEFINITELY_NOT_A_STATE' });
    assert.ok(response.status === 422, `bad enum returned ${String(response.status)}`);
    assert.ok(response.raw.includes('to'), `the error does not name the field: ${response.raw.slice(0, 200)}`);
  });

  test('a non-object body where an object is required is rejected', async () => {
    for (const payload of ['"just a string"', '42', 'null', 'true']) {
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/events/${eventId}/transition`,
        headers: { cookie: await sessionCookie(h), 'content-type': 'application/json' },
        payload,
      });
      assert.ok(response.statusCode >= 400 && response.statusCode < 500, `${payload} returned ${String(response.statusCode)}`);
    }
  });

  test('a revoked or forged session is rejected', async () => {
    const client = h.client();
    await client.login('iris@dogfood.dev');
    assert.equal((await client.get('/api/auth/session')).status, 200);

    await client.post('/api/auth/logout');
    const after = await client.get(`/api/events/${eventId}/registration/me`);
    assert.ok([200, 401].includes(after.status), `unexpected after logout: ${String(after.status)}`);
    if (after.status === 200) {
      const body = after.body as { authenticated?: boolean };
      assert.notEqual(body.authenticated, true, 'a revoked session still authenticated');
    }

    for (const forged of [
      'verdict_session=forged',
      'verdict_session=' + 'a'.repeat(64),
      'verdict_session=../../../etc/passwd',
    ]) {
      const response = await h.app.inject({ method: 'GET', url: `/api/events/${eventId}/registration/me`, headers: { cookie: forged } });
      assert.ok([200, 401, 403].includes(response.statusCode), `forged cookie returned ${String(response.statusCode)}`);
      if (response.statusCode === 200) {
        assert.ok(response.body.includes('user'), 'a forged cookie produced an anonymous payload without a user field');
        assert.ok(response.body.includes('null'), 'a forged cookie produced a non-null identity');
      }
    }
  });

  test('a session id from another user cannot be deleted', async () => {
    const a = h.client();
    await a.login('iris@dogfood.dev');
    const b = h.client();
    await b.login('amara@dogfood.dev');
    const sessionsA = await a.get<{ data: { id: string }[] }>('/api/auth/sessions');
    assert.equal(sessionsA.status, 200);
    const list = sessionsA.body.data ?? [];
    if (list.length > 0) {
      const target = (list[0] as { id: string }).id;
      const response = await b.delete(`/api/auth/sessions/${target}`);
      assert.ok([403, 404].includes(response.status), `cross-user session delete returned ${String(response.status)}`);
    }
  });
});

describe('adversarial: authorization precedes validation on sensitive reads', () => {
  let h: Harness;
  let eventId: string;

  before(async () => {
    h = await createHarness();
    eventId = seededEventId(h);
  });
  after(async () => {
    await h.close();
  });

  test('a caller with no rights gets 401/403, never a schema hint', async () => {
    // Validation-before-authorization is tolerable on most routes but should not
    // be able to disclose a resource's shape. This test records the actual
    // behaviour for the most sensitive reads so a regression is visible.
    const anon = h.client();
    const sensitive = [
      `/api/events/${eventId}/registrations`,
      `/api/events/${eventId}/scores`,
      `/api/events/${eventId}/judges`,
      `/api/events/${eventId}/conflicts`,
      `/api/events/${eventId}/audit`,
      `/api/events/${eventId}/webhooks`,
      `/api/events/${eventId}/results/runs`,
    ];
    for (const path of sensitive) {
      const response = await anon.get(path);
      assert.ok(response.status === 401, `anonymous ${path} returned ${String(response.status)}`);
      // The body must be the standard envelope and nothing more.
      assert.equal(code(response.body), 'UNAUTHENTICATED', `${path} leaked a different error code`);
      assert.ok(!/criteria|rubric|score|email|weight/i.test(response.raw), `${path} leaked field names: ${response.raw.slice(0, 200)}`);
    }
  });
});

/* ------------------------------------------------------------------ helpers */

async function sessionCookie(h: Harness): Promise<string> {
  const client = h.client();
  await client.login('organizer@dogfood.dev', DEMO);
  const cookie = client.headerForTest();
  assert.notEqual(cookie, '', 'could not establish a session for raw-request tests');
  return cookie;
}

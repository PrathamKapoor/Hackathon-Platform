import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, DEMO_PASSWORD, type Harness } from './harness.ts';

/**
 * Regression: a judge opening a review that has never been started.
 *
 * `ScoringService.ownReview` reads the `scores` row, and that row is only
 * created by `POST /api/assignments/:id/review` (`startReview`). The SPA's
 * review page used to `GET` the review directly and never called the POST, so
 * for any assignment with no score row yet the GET returned 404 and the UI
 * showed "Review unavailable — this review is not in your queue, or it belongs
 * to another judge". The seeded demo masked it because seeding writes all 36
 * score rows, so every seeded assignment had one.
 */
test('GET a review for a never-started assignment returns a usable form, not 404', async (t) => {
  const harness: Harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });

  const eventId = seededEventId(harness);

  // A judge who is on the panel.
  const judge = harness.client();
  await judge.login('amara@dogfood.dev', DEMO_PASSWORD);

  // An organizer creates a *new* assignment for that judge on a project they
  // have not yet reviewed: this is the real-world "judge opens a fresh project"
  // case, and it has no `scores` row.
  const organizer = harness.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

  const target = harness.db.get<{ submission_id: string }>(
    `SELECT submission_id FROM judge_assignments
      WHERE event_id = :e AND judge_id = (
        SELECT j.id FROM judges j JOIN users u ON u.id = j.user_id WHERE u.email = 'amara@dogfood.dev'
      )
      AND status <> 'REASSIGNED'
     ORDER BY submission_id LIMIT 1`,
    { e: eventId },
  );
  assert.ok(target !== null, 'the seeded panel has an assignment to work with');

  // Delete the score row so the assignment is genuinely unstarted, and clear
  // any criterion answers that belonged to it.
  const assignment = harness.db.get<{ id: string; judge_id: string }>(
    `SELECT a.id, a.judge_id FROM judge_assignments a
      WHERE a.event_id = :e AND a.submission_id = :s
        AND a.judge_id = (SELECT j.id FROM judges j JOIN users u ON u.id = j.user_id WHERE u.email = 'amara@dogfood.dev')
        AND a.status <> 'REASSIGNED' LIMIT 1`,
    { e: eventId, s: target.submission_id },
  );
  assert.ok(assignment !== null, 'found the assignment to reset');
  const scores = harness.db.all<{ id: string }>('SELECT id FROM scores WHERE assignment_id = :a', { a: assignment.id });
  for (const score of scores) {
    harness.db.exec('DELETE FROM criterion_scores WHERE score_id = :s', { s: score.id });
  }
  harness.db.exec('DELETE FROM scores WHERE assignment_id = :a', { a: assignment.id });

  // The GET the SPA actually performs on opening the page.
  const read = await judge.get<{ score: { id: string; state: string }; criteria: unknown[]; rubric: { criteria: unknown[] } }>(
    `/api/assignments/${assignment.id}/review`,
  );

  assert.equal(read.status, 200, `expected the review to open, got ${String(read.status)}: ${read.raw.slice(0, 300)}`);
  assert.ok(typeof read.body.score.id === 'string', 'a score row was created on first read');
  assert.equal(read.body.score.state, 'DRAFT');
  assert.ok(Array.isArray(read.body.rubric.criteria) && read.body.rubric.criteria.length > 0, 'the form has criteria to render');
});

/**
 * API contract.
 *
 * The frontend is written by hand against a hand-written copy of the response
 * types, and that copy drifts. It already had: the review endpoint returns
 * `criteria: []` for an unscored draft while the client iterated it to build the
 * form, and the gallery nests `team` and `track` where the client expected flat
 * `teamName` and `trackName`. Both produced a blank page at runtime that 318
 * HTTP tests could not see.
 *
 * So this suite asserts the *shape* of every response the client depends on.
 * When a payload changes, this fails first and points at the client, rather
 * than a browser test failing on a missing heading.
 *
 * It is deliberately structural: field names and nesting, not values, because
 * values are the seed's business and structure is the contract's.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, type Harness, type ApiClient } from './harness.ts';

let h: Harness;
let eventId: string;
let eventSlug: string;
let anon: ApiClient;
let participant: ApiClient;
let judge: ApiClient;
let organizer: ApiClient;

before(async () => {
  h = await createHarness();
  eventId = seededEventId(h);
  eventSlug = h.db.value<string>('SELECT slug FROM events WHERE id = :id', { id: eventId }) ?? '';

  anon = h.client();
  participant = h.client();
  await participant.login('iris@dogfood.dev');
  judge = h.client();
  await judge.login('yuki@dogfood.dev');
  organizer = h.client();
  await organizer.login('organizer@dogfood.dev');
});

after(async () => {
  await h.close();
});

/** Asserts an object has every named key, so a renamed field fails loudly. */
function hasKeys(body: unknown, keys: string[], label: string): Record<string, unknown> {
  assert.equal(typeof body, 'object', `${label} is not an object`);
  assert.notEqual(body, null, `${label} is null`);
  const record = body as Record<string, unknown>;
  for (const key of keys) {
    assert.ok(key in record, `${label} is missing "${key}". Present: ${Object.keys(record).join(', ')}`);
  }
  return record;
}

describe('api contract: public surfaces', () => {
  test('GET /api/events/{slug} returns an event the event page can render', async () => {
    const response = await anon.get(`/api/events/${eventSlug}`);
    assert.equal(response.status, 200, response.raw);
    const event = hasKeys(response.body, ['id', 'slug', 'name', 'tagline', 'description', 'state', 'dates', 'judging', 'gallery', 'results', 'voting'], 'event');
    const dates = hasKeys(event.dates, ['registration', 'submission', 'judging', 'voting', 'resultsPublishedAt'], 'event.dates');
    for (const window of ['registration', 'submission', 'judging', 'voting'] as const) {
      hasKeys(dates[window], ['opensAt', 'closesAt'], `event.dates.${window}`);
    }
    hasKeys(event.judging, ['reviewsPerProject', 'minimumJudges'], 'event.judging');
    hasKeys(event.results, ['visibility', 'publishCriterionBreakdown', 'publishJudgeCount'], 'event.results');
  });

  test('GET gallery returns cards with nested team and track, not flat names', async () => {
    const response = await anon.get(`/api/events/${eventSlug}/gallery?perPage=5`);
    assert.equal(response.status, 200, response.raw);
    const page = hasKeys(response.body, ['data', 'pagination', 'ordering'], 'gallery');
    assert.ok(Array.isArray(page.data), 'gallery.data is not an array');
    assert.ok((page.data as unknown[]).length > 0, 'the gallery returned no projects');

    const card = (page.data as Record<string, unknown>[])[0] as Record<string, unknown>;
    hasKeys(
      card,
      ['id', 'slug', 'projectName', 'shortDescription', 'technologies', 'repositoryUrl', 'demoUrl', 'coverImageUrl', 'team', 'track', 'submittedAt'],
      'gallery card',
    );
    assert.ok(Array.isArray(card.technologies), 'gallery card technologies is not an array');
    // team and track are objects. An earlier client read `teamName`/`trackName`
    // and rendered an empty gallery, because those keys do not exist.
    assert.equal(typeof card.team, 'object', 'gallery card team is not an object');
    assert.equal(typeof card.track, 'object', 'gallery card track is not an object');
    hasKeys(card.team as unknown, ['name', 'slug'], 'gallery card team');
    hasKeys(card.track as unknown, ['name', 'color'], 'gallery card track');
  });

  test('GET gallery technologies returns the filter list under data', async () => {
    const response = await anon.get(`/api/events/${eventSlug}/gallery/technologies`);
    assert.equal(response.status, 200, response.raw);
    const body = hasKeys(response.body, ['data'], 'technologies');
    assert.ok(Array.isArray(body.data), 'technologies.data is not an array');
    const first = (body.data as Record<string, unknown>[])[0];
    if (first !== undefined) hasKeys(first, ['technology', 'count'], 'technology entry');
  });

  test('GET rubrics returns versions carrying the criteria the rubric editor needs', async () => {
    const response = await anon.get(`/api/events/${eventSlug}/rubrics`);
    assert.equal(response.status, 200, response.raw);
    hasKeys(response.body, ['data'], 'rubrics');
    const rubrics = (response.body as { data: Record<string, unknown>[] }).data;
    assert.ok(rubrics.length > 0, 'no rubrics for the seeded event');

    /*
     * The list view is a row per *rubric*, in snake_case, and points at the
     * active version by id rather than embedding it. The criteria arrive on
     * the version endpoint, which the rubric editor fetches on demand. An
     * earlier client expected `activeVersion` inline and `eventId` camelCase,
     * and rendered an empty editor.
     */
    const rubric = rubrics[0] as Record<string, unknown>;
    hasKeys(
      rubric,
      ['id', 'event_id', 'name', 'description', 'version_count', 'active_version_id'],
      'rubric row',
    );
    assert.ok(rubric.active_version_id !== null, 'the seeded rubric has no active version');

    // The version is returned flat — not wrapped in a `version` object — and
    // reading it is judge-or-organizer only: publishing the weights to an
    // anonymous visitor would let a team tune a submission to the rubric.
    const version = await organizer.get<Record<string, unknown>>(
      `/api/rubric-versions/${String(rubric.active_version_id)}`,
    );
    assert.equal(version.status, 200, version.raw);
    const criteria = hasKeys(
      version.body,
      ['id', 'version', 'status', 'rounding', 'judgeGuidance', 'criteria'],
      'rubric version',
    ).criteria as Record<string, unknown>[];
    assert.ok(criteria.length > 0, 'the rubric has no criteria');
    for (const criterion of criteria) {
      hasKeys(
        criterion,
        ['id', 'key', 'name', 'description', 'weight', 'min', 'max', 'required', 'scoringType', 'order'],
        'rubric criterion',
      );
      assert.equal(typeof criterion.required, 'boolean', 'criterion.required is not a boolean');
      assert.equal(typeof criterion.max, 'number', 'criterion.max is not a number');
    }
  });

  test('GET results returns the published board the results page renders', async () => {
    const response = await anon.get(`/api/events/${eventSlug}/results`);
    assert.equal(response.status, 200, response.raw);
    const board = hasKeys(
      response.body,
      ['published', 'snapshot', 'showJudgeCount', 'showCriterionBreakdown', 'entries'],
      'results board',
    );
    if (board.published === true) {
      hasKeys(board.snapshot, ['id', 'sequence', 'publishedAt', 'integrityHash', 'entryCount', 'isCorrection'], 'results snapshot');
      const entries = board.entries as Record<string, unknown>[];
      assert.ok(entries.length > 0, 'a published board has no entries');
      hasKeys(
        entries[0],
        ['rank', 'projectId', 'projectName', 'slug', 'shortDescription', 'technologies', 'aggregateScore', 'judgeCount', 'coverage', 'validation', 'prizes', 'notes'],
        'result entry',
      );
    }
  });
});

describe('api contract: judging surfaces', () => {
  test('the queue returns items with the state a judge needs to choose what to do', async () => {
    const response = await judge.get(`/api/events/${eventId}/judging/queue`);
    assert.equal(response.status, 200, response.raw);
    const queue = hasKeys(response.body, ['judgeId', 'items', 'progress'], 'queue');
    hasKeys(queue.progress, ['assigned', 'completed', 'inProgress', 'remaining'], 'queue.progress');

    const items = queue.items as Record<string, unknown>[];
    assert.ok(items.length > 0, 'the judge queue is empty');
    const firstItem = items[0] as Record<string, unknown>;
    hasKeys(
      firstItem,
      ['assignmentId', 'submissionId', 'slug', 'projectName', 'shortDescription', 'technologies', 'repositoryUrl', 'demoUrl', 'documentationUrl', 'status', 'scoreState'],
      'queue item',
    );
    assert.ok(
      ['ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'DRAFT'].includes(String(firstItem.scoreState)),
      `unexpected scoreState ${String(firstItem.scoreState)}`,
    );
  });

  test('a draft review returns an empty criteria list and the rubric that defines them', async () => {
    /*
     * The single most important shape in the client. An unscored review has no
     * criterion_scores rows, so `criteria` is empty; the questions come from the
     * rubric. A client that iterates `criteria` to build the form renders an
     * empty form and the judge cannot score anything.
     */
    const assignment = h.db.value<string>(
      `SELECT a.id FROM judge_assignments a
         JOIN judges j ON j.id = a.judge_id
         JOIN users u ON u.id = j.user_id
         JOIN scores sc ON sc.assignment_id = a.id AND sc.state = 'DRAFT'
        WHERE u.email_normalized = 'yuki@dogfood.dev' LIMIT 1`,
    );
    assert.ok(assignment !== null, 'the seed should leave a draft review');

    const response = await judge.get(`/api/assignments/${assignment}/review`);
    assert.equal(response.status, 200, response.raw);
    const review = hasKeys(response.body, ['score', 'criteria', 'rubric'], 'review');
    hasKeys(
      review.score,
      ['id', 'assignment_id', 'rubric_version_id', 'state', 'summary', 'started_at', 'submitted_at'],
      'review.score',
    );
    assert.ok(Array.isArray(review.criteria), 'review.criteria is not an array');

    const rubric = hasKeys(review.rubric, ['id', 'version', 'status', 'criteria', 'judgeGuidance'], 'review.rubric');
    const rubricCriteria = rubric.criteria as Record<string, unknown>[];
    assert.ok(rubricCriteria.length > 0, 'the rubric has no criteria, so there is nothing to score');
    for (const criterion of rubricCriteria) {
      hasKeys(criterion, ['id', 'key', 'name', 'description', 'weight', 'min', 'max', 'required'], 'rubric criterion');
    }
  });

  test('a submitted review returns criterion scores keyed by criterionId', async () => {
    const assignment = h.db.value<string>(
      `SELECT a.id FROM judge_assignments a
         JOIN judges j ON j.id = a.judge_id
         JOIN users u ON u.id = j.user_id
         JOIN scores sc ON sc.assignment_id = a.id AND sc.state = 'SUBMITTED'
        WHERE u.email_normalized = 'yuki@dogfood.dev' LIMIT 1`,
    );
    // This judge has no submitted review in the seed, so fall back to any judge.
    const target =
      assignment ??
      h.db.value<string>(
        `SELECT a.id FROM judge_assignments a JOIN scores sc ON sc.assignment_id = a.id
          WHERE sc.state = 'SUBMITTED' LIMIT 1`,
      );
    assert.ok(target !== null, 'the seed produced no submitted review');

    const owner = h.db.value<string>(
      `SELECT u.email_normalized FROM judge_assignments a
         JOIN judges j ON j.id = a.judge_id JOIN users u ON u.id = j.user_id
        WHERE a.id = :id`,
      { id: target },
    ) as string;
    const ownerClient = h.client();
    await ownerClient.login(owner);

    const response = await ownerClient.get(`/api/assignments/${target}/review`);
    assert.equal(response.status, 200, response.raw);
    const criteria = (response.body as { criteria: Record<string, unknown>[] }).criteria;
    assert.ok(criteria.length > 0, 'a submitted review has no criterion scores');
    for (const criterion of criteria) {
      /*
       * The client joins these onto rubric criteria by `criterionId`, so that is
       * the field it must carry — and camelCase, not `criterion_id`. Reading the
       * snake_case name gives `undefined`, which empties the scoring form after
       * the first save and leaves "Submit" disabled with no error shown.
       */
      hasKeys(
        criterion,
        ['id', 'criterionId', 'key', 'name', 'min', 'max', 'value', 'normalized', 'points', 'comment', 'updatedAt'],
        'criterion score',
      );
      assert.equal(typeof criterion.value, 'number', 'a submitted criterion score is not a number');
      assert.equal(criterion.criterion_id, undefined, 'criterion scores must not expose the snake_case column name');
    }

    /*
     * An organizer's view of the same review omits `judgeGuidance`, because
     * guidance is written for judges and including it in an organizer payload
     * invites editing the words judges are reading. The client treats it as
     * optional because of this, and this assertion is what keeps that honest.
     */
    const asOrganizer = await organizer.get(`/api/assignments/${target}/review`);
    assert.equal(asOrganizer.status, 200, asOrganizer.raw);
    const organizerView = asOrganizer.body as { rubric: Record<string, unknown> };
    assert.equal(organizerView.rubric.judgeGuidance, undefined, 'the organizer view leaks judge guidance');
    assert.ok(Array.isArray(organizerView.rubric.criteria), 'the organizer view has no rubric criteria');
  });

  test('the rubric version endpoint is closed to the public', async () => {
    // Deliberate, and worth asserting: criterion weights are the thing a team
    // would tune a submission to if they could see them before judging.
    const versionId = h.db.value<string>('SELECT id FROM rubric_versions LIMIT 1');
    const response = await anon.get(`/api/rubric-versions/${String(versionId)}`);
    assert.equal(response.status, 403, 'an anonymous visitor could read the rubric criteria');
  });

  test('the pairwise queue returns numbered pairs the judge UI can render', async () => {
    const response = await judge.get(`/api/events/${eventId}/pairwise/queue`);
    assert.equal(response.status, 200, response.raw);
    const queue = hasKeys(response.body, ['judgeId', 'total', 'pairs'], 'pairwise queue');
    const pairs = queue.pairs as Record<string, unknown>[];
    assert.ok(pairs.length > 0, 'the pairwise queue is empty');
    for (const pair of pairs) {
      hasKeys(pair, ['index', 'left', 'right'], 'pairwise pair');
      // Each side must carry enough to render a card the judge can choose
      // between without navigating away.
      hasKeys(pair.left as unknown, ['id', 'projectName', 'shortDescription', 'technologies'], 'pairwise left');
      hasKeys(pair.right as unknown, ['id', 'projectName', 'shortDescription', 'technologies'], 'pairwise right');
    }
  });

  test('the organizer score table carries per-project aggregates', async () => {
    const response = await organizer.get(`/api/events/${eventId}/scores`);
    assert.equal(response.status, 200, response.raw);
    hasKeys(response.body, ['data'], 'score table');
    const rows = (response.body as { data: Record<string, unknown>[] }).data;
    assert.ok(rows.length > 0, 'the score table is empty');
    hasKeys(
      rows[0],
      ['submissionId', 'projectName', 'assigned', 'completed', 'meanScore', 'minScore', 'maxScore'],
      'score table row',
    );
  });

  test('the assignment view carries per-project coverage', async () => {
    const response = await organizer.get(`/api/events/${eventId}/assignments`);
    assert.equal(response.status, 200, response.raw);
    hasKeys(response.body, ['data', 'coverage', 'currentVersion'], 'assignments');
    const coverage = (response.body as { coverage: Record<string, unknown>[] }).coverage;
    assert.ok(coverage.length > 0, 'the coverage report is empty');
    hasKeys(coverage[0], ['projectId', 'projectName', 'assigned', 'target', 'completed', 'coverage'], 'coverage row');
  });
});

describe('api contract: organizer surfaces', () => {
  test('the judge roster carries state, capacity and workload', async () => {
    const response = await organizer.get(`/api/events/${eventId}/judges`);
    assert.equal(response.status, 200, response.raw);
    hasKeys(response.body, ['data'], 'judges');
    const judges = (response.body as { data: Record<string, unknown>[] }).data;
    assert.ok(judges.length > 0, 'the judge roster is empty');
    /*
     * The roster is the judge table joined to its user, so it is snake_case with
     * camelCase workload columns appended. `expertise` arrives as a JSON string,
     * which the client must parse rather than treat as an array.
     */
    const [firstJudge] = judges;
    hasKeys(
      firstJudge,
      ['id', 'event_id', 'user_id', 'state', 'capacity', 'expertise', 'display_name', 'email', 'username', 'assigned', 'completed'],
      'judge row',
    );
    assert.equal(typeof firstJudge.expertise, 'string', 'judge expertise is not a JSON string');
    assert.doesNotThrow(() => JSON.parse(String(firstJudge.expertise)), 'judge expertise is not parseable JSON');
  });

  test('the conflicts list carries kind and severity', async () => {
    const response = await organizer.get(`/api/events/${eventId}/conflicts`);
    assert.equal(response.status, 200, response.raw);
    hasKeys(response.body, ['data'], 'conflicts');
    const conflicts = (response.body as { data: Record<string, unknown>[] }).data;
    if (conflicts.length > 0) {
      hasKeys(conflicts[0], ['id', 'event_id', 'judge_id', 'kind', 'severity', 'note', 'created_at'], 'conflict');
    }
  });

  test('the vote report carries tallies, the window, and per-account activity', async () => {
    const response = await organizer.get(`/api/events/${eventId}/votes/report`);
    assert.equal(response.status, 200, response.raw);
    const report = hasKeys(
      response.body,
      ['eventId', 'totalsVisible', 'totalVotes', 'distinctVoters', 'votesPerVoter', 'window', 'topAccounts', 'note'],
      'vote report',
    );
    hasKeys(report.window, ['opensAt', 'closesAt'], 'vote window');
    const accounts = report.topAccounts as Record<string, unknown>[];
    assert.ok(Array.isArray(accounts), 'topAccounts is not an array');
    if (accounts.length > 0) {
      hasKeys(accounts[0], ['userId', 'displayName', 'email', 'votes', 'share', 'firstVoteAt', 'lastVoteAt'], 'vote account');
    }
  });

  test('the audit ledger is paginated with the fields an operator needs', async () => {
    const response = await organizer.get(`/api/events/${eventId}/audit?perPage=5`);
    assert.equal(response.status, 200, response.raw);
    hasKeys(response.body, ['data', 'pagination'], 'audit');
    const rows = (response.body as { data: Record<string, unknown>[] }).data;
    assert.ok(rows.length > 0, 'the audit ledger is empty for a seeded event');
    hasKeys(
      rows[0],
      ['id', 'at', 'actorId', 'actorRoles', 'actor', 'action', 'resourceType', 'resourceId', 'previousState', 'newState', 'outcome', 'requestId', 'ipAddress', 'metadata'],
      'audit row',
    );
  });

  test('registration and team lists are paginated and identifiable', async () => {
    const registrations = await organizer.get(`/api/events/${eventId}/registrations?perPage=5`);
    assert.equal(registrations.status, 200, registrations.raw);
    hasKeys(registrations.body, ['data', 'pagination'], 'registrations');

    const teams = await organizer.get(`/api/events/${eventId}/teams`);
    assert.equal(teams.status, 200, teams.raw);
    hasKeys(teams.body, ['data', 'pagination'], 'teams');
    const rows = (teams.body as { data: Record<string, unknown>[] }).data;
    if (rows.length > 0) hasKeys(rows[0], ['id', 'name', 'slug', 'memberCount'], 'team row');
  });

  test('result runs and snapshots are listable for the organizer', async () => {
    // These two are unpaginated: a single event has at most a handful of runs
    // and a few dozen snapshots, and the client renders them as a list, not a
    // pager.
    const runs = await organizer.get(`/api/events/${eventId}/results/runs`);
    assert.equal(runs.status, 200, runs.raw);
    hasKeys(runs.body, ['data'], 'runs');

    const snapshots = await organizer.get(`/api/events/${eventId}/results/snapshots`);
    assert.equal(snapshots.status, 200, snapshots.raw);
    hasKeys(snapshots.body, ['data'], 'snapshots');
  });

  test('the capabilities document describes what this instance supports', async () => {
    const response = await anon.get('/api/capabilities');
    assert.equal(response.status, 200, response.raw);
    hasKeys(response.body, ['version', 'judging', 'uploads', 'registrationFieldTypes', 'limits'], 'capabilities');
  });
});

describe('api contract: participant surfaces', () => {
  test('the registration form lists fields the form can render', async () => {
    const response = await participant.get(`/api/events/${eventId}/registration/form`);
    assert.equal(response.status, 200, response.raw);
    hasKeys(response.body, ['eventId', 'fields'], 'registration form');
    const fields = (response.body as { fields: Record<string, unknown>[] }).fields;
    if (fields.length > 0) {
      hasKeys(fields[0], ['id', 'key', 'label', 'helpText', 'type', 'required', 'options'], 'registration field');
    }
  });

  test('the participant team view carries the team, its members and open invitations', async () => {
    const response = await participant.get(`/api/events/${eventId}/teams/mine`);
    assert.equal(response.status, 200, response.raw);
    const body = hasKeys(response.body, ['team', 'members', 'invitations'], 'my team');
    const team = body.team as Record<string, unknown> | null;
    if (team !== null) hasKeys(team, ['id', 'name', 'slug'], 'my team.team');
    assert.ok(Array.isArray(body.members), 'my team members is not an array');
    assert.ok(Array.isArray(body.invitations), 'my team invitations is not an array');
  });

  test('the event submission list is paginated', async () => {
    const response = await participant.get(`/api/events/${eventId}/submissions`);
    assert.equal(response.status, 200, response.raw);
    hasKeys(response.body, ['data', 'pagination'], 'submissions');
  });
});

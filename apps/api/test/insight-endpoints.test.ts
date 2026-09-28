import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, DEMO_PASSWORD, type Harness, type ApiClient } from './harness.ts';

/**
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The most expensive kind of incompleteness in this codebase is not a bug. It
 * is a feature that was fully implemented, fully unit-tested, and completely
 * unreachable because nothing routed to it.
 *
 * `ResultService.computeDiagnostics`, `listAnomalies`, `setAnomalyStatus`,
 * `normalizationComparison`, `listNormalizationRuns`,
 * `ScoringService.listComparisons`, `CertificateService.list`,
 * `CertificateService.revoke` and
 * `CertificateService.issueParticipationRecords` were all in that state. The
 * normalization comparison alone is the entire "normalization proof" bonus
 * requirement, and no client could reach it over HTTP.
 *
 * These tests now assert three things for each:
 *   1. the endpoint answers 200 for an organizer and returns real, non-empty
 *      data derived from the seeded event;
 *   2. an anonymous caller is refused with 401 and a judge with 403, so wiring
 *      a route up did not also wire an authorization hole open;
 *   3. where the service permits more than the route does, the route is the
 *      stricter of the two on purpose.
 */
describe('insight endpoints are reachable and correctly scoped', () => {
  let harness: Harness;

  /*
   * One harness for the whole suite, seeded once.
   *
   * `after` has to be a real hook here: `t.after()` inside a test body tears
   * the database down as soon as that first test finishes, and every later test
   * then fails with "database is not open" — a confusing failure that has nothing
   * to do with what it is testing. `harness.ts` documents exactly this.
   */
  before(async () => {
    harness = await createHarness();
  });

  after(async () => {
    await harness.close();
  });

  /**
   * Every read-only insight route, with an assertion on the payload so an
   * endpoint that answers 200 with an empty object fails here rather than
   * looking finished in the UI.
   */
  const READS: { name: string; path: (eventId: string) => string; assert: (body: unknown) => void }[] = [
    {
      name: 'judge diagnostics',
      path: (e) => `/api/events/${e}/diagnostics`,
      assert: (body) => {
        const value = body as { judges: unknown[]; projects: unknown[]; signals: unknown[] };
        assert.ok(Array.isArray(value.judges) && value.judges.length > 0, 'diagnostics reports per-judge statistics');
        assert.ok(Array.isArray(value.projects) && value.projects.length > 0, 'diagnostics reports per-project statistics');
        assert.ok(Array.isArray(value.signals), 'diagnostics reports review signals');
      },
    },
    {
      name: 'anomaly register',
      path: (e) => `/api/events/${e}/anomalies`,
      assert: (body) => {
        const value = body as { data: unknown[] };
        assert.ok(Array.isArray(value.data) && value.data.length > 0, 'the seeded panel raises at least one review flag');
      },
    },
    {
      name: 'normalization comparison',
      path: (e) => `/api/events/${e}/normalization/comparison?method=Z_SCORE`,
      assert: (body) => {
        const value = body as { method: string; rows: { rawScore: number | null; normalizedScore: number | null; rawRank: number | null }[]; judgeStats: unknown[] };
        assert.equal(value.method, 'Z_SCORE');
        assert.ok(value.rows.length > 0, 'the comparison covers every project');
        assert.ok(value.judgeStats.length > 0, 'the comparison reports judge statistics for the method');
        // The whole point: both the raw and the normalized number are present,
        // so an organizer can see the effect rather than only its conclusion.
        assert.ok(
          value.rows.every((row) => row.rawScore !== null && row.normalizedScore !== null),
          'every row carries both the raw and the normalized score',
        );
        assert.ok(
          value.rows.every((row) => row.rawRank !== null),
          'every row carries the raw rank, so a rank change is measurable',
        );
      },
    },
    {
      name: 'normalization run history',
      path: (e) => `/api/events/${e}/normalization/runs`,
      assert: (body) => {
        const value = body as { data: { method: string; configHash: string }[] };
        assert.ok(value.data.length > 0, 'seeding recorded at least one normalization run');
        assert.ok(value.data.every((run) => typeof run.configHash === 'string' && run.configHash.length === 64), 'every run is bound to a configuration hash');
      },
    },
    {
      name: 'pairwise comparisons',
      path: (e) => `/api/events/${e}/comparisons`,
      assert: (body) => {
        const value = body as { data: { leftProjectName: string; outcome: string }[] };
        assert.ok(Array.isArray(value.data), 'comparisons return an array');
        // Seeded comparisons must resolve project names, not bare ids.
        assert.ok(
          value.data.every((row) => row.leftProjectName.length > 0 && !row.leftProjectName.startsWith('sub_')),
          'comparisons resolve human-readable project names',
        );
      },
    },
    {
      name: 'certificate list',
      path: (e) => `/api/events/${e}/certificates`,
      assert: (body) => {
        const value = body as { data: { reference: string; url: string }[] };
        assert.ok(value.data.length > 0, 'seeding issued certificates');
        assert.ok(
          value.data.every((row) => row.reference.startsWith('CRT-') && row.url.includes(`/certificates/${row.reference}`)),
          'every certificate has a reference and a resolvable URL',
        );
      },
    },
    {
      name: 'participation records',
      path: (e) => `/api/events/${e}/participation-records`,
      assert: (body) => {
        const value = body as { data: { judgeName: string; completionStatus: string; detail: unknown }[] };
        assert.ok(value.data.length > 0, 'seeding issued judge participation records');
        assert.ok(
          value.data.every((row) => row.judgeName.length > 0 && typeof row.completionStatus === 'string'),
          'each record names its judge and states what they completed',
        );
        assert.ok(value.data.every((row) => row.detail !== null), 'each record carries its frozen detail snapshot');
      },
    },
  ];

  for (const route of READS) {
    test(`${route.name}: organizer 200, anonymous 401, judge 403`, async () => {
      const eventId = seededEventId(harness);

      const organizer: ApiClient = harness.client();
      await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
      const ok = await organizer.get(route.path(eventId));
      assert.equal(ok.status, 200, `${route.name} for an organizer: ${ok.raw.slice(0, 300)}`);
      route.assert(ok.body);

      const anonymous = await harness.client().get(route.path(eventId));
      assert.equal(anonymous.status, 401, `${route.name} must require authentication, got ${String(anonymous.status)}`);

      const judge = harness.client();
      await judge.login('amara@dogfood.dev', DEMO_PASSWORD);
      const refused = await judge.get(route.path(eventId));
      assert.equal(refused.status, 403, `${route.name} must refuse a judge, got ${String(refused.status)}`);
    });
  }

  test('a review flag can be acknowledged, and dismissing it requires a conclusion', async () => {
    const eventId = seededEventId(harness);
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

    const list = await organizer.get<{ data: { id: string; status: string }[] }>(`/api/events/${eventId}/anomalies`);
    const flag = list.body.data[0];
    assert.ok(flag !== undefined, 'there is a flag to act on');

    const acknowledged = await organizer.post<{ status: string }>(`/api/events/${eventId}/anomalies/${flag.id}`, {
      status: 'ACKNOWLEDGED',
      resolution: 'Reviewed during the acceptance run.',
    });
    assert.equal(acknowledged.status, 200, acknowledged.raw);
    assert.equal(acknowledged.body.status, 'ACKNOWLEDGED');

    // Dismissing with no written conclusion must be refused: "looked at it,
    // fine" is not a conclusion.
    const lazy = await organizer.post<{ error: { code: string } }>(`/api/events/${eventId}/anomalies/${flag.id}`, {
      status: 'DISMISSED',
      resolution: '',
    });
    // 422 rather than 400: the request was well-formed and well-authorized, and
    // what failed was the rule that a dismissal must carry a conclusion.
    assert.equal(lazy.status, 422, 'dismissing without a conclusion must be refused');
    assert.equal(lazy.body.error.code, 'VALIDATION_FAILED');

    // With one, it succeeds and the status is recorded.
    const dismissed = await organizer.post<{ status: string; resolution: string }>(
      `/api/events/${eventId}/anomalies/${flag.id}`,
      { status: 'DISMISSED', resolution: 'Two judges agreeing is not an anomaly at this sample size.' },
    );
    assert.equal(dismissed.status, 200, dismissed.raw);
    assert.equal(dismissed.body.status, 'DISMISSED');
    assert.ok(dismissed.body.resolution.length > 0, 'the written conclusion is stored with the flag');
  });

  test('a judge cannot acknowledge a review flag', async () => {
    const eventId = seededEventId(harness);
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const list = await organizer.get<{ data: { id: string }[] }>(`/api/events/${eventId}/anomalies`);
    const flag = list.body.data[0];
    assert.ok(flag !== undefined);

    const judge = harness.client();
    await judge.login('amara@dogfood.dev', DEMO_PASSWORD);
    const refused = await judge.post(`/api/events/${eventId}/anomalies/${flag.id}`, {
      status: 'DISMISSED',
      resolution: 'I would rather this were not here.',
    });
    assert.equal(refused.status, 403, 'a judge must not be able to clear a flag raised about the panel');
  });

  test('issuing participation records is idempotent', async () => {
    const eventId = seededEventId(harness);
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

    const first = await organizer.post<{ issued: number }>(`/api/events/${eventId}/participation-records`, {});
    assert.equal(first.status, 200, first.raw);

    const before = await organizer.get<{ data: unknown[] }>(`/api/events/${eventId}/participation-records`);
    const second = await organizer.post<{ issued: number }>(`/api/events/${eventId}/participation-records`, {});
    assert.equal(second.status, 200, second.raw);
    const after = await organizer.get<{ data: unknown[] }>(`/api/events/${eventId}/participation-records`);

    // Seeding already issued them, so a re-run must add nothing.
    assert.equal(after.body.data.length, before.body.data.length, 're-issuing does not duplicate records');
  });

  test('a certificate can be revoked under a reason, and revocation is visible', async () => {
    const eventId = seededEventId(harness);
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

    const list = await organizer.get<{ data: { id: string; reference: string }[] }>(`/api/events/${eventId}/certificates`);
    const target = list.body.data.find((row) => row.reference.length > 0);
    assert.ok(target !== undefined);

    const tooShort = await organizer.post(`/api/events/${eventId}/certificates/${target.id}/revoke`, { reason: 'no' });
    assert.equal(tooShort.status, 422, 'a revocation without a real reason is refused');

    const revoked = await organizer.post(`/api/events/${eventId}/certificates/${target.id}/revoke`, {
      reason: 'Issued against the wrong event during a rehearsal.',
    });
    assert.equal(revoked.status, 200, revoked.raw);

    // Public verification now reports REVOKED, and still proves the record
    // itself was not tampered with.
    const verify = await harness.client().get<{ status: string; valid: boolean }>(`/api/certificates/${target.reference}`);
    assert.equal(verify.status, 200);
    assert.equal(verify.body.status, 'REVOKED');
    assert.equal(verify.body.valid, true, 'the hash still matches; the record is honest about being withdrawn');
  });

  test('a judge is refused the event-wide comparison record but keeps their own', async () => {
    const eventId = seededEventId(harness);
    const judge = harness.client();
    await judge.login('amara@dogfood.dev', DEMO_PASSWORD);

    const eventWide = await judge.get(`/api/events/${eventId}/comparisons`);
    assert.equal(eventWide.status, 403, 'pairwise outcomes are judge data and are not published to the panel');

    // The judge's own comparison queue is the scoped path they do get.
    const own = await judge.get<{ pairs: unknown[] }>(`/api/events/${eventId}/pairwise/queue?pairs=5`);
    assert.equal(own.status, 200, own.raw);
    assert.ok(Array.isArray(own.body.pairs), 'the comparison queue is available to the judge');
  });
});

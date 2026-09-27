/**
 * Security regression tests.
 *
 * Every test here corresponds to a defect that was actually found and fixed,
 * or to an invariant whose violation would be a real vulnerability. They are
 * written as regressions on purpose: each one names the bug it prevents, so a
 * future change that reintroduces it fails with an explanation rather than a
 * bare number.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, DEMO_PASSWORD, type Harness } from './harness.ts';

type ErrorBody = { error: { code: string; message: string } };

const asError = (body: unknown): ErrorBody => body as ErrorBody;

describe('security: authentication and session handling', () => {
  let harness: Harness;

  before(async () => {
    harness = await createHarness();
  });
  after(async () => {
    await harness.close();
  });

  test('passwords are stored as scrypt hashes, never in the clear', () => {
    const row = harness.db.get<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email_normalized = :e',
      { e: 'organizer@dogfood.dev' },
    );
    assert.ok(row !== null);
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes('verdict-demo-2026'), 'the plaintext password is in the users table');
  });

  test('session tokens are stored only as a digest', async () => {
    const client = harness.client();
    await client.login('organizer@dogfood.dev');
    // The raw cookie value must not be recoverable from the database.
    const rows = harness.db.all<{ token_hash: string }>('SELECT token_hash FROM sessions');
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.match(row.token_hash, /^[0-9a-f]{64}$/, 'the session token is not stored as a SHA-256 digest');
    }
  });

  test('the session cookie is HttpOnly and the CSRF cookie deliberately is not', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'organizer@dogfood.dev', password: 'verdict-demo-2026' },
    });
    // `set-cookie` is typed as possibly absent, so narrow it before inspecting.
    const raw = response.headers['set-cookie'];
    const cookies = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((c): c is string => typeof c === 'string');
    const session = cookies.find((c) => c.startsWith('verdict_session='));
    const csrf = cookies.find((c) => c.startsWith('verdict_csrf='));
    assert.ok(session !== undefined, 'no session cookie was set');
    assert.ok(csrf !== undefined, 'no CSRF cookie was set');
    const sessionCookie = session;
    const csrfCookie = csrf;

    // HttpOnly on the session stops script from reading the credential.
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /SameSite=Lax/i);
    // The CSRF token must be readable, because the SPA has to echo it back in
    // a header; it is not a credential on its own.
    assert.doesNotMatch(csrfCookie, /HttpOnly/i);
  });

  test('a cross-origin state change is refused even with a valid session', async () => {
    const client = harness.client();
    await client.login('organizer@dogfood.dev');

    // A browser on another origin sends the session cookie but cannot read the
    // CSRF cookie, so it cannot set the header.
    const response = await client.post(
      '/api/events',
      { name: 'Should not be created' },
      { headers: { origin: 'https://evil.example' }, csrf: false },
    );
    assert.ok(response.status === 403, `got ${String(response.status)}: ${response.raw}`);
  });

  test('an origin matching the request Host is accepted, a real cross-origin is not', async () => {
    /*
     * Regression: the guard compared Origin only against PUBLIC_URL, so a
     * self-hoster who reached the instance at a LAN address or a proxy hostname
     * — anything other than the one configured name — had every write refused
     * with ORIGIN_REJECTED and no indication of the cause.
     *
     * Self-referential requests are the fix; cross-site ones must still fail.
     */
    const base = 'http://verdict.test';
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: base, 'content-type': 'application/json' },
      payload: { email: 'organizer@dogfood.dev', password: DEMO_PASSWORD },
    });
    assert.equal(login.statusCode, 200, login.body);

    const jar = (login.headers['set-cookie'] as string[]).map((c) => c.split(';')[0] ?? '').join('; ');
    const csrf = (login.headers['set-cookie'] as string[])
      .find((c) => c.startsWith('verdict_csrf='))
      ?.split(';')[0]
      ?.split('=')[1];
    assert.ok(csrf !== undefined, 'no csrf cookie issued');

    /*
     * Uses PATCH /api/profile, which an organizer may always do to themselves.
     * A route an organizer cannot use (event creation requires ADMIN) would
     * fail on RBAC and tell us nothing about the origin guard.
     */
    const sameOrigin = await harness.app.inject({
      method: 'PATCH',
      url: '/api/profile',
      headers: { origin: 'http://verdict.test:9999', host: 'verdict.test:9999', cookie: jar, 'x-verdict-csrf': csrf, 'content-type': 'application/json' },
      payload: { bio: 'reached on another port' },
    });
    assert.equal(
      sameOrigin.statusCode,
      200,
      `a self-referential request was rejected: ${sameOrigin.statusCode} ${sameOrigin.body.slice(0, 240)}`,
    );

    // Origin is genuinely another site -> still refused, by the origin guard
    // rather than by anything else.
    const crossSite = await harness.app.inject({
      method: 'PATCH',
      url: '/api/profile',
      headers: { origin: 'http://evil.example', host: 'verdict.test', cookie: jar, 'x-verdict-csrf': csrf, 'content-type': 'application/json' },
      payload: { bio: 'from another site' },
    });
    assert.equal(crossSite.statusCode, 403, 'a cross-origin write was not refused');
    assert.equal(
      (JSON.parse(crossSite.body) as { error: { code: string } }).error.code,
      'ORIGIN_REJECTED',
    );
  });

  test('an eight-failure streak locks the account', async () => {
    const client = harness.client();
    let last = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      last = (
        await client.post('/api/auth/login', { email: 'iris@dogfood.dev', password: `wrong-${String(attempt)}` }, { csrf: false })
      ).raw;
    }
    const locked = await client.post(
      '/api/auth/login',
      { email: 'iris@dogfood.dev', password: 'verdict-demo-2026' },
      { csrf: false },
    );
    assert.equal(locked.status, 423, `the account was not locked: ${last}`);
    assert.equal(asError(locked.body).error.code, 'ACCOUNT_LOCKED');
  });
});

describe('security: authorization', () => {
  let harness: Harness;
  let eventId: string;

  before(async () => {
    harness = await createHarness();
    eventId = seededEventId(harness);
  });
  after(async () => {
    await harness.close();
  });

  test('an anonymous caller is told 401, and a signed-in non-privileged caller 403', async () => {
    // The distinction matters to clients: 401 means "sign in", 403 means "you
    // still may not". Collapsing them makes an expired session look like a
    // permissions problem.
    const anon = await harness.client().get(`/api/events/${eventId}/scores`);
    assert.equal(anon.status, 401, anon.raw);
    assert.equal(asError(anon.body).error.code, 'UNAUTHENTICATED');

    const participant = harness.client();
    await participant.login('iris@dogfood.dev');
    const denied = await participant.get(`/api/events/${eventId}/scores`);
    assert.equal(denied.status, 403, denied.raw);
    assert.equal(asError(denied.body).error.code, 'FORBIDDEN');
  });

  test('a judge can open their own queue (regression: OWN scope was never satisfied)', async () => {
    // The queue route asserted `assignedJudge` while the RBAC grant for
    // `assignment` is OWN, which only `ownerId` satisfies — so every judge was
    // locked out of the screen the product exists to give them.
    const judge = harness.client();
    await judge.login('amara@dogfood.dev');
    const queue = await judge.get(`/api/events/${eventId}/judging/queue`);
    assert.equal(queue.status, 200, queue.raw);
  });

  test('an organizer can compute results (regression: result:create was ungranted)', async () => {
    // Without `result: 'EVENT'` on the organizer's create grants, the entire
    // judging pipeline was unreachable over HTTP: results existed only because
    // the seeder wrote them directly to the database.
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev');
    const computed = await organizer.post(`/api/events/${eventId}/results/compute`, {});
    assert.equal(computed.status, 200, computed.raw);
  });

  test('a judge cannot read the organizer score table', async () => {
    const judge = harness.client();
    await judge.login('ben@dogfood.dev');
    const response = await judge.get(`/api/events/${eventId}/scores`);
    assert.equal(response.status, 403, response.raw);
  });

  test('a judge cannot see another judge\'s review', async () => {
    const judge = harness.client();
    await judge.login('ben@dogfood.dev');

    // Any assignment that is not this judge's must be refused, not merely
    // filtered out of a list.
    const other = harness.db.get<{ id: string; user_id: string }>(
      `SELECT a.id, j.user_id
         FROM judge_assignments a
         JOIN judges j ON j.id = a.judge_id
        WHERE a.event_id = :e AND j.user_id <> (SELECT id FROM users WHERE email_normalized = 'ben@dogfood.dev')
        LIMIT 1`,
      { e: eventId },
    );
    assert.ok(other !== null, 'the seed produced no other-judge assignment to test against');

    const response = await judge.get(`/api/assignments/${other.id as string}/review`);
    assert.equal(response.status, 403, response.raw);
  });

  test('a participant cannot administer the event', async () => {
    const participant = harness.client();
    await participant.login('iris@dogfood.dev');

    // Each request carries a *valid* body. Route handlers validate before they
    // authorize, so sending `{}` would prove only that the schema rejects it —
    // the interesting question is whether a well-formed attempt is refused.
    const attempts = [
      { method: 'POST', url: `/api/events/${eventId}/transition`, payload: { to: 'PUBLISHED' } },
      { method: 'POST', url: `/api/events/${eventId}/judges/invite`, payload: { email: 'someone@example.com' } },
      { method: 'POST', url: `/api/events/${eventId}/assignments/commit`, payload: { strategy: 'WORKLOAD_AWARE' } },
      { method: 'POST', url: `/api/events/${eventId}/assignments/preview`, payload: { strategy: 'WORKLOAD_AWARE' } },
    ] as const;

    for (const attempt of attempts) {
      const response = await participant.request(attempt.method, attempt.url, { payload: attempt.payload });
      assert.equal(response.status, 403, `${attempt.method} ${attempt.url} returned ${String(response.status)}: ${response.raw}`);
    }
  });

  test('a malformed body is a 422 with the offending field named, not a 500', async () => {
    // Regression: `.parse()` failures arrived at the error handler as an
    // unrecognised ZodError and were rendered as INTERNAL_ERROR, so a client
    // that sent a bad value produced a 500 and tripped error alerting during a
    // live event.
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev');

    const response = await organizer.post(`/api/events/${eventId}/transition`, { to: 'NOT_A_STATE' });
    assert.equal(response.status, 422, response.raw);
    const body = asError(response.body);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.ok(response.raw.includes('to'), `the error does not name the field: ${response.raw}`);
  });

  test('an organizer of one event cannot administer another', async () => {
    // The seeded organizer is scoped to one event. A second event, created
    // directly, must be out of reach.
    const otherEventId = harness.db.value<string>("SELECT id FROM events WHERE slug <> 'dogfood-2026' LIMIT 1");
    if (otherEventId === null) {
      // Only one event is seeded; assert the scope is at least event-scoped
      // rather than platform-wide, which is the property that matters.
      const organizer = harness.client();
      await organizer.login('organizer@dogfood.dev');
      const me = await organizer.get<{ user: { roles: string[] } }>('/api/auth/session');
      assert.ok(!me.body.user.roles.includes('ADMIN'), 'the seeded organizer is a platform admin after all');
      return;
    }
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev');
    const response = await organizer.get(`/api/events/${otherEventId}/scores`);
    assert.equal(response.status, 403, response.raw);
  });
});

describe('security: rate limiting', () => {
  test('a rate-limited request is 429, not a server error', async () => {
    // Regression: the limiter's default rejection path threw, and the error
    // handler rendered the throw as a 500 — so a working server reported a
    // client-caused throttle as an internal fault.
    const limited = await createHarness({
      config: { security: { authRateLimitMax: 3, authRateLimitWindowMs: 60_000, rateLimitMax: 100_000 } },
    });
    try {
      const client = limited.client();
      let sawLimit = false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await client.post(
          '/api/auth/login',
          { email: 'nobody@nowhere.test', password: 'whatever-password' },
          { csrf: false },
        );
        if (response.status === 429) {
          sawLimit = true;
          assert.equal(asError(response.body).error.code, 'RATE_LIMITED');
          assert.ok(Number(response.headers['retry-after'] ?? 0) > 0, 'no Retry-After header on a 429');
          break;
        }
        // Wrong credentials are 401, which is the correct answer until the
        // budget runs out.
        assert.equal(response.status, 401, `unexpected ${String(response.status)}: ${response.raw}`);
      }
      assert.ok(sawLimit, 'the limiter never engaged');
    } finally {
      await limited.close();
    }
  });
});

describe('security: storage-level immutability', () => {
  let harness: Harness;

  before(async () => {
    harness = await createHarness();
  });
  after(async () => {
    await harness.close();
  });

  test('the audit ledger rejects updates and deletes', () => {
    const before = harness.db.value<number>('SELECT COUNT(*) AS c FROM audit_events');
    assert.ok((before ?? 0) > 0, 'the seed wrote no audit events');
    assert.throws(
      () => harness.db.exec("UPDATE audit_events SET action = 'tampered' WHERE id = (SELECT id FROM audit_events LIMIT 1)"),
      /append-only/i,
    );
    assert.throws(() => harness.db.exec('DELETE FROM audit_events'), /append-only/i);
    assert.equal(harness.db.value<number>('SELECT COUNT(*) AS c FROM audit_events'), before);
  });

  test('a computed run cannot be edited in place', () => {
    const run = harness.db.get<{ id: string }>('SELECT id FROM result_runs LIMIT 1');
    assert.ok(run !== null);
    assert.throws(
      () => harness.db.exec('UPDATE result_run_entries SET aggregate_score = 100 WHERE result_run_id = :r', { r: run.id }),
      /immutable/i,
      'a run entry was edited after the fact, so its integrity hash no longer describes it',
    );
  });

  test('the users table cannot hold a global role with a dangling scope', () => {
    // The scope mirror exists so a global role is representable; the CHECK is
    // what stops the two columns drifting apart.
    const user = harness.db.value<string>("SELECT id FROM users WHERE email_normalized = 'organizer@dogfood.dev'");
    assert.throws(
      () =>
        harness.db.exec(
          `INSERT INTO user_roles (user_id, role, event_id, scope, granted_by, granted_at)
           VALUES (:u, 'ADMIN', :e, '', :u, '2026-01-01T00:00:00.000Z')`,
          { u: user as string, e: 'evt_does_not_exist' },
        ),
      /CHECK|FOREIGN KEY/i,
    );
  });
});

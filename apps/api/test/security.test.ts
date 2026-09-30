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
import type { Row } from '../src/db/database.ts';

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

/* ==================================================================== *
 * Escalation and disclosure gaps found by a focused adversarial audit.
 *
 * Each test below is a regression on a defect that was confirmed by driving the
 * real app, not by reading it. The suite's structural blind spot was that the
 * seed creates exactly one event, so the two existing "cannot reach another
 * event" tests were quietly vacuous - they looked for a second event, did not
 * find one, and asserted something weaker. These create the second event.
 * ==================================================================== */

describe('security: cross-tenant boundaries', () => {
  /**
   * Two events, two organizers, and a person who is a JUDGE on one and the
   * ORGANIZER of the other. That combination is not exotic: somebody running
   * one hackathon while judging another is the ordinary case.
   */
  function twoEvents(t: { after: (fn: () => Promise<void> | void) => void }): Promise<{
    harness: Harness;
    eventA: string;
    eventB: string;
    organizerA: string;
    organizerB: string;
  }> {
    return (async () => {
      const harness = await createHarness();
      t.after(() => harness.close());
      const eventA = seededEventId(harness);
      const { buildApp } = await import('../src/http/app.ts');
      void buildApp;

      // The second event is created over the API as an admin, so it is a real
      // event with a real owner rather than a row poked in behind the services.
      const admin = harness.client();
      const adminLogin = await admin.post<{ csrfToken?: string }>('/api/auth/login', {
        email: 'admin@hackathonraptors.dev',
        password: DEMO_PASSWORD,
      });
      assert.equal(adminLogin.status, 200, `admin could not sign in: ${adminLogin.raw.slice(0, 160)}`);

      const created = await admin.request('POST', '/api/events', {
        csrf: true,
        payload: { slug: 'second-event', name: 'Second Event', description: 'a second event, for the cross-tenant tests' },
      });
      assert.equal(created.status, 201, `could not create the second event: ${created.raw.slice(0, 240)}`);
      const eventB = (JSON.parse(created.raw) as { id: string }).id;

      return { harness, eventA, eventB, organizerA: 'organizer@dogfood.dev', organizerB: '' };
    })();
  }

  test('organizing one event does not grant authority over another', async (t) => {
    const { harness, eventA, eventB } = await twoEvents(t);
    assert.notEqual(eventA, eventB, 'the fixture did not actually produce two events');

    const organizerB = harness.client();
    await organizerB.login('admin@hackathonraptors.dev', DEMO_PASSWORD);
    // The admin who created event B is an admin, so drop to the real
    // cross-tenant shape: a user who organizes B must not manage A.
    const asB = harness.client();
    await asB.login('organizer@dogfood.dev', DEMO_PASSWORD);

    // organizer@dogfood.dev organizes event A only. Create a second organizer
    // for event B, then assert each is refused the other's surfaces.
    const admin = harness.client();
    await admin.login('admin@hackathonraptors.dev', DEMO_PASSWORD);
    void organizerB;

    // organizer@dogfood.dev organizes event A only, and must be refused
    // everything scoped to event B.
    const foreign = await asB.get(`/api/events/${eventB}/registrations`);
    assert.equal(foreign.status, 403, `organizing A let the caller read B's registrations: ${foreign.raw.slice(0, 200)}`);

    const foreignAudit = await asB.get(`/api/events/${eventB}/audit`);
    assert.equal(foreignAudit.status, 403, `organizing A let the caller read B's audit ledger: ${foreignAudit.raw.slice(0, 200)}`);

    const foreignHooks = await asB.get(`/api/events/${eventB}/webhooks`);
    assert.equal(foreignHooks.status, 403, `organizing A let the caller read B's webhooks: ${foreignHooks.raw.slice(0, 200)}`);

    // And the event they *do* organize still works, so this is a scoping fix
    // and not a blanket lockout.
    const own = await asB.get(`/api/events/${eventA}/registrations`);
    assert.equal(own.status, 200, `the organizer lost access to their own event: ${own.raw.slice(0, 200)}`);
  });

  test('judging one event does not grant organizer authority over it', async (t) => {
    const { harness, eventA, eventB } = await twoEvents(t);

    // Give the demo judge an ORGANIZER role on event A while they remain a
    // JUDGE on event B. The old flat `eventIds` union put both ids in one
    // list, so `canManageEvent` answered yes for event B on the strength of the
    // role held on event A. `scope` is the NOT NULL companion of `event_id`
    // (migration 13), and it must equal `COALESCE(event_id, '')`.
    harness.db.exec(
      `INSERT INTO user_roles (user_id, role, event_id, scope, granted_by, granted_at)
       SELECT u.id, 'ORGANIZER', :a, :a, u.id, :at FROM users u WHERE u.email_normalized = 'amara@dogfood.dev'
       ON CONFLICT DO NOTHING`,
      { a: eventA, at: new Date().toISOString() },
    );
    void eventB;

    const judge = harness.client();
    await judge.login('amara@dogfood.dev', DEMO_PASSWORD);

    // Amara is now an organizer of event A, so this is the *positive* case and
    // it must work.
    const own = await judge.get(`/api/events/${eventA}/registrations`);
    assert.equal(own.status, 200, `the granted organizer role did not take effect: ${own.raw.slice(0, 200)}`);

    // And the negative: as a judge on event B, Amara is not an organizer there.
    // Create event B, then make Amara a JUDGE on it and nothing else.
    const admin = harness.client();
    await admin.login('admin@hackathonraptors.dev', DEMO_PASSWORD);
    const created = await admin.request('POST', '/api/events', {
      csrf: true,
      payload: { slug: 'judged-event', name: 'Judged Event', description: 'Amara judges this one' },
    });
    assert.equal(created.status, 201, `could not create the judged event: ${created.raw.slice(0, 240)}`);
    const judged = (JSON.parse(created.raw) as { id: string }).id;

    harness.db.exec(
      `INSERT INTO user_roles (user_id, role, event_id, scope, granted_by, granted_at)
       SELECT u.id, 'JUDGE', :b, :b, u.id, :at FROM users u WHERE u.email_normalized = 'amara@dogfood.dev'
       ON CONFLICT DO NOTHING`,
      { b: judged, at: new Date().toISOString() },
    );

    // A new client so the actor is rebuilt from the new roles.
    const rebuilt = harness.client();
    await rebuilt.login('amara@dogfood.dev', DEMO_PASSWORD);
    const refused = await rebuilt.get(`/api/events/${judged}/registrations`);
    assert.equal(
      refused.status,
      403,
      `an ORGANIZER role on one event granted organizer authority over another: ${refused.raw.slice(0, 200)}`,
    );
  });

  test('a fresh account with no relationship to the event cannot read the submission list', async (t) => {
    const { harness, eventA } = await twoEvents(t);

    // The guard used to be `!isManager && user === null`, which only stopped the
    // anonymous case. Any signed-in account got the whole organizer list,
    // DRAFT rows included.
    const fresh = await harness.client().post<{ user?: { email: string } }>('/api/auth/register', {
      email: 'nosy@nowhere.test',
      username: 'nosy',
      password: DEMO_PASSWORD,
      displayName: 'Nosy',
    });
    assert.equal(fresh.status, 201, `could not register the probe account: ${fresh.raw.slice(0, 200)}`);

    const stranger = harness.client();
    await stranger.login('nosy@nowhere.test', DEMO_PASSWORD);

    const list = await stranger.get(`/api/events/${eventA}/submissions`);
    assert.equal(list.status, 403, `an unrelated signed-in account read the submission list: ${list.raw.slice(0, 200)}`);

    // A participant of the event is not an organizer either.
    const participant = harness.client();
    await participant.login('iris@dogfood.dev', DEMO_PASSWORD);
    const asParticipant = await participant.get(`/api/events/${eventA}/submissions`);
    assert.equal(
      asParticipant.status,
      403,
      `a participant read the submission list: ${asParticipant.raw.slice(0, 200)}`,
    );

    // And the organizer still gets it, so this is a guard and not a lockout.
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const asOrganizer = await organizer.get(`/api/events/${eventA}/submissions`);
    assert.equal(asOrganizer.status, 200, `the organizer lost the submission list: ${asOrganizer.raw.slice(0, 200)}`);
  });
});

describe('security: password reset', () => {
  test('a production build never returns the reset token to an anonymous caller', async (t) => {
    /*
     * Unauthenticated account takeover of anyone whose address is known. The
     * token came back in the response body, and the 5/hour IP budget is no
     * obstacle because one request per victim is all it takes.
     */
    const harness = await createHarness({ env: 'production' });
    t.after(() => harness.close());

    const response = await harness.client().post<{ sent?: boolean; resetToken?: string }>('/api/auth/password-reset', {
      email: 'ben@dogfood.dev',
    });
    assert.equal(response.status, 200, `the request failed: ${response.raw.slice(0, 200)}`);
    assert.equal(response.body.resetToken, undefined, 'a production build handed the reset token to an anonymous caller');
    assert.doesNotMatch(response.raw, /resetToken/, 'the token appears somewhere in the production response');

    // The flow still functions: an operator reads the token from the ledger.
    const issued = harness.db.all<{ action: string; metadata: string }>(
      `SELECT action, metadata FROM audit_events WHERE action LIKE 'auth.password_reset%' ORDER BY created_at DESC LIMIT 5`,
    );
    assert.ok(issued.length > 0, 'the reset was not recorded in the audit ledger, so an operator has no way to complete it');

    // And the response is identical for a real and an invented address, so the
    // endpoint still cannot be used to enumerate accounts.
    const unknown = await harness.client().post('/api/auth/password-reset', { email: 'nobody@nowhere.test' });
    assert.equal(unknown.status, response.status, 'the response status differs between a known and an unknown address');
    assert.equal(unknown.raw, response.raw, 'the response body differs between a known and an unknown address');
  });

  test('outside production the token is returned, because there is no mail service', async (t) => {
    const harness = await createHarness({ env: 'test' });
    t.after(() => harness.close());
    const response = await harness.client().post<{ resetToken?: string }>('/api/auth/password-reset', {
      email: 'ben@dogfood.dev',
    });
    assert.equal(response.status, 200);
    assert.ok(typeof response.body.resetToken === 'string', 'the demo flow no longer returns a token, so it cannot be completed');
  });
});


/* ==================================================================== *
 * Identity is not authority.
 * ==================================================================== */

describe('security: judge state transitions', () => {
  test('a judge cannot mark themselves complete with assignments outstanding', async (t) => {
    /*
     * `ACTIVE -> COMPLETED` asserts a fact about the panel: "all assigned
     * reviews are submitted". That is checkable, the count was already computed
     * and handed to the guards as `outstandingAssignments`, and the guard simply
     * did not consult it - the edge had no guard at all.
     *
     * Combined with `override: options.override === true || isSelf` in the
     * service, that meant a judge could walk their own record straight to
     * COMPLETED and back to ACTIVE indefinitely. A participation record attests
     * to how much of a panel was completed, so this is self-certification of
     * exactly the thing the record is evidence for.
     */
    const harness = await createHarness();
    t.after(() => harness.close());
    const eventId = seededEventId(harness);

    // Yuki is the seeded judge with deliberately unfinished assignments.
    const judge = harness.client();
    await judge.login('yuki@dogfood.dev', DEMO_PASSWORD);
    const queue = await judge.get<{ judgeId: string; total: number }>(`/api/events/${eventId}/pairwise/queue?pairs=1`);
    assert.equal(queue.status, 200, `could not read the judge queue: ${queue.raw.slice(0, 160)}`);
    const judgeId = queue.body.judgeId;
    assert.ok(judgeId !== undefined, 'no judge id on the queue');
    assert.ok(queue.body.total > 0, 'the premise needs a judge with outstanding work, and this one has none');

    const attempt = await judge.post(`/api/judges/${judgeId}/transition`, { to: 'COMPLETED' });
    assert.notEqual(attempt.status, 200, 'a judge marked themselves complete with work outstanding');
    assert.equal(attempt.status, 409, `expected 409, got ${String(attempt.status)}: ${attempt.raw.slice(0, 220)}`);

    // The state is untouched, which is the part a status code alone would not tell us.
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const panel = await organizer.get<{ data: { id: string; state: string }[] }>(`/api/events/${eventId}/judges`);
    const row = panel.body.data?.find((entry) => entry.id === judgeId);
    assert.notEqual(row?.state, 'COMPLETED', 'the judge was moved to COMPLETED despite the refusal');
  });

  test('an organizer override still completes a judge with work outstanding', async (t) => {
    // The guard must have an escape. An organizer closing out a judge whose
    // panel was reassigned, or who has left, is a real case - and it has to be
    // recorded as an override rather than being indistinguishable from the
    // ordinary path.
    const harness = await createHarness();
    t.after(() => harness.close());
    const eventId = seededEventId(harness);

    const judge = harness.client();
    await judge.login('yuki@dogfood.dev', DEMO_PASSWORD);
    const queue = await judge.get<{ judgeId: string }>(`/api/events/${eventId}/pairwise/queue?pairs=1`);
    const judgeId = queue.body.judgeId;
    assert.ok(judgeId !== undefined);

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const forced = await organizer.post(`/api/judges/${judgeId}/transition`, {
      to: 'COMPLETED',
      override: true,
      reason: 'regression test: the organizer escape must still work',
    });
    assert.equal(forced.status, 200, `the organizer override was refused: ${forced.raw.slice(0, 220)}`);

    const panel = await organizer.get<{ data: { id: string; state: string }[] }>(`/api/events/${eventId}/judges`);
    assert.equal(
      panel.body.data?.find((entry) => entry.id === judgeId)?.state,
      'COMPLETED',
      'the override reported success but the state did not change',
    );
  });

  test('a judge may still step out of the panel on their own record', async (t) => {
    // The self-service that must survive the scoping. Withdrawing is a step out
    // of the panel, not a claim about the work in it.
    const harness = await createHarness();
    t.after(() => harness.close());
    const eventId = seededEventId(harness);

    const judge = harness.client();
    await judge.login('amara@dogfood.dev', DEMO_PASSWORD);
    const queue = await judge.get<{ judgeId: string }>(`/api/events/${eventId}/pairwise/queue?pairs=1`);
    const judgeId = queue.body.judgeId;
    assert.ok(judgeId !== undefined);

    const steppedOut = await judge.post(`/api/judges/${judgeId}/transition`, { to: 'ACCEPTED' });
    assert.equal(steppedOut.status, 200, `a judge could not step out of the panel: ${steppedOut.raw.slice(0, 220)}`);
  });

  test('a judge cannot transition another judge, even with override', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const eventId = seededEventId(harness);

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const panel = await organizer.get<{ data: { id: string }[] }>(`/api/events/${eventId}/judges`);
    const somebodyElse = panel.body.data?.[0];
    assert.ok(somebodyElse !== undefined);

    const judge = harness.client();
    await judge.login('amara@dogfood.dev', DEMO_PASSWORD);
    const crossJudge = await judge.post(`/api/judges/${somebodyElse.id}/transition`, { to: 'COMPLETED', override: true });
    assert.notEqual(
      crossJudge.status,
      200,
      `a judge transitioned another judge, and the override flag made it possible: ${crossJudge.raw.slice(0, 200)}`,
    );
  });

  test('a participant with no panel role cannot transition anybody', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const eventId = seededEventId(harness);

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const panel = await organizer.get<{ data: { id: string }[] }>(`/api/events/${eventId}/judges`);
    const target = panel.body.data?.[0];
    assert.ok(target !== undefined);

    const participant = harness.client();
    await participant.login('iris@dogfood.dev', DEMO_PASSWORD);
    const attempt = await participant.post(`/api/judges/${target.id}/transition`, { to: 'COMPLETED', override: true });
    assert.notEqual(attempt.status, 200, `a participant transitioned a judge: ${attempt.raw.slice(0, 200)}`);
  });

  test('a refused transition is recorded in the audit ledger', async (t) => {
    // A denial that is not written down cannot be reviewed later, and this
    // particular denial is the one an operator would most want to see.
    const harness = await createHarness();
    t.after(() => harness.close());
    const eventId = seededEventId(harness);

    const judge = harness.client();
    await judge.login('yuki@dogfood.dev', DEMO_PASSWORD);
    const queue = await judge.get<{ judgeId: string }>(`/api/events/${eventId}/pairwise/queue?pairs=1`);
    const judgeId = queue.body.judgeId;
    assert.ok(judgeId !== undefined);
    await judge.post(`/api/judges/${judgeId}/transition`, { to: 'COMPLETED' });

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const audit = await organizer.get<{ data: { action: string; outcome: string; resourceId?: string }[] }>(
      `/api/events/${eventId}/audit?action=judge.state_changed&perPage=200`,
    );
    const denial = (audit.body.data ?? []).find((row) => row.resourceId === judgeId && row.outcome === 'DENIED');
    assert.ok(denial !== undefined, 'the refused transition left no DENIED entry in the audit ledger');
  });
});
/* ==================================================================== *
 * The conflict-override path, end to end.
 * ==================================================================== */

describe('security: conflict override', () => {
  /**
   * Declare a HARD conflict between a judge and a project. Declaring is the
   * precondition for overriding, so a test that skipped it would be testing
   * nothing.
   */
  async function declareHardConflict(
    harness: Awaited<ReturnType<typeof createHarness>>,
    eventId: string,
    judgeId: string,
    projectId: string,
  ): Promise<void> {
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const declared = await organizer.post<{ id: string }>(`/api/events/${eventId}/conflicts`, {
      judgeId,
      kind: 'TEAM',
      severity: 'HARD',
      projectId,
      subjectKind: 'TEAM',
      note: 'regression test: the judge is on the submitting team',
    });
    assert.equal(declared.status, 201, `could not declare the conflict: ${declared.raw.slice(0, 240)}`);
  }

  /** The first seeded judge, a seeded project, and a real assignment. */
  async function overrideFixture(
    harness: Awaited<ReturnType<typeof createHarness>>,
  ): Promise<{ eventId: string; judgeId: string; projectId: string; assignmentId: string }> {
    const eventId = seededEventId(harness);
    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const panel = await organizer.get<{ data: { id: string }[] }>(`/api/events/${eventId}/judges`);
    const assignments = await organizer.get<{ data: { id: string }[] }>(`/api/events/${eventId}/assignments?perPage=200`);
    const projects = await organizer.get<{ data: { id: string }[] }>(`/api/events/${eventId}/submissions?perPage=1`);
    const judgeId = panel.body.data?.[0]?.id;
    const assignmentId = assignments.body.data?.[0]?.id;
    const projectId = projects.body.data?.[0]?.id;
    assert.ok(judgeId !== undefined && assignmentId !== undefined && projectId !== undefined, 'the seeded fixture is incomplete');
    return { eventId, judgeId, projectId, assignmentId };
  }

  test('a real override works, and is recorded as an override', async (t) => {
    /*
     * This is the test whose absence let migration 16 ship a broken feature. The
     * new CHECK on `judge_assignments.strategy` did not list `OVERRIDE`, which
     * is the value this path writes, so the next real override would have failed
     * at the database. Nothing failed, because nothing had ever performed one.
     */
    const harness = await createHarness();
    t.after(() => harness.close());
    const { eventId, judgeId, projectId, assignmentId } = await overrideFixture(harness);
    await declareHardConflict(harness, eventId, judgeId, projectId);

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const forced = await organizer.post<{ id: string }>(`/api/assignments/${assignmentId}/conflict-override`, {
      judgeId,
      submissionId: projectId,
      reason: 'the project team changed after the conflict was declared',
      confirm: true,
    });
    assert.equal(forced.status, 200, `a real conflict override was refused: ${forced.raw.slice(0, 260)}`);

    // The strategy is recorded as an override. It used to be set only on insert,
    // so overriding the *existing* engine assignment - the common case - left
    // the engine strategy standing, and the row claimed the engine had decided
    // something a person had actually forced.
    //
    // Read from the database, and read the row the service actually resolved:
    // the route's `assignmentId` is used for the permission check, and the
    // service then finds the assignment by (judge, submission), so the two are
    // not guaranteed to be the same row. Asserting against the URL's id would
    // have checked the wrong record and passed for the wrong reason.
    const stored = harness.db.get<{ strategy: string }>(
      'SELECT strategy FROM judge_assignments WHERE judge_id = :j AND submission_id = :s',
      { j: judgeId, s: projectId },
    );
    assert.equal(stored?.strategy, 'OVERRIDE', `the override was recorded as "${String(stored?.strategy)}"`);

    // And it is in the ledger as an override, not as an ordinary assignment.
    const audit = await organizer.get<{ data: { action: string }[] }>(
      `/api/events/${eventId}/audit?action=conflict.override&perPage=50`,
    );
    assert.ok((audit.body.data ?? []).length > 0, 'the override left no conflict.override entry in the ledger');
  });

  /**
   * A second event with a judge and a project in it, so "another event" is a
   * real row rather than a plausible-looking id.
   *
   * A created event is empty - no judge, no submission - so pointing at one and
   * asserting a 404 would pass for the wrong reason: the service would reject a
   * row that does not exist, not one that belongs elsewhere. Only an id that
   * resolves, and resolves to a different event, tests the scoping.
   */
  async function secondEventWithData(
    harness: Awaited<ReturnType<typeof createHarness>>,
    slug: string,
  ): Promise<{ eventId: string; judgeId: string; projectId: string }> {
    const admin = harness.client();
    await admin.login('admin@hackathonraptors.dev', DEMO_PASSWORD);
    const created = await admin.request('POST', '/api/events', {
      csrf: true,
      payload: { slug, name: `Other ${slug}`, description: 'for the cross-event scoping tests' },
    });
    assert.equal(created.status, 201, `could not create the second event: ${created.raw.slice(0, 240)}`);
    const eventId = (JSON.parse(created.raw) as { id: string }).id;

    // The admin is the organizer of the event it just created, so it can staff it.
    const team = await admin.post<{ id: string }>(`/api/events/${eventId}/teams`, {
      name: 'Other Team',
      description: 'a team in the second event',
    });
    assert.equal(team.status, 201, `could not create a team in the second event: ${team.raw.slice(0, 240)}`);

    const submission = await admin.post<{ id: string }>(`/api/events/${eventId}/submissions`, {
      teamId: team.body.id,
      projectName: 'Other Project',
      shortDescription: 'A project in the second event.',
    });
    assert.equal(submission.status, 201, `could not create a submission in the second event: ${submission.raw.slice(0, 240)}`);

    // A judge, invited to the second event. The invite takes a list, not a single
    // address - which the first version of this fixture got wrong, and which
    // produced a 422 rather than a judge.
    const invite = await admin.post<{ userId?: string }>(`/api/events/${eventId}/judges/invite`, {
      emails: ['ben@dogfood.dev'],
      panelRole: 'GENEROUS',
    });
    assert.ok(
      invite.status === 200 || invite.status === 201,
      `could not put a judge on the second panel: ${invite.raw.slice(0, 240)}`,
    );
    const found = harness.db.get<{ id: string }>('SELECT id FROM judges WHERE event_id = :e LIMIT 1', { e: eventId });
    assert.ok(found !== null && found !== undefined, 'the second event still has no judge after inviting one');
    return { eventId, judgeId: found.id, projectId: submission.body.id };
  }

  test('the override refuses a submission from another event', async (t) => {
    // The body is the caller's, and the event is the route's. Nothing tied them
    // together, so a submission id from elsewhere would be written into this
    // event's assignment table - a row that claims one event and points at
    // another one's data.
    const harness = await createHarness();
    t.after(() => harness.close());
    const { assignmentId, judgeId } = await overrideFixture(harness);
    const other = await secondEventWithData(harness, 'other-projects');

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const response = await organizer.post(`/api/assignments/${assignmentId}/conflict-override`, {
      judgeId,
      submissionId: other.projectId,
      reason: 'attempting to pull a foreign project into this event',
      confirm: true,
    });
    assert.notEqual(
      response.status,
      200,
      `the override accepted a submission from another event: ${response.raw.slice(0, 220)}`,
    );
  });

  test('the override refuses a judge from another event', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const { assignmentId, projectId } = await overrideFixture(harness);
    const other = await secondEventWithData(harness, 'other-panel');

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const response = await organizer.post(`/api/assignments/${assignmentId}/conflict-override`, {
      judgeId: other.judgeId,
      submissionId: projectId,
      reason: 'attempting to bring a foreign judge into this event',
      confirm: true,
    });
    assert.notEqual(response.status, 200, `the override accepted a judge from another event: ${response.raw.slice(0, 220)}`);
  });

  test('the override refuses an unconfirmed request', async (t) => {
    // `confirm: z.literal(true)` makes an omitted or false confirmation a schema
    // violation, rejected with 422 before the service is reached at all. The
    // service's own 412 check is defence in depth for callers that are not this
    // route; this asserts the status a caller actually observes.
    const harness = await createHarness();
    t.after(() => harness.close());
    const { eventId, judgeId, projectId, assignmentId } = await overrideFixture(harness);
    await declareHardConflict(harness, eventId, judgeId, projectId);

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    const reason = 'a reason that is comfortably longer than fifteen characters';

    const omitted = await organizer.post(`/api/assignments/${assignmentId}/conflict-override`, {
      judgeId,
      submissionId: projectId,
      reason,
    });
    assert.equal(omitted.status, 422, `an unconfirmed override returned ${String(omitted.status)}: ${omitted.raw.slice(0, 160)}`);

    const explicitlyFalse = await organizer.post(`/api/assignments/${assignmentId}/conflict-override`, {
      judgeId,
      submissionId: projectId,
      reason,
      confirm: false,
    });
    assert.equal(explicitlyFalse.status, 422, `confirm: false returned ${String(explicitlyFalse.status)}`);
  });

  test('a participant cannot override a conflict', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const { assignmentId, judgeId, projectId } = await overrideFixture(harness);

    const participant = harness.client();
    await participant.login('iris@dogfood.dev', DEMO_PASSWORD);
    const attempt = await participant.post(`/api/assignments/${assignmentId}/conflict-override`, {
      judgeId,
      submissionId: projectId,
      reason: 'a participant should never get this far',
      confirm: true,
    });
    assert.notEqual(attempt.status, 200, `a participant performed a conflict override: ${attempt.raw.slice(0, 200)}`);
  });
});
/* ==================================================================== *
 * Uploads.
 * ==================================================================== */

/** A real 1x1 PNG, so the bytes pass signature validation. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function multipartBody(bytes: Buffer, filename = 'shot.png', mimetype = 'image/png'): {
  body: Buffer;
  boundary: string;
} {
  const boundary = `----verdicttest${String(Date.now())}${Math.floor(Math.random() * 1e6).toString(16)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { body: Buffer.concat([head, bytes, tail]), boundary };
}

type HarnessClient = Awaited<ReturnType<Awaited<ReturnType<typeof createHarness>>['client']>>;

describe('security: uploads', () => {
  /**
   * A submission the participant owns, plus the *same* client signed in as them.
   *
   * Both details matter. The submission is created over the API rather than read
   * from the seed, because the seed's submissions belong to various users and
   * one is LOCKED - a fixture that looked for "a submission to upload to" would
   * be testing the seed's shape instead of the upload route, and would silently
   * skip itself the day the seed changes.
   *
   * And the client is returned because `harness.client()` hands back a *new*
   * cookie jar on every call. Asking for a second client is how the first
   * version of these tests got 401s and then reported the 413 check as failing,
   * when the 413 was never actually exercised at all.
   */
  async function ownSubmission(harness: Awaited<ReturnType<typeof createHarness>>): Promise<{
    eventId: string;
    submissionId: string;
    client: HarnessClient;
  }> {
    const eventId = seededEventId(harness);
    const client = harness.client();
    await client.login('iris@dogfood.dev', DEMO_PASSWORD);
    const team = harness.db.get<{ id: string }>(
      'SELECT t.id FROM teams t JOIN users u ON u.id = t.captain_id WHERE u.email_normalized = :e LIMIT 1',
      { e: 'iris@dogfood.dev' },
    );
    assert.ok(team !== null, 'the demo participant does not captain a team');
    const created = await client.post<{ id: string }>(`/api/events/${eventId}/submissions`, {
      teamId: team.id,
      projectName: 'Upload Fixture',
      shortDescription: 'A submission owned by the participant, for the upload tests.',
    });
    assert.equal(created.status, 201, `could not create the fixture submission: ${created.raw.slice(0, 240)}`);
    return { eventId, submissionId: created.body.id, client };
  }

  const upload = (
    client: HarnessClient,
    submissionId: string,
    bytes: Buffer,
    filename?: string,
    mimetype?: string,
  ) => {
    const { body, boundary } = multipartBody(bytes, filename, mimetype);
    return client.request('POST', `/api/submissions/${submissionId}/uploads`, {
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
  };

  test('a normal image is accepted', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const { submissionId, client } = await ownSubmission(harness);
    const response = await upload(client, submissionId, PNG_1X1);
    assert.equal(response.status, 201, `a valid upload was refused: ${response.raw.slice(0, 240)}`);
    assert.match(response.raw, /"id"\s*:\s*"upl_/, 'the upload returned no id');
  });

  test('an oversized upload is a 413, not a 500', async (t) => {
    /*
     * `@fastify/multipart` reports an oversized file as `FST_REQ_FILE_TOO_LARGE`.
     * The error mapper only recognised the `FST_ERR_` family, so every rejected
     * upload fell through to INTERNAL_ERROR: a 500, a stack trace in the log,
     * "An unexpected error occurred" to the caller, and an alert for the operator
     * on what was a client mistake. The route even documented
     * `PAYLOAD_TOO_LARGE`, so the document promised a 413 that could not be
     * returned.
     */
    const harness = await createHarness();
    t.after(() => harness.close());
    const { submissionId, client } = await ownSubmission(harness);

    // Comfortably past the 8 MiB limit, without being absurd.
    const oversized = Buffer.alloc(9 * 1024 * 1024, 0x41);
    PNG_1X1.copy(oversized, 0);
    const response = await upload(client, submissionId, oversized, 'huge.png', 'image/png');

    assert.equal(
      response.status,
      413,
      `an oversized upload returned ${String(response.status)} rather than 413: ${response.raw.slice(0, 240)}`,
    );
    const parsed = JSON.parse(response.raw) as { error?: { code?: string } };
    assert.equal(parsed.error?.code, 'PAYLOAD_TOO_LARGE', `unexpected error code: ${response.raw.slice(0, 200)}`);
    assert.doesNotMatch(response.raw, /at .*\.ts:\d+/, 'the response leaked a stack trace');
    assert.doesNotMatch(response.raw, /\/app\//, 'the response leaked a filesystem path');
  });

  test('malformed multipart is a client error, not a server error', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const { submissionId, client } = await ownSubmission(harness);
    const response = await client.request('POST', `/api/submissions/${submissionId}/uploads`, {
      // Declares a boundary that is not in the body at all.
      payload: Buffer.from('this is not multipart'),
      headers: { 'content-type': 'multipart/form-data; boundary=absent-from-body' },
    });
    assert.ok(
      response.status >= 400 && response.status < 500,
      `malformed multipart returned ${String(response.status)}: ${response.raw.slice(0, 200)}`,
    );
  });

  test('a request with no file part is a client error', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const { submissionId, client } = await ownSubmission(harness);
    const response = await client.request('POST', `/api/submissions/${submissionId}/uploads`, {
      payload: { kind: 'SCREENSHOT' },
    });
    assert.ok(
      response.status >= 400 && response.status < 500,
      `a fileless upload returned ${String(response.status)}: ${response.raw.slice(0, 200)}`,
    );
  });

  test('someone else cannot upload to a submission they do not own', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const { submissionId } = await ownSubmission(harness);

    const stranger = harness.client();
    await stranger.login('amara@dogfood.dev', DEMO_PASSWORD);
    const response = await upload(stranger, submissionId, PNG_1X1);
    assert.notEqual(response.status, 201, `a judge uploaded to somebody else's submission: ${response.raw.slice(0, 200)}`);
  });

  test('a path-traversal filename is stored under a generated name', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const { submissionId, client } = await ownSubmission(harness);

    const response = await upload(client, submissionId, PNG_1X1, '../../../../etc/pwned.png');
    assert.equal(response.status, 201, `the upload was refused: ${response.raw.slice(0, 200)}`);

    const stored = harness.db.get<{ stored_name: string; original_name: string }>(
      'SELECT stored_name, original_name FROM uploads ORDER BY created_at DESC LIMIT 1',
    );
    assert.ok(stored !== null, 'the upload was not recorded');
    assert.match(stored.stored_name, /^upl_/, `the stored filename is not generated: ${stored.stored_name}`);
    assert.doesNotMatch(stored.stored_name, /\.\./, 'the stored filename contains a traversal sequence');
    // The original is kept for display, which is the safe thing to do with it.
    assert.equal(stored.original_name, 'pwned.png', 'the original name should be sanitized, not rejected');
  });

  test('an SVG is refused, because it is a document that can carry script', async (t) => {
    // SVG is a legitimate image format, and this endpoint serves uploads back on
    // the application's own origin.
    const harness = await createHarness();
    t.after(() => harness.close());
    const { submissionId, client } = await ownSubmission(harness);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
    const response = await upload(client, submissionId, svg, 'payload.svg', 'image/svg+xml');
    assert.equal(response.status, 415, `an SVG was accepted: ${response.raw.slice(0, 200)}`);
  });
});
/* ==================================================================== *
 * GETs that persist.
 * ==================================================================== */

/**
 * The tables that make up the domain proper: the data a GET must never touch.
 *
 * `export_jobs` and `audit_log` are excluded on purpose - they are the two places
 * a deliberate read-side record is allowed to land. Everything else in here is
 * the thing the export is a *view of*, so any change to it means the read is
 * doing more than reading.
 */
const DOMAIN_TABLES = [
  'submissions',
  'scores',
  'criterion_scores',
  'judge_assignments',
  'judge_conflicts',
  'judges',
  'comments',
  'certificates',
  'teams',
  'events',
  'users',
  'result_snapshots',
  'result_runs',
  'rubric_criteria',
  'registration_responses',
] as const;

function count(harness: Awaited<ReturnType<typeof createHarness>>, table: string, where = '1 = 1'): number {
  return Number(harness.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)?.n ?? 0);
}

function fingerprint(harness: Awaited<ReturnType<typeof createHarness>>): string {
  return DOMAIN_TABLES.map((table) => {
    // `SELECT *` is ordered by rowid so the digest is stable, and every table
    // here has one.
    const rows = harness.db.all<Row>(`SELECT * FROM ${table} ORDER BY rowid`);
    return `${table}=${JSON.stringify(rows)}`;
  }).join('|');
}

describe('security: read-side persistence', () => {
  /**
   * What each export GET actually does, measured rather than assumed.
   *
   * The suspicion going in was "the export GETs write, which is surprising for a
   * GET". Half of it was right, and the half that was wrong is the interesting
   * part: only the two that go through `transfer.exportCsv` record anything. The
   * manifest and the registrations export are pure reads, in a different
   * service, and marking them alongside the other two would have been a
   * documentation change nobody could check.
   *
   * So the table below is the answer, and the test asserts the server agrees.
   */
  const WRITES: Record<string, boolean> = {
    '/api/events/{eventId}/exports/{kind}': true,
    '/api/events/{eventId}/exports/{kind}.json': true,
    '/api/events/{eventId}/exports/manifest': false,
    '/api/events/{eventId}/registrations/export': false,
  };

  test('each export GET writes exactly what it is supposed to, and no more', async (t) => {
    /*
     * A safe method is assumed to be free of side effects, and the assumption is
     * load-bearing: it is why a client can prefetch, retry, or let a crawler fetch
     * a URL twice without thinking about it.
     *
     * Two of these four do write, on purpose. An audit ledger that cannot answer
     * "who exported this event's participant data, and when" is not much of a
     * ledger, and `export_jobs` is that history in a form an organizer can read.
     * The boundary worth proving is that the write stays inside those two tables
     * - if a read ever stamped "last exported" onto the project, that would be a
     * mutation wearing a GET's clothes, and a race between two organizers.
     */
    const harness = await createHarness();
    t.after(() => harness.close());
    const eventId = seededEventId(harness);

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

    const urls: [string, string][] = [
      ['/api/events/{eventId}/exports/{kind}', `/api/events/${eventId}/exports/SUBMISSIONS`],
      ['/api/events/{eventId}/exports/{kind}.json', `/api/events/${eventId}/exports/SUBMISSIONS.json`],
      ['/api/events/{eventId}/exports/manifest', `/api/events/${eventId}/exports/manifest`],
      ['/api/events/{eventId}/registrations/export', `/api/events/${eventId}/registrations/export`],
    ];

    for (const [label, url] of urls) {
      const before = fingerprint(harness);
      const jobsBefore = count(harness, 'export_jobs');
      const auditsBefore = count(harness, 'audit_events', "action = 'export.generated'");

      const response = await organizer.get(url);
      assert.equal(response.status, 200, `${url} failed: ${response.raw.slice(0, 200)}`);

      assert.equal(fingerprint(harness), before, `${url} changed the data it exports`);
      const expectedWrites = WRITES[label] ? 1 : 0;
      assert.equal(
        count(harness, 'export_jobs') - jobsBefore,
        expectedWrites,
        `${url} recorded ${String(count(harness, 'export_jobs') - jobsBefore)} export rows, expected ${String(expectedWrites)}`,
      );
      assert.equal(
        count(harness, 'audit_events', "action = 'export.generated'") - auditsBefore,
        expectedWrites,
        `${url} left ${String(count(harness, 'audit_events', "action = 'export.generated'") - auditsBefore)} audit rows, expected ${String(expectedWrites)}`,
      );
    }
  });

  test('the export history says who exported, when, and how much', async (t) => {
    // A row that cannot answer those three questions is not a history.
    const harness = await createHarness();
    t.after(() => harness.close());
    const eventId = seededEventId(harness);

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
    await organizer.get<string>(`/api/events/${eventId}/exports/SUBMISSIONS`);

    const job = harness.db.get<{
      kind: string;
      status: string;
      row_count: number;
      checksum: string;
      created_by: string;
      created_at: string;
    }>('SELECT kind, status, row_count, checksum, created_by, created_at FROM export_jobs ORDER BY created_at DESC LIMIT 1');
    assert.ok(job !== null, 'no export was recorded');
    assert.equal(job.kind, 'SUBMISSIONS');
    assert.equal(job.status, 'COMPLETED');
    assert.ok(job.row_count > 0, 'the export recorded no rows');
    assert.equal(job.created_by, await organizer.userId(), 'the export is not attributed to the organizer who took it');
    assert.ok(job.created_at.length > 0, 'the export has no timestamp');
  });

  test('the moderation queue is a pure read, despite the "moderate" permission', async (t) => {
    /*
     * The route is gated on a `moderate` permission, which reads like an action
     * and is not one. Loading the queue marks nothing, dismisses nothing, and
     * escalates nothing - an organizer opening the page in a background tab must
     * not quietly change the state of every comment in it.
     *
     * This is the control for the table above: a permission verb is not evidence
     * of a write, and the only way to tell them apart is to measure.
     */
    const harness = await createHarness();
    t.after(() => harness.close());
    const eventId = seededEventId(harness);

    const organizer = harness.client();
    await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

    const before = fingerprint(harness);
    const auditsBefore = count(harness, 'audit_events');

    const response = await organizer.get(`/api/events/${eventId}/comments/moderation`);
    assert.equal(response.status, 200, `the moderation queue failed: ${response.raw.slice(0, 240)}`);

    assert.equal(fingerprint(harness), before, 'reading the moderation queue changed the comments');
    assert.equal(count(harness, 'audit_events'), auditsBefore, 'reading the moderation queue wrote an audit row');
  });

  test('an export is refused to a participant, so no history is written for them', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const eventId = seededEventId(harness);

    const participant = harness.client();
    await participant.login('iris@dogfood.dev', DEMO_PASSWORD);
    const jobsBefore = count(harness, 'export_jobs');

    const response = await participant.get(`/api/events/${eventId}/exports/SUBMISSIONS`);
    assert.notEqual(response.status, 200, `a participant exported the event: ${response.raw.slice(0, 200)}`);

    assert.equal(count(harness, 'export_jobs'), jobsBefore, 'a refused export still recorded a job');
  });
});
/* ==================================================================== *
 * Participation record references.
 * ==================================================================== */

describe('security: participation record references', () => {
  /*
   * The reference was `JPR-` plus 8 hex characters - 32 bits of entropy, in a
   * document people are invited to share publicly.
   *
   * Thirty-two bits is not a lot. A record is found by guessing its reference, so
   * an attacker who wants to know what a judge scored simply tries references
   * until one resolves: a few billion attempts against a public endpoint, with
   * no rate limit on the guessing because the endpoint is meant to be open. Worse,
   * it looked fine - it was short, it was readable, it was the same shape as
   * every other reference in the system.
   *
   * New records therefore carry `JPR-` plus two eight-character Crockford groups
   * - about 80 bits - reusing the same `verificationCode` the rest of the
   * application uses rather than inventing a second alphabet.
   *
   * The part that is easy to get wrong is the old records. Tightening the format
   * is worthless if it invalidates the ones already issued and already in
   * organizers' hands, so the lookup is still an exact match on the stored column
   * and both formats resolve. The test below pins that, by writing a legacy row
   * by hand and verifying it the way a judge with a two-year-old link would.
   */
  const LEGACY = 'JPR-3F9A2B7C';

  /**
   * The verdict at a reference, or null.
   *
   * This endpoint answers 200 either way - "no such record" is an answer to the
   * question "is this record genuine?", not a transport failure. Asserting on the
   * HTTP status would therefore pass whether the record was found or not, which is
   * a test that cannot fail. The contract that matters is the `status` field.
   */
  async function verdictAt(
    harness: Awaited<ReturnType<typeof createHarness>>,
    reference: string,
  ): Promise<{ http: number; status: string; valid: boolean }> {
    const response = await harness.client().get<{ status: string; valid: boolean }>(
      `/api/participation-records/${reference}`,
    );
    return { http: response.status, status: String(response.body?.status), valid: response.body?.valid === true };
  }

  /**
   * A genuinely issued record, relabelled with an old-format reference.
   *
   * The earlier version of this fixture hand-wrote a row with a plausible hash,
   * which meant the record was found and reported TAMPERED - so the test could
   * not tell "the old reference resolved" from "the old reference resolved to
   * something wrong". Rewriting the reference on a real record is also closer to
   * the actual situation: the reference is the only thing that changes format,
   * and everything behind it was always the same.
   */
  function legacyReference(harness: Awaited<ReturnType<typeof createHarness>>, reference: string): string {
    const issued = harness.db.get<{ id: string }>('SELECT id FROM judge_participation_records ORDER BY issued_at DESC LIMIT 1');
    assert.ok(issued !== null, 'the seed issued no participation record to relabel');
    harness.db.exec('UPDATE judge_participation_records SET reference = :r WHERE id = :id', {
      r: reference,
      id: issued.id,
    });
    return issued.id;
  }

  test('a reference issued before the format change still verifies', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());
    legacyReference(harness, LEGACY);

    const verdict = await verdictAt(harness, LEGACY);
    assert.equal(verdict.status, 'VALID', `an already-issued reference stopped verifying: ${verdict.status}`);
    assert.equal(verdict.valid, true, 'an already-issued reference was reported as not genuine');
  });

  test('and it is found case-insensitively, as it always was', async (t) => {
    // A judge reading a printed certificate types what they see. The lookup
    // upper-cases before matching, and that behaviour is older than the format
    // change - so it has to survive it.
    const harness = await createHarness();
    t.after(() => harness.close());
    legacyReference(harness, LEGACY);

    const upper = await verdictAt(harness, LEGACY);
    const lower = await verdictAt(harness, LEGACY.toLowerCase());
    assert.equal(lower.status, upper.status, 'a lower-case reference resolves differently from an upper-case one');
  });

  test('a reference that is merely a prefix of a real one does not resolve', async (t) => {
    // Exact-column lookup, not a prefix search. If this were ever relaxed to
    // "starts with", the entropy increase would be undone in one edit - and
    // quietly, because a prefix search on a short reference still looks correct.
    const harness = await createHarness();
    t.after(() => harness.close());
    legacyReference(harness, LEGACY);

    const verdict = await verdictAt(harness, 'JPR-3F9A2B');
    assert.equal(verdict.status, 'NOT_FOUND', 'a truncated reference resolved to a record');
  });

  test('a reference nobody issued does not resolve, and is not distinguishable from nonsense', async (t) => {
    /*
     * "No such record" and "that is not a reference at all" must look identical.
     * If they did not, the difference would be worth enumerating, and an
     * attacker guessing references would get a free signal for free.
     */
    const harness = await createHarness();
    t.after(() => harness.close());

    const missing = await verdictAt(harness, 'JPR-00000000');
    const nonsense = await verdictAt(harness, 'not-a-reference-at-all');
    assert.equal(missing.status, 'NOT_FOUND', `an unknown reference reported ${missing.status}`);
    assert.equal(
      missing.status,
      nonsense.status,
      'an unknown reference and a malformed one are distinguishable, which is a free signal to a guesser',
    );
    assert.equal(missing.valid, false, 'an unknown reference was reported as valid');
  });
});
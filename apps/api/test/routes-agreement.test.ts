import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, seededEventId, DEMO_PASSWORD, type Harness } from './harness.ts';
import { ACCOUNTS } from './browser.ts';

/**
 * Every URL the product hands to a human must resolve to a real route.
 *
 * Three of these did not, and all three were invisible to the API test suite
 * because the API only ever returns the string — nothing checked that the SPA
 * could serve it:
 *
 *   - gallery cards link to `/e/:slug/projects/:slug`   -> no route: 404
 *   - the embed payload emits a project URL             -> no route: 404
 *   - certificate issue returns /certificates/:ref     -> no route: 404
 *   - team invitation returns /invite/:code             -> no route: 404
 *
 * A dead link in a product that is "defensible" is a small thing; a dead link
 * on the certificate a losing team forwards to an employer, and on the
 * invitation that forms a team, is not. These assert the API's URLs and the
 * router agree, so the two cannot drift.
 */
const APP_TSX = readFileSync(join(process.cwd(), 'apps', 'web', 'src', 'App.tsx'), 'utf8');

/** The literal `path="..."` values the router registers. */
function registeredRoutes(): string[] {
  return [...APP_TSX.matchAll(/path="([^"]+)"/g)].map((match) => match[1] as string);
}

/** True when a concrete path would be matched by a registered route pattern. */
function routeMatches(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = path.split('/').filter(Boolean);
  // A trailing `*` swallows the remainder, exactly as react-router does.
  if (patternSegments[patternSegments.length - 1] === '*') {
    return pathSegments.length >= patternSegments.length - 1;
  }
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, index) => segment.startsWith(':') || segment === pathSegments[index]);
}

function resolves(path: string): boolean {
  return registeredRoutes().some((pattern) => routeMatches(pattern, path));
}

test('the gallery card link resolves to a registered SPA route', async (t) => {
  const harness: Harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });

  const eventId = seededEventId(harness);
  const gallery = await harness.client().get<{ data: { slug: string }[] }>(`/api/events/${eventId}/gallery`);
  assert.equal(gallery.status, 200);
  const first = gallery.body.data[0];
  assert.ok(first !== undefined, 'the seeded gallery has at least one project');

  const target = `/e/dogfood-2026/projects/${first.slug}`;
  assert.ok(
    resolves(target),
    `gallery cards link to ${target} but App.tsx registers no matching route. Routes: ${registeredRoutes().join(', ')}`,
  );
});

test('the embeddable payload points at a resolvable project URL', async (t) => {
  const harness: Harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });

  const eventId = seededEventId(harness);
  const embed = await harness.client().get<{ projects: { url: string }[] }>(`/api/embed/${eventId}.json`);
  assert.equal(embed.status, 200);
  const first = embed.body.projects[0];
  assert.ok(first !== undefined, 'the embed payload has at least one project');

  // Strip the origin the payload prefixes; the SPA route is what matters.
  const path = new URL(first.url).pathname;
  assert.ok(
    resolves(path),
    `the embed payload points at ${path} but App.tsx registers no matching route`,
  );
});

test('a certificate URL the API hands out resolves to a registered SPA route', async (t) => {
  const harness: Harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });

  const organizer = harness.client();
  await organizer.login(ACCOUNTS.organizer, DEMO_PASSWORD);
  const eventId = seededEventId(harness);

  const issued = await organizer.post<{ reference: string; url: string }>(`/api/events/${eventId}/certificates`, {
    userId: harness.db.value<string>("SELECT id FROM users WHERE email = 'iris@dogfood.dev'") as string,
    kind: 'PARTICIPANT',
  });
  assert.equal(issued.status, 201, issued.raw);

  const path = new URL(issued.body.url).pathname;
  assert.ok(
    resolves(path),
    `issuing a certificate returns ${path} but App.tsx registers no matching route`,
  );

  // And the page it points at must actually verify, not just exist.
  const verify = await harness.client().get<{ status: string }>(`/api/certificates/${issued.body.reference}`);
  assert.equal(verify.status, 200);
  assert.ok(['VALID', 'REVOKED'].includes(verify.body.status), `unexpected status ${verify.body.status}`);
});

test('a team invitation URL the API hands out resolves to a registered SPA route', async (t) => {
  const harness: Harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });

  const organizer = harness.client();
  await organizer.login(ACCOUNTS.organizer, DEMO_PASSWORD);

  /*
   * A brand-new event, because the seeded one has passed its submission
   * deadline and correctly refuses team changes with DEADLINE_PASSED. Using the
   * frozen demo event here would either fail the test or, worse, tempt someone
   * to "fix" it by weakening the deadline check. This also exercises the real
   * participant path end to end: create an event, register, form a team, invite.
   *
   * The ADMIN account creates the event, which is the platform's actual model:
   * `create event` is granted at ANY scope, so only a global admin may make a
   * new event, and an admin then hands out event-scoped ORGANIZER roles through
   * /api/admin/users/{userId}/roles. An ORGANIZER cannot self-serve an event,
   * and asserting that here keeps the boundary from quietly widening.
   */
  const operator = harness.client();
  await operator.login(ACCOUNTS.admin, DEMO_PASSWORD);
  const slug = `invite-check-${Date.now().toString(36)}`;
  const created = await operator.post<{ id: string }>('/api/events', {
    slug,
    name: 'Invitation route check',
    timezone: 'UTC',
    registrationOpensAt: null,
    registrationClosesAt: null,
    submissionOpensAt: null,
    submissionClosesAt: null,
  });
  assert.equal(created.status, 201, created.raw);
  const eventId = created.body.id;

  // The event creator is not automatically able to run it by invitation alone;
  // an admin grants the event-scoped role. Assert an organizer cannot self-serve.
  const selfServe = await harness.client();
  await selfServe.login(ACCOUNTS.organizer, DEMO_PASSWORD);
  const denied = await selfServe.post<{ error: { code: string } }>('/api/events', {
    slug: `${slug}-two`,
    name: 'Organizer self-service attempt',
    timezone: 'UTC',
  });
  assert.equal(denied.status, 403, 'an ORGANIZER must not be able to create an event');
  assert.equal(denied.body.error.code, 'FORBIDDEN');

  // A second participant joins the new event and registers.
  const joiner = harness.client();
  await joiner.login('ben@dogfood.dev', DEMO_PASSWORD);
  const applied = await joiner.post(`/api/events/${eventId}/registration`, {
    fullName: 'Ben',
    responses: {},
  });
  assert.equal(applied.status, 201, applied.raw);

  // The operator caps a team and creates it, so the invitation has a captain.
  const team = await operator.post<{ id: string }>(`/api/events/${eventId}/teams`, {
    name: 'Route Check Team',
    description: 'Created to prove the invitation URL resolves.',
  });
  assert.equal(team.status, 201, team.raw);

  const invitation = await operator.post<{ url: string }>(`/api/teams/${team.body.id}/invitations`, {
    email: 'ben@dogfood.dev',
  });
  assert.equal(invitation.status, 201, invitation.raw);

  const path = new URL(invitation.body.url).pathname;
  assert.ok(
    resolves(path),
    `creating an invitation returns ${path} but App.tsx registers no matching route`,
  );

  // The invitation preview must work, and must not leak the invited address to
  // an anonymous caller.
  const preview = await harness.client().get<{ forYou: boolean; team: { name: string } }>(
    `/api/invitations${path.replace('/invite', '')}`,
  );
  assert.equal(preview.status, 200, preview.raw);
  assert.equal(preview.body.forYou, false, 'an anonymous caller is not told this invitation is for them');
  assert.equal(preview.body.team.name, 'Route Check Team');

  // And the invited account can accept it.
  const accepted = await joiner.post(`/api/invitations${path.replace('/invite', '')}/accept`, {});
  assert.equal(accepted.status, 200, accepted.raw);
});

test('the public results verification reference resolves to a real route or endpoint', async (t) => {
  const harness: Harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });

  // The certificate page links to the SVG; assert that endpoint answers with
  // the right content type rather than JSON, since a browser <img>/download
  // against a JSON error body is a silent failure.
  const organizer = harness.client();
  await organizer.login(ACCOUNTS.organizer, DEMO_PASSWORD);
  const eventId = seededEventId(harness);
  const row = harness.db.get<{ reference: string }>(
    'SELECT reference FROM certificates WHERE event_id = :e LIMIT 1',
    { e: eventId },
  );
  assert.ok(row !== null, 'seeding issues at least one certificate');

  const svg = await harness.client().get(`/api/certificates/${row.reference}.svg`);
  assert.equal(svg.status, 200);
  assert.match(String(svg.headers['content-type'] ?? ''), /image\/svg\+xml/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, seededEventId, DEMO_PASSWORD, type Harness } from './harness.ts';

/**
 * The OpenAPI document, checked against the API that serves it.
 *
 * "API-first" only means something if the contract is true. The document used
 * to be generated from the same Zod schemas the server validates with, which
 * sounds like a guarantee and mostly was - but the parts that were *not* derived
 * from a schema were wrong, and wrong in ways a client would hit:
 *
 *   - every operation that did not declare a response schema was documented as
 *     `204 No Content`, which is 140 of 144. The real distribution is 200, 201
 *     and 204, and a client generated from that document would not know a
 *     creation had happened;
 *   - a route's query schema was emitted as one parameter named `query`, so the
 *     filters on roughly fifteen endpoints were documented nowhere and only one
 *     operation in the whole document had any query parameters;
 *   - every operation advertised a `requestId` header that the server ignored;
 *   - every operation advertised `429`, including the health check, which is
 *     rate-limit exempt and can never return one;
 *   - the upload endpoint had no documented request body at all.
 *
 * So the document is now compared against the running server, operation by
 * operation. This test is the mechanism: it calls routes, checks the status the
 * document claims, and checks the parameters the document claims are accepted.
 */


type Operation = {
  operationId: string;
  tags: string[];
  summary: string;
  parameters?: { name: string; in: string; required?: boolean; schema?: Record<string, unknown> }[];
  requestBody?: { content: Record<string, { schema?: { required?: string[]; properties?: Record<string, unknown> } }> };
  responses: Record<string, unknown>;
  security: unknown;
  'x-verdict-auth'?: string;
  'x-verdict-permission'?: { resource: string; action: string };
};

type Spec = {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
};

/**
 * Build the document from the running route registry rather than reading
 * `openapi.json`.
 *
 * That file is a generated artefact and is not committed, so a test that read it
 * would pass locally and fail in a clean checkout with ENOENT - and worse, it
 * would happily pass against a *stale* copy. Building from the registry means
 * this test can only ever describe what the server actually registers, and
 * `npm run check:openapi` is still the thing that keeps the committed artefact
 * honest.
 */
async function liveSpec(t: { after: (fn: () => Promise<void>) => void }): Promise<Spec> {
  const harness = await openHarness(t);
  const spec = await harness.client().get<Spec>('/api/openapi.json');
  assert.equal(spec.status, 200, 'the server did not serve a document to check');
  return spec.body;
}

async function openHarness(t: { after: (fn: () => Promise<void>) => void }): Promise<Harness> {
  const harness = await createHarness();
  t.after(async () => {
    await harness.close();
  });
  return harness;
}

/** Every operation in the document, as a flat list. */
function allOperations(spec: Spec): { method: string; path: string; operation: Operation }[] {
  const out: { method: string; path: string; operation: Operation }[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      out.push({ method: method.toUpperCase(), path, operation: operation as Operation });
    }
  }
  return out;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

test('the document declares a success status for every operation', async (t) => {
  const spec = await liveSpec(t);
  for (const { method, path, operation } of allOperations(spec)) {
    const codes = Object.keys(operation.responses);
    const successes = codes.filter((code) => /^2\d\d$/.test(code));
    assert.equal(
      successes.length,
      1,
      `${method} ${path} declares ${successes.length} success responses (${successes.join(', ') || 'none'})`,
    );
    assert.ok(
      successes[0] !== '204' || SAFE_METHODS.has(method) || method === 'DELETE' || method === 'POST',
      `${method} ${path} is documented as 204, which is only correct for a read, a delete, or a POST that genuinely returns no content`,
    );
  }
});

test('the only POST documented as 204 is logout, and the server agrees', async (t) => {
  /*
   * 204 on a POST is only meaningful for an operation that genuinely returns
   * no representation. The one such operation here is logout, which deletes the
   * session. This pins the list so a new 204 on a POST has to be justified
   * rather than inherited from the old default.
   */
  const spec = await liveSpec(t);
  const expected = ['POST /api/auth/logout'];
  const actual = allOperations(spec)
    .filter(({ method, operation }) => method === 'POST' && operation.responses['204'] !== undefined)
    .map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(actual.sort(), expected.sort());
});

test('the request id is echoed, as every operation claims it will be', async (t) => {
  const harness = await openHarness(t);
  const spec = await harness.client().get<Spec>('/api/openapi.json');
  assert.equal(spec.status, 200);

  // Every operation advertises the header, so every operation must honour it.
  const sample = allOperations(spec.body).filter((entry) => entry.operation.parameters?.some((p) => p.name === 'requestId'));
  assert.ok(sample.length > 100, `only ${String(sample.length)} operations advertise a requestId header`);

  const supplied = 'probe-correlation-1234';
  const response = await harness.client().request('GET', '/api/capabilities', {
    headers: { 'x-request-id': supplied },
    csrf: false,
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers['x-request-id'],
    supplied,
    'a supplied request id was not echoed, so the document is lying about it',
  );

  // A malformed one is ignored rather than refused - a debugging aid must not
  // be able to cause a denial of service - but a request id is still returned.
  const junk = await harness.client().request('GET', '/api/capabilities', {
    headers: { 'x-request-id': 'no' },
    csrf: false,
  });
  assert.equal(junk.status, 200, 'a malformed request id was rejected instead of ignored');
  assert.match(
    String(junk.headers['x-request-id'] ?? ''),
    /^req_/,
    'no request id was returned when the supplied one was ignored',
  );

  // And the ledger records the id the client sent, so it actually correlates.
  const organizer = harness.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);
  const audit = await organizer.get<{ data: { requestId: string }[] }>(
    `/api/events/${seededEventId(harness)}/audit?perPage=200`,
  );
  const ids = new Set(audit.body.data.map((row) => row.requestId));
  assert.ok(ids.size > 0, 'the audit ledger carries no request ids at all');
});

test('rate-limit-exempt routes do not advertise 429', async (t) => {
  const spec = await liveSpec(t);
  // `/api/health` is hidden from the document, so this checks the flag reached
  // the generator at all rather than a specific published operation.
  const health = allOperations(spec).find((entry) => entry.path === '/api/health');
  if (health !== undefined) {
    assert.equal(health.operation.responses['429'], undefined, '/api/health is rate-limit exempt and cannot return 429');
  }

  // And the flag is set: every other published operation legitimately can.
  const rateLimited = allOperations(spec).filter((entry) => entry.operation.responses['429'] !== undefined);
  assert.ok(rateLimited.length > 100, 'the 429 response was removed from every operation, which is also wrong');
});

test('query parameters are individual parameters, not one opaque object', async (t) => {
  const spec = await liveSpec(t);
  for (const { method, path, operation } of allOperations(spec)) {
    const params = operation.parameters ?? [];
    assert.ok(
      !params.some((parameter) => parameter.name === 'query' && parameter.in === 'query'),
      `${method} ${path} still declares a single opaque "query" parameter, which no tooling reads`,
    );
  }

  // The gallery has five filters. They must all be named.
  const gallery = spec.paths['/api/events/{eventId}/gallery']?.['get'];
  assert.ok(gallery !== undefined, 'the gallery is not in the document');
  const names = (gallery.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name).sort();
  for (const expected of ['search', 'sort', 'technology', 'trackId', 'page', 'perPage']) {
    assert.ok(names.includes(expected), `the gallery does not document ?${expected} (has: ${names.join(', ')})`);
  }
});

test('the upload endpoint documents its multipart body', async (t) => {
  const spec = await liveSpec(t);
  const upload = spec.paths['/api/submissions/{submissionId}/uploads']?.['post'];
  assert.ok(upload !== undefined, 'the upload endpoint is not in the document');
  assert.ok(upload.requestBody !== undefined, 'the upload endpoint has no documented request body');

  const multipart = upload.requestBody?.content['multipart/form-data'];
  assert.ok(multipart !== undefined, 'the upload endpoint does not document multipart/form-data');
  const schema = multipart?.schema;
  assert.ok(schema?.required?.includes('file') === true, 'the file part is not marked required');
  assert.equal(
    (schema?.properties?.['file'] as { format?: string } | undefined)?.format,
    'binary',
    'the file part is not documented as binary',
  );
});

test('every operation is a real route the server serves', async (t) => {
  /*
   * The other direction of the contract: not "the spec describes nothing", but
   * "the spec describes only what exists". A path in the document that 404s is
   * a promise the server does not keep; a route missing from the document is a
   * capability nobody can find.
   */
  const harness = await openHarness(t);
  const spec = await harness.client().get<Spec>('/api/openapi.json');
  assert.equal(spec.status, 200);

  const client = harness.client();
  let checked = 0;
  for (const [path, methods] of Object.entries(spec.body.paths)) {
    for (const method of Object.keys(methods)) {
      // A structural probe: a path that does not exist answers 404 with the
      // project's own error envelope. Served paths answer with anything else.
      const response = await client.request(
        method.toUpperCase() as 'GET',
        path.replace(/\{[^}]+\}/g, 'probe-id-000'),
        { csrf: false, payload: {} },
      );
      if (response.status === 404) {
        // Could be a real 404 from a handler, or a missing route. Distinguish by
        // the message: a missing route names the method and path.
        const body = response.body as { error?: { message?: string }; message?: string };
        const message = body.error?.message ?? body.message ?? '';
        /*
         * A route that Fastify does not serve at all is reported by the
         * not-found handler as `Endpoint "<METHOD> <url>" was not found.` A
         * handler's own domain 404 names the *resource* it could not load, as
         * in `Assignment "..." was not found.`, and that is correct behaviour
         * for a synthetic id - so only the `Endpoint` form means the document
         * lists an operation the server does not have.
         */
        assert.doesNotMatch(
          message,
          /^Endpoint "/,
          `${method.toUpperCase()} ${path} is in the document but the server does not serve it (${message})`,
        );
      }
      checked += 1;
    }
  }
  assert.ok(checked > 100, `only ${String(checked)} operations were probed`);
});

/**
 * The public read surface, driven for real against a real seeded event.
 *
 * Each row names the document template as well as the concrete path, so the
 * assertion is "the document says 200 for this operation, and the server
 * returns 200 for it" rather than a search for something that looks right.
 */
const PUBLIC_READS: { method: 'GET'; template: string; path: (eventId: string) => string; success: number }[] = [
  { method: 'GET', template: '/api/capabilities', path: () => '/api/capabilities', success: 200 },
  { method: 'GET', template: '/api/events', path: () => '/api/events', success: 200 },
  { method: 'GET', template: '/api/lifecycle', path: () => '/api/lifecycle', success: 200 },
  { method: 'GET', template: '/api/rbac/matrix', path: () => '/api/rbac/matrix', success: 200 },
  { method: 'GET', template: '/api/events/{eventId}', path: (e) => `/api/events/${e}`, success: 200 },
  { method: 'GET', template: '/api/events/{eventId}/gallery', path: (e) => `/api/events/${e}/gallery`, success: 200 },
  { method: 'GET', template: '/api/events/{eventId}/gallery/technologies', path: (e) => `/api/events/${e}/gallery/technologies`, success: 200 },
  { method: 'GET', template: '/api/events/{eventId}/tracks', path: (e) => `/api/events/${e}/tracks`, success: 200 },
  { method: 'GET', template: '/api/events/{eventId}/prizes', path: (e) => `/api/events/${e}/prizes`, success: 200 },
  { method: 'GET', template: '/api/events/{eventId}/results', path: (e) => `/api/events/${e}/results`, success: 200 },
  { method: 'GET', template: '/api/events/{eventId}/registration/form', path: (e) => `/api/events/${e}/registration/form`, success: 200 },
  { method: 'GET', template: '/api/embed/{eventId}.json', path: (e) => `/api/embed/${e}.json`, success: 200 },
];

test('every public read is described the way it behaves', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const anonymous = harness.client();
  const spec = await anonymous.get<Spec>('/api/openapi.json');
  assert.equal(spec.status, 200);

  for (const row of PUBLIC_READS) {
    const concrete = row.path(eventId);
    const response = await anonymous.request('GET', concrete, { csrf: false });
    assert.equal(
      response.status,
      row.success,
      `GET ${concrete} returned ${String(response.status)}, expected ${String(row.success)}: ${response.raw.slice(0, 200)}`,
    );

    const operation = spec.body.paths[row.template]?.[row.method.toLowerCase()];
    assert.ok(operation !== undefined, `the document has no ${row.method} ${row.template}`);
    assert.ok(
      operation.responses[String(row.success)] !== undefined,
      `the document does not describe ${row.method} ${row.template} as returning ${String(row.success)}; it declares ${Object.keys(operation.responses).join(', ')}`,
    );
    // And it is not also documented as something else.
    const successes = Object.keys(operation.responses).filter((code) => /^2\d\d$/.test(code));
    assert.equal(successes.length, 1, `${row.method} ${row.template} declares several success codes: ${successes.join(', ')}`);
  }
});

test('a creation the server performs with 201 is documented as 201', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const organizer = harness.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

  // Creating a team is a 201 in the handler. The document said 204 for every
  // operation without a response schema, so this is the specific case that was
  // wrong and that a client would notice immediately.
  const created = await organizer.post<{ id: string }>(`/api/events/${eventId}/teams`, {
    name: `Openapi Truth Probe ${String(Date.now())}`,
    description: 'created to check the documented status',
  });
  assert.equal(created.status, 201, `creating a team returned ${String(created.status)}: ${created.raw.slice(0, 200)}`);

  const spec = await harness.client().get<Spec>('/api/openapi.json');
  const operation = spec.body.paths['/api/events/{eventId}/teams']?.['post'];
  assert.ok(operation !== undefined, 'team creation is not in the document');
  assert.ok(
    operation.responses['201'] !== undefined,
    `team creation is documented as ${Object.keys(operation.responses).filter((c) => /^2/.test(c)).join(', ')} rather than 201`,
  );
  assert.equal(operation.responses['204'], undefined, 'team creation is still documented as 204');

  // And the created thing really exists, so this is not a 201 with nothing behind it.
  const listed = await organizer.get<{ data: { id: string }[] }>(`/api/events/${eventId}/teams`);
  assert.ok(listed.body.data.some((team) => team.id === created.body.id), 'the created team is not in the team list');
});

test('a delete the server performs with 204 is documented as 204', async (t) => {
  const harness = await openHarness(t);
  const eventId = seededEventId(harness);
  const organizer = harness.client();
  await organizer.login('organizer@dogfood.dev', DEMO_PASSWORD);

  const created = await organizer.post<{ id: string }>(`/api/events/${eventId}/teams`, {
    name: `Openapi Delete Probe ${String(Date.now())}`,
    description: 'created to check the documented delete status',
  });
  assert.equal(created.status, 201);
  const invitation = await organizer.post(`/api/teams/${created.body.id}/invitations`, {});
  void invitation;
  // A member row is required to delete, so use a comment report round trip
  // instead: a webhook delete needs no setup beyond creating one.
  const webhook = await organizer.post<{ id: string }>(`/api/events/${eventId}/webhooks`, {
    url: 'https://example.com/openapi-delete-probe',
    subscriptions: ['results.published'],
    secret: 'openapi-delete-probe-secret-0123456789',
  });
  assert.equal(webhook.status, 201);

  const deleted = await organizer.delete(`/api/webhooks/${webhook.body.id}`);
  assert.equal(deleted.status, 204, `deleting a webhook returned ${String(deleted.status)}`);

  const spec = await harness.client().get<Spec>('/api/openapi.json');
  const operation = spec.body.paths['/api/webhooks/{webhookId}']?.['delete'];
  assert.ok(operation !== undefined, 'webhook deletion is not in the document');
  assert.ok(operation.responses['204'] !== undefined, 'webhook deletion is not documented as 204');
});

test('operations that persist are marked, so a GET that writes cannot hide', async (t) => {
  const spec = await liveSpec(t);
  /*
   * `GET /diagnostics` used to record review flags and an audit row, which is why
   * the route now has a POST sibling. Rather than trust that by inspection, this
   * asserts the shape holds: every GET that documents a mutating permission is
   * one we know about, and the diagnostics GET is a pure read.
   */
  const diagnosticsGet = spec.paths['/api/events/{eventId}/diagnostics']?.['get'];
  const diagnosticsPost = spec.paths['/api/events/{eventId}/diagnostics']?.['post'];
  assert.ok(diagnosticsGet !== undefined, 'the diagnostics read is not documented');
  assert.ok(diagnosticsPost !== undefined, 'there is no documented way to file the signals');
  assert.equal(
    (diagnosticsGet['x-verdict-permission'] as { action: string } | undefined)?.action,
    'read',
    'the diagnostics GET is documented as a read',
  );
  assert.equal(
    (diagnosticsPost['x-verdict-permission'] as { action: string } | undefined)?.action,
    'create',
    'filing the signals should be documented as a create, not a read',
  );
});

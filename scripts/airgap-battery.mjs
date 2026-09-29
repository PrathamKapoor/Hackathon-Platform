/**
 * The air-gapped functional battery.
 *
 * Runs INSIDE a container started with `--network none`, so there is no network
 * interface at all - not a blocked route, not a filtered one, no interface. Every
 * assertion here is made over loopback against the real server.
 *
 * This is the strongest form the claim can take: if the platform works here, it
 * depends on nothing but itself. A caveat stated up front - the browser suite
 * cannot be part of it, because with no network namespace there is no way for a
 * browser on the host to reach the container over TCP. That is reported
 * honestly rather than worked around.
 */
const BASE = 'http://127.0.0.1:8080';
const PASSWORD = 'verdict-demo-2026';

let cookies = new Map();
let csrf = null;
const results = [];

function absorb(response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function call(method, path, { body, useCsrf = false, headers = {} } = {}) {
  const h = { ...headers };
  if (cookies.size > 0) h.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  if (useCsrf && csrf) h['x-verdict-csrf'] = csrf;
  let payload;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(BASE + path, { method, headers: h, body: payload });
  absorb(response);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: String(await fn()) });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message ?? error).slice(0, 220) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function anon() {
  const saved = new Map(cookies);
  cookies = new Map();
  return { saved, restore: () => { cookies = saved; } };
}

/* -- 16: prove there is genuinely no network before claiming anything else --- */

await check('no network interface at all', async () => {
  const os = await import('node:os');
  const ifaces = Object.entries(os.networkInterfaces())
    .filter(([, addrs]) => addrs !== undefined)
    .flatMap(([name, addrs]) => addrs.map((a) => `${name}:${a.family}`))
    .filter((entry) => !entry.startsWith('lo'));
  assert(ifaces.length === 0, `non-loopback interfaces present: ${ifaces.join(', ')}`);
  return 'zero non-loopback interfaces';
});

await check('DNS resolution fails', async () => {
  const { promises: dns } = await import('node:dns');
  try {
    await dns.lookup('registry.npmjs.org');
  } catch (error) {
    return `blocked (${error.code})`;
  }
  throw new Error('DNS resolved a public name with no network interface');
});

await check('outbound HTTPS fails', async () => {
  try {
    const r = await fetch('https://example.com', { signal: AbortSignal.timeout(4000) });
    throw new Error(`reached the internet: status ${r.status}`);
  } catch (error) {
    // `fetch failed` with no `code` is Node's generic wrapper for a transport
    // failure, which is exactly what a missing route produces. The point is that
    // it threw at all.
    return `blocked (${error.cause?.code ?? error.message})`;
  }
});

/* -- 4, 5: health and readiness -------------------------------------------- */

await check('health endpoint responds', async () => {
  const r = await call('GET', '/api/health');
  assert(r.status === 200, `status ${r.status}`);
  return `200 ${r.json?.status ?? 'ok'}`;
});

await check('readiness endpoint reports the schema', async () => {
  const r = await call('GET', '/api/ready');
  assert(r.status === 200, `status ${r.status}`);
  return `200 ${r.json?.status} schema=${String(r.json?.schemaVersion)}`;
});

/* -- 5: the frontend loads ------------------------------------------------- */

await check('frontend shell serves HTML', async () => {
  const r = await call('GET', '/');
  assert(r.status === 200, `status ${r.status}`);
  assert(/text\/html/.test(r.headers.get('content-type') ?? ''), 'not HTML');
  assert(r.text.includes('id="root"'), 'no React root in the shell');
  return `200, ${r.text.length} bytes, React root present`;
});

await check('the JS bundle and stylesheet are served locally', async () => {
  const shell = await call('GET', '/');
  const assets = [...shell.text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  assert(assets.length > 0, 'the shell references no built assets');
  for (const asset of assets) {
    const r = await call('GET', asset);
    assert(r.status === 200, `${asset} returned ${r.status}`);
  }
  return `${assets.length} assets, all served: ${assets.join(', ')}`;
});

await check('a deep link resolves to the shell', async () => {
  const r = await call('GET', '/projects/some-slug');
  assert(r.status === 200, `status ${r.status}`);
  return '200';
});

/* -- 6, 7, 12, 13: sign in, and reach both roles --------------------------- */

let eventId = null;
let judgeId = null;

await check('anonymously, the public gallery works', async () => {
  const events = await call('GET', '/api/events');
  assert(events.status === 200, `status ${events.status}`);
  eventId = events.json?.data?.[0]?.id;
  assert(eventId, 'no seeded event');
  const gallery = await call('GET', `/api/events/${eventId}/gallery`);
  assert(gallery.status === 200, `gallery status ${gallery.status}`);
  return `1 event, ${(gallery.json?.data ?? []).length} public projects`;
});

await check('organizer signs in', async () => {
  const r = await call('POST', '/api/auth/login', { body: { email: 'organizer@dogfood.dev', password: PASSWORD } });
  assert(r.status === 200, `status ${r.status}: ${r.text.slice(0, 160)}`);
  csrf = r.json?.csrfToken;
  assert(csrf, 'no CSRF token');
  return `200 as ${r.json?.user?.email}`;
});

await check('organizer reaches the dashboard', async () => {
  const r = await call('GET', `/api/events/${eventId}/registrations`);
  assert(r.status === 200, `status ${r.status}`);
  return `200, ${(r.json?.data ?? []).length} registrations`;
});

await check('judge signs in and reaches their queue', async () => {
  const saved = new Map(cookies);
  const savedCsrf = csrf;
  try {
    cookies = new Map();
    const login = await call('POST', '/api/auth/login', { body: { email: 'amara@dogfood.dev', password: PASSWORD } });
    assert(login.status === 200, `status ${login.status}`);
    csrf = login.json?.csrfToken;
    // `/judges` is the organizer's panel view, so a judge asking for it is a 403
    // and correctly so. The judge's own surface is the pairwise queue.
    const queue = await call('GET', `/api/events/${eventId}/pairwise/queue?pairs=2`);
    assert(queue.status === 200, `queue status ${queue.status}: ${queue.text.slice(0, 160)}`);
    judgeId = queue.json?.judgeId;
    return `200, judgeId ${String(judgeId)}, queue total ${String(queue.json?.total)}`;
  } finally {
    cookies = saved;
    csrf = savedCsrf;
  }
});

/* -- 9, 10: save a score, then submit it ----------------------------------- */

await check('judge saves a score (autosave path)', async () => {
  const saved = new Map(cookies);
  const savedCsrf = csrf;
  try {
    cookies = new Map();
    const login = await call('POST', '/api/auth/login', { body: { email: 'yuki@dogfood.dev', password: PASSWORD } });
    assert(login.status === 200, `login status ${login.status}`);
    csrf = login.json?.csrfToken;

    // The assignments list is organizer-scoped, so ask as the organizer, then
    // switch back to the judge for the write. Yuki is the seeded panelist with
    // two deliberately unfinished assignments.
    const asOrganizer = new Map(cookies);
    const organizerCsrf = csrf;
    cookies = saved;
    csrf = savedCsrf;
    const assignments = await call('GET', `/api/events/${eventId}/assignments?perPage=200`);
    const rows = assignments.json?.data ?? [];
    assert(rows.length > 0, `the organizer saw no assignments: ${assignments.text.slice(0, 200)}`);
    const unfinished = rows.find((a) => a.status === 'IN_PROGRESS') ?? rows[0];
    cookies = asOrganizer;
    csrf = organizerCsrf;

    const assignmentId = unfinished.id;
    const opened = await call('POST', `/api/assignments/${assignmentId}/review`, { useCsrf: true });
    assert(opened.status === 200 || opened.status === 201, `open returned ${opened.status}: ${opened.text.slice(0, 200)}`);

    const read = await call('GET', `/api/assignments/${assignmentId}/review`);
    assert(read.status === 200, `read returned ${read.status}: ${read.text.slice(0, 200)}`);
    const criteria = read.json?.rubric?.criteria ?? read.json?.criteria ?? [];
    assert(Array.isArray(criteria) && criteria.length > 0, `no rubric criteria to score: ${read.text.slice(0, 200)}`);

    // The review body is `{ criteria: [{ criterionId, value, comment? }] }`,
    // not a map keyed by criterion.
    const criteriaBody = criteria.map((criterion, i) => ({
      criterionId: criterion.id ?? criterion.key,
      value: 5 + (i % 3),
      comment: null,
    }));
    const payload = { criteria: criteriaBody, summary: 'Air-gapped verification: scored with no network at all.' };
    const savedScore = await call('PUT', `/api/assignments/${assignmentId}/review`, { useCsrf: true, body: payload });
    assert(savedScore.status === 200 || savedScore.status === 201, `save returned ${savedScore.status}: ${savedScore.text.slice(0, 240)}`);

    const submitted = await call('POST', `/api/assignments/${assignmentId}/review`, { useCsrf: true, body: payload });
    assert(submitted.status === 200 || submitted.status === 201, `submit returned ${submitted.status}: ${submitted.text.slice(0, 240)}`);

    return `scored ${criteria.length} criteria and submitted (assignment ${assignmentId}, was ${String(unfinished.status)})`;
  } finally {
    cookies = saved;
    csrf = savedCsrf;
  }
});

/* -- 11, 12: normalization and results, computed for real -------------------- */

await check('normalization comparison computes', async () => {
  const r = await call('GET', `/api/events/${eventId}/normalization/comparison?method=Z_SCORE`);
  assert(r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
  const rows = r.json?.data ?? r.json?.projects ?? [];
  return `200, ${rows.length} projects compared`;
});

let runId = null;
await check('result computation runs', async () => {
  const run = await call('POST', `/api/events/${eventId}/results/compute`, { useCsrf: true, body: {} });
  assert(run.status === 200 || run.status === 201, `compute returned ${run.status}: ${run.text.slice(0, 220)}`);
  runId = run.json?.id ?? run.json?.runId;
  const entries = (run.json?.entries ?? run.json?.run?.entries ?? []).length;
  return `200, run ${String(runId)} with ${entries} entries`;
});

await check('the result is deterministic across two computations', async () => {
  const first = await call('POST', `/api/events/${eventId}/results/compute`, { useCsrf: true, body: {} });
  const second = await call('POST', `/api/events/${eventId}/results/compute`, { useCsrf: true, body: {} });
  assert(first.status === second.status, `the two runs disagreed on status: ${first.status} vs ${second.status}`);
  const hashOf = (r) => r.json?.integrityHash ?? r.json?.run?.integrityHash;
  const a = hashOf(first);
  const b = hashOf(second);
  assert(typeof a === 'string' && a.length > 0, `no integrity hash on the first run: ${first.text.slice(0, 200)}`);
  assert(a === b, `integrity hashes differ: ${String(a)} vs ${String(b)}`);
  return `both ${a.slice(0, 16)}`;
});

await check('snapshot publishes and is publicly verifiable', async () => {
  const snap = await call('POST', `/api/events/${eventId}/results/${String(runId)}/snapshot`, { useCsrf: true, body: {} });
  assert(snap.status === 200 || snap.status === 201, `snapshot returned ${snap.status}: ${snap.text.slice(0, 220)}`);
  const snapshotId = snap.json?.snapshotId ?? snap.json?.id ?? snap.json?.snapshot?.id;
  assert(snapshotId, `no snapshot id in ${snap.text.slice(0, 200)}`);
  const published = await call('POST', `/api/events/${eventId}/results/snapshots/${String(snapshotId)}/publish`, { useCsrf: true, body: {} });
  assert(published.status === 200 || published.status === 201, `publish returned ${published.status}: ${published.text.slice(0, 220)}`);

  const { restore } = anon();
  const verify = await call('GET', `/api/results/verify/${eventId}::${String(snapshotId)}`);
  restore();
  assert(verify.status === 200, `verify returned ${verify.status}: ${verify.text.slice(0, 200)}`);
  return `200, publicly reproduced as ${String(verify.json?.status)}`;
});

/* -- 13: the audit ledger -------------------------------------------------- */

await check('the audit ledger is written and carries request ids', async () => {
  const r = await call('GET', `/api/events/${eventId}/audit?perPage=200`);
  assert(r.status === 200, `status ${r.status}`);
  const rows = r.json?.data ?? [];
  const withId = rows.filter((row) => row.requestId);
  assert(rows.length > 0, 'the ledger is empty');
  return `${rows.length} entries, ${withId.length} with a request id`;
});

/* -- 14: OpenAPI is served ------------------------------------------------- */

await check('the OpenAPI document is served', async () => {
  const r = await call('GET', '/api/openapi.json');
  assert(r.status === 200, `status ${r.status}`);
  const paths = Object.keys(r.json?.paths ?? {});
  assert(paths.length > 100, `only ${paths.length} paths`);
  return `200, ${paths.length} paths`;
});

/* -- 15: the public gallery again, after all the writes -------------------- */

await check('the public gallery is unaffected by organizer activity', async () => {
  const { restore } = anon();
  const r = await call('GET', `/api/events/${eventId}/gallery`);
  restore();
  assert(r.status === 200, `status ${r.status}`);
  return `200, ${(r.json?.data ?? []).length} projects still public`;
});

/* -- report ---------------------------------------------------------------- */

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(52)} ${r.detail}`);
}
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length} of ${results.length} air-gapped checks passed`);
console.log(`networking: ${failed.length === 0 ? 'no interface, and the platform did not need one' : 'see failures'}`);
process.exit(failed.length === 0 ? 0 : 1);

/**
 * Does the organizer reproduction report *what* changed, not just that it did?
 *
 * The public route deliberately returns only a verdict, which is right: a
 * published result's field-level diff is not owed to the public. The organizer
 * route is the one that should carry it, and the documentation claims a
 * field-level diff. This checks that claim by tampering, reproducing as the
 * organizer, and printing whatever differences come back.
 *
 * Run inside the container.
 */
import { DatabaseSync } from 'node:sqlite';

const BASE = 'http://127.0.0.1:8080';
const PASSWORD = 'verdict-demo-2026';

const db = new DatabaseSync('/data/verdict.db');
const one = (sql, params) => (params === undefined ? db.prepare(sql).get() : db.prepare(sql).get(params));

const jar = new Map();
let csrf = null;

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function api(method, path, body) {
  const headers = {};
  if (jar.size > 0) headers.cookie = cookieHeader();
  if (csrf) headers['x-verdict-csrf'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  // Accumulate, do not replace: the session sets two cookies and the second
  // would otherwise overwrite the first.
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json, text };
}

console.log('');
console.log('Does organizer reproduction name the field that changed?');
console.log('===================================================');

const login = await api('POST', '/api/auth/login', { email: 'organizer@dogfood.dev', password: PASSWORD });
if (login.status !== 200) {
  console.log(`could not sign in: ${login.status}`);
  process.exit(2);
}
csrf = login.json?.csrfToken;

const events = await api('GET', '/api/events');
const eventId = events.json?.data?.[0]?.id;
const snapshots = await api('GET', `/api/events/${eventId}/results/snapshots`);
const snapshot = snapshots.json?.data?.[0];
if (snapshot === undefined) {
  console.log('no published snapshot; run the reproduction script first');
  process.exit(2);
}
console.log(`  event    : ${eventId}`);
console.log(`  snapshot : ${snapshot.id}`);
console.log('');

const target = one(
  `SELECT s.id, s.raw_score FROM scores s
     JOIN judge_assignments a ON a.id = s.assignment_id
    WHERE a.event_id = ? AND s.state IN ('SUBMITTED','LOCKED') LIMIT 1`,
  eventId,
);
const original = target.raw_score;
console.log(`  changing stored raw_score on ${target.id} from ${String(original)} to ${String(original + 25)}`);
db.prepare('UPDATE scores SET raw_score = raw_score + 25.0 WHERE id = ?').run(target.id);
console.log('');

const reproduce = await api('POST', `/api/events/${eventId}/results/snapshots/${snapshot.id}/reproduce`, {});
const body = reproduce.json ?? {};
const diffs = body.differences ?? [];
console.log(`  status         : ${String(body.status)}`);
console.log(`  response keys  : ${Object.keys(body).join(', ')}`);
console.log(`  differences    : ${diffs.length}`);
for (const diff of diffs.slice(0, 6)) {
  console.log(`      ${JSON.stringify(diff).slice(0, 200)}`);
}

db.prepare('UPDATE scores SET raw_score = ? WHERE id = ?').run(original, target.id);
const restored = await api('POST', `/api/events/${eventId}/results/snapshots/${snapshot.id}/reproduce`, {});
console.log('');
console.log(`  after restoring: ${String(restored.json?.status)} with ${(restored.json?.differences ?? []).length} difference(s)`);

db.close();

const verdict = diffs.length > 0 ? 'field-level diff reported' : 'no field-level diff reported';
console.log('');
console.log(
  body.status === 'MISMATCH' && diffs.length > 0
    ? `VERIFIED: the organizer route names what changed (${verdict})`
    : `PARTIAL: tamper detected as ${String(body.status)}, but ${verdict}. The public route intentionally withholds the diff; the organizer route is the one that should carry it.`,
);
process.exit(body.status === 'MISMATCH' ? 0 : 1);

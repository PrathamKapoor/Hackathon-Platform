/**
 * Does verification actually detect tampering, or does it always say MATCH?
 *
 * A reproducibility claim that has only ever been observed to succeed is not
 * evidence. The MATCH in the reproduction script only means something if the
 * same code path reports MISMATCH when the stored evidence changes.
 *
 * So this alters a stored review score directly in the database - bypassing the
 * application entirely, which is the only way to simulate an operator with file
 * access or a bug that writes outside the normal path - and then asks the public
 * verification endpoint, as an anonymous caller, what it now says.
 *
 * Run inside the container. Exit code 0 means the tamper was detected.
 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/data/verdict.db');
const one = (sql, params) => (params === undefined ? db.prepare(sql).get() : db.prepare(sql).get(params));

const event = one("SELECT id, name FROM events WHERE slug = 'dogfood-2026'");
if (event === null) {
  console.log('no seeded event; run the reproduction script first');
  process.exit(2);
}

const snapshot = one(
  'SELECT id, sequence, integrity_hash FROM result_snapshots WHERE event_id = ? AND published_at IS NOT NULL ORDER BY sequence DESC LIMIT 1',
  event.id,
);
if (snapshot === null) {
  console.log('no published snapshot; run the reproduction script first');
  process.exit(2);
}

/* A score row that feeds the pipeline. */
const target = one(
  `SELECT s.id, s.raw_score, s.total_score, s.submission_id
     FROM scores s
     JOIN judge_assignments a ON a.id = s.assignment_id
    WHERE a.event_id = ? AND s.state IN ('SUBMITTED','LOCKED')
    LIMIT 1`,
  event.id,
);
if (target === null) {
  console.log('no submitted score to tamper with');
  process.exit(2);
}

const before = target.raw_score ?? target.total_score;
console.log('');
console.log('Tamper detection for a published result');
console.log('========================================');
console.log(`  event      : ${event.name}`);
console.log(`  snapshot   : ${snapshot.id} (sequence ${snapshot.sequence})`);
console.log(`  integrity  : ${snapshot.integrity_hash}`);
console.log(`  target score: ${target.id}, value ${String(before)}`);
console.log('');

/* Before tampering, verification must be clean. Otherwise a MISMATCH afterwards
   would prove nothing - it might just mean the snapshot was already stale. */
let tamperedBody = null;
const probe = async (label) => {
  const response = await fetch(`http://127.0.0.1:8080/api/results/verify/${event.id}::${snapshot.id}`);
  const body = await response.json();
  const diffs = body?.differences ?? [];
  if (label.startsWith('after tampering')) tamperedBody = body;
  console.log(`  ${label.padEnd(34)} ${String(body?.status).padEnd(9)} ${diffs.length} difference(s)`);
  for (const diff of diffs.slice(0, 3)) {
    console.log(`      ${JSON.stringify(diff).slice(0, 160)}`);
  }
  return body;
};

const clean = await probe('before tampering');

console.log('');
console.log('  altering the stored raw score directly in SQLite...');
db.prepare('UPDATE scores SET raw_score = raw_score + 25.0 WHERE id = ?').run(target.id);

const after = one('SELECT raw_score FROM scores WHERE id = ?', target.id);
console.log(`  raw_score ${String(before)} -> ${String(after.raw_score)}`);

const tampered = await probe('after tampering');

/* Put it back, so the check is repeatable and leaves the database as found. */
db.prepare('UPDATE scores SET raw_score = ? WHERE id = ?').run(before, target.id);
const restored = one('SELECT raw_score FROM scores WHERE id = ?', target.id);
console.log('');
console.log(`  restored to ${String(restored.raw_score)}`);

const again = await probe('after restoring');

db.close();

const detected = clean?.status === 'MATCH' && tampered?.status === 'MISMATCH' && again?.status === 'MATCH';
console.log('');
console.log(
  detected
    ? 'tamper detection verified: MATCH -> MISMATCH -> MATCH around a single stored value'
    : `NOT VERIFIED: clean=${String(clean?.status)} tampered=${String(tampered?.status)} restored=${String(again?.status)}`,
);
process.exit(detected ? 0 : 1);

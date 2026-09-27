/**
 * Identifier generation.
 *
 * IDs are prefixed (`evt_`, `sub_`, ...) so that an ID appearing in a log line
 * or a support ticket is self-describing, and so that a mis-pasted ID from the
 * wrong table fails loudly instead of silently matching a row.
 *
 * The body is a Crockford base32 encoding of a 48-bit timestamp plus 80 bits
 * of randomness, which makes IDs:
 *   - collision-resistant without a database round trip
 *   - lexicographically sortable by creation time, so `ORDER BY id` is a
 *     stable, meaningful tie-break
 *   - safe to expose publicly (no sequential enumeration)
 */

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const ID_PREFIXES = {
  user: 'usr',
  session: 'ses',
  event: 'evt',
  track: 'trk',
  prize: 'prz',
  registration: 'reg',
  registrationField: 'rfd',
  registrationResponse: 'rsp',
  team: 'tem',
  teamMember: 'tmb',
  teamInvitation: 'tvi',
  submission: 'sub',
  submissionVersion: 'suv',
  upload: 'upl',
  judge: 'jdg',
  judgeConflict: 'cfl',
  judgeAssignment: 'asg',
  rubric: 'rub',
  rubricVersion: 'rvr',
  rubricCriterion: 'rct',
  score: 'scr',
  criterionScore: 'csc',
  calibrationSession: 'cal',
  calibrationScore: 'cls',
  normalizationRun: 'nrm',
  judgeDiagnostic: 'dgn',
  anomalyFlag: 'anf',
  communityVote: 'vot',
  comment: 'cmt',
  auditEvent: 'aud',
  resultRun: 'run',
  resultRunEntry: 'rnt',
  resultSnapshot: 'snp',
  resultEntry: 'ent',
  participationRecord: 'prr',
  certificate: 'crt',
  webhook: 'whk',
  webhookDelivery: 'whd',
  pairwiseComparison: 'pwr',
  importJob: 'imp',
  exportJob: 'exp',
  // Deliberately not 'pwr': prefixes exist so a mis-pasted id from the wrong
  // table fails loudly, and a reset token landing in a pairwise query should.
  passwordReset: 'pws',
  requestLog: 'req',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/**
 * @param now epoch milliseconds; injected in tests and by the seeder so that
 *        generated ids are deterministic for a fixed run.
 */
export function newId(kind: IdKind, now: number = Date.now()): string {
  const prefix = ID_PREFIXES[kind];
  // 48 bits of creation time -> lexicographic ids sort by age. Clamped so a
  // caller passing a nonsense epoch cannot produce a colliding prefix.
  const time = BigInt(Math.max(0, Math.floor(now))) & 0xffffffffffffn;
  const random = randomBytes(10); // 80 bits
  const body = encodeBase32(time, 10) + encodeBytes(random, 16);
  return `${prefix}_${body}`;
}

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[Number(remaining % 32n)] + out;
    remaining = remaining / 32n;
  }
  return out;
}

function encodeBytes(bytes: Uint8Array, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.slice(0, length);
}

const ID_PATTERN = /^[a-z]{3}_[0-9a-hjkmnp-tv-z]{20,32}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function assertId(kind: IdKind, value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith(`${ID_PREFIXES[kind]}_`)) {
    throw new TypeError(`Expected a ${kind} id (${ID_PREFIXES[kind]}_...), received ${String(value)}`);
  }
  return value;
}

/** Short opaque token (session ids, invitation links, password reset codes). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** URL-safe, human-typeable invitation code such as "K4P2-9XQD". */
export function newInviteCode(): string {
  const raw = randomBytes(8);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const byte of raw) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

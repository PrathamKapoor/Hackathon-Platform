/**
 * Password hashing.
 *
 * Choice: scrypt (RFC 7914) from the Node standard library.
 *
 * Why not bcrypt or argon2id?
 *   - Both are native addons. That means a compiler or a prebuilt binary at
 *     install time, which breaks the "clone and run offline" promise and makes
 *     the Docker build platform-dependent.
 *   - Argon2id is the better algorithm today and would be the right choice for a
 *     service with a native toolchain available.
 * scrypt is memory-hard, appears in the OWASP Password Storage Cheat Sheet's
 * recommended list, needs no native code, and is a single `crypto.scryptSync`
 * call. The trade-off is documented in THREAT-MODEL.md rather than hidden: the
 * parameters below cost roughly 32 MiB and 60-100 ms per hash on a typical
 * server core, calibrated to make online guessing expensive while keeping an
 * interactive login responsive.
 *
 * The stored format is self-describing so parameters can be raised later
 * without invalidating existing hashes:
 *
 *     scrypt$N$r$p$<base64url salt>$<base64url derived key>
 *
 * `verifyPassword` reads the parameters from the stored string, so an old hash
 * keeps verifying after the cost parameters are increased, and `needsRehash`
 * tells the caller when to upgrade it on the next successful login.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const ALGORITHM = 'scrypt';

/** Cost parameters. Changing these only affects newly created hashes. */
export const SCRYPT_PARAMS = {
  /** CPU/memory cost. Must be a power of two. */
  N: 32768,
  /** Block size. Memory is roughly 128 * N * r bytes => 32 MiB at these values. */
  r: 8,
  /** Parallelisation. */
  p: 1,
  /** Derived key length in bytes. */
  keyLength: 64,
  /** Salt length in bytes. */
  saltLength: 16,
  /** scrypt refuses to allocate beyond this; also bounds a tampered row. */
  maxmem: 96 * 1024 * 1024,
} as const;

function derive(password: string, salt: Buffer, N: number, r: number, p: number, length: number): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, length, { N, r, p, maxmem: SCRYPT_PARAMS.maxmem });
}

/**
 * A valid hash of a fixed throwaway value. Verifying against this when the
 * account does not exist makes "unknown user" and "wrong password" cost the
 * same, so login timing does not disclose which emails have accounts.
 */
const DUMMY_HASH = (() => {
  const salt = Buffer.alloc(SCRYPT_PARAMS.saltLength, 7);
  const key = derive('verdict-timing-equaliser', salt, SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, SCRYPT_PARAMS.keyLength);
  return `${ALGORITHM}$${String(SCRYPT_PARAMS.N)}$${String(SCRYPT_PARAMS.r)}$${String(SCRYPT_PARAMS.p)}$${salt.toString('base64url')}$${key.toString('base64url')}`;
})();

export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_PARAMS.saltLength);
  const key = derive(password, salt, SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, SCRYPT_PARAMS.keyLength);
  return `${ALGORITHM}$${String(SCRYPT_PARAMS.N)}$${String(SCRYPT_PARAMS.r)}$${String(SCRYPT_PARAMS.p)}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export type VerifyReason = 'ok' | 'mismatch' | 'malformed';

export type VerifyResult = {
  valid: boolean;
  /** True when the stored hash used weaker parameters than the current policy. */
  needsRehash: boolean;
  reason: VerifyReason;
};

export function verifyPassword(password: string, stored: string): VerifyResult {
  const parsed = parseHash(stored);

  if (parsed === null) {
    // Burn the same work a real verification would, so a corrupt or tampered
    // row in the database is not distinguishable from a wrong password.
    derive(password, Buffer.alloc(SCRYPT_PARAMS.saltLength, 11), SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, SCRYPT_PARAMS.keyLength);
    return { valid: false, needsRehash: true, reason: 'malformed' };
  }

  let derived: Buffer;
  try {
    derived = derive(password, parsed.salt, parsed.N, parsed.r, parsed.p, parsed.expected.length);
  } catch {
    return { valid: false, needsRehash: true, reason: 'malformed' };
  }

  const valid = derived.length === parsed.expected.length && timingSafeEqual(derived, parsed.expected);
  const needsRehash =
    parsed.N < SCRYPT_PARAMS.N ||
    parsed.r < SCRYPT_PARAMS.r ||
    parsed.p < SCRYPT_PARAMS.p ||
    parsed.expected.length < SCRYPT_PARAMS.keyLength;

  return { valid, needsRehash, reason: valid ? 'ok' : 'mismatch' };
}

type ParsedHash = { N: number; r: number; p: number; salt: Buffer; expected: Buffer };

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const algorithm = parts[0] as string;
  if (algorithm !== ALGORITHM) return null;
  const N = Number.parseInt(parts[1] as string, 10);
  const r = Number.parseInt(parts[2] as string, 10);
  const p = Number.parseInt(parts[3] as string, 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || (N & (N - 1)) !== 0) return null; // scrypt requires a power of two
  if (r < 1 || r > 32 || p < 1 || p > 16) return null;
  // A tampered row must not be able to request an unbounded allocation.
  if (N * r * 128 > SCRYPT_PARAMS.maxmem) return null;
  const salt = Buffer.from(parts[4] as string, 'base64url');
  const expected = Buffer.from(parts[5] as string, 'base64url');
  if (salt.length < 8 || expected.length < 16) return null;
  return { N, r, p, salt, expected };
}

/** Spend verification-equivalent time without a real account. */
export function dummyVerify(password: string): void {
  verifyPassword(password, DUMMY_HASH);
}

export function isHashFormat(value: string): boolean {
  return value.startsWith(`${ALGORITHM}$`);
}

/**
 * SHA-256 hex of an opaque token. Used for session cookies, invitation codes and
 * reset tokens: these are high-entropy random values, so a fast hash is correct
 * (there is nothing to brute force) and lets the lookup be indexed.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison for tokens of equal expected length. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

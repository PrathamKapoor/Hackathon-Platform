/**
 * Canonical serialisation and integrity hashing.
 *
 * Result snapshots must be provably immutable and reproducible. That requires
 * a byte-stable encoding of arbitrary JSON: object keys sorted, no
 * insignificant whitespace, no reliance on `JSON.stringify` key insertion
 * order, and explicit rejection of `undefined`, `NaN` and `Infinity`.
 */

import { createHash } from 'node:crypto';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Deterministic JSON encoding: recursively sorted object keys, no whitespace.
 * Throws on non-finite numbers so that NaN can never be silently encoded.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

function encode(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(`canonicalJson: non-finite number ${String(value)}`);
    }
    // Normalise -0 to 0 so hashes do not depend on sign of zero.
    return JSON.stringify(n === 0 ? 0 : n);
  }
  if (t === 'string') return JSON.stringify(value as string);
  if (t === 'bigint') return JSON.stringify((value as bigint).toString());
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  const obj = value as object;
  if (seen.has(obj)) throw new TypeError('canonicalJson: circular structure');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item) => encode(item, seen));
      return `[${parts.join(',')}]`;
    }
    if (obj instanceof Date) return JSON.stringify(obj.toISOString());
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const encoded = encode(record[key], seen);
      if (encoded === 'null' && record[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/** SHA-256 hex digest of arbitrary bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** SHA-256 of the canonical JSON encoding of a value. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Chain a list of hashes into a single digest. Used to bind a snapshot to the
 * exact set of inputs that produced it: changing any input changes the chain.
 */
export function hashChain(parts: readonly unknown[]): string {
  return contentHash(parts);
}

/**
 * Short, human-quotable verification reference (e.g. for certificates).
 * Uses Crockford-style base32 without ambiguous characters.
 */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function verificationCode(digest: string, groups = 2, groupSize = 4): string {
  const clean = digest.toUpperCase().replace(/[^0-9A-F]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  let bits = 0;
  let value = 0;
  const out: string[] = [];
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out.push(BASE32[(value >>> (bits - 5)) & 31] as string);
      bits -= 5;
    }
  }
  if (bits > 0) out.push(BASE32[(value << (5 - bits)) & 31] as string);
  const joined = out.join('');
  const chunked: string[] = [];
  for (let i = 0; i + groupSize <= joined.length && chunked.length < groups; i += groupSize) {
    chunked.push(joined.slice(i, i + groupSize));
  }
  return chunked.join('-');
}

/** Stable short ID for certificates and verification records. */
export function certificateReference(digest: string): string {
  return `CRT-${verificationCode(digest, 2, 5)}`;
}

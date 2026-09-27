/**
 * Session and CSRF token lifecycle.
 *
 * ---------------------------------------------------------------------------
 * SESSION DESIGN
 * ---------------------------------------------------------------------------
 * The cookie carries a 256-bit random token. The database stores only its
 * SHA-256 digest, so a database disclosure does not yield usable session
 * cookies. Lookups are by digest, which is indexed.
 *
 * Two independent expiries apply:
 *   idle      - the session dies unless used within N days
 *   absolute  - the session dies N days after creation no matter what
 * The absolute cap is what stops a stolen cookie from being kept alive forever
 * by an attacker who keeps using it.
 *
 * Cookie flags: HttpOnly (no JavaScript access), SameSite=Lax (no cross-site
 * POST), Path=/, and Secure whenever the deployment is HTTPS.
 *
 * ---------------------------------------------------------------------------
 * CSRF
 * ---------------------------------------------------------------------------
 * Two layers, because they fail differently:
 *   1. SameSite=Lax already prevents a cross-site form POST from carrying the
 *      session cookie.
 *   2. A double-submit token: a random value in a readable cookie must be
 *      echoed in the `x-verdict-csrf` header on every state-changing request.
 *      SameSite=Lax means an attacker's page cannot read the cookie to populate
 *      the header, so the two together are robust even if SameSite is ignored
 *      by an old client.
 * Plus an Origin/Referer check, which costs nothing and stops a whole class of
 * requests before they reach a handler.
 */

import { newId, newToken } from '@verdict/core/ids';
import { addSeconds, now, toEpochMs, type Instant } from '@verdict/core/time';
import { sha256, safeEqual } from './password.ts';
import type { Database } from '../db/database.ts';

export type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  ip_address: string;
  user_agent: string;
  created_at: string;
  last_seen_at: string;
  last_seen_ms: number;
  expires_at: string;
  expires_ms: number;
  revoked_at: string | null;
  revoked_reason: string | null;
};

export type SessionOptions = {
  idleTimeoutDays: number;
  absoluteTimeoutDays: number;
};

/** The idle window is not refreshed more often than this, to bound writes. */
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export class SessionStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: {
    userId: string;
    ipAddress: string;
    userAgent: string;
    options: SessionOptions;
    at?: Instant;
  }): { session: SessionRow; token: string; csrfToken: string } {
    const at = input.at ?? now();
    const token = newToken(32);
    const csrfToken = newToken(24);
    const id = newId('session');
    const absoluteExpiry = addSeconds(at, input.options.absoluteTimeoutDays * 86_400);

    this.db.exec(
      `INSERT INTO sessions (
         id, user_id, token_hash, csrf_token, ip_address, user_agent,
         created_at, last_seen_at, last_seen_ms, expires_at, expires_ms
       ) VALUES (
         :id, :user_id, :token_hash, :csrf_token, :ip_address, :user_agent,
         :created_at, :last_seen_at, :last_seen_ms, :expires_at, :expires_ms
       )`,
      {
        id,
        user_id: input.userId,
        token_hash: sha256(token),
        csrf_token: csrfToken,
        ip_address: input.ipAddress.slice(0, 64),
        user_agent: input.userAgent.slice(0, 300),
        created_at: at,
        last_seen_at: at,
        last_seen_ms: toEpochMs(at),
        expires_at: absoluteExpiry,
        expires_ms: toEpochMs(absoluteExpiry),
      },
    );

    return { session: this.require(id), token, csrfToken };
  }

  /** Resolve a cookie value to a live session, refreshing the idle window. */
  resolve(token: string, options: SessionOptions, at: Instant = now()): SessionRow | null {
    const row = this.find(token);
    if (row === null) return null;
    if (row.revoked_at !== null) return null;
    if (toEpochMs(at) >= row.expires_ms) return null;

    // Enforce the idle window independently of the stored absolute expiry.
    const idleDeadline = toEpochMs(row.last_seen_at) + options.idleTimeoutDays * 86_400_000;
    if (toEpochMs(at) >= idleDeadline) {
      this.revoke(row.id, 'idle timeout', at);
      return null;
    }

    if (toEpochMs(at) - row.last_seen_ms > LAST_SEEN_WRITE_INTERVAL_MS) {
      this.db.exec('UPDATE sessions SET last_seen_at = :at, last_seen_ms = :ms WHERE id = :id', {
        at,
        ms: toEpochMs(at),
        id: row.id,
      });
      row.last_seen_at = at;
      row.last_seen_ms = toEpochMs(at);
    }

    return row;
  }

  find(token: string): SessionRow | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = :hash', { hash: sha256(token) });
  }

  require(id: string): SessionRow {
    const row = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = :id', { id });
    if (row === null) throw new Error(`Session ${id} disappeared immediately after creation`);
    return row;
  }

  revoke(id: string, reason: string, at: Instant = now()): void {
    this.db.exec('UPDATE sessions SET revoked_at = :at, revoked_reason = :reason WHERE id = :id AND revoked_at IS NULL', {
      at,
      reason,
      id,
    });
  }

  /**
   * Revoke every live session for a user.
   *
   * @param exceptSessionId keep this one session alive. `null` and `undefined`
   *   both mean "revoke all", so a caller cannot accidentally preserve a
   *   session by passing a nullish value that meant the opposite.
   */
  revokeAllForUser(userId: string, reason: string, at: Instant = now(), exceptSessionId?: string | null): number {
    if (exceptSessionId === null || exceptSessionId === undefined) {
      return this.db.exec(
        'UPDATE sessions SET revoked_at = :at, revoked_reason = :reason WHERE user_id = :user_id AND revoked_at IS NULL',
        { at, reason, user_id: userId },
      ).changes;
    }
    return this.db.exec(
      'UPDATE sessions SET revoked_at = :at, revoked_reason = :reason WHERE user_id = :user_id AND revoked_at IS NULL AND id <> :keep',
      { at, reason, user_id: userId, keep: exceptSessionId },
    ).changes;
  }

  listActive(userId: string, at: Instant = now()): SessionRow[] {
    return this.db.all<SessionRow>(
      'SELECT * FROM sessions WHERE user_id = :user_id AND revoked_at IS NULL AND expires_ms > :now ORDER BY last_seen_ms DESC',
      { user_id: userId, now: toEpochMs(at) },
    );
  }

  /** Housekeeping: drop sessions that expired long ago. */
  purgeExpired(olderThanDays = 30, at: Instant = now()): number {
    const cutoff = toEpochMs(addSeconds(at, -olderThanDays * 86_400));
    return this.db.exec('DELETE FROM sessions WHERE expires_ms < :cutoff', { cutoff }).changes;
  }

  static verifyCsrf(session: SessionRow, presented: string | null | undefined): boolean {
    if (typeof presented !== 'string' || presented.length === 0) return false;
    return safeEqual(session.csrf_token, presented);
  }
}

/** Cookie serialisation without a cookie library: small and auditable. */
export function serialiseCookie(
  name: string,
  value: string,
  options: {
    maxAgeSeconds?: number;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None';
    expires?: Date;
  } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (key === '') continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

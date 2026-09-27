/**
 * Input validation primitives shared by the HTTP layer and the domain.
 *
 * Kept in the domain core (rather than inline in route handlers) so that the
 * same rule cannot be enforced in one place and forgotten in another, and so
 * the rules are unit-testable without spinning up a server.
 */

import { isValidTimeZone } from './time.ts';

/**
 * URL policy.
 *
 * Only http/https are accepted: `javascript:`, `data:` and `file:` URLs in a
 * repository field are the classic stored-XSS vector when rendered into an
 * `href`. Hostnames must be syntactically valid and must not carry credentials.
 */
export type UrlValidation = { valid: true; url: string } | { valid: false; reason: string };

export function validateHttpUrl(input: string, options: { allowPrivateHosts?: boolean } = {}): UrlValidation {
  const raw = input.trim();
  if (raw === '') return { valid: false, reason: 'URL is empty' };
  if (raw.length > 2048) return { valid: false, reason: 'URL exceeds 2048 characters' };
  if (/[\s<>"'`\\]/.test(raw)) return { valid: false, reason: 'URL contains whitespace or control characters' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, reason: 'URL is not parseable' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: `Only http and https URLs are accepted (received ${parsed.protocol})` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { valid: false, reason: 'URLs must not embed credentials' };
  }
  if (!parsed.hostname) return { valid: false, reason: 'URL has no host' };
  if (!/^[a-z0-9.-]+$/i.test(parsed.hostname) && parsed.hostname !== '[::1]') {
    return { valid: false, reason: 'URL hostname contains invalid characters' };
  }
  if (parsed.hostname.includes('..')) {
    return { valid: false, reason: 'URL hostname contains an empty label' };
  }
  if (!options.allowPrivateHosts && isPrivateHostname(parsed.hostname)) {
    return { valid: false, reason: 'URL points at a private, loopback or link-local address' };
  }
  return { valid: true, url: parsed.toString() };
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe80:/i.test(host)) return true;
  return false;
}

/** Reject control characters and NUL bytes in free text. */
export function containsControlCharacters(input: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(input);
}

export function validatePlainText(input: string, options: { field: string; min?: number; max?: number }): string {
  const value = input.trim();
  if (containsControlCharacters(value)) {
    throw new ValidationError(`${options.field} contains control characters`);
  }
  if (value.length < (options.min ?? 0)) {
    throw new ValidationError(`${options.field} must be at least ${options.min ?? 0} characters`);
  }
  if (value.length > (options.max ?? 10_000)) {
    throw new ValidationError(`${options.field} must be at most ${options.max ?? 10_000} characters`);
  }
  return value;
}

export class ValidationError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly issues: { field: string; message: string }[];

  constructor(issues: { field: string; message: string }[] | string, field = 'input') {
    super(typeof issues === 'string' ? issues : issues.map((i) => `${i.field}: ${i.message}`).join('; '));
    this.name = 'ValidationError';
    this.issues = typeof issues === 'string' ? [{ field, message: issues }] : issues;
  }
}

export function validateEmail(input: string): string {
  const value = input.trim().toLowerCase();
  if (value.length < 6 || value.length > 254) throw new ValidationError('email must be between 6 and 254 characters', 'email');
  // Deliberately conservative: one @, no whitespace, a dotted domain, no
  // consecutive dots. We do not attempt RFC 5322 completeness.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) {
    throw new ValidationError('email is not a valid address', 'email');
  }
  if (value.includes('..')) throw new ValidationError('email contains consecutive dots', 'email');
  return value;
}

export function validateUsername(input: string): string {
  const value = input.trim();
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{1,30})[a-zA-Z0-9]$/.test(value)) {
    throw new ValidationError(
      'username must be 3-32 characters, start and end alphanumeric, and contain only letters, digits, underscore or hyphen',
      'username',
    );
  }
  return value.toLowerCase();
}

export function validateTimeZoneName(input: string): string {
  if (!isValidTimeZone(input)) throw new ValidationError(`Unknown IANA timezone: ${input}`, 'timezone');
  return input;
}

export type PasswordQuality = { ok: true } | { ok: false; problems: string[] };

/**
 * Password policy. Length is the dominant factor, so the minimum is 12
 * characters rather than a complexity maze; composition rules are limited to
 * rejecting values that are trivially guessable.
 */
export function assessPassword(password: string, context: { email?: string; username?: string } = {}): PasswordQuality {
  const problems: string[] = [];
  if (password.length < 12) problems.push('must be at least 12 characters');
  if (password.length > 200) problems.push('must be at most 200 characters');
  if (containsControlCharacters(password)) problems.push('must not contain control characters');
  const lower = password.toLowerCase();
  if (context.email) {
    const local = context.email.split('@')[0] ?? '';
    if (local.length >= 3 && lower.includes(local.toLowerCase())) problems.push('must not contain your email address');
  }
  if (context.username && context.username.length >= 3 && lower.includes(context.username.toLowerCase())) {
    problems.push('must not contain your username');
  }
  const common = ['password', 'qwerty', 'letmein', 'welcome', 'admin123', 'iloveyou', '123456789012', 'hackathon'];
  if (common.some((c) => lower.includes(c))) problems.push('is too common');
  if (new Set(password).size < 5) problems.push('must use at least 5 distinct characters');
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

const SLUG_SAFE = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;

export function validateSlug(input: string, field = 'slug'): string {
  const value = input.trim().toLowerCase();
  if (!SLUG_SAFE.test(value)) {
    throw new ValidationError(
      `${field} must be 3-64 lowercase characters using letters, digits, dot, underscore or hyphen`,
      field,
    );
  }
  return value;
}

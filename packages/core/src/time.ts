/**
 * Canonical time strategy (spec §10).
 *
 * Verdict stores and compares every instant in UTC, as an ISO-8601 string with
 * an explicit `Z` suffix, plus an integer epoch-millisecond column for sorting
 * and range queries. Deadlines are *server-authoritative*: a browser never
 * decides whether a submission is late.
 *
 * Rules:
 *  - All persisted timestamps are `YYYY-MM-DDTHH:MM:SS.sssZ`.
 *  - Organizers input wall-clock local time together with an IANA timezone;
 *    the API converts to UTC on write. The stored event keeps both the UTC
 *    instant and the original zone so the UI can render "as entered".
 *  - Comparisons happen in epoch milliseconds.
 *  - Naive datetimes without a zone are rejected, not guessed.
 */

export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type Instant = string;

export class TimeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeValidationError';
  }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Format epoch milliseconds as a canonical UTC ISO-8601 instant. */
export function toInstant(epochMs: number): Instant {
  if (!Number.isFinite(epochMs)) throw new TimeValidationError('Invalid epoch milliseconds');
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) throw new TimeValidationError('Invalid date');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}Z`
  );
}

/** Current time as a canonical instant. Injected in tests for determinism. */
export function now(): Instant {
  return toInstant(Date.now());
}

/** Parse a canonical instant; throws on anything ambiguous. */
export function parseInstant(value: string): Instant {
  if (!ISO_UTC_PATTERN.test(value)) {
    throw new TimeValidationError(
      `Timestamp must be UTC ISO-8601 with Z suffix (e.g. 2026-03-01T09:00:00.000Z), received: ${value}`,
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new TimeValidationError(`Unparseable timestamp: ${value}`);
  return toInstant(ms);
}

export function isValidInstant(value: unknown): value is Instant {
  return typeof value === 'string' && ISO_UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

export function toEpochMs(value: Instant): number {
  return Date.parse(parseInstant(value));
}

export function instantFromEpoch(epochMs: number | null | undefined): Instant | null {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return null;
  return toInstant(epochMs);
}

/* --------------------------------------------------------- IANA zones */

const ZONE_CACHE = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = ZONE_CACHE.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new TimeValidationError(`Unknown IANA timezone: ${timeZone}`);
  }
  ZONE_CACHE.set(timeZone, formatter);
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    zoneFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Offset in minutes (east positive) for a zone at a given instant. */
function zoneOffsetMinutes(timeZone: string, epochMs: number): number {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(epochMs));
  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type === 'literal') continue;
    lookup[part.type] = Number.parseInt(part.value, 10);
  }
  const asUtc = Date.UTC(
    lookup.year as number,
    (lookup.month as number) - 1,
    lookup.day as number,
    (lookup.hour as number) % 24,
    lookup.minute as number,
    lookup.second as number,
  );
  return Math.round((asUtc - epochMs) / 60000);
}

/**
 * Convert a *naive local* wall-clock time in a named IANA zone to a UTC instant.
 *
 * Handles the two pathological cases honestly:
 *  - Spring-forward gaps: a local time that does not exist is shifted forward
 *    by the gap (documented behaviour, and surfaced to organizers).
 *  - Autumn-back overlaps: the earlier (first) occurrence is chosen.
 */
export function localWallClockToInstant(local: string, timeZone: string): Instant {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!match) {
    throw new TimeValidationError(
      `Local datetime must look like 2026-03-01T09:00 (no offset, no Z), received: ${local}`,
    );
  }
  const [, y, mo, d, h, mi, s] = match;
  const naiveUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? '0'),
  );
  // First pass with the offset at the naive instant, then correct once — the
  // standard two-pass approach used by date libraries.
  let guessOffset = zoneOffsetMinutes(timeZone, naiveUtc);
  let candidate = naiveUtc - guessOffset * 60000;
  guessOffset = zoneOffsetMinutes(timeZone, candidate);
  candidate = naiveUtc - guessOffset * 60000;
  return toInstant(candidate);
}

/** Render a UTC instant as wall-clock time in a zone (for "as entered" display). */
export function instantToLocalWallClock(instant: Instant, timeZone: string): string {
  const ms = toEpochMs(instant);
  const offset = zoneOffsetMinutes(timeZone, ms);
  const shifted = new Date(ms + offset * 60000);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

/* --------------------------------------------------------- comparisons */

export function compare(a: Instant, b: Instant): number {
  const da = toEpochMs(a);
  const db = toEpochMs(b);
  return da === db ? 0 : da < db ? -1 : 1;
}

export function isBefore(a: Instant, b: Instant): boolean {
  return compare(a, b) < 0;
}

export function isAfter(a: Instant, b: Instant): boolean {
  return compare(a, b) > 0;
}

/** Inclusive-start, exclusive-end window test. */
export function isWithin(instant: Instant, start: Instant | null, end: Instant | null): boolean {
  if (start !== null && compare(instant, start) < 0) return false;
  if (end !== null && compare(instant, end) >= 0) return false;
  return true;
}

export type DeadlineVerdict = {
  open: boolean;
  /** Human-readable reason, always populated so the API can explain refusals. */
  reason: string;
  /** Which boundary closed the window, if any. */
  boundary: 'BEFORE_START' | 'AFTER_END' | null;
};

/**
 * Server-authoritative deadline evaluation.
 * Windows are inclusive of the start instant and exclusive of the end instant.
 */
export function evaluateDeadline(
  at: Instant,
  window: { opensAt: Instant | null; closesAt: Instant | null },
): DeadlineVerdict {
  if (window.opensAt !== null && compare(at, window.opensAt) < 0) {
    return { open: false, reason: `This window has not opened yet (opens ${window.opensAt}).`, boundary: 'BEFORE_START' };
  }
  if (window.closesAt !== null && compare(at, window.closesAt) >= 0) {
    return { open: false, reason: `This window closed at ${window.closesAt}.`, boundary: 'AFTER_END' };
  }
  return { open: true, reason: 'Open', boundary: null };
}

/** Whole days between two instants, rounded up, for "days remaining" UI. */
export function daysBetween(from: Instant, to: Instant): number {
  const ms = toEpochMs(to) - toEpochMs(from);
  return Math.ceil(ms / 86_400_000);
}

export function addSeconds(instant: Instant, seconds: number): Instant {
  return toInstant(toEpochMs(instant) + seconds * 1000);
}

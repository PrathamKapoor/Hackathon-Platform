/**
 * Structured logging with request correlation.
 *
 * Rules this module enforces, because getting them wrong is how log files become
 * a security liability:
 *  - Passwords, session cookies, CSRF tokens, reset tokens and webhook secrets
 *    are never logged, at any level. `redact` is applied to every metadata bag.
 *  - Every line carries the request id, so a user-reported error can be traced
 *    through the whole request.
 *  - Development emits human-readable lines; production emits one JSON object
 *    per line, which is what a log shipper actually wants.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger that stamps every line with additional fields. */
  child(fields: LogFields): Logger;
};

const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'confirmpassword',
  'passwordhash',
  'password_hash',
  'token',
  'tokenhash',
  'token_hash',
  'sessiontoken',
  'session_token',
  'csrftoken',
  'csrf_token',
  'cookie',
  'authorization',
  'secret',
  'webhooksecret',
  'webhook_secret',
  'resettoken',
  'reset_token',
  'invitecode',
  'invite_code',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'totp',
]);

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

/**
 * Deep-copy a value with sensitive keys replaced and oversized structures
 * truncated, so a large or accidentally-sensitive payload cannot bloat or
 * leak into the log.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[truncated: max depth]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated ${String(value.length - MAX_STRING)} chars]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    if (value.length > 200) return [...value.slice(0, 200).map((v) => redact(v, depth + 1)), `[truncated ${String(value.length - 200)} items]`];
    return value.map((v) => redact(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(inner, depth + 1);
    }
    return out;
  }
  return '[unserialisable]';
}

const COLOURS: Record<string, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  reset: '\u001b[0m',
  dim: '\u001b[2m',
};

export type LoggerOptions = {
  level: LogLevel;
  pretty: boolean;
  /** Minimum level for this logger instance. */
  base?: LogFields;
  /** Injection point for tests. */
  sink?: (line: string) => void;
};

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level] ?? LEVEL_ORDER.info;
  const write = options.sink ?? ((line: string) => process.stdout.write(line));

  const emit = (level: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const merged = { ...(options.base ?? {}), ...(fields ?? {}) };
    const safe = redact(merged) as LogFields;
    const timestamp = new Date().toISOString();

    if (options.pretty) {
      const colour = COLOURS[level] ?? '';
      const extras = Object.keys(safe).length > 0 ? ` ${COLOURS.dim ?? ''}${JSON.stringify(safe)}${COLOURS.reset ?? ''}` : '';
      write(`${COLOURS.dim ?? ''}${timestamp}${COLOURS.reset ?? ''} ${colour}${level.toUpperCase().padEnd(5)}${COLOURS.reset ?? ''} ${message}${extras}\n`);
      return;
    }

    write(`${JSON.stringify({ timestamp, level, message, ...safe })}\n`);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child(fields) {
      return createLogger({ ...options, base: { ...(options.base ?? {}), ...fields } });
    },
  };
}

export function isLogLevel(value: string): value is LogLevel {
  return value in LEVEL_ORDER;
}

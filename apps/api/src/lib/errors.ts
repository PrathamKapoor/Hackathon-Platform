/**
 * The application's error vocabulary.
 *
 * Every error the API returns to a client is an `ApiError` with a stable machine
 * code, an HTTP status, and a message written for the person reading it. That
 * last part is a deliberate product decision: an organizer who trips a
 * deadline should be told *why* and *what to do*, not handed `{"error":true}`.
 *
 * Unexpected errors are never forwarded. They are logged with their stack and
 * replaced with a generic message plus the request id, so an internal failure
 * cannot leak a table name, a file path or a stack trace to a stranger.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_SUSPENDED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'ILLEGAL_TRANSITION'
  | 'DEADLINE_PASSED'
  | 'WINDOW_CLOSED'
  | 'IMMUTABLE'
  | 'CONFLICT_OF_INTEREST'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'CSRF_FAILED'
  | 'ORIGIN_REJECTED'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL_ERROR'
  | 'NOT_IMPLEMENTED'
  | 'SERVICE_UNAVAILABLE';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  ACCOUNT_SUSPENDED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  ILLEGAL_TRANSITION: 409,
  DEADLINE_PASSED: 409,
  WINDOW_CLOSED: 409,
  IMMUTABLE: 409,
  CONFLICT_OF_INTEREST: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  CSRF_FAILED: 403,
  ORIGIN_REJECTED: 403,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  SERVICE_UNAVAILABLE: 503,
};

export type ApiErrorDetail = {
  field?: string;
  issue?: string;
  /** Machine-readable extras, e.g. the legal target states of a transition. */
  [key: string]: unknown;
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ApiErrorDetail[];
  readonly expose: boolean;
  /** Extra response headers, e.g. `Retry-After` on a rate limit. */
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: ApiErrorDetail[]; headers?: Record<string, string>; cause?: unknown; expose?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] ?? 500;
    this.details = options.details ?? [];
    this.headers = options.headers ?? {};
    // 5xx messages are replaced before they leave the process, so a 500 can
    // never accidentally carry internal detail.
    this.expose = options.expose ?? this.status < 500;
  }

  toBody(requestId: string): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.expose ? this.message : 'An unexpected error occurred. Quote the reference below when reporting it.',
        requestId,
        ...(this.details.length > 0 ? { details: this.details } : {}),
      },
    };
  }
}

export const errors = {
  badRequest: (message: string, details?: ApiErrorDetail[]) => new ApiError('BAD_REQUEST', message, details ? { details } : {}),
  validation: (message: string, details?: ApiErrorDetail[]) => new ApiError('VALIDATION_FAILED', message, details ? { details } : {}),
  unauthenticated: (message = 'Sign in to continue.') => new ApiError('UNAUTHENTICATED', message),
  invalidCredentials: (message = 'That email and password combination is not correct.') =>
    new ApiError('INVALID_CREDENTIALS', message),
  accountLocked: (message: string) => new ApiError('ACCOUNT_LOCKED', message, { headers: { 'retry-after': '900' } }),
  accountSuspended: (message = 'This account has been suspended. Contact an administrator.') =>
    new ApiError('ACCOUNT_SUSPENDED', message),
  forbidden: (message = 'You do not have permission to perform this action.', details?: ApiErrorDetail[]) =>
    new ApiError('FORBIDDEN', message, details ? { details } : {}),
  notFound: (resource: string, id?: string) =>
    new ApiError('NOT_FOUND', id ? `${resource} "${id}" was not found.` : `${resource} was not found.`),
  conflict: (message: string, details?: ApiErrorDetail[]) => new ApiError('CONFLICT', message, details ? { details } : {}),
  illegalTransition: (message: string, details?: ApiErrorDetail[]) => new ApiError('ILLEGAL_TRANSITION', message, details ? { details } : {}),
  deadlinePassed: (message: string) => new ApiError('DEADLINE_PASSED', message),
  windowClosed: (message: string) => new ApiError('WINDOW_CLOSED', message),
  immutable: (message: string) => new ApiError('IMMUTABLE', message),
  conflictOfInterest: (message: string, details?: ApiErrorDetail[]) => new ApiError('CONFLICT_OF_INTEREST', message, details ? { details } : {}),
  preconditionFailed: (message: string, details?: ApiErrorDetail[]) => new ApiError('PRECONDITION_FAILED', message, details ? { details } : {}),
  payloadTooLarge: (message: string) => new ApiError('PAYLOAD_TOO_LARGE', message),
  unsupportedMedia: (message: string) => new ApiError('UNSUPPORTED_MEDIA_TYPE', message),
  rateLimited: (message: string, retryAfterSeconds: number) =>
    new ApiError('RATE_LIMITED', message, { headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))) } }),
  csrfFailed: (message = 'Your session could not be verified. Refresh the page and try again.') => new ApiError('CSRF_FAILED', message),
  originRejected: (message = 'This request came from an unrecognised origin.') => new ApiError('ORIGIN_REJECTED', message),
  internal: (message = 'Internal error', cause?: unknown) => new ApiError('INTERNAL_ERROR', message, { cause, expose: false }),
  notImplemented: (message: string) => new ApiError('NOT_IMPLEMENTED', message),
  unavailable: (message: string) => new ApiError('SERVICE_UNAVAILABLE', message),
};

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Translate a domain-core error into an API error.
 *
 * The domain core throws rich, human-readable errors (illegal transitions,
 * rubric validation, CSV problems) that must not reach the client as 500s. This
 * is the single place that mapping lives, so a new domain error cannot leak a
 * stack trace by being forgotten.
 */
export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error;

  if (error instanceof Error) {
    if (error.name === 'TransitionError') {
      return new ApiError('ILLEGAL_TRANSITION', error.message, { details: [{ issue: error.message }] });
    }
    if (error.name === 'RubricValidationError') {
      const issues = (error as Error & { issues?: string[] }).issues ?? [];
      return new ApiError('VALIDATION_FAILED', error.message, {
        details: issues.map((issue) => ({ field: 'rubric', issue })),
      });
    }
    if (error.name === 'ValidationError' || error.name === 'CsvParseError' || error.name === 'TimeValidationError') {
      const issues = (error as Error & { issues?: { field: string; message: string }[] }).issues;
      return new ApiError('VALIDATION_FAILED', error.message, {
        details: issues?.map((i) => ({ field: i.field, issue: i.message })),
      });
    }
    if (error.name === 'ScoreOutOfRangeError') {
      // A judge typed or sent a value the slider could not produce. Name the
      // criterion and both bounds so the client can correct the field without
      // guessing — and so this stays a 422 rather than becoming an alert.
      const detail = error as Error & { field?: string; min?: number; max?: number; received?: number };
      const issue = Number.isFinite(detail.received ?? Number.NaN)
        ? `must be between ${String(detail.min)} and ${String(detail.max)}, received ${String(detail.received)}`
        : `must be a finite number between ${String(detail.min)} and ${String(detail.max)}`;
      return new ApiError('VALIDATION_FAILED', error.message, {
        details: [{ field: detail.field ?? 'criterion', issue }],
      });
    }
    if (error.name === 'TypeError') {
      // A TypeError from the domain usually means a malformed identifier.
      return new ApiError('BAD_REQUEST', error.message);
    }

    /*
     * Request schemas are validated by calling `.parse()` inside the handler,
     * so a bad body arrives here as a ZodError. Without this branch it fell
     * through to INTERNAL_ERROR, which meant a client that sent a slightly
     * wrong value — a misspelled state name, say — got a 500 and tripped the
     * error alerting during a live event. It is a client mistake, and it should
     * say which field was wrong.
     *
     * Fastify's own schema validation produces a ValidationError-shaped object
     * with a `validation` array, and deserves the same treatment.
     */
    const zodIssues = (error as { issues?: unknown }).issues;
    if (error.name === 'ZodError' && Array.isArray(zodIssues)) {
      return new ApiError('VALIDATION_FAILED', 'The request body did not match the expected shape.', {
        details: zodIssues.map((issue) => {
          const record = issue as { path?: unknown[]; message?: string };
          const field = Array.isArray(record.path) && record.path.length > 0 ? record.path.join('.') : 'body';
          return { field, issue: record.message ?? 'invalid value' };
        }),
      });
    }
    const fastifyValidation = (error as { validation?: unknown }).validation;
    if (Array.isArray(fastifyValidation) && fastifyValidation.length > 0) {
      return new ApiError('VALIDATION_FAILED', 'The request did not match the expected shape.', {
        details: fastifyValidation.map((issue) => {
          const record = issue as { params?: { missingProperty?: string }; message?: string };
          return { field: record.params?.missingProperty ?? 'request', issue: record.message ?? 'invalid value' };
        }),
      });
    }

    /*
     * Fastify's own request-level failures, which arrive as errors with a
     * `code` and no HTTP status of their own. Without this they fall through to
     * INTERNAL_ERROR, so a client that sent truncated JSON or an oversized body
     * got a 500 — reported to the operator as a server fault when the server did
     * exactly the right thing by refusing it.
     */
    const fastifyCode = (error as { code?: unknown }).code;
    /*
     * Both prefixes, not just `FST_ERR_`.
     *
     * `@fastify/multipart` reports an oversized upload as `FST_REQ_FILE_TOO_LARGE`
     * and too many parts as `FST_FILES_LIMIT` - the `FST_REQ_` family, not
     * `FST_ERR_`. The check below only recognised the latter, so every rejected
     * upload fell through to INTERNAL_ERROR: a 500, a stack trace in the log,
     * "An unexpected error occurred" to the caller, and a page on the operator's
     * alerting dashboard for what was a client mistake. The route even
     * documented `PAYLOAD_TOO_LARGE` as a possible outcome, so the document and
     * the behaviour disagreed in the worst possible direction: the response
     * promised a 413 that could never be returned.
     */
    const isFastifyCode = typeof fastifyCode === 'string' && (fastifyCode.startsWith('FST_ERR_') || fastifyCode.startsWith('FST_REQ_'));
    if (isFastifyCode) {
      const bodyTooLarge =
        fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
        fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE_FOR_JSON' ||
        fastifyCode === 'FST_ERR_REQ_BODY_TOO_LARGE' ||
        // The multipart family, from @fastify/multipart.
        fastifyCode === 'FST_REQ_FILE_TOO_LARGE' ||
        fastifyCode === 'FST_FILES_LIMIT';
      if (bodyTooLarge) {
        return new ApiError('PAYLOAD_TOO_LARGE', 'That request body is larger than this instance accepts.');
      }

      const badJson =
        fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
        fastifyCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
        fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
      if (badJson) {
        return new ApiError('BAD_REQUEST', 'The request body could not be read as JSON.');
      }

      if (fastifyCode === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH') {
        return new ApiError('BAD_REQUEST', 'The Content-Length header did not match the body received.');
      }

      /*
       * Anything else from these two families is a malformed or unsupported
       * *request*, not a fault in the server, and saying so is the difference
       * between a 400 the caller can act on and a 500 that pages somebody.
       *
       * This was found by asking for an upload with no file part: multipart
       * raises a code outside the list above, it fell through, and the caller
       * got "an unexpected error occurred" for the most ordinary mistake in the
       * API. Fastify and its plugins reserve these prefixes for request
       * validation, so anything unrecognised in them is a 4xx by construction.
       */
      return new ApiError('BAD_REQUEST', 'The request body could not be read as multipart/form-data.');
    }
  }

  return new ApiError('INTERNAL_ERROR', 'Internal error', { cause: error, expose: false });
}

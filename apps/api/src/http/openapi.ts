/**
 * OpenAPI 3.1 document generation.
 *
 * The document is derived from the same Zod schemas that validate requests at
 * runtime, so documentation and behaviour cannot diverge. There is no
 * hand-written spec file to fall out of date.
 */

import { z } from 'zod';
import type { RouteRegistry, RouteDoc } from './context.ts';
import { RESOURCES, ACTIONS } from '../lib/rbac.ts';
import { AUDIT_ACTIONS, NORMALIZATION_METHODS, AGGREGATION_METHODS, STATE_LABELS } from '@verdict/core/types';
import { describeMachine, MACHINES } from '@verdict/core/state-machines';
import { THRESHOLDS } from '@verdict/core/diagnostics';
import { configForMethod } from '@verdict/core/normalization';

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: ZodLike, io: 'input' | 'output'): JsonSchema | null {
  try {
    return z.toJSONSchema(schema as never, { io, unrepresentable: 'any', cycles: 'ref' }) as JsonSchema;
  } catch {
    // A schema that cannot be expressed in JSON Schema still validates at
    // runtime; omit it from the document rather than failing the whole build.
    return null;
  }
}

type ZodLike = z.ZodType;

const ERROR_SCHEMA = z
  .object({
    error: z.object({
      code: z.string().describe('Stable machine-readable error code.'),
      message: z.string().describe('Human-readable explanation, written for the person reading it.'),
      requestId: z.string().describe('Correlates this response with the server logs.'),
      details: z
        .array(
          z.object({
            field: z.string().optional(),
            issue: z.string().optional(),
          }),
        )
        .optional()
        .describe('Field-level problems, present for validation and permission failures.'),
    }),
  })
  .meta({ id: 'Error' });

const PAGE_META = {
  type: 'object',
  required: ['page', 'perPage', 'total', 'totalPages', 'hasMore'],
  properties: {
    page: { type: 'integer', minimum: 1 },
    perPage: { type: 'integer', minimum: 1, maximum: 200 },
    total: { type: 'integer', minimum: 0 },
    totalPages: { type: 'integer', minimum: 0 },
    hasMore: { type: 'boolean' },
  },
} as const;

const PAGINATION_QUERY = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe('1-based page number.'),
    perPage: z.coerce.number().int().min(1).max(200).default(25).describe('Items per page, maximum 200.'),
  })
  .meta({ id: 'PaginationQuery' });

const REQUEST_ID_PARAM = {
  name: 'requestId',
  in: 'header',
  required: false,
  schema: { type: 'string' },
  description: 'Optional client-supplied correlation id, echoed in the response and in the audit ledger.',
} as const;

function statusForError(code: string): number {
  const map: Record<string, number> = {
    BAD_REQUEST: 400,
    VALIDATION_FAILED: 422,
    UNAUTHENTICATED: 401,
    INVALID_CREDENTIALS: 401,
    ACCOUNT_LOCKED: 423,
    ACCOUNT_SUSPENDED: 403,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
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
  return map[code] ?? 500;
}

export type OpenApiOptions = {
  registry: RouteRegistry;
  version: string;
  serverUrl: string;
  title?: string;
};

export function buildOpenApiDocument(options: OpenApiOptions): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};

  const errorSchema = toJsonSchema(ERROR_SCHEMA, 'output');
  if (errorSchema) schemas.Error = errorSchema;
  const paginationSchema = toJsonSchema(PAGINATION_QUERY, 'input');
  if (paginationSchema) schemas.PaginationQuery = paginationSchema;

  /*
   * `published()`, not `all()`. A route registered with `hidden: true` carries a
   * comment saying it should be kept out of the published document, and the
   * generator ignored that entirely - so the health and readiness probes
   * appeared in the spec despite being marked hidden, and `published()` was dead
   * code. The code's stated intent and the generator now agree.
   */
  for (const route of options.registry.published()) {
    const entry = paths[route.path] ?? {};
    const successStatus = route.success ?? 200;
    const successDescription =
      successStatus === 201
        ? 'Created'
        : successStatus === 202
          ? 'Accepted'
          : successStatus === 204
            ? 'No content'
            : 'Success';
    const operation: Record<string, unknown> = {
      operationId: operationIdFor(route),
      tags: route.tags,
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      parameters: [REQUEST_ID_PARAM],
      responses: {},
      security: route.auth === 'none' ? [] : [{ sessionCookie: [] }],
    };

    if (route.description === undefined && route.summary.includes('—')) {
      // keep summary-only routes tidy
    }

    // Path parameters are always present; body/query come from Zod.
    const pathParams = extractPathParams(route.path);
    operation.parameters = [
      REQUEST_ID_PARAM,
      ...pathParams.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: `Identifier of the ${name.replace(/Id$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()}.`,
      })),
    ];

    if (route.params) {
      const schema = toJsonSchema(route.params, 'input');
      if (schema) {
        operation.parameters = [
          ...(operation.parameters as unknown[]),
          {
            name: 'params',
            in: 'query',
            required: false,
            schema,
            description: 'Path parameters, described here for tooling that cannot introspect the path template.',
          },
        ];
      }
    }

    if (route.querystring) {
      /*
       * Expanded into one parameter per property.
       *
       * It used to be emitted as a single parameter literally named `query`,
       * carrying an object schema. No OpenAPI tooling reads that as individual
       * query parameters, so the effect was that the filters, sorts, status
       * values and date ranges on roughly fifteen endpoints were documented
       * nowhere - and `GET /api/events` was the only operation in the whole
       * document with any query parameters at all, despite being the only route
       * that happened to declare its schema inline.
       */
      const schema = toJsonSchema(route.querystring, 'input');
      if (schema !== null && typeof schema === 'object' && schema !== null && 'properties' in schema) {
        const properties = (schema as { properties?: Record<string, unknown>; required?: string[] }).properties ?? {};
        const required = new Set((schema as { required?: string[] }).required ?? []);
        for (const [name, propertySchema] of Object.entries(properties)) {
          operation.parameters = [
            ...(operation.parameters as unknown[]),
            {
              name,
              in: 'query',
              required: required.has(name),
              schema: propertySchema as Record<string, unknown>,
              ...(typeof propertySchema === 'object' && propertySchema !== null && 'description' in propertySchema
                ? { description: (propertySchema as { description: string }).description }
                : {}),
            },
          ];
        }
      }
    }

    if (route.multipart === true) {
      /*
       * A file upload has no useful JSON Schema - it is a binary part - so the
       * route declares `multipart: true` and the shape is written out here.
       * Without this the upload endpoint had no documented request body at all,
       * despite requiring a `file` part.
       */
      operation.requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: {
                file: {
                  type: 'string',
                  format: 'binary',
                  description: 'PNG, JPEG, WEBP or GIF. SVG is refused. The declared type, the extension and the file\'s magic bytes must all agree.',
                },
              },
            },
          },
        },
      };
    } else if (route.body) {
      const schema = toJsonSchema(route.body, 'input');
      if (schema) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema } },
        };
      }
    }

    if (route.response) {
      const schema = toJsonSchema(route.response, 'output');
      const responses = operation.responses as Record<string, unknown>;
      if (schema) {
        responses[String(successStatus)] = {
          description: successDescription,
          content: { 'application/json': { schema } },
        };
      } else {
        responses[String(successStatus)] = { description: successDescription };
      }
    } else {
      /*
       * The status comes from the route, not from whether it happened to declare
       * a response schema. See `RouteDoc.success`.
       */
      (operation.responses as Record<string, unknown>)[String(successStatus)] = { description: successDescription };
    }

    const responses = operation.responses as Record<string, unknown>;
    const errorContent = errorSchema ? { content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } : {};
    for (const code of route.errors ?? []) {
      responses[String(statusForError(code))] = { description: describeError(code), ...errorContent };
    }
    if (!route.errors?.includes('UNAUTHENTICATED') && route.auth !== 'none') {
      responses['401'] = { description: 'Authentication required', ...errorContent };
    }
    if (!route.errors?.includes('FORBIDDEN') && route.auth !== 'none') {
      responses['403'] = { description: 'Authenticated but not permitted', ...errorContent };
    }
    if (!route.errors?.includes('RATE_LIMITED') && route.rateLimited !== false) {
      responses['429'] = { description: 'Rate limit exceeded', ...errorContent };
    }

    if (route.permission) {
      operation['x-verdict-permission'] = {
        resource: route.permission.resource,
        action: route.permission.action,
        description: `Enforced server-side against the RBAC matrix (${route.permission.resource}:${route.permission.action}).`,
      };
    }
    operation['x-verdict-auth'] = route.auth;

    /*
     * A GET that writes is worth saying out loud.
     *
     * Safe methods are supposed to be free of side effects, and the assumption
     * is load-bearing: it is why a client can prefetch, retry, or let a crawler
     * fetch a URL twice without thinking about it. The export endpoints are GET
     * and they do write, on purpose - an audit row and an `export_jobs` row, so
     * that "who exported this event's participant data, and when" has an answer.
     *
     * Emitting the flag keeps that promise honest. A consumer generating a client
     * can see which reads are really events, and a crawler can be configured not
     * to inflate the export log.
     */
    if (route.mutates) {
      operation['x-verdict-mutates'] = true;
      operation.description = `${route.description ?? ''}\n\n**This GET persists a record.** It writes an audit entry and an export history row. It is not safe to prefetch, retry freely, or fetch from a crawler.`.trim();
    }

    entry[route.method.toLowerCase()] = operation;
    paths[route.path] = entry;
  }

  // Surface the lifecycle and judging vocabulary in the document itself, so an
  // integrator can read the state machines without opening the source.
  schemas.StateMachines = {
    type: 'object',
    description: 'Legal lifecycle transitions. Anything not listed here is rejected with ILLEGAL_TRANSITION.',
    properties: Object.fromEntries(
      Object.keys(MACHINES).map((name) => [
        name,
        {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              reason: { type: 'string' },
              guarded: { type: 'boolean', description: 'True when a guard must also be satisfied (e.g. a deadline or an override).' },
            },
          },
          ...(describeMachine(name as keyof typeof MACHINES) as Record<string, unknown>),
        },
      ]),
    ),
  };

  schemas.NormalizationMethods = {
    type: 'string',
    enum: [...NORMALIZATION_METHODS],
    description:
      'RAW is the identity and the default. Z_SCORE standardises each judge against their own reviews. MIN_MAX maps each judge\'s observed range onto [0,50]. ROBUST_MAD is median/MAD based, outlier-resistant, and the recommended method for real panels. RANK is scale-free and discards magnitude.',
    default: 'RAW',
    'x-verdict-defaults': Object.fromEntries(
      NORMALIZATION_METHODS.map((method) => [method, configForMethod(method)]),
    ),
  };

  schemas.AggregationMethods = { type: 'string', enum: [...AGGREGATION_METHODS], default: 'MEAN' };
  schemas.StateLabels = { type: 'object', additionalProperties: { type: 'string' }, description: STATE_LABELS };
  schemas.PaginationMeta = PAGE_META;
  schemas.AuditActions = { type: 'string', enum: [...AUDIT_ACTIONS] };
  schemas.DiagnosticsThresholds = {
    type: 'object',
    description: 'Thresholds used by the diagnostic and anomaly engine. Signals are review prompts, never verdicts of guilt.',
    properties: Object.fromEntries(Object.entries(THRESHOLDS).map(([key, value]) => [key, { type: typeof value === 'number' ? 'number' : 'string', default: value }])),
  };
  schemas.AuthorizationMatrix = {
    type: 'object',
    description: 'The complete RBAC matrix. `null` means the action is never granted to that role.',
    properties: Object.fromEntries(
      ['PARTICIPANT', 'JUDGE', 'ORGANIZER', 'ADMIN'].map((role) => [
        role,
        {
          type: 'object',
          properties: Object.fromEntries(
            ACTIONS.map((action) => [
              action,
              {
                type: 'object',
                properties: Object.fromEntries(RESOURCES.map((resource) => [resource, { type: ['string', 'null'] }])),
              },
            ]),
          ),
        },
      ]),
    ),
  };

  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'Verdict API',
      version: options.version,
      summary: 'Hackathon operating system with a defensible, reproducible judging engine.',
      description: [
        'Every UI action in Verdict is available through this API; the web client calls these endpoints and never touches the database directly.',
        '',
        '## Authentication',
        'Local email + password. On sign-in the server sets an HttpOnly, SameSite=Lax session cookie and a readable CSRF cookie. Every state-changing request must echo the CSRF value in the `x-verdict-csrf` header and must come from the configured `PUBLIC_URL` origin.',
        '',
        '## Authorization',
        'The server is authoritative. The complete role matrix is published as `AuthorizationMatrix`, and each operation records the permission it enforces under `x-verdict-permission`.',
        '',
        '## Errors',
        'All errors share one envelope with a stable `code`, a message written for a human, and the `requestId` that appears in the server logs.',
        '',
        '## Reproducibility',
        'Judging is a pure function of (event, rubric version, assignment version, scores, normalization config, aggregation config). `POST /results/{id}/reproduce` recomputes a published snapshot from stored inputs and reports MATCH or a field-level diff.',
      ].join('\n'),
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
      contact: { name: 'Verdict' },
    },
    servers: [{ url: options.serverUrl, description: 'This deployment' }],
    tags: [
      { name: 'auth', description: 'Registration, sign-in, sessions, password lifecycle.' },
      { name: 'profile', description: 'The signed-in user\'s own profile and sessions.' },
      { name: 'events', description: 'Event lifecycle, tracks, prizes, public pages.' },
      { name: 'registration', description: 'Configurable application forms, decisions, bulk actions, CSV.' },
      { name: 'teams', description: 'Team formation, invitations, membership, overrides.' },
      { name: 'submissions', description: 'Drafts, versioning, deadline enforcement, the public gallery.' },
      { name: 'uploads', description: 'Screenshot and attachment uploads with type and size validation.' },
      { name: 'judges', description: 'Judge invitations, capacity, workload, conflicts.' },
      { name: 'assignments', description: 'Preview, commit, reassign; every strategy is seeded and reproducible.' },
      { name: 'rubrics', description: 'Versioned rubrics; versions are immutable once judging starts.' },
      { name: 'calibration', description: 'Calibration sessions and the resulting panel diagnostics.' },
      { name: 'scoring', description: 'Judge review queue, drafts, submission, pairwise comparisons.' },
      { name: 'normalization', description: 'Normalization runs and the raw-versus-normalized comparison.' },
      { name: 'diagnostics', description: 'Judge and project statistics, anomaly flags for organizer review.' },
      { name: 'results', description: 'Result runs, immutable snapshots, publication, reproduction.' },
      { name: 'community', description: 'Voting, comments, moderation and abuse signals.' },
      { name: 'certificates', description: 'Certificate issuance and public verification.' },
      { name: 'webhooks', description: 'Signed outbound webhooks and delivery history.' },
      { name: 'imports', description: 'Bulk CSV import with per-row validation.' },
      { name: 'exports', description: 'CSV/JSON export of every operational dataset.' },
      { name: 'audit', description: 'Append-only audit ledger.' },
      { name: 'admin', description: 'System overview, user management, health.' },
      { name: 'meta', description: 'Health, readiness, capabilities and the embedding script.' },
    ],
    paths: sortPaths(paths),
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'verdict_session',
          description: 'HttpOnly session cookie set by `POST /auth/login`. The readable `verdict_csrf` cookie must be echoed in the `x-verdict-csrf` header on state-changing requests.',
        },
      },
      schemas,
    },
  };
}

function extractPathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
}

function operationIdFor(route: RouteDoc): string {
  const path = route.path
    .replace(/\{(\w+)\}/g, 'By_$1')
    .split('/')
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${route.method.toLowerCase()}${path}`;
}

function describeError(code: string): string {
  const descriptions: Record<string, string> = {
    BAD_REQUEST: 'The request could not be understood.',
    VALIDATION_FAILED: 'One or more fields failed validation.',
    UNAUTHENTICATED: 'No valid session was presented.',
    INVALID_CREDENTIALS: 'Email or password is incorrect.',
    ACCOUNT_LOCKED: 'Too many failed attempts; try again later.',
    ACCOUNT_SUSPENDED: 'The account has been suspended.',
    FORBIDDEN: 'The role matrix does not grant this action to the caller.',
    NOT_FOUND: 'No such resource.',
    CONFLICT: 'The request conflicts with the current state.',
    ILLEGAL_TRANSITION: 'The requested lifecycle transition is not permitted.',
    DEADLINE_PASSED: 'The deadline has passed and the record is frozen.',
    WINDOW_CLOSED: 'The relevant window is closed.',
    IMMUTABLE: 'The record is immutable; create a correction instead.',
    CONFLICT_OF_INTEREST: 'A declared conflict of interest forbids this.',
    PRECONDITION_FAILED: 'A stated precondition does not hold.',
    PAYLOAD_TOO_LARGE: 'The request body or upload exceeds the configured limit.',
    UNSUPPORTED_MEDIA_TYPE: 'The content type is not accepted.',
    RATE_LIMITED: 'Too many requests.',
    CSRF_FAILED: 'The CSRF token is missing or does not match the session.',
    ORIGIN_REJECTED: 'The request origin is not the configured PUBLIC_URL.',
    INTERNAL_ERROR: 'Unexpected server error. Quote the requestId.',
    NOT_IMPLEMENTED: 'Not implemented.',
    SERVICE_UNAVAILABLE: 'A dependency is unavailable.',
  };
  return descriptions[code] ?? code;
}

/** Stable path ordering keeps regenerated documents diff-friendly. */
function sortPaths(paths: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const sorted: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(paths).sort()) sorted[key] = paths[key] as Record<string, unknown>;
  return sorted;
}

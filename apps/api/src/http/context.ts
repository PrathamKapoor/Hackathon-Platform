/**
 * HTTP plumbing: request context, authentication, authorization, CSRF, origin
 * checking, rate limiting, error rendering and the OpenAPI registry.
 *
 * The design rule for this layer: it *derives* context and *enforces* policy,
 * and it knows nothing about the domain. Every handler receives a
 * `RequestContext` that already has a verified actor, and every permission
 * check goes through `requirePermission`, which consults the single matrix in
 * `lib/rbac.ts`.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest, FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ZodType } from 'zod';
import { newId } from '@verdict/core/ids';
import { now, type Instant } from '@verdict/core/time';
import { ApiError, errors, isApiError, toApiError } from '../lib/errors.ts';
import type { Actor, Action, Ownership, Resource } from '../lib/rbac.ts';
import { can, NO_OWNERSHIP } from '../lib/rbac.ts';
import type { Role } from '@verdict/core/types';
import { SessionStore, parseCookies } from '../lib/session.ts';
import type { AppConfig } from '../config.ts';
import type { AuthService, RequestContext, UserRow } from '../lib/auth.ts';
import type { AuditLedger } from '../lib/audit.ts';
import type { Logger } from '../lib/logger.ts';

export type AppServices = {
  config: AppConfig;
  db: import('../db/database.ts').Database;
  auth: AuthService;
  audit: AuditLedger;
  logger: Logger;
  /** The full service container, so hooks can reach any service. */
  services: import('../services/context.ts').Services;
};

/**
 * `setCookie` / `clearCookie` come from `@fastify/cookie`, which is registered
 * in `buildApp`. Its `sameSite` option is lower-case ('lax'), which is why the
 * cookie call sites use string literals rather than the capitalised enum in
 * `lib/session.ts` — that module serialises headers by hand for the tests,
 * while the server path uses the plugin.
 */
declare module 'fastify' {
  interface FastifyInstance {
    services: AppServices;
  }
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

/* --------------------------------------------------------- request ids */

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

/**
 * The request id, honouring a caller-supplied one.
 *
 * Every operation in the published document advertised an optional `requestId`
 * header "echoed in the response and in the audit ledger", and the server
 * ignored the header completely - it generated its own id and never wrote one
 * back. A client relying on that could correlate nothing at all, which is the
 * opposite of the point.
 *
 * So the documented behaviour is now implemented rather than deleted: a caller
 * may supply `x-request-id`, it is accepted when it looks like an identifier and
 * bounded in length, and Fastify echoes it on the response. Anything that does
 * not look like an id is ignored rather than rejected, because refusing a
 * request over a malformed correlation id would be a denial of service for a
 * debugging aid. An unparseable value simply gets a generated id, so the
 * invariant is that a response always carries a request id the ledger shares.
 */
const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestIdFrom(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && REQUEST_ID_PATTERN.test(value)) return value;
  return newRequestId();
}

/* ------------------------------------------------------ context builder */

/**
 * Build the request context: resolve the session cookie to a user and an actor.
 *
 * Never throws. A missing or invalid session simply yields a null actor, and
 * the route's own permission check decides whether that is acceptable.
 */
export function buildContext(
  request: FastifyRequest,
  services: AppServices,
): RequestContext {
  const at = now();
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[services.config.session.cookieName];
  const ipAddress = clientIp(request, services.config);
  const userAgent = String(request.headers['user-agent'] ?? '').slice(0, 300);

  let session = null;
  let user: UserRow | null = null;

  if (token) {
    session = services.auth.sessions.resolve(token, {
      idleTimeoutDays: services.config.session.idleTimeoutDays,
      absoluteTimeoutDays: services.config.session.absoluteTimeoutDays,
    }, at);
    if (session !== null) {
      user = services.auth.findById(session.user_id);
      if (user === null) {
        // The account was deleted while the session lived on.
        services.auth.sessions.revoke(session.id, 'user no longer exists', at);
        session = null;
      }
    }
  }

  const actor = services.auth.buildActor(user);

  return {
    requestId: request.id,
    ipAddress,
    userAgent,
    session,
    user,
    actor,
    at,
  };
}

/**
 * Client IP.
 *
 * `X-Forwarded-For` is only consulted when the deployment explicitly trusts a
 * proxy. Blindly trusting it would let any client forge its own address and
 * defeat IP-based rate limiting, which is the entire reason that header exists
 * to be dangerous.
 */
export function clientIp(request: FastifyRequest, config: AppConfig): string {
  if (config.trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof header === 'string' && header.length > 0) {
      const first = header.split(',')[0]?.trim();
      if (first) return first.slice(0, 64);
    }
  }
  return request.ip.slice(0, 64);
}

/* ------------------------------------------------------------- cookies */

/** Shared cookie options, so every call site agrees on the flags. */
export function sessionCookieOptions(config: AppConfig, maxAgeSeconds: number) {
  return {
    path: '/',
    maxAge: maxAgeSeconds,
    secure: config.session.secureCookies,
    sameSite: 'lax' as const,
  };
}

export const CSRF_HEADER = 'x-verdict-csrf';

/* ------------------------------------------------------ authentication */

export function requireUser(ctx: RequestContext): NonNullable<RequestContext['user']> {
  if (ctx.user === null) throw errors.unauthenticated();
  return ctx.user;
}

export function requireActor(ctx: RequestContext): Actor {
  if (ctx.actor === null) throw errors.unauthenticated();
  return ctx.actor;
}

/**
 * The single authorization entry point.
 *
 * Throws a 403 with the full decision trail (which role was required and why it
 * was refused) so a developer can debug a permission problem from the response
 * alone, while the audit ledger records it for organizers.
 */
/**
 * The minimum a permission check needs. Taking a structural type rather than
 * the whole service container keeps route handlers free to pass `services`
 * directly without a cast at every call site.
 */
export type PermissionHost = {
  audit: AuditLedger;
  logger: Logger;
};

export function requirePermission(
  services: PermissionHost,
  ctx: RequestContext,
  resource: Resource,
  action: Action,
  ownership: Partial<Ownership> = {},
  audit?: { eventId?: string | null; resourceType?: string; resourceId?: string },
): Granted {
  // Partial ownership is merged over the all-false default, so a route states
  // only the fact it actually established rather than padding six booleans.
  const resolved: Ownership = { ...NO_OWNERSHIP, ...ownership };
  const decision = can(ctx.actor, resource, action, resolved);
  if (decision.allowed) {
    return { allowed: true, viaRole: decision.viaRole, reason: decision.reason };
  }

  services.audit.recordDenied({
    action: 'admin.override',
    actorId: ctx.actor?.id ?? null,
    actorRoles: ctx.actor?.roles ?? [],
    eventId: audit?.eventId ?? null,
    resourceType: audit?.resourceType ?? resource,
    resourceId: audit?.resourceId ?? '',
    requestId: ctx.requestId,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    reason: decision.reason,
    requiredRole: String(action),
    metadata: { attempted: `${action} ${resource}` },
    at: ctx.at,
  });

  /*
   * "Who are you?" and "you may not do that" are different answers, and clients
   * act on the difference: a 401 sends someone to sign in, a 403 sends them to
   * an error page. Collapsing both into 403 makes an expired session look like
   * a permissions problem, which is a genuinely confusing thing to hand a
   * participant during an event.
   *
   * Note the audit row above is written either way. An anonymous 403 is still
   * a probe worth recording.
   */
  if (ctx.actor === null) {
    throw errors.unauthenticated('Sign in to continue.');
  }
  throw errors.forbidden(`You are not allowed to ${action} this ${resource}.`, [{ field: resource, issue: decision.reason }]);
}

type Granted = { allowed: true; viaRole: Role | null; reason: string };

/* ------------------------------------------------------- CSRF / origin */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF and origin enforcement for state-changing requests.
 *
 * Applied globally rather than per-route so a new endpoint cannot forget it.
 * The session cookie is SameSite=Lax, so a cross-site request will not carry it
 * at all in a compliant browser; this is the second layer for the rest.
 */
export const csrfGuard: preHandlerHookHandler = (request, _reply, done) => {
  const services = request.server.services;
  const { config } = services;
  const ctx = request.ctx;

  if (!MUTATING_METHODS.has(request.method)) {
    done();
    return;
  }

  // Content types that a browser can submit from a foreign origin as a "simple"
  // request (no preflight) are the dangerous ones.
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
  const isSimpleForm = contentType === 'application/x-www-form-urlencoded' || contentType === 'multipart/form-data' || contentType === 'text/plain';

  if (ctx.session === null) {
    // No session means no CSRF risk: there is nothing to ride on. Endpoints
    // that need a session will fail in their own permission check.
    if (!isSimpleForm) {
      done();
      return;
    }
  }

  const origin = request.headers.origin;
  const referer = request.headers.referer;

  /*
   * An origin is acceptable when it matches EITHER the configured PUBLIC_URL or
   * the host the client actually reached us on.
   *
   * The second clause matters for self-hosting, which is the only supported
   * deployment. PUBLIC_URL has to be a single value, but an operator reaches
   * the same instance at `localhost`, at a LAN IP, and through a reverse proxy
   * hostname — often in the same session. Matching only PUBLIC_URL meant every
   * state-changing request failed with ORIGIN_REJECTED on the two names that
   * were not configured, with a message that pointed nowhere near the cause.
   *
   * This is not a weakening of the check. A cross-site attacker controls the
   * Origin header but not the Host header, and Host is derived from the URL the
   * browser connected to. So `Origin` equal to `Host` can only happen when the
   * page really was served by this origin, which is exactly the condition the
   * check exists to establish. A forged Origin from another site still differs.
   */
  const configuredHost = new URL(config.publicUrl).host;
  const requestHost = request.headers.host ?? '';
  const isSameOrigin = (candidate: string): boolean => {
    if (candidate === configuredHost) return true;
    if (requestHost === '') return false;
    // Compare case-insensitively, and treat an explicit default port as equal to
    // its implicit one, because a browser omits :443 for https but an operator
    // may have configured it either way.
    const normalise = (host: string): string => host.trim().toLowerCase().replace(/^(\[[^\]]+\]|[^:]+):(80|443)$/, '$1');
    return normalise(candidate) === normalise(requestHost);
  };

  if (typeof origin === 'string' && origin.length > 0) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      services.audit.recordDenied({
        action: 'admin.override',
        actorId: ctx.actor?.id ?? null,
        actorRoles: ctx.actor?.roles ?? [],
        resourceType: 'csrf',
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        reason: 'unparseable Origin header',
        at: ctx.at,
      });
      done(errors.originRejected());
      return;
    }
    if (!isSameOrigin(originHost)) {
      services.audit.recordDenied({
        action: 'admin.override',
        actorId: ctx.actor?.id ?? null,
        actorRoles: ctx.actor?.roles ?? [],
        resourceType: 'csrf',
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        reason: `origin ${originHost} matches neither PUBLIC_URL (${configuredHost}) nor the request Host (${requestHost})`,
        at: ctx.at,
      });
      done(errors.originRejected());
      return;
    }
  } else if (typeof referer === 'string' && referer.length > 0) {
    let refererHost: string;
    try {
      refererHost = new URL(referer).host;
    } catch {
      refererHost = '';
    }
    if (refererHost !== '' && !isSameOrigin(refererHost)) {
      done(errors.originRejected());
      return;
    }
  }

  if (ctx.session !== null) {
    const presented = request.headers[config.csrf.headerName];
    const token = Array.isArray(presented) ? presented[0] : presented;
    if (!SessionStore.verifyCsrf(ctx.session, token ?? null)) {
      services.audit.recordDenied({
        action: 'admin.override',
        actorId: ctx.actor?.id ?? null,
        actorRoles: ctx.actor?.roles ?? [],
        resourceType: 'csrf',
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        reason: 'CSRF token missing or mismatched',
        at: ctx.at,
      });
      done(errors.csrfFailed());
      return;
    }
  }

  done();
};

/* -------------------------------------------------------- rate limiting */

type Bucket = { count: number; resetAt: number };

/**
 * A small in-process fixed-window limiter.
 *
 * Deliberately in-process: this platform is designed to run as a single node
 * from one `docker compose up`, and an external store would break the
 * "no external service" guarantee. The trade-off is documented in
 * THREAT-MODEL.md: a multi-node deployment would need a shared store, and the
 * limiter is the one component that would have to change.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();
  /** Exposed so the response can advertise the budget it just spent from. */
  readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  check(key: string, at: number = Date.now()): { allowed: boolean; remaining: number; resetAt: number; retryAfterSeconds: number } {
    this.sweep(at);
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= at) {
      const resetAt = at + this.windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.max - 1, resetAt, retryAfterSeconds: 0 };
    }
    bucket.count += 1;
    const allowed = bucket.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterSeconds: allowed ? 0 : Math.ceil((bucket.resetAt - at) / 1000),
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(at: number): void {
    if (at - this.lastSweep < this.windowMs) return;
    this.lastSweep = at;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= at) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/* ------------------------------------------------------ error rendering */

/**
 * Render any thrown error as the standard JSON envelope.
 *
 * Installed separately from `installNotFoundHandler` because Fastify allows
 * exactly one of each, and the SPA branch needs to own the 404 handler while
 * still using this one.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const services = request.server.services;
    const ctx = request.ctx;
    const apiError = toApiError(error);

    if (apiError.status >= 500) {
      services.logger.error('request failed', {
        requestId: ctx.requestId,
        method: request.method,
        url: request.url,
        code: apiError.code,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
    } else {
      services.logger.debug('request rejected', {
        requestId: ctx.requestId,
        method: request.method,
        url: request.url,
        code: apiError.code,
        status: apiError.status,
      });
    }

    for (const [key, value] of Object.entries(apiError.headers)) reply.header(key, value);
    void reply.status(apiError.status).send(apiError.toBody(ctx.requestId));
  });
}

/**
 * The 404 body, in the same shape as every other error, so a client can parse
 * one thing. Exported because the SPA route needs to answer /api and /assets
 * misses itself rather than falling through to the shell.
 */
export function notFoundBody(method: string, url: string, requestId: string): unknown {
  return errors.notFound('Endpoint', `${method} ${url}`).toBody(requestId);
}

/** The API-only 404: JSON, never the SPA shell. */
export function installNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const services = request.server.services;
    const ctx = request.ctx;
    services.logger.debug('route not found', { requestId: ctx.requestId, method: request.method, url: request.url });
    void reply.status(404).send(notFoundBody(request.method, request.url, ctx.requestId));
  });
}

/* ---------------------------------------------------------- pagination */

export type Page<T> = {
  data: T[];
  pagination: { page: number; perPage: number; total: number; totalPages: number; hasMore: boolean };
};

export function paginate<T>(rows: T[], total: number, page: number, perPage: number): Page<T> {
  const totalPages = perPage > 0 ? Math.ceil(total / perPage) : 0;
  return {
    data: rows,
    pagination: { page, perPage, total, totalPages, hasMore: page < totalPages },
  };
}

export const MAX_PER_PAGE = 200;

export function normalisePaging(input: { page?: number; perPage?: number }): { page: number; perPage: number; limit: number; offset: number } {
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.trunc(input.perPage ?? 25)));
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  return { page, perPage, limit: perPage, offset: (page - 1) * perPage };
}

/* ------------------------------------------------------------- OpenAPI */

export type RouteDoc = {
  method: string;
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  /** Zod schemas; converted to JSON Schema when the document is generated. */
  body?: ZodType;
  /**
   * The body is `multipart/form-data` rather than JSON. A binary part has no
   * meaningful Zod schema, so this says what the parts are and the generator
   * writes the shape out. It used to be inferred from the path containing
   * "uploads", which meant the upload endpoint got no documented body at all.
   */
  multipart?: boolean;
  querystring?: ZodType;
  params?: ZodType;
  response?: ZodType;
  /** Response status codes this route can produce, beyond the success code. */
  errors?: ApiError['code'][];
  auth: 'none' | 'session' | 'organizer' | 'admin';
  /** Permission recorded in the docs, mirroring the enforced check. */
  permission?: { resource: Resource; action: Action };
  /** Hide from the published document (health, internal). */
  hidden?: boolean;
  /**
   * The status the route returns on success. Defaults to 200.
   *
   * The generator used to infer this from whether a response schema was
   * declared, and emit `204 No Content` for every route that had none. Since
   * only two routes declared one, 140 of 142 operations were documented as 204
   * when the real distribution is 200, 201 and 204 - a client generated from
   * that document would not know a creation had happened. Declared per route
   * instead, so the document states what the handler does.
   */
  success?: 200 | 201 | 202 | 204;
  /**
   * Whether this route consumes rate-limit budget. Defaults to true.
   *
   * `/api/health` is exempt, so a liveness probe cannot exhaust anyone's budget
   * and a probe that is itself rate limited cannot fail for the wrong reason. The
   * document used to advertise `429` on every operation including that one, which
   * is a response it can never return.
   */
  rateLimited?: boolean;
  /**
   * Whether a successful request changes persisted state. Used to warn in the
   * document, because a `GET` that writes is a trap for crawlers and link
   * previews.
   */
  mutates?: boolean;
};

/**
 * Route documentation registry.
 *
 * Each route registers its own Zod schemas here, and the OpenAPI generator
 * reads this registry. Because the *same* Zod objects are used for runtime
 * validation, the published document cannot drift from the implementation —
 * which is the only way "API-first" means anything.
 */
export class RouteRegistry {
  private readonly routes: RouteDoc[] = [];

  register(doc: RouteDoc): void {
    this.routes.push(doc);
  }

  all(): readonly RouteDoc[] {
    return this.routes;
  }

  published(): RouteDoc[] {
    return this.routes.filter((route) => !route.hidden);
  }
}

/* ------------------------------------------------------------ helpers */

export function sendCsv(reply: FastifyReply, filename: string, body: string): FastifyReply {
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${safeName}"`)
    .header('cache-control', 'no-store')
    .send(body);
}

export function sendJson(reply: FastifyReply, filename: string, body: string): FastifyReply {
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return reply
    .header('content-type', 'application/json; charset=utf-8')
    .header('content-disposition', `attachment; filename="${safeName}"`)
    .header('cache-control', 'no-store')
    .send(body);
}

export function toInstant(value: Instant): string {
  return value;
}

export { ApiError, errors, isApiError, newId };

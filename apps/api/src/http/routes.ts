/**
 * HTTP routes.
 *
 * Every route is a thin translation: validate the request with the Zod schema
 * that also generates the OpenAPI entry, build an `Ownership` object from the
 * row the service actually loaded, call the service, shape the response.
 *
 * The rules that make this safe:
 *  - Permission checks are explicit per route and go through
 *    `requirePermission`, so the RBAC matrix is the only grant path.
 *  - Ownership is derived from the loaded record, never from a body field.
 *  - A handler that returns a service result returns it verbatim; no ranking,
 *    no scoring and no permission decision happens in this layer.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NORMALIZATION_METHODS, AGGREGATION_METHODS, EVENT_STATES } from '@verdict/core/types';
import { ASSIGNMENT_STRATEGIES } from '@verdict/core/assignment';
import { MACHINES, describeMachine } from '@verdict/core/state-machines';
import { errors } from '../lib/errors.ts';
import {
  MAX_PER_PAGE,
  normalisePaging,
  requirePermission,
  sendCsv,
  sendJson,
  type AppServices,
  type Page,
  type RouteRegistry,
} from './context.ts';
import { actorContext } from '../services/context.ts';
import { FIELD_TYPES } from '../services/registration-service.ts';
import { serializeEvent, serializePublicUser } from './serializers.ts';

const Id = z.string().min(3).max(64);
const InstantString = z.string().min(4).max(40);
const Paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(MAX_PER_PAGE).default(25),
});

type Services = AppServices['services'];

/* ==================================================================== meta */

export function registerMetaRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  const health = async () => {
    const check = services.db.healthCheck();
    return {
      status: check.ok ? 'ok' : 'degraded',
      database: check,
      uptimeSeconds: Math.round(process.uptime()),
      version: appVerdictVersion,
    };
  };

  app.get('/api/health', { config: { rateLimit: false } as never }, health);
  registry.register({
    method: 'GET', path: '/api/health', tags: ['meta'], auth: 'none', hidden: true,
    summary: 'Liveness probe — answers even when the database is down.',
  });

  app.get('/api/ready', async () => {
    const check = services.db.healthCheck();
    const ready = check.ok && services.db.isReady();
    if (!ready) {
      throw errors.unavailable(`Not ready: ${check.detail}`);
    }
    return { status: 'ready', schemaVersion: services.db.value<number>('SELECT MAX(version) AS v FROM schema_migrations') };
  });
  registry.register({
    method: 'GET', path: '/api/ready', tags: ['meta'], auth: 'none', hidden: true,
    summary: 'Readiness probe — used by Docker to gate traffic until migrations finish.',
  });

  app.get('/api/capabilities', async () => ({
    version: appVerdictVersion,
    judging: {
      normalizationMethods: NORMALIZATION_METHODS,
      aggregationMethods: AGGREGATION_METHODS,
      assignmentStrategies: ASSIGNMENT_STRATEGIES,
    },
    uploads: services.uploads.rules(),
    registrationFieldTypes: FIELD_TYPES,
    limits: {
      maxJsonBodyBytes: services.config.security.maxJsonBodyBytes,
      maxUploadBytes: services.config.security.maxUploadBytes,
      maxPerPage: MAX_PER_PAGE,
    },
    time: { strategy: 'UTC instants; naive local input is interpreted in the event timezone', storage: 'ISO-8601 with Z' },
  }));
  registry.register({
    method: 'GET', path: '/api/capabilities', tags: ['meta'], auth: 'none',
    summary: 'What this deployment supports — methods, limits, field types.',
  });

  /*
   * The lifecycle vocabulary, as data.
   *
   * This used to return `event: describeMatrix().length > 0 ? undefined :
   * undefined` — a tautology that always produced `undefined`, and an import of
   * the RBAC matrix into an event route, which had nothing to do with the answer.
   * The useful thing to publish here is the transition table itself: an
   * organizer or an integrating frontend can discover which moves are legal and,
   * critically, *why* the illegal ones are refused, without reading the source.
   */
  app.get('/api/lifecycle', async () => ({
    states: EVENT_STATES,
    machines: Object.fromEntries(
      (Object.keys(MACHINES) as (keyof typeof MACHINES)[]).map((name) => [name, describeMachine(name)]),
    ),
    note: 'Guarded transitions are refused unless a fact holds or an authorised organizer supplies an explicit override. Each entry carries the reason so the refusal can be explained rather than merely reported.',
  }));
  registry.register({
    method: 'GET', path: '/api/lifecycle', tags: ['meta'], auth: 'none',
    summary: 'Every lifecycle state machine and its legal transitions, with the reason for each.',
    description: 'The same tables the server enforces. A client that renders a lifecycle control from this cannot offer a move the server will refuse.',
  });
}

/* ==================================================================== auth */

const RegisterBody = z.object({
  email: z.email().max(254),
  username: z.string().min(3).max(32),
  password: z.string().min(12).max(200),
  displayName: z.string().min(1).max(120).optional(),
  organization: z.string().max(200).optional(),
});

const LoginBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(200),
});

export function registerAuthRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  const { config, auth, audit } = services;

  const setSessionCookies = (reply: FastifyReply, token: string, csrfToken: string) => {
    // `maxAge` is in seconds, matching the cookie's own unit, so the browser
    // expires it exactly when the server-side absolute timeout fires.
    const maxAge = config.session.absoluteTimeoutDays * 86_400;

    // httpOnly is stated explicitly rather than left to @fastify/cookie, which
    // applies no default for it. Relying on that would have shipped a session
    // cookie that any script on the page could read — turning a single XSS into
    // a full account takeover, including organizer and admin sessions.
    reply.setCookie(config.session.cookieName, token, {
      maxAge,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.session.secureCookies,
    });

    // Readable by JavaScript on purpose: the SPA has to echo it in the CSRF
    // header. It is not a credential — without the session cookie it is
    // useless, and it is compared against the session's stored token.
    reply.setCookie(config.csrf.cookieName, csrfToken, {
      maxAge,
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      secure: config.session.secureCookies,
    });
  };

  const clearSessionCookies = (reply: FastifyReply) => {
    // The deletion cookie must carry the same attributes as the one it is
    // replacing, or the browser keeps the original: path and same-site in
    // particular have to match for the match to be found at all.
    const common = { path: '/', sameSite: 'lax' as const, secure: config.session.secureCookies };
    reply.clearCookie(config.session.cookieName, { ...common, httpOnly: true });
    reply.clearCookie(config.csrf.cookieName, { ...common, httpOnly: false });
  };

  app.post('/api/auth/register', { config: { rateLimit: { max: config.security.authRateLimitMax, timeWindow: config.security.authRateLimitWindowMs } } as never }, async (request, reply) => {
    const body = RegisterBody.parse(request.body) as z.infer<typeof RegisterBody>;
    const result = auth.register(body, {
      requestId: request.ctx.requestId,
      ipAddress: request.ctx.ipAddress,
      userAgent: request.ctx.userAgent,
      at: request.ctx.at,
    });
    setSessionCookies(reply, result.session.token, result.session.csrfToken);
    return reply.status(201).send({ user: result.user, csrfToken: result.session.csrfToken });
  });
  registry.register({
    method: 'POST', path: '/api/auth/register', tags: ['auth'], auth: 'none', body: RegisterBody,
    summary: 'Create an account and sign in.',
    description: 'The new account receives the PARTICIPANT role. Organizer and admin accounts are created by an existing admin.',
    response: z.object({ user: z.unknown(), csrfToken: z.string() }),
    errors: ['VALIDATION_FAILED', 'CONFLICT', 'RATE_LIMITED', 'CSRF_FAILED'],
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: config.security.authRateLimitMax, timeWindow: config.security.authRateLimitWindowMs } } as never }, async (request, reply) => {
    const body = LoginBody.parse(request.body) as z.infer<typeof LoginBody>;
    const result = auth.login(body, {
      requestId: request.ctx.requestId,
      ipAddress: request.ctx.ipAddress,
      userAgent: request.ctx.userAgent,
      at: request.ctx.at,
    });
    setSessionCookies(reply, result.session.token, result.session.csrfToken);
    return { user: result.user, csrfToken: result.session.csrfToken };
  });
  registry.register({
    method: 'POST', path: '/api/auth/login', tags: ['auth'], auth: 'none', body: LoginBody,
    summary: 'Sign in and receive session cookies.',
    description: 'An unknown address and a wrong password return the same 401 body and take comparable time, so this endpoint cannot be used to enumerate accounts. Eight consecutive failures lock the account for 15 minutes.',
    response: z.object({ user: z.unknown(), csrfToken: z.string() }),
    errors: ['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'ACCOUNT_SUSPENDED', 'RATE_LIMITED'],
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.ctx.session !== null) {
      auth.logout(request.ctx.session.id, {
        requestId: request.ctx.requestId,
        actor: request.ctx.actor,
        at: request.ctx.at,
      });
    }
    clearSessionCookies(reply);
    return reply.status(204).send();
  });
  registry.register({
    method: 'POST', path: '/api/auth/logout', tags: ['auth'], auth: 'session',
    summary: 'Sign out and revoke the session server-side.',
  });

  app.get('/api/auth/session', async (request) => {
    if (request.ctx.user === null) return { authenticated: false, user: null };
    return { authenticated: true, user: serializePublicUser(auth.toPublicUser(request.ctx.user), request.ctx.actor?.eventIds ?? []) };
  });
  registry.register({
    method: 'GET', path: '/api/auth/session', tags: ['auth'], auth: 'none',
    summary: 'Who am I, and what may I do?',
    description: 'Returns 200 with `authenticated: false` rather than 401, so the client can use one call to decide what to render.',
  });

  app.post('/api/auth/password', async (request) => {
    const body = z
      .object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(200) })
      .parse(request.body);
    const user = request.ctx.user;
    if (user === null) throw errors.unauthenticated();
    auth.changePassword(user.id, body, {
      requestId: request.ctx.requestId,
      ipAddress: request.ctx.ipAddress,
      userAgent: request.ctx.userAgent,
      at: request.ctx.at,
      keepCurrentSession: true,
      currentSessionId: request.ctx.session?.id,
    });
    return { changed: true, note: 'Every other device has been signed out.' };
  });
  registry.register({
    method: 'POST', path: '/api/auth/password', tags: ['auth'], auth: 'session',
    summary: 'Change your password.',
    description: 'Revokes every other session for the account.',
    errors: ['INVALID_CREDENTIALS', 'VALIDATION_FAILED'],
  });

  app.post('/api/auth/password-reset', { config: { rateLimit: { max: 5, timeWindow: 3_600_000 } } as never }, async (request) => {
    const body = z.object({ email: z.email() }).parse(request.body);
    const result = auth.requestPasswordReset(body, {
      requestId: request.ctx.requestId,
      ipAddress: request.ctx.ipAddress,
      userAgent: request.ctx.userAgent,
      at: request.ctx.at,
    });
    // The token is returned only because there is no mail service. A
    // deployment with SMTP would send it instead and return nothing.
    return {
      sent: true,
      ...(result.token === null ? {} : { resetToken: result.token, note: 'No mail service is configured, so the token is returned directly. In a real deployment this would be emailed.' }),
    };
  });
  registry.register({
    method: 'POST', path: '/api/auth/password-reset', tags: ['auth'], auth: 'none',
    summary: 'Request a password reset link.',
    description: 'Always reports success, whether or not the address exists, so the endpoint cannot enumerate accounts. The token is returned in the body because this deployment has no mail service.',
    errors: ['RATE_LIMITED'],
  });

  app.post('/api/auth/password-reset/complete', { config: { rateLimit: { max: 10, timeWindow: 3_600_000 } } as never }, async (request) => {
    const body = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(12).max(200) }).parse(request.body);
    auth.completePasswordReset(body, {
      requestId: request.ctx.requestId,
      ipAddress: request.ctx.ipAddress,
      userAgent: request.ctx.userAgent,
      at: request.ctx.at,
    });
    return { completed: true, note: 'Every session for this account has been signed out.' };
  });
  registry.register({
    method: 'POST', path: '/api/auth/password-reset/complete', tags: ['auth'], auth: 'none',
    summary: 'Complete a password reset.',
    errors: ['BAD_REQUEST', 'VALIDATION_FAILED', 'RATE_LIMITED'],
  });

  app.get('/api/auth/sessions', async (request) => {
    if (request.ctx.user === null) throw errors.unauthenticated();
    const sessions = auth.sessions.listActive(request.ctx.user.id, request.ctx.at);
    return {
      data: sessions.map((session) => ({
        id: session.id,
        current: session.id === request.ctx.session?.id,
        createdAt: session.created_at,
        lastSeenAt: session.last_seen_at,
        expiresAt: session.expires_at,
        ipAddress: session.ip_address,
        userAgent: session.user_agent,
      })),
      note: 'Sessions store only a SHA-256 digest of the cookie value.',
    };
  });
  registry.register({
    method: 'GET', path: '/api/auth/sessions', tags: ['auth'], auth: 'session',
    summary: 'List your live sessions.',
  });

  app.delete('/api/auth/sessions/:sessionId', async (request) => {
    const params = z.object({ sessionId: Id }).parse(request.params);
    if (request.ctx.user === null) throw errors.unauthenticated();
    const owned = auth.sessions.listActive(request.ctx.user.id, request.ctx.at).some((s) => s.id === params.sessionId);
    if (!owned) throw errors.notFound('Session', params.sessionId);
    auth.sessions.revoke(params.sessionId, 'revoked by user', request.ctx.at);
    audit.record({
      action: 'auth.session_revoked',
      actorId: request.ctx.user.id,
      actorRoles: request.ctx.actor?.roles ?? [],
      resourceType: 'session',
      resourceId: params.sessionId,
      requestId: request.ctx.requestId,
      at: request.ctx.at,
    });
    return { revoked: true };
  });
  registry.register({
    method: 'DELETE', path: '/api/auth/sessions/{sessionId}', tags: ['auth'], auth: 'session',
    summary: 'Revoke one of your sessions.',
  });
}

/* ================================================================= profile */

export function registerProfileRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.get('/api/profile', async (request) => {
    if (request.ctx.user === null) throw errors.unauthenticated();
    return serializePublicUser(services.auth.toPublicUser(request.ctx.user), request.ctx.actor?.eventIds ?? []);
  });
  registry.register({ method: 'GET', path: '/api/profile', tags: ['profile'], auth: 'session', summary: 'Your own profile.', permission: { resource: 'profile', action: 'read' } });

  app.patch('/api/profile', async (request) => {
    if (request.ctx.user === null) throw errors.unauthenticated();
    const body = z
      .object({
        displayName: z.string().min(1).max(120).optional(),
        bio: z.string().max(2000).optional(),
        organization: z.string().max(200).optional(),
        githubUrl: z.url().max(2048).nullable().optional(),
        portfolioUrl: z.url().max(2048).nullable().optional(),
        skills: z.array(z.string().max(60)).max(40).optional(),
        avatarColor: z.string().regex(/^#[0-9a-fA-F]{3,6}$/).optional(),
      })
      .parse(request.body);
    const user = services.auth.updateProfile(request.ctx.user.id, body, request.ctx.at);
    return serializePublicUser(user, request.ctx.actor?.eventIds ?? []);
  });
  registry.register({
    method: 'PATCH', path: '/api/profile', tags: ['profile'], auth: 'session',
    summary: 'Update your own profile.', permission: { resource: 'profile', action: 'update' },
    errors: ['VALIDATION_FAILED'],
  });

  app.get('/api/users/search', async (request) => {
    const query = z.object({ search: z.string().min(2).max(100) }).merge(Paging).parse(request.query);
    requirePermission(services, request.ctx, 'user', 'read');
    const paging = normalisePaging(query);
    const result = services.auth.search(query.search, paging.limit, paging.offset);
    return {
      data: result.rows.map((row) => serializePublicUser(services.auth.toPublicUser(row))),
      pagination: { page: paging.page, perPage: paging.perPage, total: result.total, totalPages: Math.ceil(result.total / paging.perPage), hasMore: paging.offset + paging.limit < result.total },
    };
  });
  registry.register({
    method: 'GET', path: '/api/users/search', tags: ['admin'], auth: 'organizer',
    summary: 'Find users (organizers and admins).', permission: { resource: 'user', action: 'read' },
  });
}

export const appVerdictVersion = '1.0.0';

/* ================================================================= events */

const EventBody = z.object({
  slug: z.string().min(3).max(64),
  name: z.string().min(3).max(160),
  tagline: z.string().max(200).optional(),
  description: z.string().max(20_000).optional(),
  rules: z.string().max(20_000).optional(),
  timezone: z.string().min(1).max(64).default('UTC'),
  registrationOpensAt: InstantString.nullable().optional(),
  registrationClosesAt: InstantString.nullable().optional(),
  submissionOpensAt: InstantString.nullable().optional(),
  submissionClosesAt: InstantString.nullable().optional(),
  judgingOpensAt: InstantString.nullable().optional(),
  judgingClosesAt: InstantString.nullable().optional(),
  votingOpensAt: InstantString.nullable().optional(),
  votingClosesAt: InstantString.nullable().optional(),
  maxTeamSize: z.number().int().min(1).max(100).optional(),
  minTeamSize: z.number().int().min(1).max(100).optional(),
  allowIndividual: z.boolean().optional(),
  galleryVisibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']).optional(),
  galleryOrder: z.enum(['RANDOMIZED', 'ALPHABETICAL', 'SUBMISSION', 'VOTES']).optional(),
  votingEnabled: z.boolean().optional(),
  votingRevealTotals: z.boolean().optional(),
  votingRequiresRegistration: z.boolean().optional(),
  commentsEnabled: z.boolean().optional(),
  commentsRequireApproval: z.boolean().optional(),
  resultsVisibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']).optional(),
  reviewsPerProject: z.number().int().min(1).max(20).optional(),
  minimumJudges: z.number().int().min(1).max(20).optional(),
  assignmentSeed: z.string().max(120).optional(),
  bannerUrl: z.url().max(2048).nullable().optional(),
  logoUrl: z.url().max(2048).nullable().optional(),
});

export function registerEventRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.get('/api/events', async (request, reply) => {
    const query = z
      .object({ state: z.enum(EVENT_STATES).optional(), search: z.string().max(100).optional() })
      .merge(Paging)
      .parse(request.query);
    const paging = normalisePaging(query);
    const ctx = actorContext({ actor: request.ctx.actor, requestId: request.ctx.requestId, ipAddress: request.ctx.ipAddress, userAgent: request.ctx.userAgent, at: request.ctx.at });

    if (request.ctx.actor === null) {
      const result = services.events.publicList({ ...(query.state ? { state: query.state } : {}), ...(query.search ? { search: query.search } : {}), limit: paging.limit, offset: paging.offset });
      return reply.send({
        data: result.rows.map((row) => serializeEvent(row, ctx)),
        pagination: { page: paging.page, perPage: paging.perPage, total: result.total, totalPages: Math.ceil(result.total / paging.perPage), hasMore: paging.offset + paging.limit < result.total },
      });
    }
    const result = services.events.listForActor(request.ctx.actor.roles, request.ctx.actor.eventIds, { ...(query.state ? { state: query.state } : {}), ...(query.search ? { search: query.search } : {}), limit: paging.limit, offset: paging.offset });
    return reply.send({
      data: result.rows.map((row) => serializeEvent(row, ctx)),
      pagination: { page: paging.page, perPage: paging.perPage, total: result.total, totalPages: Math.ceil(result.total / paging.perPage), hasMore: paging.offset + paging.limit < result.total },
    });
  });
  registry.register({
    method: 'GET', path: '/api/events', tags: ['events'], auth: 'none', querystring: Paging.extend({ state: z.enum(EVENT_STATES).optional(), search: z.string().optional() }),
    summary: 'List events you can see.',
    description: 'Anonymous callers see published and in-flight events. Signed-in organizers additionally see the events they organize.',
  });

  app.post('/api/events', async (request, reply) => {
    requirePermission(services, request.ctx, 'event', 'create', { publiclyVisible: true });
    const body = EventBody.parse(request.body) as z.infer<typeof EventBody>;
    const event = services.events.create(body, actorContext(request.ctx));
    return reply.status(201).send(serializeEvent(event, actorContext(request.ctx)));
  });
  registry.register({
    method: 'POST', path: '/api/events', tags: ['events'], auth: 'session', body: EventBody,
    summary: 'Create an event.', permission: { resource: 'event', action: 'create' },
    description: 'The creator becomes an organizer of the new event. A default application form is created so the event is immediately usable.',
    errors: ['VALIDATION_FAILED', 'CONFLICT', 'FORBIDDEN'],
  });

  app.get('/api/events/:eventId', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const event = services.events.require(params.eventId);
    return serializeEvent(event, actorContext(request.ctx));
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}', tags: ['events'], auth: 'none',
    summary: 'One event, with its live window status.',
  });

  app.patch('/api/events/:eventId', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const body = EventBody.partial().parse(request.body);
    requirePermission(services, request.ctx, 'event', 'update', { inOrganizedEvent: canOrganize(request, services, params.eventId) }, { resourceType: 'event', resourceId: params.eventId, eventId: services.events.require(params.eventId).id });
    return serializeEvent(services.events.update(params.eventId, body, actorContext(request.ctx)), actorContext(request.ctx));
  });
  registry.register({
    method: 'PATCH', path: '/api/events/{eventId}', tags: ['events'], auth: 'organizer', body: EventBody.partial(),
    summary: 'Update event settings and dates.', permission: { resource: 'event', action: 'update' },
    errors: ['VALIDATION_FAILED', 'FORBIDDEN', 'IMMUTABLE'],
  });

  app.post('/api/events/:eventId/transition', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const body = z
      .object({ to: z.enum(EVENT_STATES), override: z.boolean().default(false), reason: z.string().max(500).optional() })
      .parse(request.body);
    const eventId = services.events.require(params.eventId).id;
    requirePermission(services, request.ctx, 'event', 'publish', { inOrganizedEvent: canOrganize(request, services, eventId) }, { resourceType: 'event', resourceId: eventId, eventId });
    return serializeEvent(services.events.transition(params.eventId, body.to, body, actorContext(request.ctx)), actorContext(request.ctx));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/transition', tags: ['events'], auth: 'organizer',
    summary: 'Move the event through its lifecycle.',
    description: 'The state machine decides legality. Some transitions need a fact (the deadline must have passed) or an explicit `override` with a reason; a refusal returns 409 with the machine\'s own explanation.',
    body: z.object({ to: z.enum(EVENT_STATES), override: z.boolean().default(false), reason: z.string().optional() }),
    errors: ['ILLEGAL_TRANSITION', 'FORBIDDEN', 'VALIDATION_FAILED'],
  });

  app.get('/api/events/:eventId/transitions', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const event = services.events.require(params.eventId);
    const current = event.state;
    // `describeMachine` lists every declared edge; the live facts (has the
    // deadline passed? is there a submitted project?) are what the guards read,
    // and those are already resolved into `event.dates` by the serializer. So
    // this returns the declared vocabulary plus the concrete next moves the
    // client can actually offer, rather than a table it must interpret itself.
    return {
      current,
      machines: Object.fromEntries(
        (Object.keys(MACHINES) as (keyof typeof MACHINES)[]).map((name) => [name, describeMachine(name)]),
      ),
      available: MACHINES.Event.transitions
        .filter((t) => t.from === current)
        .map((t) => ({ to: t.to, reason: t.reason, guarded: Boolean(t.guard) })),
      windows: {
        registration: event.registration_closes_at,
        submission: event.submission_closes_at,
        judging: event.judging_closes_at,
        voting: event.voting_closes_at,
      },
    };
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/transitions', tags: ['events'], auth: 'none',
    summary: 'The current state, every lifecycle table, and the moves available from here.',
  });

  app.get('/api/events/:eventId/tracks', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    return { data: services.events.listTracks(services.events.require(params.eventId).id) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/tracks', tags: ['events'], auth: 'none', summary: 'List tracks.' });

  app.post('/api/events/:eventId/tracks', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const body = z.object({ slug: z.string().optional(), name: z.string().min(2).max(100), description: z.string().max(2000).optional(), color: z.string().optional(), maxProjects: z.number().int().min(1).nullable().optional() }).parse(request.body);
    const eventId = services.events.require(params.eventId).id;
    requirePermission(services, request.ctx, 'track', 'create', { inOrganizedEvent: canOrganize(request, services, eventId) }, { eventId, resourceType: 'track' });
    return reply.status(201).send(services.events.addTrack(eventId, body, actorContext(request.ctx)));
  });
  registry.register({ method: 'POST', path: '/api/events/{eventId}/tracks', tags: ['events'], auth: 'organizer', summary: 'Add a track.', permission: { resource: 'track', action: 'create' } });

  app.get('/api/events/:eventId/prizes', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    return { data: services.events.listPrizes(services.events.require(params.eventId).id) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/prizes', tags: ['events'], auth: 'none', summary: 'List prizes.' });

  app.post('/api/events/:eventId/prizes', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const body = z.object({ name: z.string().min(2).max(120), description: z.string().max(2000).optional(), quantity: z.number().int().min(1).max(1000).optional(), eligibleRanks: z.array(z.number().int().min(1)).max(20).optional(), eligibleTrackId: Id.nullable().optional(), priority: z.number().int().min(0).max(10_000).optional() }).parse(request.body);
    const eventId = services.events.require(params.eventId).id;
    requirePermission(services, request.ctx, 'prize', 'create', { inOrganizedEvent: canOrganize(request, services, eventId) }, { eventId, resourceType: 'prize' });
    return reply.status(201).send(services.events.addPrize(eventId, body, actorContext(request.ctx)));
  });
  registry.register({ method: 'POST', path: '/api/events/{eventId}/prizes', tags: ['events'], auth: 'organizer', summary: 'Add a prize.', permission: { resource: 'prize', action: 'create' } });
}

export function canOrganize(request: FastifyRequest, services: Services, eventIdOrSlug: string): boolean {
  if (request.ctx.actor === null) return false;
  const event = services.events.findById(eventIdOrSlug) ?? services.events.findBySlug(eventIdOrSlug);
  if (event === null) return false;
  return request.ctx.actor.roles.includes('ADMIN') || request.ctx.actor.eventIds.includes(event.id);
}

export { Paging, normalisePaging, sendCsv, sendJson, requirePermission };
export type { AppServices, FastifyInstance, Page, RouteRegistry, Services };

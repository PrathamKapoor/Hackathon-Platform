/**
 * The remaining API surface: registration, teams, submissions, uploads, the
 * gallery, judging, results, community, certificates, webhooks, transfer,
 * audit and admin.
 *
 * Same rules as `routes.ts`: thin translation, explicit permission checks,
 * ownership derived from the loaded row.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssignmentStrategy } from '@verdict/core/assignment';
import { EVENT_STATES, NORMALIZATION_METHODS, AGGREGATION_METHODS } from '@verdict/core/types';
import { ASSIGNMENT_STRATEGIES } from '@verdict/core/assignment';
import { WEBHOOK_EVENTS, type WebhookEvent } from '@verdict/core/types';
import { errors } from '../lib/errors.ts';
import { canManageEvent, describeMatrix } from '../lib/rbac.ts';
import { normalisePaging, requirePermission, sendCsv, sendJson, type RouteRegistry } from './context.ts';
import { actorContext } from '../services/context.ts';
import { EXPORT_KINDS } from '../services/transfer-service.ts';
import { serializeEvent, serializeProject, serializePublicUser, serializeSelf, safeArray } from './serializers.ts';

const Id = z.string().min(3).max(64);
const Paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(25),
});
type Services = import('../services/context.ts').Services;

function ctx(request: { ctx: import('../lib/auth.ts').RequestContext }) {
  return actorContext({
    actor: request.ctx.actor,
    requestId: request.ctx.requestId,
    ipAddress: request.ctx.ipAddress,
    userAgent: request.ctx.userAgent,
    at: request.ctx.at,
  });
}

function eventIdOf(services: Services, idOrSlug: string): string {
  return services.events.require(idOrSlug).id;
}

/* ========================================================== registration */

export function registerRegistrationRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.get('/api/events/:eventId/registration/form', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    return {
      eventId,
      fields: services.registrations.listFields(eventId).map((field) => ({
        id: field.id,
        key: field.field_key,
        label: field.label,
        helpText: field.help_text,
        type: field.field_type,
        required: field.required === 1,
        options: safeArray(field.options),
        placeholder: field.placeholder,
        order: Number(field.display_order),
      })),
    };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/registration/form', tags: ['registration'], auth: 'none', summary: 'The application form for this event.' });

  app.post('/api/events/:eventId/registration/form/fields', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'registration', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'registrationField' });
    const body = z.object({
      key: z.string().max(60).optional(),
      label: z.string().min(1).max(120),
      helpText: z.string().max(400).optional(),
      type: z.enum(['text', 'number', 'select', 'multi_select', 'checkbox']),
      required: z.boolean().optional(),
      options: z.array(z.string().max(120)).max(30).optional(),
      placeholder: z.string().max(120).optional(),
    }).parse(request.body);
    return reply.status(201).send(services.registrations.addField(eventId, body, ctx(request)));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/registration/form/fields', tags: ['registration'], auth: 'organizer',
    summary: 'Add a field to the application form.', permission: { resource: 'registration', action: 'create' },
  });

  app.delete('/api/events/:eventId/registration/form/fields/:fieldId', async (request, reply) => {
    const params = z.object({ eventId: Id, fieldId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'registration', 'delete', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'registrationField' });
    services.registrations.deleteField(eventId, params.fieldId, ctx(request));
    return reply.status(204).send();
  });
  registry.register({ method: 'DELETE', path: '/api/events/{eventId}/registration/form/fields/{fieldId}', tags: ['registration'], auth: 'organizer', summary: 'Remove a form field.', permission: { resource: 'registration', action: 'delete' } });

  app.post('/api/events/:eventId/registration', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    if (request.ctx.user === null) throw errors.unauthenticated();
    const eventId = eventIdOf(services, params.eventId);
    const body = z.object({
      fullName: z.string().max(160).optional(),
      organization: z.string().max(200).optional(),
      skills: z.array(z.string().max(60)).max(40).optional(),
      githubUrl: z.url().max(2048).nullable().optional(),
      portfolioUrl: z.url().max(2048).nullable().optional(),
      bio: z.string().max(4000).optional(),
      responses: z.record(z.string(), z.union([z.string().max(2000), z.array(z.string().max(120)).max(30), z.number(), z.boolean()])).optional(),
    }).parse(request.body);
    const registration = services.registrations.apply(eventId, body, ctx(request));
    return reply.status(201).send({ ...registration, responses: services.registrations.responses(registration.id) });
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/registration', tags: ['registration'], auth: 'session',
    summary: 'Apply to take part.', permission: { resource: 'registration', action: 'create' },
    description: 'Idempotent per event: applying again updates the existing application rather than creating a duplicate.',
    errors: ['WINDOW_CLOSED', 'VALIDATION_FAILED', 'CONFLICT'],
  });

  app.get('/api/events/:eventId/registration/me', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    if (request.ctx.user === null) throw errors.unauthenticated();
    const eventId = eventIdOf(services, params.eventId);
    const registration = services.registrations.findForUser(eventId, request.ctx.user.id);
    if (registration === null) return { registration: null };
    return { registration, responses: services.registrations.responses(registration.id) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/registration/me', tags: ['registration'], auth: 'session', summary: 'Your own application.' });

  app.get('/api/events/:eventId/registrations', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = z.object({ state: z.enum(['APPLICATION', 'PENDING', 'ACCEPTED', 'REJECTED', 'WAITLISTED', 'WITHDRAWN']).optional(), search: z.string().max(100).optional() }).merge(Paging).parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'registration', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'registration' });
    const paging = normalisePaging(query);
    const result = services.registrations.list(eventId, { ...(query.state ? { state: query.state } : {}), ...(query.search ? { search: query.search } : {}), limit: paging.limit, offset: paging.offset });
    return {
      data: result.rows.map((row) => ({ ...row, responses: services.registrations.responses(row.id) })),
      byState: result.byState,
      pagination: { page: paging.page, perPage: paging.perPage, total: result.total, totalPages: Math.ceil(result.total / paging.perPage), hasMore: paging.offset + paging.limit < result.total },
    };
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/registrations', tags: ['registration'], auth: 'organizer',
    summary: 'The organizer\'s applicant queue, with per-state counts.',
    permission: { resource: 'registration', action: 'read' },
  });

  app.post('/api/events/:eventId/registrations/:registrationId/decision', async (request) => {
    const params = z.object({ eventId: Id, registrationId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'registration', 'update', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'registration', resourceId: params.registrationId });
    const body = z.object({ to: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'WAITLISTED', 'WITHDRAWN']), note: z.string().max(1000).optional(), override: z.boolean().default(false) }).parse(request.body);
    return services.registrations.decide(params.registrationId, body.to, body, ctx(request));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/registrations/{registrationId}/decision', tags: ['registration'], auth: 'organizer',
    summary: 'Accept, reject, waitlist or return an application.',
    permission: { resource: 'registration', action: 'update' },
    description: 'The decision goes through the registration state machine, so an application can never be moved into a state the workflow has no way out of.',
    errors: ['ILLEGAL_TRANSITION', 'FORBIDDEN'],
  });

  app.post('/api/events/:eventId/registrations/bulk', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'registration', 'moderate', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'registration' });
    const body = z.object({ ids: z.array(Id).min(1).max(500), to: z.enum(['ACCEPTED', 'REJECTED', 'WAITLISTED']), note: z.string().max(1000).optional(), override: z.boolean().default(false) }).parse(request.body);
    return services.registrations.bulkDecide(eventId, body.ids, body.to, body, ctx(request));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/registrations/bulk', tags: ['registration'], auth: 'organizer',
    summary: 'Decide many applications at once.',
    permission: { resource: 'registration', action: 'moderate' },
    description: 'Each application is validated independently, so one bad id cannot roll back the batch. The response reports exactly how many were applied and why the rest were not.',
  });

  app.get('/api/events/:eventId/registrations/export', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'registration', 'export', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'export' });
    return sendCsv(reply, `registrations-${eventId}.csv`, services.registrations.exportCsv(eventId));
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/registrations/export', tags: ['exports'], auth: 'organizer',
    summary: 'Export every application as CSV, including custom form responses.',
    permission: { resource: 'registration', action: 'export' },
  });
}

/* =================================================================== teams */

export function registerTeamRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.post('/api/events/:eventId/teams', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    if (request.ctx.actor === null) throw errors.unauthenticated();
    const eventId = eventIdOf(services, params.eventId);
    const body = z.object({ name: z.string().min(2).max(100), description: z.string().max(2000).optional(), organization: z.string().max(200).optional(), trackId: Id.nullable().optional() }).parse(request.body);
    const team = services.teams.create(eventId, body, ctx(request));
    return reply.status(201).send({ ...team, members: services.teams.members(team.id) });
  });
  registry.register({ method: 'POST', path: '/api/events/{eventId}/teams', tags: ['teams'], auth: 'session', summary: 'Create a team (you become the captain).', permission: { resource: 'team', action: 'create' } });

  app.get('/api/events/:eventId/teams', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = z.object({ search: z.string().max(100).optional() }).merge(Paging).parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    const paging = normalisePaging(query);
    const result = services.teams.list(eventId, { ...(query.search ? { search: query.search } : {}), limit: paging.limit, offset: paging.offset });
    return {
      data: result.rows.map((row) => ({ ...row, memberCount: services.teams.memberCount(row.id) })),
      pagination: { page: paging.page, perPage: paging.perPage, total: result.total, totalPages: Math.ceil(result.total / paging.perPage), hasMore: paging.offset + paging.limit < result.total },
    };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/teams', tags: ['teams'], auth: 'none', summary: 'List teams.' });

  app.get('/api/events/:eventId/teams/mine', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    if (request.ctx.user === null) throw errors.unauthenticated();
    const eventId = eventIdOf(services, params.eventId);
    const team = services.teams.findForUser(eventId, request.ctx.user.id);
    if (team === null) return { team: null };
    return { team, members: services.teams.members(team.id), invitations: services.teams.invitations(team.id).filter((i) => (i as { status: string }).status === 'PENDING') };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/teams/mine', tags: ['teams'], auth: 'session', summary: 'The team you belong to, if any.' });

  app.get('/api/teams/:teamId', async (request) => {
    const params = z.object({ teamId: Id }).parse(request.params);
    const team = services.teams.require(params.teamId);
    return { ...team, members: services.teams.members(team.id) };
  });
  registry.register({ method: 'GET', path: '/api/teams/{teamId}', tags: ['teams'], auth: 'none', summary: 'One team and its members.' });

  app.patch('/api/teams/:teamId', async (request) => {
    const params = z.object({ teamId: Id }).parse(request.params);
    requirePermission(services, request.ctx, 'team', 'update', { ownerId: services.teams.require(params.teamId).captain_id }, { resourceType: 'team', resourceId: params.teamId });
    const body = z.object({ name: z.string().min(2).max(100).optional(), description: z.string().max(2000).optional(), organization: z.string().max(200).optional(), trackId: Id.nullable().optional() }).parse(request.body);
    return services.teams.update(params.teamId, body, ctx(request));
  });
  registry.register({
    method: 'PATCH', path: '/api/teams/{teamId}', tags: ['teams'], auth: 'session',
    summary: 'Edit your team.', permission: { resource: 'team', action: 'update' },
    errors: ['FORBIDDEN', 'DEADLINE_PASSED'],
  });

  app.post('/api/teams/:teamId/invitations', async (request, reply) => {
    const params = z.object({ teamId: Id }).parse(request.params);
    requirePermission(services, request.ctx, 'team', 'update', { ownerId: services.teams.require(params.teamId).captain_id }, { resourceType: 'team', resourceId: params.teamId });
    const body = z.object({ email: z.email().optional(), username: z.string().max(32).optional() }).parse(request.body);
    const invitation = services.teams.invite(params.teamId, body, ctx(request));
    return reply.status(201).send({ ...invitation, url: `${services.config.publicUrl}/invite/${(invitation as { code: string }).code}` });
  });
  registry.register({ method: 'POST', path: '/api/teams/{teamId}/invitations', tags: ['teams'], auth: 'session', summary: 'Invite someone to your team.', permission: { resource: 'team', action: 'update' } });

  app.get('/api/invitations/:code', async (request) => {
    const params = z.object({ code: z.string().min(4).max(16) }).parse(request.params);
    const invitation = services.teams.findInvitationByCode(params.code);
    if (invitation === null) throw errors.notFound('Invitation', params.code);
    const row = invitation as { team_name: string; event_name: string; event_slug: string; email: string; status: string; expires_at: string };
    // The invited address is not disclosed to an anonymous caller.
    return {
      team: { name: row.team_name },
      event: { name: row.event_name, slug: row.event_slug },
      status: row.status,
      expiresAt: row.expires_at,
      ...(request.ctx.user !== null && request.ctx.user.email.toLowerCase() === row.email.toLowerCase()
        ? { forYou: true }
        : { forYou: false, note: 'Sign in with the address this invitation was sent to.' }),
    };
  });
  registry.register({ method: 'GET', path: '/api/invitations/{code}', tags: ['teams'], auth: 'none', summary: 'Preview a team invitation before accepting.' });

  app.post('/api/invitations/:code/accept', async (request) => {
    const params = z.object({ code: z.string().min(4).max(16) }).parse(request.params);
    if (request.ctx.actor === null) throw errors.unauthenticated();
    const team = services.teams.acceptInvitation(params.code, ctx(request));
    return { team, members: services.teams.members(team.id) };
  });
  registry.register({
    method: 'POST', path: '/api/invitations/{code}/accept', tags: ['teams'], auth: 'session',
    summary: 'Accept a team invitation.', permission: { resource: 'team', action: 'update' },
    errors: ['FORBIDDEN', 'CONFLICT', 'WINDOW_CLOSED', 'DEADLINE_PASSED'],
  });

  app.post('/api/invitations/:code/reject', async (request) => {
    const params = z.object({ code: z.string().min(4).max(16) }).parse(request.params);
    if (request.ctx.actor === null) throw errors.unauthenticated();
    services.teams.rejectInvitation(params.code, ctx(request));
    return { rejected: true };
  });
  registry.register({ method: 'POST', path: '/api/invitations/{code}/reject', tags: ['teams'], auth: 'session', summary: 'Decline an invitation.' });

  app.delete('/api/teams/:teamId/members/:userId', async (request, reply) => {
    const params = z.object({ teamId: Id, userId: Id }).parse(request.params);
    const team = services.teams.require(params.teamId);
    requirePermission(services, request.ctx, 'team', 'delete', { ownerId: team.captain_id, teamMember: true }, { resourceType: 'team', resourceId: team.id, eventId: team.event_id });
    services.teams.removeMember(team.id, params.userId, ctx(request));
    return reply.status(204).send();
  });
  registry.register({ method: 'DELETE', path: '/api/teams/{teamId}/members/{userId}', tags: ['teams'], auth: 'session', summary: 'Leave a team or remove a member.', permission: { resource: 'team', action: 'delete' } });

  app.post('/api/teams/:teamId/captain/:userId', async (request) => {
    const params = z.object({ teamId: Id, userId: Id }).parse(request.params);
    requirePermission(services, request.ctx, 'team', 'update', { ownerId: services.teams.require(params.teamId).captain_id }, { resourceType: 'team', resourceId: params.teamId });
    return services.teams.promote(params.teamId, params.userId, ctx(request));
  });
  registry.register({ method: 'POST', path: '/api/teams/{teamId}/captain/{userId}', tags: ['teams'], auth: 'session', summary: 'Transfer captaincy.', permission: { resource: 'team', action: 'update' } });

  app.post('/api/teams/:teamId/override', async (request) => {
    const params = z.object({ teamId: Id }).parse(request.params);
    const team = services.teams.require(params.teamId);
    requirePermission(services, request.ctx, 'team', 'override', { inOrganizedEvent: canManageEvent(request.ctx.actor, team.event_id) }, { resourceType: 'team', resourceId: team.id, eventId: team.event_id });
    const body = z.object({ action: z.enum(['add', 'remove']), userId: Id, reason: z.string().min(8).max(500) }).parse(request.body);
    services.teams.override(team.id, body.action, body.userId, body.reason, ctx(request));
    return { applied: true, note: 'The override and its reason are recorded in the audit ledger.' };
  });
  registry.register({
    method: 'POST', path: '/api/teams/{teamId}/override', tags: ['teams'], auth: 'organizer',
    summary: 'Add or remove a member on a frozen team under a written justification.',
    permission: { resource: 'team', action: 'override' },
  });
}

/* ============================================================ submissions */

const SubmissionBody = z.object({
  projectName: z.string().min(2).max(160).optional(),
  shortDescription: z.string().max(400).optional(),
  fullDescription: z.string().max(20_000).optional(),
  problem: z.string().max(10_000).optional(),
  solution: z.string().max(10_000).optional(),
  technologies: z.array(z.string().max(60)).max(40).optional(),
  trackId: Id.nullable().optional(),
  repositoryUrl: z.url().max(2048).nullable().optional(),
  demoUrl: z.url().max(2048).nullable().optional(),
  videoUrl: z.url().max(2048).nullable().optional(),
  documentationUrl: z.url().max(2048).nullable().optional(),
  coverImageUrl: z.url().max(2048).nullable().optional(),
  galleryVisible: z.boolean().optional(),
  eligibleForPrizes: z.boolean().optional(),
});

export function registerSubmissionRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.post('/api/events/:eventId/submissions', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    if (request.ctx.actor === null) throw errors.unauthenticated();
    const eventId = eventIdOf(services, params.eventId);
    const body = SubmissionBody.extend({ teamId: Id.nullable() }).parse(request.body);
    requirePermission(services, request.ctx, 'submission', 'create', { ownerId: request.ctx.user?.id ?? null, inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'submission' });
    const submission = services.submissions.create(eventId, body.teamId ?? null, body, ctx(request));
    return reply.status(201).send(serializeProject(submission));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/submissions', tags: ['submissions'], auth: 'session',
    summary: 'Start a draft submission.', permission: { resource: 'submission', action: 'create' },
    description: 'Creates a DRAFT. Drafts can be saved right up to the deadline; completeness is checked at submit time, not save time.',
    errors: ['CONFLICT', 'FORBIDDEN', 'VALIDATION_FAILED'],
  });

  app.get('/api/events/:eventId/submissions', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = z.object({ state: z.enum(['DRAFT', 'SUBMITTED', 'LOCKED', 'JUDGING', 'FINALIZED']).optional(), trackId: Id.optional(), teamId: Id.optional(), search: z.string().max(100).optional() }).merge(Paging).parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    const paging = normalisePaging(query);
    const isManager = canManageEvent(request.ctx.actor, eventId);
    if (!isManager && request.ctx.user === null) {
      // Public callers see the gallery instead.
      throw errors.forbidden('Use the gallery endpoint to browse projects.');
    }
    const result = services.submissions.listForEvent(eventId, { ...(query.state ? { state: query.state } : {}), ...(query.trackId ? { trackId: query.trackId } : {}), ...(query.teamId ? { teamId: query.teamId } : {}), ...(query.search ? { search: query.search } : {}), limit: paging.limit, offset: paging.offset });
    return {
      data: result.rows.map((row) => serializeProject(row)),
      pagination: { page: paging.page, perPage: paging.perPage, total: result.total, totalPages: Math.ceil(result.total / paging.perPage), hasMore: paging.offset + paging.limit < result.total },
    };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/submissions', tags: ['submissions'], auth: 'organizer', summary: 'The organizer\'s submission list.', permission: { resource: 'submission', action: 'read' } });

  app.get('/api/submissions/:submissionId', async (request) => {
    const params = z.object({ submissionId: Id }).parse(request.params);
    const submission = services.submissions.require(params.submissionId);
    const isOwner = request.ctx.user !== null && (submission.created_by === request.ctx.user.id || (submission.team_id !== null && services.teams.member(submission.team_id, request.ctx.user.id) !== null));
    const isManager = canManageEvent(request.ctx.actor, submission.event_id);
    if (!isOwner && !isManager) {
      // Fall through to the public gallery, which enforces gallery visibility.
      return services.gallery.detail(submission.event_id, submission.slug, ctx(request));
    }
    return {
      ...serializeProject(submission),
      team: submission.team_id ? services.teams.require(submission.team_id) : null,
      members: submission.team_id ? services.teams.members(submission.team_id) : [],
      screenshots: services.submissions.screenshots(submission.id).map((u) => ({ id: u.id, url: `/api/uploads/${u.id}`, width: u.width, height: u.height })),
      // The real answer, from the same ownership/state/deadline facts
      // `assertEditable` enforces — so a form can disable itself and say why
      // instead of the client re-deriving (and mis-deriving) a server rule.
      ...services.submissions.canEdit(submission, request.ctx.actor, ctx(request)),
    };
  });
  registry.register({ method: 'GET', path: '/api/submissions/{submissionId}', tags: ['submissions'], auth: 'none', summary: 'One submission. Owners and organizers see draft fields; everyone else sees the public view.' });

  app.patch('/api/submissions/:submissionId', async (request) => {
    const params = z.object({ submissionId: Id }).parse(request.params);
    const submission = services.submissions.require(params.submissionId);
    requirePermission(services, request.ctx, 'submission', 'update', { ownerId: submission.created_by, inOrganizedEvent: canManageEvent(request.ctx.actor, submission.event_id) }, { resourceType: 'submission', resourceId: submission.id, eventId: submission.event_id });
    const body = SubmissionBody.parse(request.body);
    return serializeProject(services.submissions.update(submission.id, body, ctx(request)));
  });
  registry.register({
    method: 'PATCH', path: '/api/submissions/{submissionId}', tags: ['submissions'], auth: 'session',
    summary: 'Edit a draft submission.', permission: { resource: 'submission', action: 'update' },
    description: 'Server-authoritative deadline check: if the submission window has closed this returns 409 DEADLINE_PASSED regardless of what the client believes the time is.',
    errors: ['FORBIDDEN', 'DEADLINE_PASSED', 'VALIDATION_FAILED'],
  });

  app.post('/api/submissions/:submissionId/submit', async (request) => {
    const params = z.object({ submissionId: Id }).parse(request.params);
    const submission = services.submissions.require(params.submissionId);
    requirePermission(services, request.ctx, 'submission', 'update', { ownerId: submission.created_by, inOrganizedEvent: canManageEvent(request.ctx.actor, submission.event_id) }, { resourceType: 'submission', resourceId: submission.id, eventId: submission.event_id });
    const body = z.object({ override: z.boolean().default(false), reason: z.string().max(500).optional() }).parse(request.body ?? {});
    return serializeProject(services.submissions.submit(submission.id, body, ctx(request)));
  });
  registry.register({
    method: 'POST', path: '/api/submissions/{submissionId}/submit', tags: ['submissions'], auth: 'session',
    summary: 'Submit the project for judging.', permission: { resource: 'submission', action: 'update' },
    description: 'Runs the completeness check and the deadline check. After the deadline only an organizer override succeeds, and the override is audited.',
    errors: ['DEADLINE_PASSED', 'VALIDATION_FAILED', 'ILLEGAL_TRANSITION'],
  });

  app.post('/api/submissions/:submissionId/withdraw', async (request) => {
    const params = z.object({ submissionId: Id }).parse(request.params);
    const submission = services.submissions.require(params.submissionId);
    requirePermission(services, request.ctx, 'submission', 'update', { ownerId: submission.created_by }, { resourceType: 'submission', resourceId: submission.id, eventId: submission.event_id });
    return serializeProject(services.submissions.withdraw(submission.id, ctx(request)));
  });
  registry.register({ method: 'POST', path: '/api/submissions/{submissionId}/withdraw', tags: ['submissions'], auth: 'session', summary: 'Pull a submitted project back to draft (inside the window only).', permission: { resource: 'submission', action: 'update' } });

  app.post('/api/submissions/:submissionId/transition', async (request) => {
    const params = z.object({ submissionId: Id }).parse(request.params);
    const submission = services.submissions.require(params.submissionId);
    requirePermission(services, request.ctx, 'submission', 'update', { inOrganizedEvent: canManageEvent(request.ctx.actor, submission.event_id) }, { resourceType: 'submission', resourceId: submission.id, eventId: submission.event_id });
    const body = z.object({ to: z.enum(['DRAFT', 'SUBMITTED', 'LOCKED', 'JUDGING', 'FINALIZED']), override: z.boolean().default(false), reason: z.string().max(500).optional() }).parse(request.body);
    return serializeProject(services.submissions.transition(submission.id, body.to, body, ctx(request)));
  });
  registry.register({ method: 'POST', path: '/api/submissions/{submissionId}/transition', tags: ['submissions'], auth: 'organizer', summary: 'Move a submission through its lifecycle.', permission: { resource: 'submission', action: 'update' }, errors: ['ILLEGAL_TRANSITION'] });

  app.get('/api/submissions/:submissionId/versions', async (request) => {
    const params = z.object({ submissionId: Id }).parse(request.params);
    const submission = services.submissions.require(params.submissionId);
    requirePermission(services, request.ctx, 'submissionVersion', 'read', { ownerId: submission.created_by, inOrganizedEvent: canManageEvent(request.ctx.actor, submission.event_id) }, { resourceType: 'submission', resourceId: submission.id, eventId: submission.event_id });
    return {
      data: services.submissions.versions(submission.id),
      note: 'The final version is frozen at the deadline and cannot be edited or deleted — enforced by a database trigger.',
    };
  });
  registry.register({ method: 'GET', path: '/api/submissions/{submissionId}/versions', tags: ['submissions'], auth: 'session', summary: 'Immutable version history.', permission: { resource: 'submissionVersion', action: 'read' } });

  app.get('/api/submissions/:submissionId/versions/:version', async (request) => {
    const params = z.object({ submissionId: Id, version: z.coerce.number().int().min(1) }).parse(request.params);
    const submission = services.submissions.require(params.submissionId);
    requirePermission(services, request.ctx, 'submissionVersion', 'read', { ownerId: submission.created_by, inOrganizedEvent: canManageEvent(request.ctx.actor, submission.event_id) }, { resourceType: 'submission', resourceId: submission.id, eventId: submission.event_id });
    const version = services.submissions.version(submission.id, params.version);
    if (version === null) throw errors.notFound('Submission version', String(params.version));
    return { ...(version as Record<string, unknown>), snapshot: JSON.parse((version as { snapshot: string }).snapshot) };
  });
  registry.register({ method: 'GET', path: '/api/submissions/{submissionId}/versions/{version}', tags: ['submissions'], auth: 'session', summary: 'One version snapshot.', permission: { resource: 'submissionVersion', action: 'read' } });
}

/* ================================================================ gallery */

export function registerGalleryRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.get('/api/events/:eventId/gallery', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = z.object({ search: z.string().max(100).optional(), trackId: Id.optional(), technology: z.string().max(60).optional(), teamId: Id.optional(), sort: z.enum(['GALLERY', 'NAME', 'SUBMISSION', 'VOTES']).optional() }).merge(Paging).parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    const paging = normalisePaging(query);
    return services.gallery.list(eventId, {
      ...(query.search ? { search: query.search } : {}),
      ...(query.trackId ? { trackId: query.trackId } : {}),
      ...(query.technology ? { technology: query.technology } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.sort ? { sort: query.sort } : {}),
      limit: paging.limit,
      offset: paging.offset,
    }, ctx(request));
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/gallery', tags: ['submissions'], auth: 'none',
    summary: 'The public project gallery: search, track and technology filters, pagination.',
    description: 'Randomized ordering is seeded per event per day, so the sequence is stable for a visitor\'s whole day yet differs between days and events.',
  });

  app.get('/api/events/:eventId/gallery/technologies', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    return { data: services.gallery.technologies(eventIdOf(services, params.eventId)) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/gallery/technologies', tags: ['submissions'], auth: 'none', summary: 'Technology facets with counts.' });

  app.get('/api/events/:eventId/gallery/:slug', async (request) => {
    const params = z.object({ eventId: Id, slug: z.string().min(1).max(120) }).parse(request.params);
    return services.gallery.detail(eventIdOf(services, params.eventId), params.slug, ctx(request));
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/gallery/{slug}', tags: ['submissions'], auth: 'none', summary: 'One project page with team, track and screenshots.' });

  app.get('/api/embed/:eventId.json', async (request, reply) => {
    // `limit` is read from the query, not from the path. Parsing it out of
    // `request.params` meant the default always won and `?limit=` was silently
    // ignored - a schema that looks like a query contract and is not one.
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(24) }).parse(request.query);
    const payload = services.gallery.embedPayload(eventIdOf(services, params.eventId), query.limit, ctx(request));
    /*
     * The content type is stated rather than left to Fastify.
     *
     * `.send(JSON.stringify(payload))` sends a *string*, and Fastify labels a
     * string body `text/plain; charset=utf-8`. The payload was correct JSON but
     * the endpoint — whose entire purpose is to be consumed by another site's
     * script — was served as text, so a consumer's `response.json()` threw and
     * the embed silently rendered nothing. Returning the object lets Fastify
     * serialise it as `application/json`.
     */
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('access-control-allow-origin', '*')
      .header('cache-control', 'public, max-age=60')
      .send(payload);
  });
  registry.register({
    method: 'GET', path: '/api/embed/{eventId}.json', tags: ['submissions'], auth: 'none',
    summary: 'Compact JSON for the embeddable widget.',
    description: 'Deliberately CORS-open so an external event site can fetch it, and deliberately small: only fields a card needs. Vote totals are omitted when the event hides them.',
  });
}

/* ================================================================ uploads */

export function registerUploadRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.post('/api/submissions/:submissionId/uploads', async (request, reply) => {
    const params = z.object({ submissionId: Id }).parse(request.params);
    const submission = services.submissions.require(params.submissionId);
    requirePermission(services, request.ctx, 'upload', 'create', { ownerId: submission.created_by, inOrganizedEvent: canManageEvent(request.ctx.actor, submission.event_id) }, { resourceType: 'submission', resourceId: submission.id, eventId: submission.event_id });
    const file = await (request as { file(): Promise<{ filename: string; mimetype: string; toBuffer(): Promise<Buffer> } | undefined> }).file();
    if (file === undefined) throw errors.badRequest('No file was uploaded. Send multipart/form-data with a "file" part.');
    const buffer = await file.toBuffer();
    const upload = await services.uploads.store(
      {
        kind: 'SCREENSHOT',
        filename: file.filename,
        declaredMimeType: file.mimetype,
        data: buffer,
        eventId: submission.event_id,
        submissionId: submission.id,
      },
      ctx(request),
    );
    return reply.status(201).send({ id: upload.id, url: `/api/uploads/${upload.id}`, width: upload.width, height: upload.height, byteSize: upload.byte_size });
  });
  registry.register({
    method: 'POST', path: '/api/submissions/{submissionId}/uploads', tags: ['uploads'], auth: 'session',
    summary: 'Attach a screenshot.', permission: { resource: 'upload', action: 'create' },
    description: 'PNG/JPEG/WEBP/GIF only. The declared type, the file extension and the file\'s magic bytes must all agree, so renaming a script to .png is refused. SVG is rejected outright as a script vector.',
    errors: ['UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE', 'FORBIDDEN'],
  });

  app.get('/api/uploads/:uploadId', async (request, reply) => {
    const params = z.object({ uploadId: Id }).parse(request.params);
    const upload = services.uploads.findById(params.uploadId);
    if (upload === null) throw errors.notFound('Upload', params.uploadId);
    // A screenshot attached to a gallery-visible project is public; anything
    // else needs to be its owner or an organizer of the event.
    const publicProject = upload.submission_id
      ? services.db.get<{ gallery_visible: number; event_id: string; state: string }>('SELECT gallery_visible, event_id, state FROM submissions WHERE id = :id', { id: upload.submission_id })
      : null;
    const isPublic =
      publicProject !== null &&
      publicProject.gallery_visible === 1 &&
      ['SUBMITTED', 'LOCKED', 'JUDGING', 'FINALIZED'].includes(publicProject.state);
    if (!isPublic) {
      // A profile avatar has no event, so there is no event to organise and
      // ownership is the only way in.
      const organises = upload.event_id === null ? false : canManageEvent(request.ctx.actor, upload.event_id);
      requirePermission(services, request.ctx, 'upload', 'read', { ownerId: upload.user_id, inOrganizedEvent: organises }, { resourceType: 'upload', resourceId: upload.id, eventId: upload.event_id });
    }
    const { row, data, serveInline } = await services.uploads.read(upload.id);
    void reply;
    return reply
      .header('content-type', row.mime_type)
      .header('content-length', String(data.byteLength))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=3600')
      .header('content-disposition', `${serveInline ? 'inline' : 'attachment'}; filename="${row.original_name ?? 'download'}"`)
      .send(data);
  });
  registry.register({
    method: 'GET', path: '/api/uploads/{uploadId}', tags: ['uploads'], auth: 'none',
    summary: 'Serve a stored file after an integrity check.',
    description: 'Screenshots on gallery-visible projects are public. Everything else requires ownership or organizer rights. The SHA-256 is verified before the bytes are sent, and `nosniff` plus an explicit disposition are always set.',
  });

  app.delete('/api/uploads/:uploadId', async (request, reply) => {
    const params = z.object({ uploadId: Id }).parse(request.params);
    const upload = services.uploads.require(params.uploadId);
    const organises = upload.event_id === null ? false : canManageEvent(request.ctx.actor, upload.event_id);
    requirePermission(services, request.ctx, 'upload', 'delete', { ownerId: upload.user_id, inOrganizedEvent: organises }, { resourceType: 'upload', resourceId: upload.id, eventId: upload.event_id });
    await services.uploads.remove(upload.id, ctx(request));
    return reply.status(204).send();
  });
  registry.register({ method: 'DELETE', path: '/api/uploads/{uploadId}', tags: ['uploads'], auth: 'session', summary: 'Delete a file.', permission: { resource: 'upload', action: 'delete' } });
}

/* ================================================================ judging */

export function registerJudgingRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  // ---- judges
  app.post('/api/events/:eventId/judges/invite', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'judge', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'judge' });
    const body = z.object({ emails: z.array(z.email()).max(200).optional(), usernames: z.array(z.string().max(32)).max(200).optional(), capacity: z.number().int().min(0).max(500).optional(), note: z.string().max(1000).optional() }).parse(request.body);
    const result = services.judges.invite(eventId, body, ctx(request));
    return reply.status(201).send(result);
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/judges/invite', tags: ['judges'], auth: 'organizer',
    summary: 'Invite judges by email or username.', permission: { resource: 'judge', action: 'create' },
    description: 'Each identifier is handled independently, so one unknown address does not abort the batch. The response lists exactly who was invited and who was skipped and why.',
  });

  app.get('/api/events/:eventId/judges', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = z.object({ state: z.enum(['INVITED', 'ACCEPTED', 'ACTIVE', 'COMPLETED']).optional(), search: z.string().max(100).optional() }).merge(Paging).parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'judge', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'judge' });
    const paging = normalisePaging(query);
    const result = services.judges.list(eventId, { ...(query.state ? { state: query.state } : {}), ...(query.search ? { search: query.search } : {}), limit: paging.limit, offset: paging.offset });
    return {
      data: result.rows,
      workload: services.judges.workload(eventId),
      pagination: { page: paging.page, perPage: paging.perPage, total: result.total, totalPages: Math.ceil(result.total / paging.perPage), hasMore: paging.offset + paging.limit < result.total },
    };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/judges', tags: ['judges'], auth: 'organizer', summary: 'The panel, with per-judge workload and progress.', permission: { resource: 'judge', action: 'read' } });

  app.post('/api/judges/:judgeId/accept', async (request) => {
    const params = z.object({ judgeId: Id }).parse(request.params);
    const body = z.object({ title: z.string().max(120).optional(), organization: z.string().max(200).optional(), expertise: z.array(z.string().max(60)).max(20).optional(), bio: z.string().max(2000).optional() }).parse(request.body ?? {});
    return services.judges.accept(params.judgeId, body, ctx(request));
  });
  registry.register({ method: 'POST', path: '/api/judges/{judgeId}/accept', tags: ['judges'], auth: 'session', summary: 'Accept a judging invitation and complete your profile.', permission: { resource: 'judge', action: 'update' } });

  app.post('/api/judges/:judgeId/transition', async (request) => {
    const params = z.object({ judgeId: Id }).parse(request.params);
    const body = z.object({ to: z.enum(['INVITED', 'ACCEPTED', 'ACTIVE', 'COMPLETED']), override: z.boolean().default(false), reason: z.string().max(500).optional() }).parse(request.body);
    return services.judges.transition(params.judgeId, body.to, body, ctx(request));
  });
  registry.register({ method: 'POST', path: '/api/judges/{judgeId}/transition', tags: ['judges'], auth: 'session', summary: 'Activate, deactivate, reactivate or complete a judge.', permission: { resource: 'judge', action: 'update' } });

  app.patch('/api/judges/:judgeId/capacity', async (request) => {
    const params = z.object({ judgeId: Id }).parse(request.params);
    const judge = services.judges.require(params.judgeId);
    requirePermission(services, request.ctx, 'judge', 'update', { inOrganizedEvent: canManageEvent(request.ctx.actor, judge.event_id) }, { eventId: judge.event_id, resourceType: 'judge', resourceId: judge.id });
    const body = z.object({ capacity: z.number().int().min(0).max(500) }).parse(request.body);
    return services.judges.setCapacity(judge.id, body.capacity, ctx(request));
  });
  registry.register({ method: 'PATCH', path: '/api/judges/{judgeId}/capacity', tags: ['judges'], auth: 'organizer', summary: 'Set how many reviews a judge can take.', permission: { resource: 'judge', action: 'update' } });

  // ---- conflicts
  app.post('/api/events/:eventId/conflicts', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    const body = z.object({
      judgeId: Id,
      projectId: Id.nullable().optional(),
      kind: z.enum(['PARTICIPANT', 'TEAM', 'SUBMISSION', 'ORGANIZATION', 'MENTOR', 'EMPLOYER', 'CUSTOM']),
      severity: z.enum(['HARD', 'SOFT']).default('HARD'),
      subjectKind: z.string().max(32).nullable().optional(),
      subjectId: z.string().max(64).nullable().optional(),
      note: z.string().max(1000).optional(),
    }).parse(request.body);
    // A judge may always declare a conflict against themselves; anyone else
    // needs organizer rights, which the service checks.
    const conflict = services.judges.declareConflict(eventId, body, ctx(request));
    return reply.status(201).send(conflict);
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/conflicts', tags: ['judges'], auth: 'session',
    summary: 'Declare a conflict of interest.',
    description: 'Anyone may declare a conflict against themselves, at any time, including after judging started — blocking it would only encourage concealment. A HARD conflict is never assigned by the engine under any strategy; an organizer who truly must proceed uses the separate, confirmed, audited conflict-override path.',
    errors: ['VALIDATION_FAILED', 'FORBIDDEN'],
  });

  app.get('/api/events/:eventId/conflicts', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = z.object({ judgeId: Id.optional(), projectId: Id.optional() }).parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'conflict', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'conflict' });
    return { data: services.judges.listConflicts(eventId, query) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/conflicts', tags: ['judges'], auth: 'organizer', summary: 'The conflict register.', permission: { resource: 'conflict', action: 'read' } });

  app.delete('/api/conflicts/:conflictId', async (request, reply) => {
    const params = z.object({ conflictId: Id }).parse(request.params);
    const row = services.db.get<{ event_id: string }>('SELECT event_id FROM judge_conflicts WHERE id = :id', { id: params.conflictId });
    if (row === null) throw errors.notFound('Conflict', params.conflictId);
    requirePermission(services, request.ctx, 'conflict', 'delete', { inOrganizedEvent: canManageEvent(request.ctx.actor, row.event_id) }, { eventId: row.event_id, resourceType: 'conflict' });
    services.judges.removeConflict(params.conflictId, ctx(request));
    return reply.status(204).send();
  });
  registry.register({ method: 'DELETE', path: '/api/conflicts/{conflictId}', tags: ['judges'], auth: 'session', summary: 'Withdraw a conflict declaration (audited).', permission: { resource: 'conflict', action: 'delete' } });

  // ---- assignments
  app.post('/api/events/:eventId/assignments/preview', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'assignment', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'assignment' });
    const body = z.object({
      strategy: z.enum(ASSIGNMENT_STRATEGIES as unknown as [string, ...string[]]),
      reviewsPerProject: z.number().int().min(1).max(20).optional(),
      seed: z.string().max(120).optional(),
      trackId: Id.nullable().optional(),
      expertise: z.array(z.string().max(60)).max(20).optional(),
    }).parse(request.body);
    const preview = services.assignments.preview(eventId, { ...body, strategy: body.strategy as AssignmentStrategy }, ctx(request));
    return {
      version: preview.version,
      inputHash: preview.inputHash,
      strategy: preview.strategy,
      seed: preview.seed,
      pairs: preview.pairs,
      summary: preview.summary,
      judgeLoad: preview.judgeLoad,
      projectCoverage: preview.projectCoverage,
      unassignedProjects: preview.unassignedProjects,
      idleJudges: preview.idleJudges,
      excludedJudges: preview.excludedJudges,
      acceptedSoftConflicts: preview.acceptedSoftConflicts,
      enforcedHardConflicts: preview.enforcedHardConflicts,
      note: 'Nothing has been written. Commit with the inputHash to apply exactly this plan; if the panel, project set or conflict register changed in the meantime the commit is refused.',
    };
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/assignments/preview', tags: ['assignments'], auth: 'organizer',
    summary: 'Dry-run the assignment engine. Writes nothing.',
    permission: { resource: 'assignment', action: 'create' },
    description: 'Returns generated pairs, judge load distribution, per-project coverage, unassigned projects, excluded judges, accepted soft conflicts and enforced hard conflicts. The returned inputHash binds the plan to the data it was generated from.',
  });

  app.post('/api/events/:eventId/assignments/commit', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'assignment', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'assignment' });
    const body = z.object({
      strategy: z.enum(ASSIGNMENT_STRATEGIES as unknown as [string, ...string[]]),
      reviewsPerProject: z.number().int().min(1).max(20).optional(),
      seed: z.string().max(120).optional(),
      inputHash: z.string().length(64),
      confirmWarnings: z.boolean().default(false),
    }).parse(request.body);
    const result = services.assignments.commit(eventId, { ...body, strategy: body.strategy as AssignmentStrategy }, ctx(request));
    return { version: result.version, created: result.created, skipped: result.skipped, summary: result.preview.summary };
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/assignments/commit', tags: ['assignments'], auth: 'organizer',
    summary: 'Commit a previewed plan as a new assignment version.',
    permission: { resource: 'assignment', action: 'create' },
    description: 'Refuses if the inputHash no longer matches (the panel or conflicts changed) or if the plan has warnings that have not been explicitly confirmed.',
    errors: ['PRECONDITION_FAILED', 'VALIDATION_FAILED'],
  });

  app.get('/api/events/:eventId/assignments', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = z.object({ judgeId: Id.optional(), submissionId: Id.optional(), status: z.string().max(20).optional() }).merge(Paging).parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'assignment', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'assignment' });
    const paging = normalisePaging(query);
    const result = services.assignments.listForEvent(eventId, { ...(query.judgeId ? { judgeId: query.judgeId } : {}), ...(query.submissionId ? { submissionId: query.submissionId } : {}), ...(query.status ? { status: query.status } : {}), limit: paging.limit, offset: paging.offset });
    return {
      data: result.rows,
      currentVersion: services.assignments.currentVersion(eventId),
      coverage: services.assignments.coverage(eventId),
      pagination: { page: paging.page, perPage: paging.perPage, total: result.total, totalPages: Math.ceil(result.total / paging.perPage), hasMore: paging.offset + paging.limit < result.total },
    };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/assignments', tags: ['assignments'], auth: 'organizer', summary: 'Committed assignments and per-project coverage.', permission: { resource: 'assignment', action: 'read' } });

  app.post('/api/assignments/:assignmentId/reassign', async (request) => {
    const params = z.object({ assignmentId: Id }).parse(request.params);
    const assignment = services.assignments.findById(params.assignmentId);
    if (assignment === null) throw errors.notFound('Assignment', params.assignmentId);
    requirePermission(services, request.ctx, 'assignment', 'update', { inOrganizedEvent: canManageEvent(request.ctx.actor, assignment.event_id) }, { eventId: assignment.event_id, resourceType: 'judgeAssignment', resourceId: assignment.id });
    const body = z.object({ toJudgeId: Id.nullable(), reason: z.string().min(8).max(500) }).parse(request.body);
    const result = services.assignments.reassign(assignment.id, body, ctx(request));
    return { from: result.from?.judge_id ?? null, to: result.to?.judge_id ?? null };
  });
  registry.register({
    method: 'POST', path: '/api/assignments/{assignmentId}/reassign', tags: ['assignments'], auth: 'organizer',
    summary: 'Move a review to another judge.', permission: { resource: 'assignment', action: 'update' },
    description: 'Requires a written reason, refuses to move a review that was already submitted, and refuses a judge with a hard conflict on that project.',
    errors: ['CONFLICT_OF_INTEREST', 'VALIDATION_FAILED', 'CONFLICT'],
  });

  app.post('/api/assignments/:assignmentId/conflict-override', async (request) => {
    const params = z.object({ assignmentId: Id }).parse(request.params);
    const assignment = services.assignments.findById(params.assignmentId);
    if (assignment === null) throw errors.notFound('Assignment', params.assignmentId);
    requirePermission(services, request.ctx, 'conflict', 'override', { inOrganizedEvent: canManageEvent(request.ctx.actor, assignment.event_id) }, { eventId: assignment.event_id, resourceType: 'judgeAssignment' });
    const body = z.object({ judgeId: Id, submissionId: Id, reason: z.string().min(15).max(1000), confirm: z.literal(true) }).parse(request.body);
    return services.assignments.overrideConflict(assignment.event_id, body, ctx(request));
  });
  registry.register({
    method: 'POST', path: '/api/assignments/{assignmentId}/conflict-override', tags: ['assignments'], auth: 'organizer',
    summary: 'Assign a conflicted judge with an explicit, audited justification.',
    permission: { resource: 'conflict', action: 'override' },
    description: 'Requires confirm: true and a 15-character justification. Recorded as conflict.override so it can never be mistaken for an engine-generated assignment.',
    errors: ['PRECONDITION_FAILED', 'VALIDATION_FAILED'],
  });

  // ---- rubrics
  app.get('/api/events/:eventId/rubrics', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    return { data: services.rubrics.listRubrics(eventIdOf(services, params.eventId)) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/rubrics', tags: ['rubrics'], auth: 'none', summary: 'List rubrics and their active version.' });

  app.post('/api/events/:eventId/rubrics', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'rubric', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'rubric' });
    const body = z.object({
      name: z.string().min(2).max(120),
      description: z.string().max(2000).optional(),
      notes: z.string().max(2000).optional(),
      judgeGuidance: z.string().max(4000).optional(),
      criteria: z.array(z.object({
        key: z.string().max(60).optional(),
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional(),
        weight: z.number().min(0).max(1),
        min: z.number(),
        max: z.number(),
        required: z.boolean().optional(),
        scoringType: z.enum(['INTEGER', 'DECIMAL', 'BOOLEAN']).optional(),
        publishBreakdown: z.boolean().optional(),
      })).min(1).max(30),
    }).parse(request.body);
    const version = services.rubrics.createRubric(eventId, body, ctx(request));
    return reply.status(201).send({ ...version, criteria: services.rubrics.criteria(version.id) });
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/rubrics', tags: ['rubrics'], auth: 'organizer',
    summary: 'Create a rubric and activate version 1.', permission: { resource: 'rubric', action: 'create' },
    description: 'Weights must be fractions summing to 1.0 (30% is written 0.30); every criterion needs max > min; at least one criterion must be required. Invalid rubrics are rejected before anything is written.',
    errors: ['VALIDATION_FAILED', 'IMMUTABLE'],
  });

  app.get('/api/rubrics/:rubricId/versions', async (request) => {
    const params = z.object({ rubricId: Id }).parse(request.params);
    const rubric = services.db.get<{ event_id: string }>('SELECT event_id FROM rubrics WHERE id = :id', { id: params.rubricId });
    if (rubric === null) throw errors.notFound('Rubric', params.rubricId);
    requirePermission(services, request.ctx, 'rubric', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, rubric.event_id) }, { eventId: rubric.event_id, resourceType: 'rubric' });
    const versions = services.rubrics.listVersions(params.rubricId);
    return {
      data: versions.map((row) => ({
        ...row,
        // Criteria are the questions. Without them a version history is a list
        // of numbers, and the organizer needs to see which version asked what.
        criteria: services.rubrics.criteria(row.id),
      })),
      note: 'A version is DRAFT while it can still be edited and LOCKED once any score exists against it. Changing the questions therefore means publishing a new version; every review keeps the version it was started against.',
    };
  });
  registry.register({
    method: 'GET', path: '/api/rubrics/{rubricId}/versions', tags: ['rubrics'], auth: 'organizer',
    summary: 'Every version of a rubric, with its criteria and lock state.',
    permission: { resource: 'rubric', action: 'read' },
  });

  app.post('/api/rubrics/:rubricId/versions', async (request, reply) => {
    const params = z.object({ rubricId: Id }).parse(request.params);
    const rubric = services.db.get<{ event_id: string }>('SELECT event_id FROM rubrics WHERE id = :id', { id: params.rubricId });
    if (rubric === null) throw errors.notFound('Rubric', params.rubricId);
    requirePermission(services, request.ctx, 'rubric', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, rubric.event_id) }, { eventId: rubric.event_id, resourceType: 'rubric' });
    const body = z.object({ criteria: z.array(z.object({ key: z.string().max(60).optional(), name: z.string().min(1).max(120), description: z.string().max(2000).optional(), weight: z.number().min(0).max(1), min: z.number(), max: z.number(), required: z.boolean().optional(), scoringType: z.enum(['INTEGER', 'DECIMAL', 'BOOLEAN']).optional(), publishBreakdown: z.boolean().optional() })).min(1).max(30), notes: z.string().max(2000).optional(), judgeGuidance: z.string().max(4000).optional(), activate: z.boolean().default(true) }).parse(request.body);
    const version = services.rubrics.createVersion(params.rubricId, body, ctx(request));
    return reply.status(201).send({ ...version, criteria: services.rubrics.criteria(version.id) });
  });
  registry.register({ method: 'POST', path: '/api/rubrics/{rubricId}/versions', tags: ['rubrics'], auth: 'organizer', summary: 'Add a rubric version. The previous one is retained unchanged.', permission: { resource: 'rubric', action: 'create' }, errors: ['IMMUTABLE'] });

  app.patch('/api/rubric-versions/:versionId', async (request) => {
    const params = z.object({ versionId: Id }).parse(request.params);
    const version = services.rubrics.requireVersion(params.versionId);
    requirePermission(services, request.ctx, 'rubric', 'update', { inOrganizedEvent: canManageEvent(request.ctx.actor, version.event_id) }, { eventId: version.event_id, resourceType: 'rubricVersion' });
    const body = z.object({ notes: z.string().max(2000).optional(), judgeGuidance: z.string().max(4000).optional(), tieBreakPriority: z.array(z.string().max(60)).max(30).optional() }).parse(request.body);
    return services.rubrics.updateVersion(version.id, body, ctx(request));
  });
  registry.register({ method: 'PATCH', path: '/api/rubric-versions/{versionId}', tags: ['rubrics'], auth: 'organizer', summary: 'Edit rubric notes, judge guidance and tie-break priority.', permission: { resource: 'rubric', action: 'update' }, errors: ['IMMUTABLE', 'VALIDATION_FAILED'] });

  app.get('/api/rubric-versions/:versionId', async (request) => {
    const params = z.object({ versionId: Id }).parse(request.params);
    const version = services.rubrics.requireVersion(params.versionId);
    const isJudgeOrManager = canManageEvent(request.ctx.actor, version.event_id) || (request.ctx.user !== null && services.judges.findByUser(version.event_id, request.ctx.user.id) !== null);
    if (!isJudgeOrManager) throw errors.forbidden('Only judges on this event may read the rubric.');
    return services.rubrics.toPublicView(version);
  });
  registry.register({ method: 'GET', path: '/api/rubric-versions/{versionId}', tags: ['rubrics'], auth: 'session', summary: 'The scoring form definition for a rubric version.', permission: { resource: 'rubric', action: 'read' } });

  // ---- scoring
  app.get('/api/events/:eventId/judging/queue', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    if (request.ctx.user === null) throw errors.unauthenticated();
    const judge = services.judges.findByUser(eventId, request.ctx.user.id);
    if (judge === null) throw errors.forbidden('You are not on this event\'s judging panel.');
    // An assignment is owned by the judge it was given to, so `ownerId` is the
    // judge's own user id. Passing only `assignedJudge` satisfies the ASSIGNED
    // scope but not OWN, which is what a judge has for `assignment` — the
    // result being that a judge could not open their own queue.
    requirePermission(services, request.ctx, 'assignment', 'read', { assignedJudge: true, ownerId: judge.user_id }, { eventId, resourceType: 'judge', resourceId: judge.id });
    return services.scoring.queue(eventId, judge.id, ctx(request));
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/judging/queue', tags: ['scoring'], auth: 'session',
    summary: 'Your judging queue, next unfinished review first.',
    permission: { resource: 'assignment', action: 'read' },
    description: 'Returns only projects you are assigned to, with your own review state. There is no field in this payload that could contain another judge\'s score.',
  });

  app.post('/api/assignments/:assignmentId/review', async (request) => {
    const params = z.object({ assignmentId: Id }).parse(request.params);
    const assignment = services.assignments.findById(params.assignmentId);
    if (assignment === null) throw errors.notFound('Assignment', params.assignmentId);
    requirePermission(services, request.ctx, 'score', 'update', { assignedJudge: true }, { eventId: assignment.event_id, resourceType: 'judgeAssignment', resourceId: assignment.id });
    const started = services.scoring.startReview(params.assignmentId, ctx(request));
    return { score: started.score, rubric: started.rubric };
  });
  registry.register({ method: 'POST', path: '/api/assignments/{assignmentId}/review', tags: ['scoring'], auth: 'session', summary: 'Open or resume your review.', permission: { resource: 'score', action: 'update' }, errors: ['FORBIDDEN', 'CONFLICT', 'PRECONDITION_FAILED'] });

  const ReviewBody = z.object({
    criteria: z.array(z.object({ criterionId: Id, value: z.number(), comment: z.string().max(4000).nullable().optional() })).min(1).max(40),
    summary: z.string().max(4000).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
  });

  app.put('/api/assignments/:assignmentId/review', async (request) => {
    const params = z.object({ assignmentId: Id }).parse(request.params);
    const assignment = services.assignments.findById(params.assignmentId);
    if (assignment === null) throw errors.notFound('Assignment', params.assignmentId);
    requirePermission(services, request.ctx, 'score', 'update', { assignedJudge: true }, { eventId: assignment.event_id, resourceType: 'judgeAssignment', resourceId: assignment.id });
    return { score: services.scoring.saveDraft(params.assignmentId, ReviewBody.parse(request.body), ctx(request)) };
  });
  registry.register({
    method: 'PUT', path: '/api/assignments/{assignmentId}/review', tags: ['scoring'], auth: 'session',
    summary: 'Autosave your in-progress review.', permission: { resource: 'score', action: 'update' },
    description: 'Drafts only. Values outside a criterion\'s scale are rejected with 422 rather than clamped.',
    errors: ['FORBIDDEN', 'IMMUTABLE', 'VALIDATION_FAILED'],
  });

  app.post('/api/assignments/:assignmentId/review/submit', async (request) => {
    const params = z.object({ assignmentId: Id }).parse(request.params);
    const assignment = services.assignments.findById(params.assignmentId);
    if (assignment === null) throw errors.notFound('Assignment', params.assignmentId);
    requirePermission(services, request.ctx, 'score', 'update', { assignedJudge: true }, { eventId: assignment.event_id, resourceType: 'judgeAssignment', resourceId: assignment.id });
    return { score: services.scoring.submitReview(params.assignmentId, ReviewBody.parse(request.body), ctx(request)) };
  });
  registry.register({
    method: 'POST', path: '/api/assignments/{assignmentId}/review/submit', tags: ['scoring'], auth: 'session',
    summary: 'Submit your review. It becomes visible to organizers and locks when judging closes.',
    permission: { resource: 'score', action: 'update' },
    errors: ['FORBIDDEN', 'VALIDATION_FAILED', 'WINDOW_CLOSED', 'ILLEGAL_TRANSITION'],
  });

  app.get('/api/assignments/:assignmentId/review', async (request) => {
    const params = z.object({ assignmentId: Id }).parse(request.params);
    const assignment = services.assignments.findById(params.assignmentId);
    if (assignment === null) throw errors.notFound('Assignment', params.assignmentId);
    const isOwner = request.ctx.user !== null && services.judges.require(assignment.judge_id).user_id === request.ctx.user.id;
    if (!isOwner && !canManageEvent(request.ctx.actor, assignment.event_id)) {
      // Invariant: a judge can never read another judge's review.
      throw errors.forbidden('That review belongs to another judge.');
    }
    if (isOwner) return services.scoring.ownReview(assignment.id, ctx(request));
    const score = services.db.get<{ id: string }>('SELECT id FROM scores WHERE assignment_id = :a', { a: assignment.id });
    if (score === null) throw errors.notFound('Review', assignment.id);
    return services.scoring.reviewForOrganizer(score.id, ctx(request));
  });
  registry.register({ method: 'GET', path: '/api/assignments/{assignmentId}/review', tags: ['scoring'], auth: 'session', summary: 'Read a review — your own, or any (organizers only).', permission: { resource: 'score', action: 'read' } });

  app.get('/api/events/:eventId/scores', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'score', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'score' });
    return { data: services.scoring.scoreTable(eventId, ctx(request)) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/scores', tags: ['scoring'], auth: 'organizer', summary: 'Organizer score table: coverage, mean, min, max per project.', permission: { resource: 'score', action: 'read' } });

  // ---- pairwise
  app.get('/api/events/:eventId/pairwise/queue', async (request) => {
    // `pairs` is a query parameter; reading it from the path meant `?pairs=` was
    // silently ignored and the queue was always 20 long.
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = z.object({ pairs: z.coerce.number().int().min(1).max(200).default(20) }).parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    if (request.ctx.user === null) throw errors.unauthenticated();
    const judge = services.judges.findByUser(eventId, request.ctx.user.id);
    if (judge === null) throw errors.forbidden('You are not on this event\'s judging panel.');
    requirePermission(services, request.ctx, 'pairwise', 'read', { assignedJudge: true }, { eventId, resourceType: 'judge', resourceId: judge.id });
    return services.scoring.pairwiseQueue(eventId, judge.id, query.pairs, ctx(request));
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/pairwise/queue', tags: ['scoring'], auth: 'session',
    summary: 'Your head-to-head comparison queue.',
    permission: { resource: 'pairwise', action: 'read' },
    description: 'A deterministic round-robin over the projects assigned to you, shuffled with a per-judge seed so a judge can resume where they left off while different judges see different pairings and orientations.',
  });

  app.post('/api/events/:eventId/pairwise', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    if (request.ctx.user === null) throw errors.unauthenticated();
    const body = z.object({ leftSubmissionId: Id, rightSubmissionId: Id, outcome: z.enum(['LEFT', 'RIGHT', 'TIE', 'SKIPPED']), durationMs: z.number().int().min(0).max(86_400_000).optional() }).parse(request.body);
    requirePermission(services, request.ctx, 'pairwise', 'create', { assignedJudge: true }, { eventId, resourceType: 'pair' });
    return reply.status(201).send(services.scoring.recordComparison(eventId, body, ctx(request)));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/pairwise', tags: ['scoring'], auth: 'session',
    summary: 'Record a head-to-head comparison.', permission: { resource: 'pairwise', action: 'create' },
    description: 'Only projects assigned to you may be compared, which stops a judge ranking work they never reviewed.',
  });

  // ---- calibration
  app.post('/api/events/:eventId/calibration', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'calibration', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'calibrationSession' });
    const body = z.object({ name: z.string().min(2).max(120), instructions: z.string().max(4000).optional(), submissionIds: z.array(Id).min(1).max(20), opensAt: z.string().max(40).optional(), closesAt: z.string().max(40).optional() }).parse(request.body);
    return reply.status(201).send(services.scoring.createCalibration(eventId, body, ctx(request)));
  });
  registry.register({ method: 'POST', path: '/api/events/{eventId}/calibration', tags: ['calibration'], auth: 'organizer', summary: 'Open a calibration session on example projects.', permission: { resource: 'calibration', action: 'create' } });

  app.post('/api/calibration/:sessionId/scores', async (request) => {
    const params = z.object({ sessionId: Id }).parse(request.params);
    const body = z.object({ submissionId: Id, criteria: z.array(z.object({ criterionId: Id, value: z.number(), comment: z.string().max(4000).nullable().optional() })).min(1).max(40) }).parse(request.body);
    const session = services.db.get<{ event_id: string }>('SELECT event_id FROM calibration_sessions WHERE id = :id', { id: params.sessionId });
    if (session === null) throw errors.notFound('Calibration session', params.sessionId);
    requirePermission(services, request.ctx, 'calibration', 'update', { inOrganizedEvent: canManageEvent(request.ctx.actor, session.event_id) || services.judges.findByUser(session.event_id, request.ctx.user?.id ?? '') !== null }, { eventId: session.event_id, resourceType: 'calibrationSession' });
    return services.scoring.submitCalibration(params.sessionId, body, ctx(request));
  });
  registry.register({ method: 'POST', path: '/api/calibration/{sessionId}/scores', tags: ['calibration'], auth: 'session', summary: 'Submit a calibration score.', permission: { resource: 'calibration', action: 'update' }, description: 'Diagnostic only: a calibration score never touches a real review and never influences a ranking.' });

  app.get('/api/calibration/:sessionId/report', async (request) => {
    const params = z.object({ sessionId: Id }).parse(request.params);
    const session = services.db.get<{ event_id: string }>('SELECT event_id FROM calibration_sessions WHERE id = :id', { id: params.sessionId });
    if (session === null) throw errors.notFound('Calibration session', params.sessionId);
    requirePermission(services, request.ctx, 'calibration', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, session.event_id) || services.judges.findByUser(session.event_id, request.ctx.user?.id ?? '') !== null }, { eventId: session.event_id, resourceType: 'calibrationSession' });
    return services.scoring.calibrationReport(params.sessionId, ctx(request));
  });
  registry.register({ method: 'GET', path: '/api/calibration/{sessionId}/report', tags: ['calibration'], auth: 'session', summary: 'Panel spread and per-criterion distribution for a calibration session.', permission: { resource: 'calibration', action: 'read' } });
}

/* ================================================================ results */

export function registerResultRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.post('/api/events/:eventId/results/compute', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'result', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'resultRun' });
    const body = z.object({
      normalizationMethod: z.enum(NORMALIZATION_METHODS as unknown as [string, ...string[]]).default('RAW'),
      minimumSampleSize: z.number().int().min(1).max(50).optional(),
      aggregationMethod: z.enum(AGGREGATION_METHODS as unknown as [string, ...string[]]).default('MEAN'),
      trim: z.number().min(0).max(0.5).optional(),
      allowVoteTieBreak: z.boolean().optional(),
      allowPairwiseTieBreak: z.boolean().optional(),
      enablePairwise: z.boolean().default(false),
      notes: z.string().max(500).optional(),
      persist: z.boolean().default(true),
    }).parse(request.body ?? {});

    const run = services.results.compute(
      eventId,
      {
        normalization: { method: body.normalizationMethod as never, ...(body.minimumSampleSize === undefined ? {} : { minimumSampleSize: body.minimumSampleSize }) },
        aggregation: {
          method: body.aggregationMethod as never,
          ...(body.trim === undefined ? {} : { trim: body.trim }),
          ...(body.allowVoteTieBreak === undefined ? {} : { allowVoteTieBreak: body.allowVoteTieBreak }),
          ...(body.allowPairwiseTieBreak === undefined ? {} : { allowPairwiseTieBreak: body.allowPairwiseTieBreak }),
        },
        enablePairwise: body.enablePairwise,
        notes: body.notes ?? '',
      },
      ctx(request),
    );

    if (body.persist) {
      const row = services.results.finalize(eventId, run, { persistNormalization: true }, ctx(request));
      return { runId: row.id, integrityHash: row.integrity_hash, inputHash: row.input_hash, entries: run.entries, prizes: run.prizes, warnings: run.diagnostics.warnings, confidence: run.diagnostics.confidence, provenance: run.provenance };
    }
    return { entries: run.entries, prizes: run.prizes, warnings: run.diagnostics.warnings, confidence: run.diagnostics.confidence, integrityHash: run.integrityHash, inputHash: run.provenance.inputHash };
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/results/compute', tags: ['results'], auth: 'organizer',
    summary: 'Run the result pipeline over the current judged state.',
    permission: { resource: 'result', action: 'create' },
    description: 'RAW -> VALIDATION -> NORMALIZATION -> AGGREGATION -> TIE RESOLUTION -> PRIZES. Raw scores are never modified; the normalization method is an explicit, stored, reproducible choice. The run records the engine version, every configuration hash and an integrity hash over the ranking.',
  });

  app.post('/api/events/:eventId/results/:runId/snapshot', async (request, reply) => {
    const params = z.object({ eventId: Id, runId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'result', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'resultSnapshot' });
    const body = z.object({ correctionReason: z.string().max(1000).optional(), supersedesId: Id.optional() }).parse(request.body ?? {});
    const snapshot = services.results.createSnapshot(eventId, params.runId, body, ctx(request));
    return reply.status(201).send(snapshot);
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/results/{runId}/snapshot', tags: ['results'], auth: 'organizer',
    summary: 'Freeze a computed run as an immutable snapshot.',
    permission: { resource: 'result', action: 'create' },
    description: 'Snapshots are sequenced and append-only. A correction creates a new snapshot that supersedes the old one; database triggers refuse to modify or delete a published snapshot.',
  });

  app.post('/api/events/:eventId/results/snapshots/:snapshotId/publish', async (request) => {
    const params = z.object({ eventId: Id, snapshotId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'result', 'publish', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'resultSnapshot', resourceId: params.snapshotId });
    const body = z.object({ override: z.boolean().default(false), reason: z.string().max(500).optional() }).parse(request.body ?? {});
    return services.results.publish(eventId, params.snapshotId, { ...ctx(request), override: body.override });
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/results/snapshots/{snapshotId}/publish', tags: ['results'], auth: 'organizer',
    summary: 'Publish a snapshot. Reproduces it first and refuses if it does not match.',
    permission: { resource: 'result', action: 'publish' },
    description: 'Publication recomputes the pipeline from the stored scores and compares against the snapshot. A mismatch returns 412 with a field-level diff and the snapshot stays unpublished. Results are also held back while the community voting window is open: publishing over a live vote requires override and is written to the audit ledger.',
    errors: ['PRECONDITION_FAILED', 'CONFLICT', 'FORBIDDEN'],
  });

  app.post('/api/events/:eventId/results/snapshots/:snapshotId/reproduce', async (request) => {
    const params = z.object({ eventId: Id, snapshotId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'result', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'resultSnapshot', resourceId: params.snapshotId });
    return services.results.verify(params.snapshotId, ctx(request));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/results/snapshots/{snapshotId}/reproduce', tags: ['results'], auth: 'organizer',
    summary: 'Recompute a snapshot from stored inputs and report MATCH or a field-level diff.',
    permission: { resource: 'result', action: 'read' },
    description: 'This is the audit operation. Same event, rubric version, assignment version, scores, normalization and aggregation must reproduce the published ranking exactly.',
  });

  app.get('/api/events/:eventId/results/runs', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'result', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'resultRun' });
    return { data: services.results.listRuns(eventId, ctx(request)) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/results/runs', tags: ['results'], auth: 'organizer', summary: 'Computation history.', permission: { resource: 'result', action: 'read' } });

  app.get('/api/events/:eventId/results/snapshots', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'result', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'resultSnapshot' });
    return { data: services.results.listSnapshots(eventId, ctx(request)) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/results/snapshots', tags: ['results'], auth: 'organizer', summary: 'Snapshot history with integrity hashes.', permission: { resource: 'result', action: 'read' } });

  app.get('/api/events/:eventId/results', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    const event = services.events.require(eventId);
    const snapshot = services.results.publishedSnapshot(eventId);
    if (snapshot === null) {
      return { published: false, entries: [], note: 'Results have not been published for this event yet.' };
    }
    if (event.results_visibility === 'PRIVATE') {
      requirePermission(services, request.ctx, 'result', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'resultSnapshot' });
    }
    const entries = services.results.entries(snapshot.id) as Record<string, unknown>[];
    return {
      published: true,
      snapshot: {
        id: snapshot.id,
        sequence: Number(snapshot.sequence),
        publishedAt: snapshot.published_at,
        integrityHash: snapshot.integrity_hash,
        entryCount: Number(snapshot.entry_count),
        isCorrection: snapshot.is_correction === 1,
      },
      showJudgeCount: event.results_publish_judge_count === 1,
      showCriterionBreakdown: event.results_publish_criterion_breakdown === 1,
      entries: entries.map((entry) => ({
        rank: entry.rank,
        projectId: entry.submission_id,
        projectName: entry.projectName,
        slug: entry.slug,
        shortDescription: entry.shortDescription,
        technologies: safeArray(String(entry.technologies ?? '[]')),
        repositoryUrl: entry.repositoryUrl,
        demoUrl: entry.demoUrl,
        coverImageUrl: entry.coverImageUrl,
        track: entry.trackName,
        trackColor: entry.trackColor,
        aggregateScore: entry.aggregate_score,
        rawAggregate: entry.raw_aggregate,
        rankDelta: entry.rank_delta,
        judgeCount: event.results_publish_judge_count === 1 ? entry.judge_count : null,
        coverage: entry.coverage,
        validation: entry.validation,
        prizes: safeArray(String(entry.prizes ?? '[]')),
        criteria: event.results_publish_criterion_breakdown === 1 ? safeArray(String(entry.criteria ?? '[]')) : [],
        notes: safeArray(String(entry.notes ?? '[]')),
      })),
    };
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/results', tags: ['results'], auth: 'none',
    summary: 'Published results for the public results page.',
    description: 'Criterion breakdowns and judge counts are omitted entirely (not merely hidden) when the event disables them, so they cannot be recovered from the network tab.',
  });

  app.get('/api/results/verify/:reference', async (request) => {
    const params = z.object({ reference: z.string().min(4).max(40) }).parse(request.params);
    const [eventId, snapshotId] = params.reference.split('::');
    if (eventId === undefined || snapshotId === undefined) throw errors.badRequest('Expected a reference of the form eventId::snapshotId.');
    return services.results.verifyPublic(eventIdOf(services, eventId), snapshotId, request.ctx.at);
  });
  registry.register({
    method: 'GET', path: '/api/results/verify/{reference}', tags: ['results'], auth: 'none',
    summary: 'Publicly verify a published result snapshot reproduces from its stored inputs.',
  });
}

/* ============================================================== community */

export function registerCommunityRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.post('/api/events/:eventId/votes', { config: { rateLimit: { max: 60, timeWindow: 3_600_000 } } as never }, async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    if (request.ctx.actor === null) throw errors.unauthenticated();
    const eventId = eventIdOf(services, params.eventId);
    const body = z.object({ submissionId: Id }).parse(request.body);
    requirePermission(services, request.ctx, 'vote', 'create', { ownerId: request.ctx.user?.id ?? null }, { eventId, resourceType: 'communityVote', resourceId: body.submissionId });
    return reply.status(201).send(services.community.castVote(eventId, body.submissionId, ctx(request)));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/votes', tags: ['community'], auth: 'session',
    summary: 'Vote for a project. One vote per account per project.',
    permission: { resource: 'vote', action: 'create' },
    description: 'Layered defences: authentication, registration eligibility, no self-voting through team membership, a UNIQUE constraint per (event, project, account), a per-account hourly rate limit and a server-side window. Voting again is a no-op, not a second vote.',
    errors: ['WINDOW_CLOSED', 'CONFLICT_OF_INTEREST', 'FORBIDDEN', 'RATE_LIMITED'],
  });

  app.delete('/api/events/:eventId/votes/:submissionId', async (request) => {
    const params = z.object({ eventId: Id, submissionId: Id }).parse(request.params);
    if (request.ctx.actor === null) throw errors.unauthenticated();
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'vote', 'delete', { ownerId: request.ctx.user?.id ?? null }, { eventId, resourceType: 'communityVote' });
    return services.community.retractVote(eventId, params.submissionId, ctx(request));
  });
  registry.register({ method: 'DELETE', path: '/api/events/{eventId}/votes/{submissionId}', tags: ['community'], auth: 'session', summary: 'Retract your vote.', permission: { resource: 'vote', action: 'delete' } });

  app.get('/api/events/:eventId/votes/mine', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    if (request.ctx.actor === null) throw errors.unauthenticated();
    return services.community.myVotes(eventIdOf(services, params.eventId), ctx(request));
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/votes/mine', tags: ['community'], auth: 'session', summary: 'What you have voted for, and whether you may vote at all.' });

  app.get('/api/events/:eventId/votes/report', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'vote', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'communityVote' });
    return services.community.votingReport(eventId, ctx(request));
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/votes/report', tags: ['community'], auth: 'organizer',
    summary: 'Voting activity for abuse review.', permission: { resource: 'vote', action: 'read' },
    description: 'Concentration and velocity are surfaced for a human to judge. Nothing here is treated as evidence of abuse on its own, and no account is ever auto-disqualified.',
  });

  app.get('/api/submissions/:submissionId/comments', async (request) => {
    /*
     * Paging is read from the query. It used to be merged into the *path*
     * schema, where those keys can never appear, so the defaults always won:
     * every caller got the first 25 comments and there was no way to ask for
     * the rest. A project with a long thread simply had no accessible tail.
     */
    const params = z.object({ submissionId: Id }).parse(request.params);
    const query = z.object({}).merge(Paging).parse(request.query);
    const submission = services.submissions.require(params.submissionId);
    const paging = normalisePaging(query);
    return services.community.listComments(submission.event_id, submission.id, { limit: paging.limit, offset: paging.offset, includeHidden: canManageEvent(request.ctx.actor, submission.event_id) }, ctx(request));
  });
  registry.register({
    method: 'GET', path: '/api/submissions/{submissionId}/comments', tags: ['community'], auth: 'none',
    summary: 'Comments on a project.',
    description: 'Paged with `page` and `perPage`. Hidden comments are included only for organizers.',
  });

  app.post('/api/submissions/:submissionId/comments', async (request, reply) => {
    const params = z.object({ submissionId: Id }).parse(request.params);
    if (request.ctx.actor === null) throw errors.unauthenticated();
    const submission = services.submissions.require(params.submissionId);
    const body = z.object({ body: z.string().min(2).max(2000), parentId: Id.nullable().optional() }).parse(request.body);
    requirePermission(services, request.ctx, 'comment', 'create', { ownerId: request.ctx.user?.id ?? null }, { eventId: submission.event_id, resourceType: 'comment' });
    return reply.status(201).send(services.community.createComment(submission.event_id, submission.id, body, ctx(request)));
  });
  registry.register({
    method: 'POST', path: '/api/submissions/{submissionId}/comments', tags: ['community'], auth: 'session',
    summary: 'Post a comment.', permission: { resource: 'comment', action: 'create' },
    description: 'A first comment from a new account is held for approval. That is the only pre-moderation rule: it blunts drive-by spam without making every commenter from a newcomer wait.',
  });

  app.delete('/api/comments/:commentId', async (request) => {
    const params = z.object({ commentId: Id }).parse(request.params);
    const row = services.db.get<{ event_id: string }>('SELECT event_id FROM comments WHERE id = :id', { id: params.commentId });
    if (row === null) throw errors.notFound('Comment', params.commentId);
    requirePermission(services, request.ctx, 'comment', 'delete', { inOrganizedEvent: canManageEvent(request.ctx.actor, row.event_id) }, { eventId: row.event_id, resourceType: 'comment' });
    return services.community.deleteComment(row.event_id, params.commentId, ctx(request));
  });
  registry.register({ method: 'DELETE', path: '/api/comments/{commentId}', tags: ['community'], auth: 'session', summary: 'Soft-delete a comment. The row is retained for the moderation history.', permission: { resource: 'comment', action: 'delete' } });

  app.post('/api/comments/:commentId/report', async (request) => {
    const params = z.object({ commentId: Id }).parse(request.params);
    if (request.ctx.actor === null) throw errors.unauthenticated();
    const row = services.db.get<{ event_id: string }>('SELECT event_id FROM comments WHERE id = :id', { id: params.commentId });
    if (row === null) throw errors.notFound('Comment', params.commentId);
    const body = z.object({ reason: z.string().min(3).max(200), note: z.string().max(500).optional() }).parse(request.body);
    return services.community.reportComment(row.event_id, params.commentId, body, ctx(request));
  });
  registry.register({ method: 'POST', path: '/api/comments/{commentId}/report', tags: ['community'], auth: 'session', summary: 'Report a comment for moderation.' });

  app.get('/api/events/:eventId/comments/moderation', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'comment', 'moderate', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'comment' });
    return { data: services.community.moderationQueue(eventId, ctx(request)) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/comments/moderation', tags: ['community'], auth: 'organizer', summary: 'Reported and pending comments.', permission: { resource: 'comment', action: 'moderate' } });
}

/* =========================================================== certificates */

export function registerCertificateRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.post('/api/events/:eventId/certificates', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'certificate', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'certificate' });
    const body = z.object({ userId: Id, kind: z.enum(['PARTICIPANT', 'FINALIST', 'WINNER', 'JUDGE']), title: z.string().max(200).optional(), body: z.string().max(2000).optional(), submissionId: Id.nullable().optional(), prizeId: Id.nullable().optional(), awardedAt: z.string().max(40).optional() }).parse(request.body);
    const certificate = services.certificates.issue(eventId, body, ctx(request));
    return reply.status(201).send({ ...certificate, url: `${services.config.publicUrl}/certificates/${certificate.reference}` });
  });
  registry.register({ method: 'POST', path: '/api/events/{eventId}/certificates', tags: ['certificates'], auth: 'organizer', summary: 'Issue one certificate.', permission: { resource: 'certificate', action: 'create' } });

  app.post('/api/events/:eventId/certificates/issue-all', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'certificate', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'certificate' });
    const body = z.object({ includeJudges: z.boolean().default(true), snapshotId: Id.nullable().optional() }).parse(request.body ?? {});
    return services.certificates.issueForEvent(eventId, body, ctx(request));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/certificates/issue-all', tags: ['certificates'], auth: 'organizer',
    summary: 'Issue certificates for winners, finalists, participants and judges.',
    permission: { resource: 'certificate', action: 'create' },
    description: 'Idempotent: re-running issues nothing twice. Also produces verifiable judge participation records.',
  });

  app.get('/api/certificates/:reference', async (request) => {
    const params = z.object({ reference: z.string().min(4).max(40) }).parse(request.params);
    return services.certificates.verify(params.reference);
  });
  registry.register({
    method: 'GET', path: '/api/certificates/{reference}', tags: ['certificates'], auth: 'none',
    summary: 'Verify a certificate. Recomputes its hash and reports VALID, REVOKED, TAMPERED or NOT_FOUND.',
  });

  app.get('/api/certificates/:reference.svg', async (request, reply) => {
    const params = z.object({ reference: z.string().min(4).max(40) }).parse(request.params);
    const row = services.certificates.findByReference(params.reference);
    if (row === null) throw errors.notFound('Certificate', params.reference);
    return reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .header('content-disposition', `inline; filename="certificate-${row.reference}.svg"`)
      .send(services.certificates.render(row));
  });
  registry.register({
    method: 'GET', path: '/api/certificates/{reference}.svg', tags: ['certificates'], auth: 'none',
    summary: 'Render the certificate as deterministic SVG.',
    description: 'Generated locally with no external service, and a pure function of the stored record, so the same certificate always produces the same bytes.',
  });
}

/* =============================================================== webhooks */

export function registerWebhookRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.post('/api/events/:eventId/webhooks', async (request, reply) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'webhook', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'webhook' });
    const body = z.object({ url: z.url().max(2048), description: z.string().max(300).optional(), subscriptions: z.array(z.enum(WEBHOOK_EVENTS as unknown as [string, ...string[]])).min(1), secret: z.string().min(16).max(200).optional() }).parse(request.body);
    const webhook = services.webhooks.create(eventId, { ...body, subscriptions: body.subscriptions as WebhookEvent[] }, ctx(request));
    return reply.status(201).send({ ...webhook, secret: webhook.secret });
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/webhooks', tags: ['webhooks'], auth: 'organizer',
    summary: 'Register a signed outbound webhook.', permission: { resource: 'webhook', action: 'create' },
    description: 'Private, loopback and link-local targets are refused, and the hostname is re-resolved and re-checked before every delivery, so a DNS record that starts pointing at 127.0.0.1 is caught. Redirects are not followed.',
    errors: ['VALIDATION_FAILED', 'FORBIDDEN'],
  });

  app.get('/api/events/:eventId/webhooks', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'webhook', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'webhook' });
    return { data: services.webhooks.list(eventId, ctx(request)) };
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/webhooks', tags: ['webhooks'], auth: 'organizer', summary: 'List webhooks and their recent delivery status.', permission: { resource: 'webhook', action: 'read' } });

  app.get('/api/webhooks/:webhookId/deliveries', async (request) => {
    // `limit` is a query parameter; read from the path it was always the default
    // 50, so an organizer debugging a failing receiver could not ask for more
    // history than the last 50 attempts.
    const params = z.object({ webhookId: Id }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).parse(request.query);
    const webhook = services.webhooks.require(params.webhookId);
    requirePermission(services, request.ctx, 'webhook', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, webhook.event_id) }, { eventId: webhook.event_id, resourceType: 'webhook' });
    return { data: services.webhooks.deliveries(webhook.id, query.limit, ctx(request)) };
  });
  registry.register({ method: 'GET', path: '/api/webhooks/{webhookId}/deliveries', tags: ['webhooks'], auth: 'organizer', summary: 'Delivery history with responses and errors.', permission: { resource: 'webhook', action: 'read' } });

  app.post('/api/webhooks/deliveries/:deliveryId/redeliver', async (request) => {
    const params = z.object({ deliveryId: Id }).parse(request.params);
    const row = services.db.get<{ webhook_id: string; event_id: string }>(
      'SELECT d.webhook_id, w.event_id FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = :id',
      { id: params.deliveryId },
    );
    if (row === null) throw errors.notFound('Delivery', params.deliveryId);
    requirePermission(services, request.ctx, 'webhook', 'update', { inOrganizedEvent: canManageEvent(request.ctx.actor, row.event_id) }, { eventId: row.event_id, resourceType: 'webhookDelivery' });
    return services.webhooks.redeliver(params.deliveryId, ctx(request));
  });
  registry.register({ method: 'POST', path: '/api/webhooks/deliveries/{deliveryId}/redeliver', tags: ['webhooks'], auth: 'organizer', summary: 'Replay a delivery after fixing the receiver.', permission: { resource: 'webhook', action: 'update' } });

  app.delete('/api/webhooks/:webhookId', async (request, reply) => {
    const params = z.object({ webhookId: Id }).parse(request.params);
    const webhook = services.webhooks.require(params.webhookId);
    requirePermission(services, request.ctx, 'webhook', 'delete', { inOrganizedEvent: canManageEvent(request.ctx.actor, webhook.event_id) }, { eventId: webhook.event_id, resourceType: 'webhook' });
    services.webhooks.delete(webhook.id, ctx(request));
    return reply.status(204).send();
  });
  registry.register({ method: 'DELETE', path: '/api/webhooks/{webhookId}', tags: ['webhooks'], auth: 'organizer', summary: 'Delete a webhook.', permission: { resource: 'webhook', action: 'delete' } });
}

/* ========================================================= transfer + ops */

export function registerTransferRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  /*
   * The route used to spell out its own thirteen-item list, in a different order
   * from the service's. Two lists that are supposed to be one list is how six of
   * them ended up disagreeing with the database. One constant, imported from the
   * service that implements them.
   */

  app.get('/api/events/:eventId/exports/manifest', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'export', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'export' });
    return services.transfer.exportManifest(eventId, ctx(request));
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/exports/manifest', tags: ['exports'], auth: 'organizer',
    summary: 'What an export bundle contains: every entity, its row count and its exact columns.',
    permission: { resource: 'export', action: 'read' },
    description: 'Published so a consumer can confirm they received the whole dataset rather than discovering a gap later.',
  });

  app.get('/api/events/:eventId/exports/:kind', async (request, reply) => {
    const params = z.object({ eventId: Id, kind: z.enum(EXPORT_KINDS) }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'export', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'export' });
    const result = services.transfer.exportCsv(eventId, params.kind, ctx(request));
    return sendCsv(reply, result.filename, result.csv);
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/exports/{kind}', tags: ['exports'], auth: 'organizer', summary: 'Export one entity as CSV.', permission: { resource: 'export', action: 'read' } });

  app.get('/api/events/:eventId/exports/:kind.json', async (request, reply) => {
    const params = z.object({ eventId: Id, kind: z.enum(EXPORT_KINDS) }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'export', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'export' });
    const result = services.transfer.exportCsv(eventId, params.kind, ctx(request));
    return sendJson(reply, result.filename.replace(/\.csv$/, '.json'), JSON.stringify({ kind: params.kind, eventId, rows: result.rows, columns: result.csv.split('\r\n')[0], csv: result.csv }, null, 2));
  });
  registry.register({ method: 'GET', path: '/api/events/{eventId}/exports/{kind}.json', tags: ['exports'], auth: 'organizer', summary: 'Export one entity with its schema, as JSON.', permission: { resource: 'export', action: 'read' } });

  const CsvBody = z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true), createAccounts: z.boolean().default(false) });

  app.post('/api/events/:eventId/imports/participants', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'import', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'importJob' });
    const body = CsvBody.parse(request.body);
    return services.transfer.importParticipants(eventId, body.csv, { dryRun: body.dryRun, createAccounts: body.createAccounts }, ctx(request));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/imports/participants', tags: ['imports'], auth: 'organizer',
    summary: 'Bulk-import participants from CSV. Dry run by default.',
    permission: { resource: 'import', action: 'create' },
    description: 'Every row is validated independently and every rejection is reported with its row number, column and reason. A ragged file is refused outright rather than silently padded.',
  });

  app.post('/api/events/:eventId/imports/judges', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'import', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'importJob' });
    const body = CsvBody.extend({ capacity: z.number().int().min(0).max(500).optional() }).parse(request.body);
    return services.transfer.importJudges(eventId, body.csv, { dryRun: body.dryRun, ...(body.capacity === undefined ? {} : { capacity: body.capacity }) }, ctx(request));
  });
  registry.register({ method: 'POST', path: '/api/events/{eventId}/imports/judges', tags: ['imports'], auth: 'organizer', summary: 'Bulk-import judges from CSV. Dry run by default.', permission: { resource: 'import', action: 'create' } });

  app.post('/api/events/:eventId/imports/teams', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'import', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'importJob' });
    const body = CsvBody.parse(request.body);
    return services.transfer.importTeams(eventId, body.csv, { dryRun: body.dryRun }, ctx(request));
  });
  registry.register({ method: 'POST', path: '/api/events/{eventId}/imports/teams', tags: ['imports'], auth: 'organizer', summary: 'Bulk-import teams from CSV. Dry run by default.', permission: { resource: 'import', action: 'create' } });

  app.post('/api/events/:eventId/imports/submissions', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'import', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'importJob' });
    const body = CsvBody.parse(request.body);
    return services.transfer.importSubmissions(eventId, body.csv, { dryRun: body.dryRun }, ctx(request));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/imports/submissions', tags: ['imports'], auth: 'organizer',
    summary: 'Bulk-import projects from CSV. Dry run by default.',
    permission: { resource: 'import', action: 'create' },
    description: 'Rows are matched to an existing team by the captain\'s email, and land as SUBMITTED so they are in the contest rather than in a draft nobody will open. A row naming an account that is not on a team in this event is rejected with its row number and reason.',
  });
}

export function registerOpsRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  app.get('/api/events/:eventId/audit', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = z.object({ action: z.string().max(60).optional(), actionPrefix: z.string().max(60).optional(), resourceType: z.string().max(40).optional(), resourceId: z.string().max(64).optional(), outcome: z.enum(['SUCCESS', 'DENIED', 'FAILED']).optional(), actorId: Id.optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional() }).merge(Paging).parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'audit', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'audit' });
    const paging = normalisePaging(query);
    const result = services.audit.list({
      eventId,
      ...(query.action ? { action: query.action } : {}),
      ...(query.actionPrefix ? { actionPrefix: query.actionPrefix } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.from ? { from: query.from ?? undefined } : {}),
      ...(query.to ? { to: query.to ?? undefined } : {}),
      limit: paging.limit,
      offset: paging.offset,
    });
    return {
      data: result.rows.map((row) => ({
        id: row.id,
        at: row.created_at,
        actorId: row.actor_id,
        actorRoles: safeArray(row.actor_roles),
        actor: row.actor_label,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        previousState: row.previous_state,
        newState: row.new_state,
        outcome: row.outcome,
        requestId: row.request_id,
        ipAddress: row.ip_address,
        metadata: JSON.parse(row.metadata || '{}') as Record<string, unknown>,
      })),
      actions: services.audit.knownActions(),
      chain: services.audit.chainDigest(),
      pagination: { page: paging.page, perPage: paging.perPage, total: result.total, totalPages: Math.ceil(result.total / paging.perPage), hasMore: paging.offset + paging.limit < result.total },
    };
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/audit', tags: ['audit'], auth: 'organizer',
    summary: 'Query the append-only audit ledger, with a tamper-evidence chain digest.',
    permission: { resource: 'audit', action: 'read' },
    description: 'Database triggers make audit_events append-only. `chain.digest` is a rolling hash over the most recent entries, so an organizer can publish it and later prove no row was edited or removed.',
  });

  app.get('/api/admin/overview', async (request) => {
    requirePermission(services, request.ctx, 'user', 'read', { inOrganizedEvent: false });
    const counts = services.db.tableCounts();
    const users = services.db.get<{ total: number; active: number; suspended: number }>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'ACTIVE' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN state <> 'ACTIVE' THEN 1 ELSE 0 END) AS suspended FROM users",
    );
    return {
      users,
      events: services.db.value<number>('SELECT COUNT(*) AS c FROM events'),
      publishedResults: services.db.value<number>('SELECT COUNT(*) AS c FROM result_snapshots WHERE is_published = 1'),
      openAnomalies: services.db.value<number>("SELECT COUNT(*) AS c FROM anomaly_flags WHERE status = 'OPEN'"),
      webhookFailures: services.db.value<number>('SELECT COUNT(*) AS c FROM webhook_deliveries WHERE status IN (\'FAILED\',\'ABANDONED\')'),
      tables: counts,
      authorizationMatrix: describeMatrix(),
      database: services.db.healthCheck(),
    };
  });
  registry.register({
    method: 'GET', path: '/api/admin/overview', tags: ['admin'], auth: 'admin',
    summary: 'System overview and the live authorization matrix.',
  });

  /*
   * Public on purpose, and that is a product decision rather than an oversight.
   * The platform's whole argument is that a judging result should be auditable
   * rather than trusted, and a permission matrix published in full supports that
   * better than one buried in source: an integrator can see exactly what the
   * model does without reading the code, and an operator can prove there is no
   * hidden back door.
   *
   * It reveals nothing an attacker could not learn by trying the endpoints, and
   * the alternative — gating it behind ADMIN — would make the security model
   * invisible to the people who most need to check it.
   */
  app.get('/api/rbac/matrix', async () => ({ matrix: describeMatrix() }));
  registry.register({
    method: 'GET', path: '/api/rbac/matrix', tags: ['meta'], auth: 'none',
    summary: 'The complete role matrix: which role may do which action on which resource, and at what scope.',
    description:
      'Published so an integrator can see the security model without reading the source. `null` means never granted. Intentionally unauthenticated: the matrix is not a secret, and hiding it would make the model harder to verify.',
  });

  app.post('/api/admin/users/:userId/state', async (request) => {
    const params = z.object({ userId: Id }).parse(request.params);
    requirePermission(services, request.ctx, 'user', 'update');
    if (request.ctx.actor === null) throw errors.unauthenticated();
    const body = z.object({ state: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']) }).parse(request.body);
    services.auth.setUserState(params.userId, body.state, request.ctx.actor, request.ctx.at);
    return services.auth.toPublicUser(services.auth.requireUser(params.userId));
  });
  registry.register({
    method: 'POST', path: '/api/admin/users/{userId}/state', tags: ['admin'], auth: 'admin',
    summary: 'Activate, suspend or deactivate an account. Suspension revokes every session.',
  });

  app.post('/api/admin/users/:userId/roles', async (request) => {
    const params = z.object({ userId: Id }).parse(request.params);
    requirePermission(services, request.ctx, 'user', 'update');
    if (request.ctx.actor === null) throw errors.unauthenticated();
    const body = z.object({ role: z.enum(['PARTICIPANT', 'JUDGE', 'ORGANIZER', 'ADMIN']), eventId: Id.nullable().default(null), revoke: z.boolean().default(false) }).parse(request.body);
    if (body.revoke) {
      services.auth.revokeRole({ userId: params.userId, role: body.role, eventId: body.eventId, actor: request.ctx.actor, at: request.ctx.at });
    } else {
      services.auth.grantRole({ userId: params.userId, role: body.role, eventId: body.eventId, grantedBy: request.ctx.actor.id, at: request.ctx.at });
    }
    return services.auth.toPublicUser(services.auth.requireUser(params.userId));
  });
  registry.register({
    method: 'POST', path: '/api/admin/users/{userId}/roles', tags: ['admin'], auth: 'admin',
    summary: 'Grant or revoke a role. Event-scoped roles (organizer, judge) take an eventId; admin and participant are global.',
  });
}

export { serializeEvent, serializeProject, serializePublicUser, serializeSelf, EVENT_STATES, safeArray };

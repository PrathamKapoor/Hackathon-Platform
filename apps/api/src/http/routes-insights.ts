/**
 * The insight surface: judging diagnostics, review flags, normalization proof,
 * pairwise results, certificates and participation records.
 *
 * Every handler in this file wraps a method that already existed in a service
 * and already had unit tests. None of it had a route, which is the most
 * expensive kind of incompleteness: the work was done, the tests passed, and
 * an organizer still had no way to see any of it. `normalizationComparison`
 * alone is the entire "normalization proof" bonus, unreachable from HTTP.
 *
 * Same rules as the other route modules: thin translation, explicit permission
 * checks, ownership from the loaded row, and a registry entry per route so the
 * published OpenAPI document stays in step with the implementation.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NORMALIZATION_METHODS } from '@verdict/core/types';
import { errors } from '../lib/errors.ts';
import { canManageEvent } from '../lib/rbac.ts';
import { normalisePaging, requirePermission, type RouteRegistry } from './context.ts';
import { actorContext } from '../services/context.ts';
import type { Services } from '../services/context.ts';

/** Tolerant parse for a stored JSON column. A corrupt row must not 500 a list. */
function parseJson(value: string | null): unknown {
  if (value === null || value === '') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

const Id = z.string().min(3).max(64);
const Paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(25),
});

/*
 * Query schemas, named and shared between the handler that enforces them and
 * the registry that documents them. See the note in `routes.ts` for why these
 * are constants rather than inline expressions.
 */
const AnomalyQuery = z
  .object({
    status: z.enum(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'DISMISSED', 'RESOLVED']).optional(),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  })
  .merge(Paging);
const NormalizationMethodQuery = z.object({
  method: z
    .enum(NORMALIZATION_METHODS as unknown as [string, ...string[]])
    .default('Z_SCORE')
    .describe('The alternative method to compare the raw scores against.'),
});
const CertificateListQuery = z
  .object({ kind: z.enum(['PARTICIPANT', 'FINALIST', 'WINNER', 'JUDGE']).optional() })
  .merge(Paging);

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

/**
 * The one place a diagnostic endpoint is allowed to be reachable from, and it
 * is organizer-only. `computeDiagnostics` persists whatever it finds as review
 * flags, so it is a write, not a read: it is POST for that reason and because a
 * GET that silently changes state is a trap for anyone who previews a link.
 */
export function registerInsightRoutes(app: FastifyInstance, services: Services, registry: RouteRegistry): void {
  /* =========================================================== diagnostics */

  app.get('/api/events/:eventId/diagnostics', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'diagnostic', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'judgeDiagnostic' });
    return services.results.readDiagnostics(eventId, ctx(request));
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/diagnostics', tags: ['diagnostics'], auth: 'organizer',
    summary: 'Panel health: per-judge and per-project statistics, and the review signals they raise.',
    permission: { resource: 'diagnostic', action: 'read' },
    description:
      'Reports mean, median, standard deviation, range, completion rate, per-criterion distributions, panel deviation, timing anomalies and repeated scoring patterns. A signal is a request for a human to look, never a finding of misconduct: the platform does not accuse, it points. This is a pure read - it records nothing. Use POST on the same path to file the signals as review flags.',
  });

  app.post('/api/events/:eventId/diagnostics', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'anomaly', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'judgeDiagnostic' });
    return services.results.recordDiagnostics(eventId, ctx(request));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/diagnostics', tags: ['diagnostics'], auth: 'organizer',
    summary: 'Compute panel health and file the signals as review flags.',
    permission: { resource: 'anomaly', action: 'create' },
    description:
      'Runs the same computation as the GET and additionally records every signal as a review flag, so something noticed at 2am is still there in the morning. Flags are deduplicated, so running it twice does not double the register. Requires anomaly:create rather than diagnostic:read, because it is the act of filing something, not of looking.',
  });

  app.get('/api/events/:eventId/anomalies', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = AnomalyQuery.parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'anomaly', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'anomalyFlag' });
    const paging = normalisePaging(query);
    const result = services.results.listAnomalies(
      eventId,
      {
        ...(query.status ? { status: query.status } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        limit: paging.limit,
        offset: paging.offset,
      },
      ctx(request),
    );
    return {
      data: result.rows,
      pagination: { page: paging.page, perPage: paging.perPage, total: result.total, totalPages: Math.ceil(result.total / paging.perPage), hasMore: paging.offset + paging.limit < result.total },
      note: 'Dismissing or resolving a flag requires a written conclusion, which is stored with the flag and audited.',
    };
  });
  registry.register({
      method: 'GET', path: '/api/events/{eventId}/anomalies', tags: ['diagnostics'], auth: 'organizer', querystring: AnomalyQuery,
    summary: 'The review-flag register, filterable by status and severity.', permission: { resource: 'anomaly', action: 'read' },
  });

  app.post('/api/events/:eventId/anomalies/:anomalyId', async (request) => {
    const params = z.object({ eventId: Id, anomalyId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'anomaly', 'update', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'anomalyFlag', resourceId: params.anomalyId });
    const body = z
      .object({
        status: z.enum(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'DISMISSED', 'RESOLVED']),
        resolution: z.string().max(2000).default(''),
      })
      .parse(request.body);
    return services.results.setAnomalyStatus(eventId, params.anomalyId, body.status, body.resolution, ctx(request));
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/anomalies/{anomalyId}', tags: ['diagnostics'], auth: 'organizer',
    summary: 'Acknowledge, investigate, dismiss or resolve a review flag.',
    permission: { resource: 'anomaly', action: 'update' },
    description: 'DISMISSED and RESOLVED both require a written conclusion of at least five characters, so "looked at it, fine" cannot be recorded without saying something.',
    errors: ['VALIDATION_FAILED', 'NOT_FOUND', 'FORBIDDEN'],
  });

  /* ========================================================= normalization */

  app.get('/api/events/:eventId/normalization/comparison', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = NormalizationMethodQuery.parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'normalization', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'normalization' });
    return services.results.normalizationComparison(eventId, query.method as never, ctx(request));
  });
  registry.register({
      method: 'GET', path: '/api/events/{eventId}/normalization/comparison', tags: ['normalization'], auth: 'organizer', querystring: NormalizationMethodQuery,
    summary: 'Raw scoring against one alternative normalization method, project by project.',
    permission: { resource: 'normalization', action: 'read' },
    description:
      'The proof surface for choosing a method. It runs the pipeline twice over the same stored reviews - once RAW, once with the requested method - and reports both scores, both ranks and the rank delta, so the organizer can see exactly which projects moved and why the ordering changed. Judge statistics for the chosen method are included. Raw scores are never modified.',
  });

  app.get('/api/events/:eventId/normalization/runs', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'normalization', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'normalizationRun' });
    return { data: services.results.listNormalizationRuns(eventId, ctx(request)) };
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/normalization/runs', tags: ['normalization'], auth: 'organizer',
    summary: 'Every normalization run recorded for this event, with its configuration hash.',
    permission: { resource: 'normalization', action: 'read' },
    description: 'Each row is a frozen, inspectable artifact: the method, the exact configuration, its hash, the hash of its inputs and the warnings it raised.',
  });

  /* ============================================================== pairwise */

  app.get('/api/events/:eventId/comparisons', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    /*
     * Organizer-only, and deliberately stricter than `ScoringService
     * .listComparisons`, which also admits judges. The query returns
     * comparisons for every judge on the event; pairwise outcomes are judge
     * data, so a judge is not offered the panel's head-to-head record. A judge
     * reads their own history from their comparison queue, which is scoped to
     * them by the assignment check.
     */
    requirePermission(services, request.ctx, 'pairwise', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'pairwiseComparison' });
    const comparisons = services.scoring.listComparisons(eventId, ctx(request));
    const names = new Map(
      services.db
        .all<{ id: string; project_name: string }>('SELECT id, project_name FROM submissions WHERE event_id = :e', { e: eventId })
        .map((row) => [row.id, row.project_name]),
    );
    return {
      data: comparisons.map((comparison) => ({
        ...comparison,
        leftProjectName: names.get(comparison.leftProjectId) ?? comparison.leftProjectId,
        rightProjectName: names.get(comparison.rightProjectId) ?? comparison.rightProjectId,
      })),
      counts: {
        total: comparisons.length,
        decided: comparisons.filter((comparison) => comparison.outcome !== 'SKIPPED').length,
        ties: comparisons.filter((comparison) => comparison.outcome === 'TIE').length,
        skipped: comparisons.filter((comparison) => comparison.outcome === 'SKIPPED').length,
      },
      note: 'Comparisons feed a Bradley-Terry fit when a result run is computed with enablePairwise. Enabling it is an explicit choice recorded in the run provenance.',
    };
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/comparisons', tags: ['scoring'], auth: 'organizer',
    summary: 'Every head-to-head comparison recorded on this event.', permission: { resource: 'pairwise', action: 'read' },
  });

  /* ========================================================= certificates */

  app.get('/api/events/:eventId/certificates', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const query = CertificateListQuery.parse(request.query);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'certificate', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'certificate' });
    const paging = normalisePaging(query);
    /*
     * `CertificateService.list` returns a plain array, not a `{rows, total}`
     * envelope, so the count is taken separately rather than invented from the
     * page. It applies its own limit/offset, so the two stay consistent.
     */
    const rows = services.certificates.list(
      eventId,
      { ...(query.kind ? { kind: query.kind } : {}), limit: paging.limit, offset: paging.offset },
      ctx(request),
    ) as Record<string, unknown>[];
    const total =
      services.db.value<number>(
        `SELECT COUNT(*) AS c FROM certificates WHERE event_id = :e${query.kind ? ' AND kind = :kind' : ''}`,
        query.kind ? { e: eventId, kind: query.kind } : { e: eventId },
      ) ?? 0;
    return {
      data: rows.map((row) => ({
        ...row,
        url: `${services.config.publicUrl}/certificates/${String(row['reference'])}`,
      })),
      pagination: { page: paging.page, perPage: paging.perPage, total, totalPages: Math.ceil(total / paging.perPage), hasMore: paging.offset + paging.limit < total },
    };
  });
  registry.register({
      method: 'GET', path: '/api/events/{eventId}/certificates', tags: ['certificates'], auth: 'organizer', querystring: CertificateListQuery,
    summary: 'Certificates issued for this event, with their verification references.',
    permission: { resource: 'certificate', action: 'read' },
  });

  app.post('/api/events/:eventId/certificates/:certificateId/revoke', async (request) => {
    const params = z.object({ eventId: Id, certificateId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'certificate', 'update', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'certificate', resourceId: params.certificateId });
    const body = z.object({ reason: z.string().min(5).max(500) }).parse(request.body);
    services.certificates.revoke(eventId, params.certificateId, body.reason, ctx(request));
    return { revoked: true, note: 'The certificate still verifies as issued; the public page now reports REVOKED with this reason in the audit ledger.' };
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/certificates/{certificateId}/revoke', tags: ['certificates'], auth: 'organizer',
    summary: 'Revoke a certificate under a written reason.', permission: { resource: 'certificate', action: 'update' },
    description: 'A revoked certificate is not deleted. Its hash still matches, so the record stays honest: it verifies as issued and reports that it was withdrawn.',
    errors: ['VALIDATION_FAILED', 'NOT_FOUND'],
  });

  /* ================================================== participation records */

  app.post('/api/events/:eventId/participation-records', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'participationRecord', 'create', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'participationRecord' });
    const issued = services.certificates.issueParticipationRecords(eventId, ctx(request));
    return {
      issued,
      note: 'A participation record is a verifiable statement of what a person actually did on the panel: how many projects they reviewed, and the hash chain over those reviews. Idempotent.',
    };
  });
  registry.register({
    method: 'POST', path: '/api/events/{eventId}/participation-records', tags: ['certificates'], auth: 'organizer',
    summary: 'Issue verifiable participation records for everyone who took part.',
    permission: { resource: 'participationRecord', action: 'create' },
    description: 'Covers judges, participants and organizers. For a judge the record states the number of reviews they completed and binds them with a hash, so the record cannot be quietly inflated. Re-running issues nothing twice.',
  });

  app.get('/api/events/:eventId/participation-records', async (request) => {
    const params = z.object({ eventId: Id }).parse(request.params);
    const eventId = eventIdOf(services, params.eventId);
    requirePermission(services, request.ctx, 'participationRecord', 'read', { inOrganizedEvent: canManageEvent(request.ctx.actor, eventId) }, { eventId, resourceType: 'participationRecord' });
    /*
     * `judge_participation_records` is the judge's own record — what they were
     * assigned, what they completed, over which window — and `detail` is the
     * JSON snapshot taken at issue time. Both are read-only here: a record is
     * evidence of what happened, so it is never edited after it is written.
     */
    const rows = services.db.all<{
      id: string; judge_id: string; assignment_version: number; reference: string;
      judging_opens_at: string; judging_closes_at: string; assigned_count: number;
      completed_count: number; completion_status: string; detail: string;
      integrity_hash: string; issued_at: string;
    }>(
      `SELECT r.*, u.display_name AS judgeName, u.email AS judgeEmail
       FROM judge_participation_records r JOIN judges j ON j.id = r.judge_id JOIN users u ON u.id = j.user_id
       WHERE r.event_id = :e ORDER BY r.issued_at DESC`,
      { e: eventId },
    );
    return {
      data: rows.map((row) => ({
        id: row.id,
        judgeId: row.judge_id,
        judgeName: (row as unknown as { judgeName: string }).judgeName,
        judgeEmail: (row as unknown as { judgeEmail: string }).judgeEmail,
        assignmentVersion: row.assignment_version,
        reference: row.reference,
        judgingOpensAt: row.judging_opens_at,
        judgingClosesAt: row.judging_closes_at,
        assignedCount: row.assigned_count,
        completedCount: row.completed_count,
        completionStatus: row.completion_status,
        integrityHash: row.integrity_hash,
        issuedAt: row.issued_at,
        detail: parseJson(row.detail),
      })),
    };
  });
  registry.register({
    method: 'GET', path: '/api/events/{eventId}/participation-records', tags: ['certificates'], auth: 'organizer',
    summary: 'Participation records issued for this event.', permission: { resource: 'participationRecord', action: 'read' },
  });

  /*
   * The two routes that make the record worth having.
   *
   * Without them, "publicly verifiable judge participation records" was a claim
   * about a database column: the hash was computed, stored, and never checked by
   * anyone. A judge could not read their own record - the matrix granted
   * `participationRecord: 'OWN'` to JUDGE and PARTICIPANT and no route ever
   * exercised it - and a third party could not check one, because the only read
   * route is organizer-scoped and the public certificate verifier keys on the
   * `certificates` table and returns NOT_FOUND for a `JPR-` code.
   *
   * So: a record holder can verify it, and a judge can get their own. Neither
   * needs an account for the first, and the second needs only their own.
   */
  app.get('/api/participation-records/mine', async (request) => {
    if (request.ctx.user === null) throw errors.unauthenticated();
    const rows = services.certificates.findParticipationForUser(request.ctx.user.id);
    return {
      data: rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        reference: row.reference,
        assignmentVersion: row.assignment_version,
        judgingOpensAt: row.judging_opens_at,
        judgingClosesAt: row.judging_closes_at,
        assignedCount: row.assigned_count,
        completedCount: row.completed_count,
        completionStatus: row.completion_status,
        integrityHash: row.integrity_hash,
        issuedAt: row.issued_at,
        detail: parseJson(row.detail),
        verifyUrl: `/api/participation-records/${row.reference}`,
      })),
    };
  });
  registry.register({
    method: 'GET', path: '/api/participation-records/mine', tags: ['certificates'], auth: 'session',
    summary: 'Your own judge participation records.',
    permission: { resource: 'participationRecord', action: 'read' },
    description: 'The record of what you did on any panel you sat on. Each entry carries a public verification path, so it can be shown to a third party without an account.',
  });

  app.get('/api/participation-records/:reference', async (request) => {
    const params = z.object({ reference: z.string().min(6).max(40) }).parse(request.params);
    return services.certificates.verifyParticipation(params.reference);
  });
  registry.register({
    method: 'GET', path: '/api/participation-records/{reference}', tags: ['certificates'], auth: 'none',
    summary: 'Verify a judge participation record.',
    description: 'Recomputes the record\'s hash from its own contents and reports VALID, TAMPERED or NOT_FOUND. Needs no account: the hash covers the content, so anyone holding the record can check it. This is a content hash rather than a digital signature - it proves the record is unaltered, not which deployment issued it.',
  });

  /* ============================================================ moderation */

  app.post('/api/comments/:commentId/moderate', async (request) => {
    const params = z.object({ commentId: Id }).parse(request.params);
    const row = services.db.get<{ event_id: string }>('SELECT event_id FROM comments WHERE id = :id', { id: params.commentId });
    if (row === null) throw errors.notFound('Comment', params.commentId);
    requirePermission(services, request.ctx, 'comment', 'moderate', { inOrganizedEvent: canManageEvent(request.ctx.actor, row.event_id) }, { eventId: row.event_id, resourceType: 'comment', resourceId: params.commentId });
    const body = z.object({ state: z.enum(['VISIBLE', 'HIDDEN', 'PENDING']), note: z.string().max(500).optional() }).parse(request.body);
    services.community.moderateComment(row.event_id, params.commentId, { state: body.state, ...(body.note === undefined ? {} : { note: body.note }) }, ctx(request));
    return { moderated: true, state: body.state };
  });
  registry.register({
    method: 'POST', path: '/api/comments/{commentId}/moderate', tags: ['community'], auth: 'organizer',
    summary: 'Show, hide or re-queue a comment.', permission: { resource: 'comment', action: 'moderate' },
    description: 'A soft moderation state, not a delete: the row is retained so the moderation history survives.',
  });

  app.post('/api/votes/:voteId/moderate', async (request) => {
    const params = z.object({ voteId: Id }).parse(request.params);
    const row = services.db.get<{ event_id: string }>('SELECT event_id FROM community_votes WHERE id = :id', { id: params.voteId });
    if (row === null) throw errors.notFound('Vote', params.voteId);
    requirePermission(services, request.ctx, 'vote', 'moderate', { inOrganizedEvent: canManageEvent(request.ctx.actor, row.event_id) }, { eventId: row.event_id, resourceType: 'communityVote', resourceId: params.voteId });
    const body = z.object({ reason: z.string().min(5).max(500) }).parse(request.body);
    services.community.moderateVote(row.event_id, params.voteId, body.reason, ctx(request));
    return { moderated: true, note: 'The vote is voided and the reason is recorded. No account is ever removed automatically.' };
  });
  registry.register({
    method: 'POST', path: '/api/votes/{voteId}/moderate', tags: ['community'], auth: 'organizer',
    summary: 'Void a community vote under a written reason.', permission: { resource: 'vote', action: 'moderate' },
  });
}

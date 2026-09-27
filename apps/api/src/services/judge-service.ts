/**
 * Judges, capacity, and conflicts of interest.
 *
 * Conflict handling is the part of a judging platform that is easiest to get
 * wrong and hardest to notice. Three rules:
 *
 *  1. A conflict can be declared against a specific project OR against a
 *     subject (team, participant, organization) that expands to many projects
 *     when the assignment engine runs.
 *  2. HARD conflicts are never assigned. There is no flag in the engine that
 *     changes that; an organizer who genuinely must assign a conflicted judge
 *     uses a separate, explicitly-confirmed, audited override path — so "the
 *     engine assigned a conflicted judge" can never be true.
 *  3. Declaring a conflict is always allowed, by anyone, at any time, including
 *     after judging started. Blocking it would only encourage concealment.
 */

import { newId } from '@verdict/core/ids';
import { assertTransition, type TransitionContext } from '@verdict/core/state-machines';
import { validatePlainText } from '@verdict/core/validation';
import { CONFLICT_KINDS, CONFLICT_SEVERITIES, type ConflictSeverity, type JudgeState } from '@verdict/core/types';
import { errors } from '../lib/errors.ts';
import { canManageEvent } from '../lib/rbac.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';

export type JudgeRow = {
  id: string;
  event_id: string;
  user_id: string;
  state: JudgeState;
  title: string;
  organization: string;
  expertise: string;
  capacity: number;
  bio: string;
  invited_by: string;
  invited_at: string;
  responded_at: string | null;
  activated_at: string | null;
  completed_at: string | null;
  deactivated_at: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
};

export type ConflictRow = {
  id: string;
  event_id: string;
  judge_id: string;
  project_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  kind: string;
  severity: ConflictSeverity;
  note: string;
  declared_by: string;
  created_at: string;
  updated_at: string;
};

export class JudgeService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
  }

  /* ------------------------------------------------------------ invite */

  /**
   * Invite judges. Each address is handled independently so one bad address
   * does not abort the batch, and the result reports exactly what happened.
   */
  invite(
    eventId: string,
    input: { emails?: string[]; usernames?: string[]; capacity?: number; note?: string },
    ctx: ActorContext,
  ): { invited: { userId: string; email: string; judgeId: string }[]; skipped: { identifier: string; reason: string }[] } {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);

    const capacity = Math.max(0, Math.min(500, Math.trunc(input.capacity ?? event.reviews_per_project * 3)));
    const identifiers = [
      ...(input.emails ?? []).map((value) => ({ kind: 'email' as const, value: value.trim().toLowerCase() })),
      ...(input.usernames ?? []).map((value) => ({ kind: 'username' as const, value: value.trim().toLowerCase() })),
    ];

    if (identifiers.length === 0) {
      throw errors.validation('Provide at least one email address or username.', [{ field: 'emails' }]);
    }
    if (identifiers.length > 200) {
      throw errors.validation('Invite at most 200 judges at a time.', [{ field: 'emails' }]);
    }

    const invited: { userId: string; email: string; judgeId: string }[] = [];
    const skipped: { identifier: string; reason: string }[] = [];

    for (const identifier of identifiers) {
      const user =
        identifier.kind === 'email'
          ? this.db.get<{ id: string; email: string }>('SELECT id, email FROM users WHERE email_normalized = :e', { e: identifier.value })
          : this.db.get<{ id: string; email: string }>('SELECT id, email FROM users WHERE username_normalized = :u', { u: identifier.value });

      if (user === null) {
        skipped.push({ identifier: identifier.value, reason: 'no account with that email or username' });
        continue;
      }

      const existing = this.findByUser(eventId, user.id);
      if (existing !== null) {
        skipped.push({
          identifier: identifier.value,
          reason: existing.state === 'INVITED' ? 'already invited' : `already on the panel (${existing.state.toLowerCase()})`,
        });
        continue;
      }

      const id = newId('judge');
      this.db.transaction(() => {
        this.db.exec(
          `INSERT INTO judges (id, event_id, user_id, state, title, capacity, notes, invited_by, invited_at, created_at, updated_at)
           VALUES (:id, :e, :u, 'INVITED', '', :capacity, :notes, :by, :at, :at, :at)`,
          {
            id,
            e: eventId,
            u: user.id,
            capacity,
            notes: (input.note ?? '').slice(0, 1000),
            by: actor.id,
            at: ctx.at,
          },
        );
        this.db.exec(
          `INSERT INTO user_roles (user_id, role, event_id, scope, granted_by, granted_at)
           VALUES (:u, 'JUDGE', :e, :e, :by, :at)`,
          { u: user.id, e: eventId, by: actor.id, at: ctx.at },
        );
        this.audit.record({
          action: 'judge.invited',
          actorId: actor.id,
          actorRoles: actor.roles,
          eventId,
          resourceType: 'judge',
          resourceId: id,
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          newState: 'INVITED',
          metadata: { userId: user.id, email: user.email, capacity },
          at: ctx.at,
        });
      });

      invited.push({ userId: user.id, email: user.email, judgeId: id });
    }

    return { invited, skipped };
  }

  /** The invited judge accepts and completes their profile. */
  accept(judgeId: string, input: { title?: string; organization?: string; expertise?: string[]; bio?: string }, ctx: ActorContext): JudgeRow {
    const actor = requireActor(ctx);
    const judge = this.require(judgeId);
    if (judge.user_id !== actor.id) {
      throw errors.forbidden('Only the invited judge can accept their own invitation.');
    }

    const transitionContext: TransitionContext = { override: false, facts: {}, actor: { id: actor.id, roles: actor.roles } };
    try {
      assertTransition<JudgeState>('Judge', judge.state, 'ACCEPTED', transitionContext);
    } catch (error) {
      throw errors.illegalTransition(error instanceof Error ? error.message : 'not permitted');
    }

    this.db.exec(
      `UPDATE judges SET state = 'ACCEPTED', title = :title, organization = :org, expertise = :expertise,
         bio = :bio, responded_at = :at, updated_at = :at WHERE id = :id`,
      {
        title: validatePlainText(input.title ?? '', { field: 'title', max: 120 }),
        org: validatePlainText(input.organization ?? '', { field: 'organization', max: 200 }),
        expertise: JSON.stringify((input.expertise ?? []).slice(0, 20).map((e) => validatePlainText(e, { field: 'expertise', max: 60 }))),
        bio: validatePlainText(input.bio ?? '', { field: 'bio', max: 2000 }),
        at: ctx.at,
        id: judgeId,
      },
    );

    this.audit.record({
      action: 'judge.accepted',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: judge.event_id,
      resourceType: 'judge',
      resourceId: judgeId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      previousState: judge.state,
      newState: 'ACCEPTED',
      at: ctx.at,
    });

    return this.require(judgeId);
  }

  /** Organizer lifecycle move: activate, deactivate, reactivate, complete. */
  transition(judgeId: string, to: JudgeState, options: { override?: boolean; reason?: string } = {}, ctx: ActorContext): JudgeRow {
    const actor = requireActor(ctx);
    const judge = this.require(judgeId);
    const event = this.events.require(judge.event_id);

    // A judge may always decline their own invitation; an organizer withdrawing
    // someone else's invitation is an override.
    const isSelf = judge.user_id === actor.id;
    if (!isSelf) this.events.assertOrganizer(actor, event, ctx);

    const outstanding = this.outstandingAssignments(judgeId);
    const transitionContext: TransitionContext = {
      override: options.override === true || isSelf,
      facts: { outstandingAssignments: outstanding },
      actor: { id: actor.id, roles: actor.roles },
    };

    try {
      assertTransition<JudgeState>('Judge', judge.state, to, transitionContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'not permitted';
      this.audit.record({
        action: 'judge.state_changed',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: judge.event_id,
        resourceType: 'judge',
        resourceId: judgeId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        outcome: 'DENIED',
        previousState: judge.state,
        newState: to,
        metadata: { reason: message, outstandingAssignments: outstanding },
        at: ctx.at,
      });
      throw errors.illegalTransition(message);
    }

    if (to === 'ACCEPTED' && outstanding > 0) {
      // Reactivating a judge who still has work is fine; the organizer should
      // know, so it is surfaced rather than blocked.
      this.audit.record({
        action: 'judge.state_changed',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: judge.event_id,
        resourceType: 'judge',
        resourceId: judgeId,
        requestId: ctx.requestId,
        metadata: { warning: `${String(outstanding)} assignment(s) still outstanding` },
        at: ctx.at,
      });
    }

    const patch: Record<string, string | null> = { state: to, updated_at: ctx.at };
    if (to === 'ACTIVE') patch.activated_at = ctx.at;
    if (to === 'COMPLETED') patch.completed_at = ctx.at;
    if (to === 'ACCEPTED' && judge.state === 'ACTIVE') patch.deactivated_at = ctx.at;

    this.db.transaction(() => {
      const assignments = Object.keys(patch).map((key) => `"${key}" = :${key}`);
      this.db.exec(`UPDATE judges SET ${assignments.join(', ')} WHERE id = :id`, { ...patch, id: judgeId });
      this.audit.record({
        action: to === 'ACTIVE' && judge.state === 'ACCEPTED' ? 'judge.reactivated' : 'judge.state_changed',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: judge.event_id,
        resourceType: 'judge',
        resourceId: judgeId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        previousState: judge.state,
        newState: to,
        metadata: { ...(options.reason ? { reason: options.reason } : {}), override: options.override === true },
        at: ctx.at,
      });
    });

    return this.require(judgeId);
  }

  updateProfile(judgeId: string, input: { title?: string; organization?: string; expertise?: string[]; bio?: string }, ctx: ActorContext): JudgeRow {
    const actor = requireActor(ctx);
    const judge = this.require(judgeId);
    if (judge.user_id !== actor.id && !canManageEvent(actor as never, judge.event_id)) {
      throw errors.forbidden('Only the judge or an organizer can edit that profile.');
    }
    this.db.exec(
      `UPDATE judges SET title = :title, organization = :org, expertise = :expertise, bio = :bio, updated_at = :at WHERE id = :id`,
      {
        title: validatePlainText(input.title ?? judge.title, { field: 'title', max: 120 }),
        org: validatePlainText(input.organization ?? judge.organization, { field: 'organization', max: 200 }),
        expertise: JSON.stringify((input.expertise ?? safeJson(judge.expertise)).slice(0, 20)),
        bio: validatePlainText(input.bio ?? judge.bio, { field: 'bio', max: 2000 }),
        at: ctx.at,
        id: judgeId,
      },
    );
    return this.require(judgeId);
  }

  setCapacity(judgeId: string, capacity: number, ctx: ActorContext): JudgeRow {
    const actor = requireActor(ctx);
    const judge = this.require(judgeId);
    this.events.assertOrganizer(actor, this.events.require(judge.event_id), ctx);
    const value = Math.max(0, Math.min(500, Math.trunc(capacity)));
    this.db.exec('UPDATE judges SET capacity = :c, updated_at = :at WHERE id = :id', { c: value, at: ctx.at, id: judgeId });
    this.audit.record({
      action: 'judge.state_changed',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: judge.event_id,
      resourceType: 'judge',
      resourceId: judgeId,
      requestId: ctx.requestId,
      previousState: String(judge.capacity),
      newState: String(value),
      metadata: { capacity: value },
      at: ctx.at,
    });
    return this.require(judgeId);
  }

  /* --------------------------------------------------------- conflicts */

  /**
   * Declare a conflict of interest.
   *
   * Anyone may declare a conflict against themselves. An organizer may declare
   * one against any judge (for example, when a judge discloses it verbally).
   */
  declareConflict(
    eventId: string,
    input: { judgeId: string; projectId?: string | null; kind: string; severity?: ConflictSeverity; subjectKind?: string | null; subjectId?: string | null; note?: string },
    ctx: ActorContext,
  ): ConflictRow {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    const judge = this.require(input.judgeId);

    if (judge.event_id !== eventId) throw errors.badRequest('That judge is not on this event\'s panel.');
    if (!CONFLICT_KINDS.includes(input.kind as never)) {
      throw errors.validation('Unknown conflict kind.', [{ field: 'kind', issue: `expected one of ${CONFLICT_KINDS.join(', ')}` }]);
    }
    const severity = input.severity ?? 'HARD';
    if (!CONFLICT_SEVERITIES.includes(severity)) {
      throw errors.validation('Severity must be HARD or SOFT.', [{ field: 'severity' }]);
    }
    if (input.projectId === undefined && !input.subjectId) {
      throw errors.validation('A conflict needs either a specific project or a subject (team, participant, organization).', [
        { field: 'projectId' },
      ]);
    }
    if (input.projectId !== undefined && input.projectId !== null) {
      const project = this.db.get<{ id: string; event_id: string }>('SELECT id, event_id FROM submissions WHERE id = :id', { id: input.projectId });
      if (project === null || project.event_id !== eventId) throw errors.notFound('Project', String(input.projectId));
    }

    const isSelf = judge.user_id === actor.id;
    if (!isSelf) this.events.assertOrganizer(actor, event, ctx);

    const id = newId('judgeConflict');
    this.db.exec(
      `INSERT INTO judge_conflicts (id, event_id, judge_id, project_id, subject_kind, subject_id, kind, severity, note, declared_by, created_at, updated_at)
       VALUES (:id, :e, :j, :p, :subject_kind, :subject_id, :kind, :severity, :note, :by, :at, :at)`,
      {
        id,
        e: eventId,
        j: input.judgeId,
        p: input.projectId ?? null,
        subject_kind: input.subjectKind ?? input.kind,
        subject_id: input.subjectId ?? null,
        kind: input.kind,
        severity,
        note: validatePlainText(input.note ?? '', { field: 'note', max: 1000 }),
        by: actor.id,
        at: ctx.at,
      },
    );

    this.audit.record({
      action: 'conflict.declared',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'judgeConflict',
      resourceId: id,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { judgeId: input.judgeId, projectId: input.projectId ?? null, kind: input.kind, severity, selfDeclared: isSelf },
      at: ctx.at,
    });

    return this.db.get<ConflictRow>('SELECT * FROM judge_conflicts WHERE id = :id', { id })!;
  }

  removeConflict(conflictId: string, ctx: ActorContext): void {
    const actor = requireActor(ctx);
    const conflict = this.db.get<ConflictRow>('SELECT * FROM judge_conflicts WHERE id = :id', { id: conflictId });
    if (conflict === null) throw errors.notFound('Conflict', conflictId);
    const judge = this.require(conflict.judge_id);
    if (judge.user_id !== actor.id && !canManageEvent(actor as never, conflict.event_id)) {
      throw errors.forbidden('Only the judge or an organizer can withdraw a conflict declaration.');
    }
    this.db.exec('DELETE FROM judge_conflicts WHERE id = :id', { id: conflictId });
    this.audit.record({
      action: 'conflict.removed',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: conflict.event_id,
      resourceType: 'judgeConflict',
      resourceId: conflictId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      metadata: { judgeId: conflict.judge_id, kind: conflict.kind, severity: conflict.severity },
      at: ctx.at,
    });
  }

  listConflicts(eventId: string, filter: { judgeId?: string; projectId?: string } = {}): ConflictRow[] {
    const conditions = ['c.event_id = :e'];
    const params: Record<string, string> = { e: eventId };
    if (filter.judgeId) {
      conditions.push('c.judge_id = :j');
      params.j = filter.judgeId;
    }
    if (filter.projectId) {
      conditions.push('c.project_id = :p');
      params.p = filter.projectId;
    }
    return this.db.all<ConflictRow>(
      `SELECT c.* FROM judge_conflicts c WHERE ${conditions.join(' AND ')} ORDER BY c.created_at DESC`,
      params,
    );
  }

  /* ----------------------------------------------------------- queries */

  findById(id: string): JudgeRow | null {
    return this.db.get<JudgeRow>('SELECT * FROM judges WHERE id = :id', { id });
  }

  findByUser(eventId: string, userId: string): JudgeRow | null {
    return this.db.get<JudgeRow>('SELECT * FROM judges WHERE event_id = :e AND user_id = :u', { e: eventId, u: userId });
  }

  require(id: string): JudgeRow {
    const row = this.findById(id);
    if (row === null) throw errors.notFound('Judge', id);
    return row;
  }

  list(eventId: string, filter: { state?: JudgeState; search?: string; limit: number; offset: number }) {
    const conditions = ['j.event_id = :e'];
    const params: Record<string, string | number> = { e: eventId, limit: filter.limit, offset: filter.offset };
    if (filter.state) {
      conditions.push('j.state = :state');
      params.state = filter.state;
    }
    if (filter.search) {
      conditions.push(
        "(LOWER(u.display_name) LIKE :search ESCAPE '\\' OR u.email_normalized LIKE :search ESCAPE '\\' OR LOWER(j.organization) LIKE :search ESCAPE '\\' OR LOWER(j.expertise) LIKE :search ESCAPE '\\')",
      );
      params.search = `%${filter.search.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    }
    const clause = `WHERE ${conditions.join(' AND ')}`;
    const total = this.db.value<number>(`SELECT COUNT(*) AS c FROM judges j JOIN users u ON u.id = j.user_id ${clause}`, params) ?? 0;
    return {
      rows: this.db.all<JudgeRow & { display_name: string; email: string; username: string; assigned: number; completed: number }>(
        `SELECT j.*, u.display_name, u.email, u.username,
                (SELECT COUNT(*) FROM judge_assignments a WHERE a.judge_id = j.id AND a.status IN ('ASSIGNED','IN_PROGRESS','SUBMITTED')) AS assigned,
                (SELECT COUNT(*) FROM judge_assignments a WHERE a.judge_id = j.id AND a.status = 'SUBMITTED') AS completed
         FROM judges j JOIN users u ON u.id = j.user_id
         ${clause} ORDER BY j.state, u.display_name LIMIT :limit OFFSET :offset`,
        params,
      ),
      total,
    };
  }

  /** Count of assignments with no submitted review. */
  outstandingAssignments(judgeId: string): number {
    return (
      this.db.value<number>(
        `SELECT COUNT(*) AS c FROM judge_assignments a
         LEFT JOIN scores s ON s.assignment_id = a.id AND s.state IN ('SUBMITTED','LOCKED')
         WHERE a.judge_id = :j AND a.status IN ('ASSIGNED','IN_PROGRESS') AND s.id IS NULL`,
        { j: judgeId },
      ) ?? 0
    );
  }

  /** Workload and progress for the organizer dashboard and the judge console. */
  workload(eventId: string): {
    judgeId: string;
    displayName: string;
    state: JudgeState;
    capacity: number;
    assigned: number;
    completed: number;
    drafts: number;
    progress: number | null;
    conflicts: number;
  }[] {
    return this.db
      .all<{
        judgeId: string;
        displayName: string;
        state: JudgeState;
        capacity: number;
        assigned: number;
        completed: number;
        drafts: number;
        conflicts: number;
      }>(
        `SELECT j.id AS judgeId, u.display_name AS displayName, j.state, j.capacity,
                (SELECT COUNT(*) FROM judge_assignments a WHERE a.judge_id = j.id AND a.status <> 'REASSIGNED') AS assigned,
                (SELECT COUNT(*) FROM judge_assignments a WHERE a.judge_id = j.id AND a.status = 'SUBMITTED') AS completed,
                (SELECT COUNT(*) FROM scores s WHERE s.judge_id = j.id AND s.state = 'DRAFT') AS drafts,
                (SELECT COUNT(*) FROM judge_conflicts c WHERE c.judge_id = j.id) AS conflicts
         FROM judges j JOIN users u ON u.id = j.user_id
         WHERE j.event_id = :e
         ORDER BY assigned DESC, u.display_name`,
        { e: eventId },
      )
      .map((row) => ({
        ...row,
        capacity: Number(row.capacity),
        assigned: Number(row.assigned),
        completed: Number(row.completed),
        drafts: Number(row.drafts),
        conflicts: Number(row.conflicts),
        progress: row.assigned > 0 ? Math.round((row.completed / row.assigned) * 100) : null,
      }));
  }

  /** Mark judges whose assignments are all submitted. */
  autoCompleteFinishedJudges(eventId: string, at: string): number {
    return this.db.exec(
      `UPDATE judges SET state = 'COMPLETED', completed_at = :at, updated_at = :at
       WHERE event_id = :e AND state = 'ACTIVE'
         AND EXISTS (SELECT 1 FROM judge_assignments a WHERE a.judge_id = judges.id AND a.status IN ('ASSIGNED','IN_PROGRESS'))
         AND NOT EXISTS (
           SELECT 1 FROM judge_assignments a
           LEFT JOIN scores s ON s.assignment_id = a.id AND s.state IN ('SUBMITTED','LOCKED')
           WHERE a.judge_id = judges.id AND a.status IN ('ASSIGNED','IN_PROGRESS') AND s.id IS NULL
         )`,
      { e: eventId, at },
    ).changes;
  }
}

function safeJson(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

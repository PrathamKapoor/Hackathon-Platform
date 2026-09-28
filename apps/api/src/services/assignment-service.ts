/**
 * Assignment generation and commitment.
 *
 * The workflow is deliberately preview-then-confirm:
 *
 *   1. `preview()` reads the panel, the project set and the conflict register
 *      and runs the engine in memory. Nothing is written.
 *   2. The organizer sees coverage, load distribution, unassigned projects,
 *      accepted soft conflicts, and every warning the engine produced.
 *   3. `commit()` writes the preview's pairs as a new assignment *version*.
 *
 * Because the engine is a pure function of (panel, projects, conflicts, seed,
 * strategy), the same preview can be regenerated later and will be identical —
 * which is what makes an assignment defensible after the fact.
 */

import {
  ASSIGNMENT_STRATEGIES,
  generateAssignmentPreview,
  type AssignmentPreview,
  type AssignmentStrategy,
  type ConflictDeclaration,
  type JudgeCandidate,
  type ProjectCandidate,
} from '@verdict/core/assignment';
import { sha256Hex, canonicalJson } from '@verdict/core/integrity';
import { newId } from '@verdict/core/ids';
import { errors } from '../lib/errors.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';

export type AssignmentRow = {
  id: string;
  event_id: string;
  judge_id: string;
  submission_id: string;
  version: number;
  status: 'ASSIGNED' | 'IN_PROGRESS' | 'SUBMITTED' | 'SKIPPED' | 'REASSIGNED';
  strategy: string;
  reason: string;
  soft_conflict: number;
  override_by: string | null;
  assigned_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PreviewRequest = {
  strategy: AssignmentStrategy;
  reviewsPerProject?: number;
  seed?: string;
  /** Restrict to a subset of projects (e.g. one track). */
  trackId?: string | null;
  /** Only include judges with these expertise tags. */
  expertise?: string[];
};

export class AssignmentService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];
  private readonly judges: Services['judges'];
  private readonly submissions: Services['submissions'];
  /** Held for its `webhooks` entry; see the note in `commit`. */
  private readonly services: Services;

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
    this.judges = services.judges;
    this.submissions = services.submissions;
    this.services = services;
  }

  /** Current committed assignment version for an event. */
  currentVersion(eventId: string): number {
    return (
      this.db.value<number>('SELECT COALESCE(MAX(version), 0) AS v FROM judge_assignments WHERE event_id = :e', { e: eventId }) ?? 0
    );
  }

  /**
   * Build a full dry run. Pure with respect to the database: it writes nothing.
   */
  preview(eventId: string, request: PreviewRequest, ctx: ActorContext): AssignmentPreview & { version: number; inputHash: string } {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);

    if (!ASSIGNMENT_STRATEGIES.includes(request.strategy)) {
      throw errors.validation('Unknown assignment strategy.', [
        { field: 'strategy', issue: `expected one of ${ASSIGNMENT_STRATEGIES.join(', ')}` },
      ]);
    }

    const reviewsPerProject = request.reviewsPerProject ?? event.reviews_per_project;
    if (reviewsPerProject < 1 || reviewsPerProject > 20) {
      throw errors.validation('Reviews per project must be between 1 and 20.', [{ field: 'reviewsPerProject' }]);
    }

    const projectRows = this.submissions.judgable(eventId).filter((row) => {
      if (request.trackId && row.track_id !== request.trackId) return false;
      return true;
    });
    if (projectRows.length === 0) {
      throw errors.preconditionFailed('There are no submitted projects to assign.', [
        { field: 'submissions', issue: 'the project set is empty' },
      ]);
    }

    const judgeRows = this.judges.list(eventId, { limit: 500, offset: 0 }).rows;
    if (judgeRows.length === 0) {
      throw errors.preconditionFailed('No judges have been invited to this event yet.', [
        { field: 'judges', issue: 'invite judges before generating an assignment' },
      ]);
    }

    const assignments = this.db.all<{ submission_id: string; judge_id: string }>(
      "SELECT submission_id, judge_id FROM judge_assignments WHERE event_id = :e AND status <> 'REASSIGNED'",
      { e: eventId },
    );
    const assignedByProject = new Map<string, Set<string>>();
    for (const row of assignments) {
      const set = assignedByProject.get(row.submission_id) ?? new Set<string>();
      set.add(row.judge_id);
      assignedByProject.set(row.submission_id, set);
    }
    const loadByJudge = new Map<string, number>();
    for (const row of assignments) {
      loadByJudge.set(row.judge_id, (loadByJudge.get(row.judge_id) ?? 0) + 1);
    }

    // Judges who reviewed the same organization previously, used as a soft
    // signal by the workload-aware strategy.
    const relatedByProject = this.relatedJudges(eventId);

    const projects: ProjectCandidate[] = projectRows.map((project) => ({
      projectId: project.id,
      trackId: project.track_id,
      teamId: project.team_id,
      organization: this.db.value<string>('SELECT organization FROM teams WHERE id = :t', { t: project.team_id }) ?? null,
      existingJudges: [...(assignedByProject.get(project.id) ?? [])],
      hardConflicts: [],
      softConflicts: [],
      relatedJudges: relatedByProject.get(project.id) ?? [],
      reviewsNeeded: reviewsPerProject,
    }));

    const judges: JudgeCandidate[] = judgeRows.map((judge) => {
      const excluded = judge.state === 'INVITED' || judge.state === 'COMPLETED' || judge.state === 'ACCEPTED';
      return {
        judgeId: judge.id,
        displayName: judge.display_name,
        state: judge.state,
        capacity: judge.capacity,
        existingLoad: loadByJudge.get(judge.id) ?? 0,
        expertise: safeJson(judge.expertise),
        excluded,
        exclusionReason: excluded
          ? judge.state === 'INVITED'
            ? 'Invitation not yet accepted'
            : judge.state === 'COMPLETED'
              ? 'Judge already completed their panel'
              : 'Judge has not started reviewing yet'
          : null,
      };
    });

    if (request.expertise && request.expertise.length > 0) {
      const wanted = new Set(request.expertise.map((tag) => tag.toLowerCase()));
      for (const judge of judges) {
        if (judge.expertise.some((tag) => wanted.has(tag.toLowerCase()))) continue;
        judge.excluded = true;
        judge.exclusionReason = `does not list any of: ${request.expertise.join(', ')}`;
      }
    }

    const conflicts = this.declaredConflicts(eventId, projectRows.map((p) => p.id));

    const seed = request.seed?.trim() || event.assignment_seed || this.config_seed(eventId);

    const preview = generateAssignmentPreview(
      {
        eventId,
        strategy: request.strategy,
        judges,
        projects,
        conflicts,
        reviewsPerProject,
        seed,
      },
      ctx.at,
    );

    const inputHash = sha256Hex(
      canonicalJson({
        eventId,
        strategy: request.strategy,
        reviewsPerProject,
        seed,
        judges: judges.map((j) => [j.judgeId, j.state, j.capacity, j.existingLoad]),
        projects: projects.map((p) => [p.projectId, p.reviewsNeeded, [...p.existingJudges].sort()]),
        conflicts: conflicts.map((c) => [c.judgeId, c.projectId, c.kind, c.severity]).sort(),
      }),
    );

    this.audit.record({
      action: 'assignment.generated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'assignment',
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: {
        strategy: request.strategy,
        seed,
        reviewsPerProject,
        pairs: preview.pairs.length,
        warnings: preview.summary.warnings,
        inputHash,
      },
      at: ctx.at,
    });

    return { ...preview, version: this.currentVersion(eventId) + 1, inputHash };
  }

  /**
   * Commit a preview as a new assignment version.
   *
   * The organizer sends back the `inputHash` they were shown. If the underlying
   * data changed since the preview (a judge accepted, a conflict was declared,
   * a project was withdrawn) the hash no longer matches and the commit is
   * refused — the organizer must look at the new preview rather than commit a
   * plan they never saw.
   */
  commit(
    eventId: string,
    input: { strategy: AssignmentStrategy; seed?: string; reviewsPerProject?: number; inputHash: string; confirmWarnings?: boolean },
    ctx: ActorContext,
  ): { version: number; created: number; skipped: number; preview: AssignmentPreview } {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);

    if (this.submissions.judgable(eventId).length === 0) {
      throw errors.preconditionFailed('There is nothing to assign.');
    }

    const preview = this.preview(eventId, input, ctx);

    if (preview.inputHash !== input.inputHash) {
      throw errors.preconditionFailed(
        'The panel, project set or conflict register changed since this preview was generated. Review the refreshed preview and confirm again.',
        [{ field: 'inputHash', issue: `preview was ${preview.inputHash.slice(0, 12)}, you confirmed ${String(input.inputHash).slice(0, 12)}` }],
      );
    }

    if (preview.summary.warnings.length > 0 && input.confirmWarnings !== true) {
      throw errors.preconditionFailed(
        `The generated assignment has ${String(preview.summary.warnings.length)} warning(s). Review them and confirm to proceed.`,
        preview.summary.warnings.map((issue) => ({ field: 'warnings', issue })),
      );
    }

    const version = this.currentVersion(eventId) + 1;
    let created = 0;
    let skipped = 0;

    this.db.transaction(() => {
      for (const pair of preview.pairs) {
        const existing = this.db.get<{ id: string }>(
          'SELECT id FROM judge_assignments WHERE judge_id = :j AND submission_id = :s',
          { j: pair.judgeId, s: pair.projectId },
        );
        if (existing !== null) {
          // Already assigned in an earlier version: keep the row but stamp the
          // new version so the whole plan is attributable to this run.
          this.db.exec('UPDATE judge_assignments SET version = :v, strategy = :s, reason = :r, updated_at = :at WHERE id = :id', {
            v: version,
            s: request0(input.strategy),
            r: pair.reason,
            at: ctx.at,
            id: existing.id,
          });
          skipped += 1;
          continue;
        }
        this.db.exec(
          `INSERT INTO judge_assignments (id, event_id, judge_id, submission_id, version, status, strategy, reason, soft_conflict, assigned_at, created_at, updated_at)
           VALUES (:id, :e, :j, :s, :v, 'ASSIGNED', :strategy, :reason, :soft, :at, :at, :at)`,
          {
            id: newId('judgeAssignment'),
            e: eventId,
            j: pair.judgeId,
            s: pair.projectId,
            v: version,
            strategy: input.strategy,
            reason: pair.reason,
            soft: pair.softConflict ? 1 : 0,
            at: ctx.at,
          },
        );
        created += 1;
      }

      // Move the affected submissions into the judging lifecycle.
      this.db.exec(
        `UPDATE submissions SET state = 'JUDGING', updated_at = :at
         WHERE event_id = :e AND state = 'LOCKED'
           AND id IN (SELECT submission_id FROM judge_assignments WHERE event_id = :e AND version = :v)`,
        { e: eventId, v: version, at: ctx.at },
      );

      this.audit.record({
        action: 'assignment.committed',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId,
        resourceType: 'assignment',
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        previousState: String(version - 1),
        newState: String(version),
        metadata: {
          strategy: input.strategy,
          seed: preview.seed,
          created,
          skipped,
          coverage: preview.summary.coverageRatio,
          loadSpread: preview.summary.loadSpread,
          inputHash: preview.inputHash,
          acceptedWarnings: preview.summary.warnings,
        },
        at: ctx.at,
      });
    });

    /*
     * Counts and the seed, never the plan itself. A committed plan is one row
     * per judge per project, which for a large event is thousands of ids - the
     * kind of payload that silently blows past a receiver's body limit and gets
     * retried five times. A receiver that needs the detail reads the plan from
     * the API, which is also the versioned, audited copy.
     */
    this.services.webhooks.dispatch(
      eventId,
      'judge.assigned',
      {
        version,
        strategy: input.strategy,
        created,
        skipped,
        reviewsPerProject: preview.reviewsPerProject,
        totalPairs: preview.summary.totalPairs,
        judgesUsed: preview.summary.judgesUsed,
        projectsFullyCovered: preview.summary.projectsFullyCovered,
        projectsPartiallyCovered: preview.summary.projectsPartiallyCovered,
        projectsUncovered: preview.summary.projectsUncovered,
        coverageRatio: preview.summary.coverageRatio,
        loadSpread: preview.summary.loadSpread,
        warnings: preview.summary.warnings.length,
      },
      ctx,
    );

    return { version, created, skipped, preview };
  }

  /**
   * Reassign a project's reviews to a different judge, or drop one. This is the
   * escape hatch when a judge becomes unavailable mid-event, and it is always
   * audited.
   */
  reassign(
    assignmentId: string,
    input: { toJudgeId?: string | null; reason: string },
    ctx: ActorContext,
  ): { from: AssignmentRow | null; to: AssignmentRow | null } {
    const actor = requireActor(ctx);
    const assignment = this.findById(assignmentId);
    if (assignment === null) throw errors.notFound('Assignment', assignmentId);
    const event = this.events.require(assignment.event_id);
    this.events.assertOrganizer(actor, event, ctx);

    if (input.reason.trim().length < 8) {
      throw errors.validation('Reassigning a review requires a written reason of at least 8 characters.', [{ field: 'reason' }]);
    }
    if (assignment.status === 'SUBMITTED') {
      throw errors.conflict('That review has already been submitted. Use an audited score override instead of reassigning.');
    }

    return this.db.transaction(() => {
      this.db.exec("UPDATE judge_assignments SET status = 'REASSIGNED', updated_at = :at WHERE id = :id", { at: ctx.at, id: assignmentId });
      this.db.exec('DELETE FROM scores WHERE assignment_id = :id', { id: assignmentId });

      let created: AssignmentRow | null = null;
      if (input.toJudgeId) {
        const judge = this.judges.require(input.toJudgeId);
        if (judge.event_id !== assignment.event_id) throw errors.badRequest('That judge is not on this event.');
        if (judge.state === 'INVITED' || judge.state === 'COMPLETED') {
          throw errors.preconditionFailed(`${judge.state === 'INVITED' ? 'That judge has not accepted their invitation' : 'That judge has already completed their panel'}.`, [
            { field: 'toJudgeId', issue: judge.state },
          ]);
        }
        const conflict = this.hardConflictBetween(input.toJudgeId, assignment.submission_id);
        if (conflict !== null) {
          throw errors.conflictOfInterest(
            `That judge has declared a hard conflict with this project (${conflict.kind}). Remove the conflict with an audited override if you intend to proceed.`,
            [{ field: 'toJudgeId', issue: conflict.kind }],
          );
        }
        const id = newId('judgeAssignment');
        this.db.exec(
          `INSERT INTO judge_assignments (id, event_id, judge_id, submission_id, version, status, strategy, reason, override_by, assigned_at, created_at, updated_at)
           VALUES (:id, :e, :j, :s, :v, 'ASSIGNED', 'MANUAL', :reason, :by, :at, :at, :at)`,
          {
            id,
            e: assignment.event_id,
            j: input.toJudgeId,
            s: assignment.submission_id,
            v: assignment.version,
            reason: `reassigned: ${input.reason.trim()}`,
            by: actor.id,
            at: ctx.at,
          },
        );
        created = this.findById(id);
      }

      this.audit.record({
        action: 'assignment.reassigned',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: assignment.event_id,
        resourceType: 'judgeAssignment',
        resourceId: assignmentId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        previousState: assignment.judge_id,
        newState: input.toJudgeId ?? null,
        metadata: { submissionId: assignment.submission_id, reason: input.reason.trim() },
        at: ctx.at,
      });

      return { from: assignment, to: created };
    });
  }

  /**
   * Assign a conflicted judge on purpose. Requires an explicit confirmation flag
   * and a written reason, and is recorded as `conflict.override` so it can
   * never be confused with an engine-generated assignment.
   */
  overrideConflict(
    eventId: string,
    input: { judgeId: string; submissionId: string; reason: string; confirm: boolean },
    ctx: ActorContext,
  ): AssignmentRow {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);

    if (input.confirm !== true) {
      throw errors.preconditionFailed(
        'Assigning a judge who has declared a conflict of interest requires an explicit confirmation.',
        [{ field: 'confirm', issue: 'must be true' }],
      );
    }
    if (input.reason.trim().length < 15) {
      throw errors.validation('A conflict override requires a written justification of at least 15 characters.', [{ field: 'reason' }]);
    }

    this.judges.require(input.judgeId);
    const conflict = this.hardConflictBetween(input.judgeId, input.submissionId);
    if (conflict === null) throw errors.preconditionFailed('That judge has no declared conflict with this project.');

    return this.db.transaction(() => {
      const existing = this.db.get<{ id: string }>('SELECT id FROM judge_assignments WHERE judge_id = :j AND submission_id = :s', {
        j: input.judgeId,
        s: input.submissionId,
      });
      let row: AssignmentRow | null;
      if (existing !== null) {
        this.db.exec("UPDATE judge_assignments SET status = 'ASSIGNED', override_by = :by, reason = :reason, updated_at = :at WHERE id = :id", {
          by: actor.id,
          reason: `conflict override: ${input.reason.trim()}`,
          at: ctx.at,
          id: existing.id,
        });
        row = this.findById(existing.id);
      } else {
        const id = newId('judgeAssignment');
        this.db.exec(
          `INSERT INTO judge_assignments (id, event_id, judge_id, submission_id, version, status, strategy, reason, override_by, assigned_at, created_at, updated_at)
           VALUES (:id, :e, :j, :s, :v, 'ASSIGNED', 'OVERRIDE', :reason, :by, :at, :at, :at)`,
          {
            id,
            e: eventId,
            j: input.judgeId,
            s: input.submissionId,
            v: this.currentVersion(eventId) + 1,
            reason: `conflict override: ${input.reason.trim()}`,
            by: actor.id,
            at: ctx.at,
          },
        );
        row = this.findById(id);
      }

      this.audit.record({
        action: 'conflict.override',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId,
        resourceType: 'judgeAssignment',
        resourceId: row?.id ?? '',
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: {
          judgeId: input.judgeId,
          submissionId: input.submissionId,
          conflictKind: conflict.kind,
          reason: input.reason.trim(),
        },
        at: ctx.at,
      });

      return row as AssignmentRow;
    });
  }

  /* ----------------------------------------------------------- queries */

  findById(id: string): AssignmentRow | null {
    return this.db.get<AssignmentRow>('SELECT * FROM judge_assignments WHERE id = :id', { id });
  }

  listForEvent(eventId: string, filter: { judgeId?: string; submissionId?: string; status?: string; limit: number; offset: number }) {
    const conditions = ['a.event_id = :e', "a.status <> 'REASSIGNED'"];
    const params: Record<string, string | number> = { e: eventId, limit: filter.limit, offset: filter.offset };
    if (filter.judgeId) {
      conditions.push('a.judge_id = :j');
      params.j = filter.judgeId;
    }
    if (filter.submissionId) {
      conditions.push('a.submission_id = :s');
      params.s = filter.submissionId;
    }
    if (filter.status) {
      conditions.push('a.status = :status');
      params.status = filter.status;
    }
    const clause = `WHERE ${conditions.join(' AND ')}`;
    const total = this.db.value<number>(`SELECT COUNT(*) AS c FROM judge_assignments a ${clause}`, params) ?? 0;
    return {
      rows: this.db.all<AssignmentRow & { project_name: string; score_state: string | null; total_score: number | null }>(
        `SELECT a.*, s.project_name, sc.state AS score_state, sc.total_score
         FROM judge_assignments a
         JOIN submissions s ON s.id = a.submission_id
         LEFT JOIN scores sc ON sc.assignment_id = a.id
         ${clause} ORDER BY a.assigned_at DESC LIMIT :limit OFFSET :offset`,
        params,
      ),
      total,
    };
  }

  /** The judge's own queue. Ordered so the next unfinished review is first. */
  queueForJudge(eventId: string, judgeId: string) {
    return this.db.all(
      `SELECT a.id AS assignmentId, a.status, a.assigned_at, a.reason, a.version,
              s.id AS submissionId, s.slug, s.project_name, s.short_description, s.technologies,
              s.repository_url, s.demo_url, s.video_url, s.documentation_url, s.cover_image_url, s.full_description,
              sc.id AS scoreId, sc.state AS scoreState, sc.started_at, sc.submitted_at
       FROM judge_assignments a
       JOIN submissions s ON s.id = a.submission_id
       LEFT JOIN scores sc ON sc.assignment_id = a.id
       WHERE a.event_id = :e AND a.judge_id = :j AND a.status <> 'REASSIGNED'
       ORDER BY CASE WHEN sc.state = 'SUBMITTED' THEN 2 WHEN sc.state = 'DRAFT' THEN 1 ELSE 0 END, a.assigned_at`,
      { e: eventId, j: judgeId },
    );
  }

  coverage(eventId: string): {
    projectId: string;
    projectName: string;
    assigned: number;
    target: number;
    completed: number;
    coverage: number;
  }[] {
    const event = this.events.require(eventId);
    return this.db
      .all<{ projectId: string; projectName: string; assigned: number; completed: number }>(
        `SELECT s.id AS projectId, s.project_name AS projectName,
                COUNT(a.id) AS assigned,
                SUM(CASE WHEN a.status = 'SUBMITTED' THEN 1 ELSE 0 END) AS completed
         FROM submissions s
         LEFT JOIN judge_assignments a ON a.submission_id = s.id AND a.status <> 'REASSIGNED'
         WHERE s.event_id = :e AND s.withdrawn = 0 AND s.state IN ('SUBMITTED','LOCKED','JUDGING','FINALIZED')
         GROUP BY s.id ORDER BY s.project_name`,
        { e: eventId },
      )
      .map((row) => ({
        projectId: row.projectId,
        projectName: row.projectName,
        assigned: Number(row.assigned),
        target: event.reviews_per_project,
        completed: Number(row.completed ?? 0),
        coverage: row.projectId ? Math.min(1, Number(row.assigned) / event.reviews_per_project) : 0,
      }));
  }

  /* ---------------------------------------------------------- helpers */

  private declaredConflicts(eventId: string, projectIds: string[]): ConflictDeclaration[] {
    const rows = this.db.all<{
      judge_id: string; project_id: string | null; subject_kind: string | null; subject_id: string | null;
      kind: string; severity: 'HARD' | 'SOFT'; note: string;
    }>('SELECT judge_id, project_id, subject_kind, subject_id, kind, severity, note FROM judge_conflicts WHERE event_id = :e', {
      e: eventId,
    });

    const projectSet = new Set(projectIds);
    const out: ConflictDeclaration[] = [];

    for (const row of rows) {
      if (row.project_id !== null) {
        if (projectSet.has(row.project_id)) {
          out.push({ judgeId: row.judge_id, projectId: row.project_id, kind: row.kind, severity: row.severity, subjectId: null, note: row.note });
        }
        continue;
      }
      // Subject-scoped: hand the engine the subject reference and let it expand.
      if (row.subject_kind === 'TEAM' && row.subject_id) {
        for (const projectId of this.projectsForTeam(eventId, row.subject_id)) {
          if (projectSet.has(projectId)) {
            out.push({ judgeId: row.judge_id, projectId, kind: 'TEAM', severity: row.severity, subjectId: row.subject_id, note: row.note });
          }
        }
        continue;
      }
      if (row.subject_kind === 'ORGANIZATION' && row.subject_id) {
        for (const projectId of this.projectsForOrganization(eventId, row.subject_id)) {
          if (projectSet.has(projectId)) {
            out.push({ judgeId: row.judge_id, projectId, kind: 'ORGANIZATION', severity: row.severity, subjectId: row.subject_id, note: row.note });
          }
        }
        continue;
      }
      if (row.subject_kind === 'PARTICIPANT' && row.subject_id) {
        for (const projectId of this.projectsForParticipant(eventId, row.subject_id)) {
          if (projectSet.has(projectId)) {
            out.push({ judgeId: row.judge_id, projectId, kind: 'PARTICIPANT', severity: row.severity, subjectId: row.subject_id, note: row.note });
          }
        }
      }
    }

    return out;
  }

  private projectsForTeam(eventId: string, teamId: string): string[] {
    return this.db
      .all<{ id: string }>('SELECT id FROM submissions WHERE event_id = :e AND team_id = :t', { e: eventId, t: teamId })
      .map((row) => row.id);
  }

  private projectsForOrganization(eventId: string, organization: string): string[] {
    return this.db
      .all<{ id: string }>(
        `SELECT s.id FROM submissions s JOIN teams t ON t.id = s.team_id
         WHERE s.event_id = :e AND LOWER(t.organization) = LOWER(:org)`,
        { e: eventId, org: organization },
      )
      .map((row) => row.id);
  }

  private projectsForParticipant(eventId: string, userId: string): string[] {
    return this.db
      .all<{ id: string }>(
        `SELECT DISTINCT s.id FROM submissions s
         LEFT JOIN team_members m ON m.team_id = s.team_id
         WHERE s.event_id = :e AND (s.created_by = :u OR m.user_id = :u)`,
        { e: eventId, u: userId },
      )
      .map((row) => row.id);
  }

  private hardConflictBetween(judgeId: string, submissionId: string): { kind: string } | null {
    const row = this.db.get<{ kind: string }>(
      `SELECT kind FROM judge_conflicts
       WHERE judge_id = :j AND severity = 'HARD' AND project_id = :s
       LIMIT 1`,
      { j: judgeId, s: submissionId },
    );
    return row;
  }

  /** Judges who reviewed this project before (e.g. in calibration). */
  private relatedJudges(eventId: string): Map<string, string[]> {
    const rows = this.db.all<{ projectId: string; judgeId: string }>(
      `SELECT DISTINCT submission_id AS projectId, judge_id AS judgeId
       FROM scores WHERE event_id = :e`,
      { e: eventId },
    );
    const map = new Map<string, string[]>();
    for (const row of rows) {
      map.set(row.projectId, [...(map.get(row.projectId) ?? []), row.judgeId]);
    }
    return map;
  }

  private config_seed(eventId: string): string {
    return `verdict:${eventId}:assignment`;
  }
}

function request0(strategy: AssignmentStrategy): string {
  return strategy;
}

function safeJson(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

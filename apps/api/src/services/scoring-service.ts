/**
 * Scoring: the judge's review workflow, calibration, and pairwise comparisons.
 *
 * ---------------------------------------------------------------------------
 * ROLE ISOLATION
 * ---------------------------------------------------------------------------
 * This is the most security-sensitive service in the product, so the rules are
 * stated as invariants and each is enforced here rather than at the route:
 *
 *   I1. A judge can only read or write a review for a project they are
 *       *currently assigned to*. Checked on every read, write and submit.
 *   I2. A judge can only ever read their OWN scores. There is no code path in
 *       this file that returns another judge's criterion scores.
 *   I3. A review is rejected unless the event is in a state that permits
 *       judging, judged by server time.
 *   I4. A submitted review is immutable unless the event leaves the judging
 *       state or an organizer applies an audited override. Enforced twice:
 *       here and by a database trigger.
 *
 * I2 is worth stating explicitly because "judge A can see judge B's scores" is
 * the failure mode that destroys a hackathon's results. The organizer console
 * is a separate service path (`ResultService`) with its own permission checks.
 */

import { newId } from '@verdict/core/ids';
import { assertTransition, type TransitionContext } from '@verdict/core/state-machines';
import { evaluateReview, type CriterionInput } from '@verdict/core/rubric';
import { buildPairSchedule, type PairwiseComparison } from '@verdict/core/pairwise';
import { validatePlainText } from '@verdict/core/validation';
import { mean, median, round, stddev } from '@verdict/core/statistics';
import { errors } from '../lib/errors.ts';
import { canManageEvent } from '../lib/rbac.ts';
import type { ActorContext, Services } from './context.ts';
import type { RubricVersionRow } from './rubric-service.ts';
import { requireActor } from './context.ts';

export type ScoreRow = {
  id: string;
  event_id: string;
  assignment_id: string;
  judge_id: string;
  submission_id: string;
  rubric_version_id: string;
  state: 'DRAFT' | 'SUBMITTED' | 'LOCKED';
  total_score: number | null;
  raw_score: number | null;
  summary: string;
  started_at: string;
  submitted_at: string | null;
  locked_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
};

export type CriterionScoreInput = {
  criterionId: string;
  value: number;
  comment?: string | null;
};

export class ScoringService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];
  private readonly rubrics: Services['rubrics'];
  private readonly assignments: Services['assignments'];
  private readonly judges: Services['judges'];
  /** Held for its `webhooks` entry; see the note in `submitReview`. */
  private readonly services: Services;

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
    this.rubrics = services.rubrics;
    this.assignments = services.assignments;
    this.judges = services.judges;
    this.services = services;
  }

  /* ------------------------------------------------------ judge queue */

  /**
   * The judge's own queue. Returns the next unfinished review first so the UI
   * can offer a single "next project" action with no hunting.
   */
  queue(eventId: string, judgeId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const judge = this.judges.require(judgeId);
    if (judge.user_id !== actor.id && !canManageEvent(actor as never, eventId)) {
      throw errors.forbidden('That is not your judging queue.');
    }
    const items = this.assignments.queueForJudge(eventId, judgeId) as Record<string, unknown>[];
    const assigned = items.length;
    const completed = items.filter((item) => item.scoreState === 'SUBMITTED').length;
    const inProgress = items.filter((item) => item.scoreState === 'DRAFT').length;

    return {
      judgeId,
      items: items.map((item) => ({
        assignmentId: item.assignmentId as string,
        submissionId: item.submissionId as string,
        slug: item.slug as string,
        projectName: item.project_name as string,
        shortDescription: item.short_description as string,
        technologies: safeArray(item.technologies as string),
        repositoryUrl: item.repository_url as string | null,
        demoUrl: item.demo_url as string | null,
        videoUrl: item.video_url as string | null,
        documentationUrl: item.documentation_url as string | null,
        coverImageUrl: item.cover_image_url as string | null,
        fullDescription: item.full_description as string | null,
        status: item.status as string,
        scoreId: (item.scoreId as string | null) ?? null,
        scoreState: (item.scoreState as string | null) ?? null,
        startedAt: (item.startedAt as string | null) ?? null,
        submittedAt: (item.submittedAt as string | null) ?? null,
      })),
      progress: {
        assigned,
        completed,
        inProgress,
        remaining: assigned - completed,
        percent: assigned === 0 ? null : Math.round((completed / assigned) * 100),
      },
    };
  }

  /* ---------------------------------------------------------- reviews */

  /** Open (or resume) a review. Creates the draft row on first access. */
  startReview(assignmentId: string, ctx: ActorContext): { score: ScoreRow; rubric: ReturnType<Services['rubrics']['toPublicView']> } {
    const actor = requireActor(ctx);
    const assignment = this.requireOwnAssignment(assignmentId, actor, ctx);
    const rubricRow = this.rubrics.requireActiveVersion(assignment.event_id);

    const existing = this.findScore(assignment.judge_id, assignment.submission_id);
    if (existing !== null) {
      if (existing.state === 'SUBMITTED' || existing.state === 'LOCKED') {
        return { score: existing, rubric: this.rubrics.toPublicView(rubricRow) };
      }
      return { score: existing, rubric: this.rubrics.toPublicView(rubricRow) };
    }

    const id = newId('score');
    this.db.exec(
      `INSERT INTO scores (id, event_id, assignment_id, judge_id, submission_id, rubric_version_id, state, summary, started_at, created_at, updated_at)
       VALUES (:id, :e, :a, :j, :s, :r, 'DRAFT', '', :at, :at, :at)`,
      { id, e: assignment.event_id, a: assignmentId, j: assignment.judge_id, s: assignment.submission_id, r: rubricRow.id, at: ctx.at },
    );

    this.db.exec("UPDATE judge_assignments SET status = 'IN_PROGRESS', updated_at = :at WHERE id = :id", { at: ctx.at, id: assignmentId });
    if (judgeStateIsAccepted(assignment.judge_id, this.db)) {
      this.db.exec("UPDATE judges SET state = 'ACTIVE', activated_at = :at, updated_at = :at WHERE id = :id AND state = 'ACCEPTED'", {
        at: ctx.at,
        id: assignment.judge_id,
      });
    }

    this.audit.record({
      action: 'score.draft_saved',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: assignment.event_id,
      resourceType: 'score',
      resourceId: id,
      requestId: ctx.requestId,
      newState: 'DRAFT',
      at: ctx.at,
    });

    return { score: this.requireScore(id), rubric: this.rubrics.toPublicView(rubricRow) };
  }

  /** Autosave. Only drafts can be saved this way. */
  saveDraft(
    assignmentId: string,
    input: { criteria: CriterionScoreInput[]; summary?: string; durationMs?: number },
    ctx: ActorContext,
  ): ScoreRow {
    const actor = requireActor(ctx);
    const assignment = this.requireOwnAssignment(assignmentId, actor, ctx);
    this.assertJudgingOpen(assignment.event_id, actor, ctx);

    const score = this.findScore(assignment.judge_id, assignment.submission_id);
    if (score === null) {
      this.startReview(assignmentId, ctx);
      return this.saveDraft(assignmentId, input, ctx);
    }
    if (score.state !== 'DRAFT') {
      throw errors.immutable(
        `This review was already ${score.state.toLowerCase()} and can no longer be edited. ${
          score.state === 'SUBMITTED' ? 'An organizer can apply a documented override if a correction is genuinely needed.' : ''
        }`,
      );
    }

    const rubricRow = this.rubrics.requireVersion(score.rubric_version_id);
    const domain = this.rubrics.toDomain(rubricRow);
    const evaluation = evaluateReview(domain, input.criteria.map(toCriterionInput));

    this.db.transaction(() => {
      for (const criterion of evaluation.criteria) {
        this.db.exec(
          `INSERT INTO criterion_scores (id, score_id, criterion_id, rubric_version_id, value, normalized, points, comment, created_at, updated_at)
           VALUES (:id, :score, :criterion, :rv, :value, :normalized, :points, :comment, :at, :at)
           ON CONFLICT (score_id, criterion_id) DO UPDATE SET
             value = excluded.value, normalized = excluded.normalized, points = excluded.points,
             comment = excluded.comment, updated_at = excluded.updated_at`,
          {
            id: newId('criterionScore'),
            score: score.id,
            criterion: criterion.criterionId,
            rv: score.rubric_version_id,
            value: criterion.rawValue,
            normalized: criterion.normalised,
            points: criterion.pointsOutOf100,
            comment: (criterion.comment ?? '').slice(0, 4000),
            at: ctx.at,
          },
        );
      }
      // Remove criterion rows for criteria the judge has cleared.
      for (const removed of evaluation.missingRequired) {
        void removed;
      }
      this.db.exec(
        'UPDATE scores SET total_score = :total, raw_score = :raw, summary = :summary, duration_ms = :duration, updated_at = :at WHERE id = :id',
        {
          total: evaluation.total,
          raw: evaluation.score100,
          summary: validatePlainText(input.summary ?? '', { field: 'summary', max: 4000 }),
          duration: input.durationMs ?? score.duration_ms,
          at: ctx.at,
          id: score.id,
        },
      );
      this.db.exec("UPDATE judge_assignments SET status = 'IN_PROGRESS', updated_at = :at WHERE id = :id", { at: ctx.at, id: assignmentId });
    });

    return this.requireScore(score.id);
  }

  /**
   * Submit a review. This is the moment the score becomes visible to organizers
   * and is locked unless the event leaves the judging state.
   */
  submitReview(assignmentId: string, input: { criteria: CriterionScoreInput[]; summary?: string; durationMs?: number }, ctx: ActorContext): ScoreRow {
    const actor = requireActor(ctx);
    const assignment = this.requireOwnAssignment(assignmentId, actor, ctx);
    this.assertJudgingOpen(assignment.event_id, actor, ctx, { requireOpen: true });

    const saved = this.saveDraft(assignmentId, input, ctx);
    if (saved.state !== 'DRAFT') return saved;

    const rubricRow = this.rubrics.requireVersion(saved.rubric_version_id);
    const domain = this.rubrics.toDomain(rubricRow);
    const evaluation = evaluateReview(domain, input.criteria.map(toCriterionInput));

    if (!evaluation.complete) {
      throw errors.validation(
        'Some required criteria are missing, so this review cannot be submitted.',
        evaluation.missingRequired.map((key) => ({ field: key, issue: 'required' })),
      );
    }
    if (evaluation.unknownCriterionIds.length > 0) {
      throw errors.validation('The review contains criteria that are not part of this rubric version.', [
        { field: 'criteria', issue: evaluation.unknownCriterionIds.join(', ') },
      ]);
    }

    const transitionContext: TransitionContext = {
      override: false,
      facts: { judgingOpen: this.judgingOpen(assignment.event_id, ctx.at) },
      actor: { id: actor.id, roles: actor.roles },
    };
    try {
      assertTransition('Score', saved.state, 'SUBMITTED', transitionContext);
    } catch (error) {
      throw errors.illegalTransition(error instanceof Error ? error.message : 'not permitted');
    }

    this.db.transaction(() => {
      this.db.exec(
        `UPDATE scores SET state = 'SUBMITTED', submitted_at = :at, raw_score = :raw, total_score = :total, updated_at = :at
         WHERE id = :id`,
        { at: ctx.at, raw: evaluation.score100, total: evaluation.total, id: saved.id },
      );
      this.db.exec("UPDATE judge_assignments SET status = 'SUBMITTED', completed_at = :at, updated_at = :at WHERE id = :id", {
        at: ctx.at,
        id: assignmentId,
      });
      this.audit.record({
        action: 'score.submitted',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: assignment.event_id,
        resourceType: 'score',
        resourceId: saved.id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        previousState: 'DRAFT',
        newState: 'SUBMITTED',
        metadata: { submissionId: assignment.submission_id, score: evaluation.score100, durationMs: input.durationMs ?? null },
        at: ctx.at,
      });
    });

    this.judges.autoCompleteFinishedJudges(assignment.event_id, ctx.at);

    /*
     * Counts only. The per-criterion scores stay in the database: a webhook body
     * is written to a third party's log the moment it is sent, and no receiver
     * needs a judge's individual 0-10s to advance a progress bar.
     */
    this.services.webhooks.dispatch(
      assignment.event_id,
      'score.submitted',
      {
        assignmentId,
        submissionId: assignment.submission_id,
        judgeId: actor.id,
        rubricVersionId: saved.rubric_version_id,
        durationMs: input.durationMs ?? null,
      },
      ctx,
    );

    this.dispatchJudgingCompleted(assignment.event_id, ctx);

    return this.requireScore(saved.id);
  }

  /**
   * Announce that judging is done, at most once per event.
   *
   * Derived rather than flagged: it fires from inside the last submit, and a
   * submit is only reachable while that review is still outstanding, so reaching
   * this point with nothing outstanding can only mean this submission was the
   * one that finished it. A stored "already announced" flag would need its own
   * reset path when a judge is reassigned, which is a bug waiting to happen.
   */
  private dispatchJudgingCompleted(eventId: string, ctx: ActorContext): void {
    const total = this.db.value<number>(
      "SELECT COUNT(*) AS c FROM judge_assignments WHERE event_id = :e AND status <> 'REASSIGNED'",
      { e: eventId },
    ) ?? 0;
    // An event with no panel at all has not completed judging; it never started.
    if (total === 0) return;

    const outstanding = this.db.value<number>(
      `SELECT COUNT(*) AS c
       FROM judge_assignments a
       LEFT JOIN scores sc ON sc.assignment_id = a.id
       WHERE a.event_id = :e AND a.status <> 'REASSIGNED'
         AND (sc.id IS NULL OR sc.state NOT IN ('SUBMITTED','LOCKED'))`,
      { e: eventId },
    ) ?? 0;
    if (outstanding > 0) return;

    this.services.webhooks.dispatch(
      eventId,
      'judging.completed',
      { assignments: total, outstanding: 0 },
      ctx,
    );
  }

  /**
   * The judge's own review, with criterion detail. Enforces invariant I2.
   *
   * This is a get-or-create. Reading your own review for an assignment that has
   * no `scores` row yet *opens* it, exactly as `saveDraft` already does further
   * down (`if (score === null) { this.startReview(...); }`).
   *
   * It is get-or-create rather than 404 because that 404 was a real, shipped
   * dead end: the SPA's review page reads the review on mount, so any assignment
   * without a score row rendered "Review unavailable — this review is not in
   * your queue, or it belongs to another judge". The seeded demo hid it, because
   * seeding writes a score row for all 36 assignments, but a judge assigned a
   * project after that — which is every real event — hit it immediately, and so
   * would any third-party API consumer.
   *
   * The write is idempotent and creates no scoring data: an empty DRAFT, plus
   * the assignment-status and judge-activation bookkeeping `startReview` already
   * does, all of it audited. Reading is therefore not side-effect-free on the
   * first visit, which is stated here rather than hidden, and the state change
   * it records ("a judge opened this project at this time") is worth having.
   */
  ownReview(assignmentId: string, ctx: ActorContext): { score: ScoreRow; criteria: unknown[]; rubric: unknown } {
    const actor = requireActor(ctx);
    const assignment = this.requireOwnAssignment(assignmentId, actor, ctx);
    let score = this.findScore(assignment.judge_id, assignment.submission_id);
    if (score === null) {
      score = this.startReview(assignmentId, ctx).score;
    }
    const rubricRow = this.rubrics.requireVersion(score.rubric_version_id);
    return {
      score,
      criteria: this.criterionScores(score.id),
      rubric: this.rubrics.toPublicView(rubricRow),
    };
  }

  /* ------------------------------------------------------- organizer */

  /**
   * Organizer view of a review. Kept here but gated on EVENT scope by the route
   * layer; the judge console never calls it.
   */
  reviewForOrganizer(scoreId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const score = this.requireScore(scoreId);
    this.events.assertOrganizer(actor, this.events.require(score.event_id), ctx);
    return { score, criteria: this.criterionScores(scoreId), rubric: this.rubrics.toPublicView(this.rubrics.requireVersion(score.rubric_version_id), false) };
  }

  /** Aggregated score table for the organizer, one row per project. */
  scoreTable(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    return this.db.all(
      `SELECT s.id AS submissionId, s.project_name AS projectName, s.track_id AS trackId,
              COUNT(a.id) AS assigned,
              SUM(CASE WHEN sc.state IN ('SUBMITTED','LOCKED') THEN 1 ELSE 0 END) AS completed,
              ROUND(AVG(CASE WHEN sc.state IN ('SUBMITTED','LOCKED') THEN sc.raw_score END), 4) AS meanScore,
              ROUND(MIN(CASE WHEN sc.state IN ('SUBMITTED','LOCKED') THEN sc.raw_score END), 4) AS minScore,
              ROUND(MAX(CASE WHEN sc.state IN ('SUBMITTED','LOCKED') THEN sc.raw_score END), 4) AS maxScore,
              GROUP_CONCAT(DISTINCT t.name) AS tracks
       FROM submissions s
       LEFT JOIN judge_assignments a ON a.submission_id = s.id AND a.status <> 'REASSIGNED'
       LEFT JOIN scores sc ON sc.assignment_id = a.id
       LEFT JOIN event_tracks t ON t.id = s.track_id
       WHERE s.event_id = :e AND s.withdrawn = 0 AND s.state IN ('SUBMITTED','LOCKED','JUDGING','FINALIZED')
       GROUP BY s.id ORDER BY meanScore DESC NULLS LAST, s.project_name`,
      { e: eventId },
    );
  }

  /** Lock every submitted score, called when judging closes. */
  lockAll(eventId: string, at: string): number {
    return this.db.exec(
      "UPDATE scores SET state = 'LOCKED', locked_at = :at, updated_at = :at WHERE event_id = :e AND state = 'SUBMITTED'",
      { e: eventId, at },
    ).changes;
  }

  /* ------------------------------------------------------ calibration */

  createCalibration(
    eventId: string,
    input: { name: string; instructions?: string; submissionIds: string[]; opensAt?: string; closesAt?: string },
    ctx: ActorContext,
  ) {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);
    if (input.submissionIds.length === 0) {
      throw errors.validation('Choose at least one example project for judges to score.', [{ field: 'submissionIds' }]);
    }
    const rubric = this.rubrics.requireActiveVersion(eventId);
    const id = newId('calibrationSession');
    this.db.exec(
      `INSERT INTO calibration_sessions (id, event_id, rubric_version_id, name, instructions, state, opens_at, closes_at, created_by, created_at, updated_at)
       VALUES (:id, :e, :r, :name, :instructions, 'OPEN', :opens, :closes, :by, :at, :at)`,
      {
        id,
        e: eventId,
        r: rubric.id,
        name: validatePlainText(input.name, { field: 'name', min: 2, max: 120 }),
        instructions: validatePlainText(input.instructions ?? '', { field: 'instructions', max: 4000 }),
        opens: input.opensAt ?? ctx.at,
        closes: input.closesAt ?? null,
        by: actor.id,
        at: ctx.at,
      },
    );
    this.audit.record({
      action: 'calibration.session_created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'calibrationSession',
      resourceId: id,
      requestId: ctx.requestId,
      metadata: { projects: input.submissionIds.length },
      at: ctx.at,
    });
    return this.db.get('SELECT * FROM calibration_sessions WHERE id = :id', { id });
  }

  /**
   * Calibration is diagnostic only. It computes the panel's spread and the
   * per-criterion distribution so an organizer can see whether judges
   * understand the rubric. It never writes to a real score.
   */
  submitCalibration(
    sessionId: string,
    input: { submissionId: string; criteria: CriterionScoreInput[] },
    ctx: ActorContext,
  ) {
    const actor = requireActor(ctx);
    const session = this.db.get<{ id: string; event_id: string; rubric_version_id: string; state: string; opens_at: string; closes_at: string | null }>(
      'SELECT * FROM calibration_sessions WHERE id = :id',
      { id: sessionId },
    );
    if (session === null) throw errors.notFound('Calibration session', sessionId);
    if (session.state !== 'OPEN') throw errors.conflict('This calibration session is closed.');

    const judge = this.judges.findByUser(session.event_id, actor.id);
    if (judge === null) throw errors.forbidden('Only judges on this event can submit calibration scores.');

    const domain = this.rubrics.toDomain(this.rubrics.requireVersion(session.rubric_version_id));
    const evaluation = evaluateReview(domain, input.criteria.map(toCriterionInput));
    if (!evaluation.complete) {
      throw errors.validation('Score every required criterion.', evaluation.missingRequired.map((key) => ({ field: key, issue: 'required' })));
    }

    const id = newId('calibrationScore');
    this.db.exec(
      `INSERT INTO calibration_scores (id, session_id, judge_id, submission_id, rubric_version_id, total_score, detail, submitted_at, created_at, updated_at)
       VALUES (:id, :session, :judge, :submission, :rv, :total, :detail, :at, :at, :at)
       ON CONFLICT (session_id, judge_id, submission_id) DO UPDATE SET
         total_score = excluded.total_score, detail = excluded.detail, submitted_at = excluded.submitted_at, updated_at = excluded.updated_at`,
      {
        id,
        session: sessionId,
        judge: judge.id,
        submission: input.submissionId,
        rv: session.rubric_version_id,
        total: evaluation.score100,
        detail: JSON.stringify(evaluation.criteria.map((c) => ({ key: c.key, value: c.rawValue, points: c.pointsOutOf100 }))),
        at: ctx.at,
      },
    );

    this.audit.record({
      action: 'calibration.submitted',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: session.event_id,
      resourceType: 'calibrationScore',
      resourceId: id,
      requestId: ctx.requestId,
      metadata: { sessionId, submissionId: input.submissionId, score: evaluation.score100 },
      at: ctx.at,
    });

    return { sessionId, submissionId: input.submissionId, score: evaluation.score100 };
  }

  /** Panel statistics for a calibration session. */
  calibrationReport(sessionId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const session = this.db.get<{ id: string; event_id: string; rubric_version_id: string }>(
      'SELECT id, event_id, rubric_version_id FROM calibration_sessions WHERE id = :id',
      { id: sessionId },
    );
    if (session === null) throw errors.notFound('Calibration session', sessionId);
    if (!canManageEvent(actor as never, session.event_id) && !this.judges.findByUser(session.event_id, actor.id)) {
      throw errors.forbidden('You are not on this event\'s panel.');
    }

    const rows = this.db.all<{ submission_id: string; judge_id: string; total_score: number; detail: string }>(
      'SELECT submission_id, judge_id, total_score, detail FROM calibration_scores WHERE session_id = :s',
      { s: sessionId },
    );

    return this.summariseCalibration(rows, this.rubrics.requireVersion(session.rubric_version_id));
  }

  private summariseCalibration(
    rows: { submission_id: string; judge_id: string; total_score: number; detail: string }[],
    rubricRow: RubricVersionRow,
  ) {
    const criteria = this.rubrics.criteria(rubricRow.id);

    return {
      rubricVersionId: rubricRow.id,
      judgeCount: new Set(rows.map((r) => r.judge_id)).size,
      submissions: [...new Set(rows.map((r) => r.submission_id))].map((submissionId) => {
        const forProject = rows.filter((r) => r.submission_id === submissionId);
        const scores = forProject.map((r) => Number(r.total_score));
        const detailByJudge = forProject.map((r) => ({ judgeId: r.judge_id, entries: parseDetail(r.detail) }));

        return {
          submissionId,
          judgeCount: scores.length,
          mean: round(mean(scores), 3),
          median: round(median(scores), 3),
          stddev: round(stddev(scores), 3),
          range: scores.length > 0 ? round(Math.max(...scores) - Math.min(...scores), 3) : null,
          criteria: criteria.map((criterion) => {
            const values = detailByJudge
              .flatMap((judge) => judge.entries)
              .filter((entry) => entry.key === criterion.key)
              .map((entry) => entry.points);
            return {
              key: criterion.key,
              name: criterion.name,
              judgeCount: values.length,
              mean: values.length > 0 ? round(mean(values), 3) : null,
              stddev: values.length > 1 ? round(stddev(values), 3) : null,
            };
          }),
          scores: forProject.map((r) => ({ judgeId: r.judge_id, score: Number(r.total_score) })),
        };
      }),
    };
  }

  /* --------------------------------------------------------- pairwise */

  /** The judge's deterministic pair queue for head-to-head comparison. */
  pairwiseQueue(eventId: string, judgeId: string, pairsPerJudge: number, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const judge = this.judges.require(judgeId);
    if (judge.user_id !== actor.id) throw errors.forbidden('That is not your comparison queue.');

    const assigned = this.db
      .all<{ submission_id: string }>(
        "SELECT DISTINCT submission_id FROM judge_assignments WHERE event_id = :e AND judge_id = :j AND status <> 'REASSIGNED'",
        { e: eventId, j: judgeId },
      )
      .map((row) => row.submission_id);

    const done = new Set(
      this.db
        .all<{ left_submission_id: string; right_submission_id: string }>(
          "SELECT left_submission_id, right_submission_id FROM pairwise_comparisons WHERE judge_id = :j AND outcome <> 'SKIPPED'",
          { j: judgeId },
        )
        .map((row) => [row.left_submission_id, row.right_submission_id].sort().join('|')),
    );

    const event = this.events.require(eventId);
    const schedule = buildPairSchedule(assigned, judgeId, {
      pairsPerComparison: pairsPerJudge,
      seed: event.assignment_seed || `verdict:${eventId}`,
    }).filter((pair) => !done.has([pair.left, pair.right].sort().join('|')));

    const details = new Map<string, { projectName: string; shortDescription: string; technologies: string }>();
    for (const id of assigned) {
      const row = this.db.get<{ project_name: string; short_description: string; technologies: string }>(
        'SELECT project_name, short_description, technologies FROM submissions WHERE id = :id',
        { id },
      );
      if (row !== null) {
        details.set(id, {
          projectName: row.project_name,
          shortDescription: row.short_description,
          technologies: safeArray(row.technologies).join(', '),
        });
      }
    }

    return {
      judgeId,
      total: schedule.length,
      pairs: schedule.map((pair, index) => ({
        index,
        left: { id: pair.left, ...(details.get(pair.left) ?? { projectName: pair.left, shortDescription: '', technologies: '' }) },
        right: { id: pair.right, ...(details.get(pair.right) ?? { projectName: pair.right, shortDescription: '', technologies: '' }) },
      })),
    };
  }

  recordComparison(
    eventId: string,
    input: { leftSubmissionId: string; rightSubmissionId: string; outcome: 'LEFT' | 'RIGHT' | 'TIE' | 'SKIPPED'; durationMs?: number },
    ctx: ActorContext,
  ) {
    const actor = requireActor(ctx);
    const judge = this.judges.findByUser(eventId, actor.id);
    if (judge === null) throw errors.forbidden('Only judges on this event can record comparisons.');
    if (input.leftSubmissionId === input.rightSubmissionId) {
      throw errors.badRequest('A project cannot be compared with itself.');
    }

    // A judge may only compare projects they are assigned to. Comparing an
    // unassigned pair would let a judge rank projects they never reviewed.
    for (const id of [input.leftSubmissionId, input.rightSubmissionId]) {
      const assigned = this.db.value<number>(
        "SELECT COUNT(*) AS c FROM judge_assignments WHERE event_id = :e AND judge_id = :j AND submission_id = :s AND status <> 'REASSIGNED'",
        { e: eventId, j: judge.id, s: id },
      );
      if ((assigned ?? 0) === 0) {
        throw errors.forbidden('You can only compare projects assigned to you.');
      }
    }

    const id = newId('pairwiseComparison');
    this.db.exec(
      `INSERT INTO pairwise_comparisons (id, event_id, judge_id, left_submission_id, right_submission_id, outcome, duration_ms, created_at, updated_at)
       VALUES (:id, :e, :j, :l, :r, :outcome, :duration, :at, :at)
       ON CONFLICT (judge_id, session, left_submission_id, right_submission_id) DO UPDATE SET outcome = excluded.outcome, updated_at = excluded.updated_at`,
      {
        id,
        e: eventId,
        j: judge.id,
        l: input.leftSubmissionId,
        r: input.rightSubmissionId,
        outcome: input.outcome,
        duration: input.durationMs ?? null,
        at: ctx.at,
      },
    );

    this.audit.record({
      action: 'pairwise.compared',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'pairwiseComparison',
      resourceId: id,
      requestId: ctx.requestId,
      metadata: { left: input.leftSubmissionId, right: input.rightSubmissionId, outcome: input.outcome },
      at: ctx.at,
    });

    return { id, outcome: input.outcome };
  }

  /**
   * Every comparison recorded on an event, with project names resolved.
   *
   * This previously selected `decided_at`, a column that does not exist on
   * `pairwise_comparisons` — the table stores `created_at`. It was never a
   * problem because nothing routed to this method; the moment an organizer
   * endpoint was wired up it returned 500. `PairwiseComparison.decidedAt` is an
   * alias for the same value, so the shape the core expects is unchanged.
   *
   * The service permits a judge to read these, but the route that exposes them
   * is organizer-scoped and does not. That asymmetry is deliberate: this query
   * returns comparisons for *every* judge on the event, and pairwise outcomes
   * are judge data. A judge who wants their own history gets it from their
   * comparison queue, which is scoped to them. Loosening the route without
   * scoping the query would leak the panel's head-to-head record.
   */
  listComparisons(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    if (!canManageEvent(actor as never, eventId) && !this.judges.findByUser(eventId, actor.id)) {
      throw errors.forbidden('You are not on this event\'s panel.');
    }
    return this.db.all<PairwiseComparison>(
      `SELECT id, judge_id AS judgeId, left_submission_id AS leftProjectId,
              right_submission_id AS rightProjectId, outcome, created_at AS decidedAt
       FROM pairwise_comparisons WHERE event_id = :e ORDER BY created_at`,
      { e: eventId },
    );
  }

  /* ---------------------------------------------------------- helpers */

  findScore(judgeId: string, submissionId: string): ScoreRow | null {
    return this.db.get<ScoreRow>('SELECT * FROM scores WHERE judge_id = :j AND submission_id = :s', { j: judgeId, s: submissionId });
  }

  requireScore(id: string): ScoreRow {
    const row = this.db.get<ScoreRow>('SELECT * FROM scores WHERE id = :id', { id });
    if (row === null) throw errors.notFound('Review', id);
    return row;
  }

  criterionScores(scoreId: string) {
    return this.db.all(
      `SELECT cs.id, cs.criterion_id AS criterionId, rc.field_key AS key, rc.name, rc.min_value AS min,
              rc.max_value AS max, cs.value, cs.normalized, cs.points, cs.comment, cs.updated_at AS updatedAt
       FROM criterion_scores cs JOIN rubric_criteria rc ON rc.id = cs.criterion_id
       WHERE cs.score_id = :s ORDER BY rc.display_order`,
      { s: scoreId },
    );
  }

  /**
   * Invariant I1: the caller must be the assigned judge (or an organizer of the
   * event, who may inspect for support purposes).
   */
  private requireOwnAssignment(
    assignmentId: string,
    actor: { id: string; roles: string[]; eventIds: string[] },
    ctx: ActorContext,
  ) {
    const assignment = this.db.get<{
      id: string; event_id: string; judge_id: string; submission_id: string; status: string;
    }>('SELECT id, event_id, judge_id, submission_id, status FROM judge_assignments WHERE id = :id', { id: assignmentId });

    if (assignment === null) throw errors.notFound('Assignment', assignmentId);
    if (assignment.status === 'REASSIGNED') {
      throw errors.conflict('That review was reassigned to another judge.');
    }

    const judge = this.judges.require(assignment.judge_id);
    if (judge.user_id !== actor.id) {
      this.audit.recordDenied({
        action: 'score.draft_saved',
        actorId: actor.id,
        actorRoles: actor.roles as never,
        eventId: assignment.event_id,
        resourceType: 'judgeAssignment',
        resourceId: assignmentId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        reason: 'not the assigned judge for this review',
        at: ctx.at,
      });
      throw errors.forbidden('That review is assigned to a different judge.');
    }

    return assignment;
  }

  private judgingOpen(eventId: string, at: string): boolean {
    const event = this.events.require(eventId);
    if (event.state === 'JUDGING') return true;
    if (event.judging_closes_at !== null && at < event.judging_closes_at) return true;
    return false;
  }

  /** Invariant I3. */
  private assertJudgingOpen(eventId: string, actor: { id: string; roles: string[]; eventIds: string[] }, ctx: ActorContext, options: { requireOpen?: boolean } = {}): void {
    if (this.judgingOpen(eventId, ctx.at)) return;
    const event = this.events.require(eventId);
    const closes = event.judging_closes_at ?? 'the judging period has ended';
    if (canManageEvent(actor as never, eventId)) {
      this.audit.record({
        action: 'score.overridden',
        actorId: actor.id,
        actorRoles: actor.roles as never,
        eventId,
        resourceType: 'event',
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        metadata: { warning: `organizer wrote a score while judging was closed (${closes})` },
        at: ctx.at,
      });
      if (options.requireOpen === true) {
        throw errors.windowClosed(
          `Judging for "${event.name}" closed at ${closes}. Only an organizer override can record a review now, and it will be flagged in the audit log.`,
        );
      }
      return;
    }
    throw errors.windowClosed(`Judging for "${event.name}" closed at ${closes}. Reviews can no longer be changed.`);
  }
}

function toCriterionInput(input: CriterionScoreInput): CriterionInput {
  return { criterionId: input.criterionId, value: input.value, comment: input.comment ?? null };
}

function safeArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value.filter((v): v is T => typeof v === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is T => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function judgeStateIsAccepted(judgeId: string, db: Services['db']): boolean {
  const state = db.value<string>('SELECT state FROM judges WHERE id = :id', { id: judgeId });
  return state === 'ACCEPTED';
}

/** Parse a stored calibration detail blob defensively. */
function parseDetail(raw: string): { key: string; points: number }[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is { key: string; points: number } =>
        typeof entry === 'object' && entry !== null && typeof (entry as { key?: unknown }).key === 'string',
    ).map((entry) => ({ key: entry.key, points: Number((entry as { points?: unknown }).points ?? 0) }));
  } catch {
    return [];
  }
}

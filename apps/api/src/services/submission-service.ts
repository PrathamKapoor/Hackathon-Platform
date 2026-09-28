/**
 * Submissions: drafts, immutable version history, and deadline enforcement.
 *
 * ---------------------------------------------------------------------------
 * VERSIONING
 * ---------------------------------------------------------------------------
 * Every meaningful edit appends a `submission_versions` row holding a full
 * snapshot, the list of changed fields, and a checksum. Versions are append-only
 * and the final one is frozen by a database trigger, so "what did this project
 * actually look like when the judges saw it?" is answerable forever.
 *
 * ---------------------------------------------------------------------------
 * DEADLINE ENFORCEMENT
 * ---------------------------------------------------------------------------
 * The server decides. `assertEditable` consults the event's window and state
 * using server time; a client that lies about the current time, omits a field,
 * or calls a different endpoint gets the same answer. An organizer can bypass
 * this only through `override`, which writes an audit record with a reason.
 */

import { newId } from '@verdict/core/ids';
import { assertTransition, type TransitionContext } from '@verdict/core/state-machines';
import { canonicalJson, sha256Hex } from '@verdict/core/integrity';
import { seededGalleryOrder } from '@verdict/core/random';
import { validateHttpUrl, validatePlainText } from '@verdict/core/validation';
import { isOneOf, type SubmissionState } from '@verdict/core/types';
import { errors } from '../lib/errors.ts';
import { canManageEvent } from '../lib/rbac.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';
import { slugify, type EventRow } from './event-service.ts';
import type { UploadRow } from './upload-service.ts';

export type SubmissionRow = {
  id: string;
  event_id: string;
  team_id: string | null;
  track_id: string | null;
  created_by: string;
  slug: string;
  project_name: string;
  short_description: string;
  full_description: string;
  problem: string;
  solution: string;
  technologies: string;
  repository_url: string | null;
  demo_url: string | null;
  video_url: string | null;
  documentation_url: string | null;
  cover_image_url: string | null;
  state: SubmissionState;
  current_version: number;
  submitted_at: string | null;
  locked_at: string | null;
  finalized_at: string | null;
  gallery_visible: number;
  eligible_for_prizes: number;
  withdrawn: number;
  created_at: string;
  updated_at: string;
};

export type SubmissionInput = {
  projectName?: string;
  shortDescription?: string;
  fullDescription?: string;
  problem?: string;
  solution?: string;
  technologies?: string[];
  trackId?: string | null;
  repositoryUrl?: string | null;
  demoUrl?: string | null;
  videoUrl?: string | null;
  documentationUrl?: string | null;
  coverImageUrl?: string | null;
  galleryVisible?: boolean;
  eligibleForPrizes?: boolean;
};

const MUTABLE_FIELDS: (keyof SubmissionRow)[] = [
  'project_name', 'short_description', 'full_description', 'problem', 'solution', 'technologies',
  'track_id', 'repository_url', 'demo_url', 'video_url', 'documentation_url', 'cover_image_url',
  'gallery_visible', 'eligible_for_prizes',
];

export class SubmissionService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];
  private readonly teams: Services['teams'];
  private readonly uploads: Services['uploads'];
  /** Held for its `webhooks` entry; see the note in `submit`. */
  private readonly services: Services;

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
    this.teams = services.teams;
    this.uploads = services.uploads;
    this.services = services;
  }

  /* ------------------------------------------------------------- create */

  create(eventId: string, teamId: string | null, input: SubmissionInput, ctx: ActorContext): SubmissionRow {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);

    if (teamId !== null) {
      const team = this.teams.require(teamId);
      if (team.event_id !== eventId) throw errors.badRequest('That team belongs to a different event.');
      if (this.teams.member(teamId, actor.id) === null) {
        throw errors.forbidden('Only a team member can create that team\'s submission.');
      }
    } else {
      if (event.allow_individual !== 1) {
        throw errors.forbidden('This event requires submissions to belong to a team.');
      }
    }

    const existing = this.db.get<{ id: string }>(
      "SELECT id FROM submissions WHERE event_id = :e AND created_by = :u AND state = 'DRAFT' AND withdrawn = 0",
      { e: eventId, u: actor.id },
    );
    if (existing !== null) {
      throw errors.conflict('You already have a draft submission for this event.', [
        { field: 'submissionId', issue: existing.id },
      ]);
    }

    const projectName = validatePlainText(input.projectName ?? '', { field: 'project name', min: 2, max: 160 });
    const id = newId('submission');
    const slug = this.uniqueSlug(eventId, slugify(projectName));

    return this.db.transaction(() => {
      this.db.exec(
        `INSERT INTO submissions (
           id, event_id, team_id, track_id, created_by, slug, project_name, short_description,
           full_description, problem, solution, technologies, repository_url, demo_url,
           video_url, documentation_url, cover_image_url, state, current_version,
           gallery_visible, eligible_for_prizes, created_at, updated_at
         ) VALUES (
           :id, :e, :t, :track, :by, :slug, :name, :short,
           :full, :problem, :solution, :tech, :repo, :demo,
           :video, :docs, :cover, 'DRAFT', 0,
           :visible, :eligible, :at, :at
         )`,
        {
          id,
          e: eventId,
          t: teamId,
          track: input.trackId ?? null,
          by: actor.id,
          slug,
          name: projectName,
          short: validatePlainText(input.shortDescription ?? '', { field: 'short description', max: 400 }),
          full: validatePlainText(input.fullDescription ?? '', { field: 'full description', max: 20_000 }),
          problem: validatePlainText(input.problem ?? '', { field: 'problem', max: 10_000 }),
          solution: validatePlainText(input.solution ?? '', { field: 'solution', max: 10_000 }),
          tech: JSON.stringify(this.normaliseTechnologies(input.technologies ?? [])),
          repo: this.urlOrNull(input.repositoryUrl, 'repositoryUrl'),
          demo: this.urlOrNull(input.demoUrl, 'demoUrl'),
          video: this.urlOrNull(input.videoUrl, 'videoUrl'),
          docs: this.urlOrNull(input.documentationUrl, 'documentationUrl'),
          cover: this.urlOrNull(input.coverImageUrl, 'coverImageUrl'),
          visible: input.galleryVisible === false ? 0 : 1,
          eligible: input.eligibleForPrizes === false ? 0 : 1,
          at: ctx.at,
        },
      );

      this.writeVersion(id, actor.id, 'DRAFT', 'created the submission', [], ctx.at);

      this.audit.record({
        action: 'submission.created',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId,
        resourceType: 'submission',
        resourceId: id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        newState: 'DRAFT',
        metadata: { projectName, teamId },
        at: ctx.at,
      });

      return this.require(id);
    });
  }

  /* ------------------------------------------------------------- update */

  update(submissionId: string, input: SubmissionInput, ctx: ActorContext): SubmissionRow {
    const actor = requireActor(ctx);
    const before = this.require(submissionId);
    this.assertEditable(before, actor, ctx);

    const patch = this.buildPatch(input);
    if (Object.keys(patch).length === 0) return before;

    const changed = Object.keys(patch).filter((key) => String(before[key as keyof SubmissionRow]) !== String(patch[key]));

    return this.db.transaction(() => {
      const assignments = Object.keys(patch).map((key) => `"${key}" = :${key}`);
      this.db.exec(`UPDATE submissions SET ${assignments.join(', ')}, updated_at = :at WHERE id = :id`, {
        ...patch,
        at: ctx.at,
        id: submissionId,
      });
      this.writeVersion(submissionId, actor.id, before.state, 'edited the submission', changed, ctx.at);

      this.audit.record({
        action: 'submission.updated',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: before.event_id,
        resourceType: 'submission',
        resourceId: submissionId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { changed },
        at: ctx.at,
      });

      return this.require(submissionId);
    });
  }

  /** DRAFT -> SUBMITTED. Deadline-checked, overridable, audited. */
  submit(submissionId: string, options: { override?: boolean; reason?: string } = {}, ctx: ActorContext): SubmissionRow {
    const actor = requireActor(ctx);
    const before = this.require(submissionId);
    this.assertOwner(before, actor, ctx);

    const event = this.events.require(before.event_id);
    const windowOpen = this.events.isSubmissionOpen(event, ctx.at);

    const transitionContext: TransitionContext = {
      override: options.override === true,
      facts: { submissionWindowOpen: windowOpen },
      actor: { id: actor.id, roles: actor.roles },
    };

    try {
      assertTransition<SubmissionState>('Submission', before.state, 'SUBMITTED', transitionContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'not permitted';
      this.audit.record({
        action: options.override ? 'submission.override' : 'submission.submitted',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: before.event_id,
        resourceType: 'submission',
        resourceId: submissionId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        previousState: before.state,
        newState: 'SUBMITTED',
        outcome: 'DENIED',
        metadata: { reason: message, windowOpen, override: options.override === true },
        at: ctx.at,
      });
      throw errors.deadlinePassed(message);
    }

    this.validateForSubmission(before, event);

    this.db.transaction(() => {
      this.db.exec(
        `UPDATE submissions SET state = 'SUBMITTED', submitted_at = :at, updated_at = :at WHERE id = :id`,
        { at: ctx.at, id: submissionId },
      );
      this.writeVersion(submissionId, actor.id, 'SUBMITTED', 'submitted the project', ['state'], ctx.at);
      this.audit.record({
        action: options.override ? 'submission.override' : 'submission.submitted',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: before.event_id,
        resourceType: 'submission',
        resourceId: submissionId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        previousState: before.state,
        newState: 'SUBMITTED',
        metadata: { ...(options.reason ? { reason: options.reason } : {}), override: options.override === true },
        at: ctx.at,
      });
    });

    /*
     * `submission.created` fires on the draft -> SUBMITTED change, not on
     * `create()`. A draft is a private working copy that may never be entered,
     * so announcing it would put projects in a receiver that were never in the
     * contest. The draft is not an announcement anyone can act on.
     *
     * After the transaction, like every other dispatch here: the attempt writes
     * its outcome back to the database and must not race the commit.
     */
    this.services.webhooks.dispatch(
      before.event_id,
      'submission.created',
      { submissionId, teamId: before.team_id, slug: before.slug, projectName: before.project_name, trackId: before.track_id },
      ctx,
    );

    return this.require(submissionId);
  }

  /** Withdraw a submitted project back to editing (only inside the window). */
  withdraw(submissionId: string, ctx: ActorContext): SubmissionRow {
    const actor = requireActor(ctx);
    const before = this.require(submissionId);
    this.assertOwner(before, actor, ctx);
    const event = this.events.require(before.event_id);

    const transitionContext: TransitionContext = {
      override: false,
      facts: { submissionWindowOpen: this.events.isSubmissionOpen(event, ctx.at) },
      actor: { id: actor.id, roles: actor.roles },
    };
    assertTransition<SubmissionState>('Submission', before.state, 'DRAFT', transitionContext);

    this.db.exec("UPDATE submissions SET state = 'DRAFT', submitted_at = NULL, updated_at = :at WHERE id = :id", {
      at: ctx.at,
      id: submissionId,
    });
    this.writeVersion(submissionId, actor.id, 'DRAFT', 'withdrew the project back to draft', ['state'], ctx.at);
    this.audit.record({
      action: 'submission.updated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: before.event_id,
      resourceType: 'submission',
      resourceId: submissionId,
      requestId: ctx.requestId,
      previousState: before.state,
      newState: 'DRAFT',
      at: ctx.at,
    });
    return this.require(submissionId);
  }

  /** Organizer lifecycle move (lock, unlock, finalize, re-open). */
  transition(submissionId: string, to: SubmissionState, options: { override?: boolean; reason?: string } = {}, ctx: ActorContext): SubmissionRow {
    const actor = requireActor(ctx);
    const before = this.require(submissionId);
    const event = this.events.require(before.event_id);
    this.events.assertOrganizer(actor, event, ctx);

    const transitionContext: TransitionContext = {
      override: options.override === true,
      facts: { submissionWindowOpen: this.events.isSubmissionOpen(event, ctx.at) },
      actor: { id: actor.id, roles: actor.roles },
    };
    try {
      assertTransition<SubmissionState>('Submission', before.state, to, transitionContext);
    } catch (error) {
      throw errors.illegalTransition(error instanceof Error ? error.message : 'not permitted');
    }

    const patch: Record<string, string | null> = { state: to, updated_at: ctx.at };
    if (to === 'LOCKED') patch.locked_at = ctx.at;
    if (to === 'FINALIZED') patch.finalized_at = ctx.at;
    if (to === 'SUBMITTED' && before.submitted_at === null) patch.submitted_at = ctx.at;

    this.db.transaction(() => {
      const assignments = Object.keys(patch).map((key) => `"${key}" = :${key}`);
      this.db.exec(`UPDATE submissions SET ${assignments.join(', ')} WHERE id = :id`, { ...patch, id: submissionId });
      this.writeVersion(submissionId, actor.id, to, `moved to ${to}`, ['state'], ctx.at);
      this.audit.record({
        action: to === 'LOCKED' ? 'submission.locked' : options.override ? 'submission.override' : 'submission.updated',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: before.event_id,
        resourceType: 'submission',
        resourceId: submissionId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        previousState: before.state,
        newState: to,
        metadata: { ...(options.reason ? { reason: options.reason } : {}), override: options.override === true },
        at: ctx.at,
      });
    });

    if (to === 'LOCKED') {
      this.services.webhooks.dispatch(
        before.event_id,
        'submission.locked',
        { submissionId, teamId: before.team_id, slug: before.slug, projectName: before.project_name, state: to },
        ctx,
      );
    }

    return this.require(submissionId);
  }

  /** Hide a project from the gallery without deleting it. */
  setGalleryVisibility(submissionId: string, visible: boolean, ctx: ActorContext): SubmissionRow {
    const actor = requireActor(ctx);
    const before = this.require(submissionId);
    this.assertOwner(before, actor, ctx);
    this.db.exec('UPDATE submissions SET gallery_visible = :v, updated_at = :at WHERE id = :id', {
      v: visible ? 1 : 0,
      at: ctx.at,
      id: submissionId,
    });
    this.writeVersion(submissionId, actor.id, before.state, visible ? 'made the project public' : 'hid the project from the gallery', ['gallery_visible'], ctx.at);
    this.audit.record({
      action: 'submission.updated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: before.event_id,
      resourceType: 'submission',
      resourceId: submissionId,
      requestId: ctx.requestId,
      metadata: { galleryVisible: visible },
      at: ctx.at,
    });
    return this.require(submissionId);
  }

  /* ---------------------------------------------------------- versions */

  versions(submissionId: string) {
    return this.db.all(
      `SELECT v.id, v.version, v.state, v.changed_fields, v.checksum, v.is_final, v.note, v.created_at,
              u.display_name AS author_name
       FROM submission_versions v JOIN users u ON u.id = v.author_id
       WHERE v.submission_id = :s ORDER BY v.version`,
      { s: submissionId },
    );
  }

  version(submissionId: string, version: number) {
    return this.db.get('SELECT * FROM submission_versions WHERE submission_id = :s AND version = :v', {
      s: submissionId,
      v: version,
    });
  }

  /** Append an immutable version snapshot. */
  private writeVersion(
    submissionId: string,
    authorId: string,
    state: SubmissionState,
    note: string,
    changedFields: string[],
    at: string,
  ): void {
    const current = this.require(submissionId);
    const version = current.current_version + 1;
    const snapshot = canonicalJson({
      projectName: current.project_name,
      shortDescription: current.short_description,
      fullDescription: current.full_description,
      problem: current.problem,
      solution: current.solution,
      technologies: safeJson(current.technologies),
      trackId: current.track_id,
      repositoryUrl: current.repository_url,
      demoUrl: current.demo_url,
      videoUrl: current.video_url,
      documentationUrl: current.documentation_url,
      coverImageUrl: current.cover_image_url,
      state,
      galleryVisible: current.gallery_visible === 1,
    });
    const checksum = sha256Hex(snapshot);

    this.db.exec(
      `INSERT INTO submission_versions (id, submission_id, version, author_id, state, changed_fields, snapshot, checksum, note, created_at)
       VALUES (:id, :s, :v, :a, :state, :changed, :snapshot, :checksum, :note, :at)`,
      {
        id: newId('submissionVersion'),
        s: submissionId,
        v: version,
        a: authorId,
        state,
        changed: JSON.stringify(changedFields),
        snapshot,
        checksum,
        note,
        at,
      },
    );
    this.db.exec('UPDATE submissions SET current_version = :v WHERE id = :id', { v: version, id: submissionId });
  }

  /* ----------------------------------------------------------- queries */

  findById(id: string): SubmissionRow | null {
    return this.db.get<SubmissionRow>('SELECT * FROM submissions WHERE id = :id', { id });
  }

  findBySlug(eventId: string, slug: string): SubmissionRow | null {
    return this.db.get<SubmissionRow>('SELECT * FROM submissions WHERE event_id = :e AND slug = :s', { e: eventId, s: slug });
  }

  require(id: string): SubmissionRow {
    const row = this.findById(id);
    if (row === null) throw errors.notFound('Submission', id);
    return row;
  }

  /** Projects eligible for judging: submitted, not withdrawn. */
  judgable(eventId: string): SubmissionRow[] {
    return this.db.all<SubmissionRow>(
      `SELECT * FROM submissions
       WHERE event_id = :e AND withdrawn = 0 AND state IN ('SUBMITTED','LOCKED','JUDGING','FINALIZED')
       ORDER BY submitted_at, id`,
      { e: eventId },
    );
  }

  listForEvent(
    eventId: string,
    filter: { state?: SubmissionState; trackId?: string; teamId?: string; search?: string; limit: number; offset: number },
  ): { rows: SubmissionRow[]; total: number } {
    const conditions = ['s.event_id = :e', 's.withdrawn = 0'];
    const params: Record<string, string | number> = { e: eventId, limit: filter.limit, offset: filter.offset };
    if (filter.state) {
      conditions.push('s.state = :state');
      params.state = filter.state;
    }
    if (filter.trackId) {
      conditions.push('s.track_id = :track');
      params.track = filter.trackId;
    }
    if (filter.teamId) {
      conditions.push('s.team_id = :team');
      params.team = filter.teamId;
    }
    if (filter.search) {
      conditions.push(
        "(LOWER(s.project_name) LIKE :search ESCAPE '\\' OR LOWER(s.short_description) LIKE :search ESCAPE '\\' OR LOWER(s.technologies) LIKE :search ESCAPE '\\')",
      );
      params.search = `%${filter.search.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    }
    const clause = `WHERE ${conditions.join(' AND ')}`;
    const total = this.db.value<number>(`SELECT COUNT(*) AS c FROM submissions s ${clause}`, params) ?? 0;
    return {
      rows: this.db.all<SubmissionRow>(`SELECT s.* FROM submissions s ${clause} ORDER BY s.submitted_at DESC LIMIT :limit OFFSET :offset`, params),
      total,
    };
  }

  screenshots(submissionId: string): UploadRow[] {
    return this.uploads.listForSubmission(submissionId).filter((upload) => upload.kind === 'SCREENSHOT');
  }

  /**
   * Gallery ordering.
   *
   * `RANDOMIZED` uses a per-day seeded shuffle so a visitor sees a stable order
   * for the whole day (no reshuffling on every refresh) while different days
   * and different events differ. Reproducible, not arbitrary.
   */
  orderForGallery(rows: SubmissionRow[], mode: EventRow['gallery_order'], eventId: string, at: string): SubmissionRow[] {
    switch (mode) {
      case 'ALPHABETICAL':
        return [...rows].sort((a, b) => a.project_name.localeCompare(b.project_name));
      case 'SUBMISSION':
        return [...rows].sort((a, b) => (a.submitted_at ?? a.created_at).localeCompare(b.submitted_at ?? b.created_at));
      case 'VOTES': {
        const counts = new Map<string, number>();
        for (const row of this.db.all<{ submission_id: string; count: number }>(
          'SELECT submission_id, COUNT(*) AS count FROM community_votes WHERE event_id = :e GROUP BY submission_id',
          { e: eventId },
        )) {
          counts.set(row.submission_id, Number(row.count));
        }
        return [...rows].sort(
          (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.project_name.localeCompare(b.project_name),
        );
      }
      case 'RANDOMIZED':
      default: {
        const day = at.slice(0, 10);
        return seededGalleryOrder(rows, eventId, day);
      }
    }
  }

  /* ---------------------------------------------------------- guards */

  /**
   * Whether this actor could edit this submission right now, and why not.
   *
   * This is the read-side twin of `assertEditable`: the same ownership, state
   * and deadline facts, but answering with a value instead of a throw. The
   * participant form uses it to disable its inputs and explain why, so the
   * client never has to re-derive a server rule (and never disagrees with one).
   */
  canEdit(
    submission: SubmissionRow,
    actor: { id: string; roles: string[]; eventIds: string[] } | null,
    ctx: ActorContext,
  ): { editable: boolean; reason: string | null } {
    if (actor === null) return { editable: false, reason: 'Sign in to edit this project.' };

    const isOwner =
      submission.created_by === actor.id ||
      (submission.team_id !== null && this.teams.member(submission.team_id, actor.id) !== null);
    const isManager = canManageEvent(actor as never, submission.event_id);

    if (!isOwner && !isManager) {
      return { editable: false, reason: 'Only the project owner, a team member, or an organizer can change this submission.' };
    }

    if (submission.state === 'LOCKED' || submission.state === 'FINALIZED') {
      return { editable: false, reason: `This project is ${submission.state.toLowerCase()} and can no longer be edited.` };
    }

    if (isManager) return { editable: true, reason: null };

    const event = this.events.require(submission.event_id);
    if (!this.events.isFrozen(event, ctx.at)) return { editable: true, reason: null };

    const deadline = event.submission_closes_at ?? 'the submission deadline';
    return {
      editable: false,
      reason: `The submission deadline (${deadline}) has passed and the project set is frozen. An organizer can apply an audited override.`,
    };
  }

  /** Server-authoritative edit gate. */
  assertEditable(submission: SubmissionRow, actor: { id: string; roles: string[]; eventIds: string[] }, ctx: ActorContext): void {
    const verdict = this.canEdit(submission, actor, ctx);
    if (verdict.editable) return;
    // Ownership failures are a 403 and are worth an audit row; a closed window is
    // a 409 and is not. `canEdit` deliberately does not decide which, so the
    // original split is preserved here rather than collapsed.
    if (verdict.reason?.startsWith('Only the project owner') === true) {
      this.assertOwner(submission, actor, ctx);
      return;
    }
    if (verdict.reason?.startsWith('This project is') === true) {
      throw errors.immutable(verdict.reason);
    }
    const event = this.events.require(submission.event_id);
    const deadline = event.submission_closes_at ?? 'the submission deadline';
    throw errors.deadlinePassed(
      `"${submission.project_name}" can no longer be edited: ${deadline} has passed and the project set for "${event.name}" is frozen. ` +
        'An organizer can apply an audited override if this is genuinely necessary.',
    );
  }

  private assertOwner(
    submission: SubmissionRow,
    actor: { id: string; roles: string[]; eventIds: string[] },
    ctx: ActorContext,
  ): void {
    if (submission.created_by === actor.id) return;
    if (submission.team_id !== null && this.teams.member(submission.team_id, actor.id) !== null) return;
    if (canManageEvent(actor as never, submission.event_id)) return;
    this.audit.recordDenied({
      action: 'submission.updated',
      actorId: actor.id,
      actorRoles: actor.roles as never,
      eventId: submission.event_id,
      resourceType: 'submission',
      resourceId: submission.id,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      reason: 'not the owner, a team member, or an organizer',
      at: ctx.at,
    });
    throw errors.forbidden('Only the project owner, a team member, or an organizer can change this submission.');
  }

  /**
   * Completeness check performed at submit time, not at save time, so a
   * participant can save a half-finished draft right up to the deadline.
   */
  private validateForSubmission(submission: SubmissionRow, event: EventRow): void {
    const problems: string[] = [];
    if (submission.short_description.trim().length < 20) {
      problems.push('Add a short description of at least 20 characters so judges know what they are looking at.');
    }
    if (submission.full_description.trim().length < 100) {
      problems.push('Add a full description of at least 100 characters.');
    }
    if (submission.problem.trim().length < 20) problems.push('Describe the problem you are solving.');
    if (submission.solution.trim().length < 20) problems.push('Describe your solution.');
    if (safeJson(submission.technologies).length === 0) problems.push('List at least one technology used.');
    if (submission.repository_url === null) problems.push('Add a link to the source repository.');
    if (submission.team_id === null && event.allow_individual !== 1) {
      problems.push('This event requires the project to belong to a team.');
    }

    if (problems.length > 0) {
      throw errors.validation('This project is not ready to submit.', problems.map((issue) => ({ field: 'submission', issue })));
    }
  }

  private buildPatch(input: SubmissionInput): Record<string, string | number | null> {
    const patch: Record<string, string | number | null> = {};
    if (input.projectName !== undefined) patch.project_name = validatePlainText(input.projectName, { field: 'project name', min: 2, max: 160 });
    if (input.shortDescription !== undefined) patch.short_description = validatePlainText(input.shortDescription, { field: 'short description', max: 400 });
    if (input.fullDescription !== undefined) patch.full_description = validatePlainText(input.fullDescription, { field: 'full description', max: 20_000 });
    if (input.problem !== undefined) patch.problem = validatePlainText(input.problem, { field: 'problem', max: 10_000 });
    if (input.solution !== undefined) patch.solution = validatePlainText(input.solution, { field: 'solution', max: 10_000 });
    if (input.technologies !== undefined) patch.technologies = JSON.stringify(this.normaliseTechnologies(input.technologies));
    if (input.trackId !== undefined) patch.track_id = input.trackId;
    if (input.repositoryUrl !== undefined) patch.repository_url = this.urlOrNull(input.repositoryUrl, 'repositoryUrl');
    if (input.demoUrl !== undefined) patch.demo_url = this.urlOrNull(input.demoUrl, 'demoUrl');
    if (input.videoUrl !== undefined) patch.video_url = this.urlOrNull(input.videoUrl, 'videoUrl');
    if (input.documentationUrl !== undefined) patch.documentation_url = this.urlOrNull(input.documentationUrl, 'documentationUrl');
    if (input.coverImageUrl !== undefined) patch.cover_image_url = this.urlOrNull(input.coverImageUrl, 'coverImageUrl');
    if (input.galleryVisible !== undefined) patch.gallery_visible = input.galleryVisible ? 1 : 0;
    if (input.eligibleForPrizes !== undefined) patch.eligible_for_prizes = input.eligibleForPrizes ? 1 : 0;
    // Only allow writes to fields the service knows how to version.
    for (const key of Object.keys(patch)) {
      if (!MUTABLE_FIELDS.includes(key as keyof SubmissionRow)) delete patch[key];
    }
    return patch;
  }

  private normaliseTechnologies(values: string[]): string[] {
    const cleaned = values
      .map((value) => validatePlainText(value, { field: 'technology', max: 60 }))
      .filter((value) => value.length > 0);
    return [...new Set(cleaned.map((value) => value.trim()))].slice(0, 40);
  }

  private urlOrNull(value: string | null | undefined, field: string): string | null {
    if (value === null || value === undefined || value === '') return null;
    const result = validateHttpUrl(value, { allowPrivateHosts: true });
    if (!result.valid) {
      throw errors.validation('That URL cannot be accepted.', [{ field, issue: result.reason }]);
    }
    return result.url;
  }

  private uniqueSlug(eventId: string, base: string): string {
    let candidate = base || 'project';
    let suffix = 1;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const clash = this.db.get<{ id: string }>('SELECT id FROM submissions WHERE event_id = :e AND slug = :s', {
        e: eventId,
        s: candidate,
      });
      if (clash === null) return candidate;
      suffix += 1;
      candidate = `${base}-${String(suffix)}`;
    }
    throw errors.conflict('Could not derive a unique project slug.');
  }
}

export function safeJson(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export { isOneOf };

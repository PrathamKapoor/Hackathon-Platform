/**
 * Event lifecycle: events, tracks, prizes, and the state machine that governs
 * them.
 *
 * All date handling goes through `@verdict/core/time`. An organizer enters a
 * wall-clock local time plus an IANA zone; the service converts to a UTC
 * instant on write and keeps the zone so the UI can show "as you typed it".
 * Nothing in this file compares a browser-supplied timestamp against a
 * deadline.
 */

import { newId } from '@verdict/core/ids';
import {
  addSeconds,
  compare,
  evaluateDeadline,
  isValidInstant,
  isValidTimeZone,
  localWallClockToInstant,
  now,
  toEpochMs,
  type Instant,
} from '@verdict/core/time';
import { assertTransition, transitionCheck, type TransitionContext } from '@verdict/core/state-machines';
import { validateHttpUrl, validatePlainText, validateSlug } from '@verdict/core/validation';
import type { EventState, Role } from '@verdict/core/types';
import { errors } from '../lib/errors.ts';
import { canManageEvent } from '../lib/rbac.ts';
import type { ActorContext, ServiceBase, Services } from './context.ts';
import { requireActor } from './context.ts';

export type EventRow = {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  rules: string;
  state: EventState;
  timezone: string;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  submission_opens_at: string | null;
  submission_closes_at: string | null;
  judging_opens_at: string | null;
  judging_closes_at: string | null;
  voting_opens_at: string | null;
  voting_closes_at: string | null;
  results_published_at: string | null;
  max_team_size: number;
  min_team_size: number;
  allow_individual: number;
  gallery_visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  gallery_order: 'RANDOMIZED' | 'ALPHABETICAL' | 'SUBMISSION' | 'VOTES';
  voting_enabled: number;
  voting_reveal_totals: number;
  voting_requires_registration: number;
  comments_enabled: number;
  comments_require_approval: number;
  results_visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  results_publish_criterion_breakdown: number;
  results_publish_judge_count: number;
  reviews_per_project: number;
  minimum_judges: number;
  normalize_by_votes: number;
  assignment_seed: string;
  banner_url: string | null;
  logo_url: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type EventPatch = {
  name?: string;
  tagline?: string;
  description?: string;
  rules?: string;
  timezone?: string;
  registrationOpensAt?: string | null;
  registrationClosesAt?: string | null;
  submissionOpensAt?: string | null;
  submissionClosesAt?: string | null;
  judgingOpensAt?: string | null;
  judgingClosesAt?: string | null;
  votingOpensAt?: string | null;
  votingClosesAt?: string | null;
  maxTeamSize?: number;
  minTeamSize?: number;
  allowIndividual?: boolean;
  galleryVisibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  galleryOrder?: 'RANDOMIZED' | 'ALPHABETICAL' | 'SUBMISSION' | 'VOTES';
  votingEnabled?: boolean;
  votingRevealTotals?: boolean;
  votingRequiresRegistration?: boolean;
  commentsEnabled?: boolean;
  commentsRequireApproval?: boolean;
  resultsVisibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  resultsPublishCriterionBreakdown?: boolean;
  resultsPublishJudgeCount?: boolean;
  reviewsPerProject?: number;
  minimumJudges?: number;
  normalizeByVotes?: boolean;
  assignmentSeed?: string;
  bannerUrl?: string | null;
  logoUrl?: string | null;
};

const TRACK_COLORS = ['#5227FF', '#B497CF', '#FF9FFC', '#2F6BFF', '#0E9F6E', '#C2410C', '#7C3AED', '#0F766E'];

export class EventService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly config: Services['config'];

  constructor(services: ServiceBase) {
    this.db = services.db;
    this.audit = services.audit;
    this.config = services.config;
  }

  /* --------------------------------------------------------- lifecycle */

  create(input: EventPatch & { slug: string; name: string; timezone: string }, ctx: ActorContext): EventRow {
    const actor = requireActor(ctx);
    const slug = validateSlug(input.slug, 'event slug');
    const name = validatePlainText(input.name, { field: 'event name', min: 3, max: 160 });
    const timezone = this.requireTimezone(input.timezone);

    if (this.findBySlug(slug) !== null) {
      throw errors.conflict(`An event already uses the slug "${slug}".`, [{ field: 'slug', issue: 'already taken' }]);
    }

    const id = newId('event');
    const at = ctx.at;
    const seed = input.assignmentSeed?.trim() || `${slug}:${id}`;

    this.db.exec(
      `INSERT INTO events (
         id, slug, name, tagline, description, rules, state, timezone,
         registration_opens_at, registration_closes_at, submission_opens_at, submission_closes_at,
         judging_opens_at, judging_closes_at, voting_opens_at, voting_closes_at,
         max_team_size, min_team_size, allow_individual, gallery_visibility, gallery_order,
         voting_enabled, voting_reveal_totals, voting_requires_registration,
         comments_enabled, comments_require_approval, results_visibility,
         results_publish_criterion_breakdown, results_publish_judge_count,
         reviews_per_project, minimum_judges, normalize_by_votes, assignment_seed,
         banner_url, logo_url, created_by, created_at, updated_at
       ) VALUES (
         :id, :slug, :name, :tagline, :description, :rules, 'DRAFT', :timezone,
         :registration_opens_at, :registration_closes_at, :submission_opens_at, :submission_closes_at,
         :judging_opens_at, :judging_closes_at, :voting_opens_at, :voting_closes_at,
         :max_team_size, :min_team_size, :allow_individual, :gallery_visibility, :gallery_order,
         :voting_enabled, :voting_reveal_totals, :voting_requires_registration,
         :comments_enabled, :comments_require_approval, :results_visibility,
         1, 1, :reviews_per_project, :minimum_judges, :normalize_by_votes, :assignment_seed,
         :banner_url, :logo_url, :created_by, :at, :at
       )`,
      {
        id,
        slug,
        name,
        tagline: validatePlainText(input.tagline ?? '', { field: 'tagline', max: 200 }),
        description: validatePlainText(input.description ?? '', { field: 'description', max: 20_000 }),
        rules: validatePlainText(input.rules ?? '', { field: 'rules', max: 20_000 }),
        timezone,
        registration_opens_at: this.toInstantOrNull(input.registrationOpensAt, timezone),
        registration_closes_at: this.toInstantOrNull(input.registrationClosesAt, timezone),
        submission_opens_at: this.toInstantOrNull(input.submissionOpensAt, timezone),
        submission_closes_at: this.toInstantOrNull(input.submissionClosesAt, timezone),
        judging_opens_at: this.toInstantOrNull(input.judgingOpensAt, timezone),
        judging_closes_at: this.toInstantOrNull(input.judgingClosesAt, timezone),
        voting_opens_at: this.toInstantOrNull(input.votingOpensAt, timezone),
        voting_closes_at: this.toInstantOrNull(input.votingClosesAt, timezone),
        max_team_size: clampInt(input.maxTeamSize ?? 5, 1, 100, 'maxTeamSize'),
        min_team_size: clampInt(input.minTeamSize ?? 1, 1, 100, 'minTeamSize'),
        allow_individual: (input.allowIndividual ?? false) ? 1 : 0,
        gallery_visibility: input.galleryVisibility ?? 'PUBLIC',
        gallery_order: input.galleryOrder ?? 'RANDOMIZED',
        voting_enabled: (input.votingEnabled ?? false) ? 1 : 0,
        voting_reveal_totals: (input.votingRevealTotals ?? true) ? 1 : 0,
        voting_requires_registration: (input.votingRequiresRegistration ?? true) ? 1 : 0,
        comments_enabled: (input.commentsEnabled ?? true) ? 1 : 0,
        comments_require_approval: (input.commentsRequireApproval ?? false) ? 1 : 0,
        results_visibility: input.resultsVisibility ?? 'PUBLIC',
        reviews_per_project: clampInt(input.reviewsPerProject ?? this.config.judging.reviewsPerProject, 1, 20, 'reviewsPerProject'),
        minimum_judges: clampInt(input.minimumJudges ?? this.config.judging.minimumJudges, 1, 20, 'minimumJudges'),
        normalize_by_votes: (input.normalizeByVotes ?? false) ? 1 : 0,
        assignment_seed: seed.slice(0, 120),
        banner_url: this.toUrlOrNull(input.bannerUrl, 'bannerUrl'),
        logo_url: this.toUrlOrNull(input.logoUrl, 'logoUrl'),
        created_by: actor.id,
        at,
      },
    );

    this.db.exec(
      `INSERT INTO user_roles (user_id, role, event_id, scope, granted_by, granted_at)
       VALUES (:user_id, 'ORGANIZER', :event_id, :event_id, :granted_by, :at)`,
      { user_id: actor.id, event_id: id, granted_by: actor.id, at },
    );

    // A default application form, so a new event is immediately usable.
    this.seedDefaultRegistrationFields(id, at);

    this.audit.record({
      action: 'event.created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: id,
      resourceType: 'event',
      resourceId: id,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      newState: 'DRAFT',
      metadata: { slug, name },
      at: ctx.at,
    });

    return this.require(id);
  }

  update(eventId: string, patch: EventPatch, ctx: ActorContext): EventRow {
    const actor = requireActor(ctx);
    const before = this.require(eventId);
    this.assertOrganizer(actor, before, ctx);

    // A published or archived event is frozen except for archival metadata.
    if (before.state === 'ARCHIVED') {
      throw errors.immutable('An archived event cannot be edited. Restore it to DRAFT first.');
    }

    const fields: Record<string, string | number | null> = { updated_at: ctx.at };
    const timezone = patch.timezone !== undefined ? this.requireTimezone(patch.timezone) : before.timezone;

    if (patch.name !== undefined) fields.name = validatePlainText(patch.name, { field: 'name', min: 3, max: 160 });
    if (patch.tagline !== undefined) fields.tagline = validatePlainText(patch.tagline, { field: 'tagline', max: 200 });
    if (patch.description !== undefined) fields.description = validatePlainText(patch.description, { field: 'description', max: 20_000 });
    if (patch.rules !== undefined) fields.rules = validatePlainText(patch.rules, { field: 'rules', max: 20_000 });
    if (patch.timezone !== undefined) fields.timezone = timezone;
    if (patch.maxTeamSize !== undefined) fields.max_team_size = clampInt(patch.maxTeamSize, 1, 100, 'maxTeamSize');
    if (patch.minTeamSize !== undefined) fields.min_team_size = clampInt(patch.minTeamSize, 1, 100, 'minTeamSize');
    if (patch.allowIndividual !== undefined) fields.allow_individual = patch.allowIndividual ? 1 : 0;
    if (patch.galleryVisibility !== undefined) fields.gallery_visibility = patch.galleryVisibility;
    if (patch.galleryOrder !== undefined) fields.gallery_order = patch.galleryOrder;
    if (patch.votingEnabled !== undefined) fields.voting_enabled = patch.votingEnabled ? 1 : 0;
    if (patch.votingRevealTotals !== undefined) fields.voting_reveal_totals = patch.votingRevealTotals ? 1 : 0;
    if (patch.votingRequiresRegistration !== undefined) fields.voting_requires_registration = patch.votingRequiresRegistration ? 1 : 0;
    if (patch.commentsEnabled !== undefined) fields.comments_enabled = patch.commentsEnabled ? 1 : 0;
    if (patch.commentsRequireApproval !== undefined) fields.comments_require_approval = patch.commentsRequireApproval ? 1 : 0;
    if (patch.resultsVisibility !== undefined) fields.results_visibility = patch.resultsVisibility;
    if (patch.resultsPublishCriterionBreakdown !== undefined) fields.results_publish_criterion_breakdown = patch.resultsPublishCriterionBreakdown ? 1 : 0;
    if (patch.resultsPublishJudgeCount !== undefined) fields.results_publish_judge_count = patch.resultsPublishJudgeCount ? 1 : 0;
    if (patch.reviewsPerProject !== undefined) fields.reviews_per_project = clampInt(patch.reviewsPerProject, 1, 20, 'reviewsPerProject');
    if (patch.minimumJudges !== undefined) fields.minimum_judges = clampInt(patch.minimumJudges, 1, 20, 'minimumJudges');
    if (patch.normalizeByVotes !== undefined) fields.normalize_by_votes = patch.normalizeByVotes ? 1 : 0;
    if (patch.assignmentSeed !== undefined) fields.assignment_seed = validatePlainText(patch.assignmentSeed, { field: 'assignmentSeed', max: 120 });
    if (patch.bannerUrl !== undefined) fields.banner_url = this.toUrlOrNull(patch.bannerUrl, 'bannerUrl');
    if (patch.logoUrl !== undefined) fields.logo_url = this.toUrlOrNull(patch.logoUrl, 'logoUrl');

    const windowFields: [keyof EventPatch, string][] = [
      ['registrationOpensAt', 'registration_opens_at'],
      ['registrationClosesAt', 'registration_closes_at'],
      ['submissionOpensAt', 'submission_opens_at'],
      ['submissionClosesAt', 'submission_closes_at'],
      ['judgingOpensAt', 'judging_opens_at'],
      ['judgingClosesAt', 'judging_closes_at'],
      ['votingOpensAt', 'voting_opens_at'],
      ['votingClosesAt', 'voting_closes_at'],
    ];
    for (const [key, column] of windowFields) {
      if (patch[key] !== undefined) fields[column] = this.toInstantOrNull(patch[key] as string | null, timezone);
    }

    this.validateWindowOrder(fields, before);

    const assignments = Object.keys(fields).map((key) => `"${key}" = :${key}`);
    this.db.exec(`UPDATE events SET ${assignments.join(', ')} WHERE id = :id`, { ...fields, id: eventId });

    this.audit.record({
      action: 'event.updated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'event',
      resourceId: eventId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { changed: Object.keys(fields).filter((k) => k !== 'updated_at') },
      at: ctx.at,
    });

    return this.require(eventId);
  }

  /**
   * Move the event through its lifecycle.
   *
   * The state machine is the only thing that decides whether the move is legal;
   * this method supplies the facts the guards need and turns a refusal into a
   * 409 with the machine's own explanation.
   */
  transition(eventId: string, to: EventState, options: { override?: boolean; reason?: string } = {}, ctx: ActorContext): EventRow {
    const actor = requireActor(ctx);
    const before = this.require(eventId);
    this.assertOrganizer(actor, before, ctx);

    const facts: Record<string, unknown> = {
      registrationOpensAt: before.registration_opens_at,
      deadlinePassed: this.submissionDeadlinePassed(before, ctx.at),
      submissionCount: this.countSubmissions(eventId),
      incompleteAssignments: this.countIncompleteAssignments(eventId),
    };

    const transitionContext: TransitionContext = {
      override: options.override === true,
      facts,
      actor: { id: actor.id, roles: actor.roles },
    };

    const probe = transitionCheck<EventState>('Event', before.state, to, transitionContext);
    if (!probe.allowed) {
      this.audit.record({
        action: options.override ? 'event.deadline_overridden' : 'event.state_changed',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId,
        resourceType: 'event',
        resourceId: eventId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        previousState: before.state,
        newState: to,
        outcome: 'DENIED',
        metadata: { reason: probe.reason, attemptedAt: ctx.at },
        at: ctx.at,
      });
      throw errors.illegalTransition(probe.reason ?? 'That transition is not permitted.', [
        { field: 'state', issue: `from ${before.state} to ${to}` },
      ]);
    }

    const patch: Record<string, string | number | null> = { state: to, updated_at: ctx.at };
    // Publishing stamps the moment, which the certificate and webhook layers read.
    if (to === 'PUBLISHED' && before.results_published_at === null) {
      patch.results_published_at = ctx.at;
    }
    const assignments = Object.keys(patch).map((key) => `"${key}" = :${key}`);
    this.db.exec(`UPDATE events SET ${assignments.join(', ')} WHERE id = :id`, { ...patch, id: eventId });

    // Locking submissions freezes their final versions, enforced by a trigger.
    if (to === 'SUBMISSIONS_LOCKED') this.freezeSubmissionVersions(eventId, ctx.at);
    if (to === 'JUDGING') this.moveSubmissionsToJudging(eventId, ctx.at);
    if (to === 'ARCHIVED') this.freezeSubmissionVersions(eventId, ctx.at);

    this.audit.record({
      action: options.override ? 'event.deadline_overridden' : 'event.state_changed',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'event',
      resourceId: eventId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      previousState: before.state,
      newState: to,
      metadata: { ...(options.reason ? { reason: options.reason } : {}), override: options.override === true },
      at: ctx.at,
    });

    return this.require(eventId);
  }

  /* ------------------------------------------------------------ windows */

  /**
   * Server-authoritative window evaluation. Every deadline question in the
   * product funnels through here so there is one implementation.
   */
  window(event: EventRow, window: 'registration' | 'submission' | 'judging' | 'voting', at: Instant = now()) {
    const map = {
      registration: { opensAt: event.registration_opens_at, closesAt: event.registration_closes_at },
      submission: { opensAt: event.submission_opens_at, closesAt: event.submission_closes_at },
      judging: { opensAt: event.judging_opens_at, closesAt: event.judging_closes_at },
      voting: { opensAt: event.voting_opens_at, closesAt: event.voting_closes_at },
    } as const;
    const windowSpec = map[window];
    return { ...evaluateDeadline(at, windowSpec), ...windowSpec };
  }

  isSubmissionOpen(event: EventRow, at: Instant = now()): boolean {
    return this.window(event, 'submission', at).open;
  }

  submissionDeadlinePassed(event: EventRow, at: Instant = now()): boolean {
    if (event.submission_closes_at === null) return false;
    return compare(at, event.submission_closes_at) >= 0;
  }

  /** Is the project set frozen for edits? */
  isFrozen(event: EventRow, at: Instant = now()): boolean {
    return (
      this.submissionDeadlinePassed(event, at) ||
      ['SUBMISSIONS_LOCKED', 'JUDGING', 'RESULTS_PENDING', 'PUBLISHED', 'ARCHIVED'].includes(event.state)
    );
  }

  /* ------------------------------------------------------------ queries */

  findById(id: string): EventRow | null {
    return this.db.get<EventRow>('SELECT * FROM events WHERE id = :id', { id });
  }

  findBySlug(slug: string): EventRow | null {
    return this.db.get<EventRow>('SELECT * FROM events WHERE slug = :slug', { slug });
  }

  require(idOrSlug: string): EventRow {
    const event = this.findById(idOrSlug) ?? this.findBySlug(idOrSlug);
    if (event === null) throw errors.notFound('Event', idOrSlug);
    return event;
  }

  listForActor(actorRoles: Role[], eventIds: string[], filter: { state?: EventState; search?: string; limit: number; offset: number }): { rows: EventRow[]; total: number } {
    const isAdmin = actorRoles.includes('ADMIN');
    const visible = isAdmin ? null : eventIds;
    const conditions: string[] = [];
    const params: Record<string, string | number | null> = { limit: filter.limit, offset: filter.offset };

    if (visible !== null) {
      if (visible.length === 0) return { rows: [], total: 0 };
      const placeholders = visible.map((_, i) => `:e${String(i)}`).join(', ');
      visible.forEach((id, i) => {
        params[`e${String(i)}`] = id;
      });
      conditions.push(`(id IN (${placeholders}) OR state IN ('REGISTRATION','ACTIVE','SUBMISSIONS_LOCKED','JUDGING','RESULTS_PENDING','PUBLISHED'))`);
    }
    if (filter.state) {
      conditions.push('state = :state');
      params.state = filter.state;
    }
    if (filter.search) {
      conditions.push("(LOWER(name) LIKE :search ESCAPE '\\' OR LOWER(slug) LIKE :search ESCAPE '\\' OR LOWER(tagline) LIKE :search ESCAPE '\\')");
      params.search = `%${filter.search.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    }
    const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = this.db.value<number>(`SELECT COUNT(*) AS c FROM events ${clause}`, params) ?? 0;
    const rows = this.db.all<EventRow>(`SELECT * FROM events ${clause} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`, params);
    return { rows, total };
  }

  publicList(filter: { state?: EventState; search?: string; limit: number; offset: number }): { rows: EventRow[]; total: number } {
    const conditions = ["state IN ('REGISTRATION','ACTIVE','SUBMISSIONS_LOCKED','JUDGING','RESULTS_PENDING','PUBLISHED')"];
    const params: Record<string, string | number | null> = { limit: filter.limit, offset: filter.offset };
    if (filter.state) {
      conditions.push('state = :state');
      params.state = filter.state;
    }
    if (filter.search) {
      conditions.push("(LOWER(name) LIKE :search ESCAPE '\\' OR LOWER(tagline) LIKE :search ESCAPE '\\')");
      params.search = `%${filter.search.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    }
    const clause = `WHERE ${conditions.join(' AND ')}`;
    const total = this.db.value<number>(`SELECT COUNT(*) AS c FROM events ${clause}`, params) ?? 0;
    return { rows: this.db.all<EventRow>(`SELECT * FROM events ${clause} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`, params), total };
  }

  /* ------------------------------------------------------------- tracks */

  addTrack(
    eventId: string,
    input: { slug?: string; name: string; description?: string; color?: string; maxProjects?: number | null },
    ctx: ActorContext,
  ) {
    const actor = requireActor(ctx);
    const event = this.require(eventId);
    this.assertOrganizer(actor, event, ctx);
    const name = validatePlainText(input.name, { field: 'track name', min: 2, max: 100 });
    const slug = validateSlug(input.slug ?? slugify(name), 'track slug');
    const id = newId('track');
    const order = (this.db.value<number>('SELECT COALESCE(MAX(display_order), -1) + 1 AS o FROM event_tracks WHERE event_id = :e', { e: eventId }) ?? 0) as number;

    this.db.exec(
      `INSERT INTO event_tracks (id, event_id, slug, name, description, color, max_projects, display_order, created_at, updated_at)
       VALUES (:id, :event_id, :slug, :name, :description, :color, :max_projects, :display_order, :at, :at)`,
      {
        id,
        event_id: eventId,
        slug,
        name,
        description: validatePlainText(input.description ?? '', { field: 'description', max: 2000 }),
        color: normaliseHex(input.color) ?? (TRACK_COLORS[order % TRACK_COLORS.length] as string),
        max_projects: input.maxProjects ?? null,
        display_order: order,
        at: ctx.at,
      },
    );
    this.audit.record({
      action: 'track.created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'track',
      resourceId: id,
      requestId: ctx.requestId,
      at: ctx.at,
    });
    return this.db.get('SELECT * FROM event_tracks WHERE id = :id', { id });
  }

  listTracks(eventId: string) {
    return this.db.all('SELECT * FROM event_tracks WHERE event_id = :e ORDER BY display_order, name', { e: eventId });
  }

  /* ------------------------------------------------------------- prizes */

  addPrize(
    eventId: string,
    input: { name: string; description?: string; quantity?: number; eligibleRanks?: number[]; eligibleTrackId?: string | null; priority?: number },
    ctx: ActorContext,
  ) {
    const actor = requireActor(ctx);
    const event = this.require(eventId);
    this.assertOrganizer(actor, event, ctx);
    const name = validatePlainText(input.name, { field: 'prize name', min: 2, max: 120 });
    const quantity = clampInt(input.quantity ?? 1, 1, 1000, 'quantity');
    const ranks = (input.eligibleRanks ?? []).filter((r) => Number.isInteger(r) && r >= 1);
    const id = newId('prize');
    const order = (this.db.value<number>('SELECT COALESCE(MAX(display_order), -1) + 1 AS o FROM prizes WHERE event_id = :e', { e: eventId }) ?? 0) as number;

    this.db.exec(
      `INSERT INTO prizes (id, event_id, name, description, quantity, eligible_ranks, eligible_track_id, priority, display_order, created_at, updated_at)
       VALUES (:id, :event_id, :name, :description, :quantity, :eligible_ranks, :eligible_track_id, :priority, :display_order, :at, :at)`,
      {
        id,
        event_id: eventId,
        name,
        description: validatePlainText(input.description ?? '', { field: 'description', max: 2000 }),
        quantity,
        eligible_ranks: JSON.stringify(ranks),
        eligible_track_id: input.eligibleTrackId ?? null,
        priority: clampInt(input.priority ?? 100, 0, 10_000, 'priority'),
        display_order: order,
        at: ctx.at,
      },
    );
    this.audit.record({
      action: 'prize.created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'prize',
      resourceId: id,
      requestId: ctx.requestId,
      at: ctx.at,
    });
    return this.db.get('SELECT * FROM prizes WHERE id = :id', { id });
  }

  listPrizes(eventId: string) {
    return this.db.all('SELECT * FROM prizes WHERE event_id = :e ORDER BY priority, display_order', { e: eventId });
  }

  deletePrize(eventId: string, prizeId: string, ctx: ActorContext): void {
    const actor = requireActor(ctx);
    const event = this.require(eventId);
    this.assertOrganizer(actor, event, ctx);
    this.db.exec('DELETE FROM prizes WHERE id = :id AND event_id = :e', { id: prizeId, e: eventId });
    this.audit.record({
      action: 'prize.updated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'prize',
      resourceId: prizeId,
      requestId: ctx.requestId,
      metadata: { deleted: true },
      at: ctx.at,
    });
  }

  /* ------------------------------------------------------------ helpers */

  assertOrganizer(actor: { id: string; roles: Role[]; eventIds: string[] }, event: EventRow, ctx: ActorContext): void {
    if (canManageEvent(actor as never, event.id)) return;
    this.audit.recordDenied({
      action: 'event.updated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: event.id,
      resourceType: 'event',
      resourceId: event.id,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      reason: 'not an organizer of this event',
      at: ctx.at,
    });
    throw errors.forbidden('You are not an organizer of this event.');
  }

  private countSubmissions(eventId: string): number {
    return (
      this.db.value<number>(
        "SELECT COUNT(*) AS c FROM submissions WHERE event_id = :e AND state IN ('SUBMITTED','LOCKED','JUDGING','FINALIZED') AND withdrawn = 0",
        { e: eventId },
      ) ?? 0
    );
  }

  private countIncompleteAssignments(eventId: string): number {
    return (
      this.db.value<number>(
        `SELECT COUNT(*) AS c FROM judge_assignments a
         LEFT JOIN scores s ON s.assignment_id = a.id AND s.state IN ('SUBMITTED','LOCKED')
         WHERE a.event_id = :e AND a.status IN ('ASSIGNED','IN_PROGRESS') AND s.id IS NULL`,
        { e: eventId },
      ) ?? 0
    );
  }

  private freezeSubmissionVersions(eventId: string, at: Instant): void {
    this.db.exec(
      `UPDATE submission_versions SET is_final = 1
       WHERE submission_id IN (SELECT id FROM submissions WHERE event_id = :e)`,
      { e: eventId },
    );
    void at;
  }

  private moveSubmissionsToJudging(eventId: string, at: Instant): void {
    this.db.exec(
      `UPDATE submissions SET state = 'JUDGING', updated_at = :at
       WHERE event_id = :e AND state = 'LOCKED'`,
      { e: eventId, at },
    );
  }

  private requireTimezone(timezone: string): string {
    if (!isValidTimeZone(timezone)) {
      throw errors.validation('Unknown IANA timezone.', [{ field: 'timezone', issue: `"${timezone}" is not a recognised IANA zone` }]);
    }
    return timezone;
  }

  /**
   * Accept either a full UTC instant (`2026-03-01T09:00:00.000Z`) or a naive
   * local wall-clock time interpreted in the event's zone (`2026-03-01T09:00`).
   * Rejecting ambiguous input is better than guessing an offset.
   */
  private toInstantOrNull(value: string | null | undefined, timezone: string): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (isValidInstant(value)) return value;
    try {
      return localWallClockToInstant(value, timezone);
    } catch (error) {
      throw errors.validation(error instanceof Error ? error.message : 'Invalid date', [
        { field: 'date', issue: 'Use an ISO-8601 UTC instant, or a local time such as 2026-03-01T09:00' },
      ]);
    }
  }

  private toUrlOrNull(value: string | null | undefined, field: string): string | null {
    if (value === null || value === undefined || value === '') return null;
    const result = validateHttpUrl(value, { allowPrivateHosts: true });
    if (!result.valid) {
      throw errors.validation('That URL cannot be accepted.', [{ field, issue: result.reason }]);
    }
    return result.url;
  }

  private validateWindowOrder(patch: Record<string, string | number | null>, before: EventRow): void {
    const read = (column: string): string | null => {
      const value = patch[column];
      if (value === undefined) return before[column as keyof EventRow] as string | null;
      return value as string | null;
    };
    const pairs: [string, string, string][] = [
      ['registration_opens_at', 'registration_closes_at', 'registration'],
      ['submission_opens_at', 'submission_closes_at', 'submission'],
      ['judging_opens_at', 'judging_closes_at', 'judging'],
      ['voting_opens_at', 'voting_closes_at', 'voting'],
    ];
    for (const [open, close, label] of pairs) {
      const opens = read(open);
      const closes = read(close);
      if (opens !== null && closes !== null && compare(opens, closes) >= 0) {
        throw errors.validation(`The ${label} window must open before it closes.`, [
          { field: label, issue: `opens ${opens} is not before closes ${closes}` },
        ]);
      }
    }
    if (patch.min_team_size !== undefined && patch.max_team_size !== undefined) {
      if ((patch.min_team_size as number) > (patch.max_team_size as number)) {
        throw errors.validation('The minimum team size cannot exceed the maximum.', [{ field: 'minTeamSize' }]);
      }
    }
  }

  private seedDefaultRegistrationFields(eventId: string, at: Instant): void {
    const defaults: { key: string; label: string; type: string; order: number; help?: string }[] = [
      { key: 'full_name', label: 'Full name', type: 'text', order: 0 },
      { key: 'organization', label: 'College or organization', type: 'text', order: 1 },
      { key: 'skills', label: 'Skills', type: 'text', order: 2, help: 'Comma separated, e.g. "React, Go, computer vision"' },
      { key: 'github', label: 'GitHub profile', type: 'text', order: 3 },
      { key: 'portfolio', label: 'Portfolio or personal site', type: 'text', order: 4 },
      { key: 'experience', label: 'Have you built anything before?', type: 'select', order: 5, help: 'First hackathon or returning builder' },
      { key: 'needs_team', label: 'Looking for a team?', type: 'checkbox', order: 6 },
    ];
    const options = JSON.stringify(['First hackathon', 'A few hackathons', 'Experienced builder']);
    for (const field of defaults) {
      this.db.exec(
        `INSERT INTO registration_fields (id, event_id, field_key, label, help_text, field_type, required, options, display_order, created_at, updated_at)
         VALUES (:id, :event_id, :key, :label, :help, :type, 0, :options, :display_order, :at, :at)`,
        {
          id: newId('registrationField'),
          event_id: eventId,
          key: field.key,
          label: field.label,
          help: field.help ?? '',
          type: field.type,
          options: field.type === 'select' ? options : '[]',
          display_order: field.order,
          at,
        },
      );
    }
  }
}

/* ------------------------------------------------------------- utilities */

export function clampInt(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw errors.validation(`${field} must be a whole number.`, [{ field }]);
  }
  if (value < min || value > max) {
    throw errors.validation(`${field} must be between ${min} and ${max}.`, [{ field, issue: `received ${value}` }]);
  }
  return value;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function normaliseHex(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(trimmed)!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  throw errors.validation('Colour must be a hex value such as #5227FF.', [{ field: 'color' }]);
}

export { addSeconds, toEpochMs, assertTransition };

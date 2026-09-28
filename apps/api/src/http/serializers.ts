/**
 * Response serializers.
 *
 * One function per public shape. Their job is to decide exactly which fields
 * leave the process, so "is judge B's score in this payload?" is a question with
 * a single place to look. A field that is not named here cannot leak by
 * accident.
 */

import type { EventRow } from '../services/event-service.ts';
import type { SubmissionRow } from '../services/submission-service.ts';
import type { PublicUser } from '../lib/auth.ts';
import type { ActorContext } from '../services/context.ts';

export function serializeEvent(row: EventRow, ctx: ActorContext) {
  const manages = ctx.actor !== null && (ctx.actor.roles.includes('ADMIN') || ctx.actor.eventIds.includes(row.id));
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    rules: row.rules,
    state: row.state,
    timezone: row.timezone,
    dates: {
      registration: { opensAt: row.registration_opens_at, closesAt: row.registration_closes_at },
      submission: { opensAt: row.submission_opens_at, closesAt: row.submission_closes_at },
      judging: { opensAt: row.judging_opens_at, closesAt: row.judging_closes_at },
      voting: { opensAt: row.voting_opens_at, closesAt: row.voting_closes_at },
      resultsPublishedAt: row.results_published_at,
    },
    teams: { min: row.min_team_size, max: row.max_team_size, allowIndividual: row.allow_individual === 1 },
    gallery: { visibility: row.gallery_visibility, order: row.gallery_order },
    voting: {
      enabled: row.voting_enabled === 1,
      revealTotals: row.voting_reveal_totals === 1,
      requiresRegistration: row.voting_requires_registration === 1,
    },
    comments: { enabled: row.comments_enabled === 1, requireApproval: row.comments_require_approval === 1 },
    results: {
      visibility: row.results_visibility,
      publishCriterionBreakdown: row.results_publish_criterion_breakdown === 1,
      publishJudgeCount: row.results_publish_judge_count === 1,
    },
    judging: { reviewsPerProject: row.reviews_per_project, minimumJudges: row.minimum_judges },
    bannerUrl: row.banner_url,
    logoUrl: row.logo_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Operational detail is organizer-only; a public reader gets the event,
    // not the machinery.
    ...(manages ? { managing: true, assignmentSeed: row.assignment_seed, createdBy: row.created_by } : {}),
  };
}

export function serializeProject(row: SubmissionRow, extra: Record<string, unknown> = {}) {
  return {
    id: row.id,
    eventId: row.event_id,
    slug: row.slug,
    projectName: row.project_name,
    shortDescription: row.short_description,
    fullDescription: row.full_description,
    problem: row.problem,
    solution: row.solution,
    technologies: safeArray(row.technologies),
    repositoryUrl: row.repository_url,
    demoUrl: row.demo_url,
    videoUrl: row.video_url,
    documentationUrl: row.documentation_url,
    coverImageUrl: row.cover_image_url,
    state: row.state,
    trackId: row.track_id,
    teamId: row.team_id,
    version: Number(row.current_version),
    submittedAt: row.submitted_at,
    lockedAt: row.locked_at,
    finalizedAt: row.finalized_at,
    galleryVisible: row.gallery_visible === 1,
    eligibleForPrizes: row.eligible_for_prizes === 1,
    withdrawn: row.withdrawn === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

export function serializePublicUser(user: PublicUser, eventIds: string[] = []) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    organization: user.organization,
    githubUrl: user.githubUrl,
    portfolioUrl: user.portfolioUrl,
    skills: user.skills,
    avatarColor: user.avatarColor,
    roles: user.roles,
    eventIds,
    createdAt: user.createdAt,
    ...(user.state === 'ACTIVE' ? {} : { state: user.state }),
  };
}

/** The signed-in user's own record, which does include their email. */
export function serializeSelf(user: PublicUser) {
  return {
    ...serializePublicUser(user),
    email: user.email,
    state: user.state,
    lastLoginAt: user.lastLoginAt,
  };
}

/**
 * The administrator's view of a user.
 *
 * `serializePublicUser` deliberately withholds the email address entirely, and
 * omits `state` when the account is active — both correct for a public payload.
 * But the admin console has to *find* someone by address and decide whether to
 * suspend them, so it needs both. Using the public serializer there meant the
 * search box could not match an address, the state column rendered blank, and
 * `stateLabel(undefined)` threw inside the panel — which, with no error boundary
 * at the time, took the whole console down.
 *
 * This shape is reachable only from `/api/users/search`, which requires the
 * `user read` permission, and is therefore organizer-and-above. The email is
 * disclosed there and nowhere else.
 */
export function serializeAdminUser(user: PublicUser, eventIds: string[] = []) {
  return {
    ...serializePublicUser(user, eventIds),
    email: user.email,
    state: user.state,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

export function safeArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

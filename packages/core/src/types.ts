/**
 * Canonical domain vocabulary for Verdict.
 *
 * Every enumerated value in the product is declared here as a frozen object plus
 * a derived union type. We deliberately avoid TypeScript `enum` because the
 * runtime uses native type-stripping (erasable syntax only) and because
 * `as const` objects are JSON-serialisable, tree-shakeable and diff-friendly.
 */

/* ------------------------------------------------------------------ roles */

export const ROLES = ['PARTICIPANT', 'JUDGE', 'ORGANIZER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** A user may hold several roles simultaneously. */
export const ROLE_RANK: Record<Role, number> = {
  PARTICIPANT: 1,
  JUDGE: 2,
  ORGANIZER: 3,
  ADMIN: 4,
};

/* ------------------------------------------------------------------ event */

export const EVENT_STATES = [
  'DRAFT',
  'REGISTRATION',
  'ACTIVE',
  'SUBMISSIONS_LOCKED',
  'JUDGING',
  'RESULTS_PENDING',
  'PUBLISHED',
  'ARCHIVED',
] as const;
export type EventState = (typeof EVENT_STATES)[number];

/* ------------------------------------------------------------ submission */

export const SUBMISSION_STATES = ['DRAFT', 'SUBMITTED', 'LOCKED', 'JUDGING', 'FINALIZED'] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/* ------------------------------------------------------------------ judge */

export const JUDGE_STATES = ['INVITED', 'ACCEPTED', 'ACTIVE', 'COMPLETED'] as const;
export type JudgeState = (typeof JUDGE_STATES)[number];

/* ---------------------------------------------------------- registration */

export const REGISTRATION_STATES = [
  'APPLICATION',
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
  'WITHDRAWN',
] as const;
export type RegistrationState = (typeof REGISTRATION_STATES)[number];

/* -------------------------------------------------------------- conflict */

export const CONFLICT_KINDS = [
  'PARTICIPANT',
  'TEAM',
  'SUBMISSION',
  'ORGANIZATION',
  'MENTOR',
  'EMPLOYER',
  'CUSTOM',
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const CONFLICT_SEVERITIES = ['HARD', 'SOFT'] as const;
export type ConflictSeverity = (typeof CONFLICT_SEVERITIES)[number];

/* ---------------------------------------------------------------- scoring */

export const SCORING_TYPES = ['INTEGER', 'DECIMAL', 'BOOLEAN'] as const;
export type ScoringType = (typeof SCORING_TYPES)[number];

export const SCORE_STATES = ['DRAFT', 'SUBMITTED', 'LOCKED'] as const;
export type ScoreState = (typeof SCORE_STATES)[number];

/* --------------------------------------------------------- normalization */

export const NORMALIZATION_METHODS = ['RAW', 'Z_SCORE', 'MIN_MAX', 'ROBUST_MAD', 'RANK'] as const;
export type NormalizationMethod = (typeof NORMALIZATION_METHODS)[number];

/* ----------------------------------------------------------- aggregation */

export const AGGREGATION_METHODS = ['MEAN', 'TRIMMED_MEAN', 'MEDIAN'] as const;
export type AggregationMethod = (typeof AGGREGATION_METHODS)[number];

/* ------------------------------------------------------------ pairwising */

export const PAIRWISE_OUTCOMES = ['LEFT', 'RIGHT', 'TIE', 'SKIPPED'] as const;
export type PairwiseOutcome = (typeof PAIRWISE_OUTCOMES)[number];

/* -------------------------------------------------------------- anomaly */

export const ANOMALY_TYPES = [
  'HIGH_VARIANCE',
  'LOW_VARIANCE',
  'PANEL_DEVIATION',
  'INCOMPLETE',
  'UNUSUAL_TIMING',
  'IDENTICAL_SCORING',
  'VOTING_VELOCITY',
  'VOTING_CONCENTRATION',
  'SCORE_MANIPULATION',
] as const;
export type AnomalyType = (typeof ANOMALY_TYPES)[number];

export const ANOMALY_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AnomalySeverity = (typeof ANOMALY_SEVERITIES)[number];

export const ANOMALY_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'DISMISSED', 'RESOLVED'] as const;
export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number];

/* --------------------------------------------------------- certification */

export const CERTIFICATE_KINDS = ['PARTICIPANT', 'FINALIST', 'WINNER', 'JUDGE'] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];

/* --------------------------------------------------------------- voting */

export const COMMENT_STATES = ['VISIBLE', 'PENDING', 'HIDDEN', 'DELETED'] as const;
export type CommentState = (typeof COMMENT_STATES)[number];

/* ----------------------------------------------------------------- audit */

/** Canonical audit action vocabulary. Keeps the ledger queryable and stable. */
export const AUDIT_ACTIONS = [
  'auth.register',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_changed',
  'auth.password_reset_requested',
  'auth.password_reset_completed',
  'auth.session_revoked',
  'user.role_changed',
  'user.activated',
  'user.deactivated',
  'event.created',
  'event.updated',
  'event.state_changed',
  'event.deadline_overridden',
  'track.created',
  'track.updated',
  'prize.created',
  'prize.updated',
  'registration.created',
  'registration.state_changed',
  'registration.bulk_action',
  'registration.imported',
  'team.created',
  'team.updated',
  'team.member_added',
  'team.member_removed',
  'team.invitation_created',
  'team.invitation_accepted',
  'team.invitation_rejected',
  'team.member_left',
  'team.override',
  'submission.created',
  'submission.updated',
  'submission.submitted',
  'submission.locked',
  'submission.finalized',
  'submission.override',
  'upload.rejected',
  'judge.invited',
  'judge.accepted',
  'judge.state_changed',
  'judge.deactivated',
  'judge.reactivated',
  'conflict.declared',
  'conflict.removed',
  'conflict.override',
  'assignment.generated',
  'assignment.committed',
  'assignment.reassigned',
  'rubric.created',
  'rubric.version_created',
  'rubric.locked',
  'calibration.session_created',
  'calibration.submitted',
  'score.draft_saved',
  'score.submitted',
  'score.locked',
  'score.overridden',
  'pairwise.compared',
  'normalization.run',
  'diagnostics.computed',
  'anomaly.flagged',
  'anomaly.status_changed',
  'results.finalized',
  'results.published',
  'results.reproduced',
  'result.corrected',
  'certificate.generated',
  'webhook.created',
  'webhook.deleted',
  'webhook.delivery_failed',
  'vote.cast',
  'vote.rejected',
  'comment.created',
  'comment.moderated',
  'export.generated',
  'import.executed',
  'admin.override',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/* ------------------------------------------------------- webhook topics */

/**
 * Every webhook topic, with the wording the organizer console shows.
 *
 * The map is the source of truth and the array is derived from it, so a topic
 * cannot exist without a label and the UI cannot offer a topic the dispatcher
 * does not know. The server filters unrecognised topics out of a subscription
 * silently, so a hard-coded list anywhere would quietly drop events.
 *
 * There is deliberately no `event.created` topic. A webhook belongs to an
 * event, so the event a subscription would name does not exist yet at the
 * moment it is created; the topic could never deliver. It was in the list
 * before, where it read as a working feature and never fired.
 */
export const WEBHOOK_EVENT_META = {
  'registration.accepted': {
    label: 'Registration accepted',
    description: 'An application was accepted, including a bulk decision that accepts it.',
  },
  'team.created': {
    label: 'Team created',
    description: 'A team was created in the event.',
  },
  'submission.created': {
    label: 'Project submitted',
    description: 'A project was submitted into the contest. Fires on the draft-to-submitted change, not when an empty draft is created, so a receiver never counts a project that was never entered.',
  },
  'submission.locked': {
    label: 'Submission locked',
    description: 'A submission was locked, either individually or by the whole event.',
  },
  'judge.assigned': {
    label: 'Assignment plan committed',
    description: 'A judge assignment plan was committed. The payload carries the counts, not the full plan.',
  },
  'score.submitted': {
    label: 'Review submitted',
    description: 'A judge submitted a review. The payload never carries the scores themselves.',
  },
  'judging.completed': {
    label: 'Judging completed',
    description: 'Every review for the event has been submitted. Fires once, on the last one.',
  },
  'results.finalized': {
    label: 'Result finalized',
    description: 'A result run was finalized, with its integrity hash.',
  },
  'results.published': {
    label: 'Results published',
    description: 'A finalized result was published to the public board.',
  },
  'certificate.generated': {
    label: 'Certificate issued',
    description: 'A certificate was issued or revoked.',
  },
} as const satisfies Record<string, { label: string; description: string }>;

export type WebhookEvent = keyof typeof WEBHOOK_EVENT_META;
export const WEBHOOK_EVENTS = Object.keys(WEBHOOK_EVENT_META) as readonly WebhookEvent[];

/* -------------------------------------------------------------- helpers */

export function isOneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** Human-readable labels for UI surfaces; keeps wording consistent everywhere. */
export const STATE_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  REGISTRATION: 'Registration open',
  ACTIVE: 'Event active',
  SUBMISSIONS_LOCKED: 'Submissions locked',
  JUDGING: 'Judging in progress',
  RESULTS_PENDING: 'Results pending',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
  SUBMITTED: 'Submitted',
  LOCKED: 'Locked',
  FINALIZED: 'Finalized',
  INVITED: 'Invited',
  ACCEPTED: 'Accepted',
  COMPLETED: 'Completed',
  APPLICATION: 'Application',
  PENDING: 'Pending review',
  REJECTED: 'Rejected',
  WAITLISTED: 'Waitlisted',
  WITHDRAWN: 'Withdrawn',
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  INVESTIGATING: 'Investigating',
  DISMISSED: 'Dismissed',
  RESOLVED: 'Resolved',
  VISIBLE: 'Visible',
  HIDDEN: 'Hidden',
  PENDING_MODERATION: 'Pending moderation',
  DELETED: 'Deleted',
};

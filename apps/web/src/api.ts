/**
 * API client and response types.
 *
 * The types below are transcribed from what the server actually returns, not
 * from what would be convenient. They were wrong once, in ways 318 HTTP tests
 * could not see:
 *
 *   - The gallery card nests `team: { name, slug }` and `track: { name, color,
 *     slug }`. The client read `project.teamName`, which is `undefined`, so no
 *     team ever appeared and searching by team name silently matched nothing.
 *   - A review's `criteria` holds stored ANSWERS and is empty until something is
 *     scored. The scoring form used to iterate it to decide which questions to
 *     render, producing a form with no inputs on a review nobody had opened.
 *     The questions are in `rubric.criteria`.
 *   - Reviews are addressed by ASSIGNMENT (`/api/assignments/:id/review`), not
 *     by submission. There is no `/api/submissions/:id/reviews/me`.
 *   - Several operational endpoints return rows straight from SQLite, so they
 *     are snake_case; the ones built by the gallery and results services are
 *     camelCase. Both appear here.
 *
 * `apps/api/test/contract.test.ts` asserts the shape of every response used in
 * this file, so a server change fails there first. Run
 * \node apps/api/test/dump-shapes.mts` to re-print the payloads when it does.
 *
 * Naming follows the server exactly. Normalising at the boundary would turn a
 * mismatch into a silently wrong value instead of an `undefined` at the use
 * site, which is how the first round of these bugs stayed invisible.
 */

/* -------------------------------------------------------------- transport */

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: { field: string; issue: string }[];
  };
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details: { field: string; issue: string }[];

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error.code ?? 'UNKNOWN';
    this.requestId = body?.error.requestId ?? '';
    this.details = body?.error.details ?? [];
  }

  /** True when signing in might fix this, so the UI can offer to do that. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  /**
   * True when the server refused because a required field is missing or invalid.
   * Used to attach the message to a specific input instead of showing a banner.
   */
  get fieldErrors(): Map<string, string> {
    const map = new Map<string, string>();
    for (const detail of this.details) map.set(detail.field, detail.issue);
    return map;
  }
}

const CSRF_COOKIE = 'verdict_csrf';

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Skip the CSRF header. Only for sign-in and registration — the requests that
   * establish the token in the first place.
   */
  anonymous?: boolean;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && !options.anonymous) {
    const token = readCookie(CSRF_COOKIE);
    if (token !== null) headers['x-verdict-csrf'] = token;
  }

  const response = await fetch(path, {
    method,
    headers,
    // Same-origin by construction: in production the API serves this bundle, in
    // development Vite proxies /api. There is no CORS configuration to get
    // wrong, and cookies are never sent anywhere else.
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ?? null,
  });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const payload: unknown = isJson ? await response.json().catch(() => null) : await response.text();

  if (!response.ok) {
    throw new ApiError(response.status, isJson ? (payload as ApiErrorBody) : null, response.statusText || 'Request failed');
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> => request<T>(path, signal === undefined ? {} : { signal }),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
  postAnonymous: <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'POST', body, anonymous: true }),
};

/* ------------------------------------------------------------------ types */

export type Role = 'PARTICIPANT' | 'JUDGE' | 'ORGANIZER' | 'ADMIN';

/**
 * A public user profile.
 *
 * mail and state are optional because they are deliberately absent from
 * most payloads: serializePublicUser withholds the address always, and omits
 * the state when the account is active. Only the signed-in user's own record and
 * the administrator's search result carry them, which is why this type must not
 * assume they are present.
 */
export type PublicUser = {
  id: string;
  email?: string;
  username: string;
  displayName: string;
  bio: string;
  organization: string;
  skills: string[];
  avatarColor: string;
  state?: string;
  roles: Role[];
  eventIds: string[];
  createdAt: string;
  lastLoginAt?: string | null;
};

export type SessionInfo = { authenticated: boolean; user: PublicUser | null };

export type Page<T> = {
  data: T[];
  pagination: { page: number; perPage: number; total: number; totalPages: number; hasMore: boolean };
};

/* ------------------------------------------------------------------ event */

export type EventWindows = {
  registration: { opensAt: string; closesAt: string };
  submission: { opensAt: string; closesAt: string };
  judging: { opensAt: string; closesAt: string };
  voting: { opensAt: string; closesAt: string };
  resultsPublishedAt: string | null;
};

export type EventSummary = {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  rules: string;
  state: string;
  timezone: string;
  dates: EventWindows;
  teams: { min: number; max: number; allowIndividual: boolean };
  gallery: { visibility: string; order: string };
  voting: { enabled: boolean; revealTotals: boolean; requiresRegistration: boolean };
  comments: { enabled: boolean; requireApproval: boolean };
  results: { visibility: string; publishCriterionBreakdown: boolean; publishJudgeCount: boolean };
  judging: { reviewsPerProject: number; minimumJudges: number };
  createdAt: string;
  updatedAt: string;
};

/* ---------------------------------------------------------------- gallery */

/**
 * A gallery card. `team` and `track` are nested objects, and either can be
 * absent: an individual entrant has no team, and a submission may have no track.
 */
export type GalleryCard = {
  id: string;
  slug: string;
  projectName: string;
  shortDescription: string;
  technologies: string[];
  repositoryUrl: string | null;
  demoUrl: string | null;
  videoUrl: string | null;
  coverImageUrl: string | null;
  team: { name: string; slug: string } | null;
  track: { name: string; color: string; slug: string } | null;
  submittedAt: string;
};

export type GalleryPage = Page<GalleryCard> & {
  ordering: { mode: string; seed: string | null };
};

/** The full public project page. */
export type GalleryProjectDetail = GalleryCard & {
  fullDescription: string;
  problem: string;
  solution: string;
  documentationUrl: string | null;
  team: (NonNullable<GalleryCard['team']> & { id: string; description: string; organization: string | null }) | null;
  track: (NonNullable<GalleryCard['track']> & { id: string }) | null;
  members: { displayName: string; username: string; role: string }[];
  /**
   * `{ id, url, width, height }` — the upload id IS the key the route uses to
   * build `/api/uploads/{id}`. The previous declaration here said
   * `{ url, caption, order }`, which does not exist on this payload.
   */
  screenshots: { id: string; url: string; width: number | null; height: number | null }[];
  /**
   * Vote state as the *gallery* sees it, which is not the same as the viewer's
   * own vote.
   *
   * When the event reveals totals the server sends `{ count }`. When it does
   * not, it sends `{ hidden: true }` and no count at all — so `count` has to be
   * read through the discriminant rather than assumed. This type used to claim
   * `{ hidden: boolean }`, which is a shape the server never sends.
   *
   * Whether *this account* has voted is a different question, answered by
   * /votes/mine; the gallery deliberately does not answer it.
   */
  votes: { count: number; hidden?: false } | { hidden: true; count?: never };
};

/** Technology facets: `{ data: [{ technology, count }] }`, not `string[]`. */
export type TechnologyCount = { technology: string; count: number };

/* ---------------------------------------------------------------- results */

export type ResultCriterion = {
  criterionId: string;
  name: string;
  normalized: number;
  weight: number;
};

export type ResultEntry = {
  rank: number;
  projectId: string;
  projectName: string;
  slug: string;
  shortDescription: string;
  technologies: string[];
  repositoryUrl: string | null;
  demoUrl: string | null;
  coverImageUrl: string | null;
  track: string | null;
  trackColor: string | null;
  aggregateScore: number | null;
  rawAggregate: number | null;
  rankDelta: number;
  judgeCount: number;
  coverage: number;
  validation: string;
  prizes: string[];
  criteria: ResultCriterion[];
  notes: string[];
};

export type ResultsBoard = {
  published: boolean;
  snapshot: {
    id: string;
    sequence: number;
    publishedAt: string;
    integrityHash: string;
    entryCount: number;
    isCorrection: boolean;
  } | null;
  showJudgeCount: boolean;
  showCriterionBreakdown: boolean;
  entries: ResultEntry[];
};

export type ResultRun = {
  id: string;
  assignmentVersion: number;
  engineVersion: string;
  inputHash: string;
  integrityHash: string;
  notes: string;
  computedAt: string;
  rubricVersion: number;
  normalizationMethod: string;
  aggregationMethod: string;
  publishedSnapshotId: string | null;
};

export type ResultSnapshotRow = {
  id: string;
  event_id: string;
  result_run_id: string;
  sequence: number;
  is_published: number;
  is_correction: number;
  supersedes_id: string | null;
  correction_reason: string;
  integrity_hash: string;
  entry_count: number;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
};

export type ComputeRun = {
  runId: string;
  integrityHash: string;
  inputHash: string;
  assignmentVersion: number;
  rubricVersion: number;
  normalizationMethod: string;
  aggregationMethod: string;
  notes: string[];
  warnings: string[];
  entries: {
    rank: number;
    tieGroup: number;
    projectId: string;
    aggregateScore: number | null;
    rawAggregate: number | null;
    rankDelta: number;
    validation: string;
    prizes: string[];
  }[];
  provenance: Record<string, unknown>;
};

export type Reproduction = { status: string; differences: unknown[] };

/* ---------------------------------------------------------------- judging */

/** One row of the signed-in judge's queue. Nothing here is another judge's data. */
export type QueueItem = {
  assignmentId: string;
  submissionId: string;
  slug: string;
  projectName: string;
  shortDescription: string;
  technologies: string[];
  repositoryUrl: string | null;
  demoUrl: string | null;
  videoUrl: string | null;
  documentationUrl: string | null;
  coverImageUrl: string | null;
  fullDescription: string | null;
  status: string;
  scoreId: string;
  scoreState: string;
  startedAt: string | null;
  submittedAt: string | null;
};

export type JudgeQueue = {
  judgeId: string;
  items: QueueItem[];
  progress: { assigned: number; completed: number; inProgress: number; remaining: number; percent: number };
};

/** A criterion as the rubric defines it: the questions being asked. */
export type RubricCriterion = {
  id: string;
  key: string;
  name: string;
  description: string;
  weight: number;
  min: number;
  max: number;
  required: boolean;
  scoringType: string;
  order: number;
};

/**
 * A rubric version, returned flat (not wrapped in a `version` object).
 *
 * `judgeGuidance` is PRESENT when a judge reads the rubric and ABSENT when an
 * organizer reads a review (`toPublicView(row, false)`), so it is optional and
 * must not be dereferenced unconditionally. It was optional here while the
 * review page called `.trim()` on it, which crashed on exactly the reviews an
 * organizer opened.
 *
 * `status` is `DRAFT` while an organizer may still edit it and `LOCKED` once
 * scores exist against it, which is the point at which changing the questions
 * would invalidate work already done.
 */
export type RubricVersion = {
  id: string;
  version: number;
  status: string;
  rounding: { precision: number; mode?: string };
  judgeGuidance?: string;
  notes?: string;
  weightsMustSumToOne?: boolean;
  tieBreakPriority?: string[];
  criteria: RubricCriterion[];
};

/** The rubric list: a row per rubric, pointing at its active version. */
export type RubricRow = {
  id: string;
  event_id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  version_count: number;
  active_version_id: string | null;
};

/**
 * A criterion answer as stored.
 *
 * camelCase, not snake_case: `criterionScores` aliases the columns on the way
 * out. Reading `criterion_id` here gives `undefined`, which silently empties the
 * form after the first save and leaves "Submit" disabled with no error.
 */
export type CriterionScore = {
  id: string;
  criterionId: string;
  key: string;
  name: string;
  min: number;
  max: number;
  value: number;
  normalized: number;
  points: number;
  comment: string;
  updatedAt: string;
};

/** A score, snake_case, exactly as stored. */
export type ScoreRow = {
  id: string;
  event_id: string;
  assignment_id: string;
  judge_id: string;
  submission_id: string;
  rubric_version_id: string;
  state: string;
  total_score: number | null;
  raw_score: number | null;
  summary: string;
  started_at: string;
  submitted_at: string | null;
  locked_at: string | null;
  duration_ms: number | null;
};

/**
 * A review: your own (`GET /api/assignments/:assignmentId/review`) or an
 * organizer's.
 *
 * `criteria` holds stored ANSWERS, so it is empty until something is scored.
 * Build the form from `rubric.criteria` and join answers on `criterionId`.
 */
export type Review = {
  score: ScoreRow;
  criteria: CriterionScore[];
  rubric: RubricVersion;
};

/** What the server accepts when saving. Values are validated against the scale. */
export type ReviewInput = {
  criteria: { criterionId: string; value: number; comment?: string | null }[];
  summary?: string;
  durationMs?: number;
};

/** The score table: one row per project, organizer only. */
export type ScoreTableRow = {
  submissionId: string;
  projectName: string;
  trackId: string | null;
  assigned: number;
  completed: number;
  meanScore: number | null;
  minScore: number | null;
  maxScore: number | null;
  tracks: string | null;
};

export type CoverageRow = {
  projectId: string;
  projectName: string;
  assigned: number;
  target: number;
  completed: number;
  coverage: number;
};

export type AssignmentRow = {
  id: string;
  event_id: string;
  judge_id: string;
  submission_id: string;
  version: number;
  status: string;
  strategy: string;
  reason: string;
  soft_conflict: number;
  override_by: string | null;
  assigned_at: string;
  completed_at: string | null;
  project_name: string;
  score_state: string | null;
  total_score: number | null;
};

/** `/api/events/:eventId/assignments`: the page plus its coverage summary. */
export type AssignmentView = Page<AssignmentRow> & {
  currentVersion: number;
  coverage: CoverageRow[];
};

/* --------------------------------------------------------------- pairwise */

export type PairwiseSide = {
  id: string;
  projectName: string;
  shortDescription: string;
  /**
   * A comma-separated STRING, not an array. The server reads it straight out of
   * the submissions row, so it must be split before use. Treating it as an
   * array renders `[object Object]` in a comparison card.
   */
  technologies: string;
};

export type PairwiseQueue = {
  judgeId: string;
  total: number;
  pairs: { index: number; left: PairwiseSide; right: PairwiseSide }[];
};

/** The recorded comparison, as POSTed and echoed back. */
export type PairwiseComparison = {
  id: string;
  leftSubmissionId: string;
  rightSubmissionId: string;
  outcome: 'LEFT' | 'RIGHT' | 'TIE' | 'SKIPPED';
  durationMs: number | null;
  createdAt: string;
};

/* ---------------------------------------------------------------- judges */

export type JudgeRow = {
  id: string;
  event_id: string;
  user_id: string;
  state: string;
  title: string;
  organization: string;
  /** A JSON string, not an array. Parse with `parseJsonArray` before use. */
  expertise: string;
  capacity: number;
  bio: string;
  display_name: string;
  email: string;
  username: string;
  assigned: number;
  completed: number;
  notes: string;
};

export type ConflictRow = {
  id: string;
  event_id: string;
  judge_id: string;
  project_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  kind: string;
  severity: string;
  note: string;
  declared_by: string;
  created_at: string;
};

/* ----------------------------------------------------------------- voting */

export type VoteReport = {
  eventId: string;
  totalsVisible: boolean;
  totalVotes: number;
  distinctVoters: number;
  votesPerVoter: number;
  window: { opensAt: string; closesAt: string };
  topAccounts: {
    userId: string;
    displayName: string;
    email: string;
    votes: number;
    share: number;
    firstVoteAt: string;
    lastVoteAt: string;
  }[];
  note: string;
};

export type VoteTally = { submissionId: string; projectName: string; votes: number; share: number; myVote: string | null };

/* ----------------------------------------------------------------- teams */

export type TeamRow = {
  id: string;
  event_id: string;
  slug: string;
  name: string;
  description: string;
  captain_id: string;
  organization: string | null;
  track_id: string | null;
  is_locked: number;
  created_at: string;
  updated_at: string;
  memberCount: number;
};

export type TeamMember = {
  id: string;
  team_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  display_name: string;
  username: string;
  email: string;
  avatar_color: string;
};

export type TeamInvitation = {
  id: string;
  team_id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
};

export type MyTeam = {
  team: TeamRow | null;
  members: TeamMember[];
  invitations: TeamInvitation[];
};

/* ---------------------------------------------------------- registrations */

export type RegistrationField = {
  id: string;
  key: string;
  label: string;
  helpText: string;
  type: string;
  required: boolean;
  options: string[];
  order: number;
};

export type RegistrationForm = { eventId: string; fields: RegistrationField[] };

export type RegistrationRow = {
  id: string;
  event_id: string;
  user_id: string;
  state: string;
  full_name: string;
  organization: string;
  /** JSON string. */
  skills: string;
  github_url: string;
  portfolio_url: string | null;
  bio: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string;
  submitted_at: string;
  display_name: string;
  email: string;
  username: string;
  team_name: string | null;
  responses: Record<string, unknown>;
};

/* ----------------------------------------------------------- submissions */

export type SubmissionRow = {
  id: string;
  eventId: string;
  slug: string;
  projectName: string;
  shortDescription: string;
  fullDescription: string;
  problem: string;
  solution: string;
  technologies: string[];
  repositoryUrl: string | null;
  demoUrl: string | null;
  videoUrl: string | null;
  documentationUrl: string | null;
  coverImageUrl: string | null;
  state: string;
  trackId: string | null;
  teamId: string | null;
  version: number;
  submittedAt: string | null;
  lockedAt: string | null;
  finalizedAt: string | null;
  galleryVisible: boolean;
  eligibleForPrizes: boolean;
  withdrawn: boolean;
  createdAt: string;
  updatedAt: string;
};

/* --------------------------------------------------------------- webhooks */

export type WebhookRow = {
  id: string;
  url: string;
  description: string;
  /** JSON string of event names. */
  subscriptions: string;
  state: string;
  lastStatus: number | null;
  lastDeliveryAt: string | null;
  consecutiveFailures: number;
  createdAt: string;
};

/* ----------------------------------------------------------------- audit */

/** One entry of the audit ledger's action vocabulary, with how often it occurs. */
export type AuditAction = { action: string; count: number };

export type AuditRow = {
  id: string;
  at: string;
  actorId: string | null;
  actorRoles: string[];
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  previousState: string | null;
  newState: string | null;
  outcome: string;
  requestId: string;
  ipAddress: string;
  metadata: Record<string, unknown>;
};

/* ------------------------------------------------------------ diagnostics */

/**
 * `GET /api/events/{eventId}/diagnostics`.
 *
 * Note that this is a GET that persists: computing diagnostics also records the
 * signals it finds as review flags, so a signal cannot be lost between being
 * computed and being looked at. The route is organizer-only and the service
 * re-checks the same thing, so a GET that writes is not a way around the guard.
 *
 * The field names below are the engine's, not invented ones. An earlier version
 * of this file declared `meanDeviationZ`, `lowVariance`/`highVariance`,
 * `suspicious`, `suspiciousTiming` and a `warnings` array. The server sends
 * `panelDeviationZ`, `judgeDisagreement` and `thresholds`, and sends **no**
 * `warnings` at all — so the panel read `undefined.length` and crashed.
 */

/**
 * `GET /api/events/{eventId}/diagnostics`.
 *
 * Note that this is a GET that persists: computing diagnostics also records the
 * signals it finds as review flags, so a signal cannot be lost between being
 * computed and being looked at. The route is organizer-only and the service
 * re-checks the same thing, so a GET that writes is not a way around the guard.
 *
 * The field names below are the engine's, not invented ones. An earlier version
 * of this file declared `meanDeviationZ`, `lowVariance`/`highVariance`,
 * `suspicious`, `suspiciousTiming`, a `warnings` array, and typed `signals` as
 * `string[]`. The server sends `panelDeviationZ`, `judgeDisagreement`,
 * `thresholds`, **no** `warnings`, and `signals` as full objects. Reading those
 * wrong fields crashed the panel twice: once on `undefined.length`, once on
 * `stateLabel` calling `.toLowerCase()` on an object.
 */
export type DiagnosticSignal = {
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  subjectId: string;
  subjectKind: string;
  metric: number | null;
  threshold: number | null;
  sampleSize: number;
  evidence: string;
  recommendedAction: string;
};

export type JudgeDiagnostic = {
  judgeId: string;
  sampleSize: number;
  mean: number | null;
  median: number | null;
  stddev: number | null;
  min: number | null;
  max: number | null;
  range: number | null;
  coefficientOfVariation: number | null;
  /** How far this judge's mean sits from the panel, in panel standard deviations. */
  panelDeviationZ: number | null;
  panelMeanAbsoluteDeviation: number | null;
  assigned: number;
  completed: number;
  completionRate: number;
  draftReviews: number;
  /** Fraction of distinct scores. A judge giving every project the same number
   *  scores 0 here, which is a review signal, not an accusation. */
  distinctScoreRatio: number | null;
  /** Objects, not strings — see the note above. */
  signals: DiagnosticSignal[];
};

export type ProjectDiagnostic = {
  projectId: string;
  assignedJudges: number;
  submittedReviews: number;
  coverage: number;
  mean: number | null;
  median: number | null;
  stddev: number | null;
  range: number | null;
  fieldDeviationZ: number | null;
  judgeDisagreement: number | null;
  criterionSpread: { key: string; stddev: number; judgeCount: number }[] | null;
  signals: DiagnosticSignal[];
};

export type EventDiagnostics = {
  engineVersion: string;
  eventId: string;
  rubricVersionId: string;
  assignmentVersion: number;
  computedAt: string;
  panel: { judges: number; reviews: number; mean: number | null; stddev: number | null } | null;
  judges: JudgeDiagnostic[];
  projects: ProjectDiagnostic[];
  voting: { totalVotes: number; distinctVoters: number; concentration: number; signals: string[] } | null;
  signals: DiagnosticSignal[];
  /** The thresholds the run applied, published so a signal can be argued with. */
  thresholds: Record<string, number>;
};

/** A persisted review flag. Raw columns, as stored. */
export type AnomalyRow = {
  id: string;
  event_id: string;
  anomaly_type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  subject_kind: string;
  subject_id: string;
  metric: number | null;
  threshold: number | null;
  sample_size: number;
  evidence: string;
  recommended_action: string;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'DISMISSED' | 'RESOLVED';
  resolution: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The normalization proof: the same stored reviews run through RAW and one
 * alternative method, side by side.
 *
 * `rawRank` and \normalizedRank` are both present precisely so a rank change is
 * measurable rather than asserted. `movedProjects` is the count that changed.
 */
export type NormalizationComparison = {
  method: string;
  rows: {
    projectId: string;
    rawScore: number | null;
    normalizedScore: number | null;
    rawRank: number | null;
    normalizedRank: number | null;
    rankDelta: number | null;
    judges: number;
  }[];
  movedProjects: number;
  warnings: string[];
  judgeStats: {
    judgeId: string;
    displayName?: string;
    count: number;
    mean: number | null;
    stddev: number | null;
    median: number | null;
    generosity: number | null;
  }[];
  explanation: string;
};

export type NormalizationRunRow = {
  id: string;
  method: string;
  config: string;
  configHash: string;
  engineVersion: string;
  scope: string;
  inputHash: string;
  warnings: string;
  computedAt: string;
  scoreCount: number;
};

/* --------------------------------------------------------------- pairwise */

export type ComparisonRow = {
  id: string;
  judgeId: string;
  leftProjectId: string;
  rightProjectId: string;
  leftProjectName: string;
  rightProjectName: string;
  outcome: 'LEFT' | 'RIGHT' | 'TIE' | 'SKIPPED';
  decidedAt: string;
};

/* ------------------------------------------------------------ certificates */

export type CertificateRow = {
  id: string;
  kind: string;
  reference: string;
  title: string;
  issuedAt: string;
  revokedAt: string | null;
  recipientName: string;
  username: string;
  projectName: string | null;
  url: string;
};

export type ParticipationRecord = {
  id: string;
  judgeId: string;
  judgeName: string;
  judgeEmail: string;
  assignmentVersion: number;
  reference: string;
  judgingOpensAt: string;
  judgingClosesAt: string;
  assignedCount: number;
  completedCount: number;
  completionStatus: 'COMPLETE' | 'PARTIAL' | 'NOT_STARTED' | 'NO_ASSIGNMENTS';
  integrityHash: string;
  issuedAt: string;
  detail: { assignedProjects?: { projectId: string; projectName: string; status: string; score: number | null; submittedAt: string | null }[] } | null;
};

/* ------------------------------------------------------------- assignment */

/**
 * The dry-run result from the assignment engine. Nothing is written until the
 * `inputHash` is presented back to commit, so a plan is bound to the data it
 * was generated from.
 */
export type AssignmentPreview = {
  version: number;
  inputHash: string;
  strategy: string;
  seed: string;
  pairs: { judgeId: string; submissionId: string; projectName?: string; cost?: number; softConflict?: boolean; reason?: string }[];
  judgeLoad: {
    judgeId: string;
    displayName: string;
    existing: number;
    assigned: number;
    total: number;
    capacity: number;
    utilisation: number;
  }[];
  projectCoverage: { projectId: string; assigned: number; needed: number; coverage: number }[];
  unassignedProjects: { projectId: string; assigned: number; needed: number; reason: string }[];
  idleJudges: { judgeId: string; load: number; capacity: number; reason: string }[];
  excludedJudges: { judgeId: string; displayName: string; reason: string }[];
  acceptedSoftConflicts: { judgeId: string; projectId: string; kind: string }[];
  enforcedHardConflicts: { judgeId: string; projectId: string; kind: string }[];
  summary: {
    totalPairs: number;
    projectsFullyCovered: number;
    projectsPartiallyCovered: number;
    projectsUncovered: number;
    judgesUsed: number;
    loadSpread: { min: number; max: number; mean: number; standardDeviation: number };
    coverageRatio: number;
    warnings: string[];
  };
  note: string;
};

/* --------------------------------------------------------------- comments */

export type CommentRow = {
  id: string;
  body: string;
  state: string;
  parentId: string | null;
  createdAt: string;
  editedAt: string | null;
  reportCount: number;
  authorId: string;
  authorName: string;
  username: string;
  avatarColor: string;
};

/* -------------------------------------------------------------- admin ops */

export type AdminOverview = {
  users: { total: number; active: number; suspended: number };
  events: number;
  publishedResults: number;
  openAnomalies: number;
  webhookFailures: number;
  tables: Record<string, number>;
  authorizationMatrix: { role: string; grants: { resource: string; action: string; scope: string | null }[] }[];
  database: { ok: boolean; detail?: string };
};

export type ExportManifest = {
  event: { id: string; slug: string; name: string };
  generatedAt: string;
  generatedBy: string;
  schemaVersion: number;
  entities: Record<string, { count: number; columns: string[] }>;
  note: string;
};

/* ------------------------------------------------------------ capabilities */

export type Capabilities = {
  version: string;
  judging: Record<string, unknown>;
  uploads: Record<string, unknown>;
  registrationFieldTypes: string[];
  limits: Record<string, unknown>;
  time?: Record<string, unknown>;
};

/**
 * Parses a JSON-column string into a string array, tolerating junk.
 *
 * Used for `expertise`, `skills` and webhook `subscriptions`, which the server
 * stores as JSON text and returns as a string. Returning `[]` for unparseable
 * input is deliberate: a corrupt expertise tag should hide a chip, not blank the
 * page.
 */
export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Splits the pairwise endpoint's comma-separated technology list. */
export function splitTechnologies(value: string): string[] {
  return value
    .split(',')
    .map((tech) => tech.trim())
    .filter((tech) => tech !== '');
}

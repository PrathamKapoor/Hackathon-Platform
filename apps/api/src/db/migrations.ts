/**
 * Schema migrations.
 *
 * Migrations are numbered, immutable and applied inside a transaction each. The
 * applied set is recorded in `schema_migrations` together with a checksum, so an
 * edited migration is detected rather than silently diverging between
 * environments.
 *
 * Conventions used throughout:
 *  - `id` is a prefixed opaque text primary key (see @verdict/core ids.ts).
 *    Text keys keep ids self-describing in logs and make cross-table paste
 *    errors fail loudly instead of matching the wrong row.
 *  - `created_at` / `updated_at` are canonical UTC ISO-8601 strings with `Z`.
 *    A companion `*_ms` integer column exists only where a range query or sort
 *    is hot, because string comparison of ISO-8601 is correct but index-heavy
 *    work is clearer in integers.
 *  - Lifecycle columns carry a CHECK constraint against the legal enum values.
 *    The application already validates these through the state machines; the
 *    CHECK is a second, independent barrier so a bug or a direct SQL session
 *    cannot write a state the code has no transition out of.
 *  - Foreign keys are declared and enforced. Cascades are used only where the
 *    child is meaningless without the parent (team members, criterion scores).
 */

import type { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '@verdict/core/integrity';

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL
) STRICT;
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'identity',
    sql: `
-- ---------------------------------------------------------------- identity

CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL,
  email_normalized   TEXT NOT NULL UNIQUE,
  username           TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  display_name       TEXT NOT NULL,
  password_hash      TEXT NOT NULL,
  bio                TEXT NOT NULL DEFAULT '',
  organization       TEXT NOT NULL DEFAULT '',
  github_url         TEXT,
  portfolio_url      TEXT,
  skills             TEXT NOT NULL DEFAULT '[]',
  avatar_color       TEXT NOT NULL DEFAULT '#5227FF',
  state              TEXT NOT NULL DEFAULT 'ACTIVE'
                       CHECK (state IN ('ACTIVE','SUSPENDED','DEACTIVATED')),
  email_verified     INTEGER NOT NULL DEFAULT 0,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until       TEXT,
  last_login_at      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) STRICT;
CREATE INDEX idx_users_email ON users (email_normalized);
CREATE INDEX idx_users_state ON users (state);

-- Roles are a join table, not a column: a person can be a participant in one
-- event, a judge in another and an admin everywhere.
CREATE TABLE user_roles (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('PARTICIPANT','JUDGE','ORGANIZER','ADMIN')),
  event_id    TEXT,             -- NULL = global role (ADMIN, or platform-wide)
  granted_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at  TEXT NOT NULL,
  revoked_at  TEXT,
  PRIMARY KEY (user_id, role, event_id, granted_at)
) STRICT;
CREATE INDEX idx_user_roles_user ON user_roles (user_id);
CREATE INDEX idx_user_roles_event ON user_roles (event_id);

-- Sessions store only a SHA-256 digest of the cookie value. A database leak
-- therefore does not hand an attacker live session cookies.
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  csrf_token     TEXT NOT NULL,
  ip_address     TEXT NOT NULL DEFAULT '',
  user_agent     TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  last_seen_ms   INTEGER NOT NULL,
  expires_at     TEXT NOT NULL,
  expires_ms     INTEGER NOT NULL,
  revoked_at     TEXT,
  revoked_reason TEXT
) STRICT;
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_ms);

CREATE TABLE password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  expires_ms  INTEGER NOT NULL,
  used_at     TEXT,
  request_ip  TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX idx_password_resets_user ON password_resets (user_id);
`,
  },

  {
    version: 2,
    name: 'events',
    sql: `
-- ------------------------------------------------------------------ events

CREATE TABLE events (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  tagline             TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  rules               TEXT NOT NULL DEFAULT '',
  state               TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (state IN ('DRAFT','REGISTRATION','ACTIVE','SUBMISSIONS_LOCKED',
                                         'JUDGING','RESULTS_PENDING','PUBLISHED','ARCHIVED')),
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  registration_opens_at  TEXT,
  registration_closes_at TEXT,
  submission_opens_at    TEXT,
  submission_closes_at   TEXT,
  judging_opens_at       TEXT,
  judging_closes_at      TEXT,
  voting_opens_at        TEXT,
  voting_closes_at       TEXT,
  results_published_at   TEXT,
  max_team_size       INTEGER NOT NULL DEFAULT 5 CHECK (max_team_size BETWEEN 1 AND 100),
  min_team_size       INTEGER NOT NULL DEFAULT 1 CHECK (min_team_size BETWEEN 1 AND 100),
  allow_individual    INTEGER NOT NULL DEFAULT 0,
  gallery_visibility  TEXT NOT NULL DEFAULT 'PUBLIC'
                        CHECK (gallery_visibility IN ('PUBLIC','UNLISTED','PRIVATE')),
  gallery_order       TEXT NOT NULL DEFAULT 'RANDOMIZED'
                        CHECK (gallery_order IN ('RANDOMIZED','ALPHABETICAL','SUBMISSION','VOTES')),
  voting_enabled      INTEGER NOT NULL DEFAULT 0,
  voting_reveal_totals INTEGER NOT NULL DEFAULT 1,
  voting_requires_registration INTEGER NOT NULL DEFAULT 1,
  comments_enabled    INTEGER NOT NULL DEFAULT 1,
  comments_require_approval INTEGER NOT NULL DEFAULT 0,
  results_visibility  TEXT NOT NULL DEFAULT 'PUBLIC'
                        CHECK (results_visibility IN ('PUBLIC','UNLISTED','PRIVATE')),
  results_publish_criterion_breakdown INTEGER NOT NULL DEFAULT 1,
  results_publish_judge_count INTEGER NOT NULL DEFAULT 1,
  reviews_per_project INTEGER NOT NULL DEFAULT 3 CHECK (reviews_per_project BETWEEN 1 AND 20),
  minimum_judges      INTEGER NOT NULL DEFAULT 3 CHECK (minimum_judges BETWEEN 1 AND 20),
  normalize_by_votes  INTEGER NOT NULL DEFAULT 0,
  assignment_seed     TEXT NOT NULL DEFAULT '',
  banner_url          TEXT,
  logo_url            TEXT,
  created_by          TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;
CREATE INDEX idx_events_state ON events (state);
CREATE INDEX idx_events_created ON events (created_at);

CREATE TABLE event_tracks (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#5227FF',
  max_projects INTEGER,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (event_id, slug)
) STRICT;
CREATE INDEX idx_tracks_event ON event_tracks (event_id);

CREATE TABLE prizes (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  quantity           INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 1000),
  eligible_ranks     TEXT NOT NULL DEFAULT '[]',
  eligible_track_id  TEXT REFERENCES event_tracks(id) ON DELETE SET NULL,
  priority           INTEGER NOT NULL DEFAULT 100,
  display_order      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) STRICT;
CREATE INDEX idx_prizes_event ON prizes (event_id, priority);
`,
  },

  {
    version: 3,
    name: 'registration',
    sql: `
-- ------------------------------------------------------------ registration

-- The form is data, not code: organizers add fields without a deploy.
CREATE TABLE registration_fields (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  field_key     TEXT NOT NULL,
  label         TEXT NOT NULL,
  help_text     TEXT NOT NULL DEFAULT '',
  field_type    TEXT NOT NULL CHECK (field_type IN ('text','number','select','multi_select','checkbox')),
  required      INTEGER NOT NULL DEFAULT 1,
  options       TEXT NOT NULL DEFAULT '[]',
  placeholder   TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (event_id, field_key)
) STRICT;
CREATE INDEX idx_reg_fields_event ON registration_fields (event_id, display_order);

CREATE TABLE registrations (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state          TEXT NOT NULL DEFAULT 'APPLICATION'
                   CHECK (state IN ('APPLICATION','PENDING','ACCEPTED','REJECTED','WAITLISTED','WITHDRAWN')),
  full_name      TEXT NOT NULL DEFAULT '',
  organization   TEXT NOT NULL DEFAULT '',
  skills         TEXT NOT NULL DEFAULT '[]',
  github_url     TEXT,
  portfolio_url  TEXT,
  bio            TEXT NOT NULL DEFAULT '',
  decided_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at     TEXT,
  decision_note  TEXT NOT NULL DEFAULT '',
  submitted_at   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (event_id, user_id)
) STRICT;
CREATE INDEX idx_registrations_state ON registrations (event_id, state);
CREATE INDEX idx_registrations_user ON registrations (user_id);

CREATE TABLE registration_responses (
  id              TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  field_id        TEXT NOT NULL REFERENCES registration_fields(id) ON DELETE CASCADE,
  value_text      TEXT NOT NULL DEFAULT '',
  value_number    REAL,
  value_boolean   INTEGER,
  value_json      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (registration_id, field_id)
) STRICT;
`,
  },

  {
    version: 4,
    name: 'teams',
    sql: `
-- ------------------------------------------------------------------- teams

CREATE TABLE teams (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  captain_id     TEXT NOT NULL REFERENCES users(id),
  organization   TEXT NOT NULL DEFAULT '',
  track_id       TEXT REFERENCES event_tracks(id) ON DELETE SET NULL,
  is_locked      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (event_id, slug)
) STRICT;
CREATE INDEX idx_teams_event ON teams (event_id);
CREATE INDEX idx_teams_captain ON teams (captain_id);

CREATE TABLE team_members (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('CAPTAIN','MEMBER')),
  joined_at  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_id, user_id)
) STRICT;
CREATE INDEX idx_team_members_user ON team_members (user_id);

CREATE TABLE team_invitations (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('CAPTAIN','MEMBER')),
  invited_by  TEXT NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','ACCEPTED','REJECTED','REVOKED','EXPIRED')),
  expires_at  TEXT NOT NULL,
  expires_ms  INTEGER NOT NULL,
  accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  responded_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX idx_team_invites_team ON team_invitations (team_id, status);
CREATE INDEX idx_team_invites_email ON team_invitations (email);
`,
  },

  {
    version: 5,
    name: 'submissions',
    sql: `
-- ------------------------------------------------------------- submissions

CREATE TABLE submissions (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id            TEXT REFERENCES teams(id) ON DELETE SET NULL,
  track_id           TEXT REFERENCES event_tracks(id) ON DELETE SET NULL,
  created_by         TEXT NOT NULL REFERENCES users(id),
  slug               TEXT NOT NULL,
  project_name       TEXT NOT NULL,
  short_description  TEXT NOT NULL DEFAULT '',
  full_description   TEXT NOT NULL DEFAULT '',
  problem            TEXT NOT NULL DEFAULT '',
  solution           TEXT NOT NULL DEFAULT '',
  technologies       TEXT NOT NULL DEFAULT '[]',
  repository_url     TEXT,
  demo_url           TEXT,
  video_url          TEXT,
  documentation_url  TEXT,
  cover_image_url    TEXT,
  state              TEXT NOT NULL DEFAULT 'DRAFT'
                       CHECK (state IN ('DRAFT','SUBMITTED','LOCKED','JUDGING','FINALIZED')),
  current_version    INTEGER NOT NULL DEFAULT 0,
  submitted_at       TEXT,
  locked_at          TEXT,
  finalized_at       TEXT,
  gallery_visible    INTEGER NOT NULL DEFAULT 1,
  eligible_for_prizes INTEGER NOT NULL DEFAULT 1,
  withdrawn          INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (event_id, slug)
) STRICT;
CREATE INDEX idx_submissions_event ON submissions (event_id, state);
CREATE INDEX idx_submissions_team ON submissions (team_id);
CREATE INDEX idx_submissions_gallery ON submissions (event_id, gallery_visible, submitted_at);

-- Every meaningful edit appends a version. The deadline is enforced by making
-- the latest version immutable once the event leaves ACTIVE, not by trusting
-- the client.
CREATE TABLE submission_versions (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  author_id     TEXT NOT NULL REFERENCES users(id),
  state         TEXT NOT NULL,
  changed_fields TEXT NOT NULL DEFAULT '[]',
  snapshot      TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  is_final      INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  UNIQUE (submission_id, version)
) STRICT;
CREATE INDEX idx_versions_submission ON submission_versions (submission_id, version);

CREATE TABLE uploads (
  id            TEXT PRIMARY KEY,
  event_id      TEXT REFERENCES events(id) ON DELETE CASCADE,
  submission_id TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('SCREENSHOT','ATTACHMENT','LOGO','BANNER','DOCUMENT')),
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  checksum      TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  created_at    TEXT NOT NULL,
  UNIQUE (event_id, stored_name)
) STRICT;
CREATE INDEX idx_uploads_submission ON uploads (submission_id);
`,
  },

  {
    version: 6,
    name: 'judging',
    sql: `
-- ---------------------------------------------------------------- judging

CREATE TABLE judges (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'INVITED'
                  CHECK (state IN ('INVITED','ACCEPTED','ACTIVE','COMPLETED')),
  title         TEXT NOT NULL DEFAULT '',
  organization  TEXT NOT NULL DEFAULT '',
  expertise     TEXT NOT NULL DEFAULT '[]',
  capacity      INTEGER NOT NULL DEFAULT 10 CHECK (capacity BETWEEN 0 AND 500),
  bio           TEXT NOT NULL DEFAULT '',
  invited_by    TEXT NOT NULL REFERENCES users(id),
  invited_at    TEXT NOT NULL,
  responded_at  TEXT,
  activated_at  TEXT,
  completed_at  TEXT,
  deactivated_at TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (event_id, user_id)
) STRICT;
CREATE INDEX idx_judges_event_state ON judges (event_id, state);

-- A conflict can be raised against a specific project, or against a subject
-- (team / participant / organization) that expands to many projects at
-- assignment time.
CREATE TABLE judge_conflicts (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  judge_id    TEXT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  project_id  TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  subject_kind TEXT CHECK (subject_kind IS NULL OR
                subject_kind IN ('PARTICIPANT','TEAM','SUBMISSION','ORGANIZATION','MENTOR','EMPLOYER','CUSTOM')),
  subject_id  TEXT,
  kind        TEXT NOT NULL
                CHECK (kind IN ('PARTICIPANT','TEAM','SUBMISSION','ORGANIZATION','MENTOR','EMPLOYER','CUSTOM')),
  severity    TEXT NOT NULL DEFAULT 'HARD' CHECK (severity IN ('HARD','SOFT')),
  note        TEXT NOT NULL DEFAULT '',
  declared_by TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (project_id IS NOT NULL OR subject_id IS NOT NULL)
) STRICT;
CREATE INDEX idx_conflicts_judge ON judge_conflicts (judge_id);
CREATE INDEX idx_conflicts_project ON judge_conflicts (project_id);
CREATE INDEX idx_conflicts_subject ON judge_conflicts (event_id, subject_kind, subject_id);

CREATE TABLE judge_assignments (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  judge_id       TEXT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'ASSIGNED'
                   CHECK (status IN ('ASSIGNED','IN_PROGRESS','SUBMITTED','SKIPPED','REASSIGNED')),
  strategy       TEXT NOT NULL DEFAULT 'MANUAL',
  reason         TEXT NOT NULL DEFAULT '',
  soft_conflict  INTEGER NOT NULL DEFAULT 0,
  override_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at    TEXT NOT NULL,
  completed_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (judge_id, submission_id)
) STRICT;
CREATE INDEX idx_assignments_event_version ON judge_assignments (event_id, version);
CREATE INDEX idx_assignments_judge ON judge_assignments (judge_id, status);
CREATE INDEX idx_assignments_submission ON judge_assignments (submission_id);

CREATE TABLE rubrics (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (event_id, name)
) STRICT;

CREATE TABLE rubric_versions (
  id                  TEXT PRIMARY KEY,
  rubric_id           TEXT NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
  event_id            TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','ACTIVE','LOCKED','RETIRED')),
  weights_must_sum_to_one INTEGER NOT NULL DEFAULT 1,
  rounding_precision  INTEGER NOT NULL DEFAULT 4,
  rounding_mode       TEXT NOT NULL DEFAULT 'HALF_UP' CHECK (rounding_mode = 'HALF_UP'),
  tie_break_priority  TEXT NOT NULL DEFAULT '[]',
  judge_guidance      TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  activated_at        TEXT,
  locked_at           TEXT,
  created_by          TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (rubric_id, version)
) STRICT;
CREATE INDEX idx_rubric_versions_event ON rubric_versions (event_id, status);

CREATE TABLE rubric_criteria (
  id                 TEXT PRIMARY KEY,
  rubric_version_id  TEXT NOT NULL REFERENCES rubric_versions(id) ON DELETE CASCADE,
  field_key          TEXT NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  weight             REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
  min_value          REAL NOT NULL,
  max_value          REAL NOT NULL,
  required           INTEGER NOT NULL DEFAULT 1,
  scoring_type       TEXT NOT NULL DEFAULT 'DECIMAL'
                       CHECK (scoring_type IN ('INTEGER','DECIMAL','BOOLEAN')),
  display_order      INTEGER NOT NULL DEFAULT 0,
  publish_breakdown  INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (max_value > min_value),
  UNIQUE (rubric_version_id, field_key)
) STRICT;
CREATE INDEX idx_criteria_version ON rubric_criteria (rubric_version_id, display_order);

CREATE TABLE scores (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  assignment_id   TEXT NOT NULL REFERENCES judge_assignments(id) ON DELETE CASCADE,
  judge_id        TEXT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  submission_id   TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  state           TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (state IN ('DRAFT','SUBMITTED','LOCKED')),
  total_score     REAL,
  raw_score       REAL,
  summary         TEXT NOT NULL DEFAULT '',
  started_at      TEXT NOT NULL,
  submitted_at    TEXT,
  locked_at       TEXT,
  duration_ms     INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (judge_id, submission_id)
) STRICT;
CREATE INDEX idx_scores_event_state ON scores (event_id, state);
CREATE INDEX idx_scores_submission ON scores (submission_id, state);
CREATE INDEX idx_scores_judge ON scores (judge_id, state);

CREATE TABLE criterion_scores (
  id            TEXT PRIMARY KEY,
  score_id      TEXT NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
  criterion_id  TEXT NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id) ON DELETE CASCADE,
  value         REAL NOT NULL,
  normalized    REAL NOT NULL,
  points        REAL NOT NULL,
  comment       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (score_id, criterion_id)
) STRICT;
CREATE INDEX idx_criterion_scores_criterion ON criterion_scores (criterion_id);
`,
  },

  {
    version: 7,
    name: 'calibration-and-pairwise',
    sql: `
-- ------------------------------------------------- calibration / pairwise

CREATE TABLE calibration_sessions (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  reference_submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  state        TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','CLOSED')),
  opens_at     TEXT NOT NULL,
  closes_at    TEXT,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX idx_calibration_event ON calibration_sessions (event_id, state);

CREATE TABLE calibration_scores (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  judge_id        TEXT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  submission_id   TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id) ON DELETE CASCADE,
  total_score     REAL NOT NULL,
  detail          TEXT NOT NULL DEFAULT '{}',
  submitted_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (session_id, judge_id, submission_id)
) STRICT;

CREATE TABLE pairwise_comparisons (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  judge_id          TEXT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  assignment_id     TEXT REFERENCES judge_assignments(id) ON DELETE SET NULL,
  session           INTEGER NOT NULL DEFAULT 1,
  left_submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  right_submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  outcome           TEXT NOT NULL CHECK (outcome IN ('LEFT','RIGHT','TIE','SKIPPED')),
  duration_ms       INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (left_submission_id <> right_submission_id)
) STRICT;
CREATE INDEX idx_pairwise_judge ON pairwise_comparisons (judge_id);
CREATE INDEX idx_pairwise_event ON pairwise_comparisons (event_id);
CREATE UNIQUE INDEX idx_pairwise_unique ON pairwise_comparisons (judge_id, session, left_submission_id, right_submission_id);
`,
  },

  {
    version: 8,
    name: 'results',
    sql: `
-- ---------------------------------------------------------------- results

CREATE TABLE normalization_runs (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rubric_version_id  TEXT NOT NULL REFERENCES rubric_versions(id) ON DELETE CASCADE,
  assignment_version INTEGER NOT NULL,
  method             TEXT NOT NULL
                       CHECK (method IN ('RAW','Z_SCORE','MIN_MAX','ROBUST_MAD','RANK')),
  config             TEXT NOT NULL,
  config_hash        TEXT NOT NULL,
  engine_version     TEXT NOT NULL,
  scope              TEXT NOT NULL DEFAULT 'EVENT' CHECK (scope IN ('EVENT','CRITERION','JUDGE')),
  input_hash         TEXT NOT NULL,
  result             TEXT NOT NULL,
  warnings           TEXT NOT NULL DEFAULT '[]',
  computed_by        TEXT NOT NULL REFERENCES users(id),
  computed_at        TEXT NOT NULL
) STRICT;
CREATE INDEX idx_normalization_event ON normalization_runs (event_id, computed_at);

CREATE TABLE judge_diagnostics (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rubric_version_id  TEXT NOT NULL REFERENCES rubric_versions(id) ON DELETE CASCADE,
  assignment_version INTEGER NOT NULL,
  engine_version     TEXT NOT NULL,
  payload            TEXT NOT NULL,
  computed_by        TEXT NOT NULL REFERENCES users(id),
  computed_at        TEXT NOT NULL
) STRICT;
CREATE INDEX idx_diagnostics_event ON judge_diagnostics (event_id, computed_at);

CREATE TABLE anomaly_flags (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  anomaly_type  TEXT NOT NULL
                  CHECK (anomaly_type IN ('HIGH_VARIANCE','LOW_VARIANCE','PANEL_DEVIATION','INCOMPLETE',
                                          'UNUSUAL_TIMING','IDENTICAL_SCORING','VOTING_VELOCITY',
                                          'VOTING_CONCENTRATION','SCORE_MANIPULATION')),
  severity      TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('JUDGE','PROJECT','ACCOUNT','EVENT')),
  subject_id    TEXT NOT NULL,
  metric        REAL,
  threshold     REAL,
  sample_size   INTEGER NOT NULL DEFAULT 0,
  evidence      TEXT NOT NULL DEFAULT '',
  recommended_action TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','ACKNOWLEDGED','INVESTIGATING','DISMISSED','RESOLVED')),
  resolution    TEXT NOT NULL DEFAULT '',
  dedupe_key    TEXT NOT NULL,
  reviewed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (event_id, dedupe_key)
) STRICT;
CREATE INDEX idx_anomaly_event_status ON anomaly_flags (event_id, status, severity);
CREATE INDEX idx_anomaly_subject ON anomaly_flags (event_id, subject_kind, subject_id);

-- A result run is a computation; a snapshot is a frozen, publishable artefact.
CREATE TABLE result_runs (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rubric_version_id  TEXT NOT NULL REFERENCES rubric_versions(id) ON DELETE CASCADE,
  assignment_version INTEGER NOT NULL,
  normalization_run_id TEXT REFERENCES normalization_runs(id) ON DELETE SET NULL,
  engine_version     TEXT NOT NULL,
  config             TEXT NOT NULL,
  input_hash         TEXT NOT NULL,
  integrity_hash     TEXT NOT NULL,
  provenance         TEXT NOT NULL,
  pairwise           TEXT,
  warnings           TEXT NOT NULL DEFAULT '[]',
  notes              TEXT NOT NULL DEFAULT '',
  computed_by        TEXT NOT NULL REFERENCES users(id),
  computed_at        TEXT NOT NULL
) STRICT;
CREATE INDEX idx_result_runs_event ON result_runs (event_id, computed_at);

CREATE TABLE result_snapshots (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  result_run_id      TEXT NOT NULL REFERENCES result_runs(id) ON DELETE CASCADE,
  sequence           INTEGER NOT NULL,
  is_published       INTEGER NOT NULL DEFAULT 0,
  is_correction      INTEGER NOT NULL DEFAULT 0,
  supersedes_id      TEXT REFERENCES result_snapshots(id) ON DELETE SET NULL,
  correction_reason  TEXT NOT NULL DEFAULT '',
  integrity_hash     TEXT NOT NULL,
  entry_count        INTEGER NOT NULL DEFAULT 0,
  published_at       TEXT,
  published_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  UNIQUE (event_id, sequence)
) STRICT;
CREATE INDEX idx_snapshots_event ON result_snapshots (event_id, sequence);

CREATE TABLE result_entries (
  id              TEXT PRIMARY KEY,
  snapshot_id     TEXT NOT NULL REFERENCES result_snapshots(id) ON DELETE CASCADE,
  submission_id   TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  rank            INTEGER NOT NULL,
  tie_group       INTEGER NOT NULL DEFAULT 0,
  aggregate_score REAL,
  raw_aggregate   REAL,
  rank_raw        INTEGER,
  rank_delta      REAL,
  judge_count     INTEGER NOT NULL DEFAULT 0,
  assigned_judges INTEGER NOT NULL DEFAULT 0,
  coverage        REAL,
  validation      TEXT NOT NULL,
  track_id        TEXT,
  pairwise_rank   INTEGER,
  prizes          TEXT NOT NULL DEFAULT '[]',
  criteria        TEXT NOT NULL DEFAULT '[]',
  notes           TEXT NOT NULL DEFAULT '[]',
  review_hashes   TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX idx_result_entries_snapshot ON result_entries (snapshot_id, rank);
CREATE INDEX idx_result_entries_submission ON result_entries (submission_id);

CREATE TABLE judge_participation_records (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  judge_id           TEXT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  assignment_version INTEGER NOT NULL,
  reference          TEXT NOT NULL UNIQUE,
  judging_opens_at   TEXT NOT NULL,
  judging_closes_at  TEXT NOT NULL,
  assigned_count     INTEGER NOT NULL DEFAULT 0,
  completed_count    INTEGER NOT NULL DEFAULT 0,
  completion_status  TEXT NOT NULL,
  detail             TEXT NOT NULL DEFAULT '{}',
  integrity_hash     TEXT NOT NULL,
  issued_at          TEXT NOT NULL
) STRICT;
CREATE INDEX idx_participation_event ON judge_participation_records (event_id);
`,
  },

  {
    version: 9,
    name: 'community',
    sql: `
-- --------------------------------------------------------------- community

CREATE TABLE community_votes (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weight        REAL NOT NULL DEFAULT 1,
  ip_hash       TEXT NOT NULL DEFAULT '',
  user_agent    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (event_id, submission_id, user_id)
) STRICT;
CREATE INDEX idx_votes_submission ON community_votes (submission_id);
CREATE INDEX idx_votes_user ON community_votes (user_id, event_id);
CREATE INDEX idx_votes_event ON community_votes (event_id, created_at);

CREATE TABLE comments (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES comments(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'VISIBLE'
                  CHECK (state IN ('VISIBLE','PENDING','HIDDEN','DELETED')),
  moderated_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  moderated_at  TEXT,
  moderation_note TEXT NOT NULL DEFAULT '',
  report_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  edited_at     TEXT
) STRICT;
CREATE INDEX idx_comments_submission ON comments (submission_id, state, created_at);
CREATE INDEX idx_comments_user ON comments (user_id);

CREATE TABLE comment_reports (
  id          TEXT PRIMARY KEY,
  comment_id  TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REVIEWING','RESOLVED','DISMISSED')),
  created_at  TEXT NOT NULL,
  UNIQUE (comment_id, reporter_id)
) STRICT;
`,
  },

  {
    version: 10,
    name: 'certificates-and-integrations',
    sql: `
-- -------------------------------------------- certificates / integrations

CREATE TABLE certificates (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('PARTICIPANT','FINALIST','WINNER','JUDGE')),
  reference      TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  submission_id  TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  prize_id       TEXT,
  awarded_at     TEXT NOT NULL,
  issued_at      TEXT NOT NULL,
  revoked_at     TEXT,
  integrity_hash TEXT NOT NULL,
  payload        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (event_id, user_id, kind, submission_id)
) STRICT;
CREATE INDEX idx_certificates_event ON certificates (event_id, kind);

CREATE TABLE webhooks (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  secret         TEXT NOT NULL,
  subscriptions  TEXT NOT NULL DEFAULT '[]',
  state          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','PAUSED','DISABLED')),
  created_by     TEXT NOT NULL REFERENCES users(id),
  last_status    INTEGER,
  last_delivery_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  disabled_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;
CREATE INDEX idx_webhooks_event ON webhooks (event_id, state);

CREATE TABLE webhook_deliveries (
  id            TEXT PRIMARY KEY,
  webhook_id    TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  delivery_id   TEXT NOT NULL,
  payload       TEXT NOT NULL,
  signature     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','DELIVERED','FAILED','ABANDONED')),
  attempt       INTEGER NOT NULL DEFAULT 1,
  response_status INTEGER,
  response_body TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  duration_ms   INTEGER,
  next_attempt_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (webhook_id, delivery_id)
) STRICT;
CREATE INDEX idx_deliveries_webhook ON webhook_deliveries (webhook_id, created_at);
CREATE INDEX idx_deliveries_status ON webhook_deliveries (status, next_attempt_at);
`,
  },

  {
    version: 11,
    name: 'audit-and-ops',
    sql: `
-- ------------------------------------------------------------ audit / ops

-- Append-only. There is no UPDATE or DELETE path in the application for this
-- table, and TRIGGERs below make that a storage-level guarantee rather than a
-- convention.
CREATE TABLE audit_events (
  id             TEXT PRIMARY KEY,
  event_id       TEXT,
  actor_id       TEXT,
  actor_roles    TEXT NOT NULL DEFAULT '[]',
  actor_label    TEXT NOT NULL DEFAULT '',
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL DEFAULT '',
  resource_id    TEXT NOT NULL DEFAULT '',
  request_id     TEXT NOT NULL DEFAULT '',
  ip_address     TEXT NOT NULL DEFAULT '',
  user_agent     TEXT NOT NULL DEFAULT '',
  previous_state TEXT,
  new_state      TEXT,
  metadata       TEXT NOT NULL DEFAULT '{}',
  outcome        TEXT NOT NULL DEFAULT 'SUCCESS' CHECK (outcome IN ('SUCCESS','DENIED','FAILED')),
  created_at     TEXT NOT NULL,
  created_ms     INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_audit_event_time ON audit_events (event_id, created_ms);
CREATE INDEX idx_audit_resource ON audit_events (resource_type, resource_id, created_ms);
CREATE INDEX idx_audit_actor ON audit_events (actor_id, created_ms);
CREATE INDEX idx_audit_action ON audit_events (action, created_ms);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- A published snapshot is immutable. Corrections create a new snapshot, so the
-- database refuses to rewrite history.
CREATE TRIGGER result_snapshots_published_immutable_update
BEFORE UPDATE ON result_snapshots
WHEN OLD.is_published = 1 AND (
       NEW.integrity_hash <> OLD.integrity_hash
    OR NEW.result_run_id <> OLD.result_run_id
    OR NEW.sequence <> OLD.sequence
)
BEGIN
  SELECT RAISE(ABORT, 'a published result snapshot cannot be modified; publish a correction instead');
END;

CREATE TRIGGER result_snapshots_published_no_delete
BEFORE DELETE ON result_snapshots
WHEN OLD.is_published = 1
BEGIN
  SELECT RAISE(ABORT, 'a published result snapshot cannot be deleted');
END;

CREATE TRIGGER result_entries_published_no_update
BEFORE UPDATE ON result_entries
WHEN (SELECT is_published FROM result_snapshots WHERE id = OLD.snapshot_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'entries of a published snapshot are immutable');
END;

CREATE TRIGGER result_entries_published_no_delete
BEFORE DELETE ON result_entries
WHEN (SELECT is_published FROM result_snapshots WHERE id = OLD.snapshot_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'entries of a published snapshot are immutable');
END;

-- The final version of a submission is frozen at the deadline.
CREATE TRIGGER submission_versions_final_immutable
BEFORE UPDATE ON submission_versions
WHEN OLD.is_final = 1
BEGIN
  SELECT RAISE(ABORT, 'the final submission version is immutable');
END;

CREATE TRIGGER submission_versions_final_no_delete
BEFORE DELETE ON submission_versions
WHEN OLD.is_final = 1
BEGIN
  SELECT RAISE(ABORT, 'the final submission version is immutable');
END;

-- Scores lock themselves once the event leaves judging.
CREATE TRIGGER scores_locked_no_update
BEFORE UPDATE ON scores
WHEN OLD.state = 'LOCKED' AND (
       NEW.state <> 'LOCKED'
    OR COALESCE(NEW.raw_score, -1) <> COALESCE(OLD.raw_score, -1)
    OR COALESCE(NEW.total_score, -1) <> COALESCE(OLD.total_score, -1)
)
BEGIN
  SELECT RAISE(ABORT, 'a locked score is immutable');
END;

CREATE TRIGGER criterion_scores_locked_no_update
BEFORE UPDATE ON criterion_scores
WHEN (SELECT state FROM scores WHERE id = OLD.score_id) = 'LOCKED'
BEGIN
  SELECT RAISE(ABORT, 'criterion scores of a locked review are immutable');
END;

CREATE TABLE import_jobs (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('PARTICIPANTS','JUDGES','TEAMS','SUBMISSIONS')),
  status       TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','VALIDATED','APPLIED','PARTIAL','FAILED')),
  filename     TEXT NOT NULL DEFAULT '',
  total_rows   INTEGER NOT NULL DEFAULT 0,
  applied_rows INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,
  issues       TEXT NOT NULL DEFAULT '[]',
  dry_run      INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  completed_at TEXT,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX idx_import_jobs_event ON import_jobs (event_id, created_at);

CREATE TABLE export_jobs (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL
                 CHECK (kind IN ('PARTICIPANTS','TEAMS','SUBMISSIONS','ASSIGNMENTS','SCORES','RESULTS','AUDIT','ALL')),
  status       TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  row_count    INTEGER NOT NULL DEFAULT 0,
  checksum     TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX idx_export_jobs_event ON export_jobs (event_id, created_at);
`,
  },

  {
    version: 12,
    name: 'result-run-entries',
    sql: `
-- --------------------------------------------------- result run entries
--
-- A result *run* is a computation; a result *snapshot* is a publication of one.
-- They are not the same thing: several snapshots may point at the same run
-- (a correction re-publishes, it does not recompute), and a run must be
-- rehydratable and verifiable long before anybody publishes it.
--
-- Storing entries only under a snapshot made both impossible. createSnapshot
-- had to read the entries it was about to write, and rehydration of an
-- unpublished run returned an empty result set, so verify() compared nothing
-- against something and could never succeed.
--
-- The run's entries are therefore the source of truth, and result_entries is
-- the frozen copy that publication publishes.

CREATE TABLE result_run_entries (
  id              TEXT PRIMARY KEY,
  result_run_id   TEXT NOT NULL REFERENCES result_runs(id) ON DELETE CASCADE,
  submission_id   TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  rank            INTEGER NOT NULL,
  tie_group       INTEGER NOT NULL DEFAULT 0,
  aggregate_score REAL,
  raw_aggregate   REAL,
  rank_raw        INTEGER,
  rank_delta      REAL,
  judge_count     INTEGER NOT NULL DEFAULT 0,
  assigned_judges INTEGER NOT NULL DEFAULT 0,
  coverage        REAL,
  validation      TEXT NOT NULL,
  track_id        TEXT,
  pairwise_rank   INTEGER,
  prizes          TEXT NOT NULL DEFAULT '[]',
  criteria        TEXT NOT NULL DEFAULT '[]',
  notes           TEXT NOT NULL DEFAULT '[]',
  review_hashes   TEXT NOT NULL DEFAULT '[]',
  UNIQUE (result_run_id, submission_id)
) STRICT;
CREATE INDEX idx_run_entries_run ON result_run_entries (result_run_id, rank);
CREATE INDEX idx_run_entries_submission ON result_run_entries (submission_id);

-- A computed run is a record of what the engine did at a point in time. If it
-- could be edited in place, the integrity hash would no longer describe the
-- stored rows, and reproduction verification would be checking a hash against
-- data that had drifted underneath it. Correct by re-running.
--
-- There is deliberately no DELETE trigger here. Deleting an event or a run
-- must cascade, and SQLite only runs child triggers on cascade when
-- PRAGMA recursive_triggers is on, so a guard here would either be silently
-- inert or would break teardown depending on a pragma nobody remembers setting.
-- A missing entry shows up immediately as a reproduction-verification failure,
-- which is a louder signal than a constraint violation during a teardown.
CREATE TRIGGER result_run_entries_no_update
BEFORE UPDATE ON result_run_entries
BEGIN
  SELECT RAISE(ABORT, 'result run entries are immutable; recompute the run instead');
END;
`,
  },

  {
    version: 13,
    name: 'user-roles-global-scope',
    sql: `
-- ------------------------------------------------------ user role scope
--
-- user_roles had event_id both nullable ("NULL = global role") and part of its
-- PRIMARY KEY. In a STRICT table a primary-key column is implicitly NOT NULL,
-- so the table could not actually store a global role: granting ADMIN failed
-- with a constraint violation, and the seed could not create one either.
--
-- The fix keeps event_id nullable, which is what lets the foreign key do its
-- job — SQLite skips the check for NULL, so a global role is simply
-- unreferenced while an event-scoped role is genuinely validated against
-- events — and moves the key onto a non-null 'scope' mirror.
--
-- The CHECK is what stops the two drifting apart. Without it, a caller that
-- forgot to set scope would write a global role that claims to belong to an
-- event, and the RBAC layer would quietly grant access to a different event
-- than the audit log records.

CREATE TABLE user_roles_new (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('PARTICIPANT','JUDGE','ORGANIZER','ADMIN')),
  event_id    TEXT REFERENCES events(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,
  granted_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at  TEXT NOT NULL,
  revoked_at  TEXT,
  PRIMARY KEY (user_id, role, scope, granted_at),
  CHECK (scope = COALESCE(event_id, ''))
) STRICT;

INSERT INTO user_roles_new (user_id, role, event_id, scope, granted_by, granted_at, revoked_at)
  SELECT user_id, role, event_id, COALESCE(event_id, ''), granted_by, granted_at, revoked_at
  FROM user_roles;

DROP TABLE user_roles;
ALTER TABLE user_roles_new RENAME TO user_roles;

CREATE INDEX idx_user_roles_user ON user_roles (user_id);
CREATE INDEX idx_user_roles_event ON user_roles (event_id);
CREATE INDEX idx_user_roles_active ON user_roles (user_id, role) WHERE revoked_at IS NULL;
`,
  },

  {
    version: 14,
    name: 'participation-record-uniqueness',
    sql: `
-- ------------------------------------------------- participation records
--
-- judge_participation_records is written with
--   ON CONFLICT (event_id, judge_id, assignment_version) DO UPDATE
-- but the only unique constraint the table had was on 'reference', which is
-- derived from a hash of the record's own contents. Re-issuing after new
-- reviews therefore produced a *different* reference, matched no constraint,
-- and inserted a second row for the same judging round.
--
-- A judge must hold exactly one participation record per assignment version:
-- that is the whole point of the artefact, since it is what a judge or a
-- regulator checks after the fact. Pre-existing duplicates are collapsed to the
-- most recently issued row so the index can be created.
--
-- Note: the certificate service relies on this constraint to make re-issue
-- idempotent, so it must not be replaced by a unique index on 'reference'.

DELETE FROM judge_participation_records
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY event_id, judge_id, assignment_version
      ORDER BY issued_at DESC, id DESC
    ) AS rn
    FROM judge_participation_records
  ) WHERE rn = 1
);

CREATE UNIQUE INDEX idx_participation_unique
  ON judge_participation_records (event_id, judge_id, assignment_version);
`,
  },
];

export function runMigrations(db: DatabaseSync): { applied: number[]; version: number } {
  db.exec(MIGRATION_TABLE);

  const applied = new Map<number, string>();
  const rows = db
    .prepare('SELECT version, checksum FROM schema_migrations')
    .all() as { version: number; checksum: string }[];
  for (const row of rows) applied.set(Number(row.version), String(row.checksum));

  const newlyApplied: number[] = [];

  for (const migration of MIGRATIONS) {
    const checksum = sha256Hex(migration.sql);
    const existing = applied.get(migration.version);

    if (existing !== undefined) {
      if (existing !== checksum) {
        throw new Error(
          `Migration ${String(migration.version)} (${migration.name}) has already been applied but its contents have changed. ` +
            'Migrations are immutable: add a new migration instead of editing an applied one.',
        );
      }
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db
        .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, checksum, new Date().toISOString());
      db.exec('COMMIT');
      newlyApplied.push(migration.version);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw new Error(
        `Migration ${String(migration.version)} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return { applied: newlyApplied, version: Number(version.v ?? 0) };
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

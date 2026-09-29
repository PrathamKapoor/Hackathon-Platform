# Data model

The authoritative source for every column, constraint and index is
`apps/api/src/db/migrations.ts`. Migrations are numbered, checksummed and
immutable, so that file is history rather than a sketch: it is applied in order,
once, and a change to an already-applied migration is refused at boot.

This document is the map. It covers what the schema guarantees, what it merely
stores, and the places where the two have come apart.

---

## Shape

| | |
| --- | --- |
| Migrations | 16 (schema version 16) |
| Tables | 45, **all `STRICT`** |
| Explicit indexes | 69 (2 of them `UNIQUE`) |
| Inline `UNIQUE` constraints | 30, giving 76 `sqlite_autoindex` entries in total |
| Triggers | 12 |
| Inline `CHECK` constraints | 52 |
| `WITHOUT ROWID` tables | 0 |
| `PRAGMA` statements in migrations | 0 |

`STRICT` is the reason a typo in an insert is a type error rather than a
stray string that surfaces three queries later. Every table declares it.

The bookkeeping table `schema_migrations` is created outside the numbered array,
so a change to it is the one schema change the immutability guard does not
cover.

### Migration history

| v | Name | Adds |
| --- | --- | --- |
| 1 | `identity` | `users`, `user_roles`, `sessions`, `password_resets` |
| 2 | `events` | `events`, `event_tracks`, `prizes` |
| 3 | `registration` | `registration_fields`, `registrations`, `registration_responses` |
| 4 | `teams` | `teams`, `team_members`, `team_invitations` |
| 5 | `submissions` | `submissions`, `submission_versions`, `uploads` |
| 6 | `judging` | `judges`, `judge_conflicts`, `judge_assignments`, `rubrics`, `rubric_versions`, `rubric_criteria`, `scores`, `criterion_scores` |
| 7 | `calibration-and-pairwise` | `calibration_sessions`, `calibration_scores`, `pairwise_comparisons` |
| 8 | `results` | `normalization_runs`, `judge_diagnostics`, `anomaly_flags`, `result_runs`, `result_snapshots`, `result_entries`, `judge_participation_records` |
| 9 | `community` | `community_votes`, `comments`, `comment_reports` |
| 10 | `certificates-and-integrations` | `certificates`, `webhooks`, `webhook_deliveries` |
| 11 | `audit-and-ops` | `audit_events`, `import_jobs`, `export_jobs`, and the 10 immutability triggers |
| 12 | `result-run-entries` | `result_run_entries`, and the run-entry immutability trigger |
| 13 | `user-roles-global-scope` | rebuilds `user_roles` to support global roles properly |
| 14 | `participation-record-uniqueness` | dedupes participation records, adds the unique index behind them |
| 15 | `export-job-kind-csv-imports` | rebuilds `export_jobs` so the `kind` check constraint admits every CSV export and the three import kinds |
| 16 | `integrity-constraints` | `certificates.prize_id` foreign key; CHECKs on `judge_assignments.strategy`, `judge_participation_records.completion_status` and `submission_versions.state`; two `rubric_version_id` indexes |

---

## Tables

### Identity and roles

| Table | Holds | Notes |
| --- | --- | --- |
| `users` | account, password hash, profile, lifecycle `state` | email and username are stored normalised *and* unique |
| `user_roles` | role grants | `event_id IS NULL` is a global role; see the note below |
| `sessions` | live sessions | stores only the SHA-256 of the cookie, never the cookie |
| `password_resets` | one-shot reset tokens | digest only |

`user_roles` is the one table rebuilt rather than altered, and the reason is
worth recording. Version 1 put `event_id` in the primary key, which in a
`STRICT` table makes the column implicitly `NOT NULL` - so a global role was
unrepresentable and an `ADMIN` could not exist. Version 13 rebuilds the table
with `scope` as a non-null mirror of `COALESCE(event_id, '')`, enforced by a
table-level `CHECK`. Roles are rows, not a column: one person can be a
participant in one event, a judge in another, and an admin everywhere.

### Events, registration, teams, submissions

| Table | Holds | Notes |
| --- | --- | --- |
| `events` | the competition, its timeline and policy knobs | 10 lifecycle timestamps, 8 states |
| `event_tracks` | optional categories | |
| `prizes` | award definitions | |
| `registration_fields` | organizer-defined form schema | data, not code |
| `registrations` | applications | one per (event, user) |
| `registration_responses` | per-field answers | four typed value columns |
| `teams`, `team_members`, `team_invitations` | teams and invitations | |
| `submissions` | a project entry | |
| `submission_versions` | append-only edit history | full snapshot + checksum per row |
| `uploads` | file metadata | checksum, dimensions, magic-byte agreement |

### Judging

| Table | Holds | Notes |
| --- | --- | --- |
| `judges` | the panel | `capacity` bounds how many reviews a judge can take |
| `judge_conflicts` | declared conflicts | hard and soft; project-specific or polymorphic |
| `judge_assignments` | who reviews what | round `version`, status, soft-conflict flag |
| `rubrics`, `rubric_versions`, `rubric_criteria` | the rubric | versions are immutable once scoring exists |
| `scores`, `criterion_scores` | reviews | one review per judge per submission |

### Results and publication

| Table | Holds | Notes |
| --- | --- | --- |
| `normalization_runs` | a normalization computation | with its config hash and input hash |
| `judge_diagnostics` | per-judge signals from a run | |
| `anomaly_flags` | review flags | deduped by `(event_id, dedupe_key)` |
| `result_runs` | a **computation** | input hash, integrity hash, full provenance |
| `result_run_entries` | that run's per-project entries | **the source of truth for a run** |
| `result_snapshots` | a **publication** of a run | sequenced, immutable once published |
| `result_entries` | the frozen copy inside a snapshot | what the public board reads |
| `judge_participation_records` | per-judge participation artefact | with a content-derived reference |

`result_run_entries` and `result_entries` carry an identical column set. That
duplication is deliberate - a run has to be rehydratable and verifiable on its
own, and a correction re-publishes an existing run rather than recomputing it -
but it is the largest single drift surface in the schema, and no trigger
enforces that a snapshot's entries still equal its run's.

### Community, certificates, integrations, audit

| Table | Holds | Notes |
| --- | --- | --- |
| `community_votes` | public gallery votes | `ip_hash`, salted, never a raw address |
| `comments`, `comment_reports` | threaded discussion and triage | `comments.parent_id` is self-referencing |
| `certificates` | issued certificates | content-derived `reference` + `integrity_hash` |
| `webhooks`, `webhook_deliveries` | outbound integrations | delivery history and retry state |
| `audit_events` | append-only ledger | **no foreign keys, on purpose** |
| `import_jobs`, `export_jobs` | bulk data operations | |

`audit_events` carries no foreign keys so the log survives deletion of the thing
it describes. A user who deletes their account leaves their history behind, which
is the correct trade for a document whose whole purpose is to outlive the
records it references.

---

## What the schema guarantees

### Immutability, enforced by trigger

| Guard | Effect |
| --- | --- |
| `audit_events_no_update`, `audit_events_no_delete` | unconditional. The ledger is append-only. |
| `result_snapshots_published_immutable_update` | a published snapshot's `integrity_hash`, `result_run_id` and `sequence` cannot change. |
| `result_snapshots_published_no_delete` | a published snapshot cannot be deleted. |
| `result_entries_published_no_update`, `..._no_delete` | entries of a published snapshot are frozen. |
| `submission_versions_final_immutable`, `..._no_delete` | the deadline version of a submission is frozen. |
| `scores_locked_no_update` | a locked score's state and totals are frozen. |
| `criterion_scores_locked_no_update` | criterion answers of a locked review are frozen. |
| `result_run_entries_no_update` | unconditional. A run is recomputed, never edited. |

These are database-level, so they hold no matter which code path writes. A
service bug cannot quietly rewrite a published result.

Three gaps, stated rather than glossed:

- `criterion_scores` has an update guard but **no delete guard**.
- `result_run_entries` has **no delete guard**. SQLite only fires child triggers
  on cascade when `PRAGMA recursive_triggers` is on, and that pragma is never
  set, so a delete guard there would be inert anyway.
- Nothing enforces the `events.state` machine, `user_roles` transitions, or
  `webhooks.state` transitions at the database level. Those live in
  `packages/core/src/state-machines.ts` and are enforced in the service layer
  only, so a direct database edit could violate one.

### Referential integrity

Foreign keys are declared throughout and enforced - `PRAGMA foreign_keys = ON`
is set in the connection constructor, because SQLite defaults it to off and
without that line the entire referential story would be decorative. CASCADE is
used where a child has no meaning without its parent, `SET NULL` where the
parent is incidental.

`PRAGMA foreign_key_check` runs after migrating (`npm run migrate`) and reports
violations with a non-zero exit code. It does **not** run at boot, and that is
deliberate: SQLite does not re-validate existing rows when a foreign key is
added, so a database upgraded from an older release can legitimately hold rows
the current schema would refuse to create. A violation found in an upgraded
database is a data problem for an operator to see and fix, not a reason to
refuse to start.

> A check of this kind used to sit in the connection constructor and could not
> fail: the pragma was spelled `foreign_keys_check` rather than
> `foreign_key_check`, so SQLite ignored it, and it ran through `exec`, which
> discards the rows a check returns. It has been replaced by
> `Database.foreignKeyViolations()`, which is tested against a genuine violation.

### Connection pragmas

| Pragma | Value | Why |
| --- | --- | --- |
| `foreign_keys` | `ON` | off by default in SQLite |
| `journal_mode` | `WAL` (files only) | readers proceed during writes; the organizer dashboard polls while judges submit |
| `synchronous` | `NORMAL` | durable enough with WAL, much faster |
| `busy_timeout` | 5000 ms | a contended write waits rather than failing |
| `temp_store` | `MEMORY` | temp b-trees in RAM |
| `recursive_triggers` | *never set* | deliberately off; see the trigger gaps above |

---

## Derived values and where they can drift

The schema stores a number of things it could compute. Each of these is a place
where a bug can show up as a figure that disagrees with the rows behind it.

**Time mirrors.** Five `*_at` ISO-8601 strings have `*_ms` integer twins, so
that expiry comparisons are integer rather than string:
`sessions.last_seen_ms`, `sessions.expires_ms`, `password_resets.expires_ms`,
`team_invitations.expires_ms`, `audit_events.created_ms`.

**Counters and cached status.**

| Column | Derived from |
| --- | --- |
| `users.failed_login_count`, `locked_until` | auth activity; there is no failure table |
| `submissions.current_version` | `MAX(submission_versions.version)` |
| `comments.report_count` | `COUNT(comment_reports)` |
| `result_snapshots.entry_count` | `COUNT(result_entries)` |
| `result_entries.judge_count`, `assigned_judges`, `coverage` | `judge_assignments` and `scores` |
| `judge_participation_records.assigned_count`, `completed_count`, `completion_status` | `judge_assignments` for that judge and version |
| `webhooks.consecutive_failures`, `last_status`, `last_delivery_at` | `webhook_deliveries` |
| `import_jobs.total_rows`, `applied_rows`, `rejected_rows` | the import's own tallies - *not* constrained to add up |

**Hashes**, which are only verifiable by recomputation:
`submission_versions.checksum`, `uploads.checksum`, `export_jobs.checksum`,
`normalization_runs.config_hash` and `input_hash`, `result_runs.input_hash` and
`integrity_hash`, `result_snapshots.integrity_hash`, `certificates.integrity_hash`,
`judge_participation_records.integrity_hash`, and the `review_hashes` arrays on
both entry tables.

**Snapshot copies of user-supplied text.** `registrations.full_name`,
`organization`, `skills`, `github_url`, `portfolio_url` and `bio` are a copy of
`users.*` taken at application time. Nothing keeps them in sync, which is the
right behaviour - an application should reflect what the applicant said that day
- but it means a renamed account still shows the old name on its application.

**JSON stored as `TEXT`.** SQLite `STRICT` has no JSON type, so structured
payloads are text. The ones with an unambiguous `[]`/`{}` default are
`users.skills`, `prizes.eligible_ranks`, `registration_fields.options`,
`registrations.skills`, `submissions.technologies`,
`submission_versions.changed_fields`, `judges.expertise`,
`rubric_versions.tie_break_priority`, `calibration_scores.detail`,
`normalization_runs.warnings`, `result_runs.warnings`, the four arrays on each
entry table, `judge_participation_records.detail`, `webhooks.subscriptions`,
`audit_events.actor_roles` and `metadata`, and `import_jobs.issues`. Those
without a default but structured by role are
`registration_responses.value_json`, `submission_versions.snapshot`, the
`config`/`result`/`provenance`/`pairwise` blobs on `normalization_runs` and
`result_runs`, `judge_diagnostics.payload`, the `validation` columns on both
entry tables, `webhook_deliveries.payload`, and `certificates.payload`.

---

## Known integrity gaps

Real, and listed so nobody discovers them in production. Four are now closed;
the rest are stated with the reasoning that makes them acceptable.

1. ~~**`certificates.prize_id` has no foreign key.**~~ **Fixed in migration 16.**
   It is now `REFERENCES prizes(id) ON DELETE SET NULL` — SET NULL rather than
   CASCADE, because withdrawing a prize must not retract the proof that somebody
   won it. A test drives the violation and requires the database to refuse.
2. **`judge_assignments` carries a round model its unique key forbids.** It has
   `version`, a `REASSIGNED` status and an index on `(event_id, version)`, all
   implying multiple rounds per (judge, submission) - but `UNIQUE (judge_id,
   submission_id)` permits exactly one row per pair, ever. `scores` mirrors the
   same constraint, so a project cannot be re-judged. If re-judging is ever
   wanted, the unique key has to change. This is left alone deliberately: it is
   a modelling inconsistency, not a corruption the database permits silently, and
   changing the unique key would change what a "round" means to the assignment
   engine.
3. **`result_entries.track_id` and `result_run_entries.track_id` are bare
   `TEXT`** — and this is now a decision rather than an oversight. Those tables
   are published, immutable snapshots, and a snapshot's job is to record what was
   true when it was taken. Adding a foreign key would mean deleting a track could
   not remove the reference to it from an already-published result, so a
   historical record would break in the present tense. A dangling track id in a
   published snapshot is correct; a missing one would not be. The migration that
   closes gaps 1, 6 and 8 says so in its own comments, next to the code.
4. **`judge_conflicts.subject_id` is unconstrained.** It is a polymorphic
   reference with nothing tying it to `subject_kind`; the table-level `CHECK`
   only requires that a project id *or* a subject id is present, not that they
   are consistent. `subject_kind = 'TEAM'` with a `subject_id` pointing at a user
   is representable. `anomaly_flags.subject_id` is the same shape with no
   referential integrity at all. These cannot have a foreign key by nature — a
   column that points at one of four tables cannot reference all four — and the
   service resolves `subject_kind` before acting, so the risk is a mislabelled
   subject rather than a corrupt row.
5. **`NULL` defeats two unique constraints.** In SQLite, nulls are distinct
   inside a unique index, so `uploads`' `UNIQUE (event_id, stored_name)` does not
   dedupe when `event_id` is null, and neither does
   `certificates`' `UNIQUE (event_id, user_id, kind, submission_id)` when
   `submission_id` is null - which is exactly the case the certificate service
   relies on for idempotency. It works because the service also checks
   explicitly, not because the constraint does. The proper fix is a unique
   *index* over `COALESCE`, which SQLite supports; it was left for a later
   migration because it is a behavioural guarantee currently provided in
   application code, and moving it into the schema changes when the check runs.
6. ~~**Four status-like columns have no `CHECK`.**~~ **Three of the four fixed in
   migration 16**: `submission_versions.state`,
   `judge_participation_records.completion_status` and
   `judge_assignments.strategy` now declare their permitted values, each taken
   from the constant the application itself uses, and each proven to reject a
   bad value by a test rather than merely appearing in the DDL. The `validation`
   columns on `result_entries` and `result_run_entries` stay unconstrained,
   under the same reasoning as gap 3.
7. **`PRAGMA foreign_key_check` does not fire at boot**, by the reasoning above.
8. ~~**No index covers `rubric_version_id` on `scores` or `criterion_scores`.**~~
   **Fixed in migration 16.** Both are indexed, and the tests assert that a query
   filtering either column actually *uses* the index rather than merely that the
   index exists — an index the planner ignores is the original complaint. On
   `judge_participation_records.reference` the original text was already correct:
   it is covered by its unique auto-index, and that is now asserted.

Some indexes are redundant with unique constraints or with the leftmost prefix of
another index - `idx_users_email` duplicates `UNIQUE (email_normalized)`,
`idx_snapshots_event` duplicates `UNIQUE (event_id, sequence)`, and
`idx_user_roles_user` duplicates the primary key. They cost write time and
nothing else, and removing them would mean editing an applied migration.

---

## Checking a database

```bash
npm run migrate                 # applies pending migrations, then reports FK violations
node -e "const {DatabaseSync}=require('node:sqlite'); \
  const db=new DatabaseSync('./storage/verdict.db'); \
  console.log(db.prepare('PRAGMA integrity_check').get()); \
  console.log(db.prepare('PRAGMA foreign_key_check').all());"
```

`PRAGMA integrity_check` is the page-level check and returns `ok` on a sound
file; `foreign_key_check` is the logical one and returns one row per violation.
Both should be empty and `ok` respectively. See `docs/OPERATIONS.md` for backup,
restore and the upgrade procedure.

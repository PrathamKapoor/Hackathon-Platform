/**
 * Import and export.
 *
 * The governing rule from the spec is "do not silently lose information during
 * export". Three things follow from it:
 *
 *  1. Every export declares its columns in one place, so a reviewer can read
 *     the schema without running anything.
 *  2. Anything that would otherwise be dropped is either included or reported:
 *     `exportAll` returns a manifest naming every entity and its row count, and
 *     the bundle includes the schema, so a restore is possible.
 *  3. Imports validate every row and report each rejection. A partial import is
 *     reported as partial, never as success.
 */

import { parseCsv, rowsToObjects, toCsv, importRows, type CsvColumn } from '@verdict/core/csv';
import { validateEmail, validateHttpUrl, validatePlainText, validateSlug } from '@verdict/core/validation';
import { newId } from '@verdict/core/ids';
import { createHash } from 'node:crypto';
import { errors } from '../lib/errors.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';
import { slugify } from './event-service.ts';

/**
 * What can be exported, as a runtime value.
 *
 * This was a TypeScript union, which is erased at runtime - so there was nothing
 * the route, the manifest, the console or a test could read. Each of those then
 * spelled out its own copy of the list, and the database's CHECK constraint
 * spelled out a fifth, narrower one. The result: six of thirteen advertised
 * exports built their CSV, failed the CHECK while recording the job, and returned
 * HTTP 500, with no test ever asking for a positive export.
 *
 * A value fixes that, because the type is now derived from it rather than
 * restated beside it. `ExportKind` is `typeof EXPORT_KINDS[number]`, so a kind
 * added here is immediately valid in the route, the manifest and the service, and
 * the drift test in `capability-coverage.test.ts` fails if the database disagrees.
 */
export const EXPORT_KINDS = [
  'PARTICIPANTS',
  'REGISTRATIONS',
  'TEAMS',
  'SUBMISSIONS',
  'ASSIGNMENTS',
  'SCORES',
  'RESULTS',
  'AUDIT',
  'JUDGES',
  'VOTES',
  'COMMENTS',
  'ANOMALIES',
  'WEBHOOKS',
] as const;

export type ExportKind = (typeof EXPORT_KINDS)[number];

/**
 * What can be imported. `SUBMISSIONS` was in this union and in the database
 * CHECK for a long time with no route behind it, which is a declared capability
 * that does not exist; the importer now exists, and the drift test exercises
 * every kind rather than trusting the list.
 */
export const IMPORT_KINDS = ['PARTICIPANTS', 'JUDGES', 'TEAMS', 'SUBMISSIONS'] as const;

export type ImportKind = (typeof IMPORT_KINDS)[number];

export class TransferService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];
  private readonly auth: Services['auth'];
  private readonly registrations: Services['registrations'];

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
    this.auth = services.auth;
    this.registrations = services.registrations;
  }

  /* ============================================================ export */

  /** Column definitions, one declaration per entity. */
  private columns(kind: ExportKind): CsvColumn<Record<string, unknown>>[] {
    const col = (header: string, value: (row: Record<string, unknown>) => unknown): CsvColumn<Record<string, unknown>> => ({ header, value });

    switch (kind) {
      case 'REGISTRATIONS':
      case 'PARTICIPANTS':
        return [
          col('registration_id', (r) => r.id),
          col('user_id', (r) => r.user_id),
          col('email', (r) => r.email),
          col('username', (r) => r.username),
          col('display_name', (r) => r.display_name),
          col('state', (r) => r.state),
          col('full_name', (r) => r.full_name),
          col('organization', (r) => r.organization),
          col('skills', (r) => r.skills),
          col('github_url', (r) => r.github_url),
          col('portfolio_url', (r) => r.portfolio_url),
          col('bio', (r) => r.bio),
          col('team_name', (r) => r.team_name),
          col('decision_note', (r) => r.decision_note),
          col('decided_at', (r) => r.decided_at),
          col('submitted_at', (r) => r.submitted_at),
        ];
      case 'TEAMS':
        return [
          col('team_id', (r) => r.id),
          col('slug', (r) => r.slug),
          col('name', (r) => r.name),
          col('description', (r) => r.description),
          col('captain_email', (r) => r.captain_email),
          col('captain_name', (r) => r.captain_name),
          col('organization', (r) => r.organization),
          col('track', (r) => r.track_name),
          col('member_count', (r) => r.member_count),
          col('members', (r) => r.members),
          col('is_locked', (r) => r.is_locked),
          col('created_at', (r) => r.created_at),
        ];
      case 'SUBMISSIONS':
        return [
          col('submission_id', (r) => r.id),
          col('slug', (r) => r.slug),
          col('project_name', (r) => r.project_name),
          col('state', (r) => r.state),
          col('team_name', (r) => r.team_name),
          col('track', (r) => r.track_name),
          col('short_description', (r) => r.short_description),
          col('full_description', (r) => r.full_description),
          col('problem', (r) => r.problem),
          col('solution', (r) => r.solution),
          col('technologies', (r) => r.technologies),
          col('repository_url', (r) => r.repository_url),
          col('demo_url', (r) => r.demo_url),
          col('video_url', (r) => r.video_url),
          col('documentation_url', (r) => r.documentation_url),
          col('cover_image_url', (r) => r.cover_image_url),
          col('version_count', (r) => r.version_count),
          col('submitted_at', (r) => r.submitted_at),
          col('gallery_visible', (r) => r.gallery_visible),
        ];
      case 'JUDGES':
        return [
          col('judge_id', (r) => r.id),
          col('email', (r) => r.email),
          col('display_name', (r) => r.display_name),
          col('state', (r) => r.state),
          col('title', (r) => r.title),
          col('organization', (r) => r.organization),
          col('expertise', (r) => r.expertise),
          col('capacity', (r) => r.capacity),
          col('assigned', (r) => r.assigned),
          col('completed', (r) => r.completed),
          col('conflicts', (r) => r.conflicts),
          col('invited_at', (r) => r.invited_at),
        ];
      case 'ASSIGNMENTS':
        return [
          col('assignment_id', (r) => r.id),
          col('version', (r) => r.version),
          col('judge_email', (r) => r.judge_email),
          col('project_name', (r) => r.project_name),
          col('status', (r) => r.status),
          col('strategy', (r) => r.strategy),
          col('soft_conflict', (r) => r.soft_conflict),
          col('reason', (r) => r.reason),
          col('assigned_at', (r) => r.assigned_at),
          col('completed_at', (r) => r.completed_at),
        ];
      case 'SCORES':
        // Organizer-only. Judge identity is included because this is an export
        // for the organizer, and the action is audited.
        return [
          col('score_id', (r) => r.id),
          col('judge_email', (r) => r.judge_email),
          col('project_name', (r) => r.project_name),
          col('state', (r) => r.state),
          col('raw_score', (r) => r.raw_score),
          col('total_score', (r) => r.total_score),
          col('summary', (r) => r.summary),
          col('started_at', (r) => r.started_at),
          col('submitted_at', (r) => r.submitted_at),
          col('locked_at', (r) => r.locked_at),
          col('duration_ms', (r) => r.duration_ms),
          ...this.rubricKeys().map((key) =>
            col(`criterion_${key}`, (r) => (r.criteria as Record<string, number> | undefined)?.[key] ?? ''),
          ),
        ];
      case 'RESULTS':
        return [
          col('snapshot_id', (r) => r.snapshot_id),
          col('sequence', (r) => r.sequence),
          col('published', (r) => r.is_published),
          col('integrity_hash', (r) => r.integrity_hash),
          col('rank', (r) => r.rank),
          col('project_name', (r) => r.project_name),
          col('track', (r) => r.track_name),
          col('aggregate_score', (r) => r.aggregate_score),
          col('raw_aggregate', (r) => r.raw_aggregate),
          col('rank_raw', (r) => r.rank_raw),
          col('rank_delta', (r) => r.rank_delta),
          col('judge_count', (r) => r.judge_count),
          col('coverage', (r) => r.coverage),
          col('validation', (r) => r.validation),
          col('pairwise_rank', (r) => r.pairwise_rank),
          col('prizes', (r) => r.prizes),
          col('notes', (r) => r.notes),
        ];
      case 'AUDIT':
        return [
          col('audit_id', (r) => r.id),
          col('created_at', (r) => r.created_at),
          col('actor', (r) => r.actor_label || r.actor_id),
          col('actor_roles', (r) => r.actor_roles),
          col('action', (r) => r.action),
          col('resource_type', (r) => r.resource_type),
          col('resource_id', (r) => r.resource_id),
          col('previous_state', (r) => r.previous_state),
          col('new_state', (r) => r.new_state),
          col('outcome', (r) => r.outcome),
          col('request_id', (r) => r.request_id),
          col('metadata', (r) => r.metadata),
        ];
      case 'VOTES':
        return [
          col('vote_id', (r) => r.id),
          col('voter_email', (r) => r.voter_email),
          col('project_name', (r) => r.project_name),
          col('created_at', (r) => r.created_at),
        ];
      case 'COMMENTS':
        return [
          col('comment_id', (r) => r.id),
          col('author_email', (r) => r.author_email),
          col('project_name', (r) => r.project_name),
          col('state', (r) => r.state),
          col('report_count', (r) => r.report_count),
          col('created_at', (r) => r.created_at),
          col('body', (r) => r.body),
        ];
      case 'ANOMALIES':
        return [
          col('flag_id', (r) => r.id),
          col('type', (r) => r.anomaly_type),
          col('severity', (r) => r.severity),
          col('subject_kind', (r) => r.subject_kind),
          col('subject_id', (r) => r.subject_id),
          col('metric', (r) => r.metric),
          col('threshold', (r) => r.threshold),
          col('sample_size', (r) => r.sample_size),
          col('status', (r) => r.status),
          col('evidence', (r) => r.evidence),
          col('recommended_action', (r) => r.recommended_action),
          col('resolution', (r) => r.resolution),
          col('created_at', (r) => r.created_at),
        ];
      case 'WEBHOOKS':
        return [
          col('webhook_id', (r) => r.id),
          col('url', (r) => r.url),
          col('description', (r) => r.description),
          col('subscriptions', (r) => r.subscriptions),
          col('state', (r) => r.state),
          col('last_status', (r) => r.last_status),
          col('consecutive_failures', (r) => r.consecutive_failures),
          col('created_at', (r) => r.created_at),
        ];
      default:
        return [col('id', (r) => r.id)];
    }
  }

  private rubricKeys(): string[] {
    const rows = this.db.all<{ field_key: string }>('SELECT DISTINCT field_key FROM rubric_criteria ORDER BY field_key');
    return rows.map((row) => row.field_key);
  }

  /** Produce a CSV for one entity. Column schema is documented in API.md. */
  exportCsv(eventId: string, kind: ExportKind, ctx: ActorContext): { filename: string; csv: string; rows: number } {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);

    const rows = this.rowsFor(eventId, kind);
    const csv = toCsv(rows, this.columns(kind) as CsvColumn<Record<string, unknown>>[]);

    this.audit.record({
      action: 'export.generated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'exportJob',
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      metadata: { kind, rows: rows.length },
      at: ctx.at,
    });

    this.db.exec(
      `INSERT INTO export_jobs (id, event_id, kind, status, row_count, checksum, created_by, created_at, completed_at)
       VALUES (:id, :e, :kind, 'COMPLETED', :rows, :checksum, :by, :at, :at)`,
      {
        id: newId('exportJob'),
        e: eventId,
        kind: kind as string,
        rows: rows.length,
        checksum: contentDigest(csv),
        by: actor.id,
        at: ctx.at,
      },
    );

    return { filename: `${kind.toLowerCase()}-${eventId}.csv`, csv, rows: rows.length };
  }

  /**
   * A manifest describing everything an export bundle contains, so a consumer
   * knows whether they received the whole dataset.
   */
  exportManifest(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    /*
     * Derived from `EXPORT_KINDS` rather than restated. This list had drifted
     * twice: it omitted `PARTICIPANTS` entirely, so the manifest an organizer
     * reads before a bulk export did not mention a kind they can perfectly well
     * download. A fourth copy of a list that has three other copies is how that
     * happens.
     */
    const kinds: ExportKind[] = [...EXPORT_KINDS];
    return {
      event: { id: eventId, name: this.events.require(eventId).name, slug: this.events.require(eventId).slug },
      generatedAt: ctx.at,
      generatedBy: actor.id,
      schemaVersion: '1.0.0',
      entities: kinds.map((kind) => ({
        kind,
        file: `${kind.toLowerCase()}.csv`,
        rows: this.rowsFor(eventId, kind).length,
        columns: this.columns(kind).map((c) => c.header),
      })),
      note: 'Uploads (screenshots and attachments) are referenced by URL, not included as binary. Export the storage directory alongside this manifest for a complete archive.',
    };
  }

  private rowsFor(eventId: string, kind: ExportKind): Record<string, unknown>[] {
    const rows = this.db.all(
      {
        REGISTRATIONS: `SELECT r.*, u.email, u.username, u.display_name,
                                (SELECT t.name FROM teams t JOIN team_members m ON m.team_id = t.id
                                  WHERE t.event_id = r.event_id AND m.user_id = r.user_id LIMIT 1) AS team_name
                         FROM registrations r JOIN users u ON u.id = r.user_id WHERE r.event_id = :e ORDER BY r.submitted_at`,
        PARTICIPANTS: `SELECT r.*, u.email, u.username, u.display_name,
                                (SELECT t.name FROM teams t JOIN team_members m ON m.team_id = t.id
                                  WHERE t.event_id = r.event_id AND m.user_id = r.user_id LIMIT 1) AS team_name
                         FROM registrations r JOIN users u ON u.id = r.user_id WHERE r.event_id = :e ORDER BY r.submitted_at`,
        TEAMS: `SELECT t.*, cu.email AS captain_email, cu.display_name AS captain_name,
                       tr.name AS track_name,
                       (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count,
                       (SELECT GROUP_CONCAT(mu.display_name, ' | ') FROM team_members m JOIN users mu ON mu.id = m.user_id
                         WHERE m.team_id = t.id) AS members
                FROM teams t JOIN users cu ON cu.id = t.captain_id
                LEFT JOIN event_tracks tr ON tr.id = t.track_id
                WHERE t.event_id = :e ORDER BY t.name`,
        SUBMISSIONS: `SELECT s.*, t.name AS team_name, tr.name AS track_name,
                             (SELECT COUNT(*) FROM submission_versions v WHERE v.submission_id = s.id) AS version_count
                      FROM submissions s LEFT JOIN teams t ON t.id = s.team_id
                      LEFT JOIN event_tracks tr ON tr.id = s.track_id
                      WHERE s.event_id = :e ORDER BY s.submitted_at`,
        JUDGES: `SELECT j.*, u.email, u.display_name,
                        (SELECT COUNT(*) FROM judge_assignments a WHERE a.judge_id = j.id AND a.status <> 'REASSIGNED') AS assigned,
                        (SELECT COUNT(*) FROM judge_assignments a WHERE a.judge_id = j.id AND a.status = 'SUBMITTED') AS completed,
                        (SELECT COUNT(*) FROM judge_conflicts c WHERE c.judge_id = j.id) AS conflicts
                 FROM judges j JOIN users u ON u.id = j.user_id WHERE j.event_id = :e ORDER BY u.display_name`,
        ASSIGNMENTS: `SELECT a.*, u.email AS judge_email, s.project_name
                      FROM judge_assignments a JOIN users u ON u.id = a.judge_id
                      JOIN submissions s ON s.id = a.submission_id
                      WHERE a.event_id = :e ORDER BY a.version, s.project_name`,
        SCORES: `SELECT sc.*, u.email AS judge_email, s.project_name,
                        (SELECT GROUP_CONCAT(rc.field_key || '=' || cs.points, ';')
                         FROM criterion_scores cs JOIN rubric_criteria rc ON rc.id = cs.criterion_id
                         WHERE cs.score_id = sc.id) AS criteria_json
                 FROM scores sc JOIN users u ON u.id = sc.judge_id
                 JOIN submissions s ON s.id = sc.submission_id
                 WHERE sc.event_id = :e ORDER BY s.project_name, u.display_name`,
        RESULTS: `SELECT rs.*, s.project_name, tr.name AS track_name
                  FROM result_entries rs
                  JOIN result_snapshots snap ON snap.id = rs.snapshot_id
                  JOIN submissions s ON s.id = rs.submission_id
                  LEFT JOIN event_tracks tr ON tr.id = s.track_id
                  WHERE snap.event_id = :e ORDER BY snap.sequence DESC, rs.rank`,
        VOTES: `SELECT v.id, u.email AS voter_email, s.project_name, v.created_at
                FROM community_votes v JOIN users u ON u.id = v.user_id
                JOIN submissions s ON s.id = v.submission_id WHERE v.event_id = :e ORDER BY v.created_at`,
        COMMENTS: `SELECT c.id, u.email AS author_email, s.project_name, c.state, c.report_count, c.created_at, c.body
                  FROM comments c JOIN users u ON u.id = c.user_id
                  JOIN submissions s ON s.id = c.submission_id WHERE c.event_id = :e ORDER BY c.created_at`,
        ANOMALIES: 'SELECT * FROM anomaly_flags WHERE event_id = :e ORDER BY created_at',
        WEBHOOKS: `SELECT id, url, description, subscriptions, state, last_status, consecutive_failures, created_at
                   FROM webhooks WHERE event_id = :e ORDER BY created_at`,
        AUDIT: 'SELECT * FROM audit_events WHERE event_id = :e ORDER BY created_ms, id',
      }[kind] ?? 'SELECT 1 AS id',
      { e: eventId },
    );

    if (kind === 'SCORES') {
      return rows.map((row) => {
        const criteria: Record<string, number> = {};
        for (const pair of String(row.criteria_json ?? '').split(';').filter(Boolean)) {
          const [key, points] = pair.split('=');
          if (key) criteria[key] = Number(points);
        }
        const { criteria_json: _omit, ...rest } = row;
        return { ...rest, criteria };
      });
    }
    return rows;
  }

  /* ============================================================ import */

  /**
   * Import judges from CSV. `dryRun` is the default: a bulk import is the
   * operation where an unreviewed write does the most damage.
   */
  importJudges(
    eventId: string,
    csv: string,
    options: { dryRun?: boolean; capacity?: number },
    ctx: ActorContext,
  ): { total: number; valid: number; applied: number; rejected: number; issues: { row: number; column: string | null; message: string; value: string | null }[] } {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const dryRun = options.dryRun !== false;

    const parsed = parseCsv(csv, { maxColumns: 40 });
    if (parsed.header.length === 0) throw errors.badRequest('That CSV file has no header row.');
    const { objects } = rowsToObjects(parsed);
    const issues: { row: number; column: string | null; message: string; value: string | null }[] = [];

    const result = importRows<{ email: string; title: string; organization: string; expertise: string[]; capacity: number }>(objects, {
      fields: {
        email: (raw) => {
          if (raw === '') return { error: 'email is required' };
          try {
            return validateEmail(raw);
          } catch (error) {
            return { error: error instanceof Error ? error.message : 'invalid email' };
          }
        },
        title: (raw) => raw,
        organization: (raw) => raw,
        expertise: (raw) => raw.split(';').map((s) => s.trim()).filter(Boolean),
        capacity: (raw) => {
          if (raw === '') return options.capacity ?? 10;
          const n = Number(raw);
          return Number.isInteger(n) && n >= 0 && n <= 500 ? n : { error: 'capacity must be an integer between 0 and 500' };
        },
      },
      onIssue: (issue) => issues.push(issue),
    });

    let applied = 0;
    if (!dryRun) {
      for (const row of result.rows) {
        const value = row.value;
        const email = value.email as string;
        const user = this.auth.findByEmail(email);
        if (user === null) {
          issues.push({ row: row.row, column: 'email', message: 'no account with this email; create the account first', value: email });
          continue;
        }
        const existing = this.db.get<{ id: string }>('SELECT id FROM judges WHERE event_id = :e AND user_id = :u', { e: eventId, u: user.id });
        if (existing !== null) {
          this.db.exec(
            `UPDATE judges SET title = :title, organization = :org, expertise = :expertise, capacity = :capacity, updated_at = :at WHERE id = :id`,
            {
              title: (value.title as string) ?? '',
              org: (value.organization as string) ?? '',
              expertise: JSON.stringify(value.expertise ?? []),
              capacity: value.capacity ?? 10,
              at: ctx.at,
              id: existing.id,
            },
          );
        } else {
          this.db.exec(
            `INSERT INTO judges (id, event_id, user_id, state, title, organization, expertise, capacity, invited_by, invited_at, created_at, updated_at)
             VALUES (:id, :e, :u, 'INVITED', :title, :org, :expertise, :capacity, :by, :at, :at, :at)`,
            {
              id: newId('judge'),
              e: eventId,
              u: user.id,
              title: (value.title as string) ?? '',
              org: (value.organization as string) ?? '',
              expertise: JSON.stringify(value.expertise ?? []),
              capacity: value.capacity ?? 10,
              by: actor.id,
              at: ctx.at,
            },
          );
          this.db.exec(
            `INSERT INTO user_roles (user_id, role, event_id, scope, granted_by, granted_at) VALUES (:u, 'JUDGE', :e, :e, :by, :at)`,
            { u: user.id, e: eventId, by: actor.id, at: ctx.at },
          );
        }
        applied += 1;
      }
    }

    this.audit.record({
      action: 'import.executed',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'importJob',
      requestId: ctx.requestId,
      metadata: { kind: 'JUDGES', total: objects.length, valid: result.rows.length, applied, rejected: issues.length, dryRun },
      at: ctx.at,
    });

    return { total: objects.length, valid: result.rows.length, applied, rejected: issues.length, issues };
  }

  /** Import teams from CSV. Captains are matched by email. */
  importTeams(
    eventId: string,
    csv: string,
    options: { dryRun?: boolean },
    ctx: ActorContext,
  ): { total: number; applied: number; rejected: number; issues: { row: number; column: string | null; message: string; value: string | null }[] } {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const dryRun = options.dryRun !== false;

    const parsed = parseCsv(csv, { maxColumns: 30 });
    if (parsed.header.length === 0) throw errors.badRequest('That CSV file has no header row.');
    const { objects } = rowsToObjects(parsed);
    const issues: { row: number; column: string | null; message: string; value: string | null }[] = [];

    const result = importRows<{ name: string; captain_email: string; description: string; organization: string; members: string[] }>(objects, {
      fields: {
        name: (raw) => {
          if (raw === '') return { error: 'name is required' };
          return validatePlainText(raw, { field: 'name', max: 100 });
        },
        captain_email: (raw) => {
          if (raw === '') return { error: 'captain_email is required' };
          try {
            return validateEmail(raw);
          } catch (error) {
            return { error: error instanceof Error ? error.message : 'invalid email' };
          }
        },
        description: (raw) => raw,
        organization: (raw) => raw,
        members: (raw) => raw.split(';').map((s) => s.trim().toLowerCase()).filter(Boolean),
      },
      onIssue: (issue) => issues.push(issue),
    });

    let applied = 0;
    if (!dryRun) {
      for (const row of result.rows) {
        const value = row.value;
        const captain = this.auth.findByEmail(value.captain_email as string);
        if (captain === null) {
          issues.push({ row: row.row, column: 'captain_email', message: 'no account with this email', value: value.captain_email as string });
          continue;
        }
        const existing = this.db.get<{ id: string }>('SELECT id FROM teams WHERE event_id = :e AND captain_id = :u', { e: eventId, u: captain.id });
        const slugBase = validateSlug(slugify(value.name as string), 'slug');
        const slug = existing !== null
          ? (this.db.value<string>('SELECT slug FROM teams WHERE id = :id', { id: existing.id }) as string)
          : this.uniqueSlug(eventId, slugBase);

        let teamId: string;
        if (existing !== null) {
          teamId = existing.id;
          this.db.exec(
            'UPDATE teams SET name = :name, description = :description, organization = :org, updated_at = :at WHERE id = :id',
            {
              name: value.name,
              description: (value.description as string) ?? '',
              org: (value.organization as string) ?? '',
              at: ctx.at,
              id: teamId,
            },
          );
        } else {
          teamId = newId('team');
          this.db.exec(
            `INSERT INTO teams (id, event_id, slug, name, description, captain_id, organization, created_at, updated_at)
             VALUES (:id, :e, :slug, :name, :description, :captain, :org, :at, :at)`,
            {
              id: teamId,
              e: eventId,
              slug,
              name: value.name,
              description: (value.description as string) ?? '',
              captain: captain.id,
              org: (value.organization as string) ?? '',
              at: ctx.at,
            },
          );
          // The captain is always also a member; the two are written together
          // so a team can never exist without its captain.
          this.db.exec(
            `INSERT INTO team_members (id, team_id, user_id, role, joined_at, created_at, updated_at)
             VALUES (:id, :t, :u, 'CAPTAIN', :at, :at, :at)`,
            { id: newId('teamMember'), t: teamId, u: captain.id, at: ctx.at },
          );
        }

        for (const memberEmail of (value.members as string[]) ?? []) {
          const member = this.auth.findByEmail(memberEmail);
          if (member === null) {
            issues.push({ row: row.row, column: 'members', message: `no account for ${memberEmail}`, value: memberEmail });
            continue;
          }
          this.db.exec(
            `INSERT INTO team_members (id, team_id, user_id, role, joined_at, created_at, updated_at)
             VALUES (:id, :t, :u, 'MEMBER', :at, :at, :at)
             ON CONFLICT (team_id, user_id) DO NOTHING`,
            { id: newId('teamMember'), t: teamId, u: member.id, at: ctx.at },
          );
        }
        applied += 1;
      }
    }

    this.audit.record({
      action: 'import.executed',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'importJob',
      requestId: ctx.requestId,
      metadata: { kind: 'TEAMS', total: objects.length, applied, rejected: issues.length, dryRun },
      at: ctx.at,
    });

    return { total: objects.length, applied, rejected: issues.length, issues };
  }

  /**
   * The participants importer lives on the registration service because it has
   * to write responses against the event's form. Re-exported here so the import
   * surface is described in one place.
   */
  importParticipants(eventId: string, csv: string, options: { dryRun?: boolean; createAccounts?: boolean }, ctx: ActorContext) {
    return this.registrations.importCsv(eventId, csv, options, ctx);
  }

  /**
   * Submissions, by CSV.
   *
   * `SUBMISSIONS` was in the import kind union and in the database's CHECK for a
   * long time with no route and no method behind it - a declared capability that
   * did not exist, which is worse than an absent one because the type said it was
   * there. A bulk import of projects is the one a hackathon actually needs on the
   * morning of judging, so it exists now.
   *
   * Imported projects land as `SUBMITTED`, not `DRAFT`, and the row is matched on
   * the team email rather than created: an import is a record of what a team says
   * it built, made by an organizer on their behalf, and it has to be in the
   * contest rather than sitting in a draft nobody will open. `dryRun` defaults to
   * true, as with every other importer, so the first run a volunteer organizer
   * does is a rehearsal.
   */
  importSubmissions(
    eventId: string,
    csv: string,
    options: { dryRun?: boolean },
    ctx: ActorContext,
  ): { total: number; applied: number; rejected: number; issues: { row: number; column: string | null; message: string; value: string | null }[] } {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const dryRun = options.dryRun !== false;

    const parsed = parseCsv(csv, { maxColumns: 30 });
    if (parsed.header.length === 0) throw errors.badRequest('That CSV file has no header row.');
    const { objects } = rowsToObjects(parsed);
    const issues: { row: number; column: string | null; message: string; value: string | null }[] = [];

    const result = importRows<{
      team_email: string;
      project_name: string;
      short_description: string;
      full_description: string;
      problem: string;
      solution: string;
      technologies: string[];
      repository_url: string;
      demo_url: string;
      documentation_url: string;
    }>(objects, {
      fields: {
        team_email: (raw) => {
          if (raw === '') return { error: 'team_email is required' };
          try {
            return validateEmail(raw);
          } catch (error) {
            return { error: error instanceof Error ? error.message : 'invalid email' };
          }
        },
        project_name: (raw) => {
          if (raw === '') return { error: 'project_name is required' };
          return validatePlainText(raw, { field: 'project_name', max: 160 });
        },
        short_description: (raw) => validatePlainText(raw, { field: 'short_description', max: 400 }),
        full_description: (raw) => validatePlainText(raw, { field: 'full_description', max: 20_000 }),
        problem: (raw) => validatePlainText(raw, { field: 'problem', max: 10_000 }),
        solution: (raw) => validatePlainText(raw, { field: 'solution', max: 10_000 }),
        technologies: (raw) => raw.split(';').map((s) => s.trim()).filter(Boolean),
        repository_url: (raw) => this.optionalUrl(raw),
        demo_url: (raw) => this.optionalUrl(raw),
        documentation_url: (raw) => this.optionalUrl(raw),      },
      onIssue: (issue) => issues.push(issue),
    });

    let applied = 0;
    if (!dryRun) {
      for (const row of result.rows) {
        const value = row.value;
        const captain = this.auth.findByEmail(value.team_email as string);
        if (captain === null) {
          issues.push({ row: row.row, column: 'team_email', message: 'no account with this email', value: value.team_email as string });
          continue;
        }
        const team = this.db.get<{ id: string }>(
          'SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE t.event_id = :e AND tm.user_id = :u LIMIT 1',
          { e: eventId, u: captain.id },
        );
        if (team === null) {
          issues.push({ row: row.row, column: 'team_email', message: 'that account is not on a team in this event', value: value.team_email as string });
          continue;
        }

        const projectName = value.project_name as string;
        const slug = this.uniqueSubmissionSlug(eventId, slugify(projectName));
        const submissionId = newId('submission');
        this.db.transaction(() => {
          this.db.exec(
            `INSERT INTO submissions (
               id, event_id, team_id, created_by, slug, project_name, short_description,
               full_description, problem, solution, technologies, repository_url, demo_url,
               documentation_url, state, current_version, gallery_visible, eligible_for_prizes,
               created_at, updated_at, submitted_at
             ) VALUES (
               :id, :e, :t, :by, :slug, :name, :short,
               :full, :problem, :solution, :tech, :repo, :demo,
               :docs, 'SUBMITTED', 1, 1, 1,
               :at, :at, :at
             )`,
            {
              id: submissionId,
              e: eventId,
              t: team.id,
              by: captain.id,
              slug,
              name: projectName,
              short: (value.short_description as string) ?? '',
              full: (value.full_description as string) ?? '',
              problem: (value.problem as string) ?? '',
              solution: (value.solution as string) ?? '',
              tech: JSON.stringify(value.technologies as string[]),
              repo: value.repository_url,
              demo: value.demo_url,
              docs: value.documentation_url,
              at: ctx.at,
            },
          );
          // A version row, so the submission has the same history every other
          // project does. A bulk import that produced projects with no version
          // record would be the one thing in the schema with no provenance.
          this.db.exec(
            `INSERT INTO submission_versions (id, submission_id, version, state, snapshot, changed_fields, checksum, note, is_final, created_at)
             VALUES (:id, :s, 1, 'SUBMITTED', :snapshot, '[]', :sum, 'imported by the organizer', 0, :at)`,
            {
              id: newId('submissionVersion'),
              s: submissionId,
              snapshot: JSON.stringify({ projectName, imported: true }),
              sum: contentDigest(`${String(submissionId)}:1`),
              at: ctx.at,
            },
          );
        });
        applied += 1;
      }
    }

    this.audit.record({
      action: 'import.executed',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'importJob',
      requestId: ctx.requestId,
      metadata: { kind: 'SUBMISSIONS', total: objects.length, applied, rejected: issues.length, dryRun },
      at: ctx.at,
    });

    return { total: objects.length, applied, rejected: issues.length, issues };
  }

  /**
   * An optional URL column. Returns the same shape `importRows` expects for a
   * field: the value, or an error for that row. Empty is not an error - a
   * project with no demo is a perfectly ordinary project.
   */
  private optionalUrl(raw: string): string | { error: string } {
    if (raw === '') return '';
    const result = validateHttpUrl(raw, { allowPrivateHosts: true });
    return result.valid ? result.url : { error: result.reason };
  }

  private uniqueSubmissionSlug(eventId: string, base: string): string {
    let candidate = base || 'project';
    let suffix = 1;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const clash = this.db.get<{ id: string }>('SELECT id FROM submissions WHERE event_id = :e AND slug = :s', { e: eventId, s: candidate });
      if (clash === null) return candidate;
      suffix += 1;
      candidate = `${base}-${String(suffix)}`;
    }
    throw errors.conflict('Could not derive a unique project slug.');
  }

  private uniqueSlug(eventId: string, base: string): string {
    let candidate = base || 'team';
    let suffix = 1;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const clash = this.db.get<{ id: string }>('SELECT id FROM teams WHERE event_id = :e AND slug = :s', { e: eventId, s: candidate });
      if (clash === null) return candidate;
      suffix += 1;
      candidate = `${base}-${String(suffix)}`;
    }
    throw errors.conflict('Could not derive a unique team slug.');
  }
}

/** Content digest of an export, so a consumer can prove they received it intact. */
function contentDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export { validateHttpUrl };

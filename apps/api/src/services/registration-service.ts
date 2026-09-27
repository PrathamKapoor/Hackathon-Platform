/**
 * Registration applications.
 *
 * The application form is data, not code: organizers add, reorder and remove
 * fields without a deploy. Responses are stored per field with a typed column
 * so filtering and export never have to re-parse text.
 *
 * Every decision (accept / reject / waitlist) goes through the registration
 * state machine, so an organizer cannot put an application into a state the
 * workflow has no way out of.
 */

import { newId } from '@verdict/core/ids';
import { now } from '@verdict/core/time';
import { assertTransition, type TransitionContext } from '@verdict/core/state-machines';
import { validateEmail, validateHttpUrl, validatePlainText } from '@verdict/core/validation';
import { isOneOf, type RegistrationState, type Role } from '@verdict/core/types';
import { errors } from '../lib/errors.ts';
import { canManageEvent } from '../lib/rbac.ts';
import { toCsv, parseCsv, rowsToObjects, importRows } from '@verdict/core/csv';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';

export const FIELD_TYPES = ['text', 'number', 'select', 'multi_select', 'checkbox'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type RegistrationFieldRow = {
  id: string;
  event_id: string;
  field_key: string;
  label: string;
  help_text: string;
  field_type: FieldType;
  required: number;
  options: string;
  placeholder: string;
  display_order: number;
  created_at: string;
  updated_at: string;
};

export type RegistrationRow = {
  id: string;
  event_id: string;
  user_id: string;
  state: RegistrationState;
  full_name: string;
  organization: string;
  skills: string;
  github_url: string | null;
  portfolio_url: string | null;
  bio: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string;
  submitted_at: string;
  created_at: string;
  updated_at: string;
};

/** The nine built-in profile columns, always collected for the participant record. */
export type ProfileAnswers = {
  fullName?: string;
  organization?: string;
  skills?: string[];
  githubUrl?: string | null;
  portfolioUrl?: string | null;
  bio?: string;
};

export class RegistrationService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];
  private readonly auth: Services['auth'];

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
    this.auth = services.auth;
  }

  /* ------------------------------------------------------------ fields */

  listFields(eventId: string): RegistrationFieldRow[] {
    return this.db.all<RegistrationFieldRow>(
      'SELECT * FROM registration_fields WHERE event_id = :e ORDER BY display_order, label',
      { e: eventId },
    );
  }

  addField(
    eventId: string,
    input: { key?: string; label: string; helpText?: string; type: FieldType; required?: boolean; options?: string[]; placeholder?: string },
    ctx: ActorContext,
  ): RegistrationFieldRow {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    if (!isOneOf(input.type, FIELD_TYPES)) {
      throw errors.validation('Unknown field type.', [{ field: 'type', issue: `expected one of ${FIELD_TYPES.join(', ')}` }]);
    }
    if ((input.type === 'select' || input.type === 'multi_select') && (input.options ?? []).length < 2) {
      throw errors.validation('A select field needs at least two options.', [{ field: 'options' }]);
    }
    const label = validatePlainText(input.label, { field: 'label', min: 1, max: 120 });
    const key = (input.key ?? slugKey(label)).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);
    if (key === '') throw errors.validation('A field key is required.', [{ field: 'key' }]);

    const clash = this.db.get('SELECT id FROM registration_fields WHERE event_id = :e AND field_key = :k', { e: eventId, k: key });
    if (clash !== null) throw errors.conflict(`A field with key "${key}" already exists on this form.`, [{ field: 'key' }]);

    const id = newId('registrationField');
    const order = (this.db.value<number>('SELECT COALESCE(MAX(display_order), -1) + 1 AS o FROM registration_fields WHERE event_id = :e', { e: eventId }) ?? 0) as number;
    this.db.exec(
      `INSERT INTO registration_fields (id, event_id, field_key, label, help_text, field_type, required, options, placeholder, display_order, created_at, updated_at)
       VALUES (:id, :e, :k, :label, :help, :type, :required, :options, :placeholder, :order, :at, :at)`,
      {
        id,
        e: eventId,
        k: key,
        label,
        help: validatePlainText(input.helpText ?? '', { field: 'helpText', max: 400 }),
        type: input.type,
        required: input.required === false ? 0 : 1,
        options: JSON.stringify(input.options ?? []),
        placeholder: validatePlainText(input.placeholder ?? '', { field: 'placeholder', max: 120 }),
        order,
        at: ctx.at,
      },
    );
    return this.db.get<RegistrationFieldRow>('SELECT * FROM registration_fields WHERE id = :id', { id })!;
  }

  deleteField(eventId: string, fieldId: string, ctx: ActorContext): void {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    this.db.exec('DELETE FROM registration_fields WHERE id = :id AND event_id = :e', { id: fieldId, e: eventId });
  }

  /* ------------------------------------------------------ applications */

  /**
   * Submit an application.
   *
   * Idempotent per (event, user): a second attempt updates the existing
   * application rather than creating a duplicate, so a participant who
   * refreshes does not end up with two rows.
   */
  apply(
    eventId: string,
    answers: ProfileAnswers & { responses?: Record<string, string | string[] | number | boolean> },
    ctx: ActorContext,
  ): RegistrationRow {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);

    const window = this.events.window(event, 'registration', ctx.at);
    if (!window.open && !this.events.isFrozen(event, ctx.at)) {
      throw errors.windowClosed(window.reason);
    }

    const existing = this.findForUser(eventId, actor.id);
    if (existing !== null && ['ACCEPTED', 'REJECTED', 'WITHDRAWN'].includes(existing.state)) {
      throw errors.conflict(
        `Your application is already ${existing.state.toLowerCase()} and cannot be edited. Contact an organizer if that is wrong.`,
        [{ field: 'state', issue: existing.state }],
      );
    }

    return this.db.transaction(() => {
      const fullName = answers.fullName
        ? validatePlainText(answers.fullName, { field: 'full name', min: 1, max: 160 })
        : (this.auth.requireUser(actor.id).display_name);
      const organization = answers.organization
        ? validatePlainText(answers.organization, { field: 'organization', max: 200 })
        : '';
      const skills = (answers.skills ?? []).slice(0, 40).map((s) => validatePlainText(s, { field: 'skill', max: 60 }));
      const githubUrl = this.urlOrNull(answers.githubUrl, 'githubUrl');
      const portfolioUrl = this.urlOrNull(answers.portfolioUrl, 'portfolioUrl');
      const bio = answers.bio ? validatePlainText(answers.bio, { field: 'bio', max: 4000 }) : '';

      const id = existing?.id ?? newId('registration');
      if (existing === null) {
        this.db.exec(
          `INSERT INTO registrations (
             id, event_id, user_id, state, full_name, organization, skills,
             github_url, portfolio_url, bio, submitted_at, created_at, updated_at
           ) VALUES (
             :id, :e, :u, 'APPLICATION', :full_name, :organization, :skills,
             :github, :portfolio, :bio, :at, :at, :at
           )`,
          {
            id,
            e: eventId,
            u: actor.id,
            full_name: fullName,
            organization,
            skills: JSON.stringify(skills),
            github: githubUrl,
            portfolio: portfolioUrl,
            bio,
            at: ctx.at,
          },
        );
      } else {
        this.db.exec(
          `UPDATE registrations SET full_name = :full_name, organization = :organization, skills = :skills,
             github_url = :github, portfolio_url = :portfolio, bio = :bio, submitted_at = :at, updated_at = :at
           WHERE id = :id`,
          {
            id,
            full_name: fullName,
            organization,
            skills: JSON.stringify(skills),
            github: githubUrl,
            portfolio: portfolioUrl,
            bio,
            at: ctx.at,
          },
        );
      }

      this.writeResponses(id, answers.responses ?? {});

      // A first submission moves APPLICATION -> PENDING, which is the only legal
      // forward step and is what the organizer's queue sorts on.
      const current = this.require(id);
      if (current.state === 'APPLICATION') {
        this.transition(id, 'PENDING', ctx);
      }

      this.audit.record({
        action: existing === null ? 'registration.created' : 'registration.state_changed',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId,
        resourceType: 'registration',
        resourceId: id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        previousState: current.state,
        newState: 'PENDING',
        at: ctx.at,
      });

      return this.require(id);
    });
  }

  /** Organizer decision. This is the only way an application changes state. */
  decide(
    registrationId: string,
    to: RegistrationState,
    options: { note?: string; override?: boolean },
    ctx: ActorContext,
  ): RegistrationRow {
    const actor = requireActor(ctx);
    const before = this.require(registrationId);
    this.events.assertOrganizer(actor, this.events.require(before.event_id), ctx);

    const transitionContext: TransitionContext = {
      override: options.override === true,
      facts: {},
      actor: { id: actor.id, roles: actor.roles },
    };
    try {
      assertTransition<RegistrationState>('Registration', before.state, to, transitionContext);
    } catch (error) {
      this.audit.record({
        action: 'registration.state_changed',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: before.event_id,
        resourceType: 'registration',
        resourceId: registrationId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        outcome: 'DENIED',
        previousState: before.state,
        newState: to,
        metadata: { reason: error instanceof Error ? error.message : 'denied' },
        at: ctx.at,
      });
      throw errors.illegalTransition(error instanceof Error ? error.message : 'That decision is not permitted.');
    }

    this.db.exec(
      `UPDATE registrations SET state = :state, decided_by = :by, decided_at = :at, decision_note = :note, updated_at = :at
       WHERE id = :id`,
      { state: to, by: actor.id, at: ctx.at, note: (options.note ?? '').slice(0, 1000), id: registrationId },
    );

    this.audit.record({
      action: 'registration.state_changed',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: before.event_id,
      resourceType: 'registration',
      resourceId: registrationId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      previousState: before.state,
      newState: to,
      metadata: { note: options.note ?? '', override: options.override === true },
      at: ctx.at,
    });

    return this.require(registrationId);
  }

  withdraw(registrationId: string, ctx: ActorContext): RegistrationRow {
    const actor = requireActor(ctx);
    const before = this.require(registrationId);
    if (before.user_id !== actor.id && !canManageEvent(actor as never, before.event_id)) {
      throw errors.forbidden('You can only withdraw your own application.');
    }
    this.transition(registrationId, 'WITHDRAWN', ctx);
    return this.require(registrationId);
  }

  private transition(registrationId: string, to: RegistrationState, ctx: ActorContext): void {
    const before = this.require(registrationId);
    const actor = requireActor(ctx);
    assertTransition<RegistrationState>('Registration', before.state, to, {
      override: false,
      facts: {},
      actor: { id: actor.id, roles: actor.roles },
    });
    this.db.exec('UPDATE registrations SET state = :state, updated_at = :at WHERE id = :id', { state: to, at: ctx.at, id: registrationId });
  }

  /* ----------------------------------------------------------- queries */

  findForUser(eventId: string, userId: string): RegistrationRow | null {
    return this.db.get<RegistrationRow>('SELECT * FROM registrations WHERE event_id = :e AND user_id = :u', {
      e: eventId,
      u: userId,
    });
  }

  findById(id: string): RegistrationRow | null {
    return this.db.get<RegistrationRow>('SELECT * FROM registrations WHERE id = :id', { id });
  }

  require(id: string): RegistrationRow {
    const row = this.findById(id);
    if (row === null) throw errors.notFound('Registration', id);
    return row;
  }

  list(
    eventId: string,
    filter: { state?: RegistrationState; search?: string; track?: string; limit: number; offset: number },
  ): { rows: (RegistrationRow & { display_name: string; email: string; username: string; team_name: string | null })[]; total: number; byState: Record<string, number> } {
    const conditions = ['r.event_id = :e'];
    const params: Record<string, string | number> = { e: eventId, limit: filter.limit, offset: filter.offset };
    if (filter.state) {
      conditions.push('r.state = :state');
      params.state = filter.state;
    }
    if (filter.search) {
      conditions.push(
        "(LOWER(r.full_name) LIKE :search ESCAPE '\\' OR LOWER(u.display_name) LIKE :search ESCAPE '\\' OR u.email_normalized LIKE :search ESCAPE '\\' OR LOWER(r.organization) LIKE :search ESCAPE '\\')",
      );
      params.search = `%${filter.search.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    }
    const clause = `WHERE ${conditions.join(' AND ')}`;

    const total = this.db.value<number>(
      `SELECT COUNT(*) AS c FROM registrations r JOIN users u ON u.id = r.user_id ${clause}`,
      params,
    ) ?? 0;
    const rows = this.db.all<RegistrationRow & { display_name: string; email: string; username: string; team_name: string | null }>(
      `SELECT r.*, u.display_name, u.email, u.username,
              (SELECT t.name FROM teams t JOIN team_members m ON m.team_id = t.id
                WHERE t.event_id = r.event_id AND m.user_id = r.user_id LIMIT 1) AS team_name
       FROM registrations r JOIN users u ON u.id = r.user_id
       ${clause} ORDER BY r.submitted_at DESC LIMIT :limit OFFSET :offset`,
      params,
    );
    const byStateRows = this.db.all<{ state: string; count: number }>(
      'SELECT state, COUNT(*) AS count FROM registrations WHERE event_id = :e GROUP BY state',
      { e: eventId },
    );
    const byState = Object.fromEntries(byStateRows.map((r) => [r.state, Number(r.count)]));
    return { rows, total, byState };
  }

  responses(registrationId: string): Record<string, string | number | boolean | string[] | null> {
    const fields = this.db.all<{ field_key: string; field_type: string; options: string }>(
      'SELECT field_key, field_type, options FROM registration_fields WHERE event_id = (SELECT event_id FROM registrations WHERE id = :r) ORDER BY display_order',
      { r: registrationId },
    );
    const rows = this.db.all<{
      field_key: string; value_text: string; value_number: number | null; value_boolean: number | null; value_json: string | null;
    }>(
      `SELECT f.field_key, r.value_text, r.value_number, r.value_boolean, r.value_json
       FROM registration_responses r JOIN registration_fields f ON f.id = r.field_id
       WHERE r.registration_id = :r`,
      { r: registrationId },
    );
    const out: Record<string, string | number | boolean | string[] | null> = {};
    for (const field of fields) out[field.field_key] = '';
    for (const row of rows) {
      if (row.value_json !== null && row.value_json !== '') {
        try {
          out[row.field_key] = JSON.parse(row.value_json) as string[];
        } catch {
          out[row.field_key] = row.value_text;
        }
      } else if (row.value_boolean !== null) {
        out[row.field_key] = row.value_boolean === 1;
      } else if (row.value_number !== null) {
        out[row.field_key] = row.value_number;
      } else {
        out[row.field_key] = row.value_text;
      }
    }
    return out;
  }

  /* -------------------------------------------------------- bulk / csv */

  /**
   * Bulk decision. Each registration is validated independently so one bad id
   * cannot roll back the whole batch, and every row is audited.
   */
  bulkDecide(
    eventId: string,
    registrationIds: string[],
    to: RegistrationState,
    options: { note?: string; override?: boolean },
    ctx: ActorContext,
  ): { applied: number; failed: { id: string; reason: string }[] } {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const applied: string[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const id of registrationIds) {
      try {
        this.decide(id, to, options, ctx);
        applied.push(id);
      } catch (error) {
        failed.push({ id, reason: error instanceof Error ? error.message : 'unknown error' });
      }
    }

    this.audit.record({
      action: 'registration.bulk_action',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'registration',
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      newState: to,
      metadata: { requested: registrationIds.length, applied: applied.length, failed: failed.length },
      at: ctx.at,
    });

    return { applied: applied.length, failed };
  }

  exportCsv(eventId: string): string {
    const fields = this.listFields(eventId);
    const { rows } = this.list(eventId, { limit: 10_000, offset: 0 });
    return toCsv(rows, [
      { header: 'registration_id', value: (r) => r.id },
      { header: 'user_id', value: (r) => r.user_id },
      { header: 'email', value: (r) => r.email },
      { header: 'username', value: (r) => r.username },
      { header: 'display_name', value: (r) => r.display_name },
      { header: 'state', value: (r) => r.state },
      { header: 'full_name', value: (r) => r.full_name },
      { header: 'organization', value: (r) => r.organization },
      { header: 'skills', value: (r) => r.skills },
      { header: 'github_url', value: (r) => r.github_url },
      { header: 'portfolio_url', value: (r) => r.portfolio_url },
      { header: 'bio', value: (r) => r.bio },
      { header: 'team', value: (r) => r.team_name },
      { header: 'decision_note', value: (r) => r.decision_note },
      { header: 'decided_at', value: (r) => r.decided_at },
      { header: 'submitted_at', value: (r) => r.submitted_at },
      ...fields.map((field) => ({
        header: field.field_key,
        value: (r: (typeof rows)[number]) => this.responses(r.id)[field.field_key] ?? '',
      })),
    ]);
  }

  /**
   * Import participants from CSV.
   *
   * `dryRun` validates and reports without writing, which is the default: a
   * bulk import is exactly the operation where an unreviewed write does the
   * most damage.
   */
  importCsv(
    eventId: string,
    csv: string,
    options: { dryRun?: boolean; createAccounts?: boolean; defaultPassword?: string },
    ctx: ActorContext,
  ): { jobId: string; total: number; applied: number; rejected: number; issues: { row: number; column: string | null; message: string; value: string | null }[] } {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const dryRun = options.dryRun !== false;

    const parsed = parseCsv(csv, { maxColumns: 60 });
    if (parsed.header.length === 0) throw errors.badRequest('That CSV file has no header row.');
    for (const ragged of parsed.raggedRows) {
      throw errors.validation(
        `Row ${String(ragged.row)} has ${String(ragged.actual)} columns but the header has ${String(ragged.expected)}. Fix the file and try again.`,
        [{ field: 'row', issue: `expected ${String(ragged.expected)} columns, found ${String(ragged.actual)}` }],
      );
    }

    const { objects } = rowsToObjects(parsed);
    const issues: { row: number; column: string | null; message: string; value: string | null }[] = [];

    const result = importRows<{ email: string; display_name: string; organization: string; skills: string; github_url: string | null; state: string }>(objects, {
      fields: {
        email: (raw) => {
          if (raw === '') return { error: 'email is required' };
          try {
            return validateEmail(raw);
          } catch (error) {
            return { error: error instanceof Error ? error.message : 'invalid email' };
          }
        },
        display_name: (raw) => raw,
        organization: (raw) => raw,
        skills: (raw) => raw,
        github_url: (raw) => {
          if (raw === '') return null;
          const url = validateHttpUrl(raw, { allowPrivateHosts: true });
          return url.valid ? url.url : { error: url.reason };
        },
        state: (raw) => {
          const value = (raw || 'PENDING').toUpperCase();
          return ['PENDING', 'ACCEPTED', 'REJECTED', 'WAITLISTED'].includes(value)
            ? value
            : { error: `unknown state "${raw}"` };
        },
      },
      onIssue: (issue) => {
        issues.push({ row: issue.row, column: issue.column, message: issue.message, value: issue.value });
      },
    });

    let applied = 0;
    const jobId = newId('importJob');

    if (!dryRun) {
      for (const row of result.rows) {
        const value = row.value;
        const email = value.email as string;
        let user = this.db.get<{ id: string }>('SELECT id FROM users WHERE email_normalized = :e', { e: email });
        if (user === null && options.createAccounts === true) {
          const username = email.split('@')[0]!.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28) || `user${String(row.row)}`;
          const created = this.auth.register(
            {
              email,
              username: uniqueUsername(this.auth, username),
              password: options.defaultPassword ?? 'imported-account-temporary',
              displayName: (value.display_name as string) || username,
              roles: ['PARTICIPANT'],
              eventId,
            },
            { requestId: ctx.requestId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, at: ctx.at },
          );
          user = { id: created.user.id };
        }
        if (user === null) {
          issues.push({ row: row.row, column: 'email', message: 'no account with this email, and account creation was not requested', value: email });
          continue;
        }
        const existing = this.findForUser(eventId, user.id);
        if (existing !== null) {
          this.db.exec(
            `UPDATE registrations SET full_name = :full_name, organization = :organization, skills = :skills,
               github_url = :github, updated_at = :at WHERE id = :id`,
            {
              full_name: (value.display_name as string) ?? '',
              organization: (value.organization as string) ?? '',
              skills: JSON.stringify(splitSkills(value.skills as string)),
              github: (value.github_url as string | null) ?? null,
              at: ctx.at,
              id: existing.id,
            },
          );
        } else {
          this.db.exec(
            `INSERT INTO registrations (id, event_id, user_id, state, full_name, organization, skills, github_url, submitted_at, created_at, updated_at)
             VALUES (:id, :e, :u, :state, :full_name, :organization, :skills, :github, :at, :at, :at)`,
            {
              id: newId('registration'),
              e: eventId,
              u: user.id,
              state: (value.state as string) ?? 'PENDING',
              full_name: (value.display_name as string) ?? '',
              organization: (value.organization as string) ?? '',
              skills: JSON.stringify(splitSkills(value.skills as string)),
              github: (value.github_url as string | null) ?? null,
              at: ctx.at,
            },
          );
        }
        applied += 1;
      }
    }

    this.db.exec(
      `INSERT INTO import_jobs (id, event_id, kind, status, filename, total_rows, applied_rows, rejected_rows, issues, dry_run, created_by, created_at, updated_at, completed_at)
       VALUES (:id, :e, 'PARTICIPANTS', :status, :filename, :total, :applied, :rejected, :issues, :dry, :by, :at, :at, :at)`,
      {
        id: jobId,
        e: eventId,
        status: dryRun ? 'VALIDATED' : applied > 0 ? (issues.length > 0 ? 'PARTIAL' : 'APPLIED') : 'FAILED',
        filename: `participants.csv`,
        total: objects.length,
        applied,
        rejected: issues.length,
        issues: JSON.stringify(issues.slice(0, 500)),
        dry: dryRun ? 1 : 0,
        by: actor.id,
        at: ctx.at,
      },
    );

    this.audit.record({
      action: 'import.executed',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'importJob',
      resourceId: jobId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      metadata: { kind: 'PARTICIPANTS', total: objects.length, applied, rejected: issues.length, dryRun },
      at: ctx.at,
    });

    return { jobId, total: objects.length, applied, rejected: issues.length, issues };
  }

  /* ---------------------------------------------------------- helpers */

  private writeResponses(registrationId: string, responses: Record<string, string | string[] | number | boolean>): void {
    const fields = this.listFields(
      this.require(registrationId).event_id,
    );
    for (const field of fields) {
      const raw = responses[field.field_key];
      if (raw === undefined) continue;
      if (field.required === 1 && (raw === '' || raw === undefined || (Array.isArray(raw) && raw.length === 0))) {
        throw errors.validation(`"${field.label}" is required.`, [{ field: field.field_key, issue: 'required' }]);
      }
      this.writeResponse(registrationId, field, raw);
    }
    for (const key of Object.keys(responses)) {
      if (!fields.some((f) => f.field_key === key)) {
        throw errors.validation(`"${key}" is not a field on this form.`, [{ field: key, issue: 'unknown field' }]);
      }
    }
  }

  private writeResponse(registrationId: string, field: RegistrationFieldRow, raw: string | string[] | number | boolean): void {
    let text = '';
    let numeric: number | null = null;
    let bool: number | null = null;
    let json: string | null = null;

    if (field.field_type === 'checkbox') {
      bool = raw === true || raw === 'true' || raw === '1' || raw === 'yes' ? 1 : 0;
      text = bool === 1 ? 'yes' : 'no';
    } else if (field.field_type === 'number') {
      const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(parsed)) {
        throw errors.validation(`"${field.label}" must be a number.`, [{ field: field.field_key, issue: `"${String(raw)}" is not numeric` }]);
      }
      numeric = parsed;
      text = String(parsed);
    } else if (field.field_type === 'multi_select') {
      const values = Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
      this.assertOptions(field, values);
      json = JSON.stringify(values);
      text = values.join(', ');
    } else if (field.field_type === 'select') {
      const value = String(raw);
      this.assertOptions(field, [value]);
      text = value;
    } else {
      text = validatePlainText(String(raw), { field: field.label, max: 2000 });
    }

    this.db.exec(
      `INSERT INTO registration_responses (id, registration_id, field_id, value_text, value_number, value_boolean, value_json, created_at, updated_at)
       VALUES (:id, :r, :f, :text, :num, :bool, :json, :at, :at)
       ON CONFLICT (registration_id, field_id) DO UPDATE SET
         value_text = excluded.value_text, value_number = excluded.value_number,
         value_boolean = excluded.value_boolean, value_json = excluded.value_json, updated_at = excluded.updated_at`,
      { id: newId('registrationResponse'), r: registrationId, f: field.id, text, num: numeric, bool, json, at: now() },
    );
  }

  private assertOptions(field: RegistrationFieldRow, values: string[]): void {
    let allowed: string[] = [];
    try {
      const parsed: unknown = JSON.parse(field.options);
      if (Array.isArray(parsed)) allowed = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      allowed = [];
    }
    if (allowed.length === 0) return;
    for (const value of values) {
      if (!allowed.includes(value)) {
        throw errors.validation(`"${value}" is not an option for "${field.label}".`, [
          { field: field.field_key, issue: `allowed: ${allowed.join(', ')}` },
        ]);
      }
    }
  }

  private urlOrNull(value: string | null | undefined, field: string): string | null {
    if (value === null || value === undefined || value === '') return null;
    const result = validateHttpUrl(value, { allowPrivateHosts: true });
    if (!result.valid) throw errors.validation('That URL cannot be accepted.', [{ field, issue: result.reason }]);
    return result.url;
  }
}

function slugKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

function splitSkills(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function uniqueUsername(auth: Services['auth'], base: string): string {
  let candidate = base.toLowerCase();
  let n = 1;
  while (auth.findByUsername(candidate) !== null) {
    n += 1;
    candidate = `${base.toLowerCase().slice(0, 24)}${String(n)}`;
  }
  return candidate;
}

export type { Role };

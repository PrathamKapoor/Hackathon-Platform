/**
 * Versioned rubrics.
 *
 * A rubric version is immutable once it is ACTIVE, and locked outright once
 * judging starts. That is the guarantee that makes a published result
 * reproducible a year later: the criteria and their weights cannot have moved
 * under the scores.
 *
 * Weight validation is delegated to `@verdict/core/rubric` so the HTTP layer,
 * the seeder and the result pipeline all enforce the identical rule.
 */

import { newId } from '@verdict/core/ids';
import {
  assertValidRubricVersion,
  validateRubricVersion,
  type RubricCriterion,
  type RubricVersion,
} from '@verdict/core/rubric';
import { validatePlainText } from '@verdict/core/validation';
import { errors } from '../lib/errors.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';

export type RubricVersionRow = {
  id: string;
  rubric_id: string;
  event_id: string;
  version: number;
  status: 'DRAFT' | 'ACTIVE' | 'LOCKED' | 'RETIRED';
  weights_must_sum_to_one: number;
  rounding_precision: number;
  rounding_mode: string;
  tie_break_priority: string;
  judge_guidance: string;
  notes: string;
  activated_at: string | null;
  locked_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type CriterionInput = {
  key?: string;
  name: string;
  description?: string;
  weight: number;
  min: number;
  max: number;
  required?: boolean;
  scoringType?: 'INTEGER' | 'DECIMAL' | 'BOOLEAN';
  publishBreakdown?: boolean;
};

export class RubricService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
  }

  /* ------------------------------------------------------------ create */

  createRubric(
    eventId: string,
    input: { name: string; description?: string; criteria: CriterionInput[]; notes?: string; judgeGuidance?: string },
    ctx: ActorContext,
  ): RubricVersionRow {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);

    const name = validatePlainText(input.name, { field: 'rubric name', min: 2, max: 120 });
    if (event.state === 'JUDGING' || event.state === 'RESULTS_PENDING' || event.state === 'PUBLISHED') {
      throw errors.immutable('The rubric cannot be created once judging has started.');
    }

    const rubricId = newId('rubric');
    this.db.exec(
      'INSERT INTO rubrics (id, event_id, name, description, created_by, created_at, updated_at) VALUES (:id, :e, :name, :desc, :by, :at, :at)',
      {
        id: rubricId,
        e: eventId,
        name,
        desc: validatePlainText(input.description ?? '', { field: 'description', max: 2000 }),
        by: actor.id,
        at: ctx.at,
      },
    );

    const version = this.insertVersion(rubricId, eventId, input, ctx, { activate: true });

    this.audit.record({
      action: 'rubric.created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'rubric',
      resourceId: rubricId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { name, criteria: input.criteria.length, version },
      at: ctx.at,
    });

    return this.requireVersion(version);
  }

  /**
   * Add a new version to an existing rubric. The previous version is retained
   * untouched so historical scores keep their meaning.
   */
  createVersion(
    rubricId: string,
    input: { criteria: CriterionInput[]; notes?: string; judgeGuidance?: string; activate?: boolean },
    ctx: ActorContext,
  ): RubricVersionRow {
    const actor = requireActor(ctx);
    const rubric = this.db.get<{ id: string; event_id: string; name: string }>(
      'SELECT id, event_id, name FROM rubrics WHERE id = :id',
      { id: rubricId },
    );
    if (rubric === null) throw errors.notFound('Rubric', rubricId);
    const event = this.events.require(rubric.event_id);
    this.events.assertOrganizer(actor, event, ctx);
    this.assertMutable(rubric.event_id, ctx);

    const latest = this.latestVersion(rubricId);
    if (latest !== null && (latest.status === 'LOCKED' || latest.status === 'ACTIVE')) {
      // Supersede the active version rather than mutating it.
      this.db.exec("UPDATE rubric_versions SET status = 'RETIRED', updated_at = :at WHERE id = :id", { at: ctx.at, id: latest.id });
    }

    const versionId = this.insertVersion(rubricId, rubric.event_id, { ...input, name: rubric.name }, ctx, {
      activate: input.activate !== false,
    });

    this.audit.record({
      action: 'rubric.version_created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: rubric.event_id,
      resourceType: 'rubricVersion',
      resourceId: versionId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      metadata: { rubricId, version: this.requireVersion(versionId).version, criteria: input.criteria.length },
      at: ctx.at,
    });

    return this.requireVersion(versionId);
  }

  private insertVersion(
    rubricId: string,
    eventId: string,
    input: { name?: string; criteria: CriterionInput[]; notes?: string; judgeGuidance?: string },
    ctx: ActorContext,
    options: { activate: boolean },
  ): string {
    const actor = requireActor(ctx);
    const nextVersion =
      (this.db.value<number>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM rubric_versions WHERE rubric_id = :r', { r: rubricId }) ?? 1) as number;
    const versionId = newId('rubricVersion');

    const criteria: RubricCriterion[] = input.criteria.map((criterion, index) => ({
      id: newId('rubricCriterion'),
      key: (criterion.key ?? slugKey(criterion.name)).toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      name: validatePlainText(criterion.name, { field: `criterion ${String(index + 1)} name`, min: 1, max: 120 }),
      description: validatePlainText(criterion.description ?? '', { field: 'description', max: 2000 }),
      weight: criterion.weight,
      min: criterion.min,
      max: criterion.max,
      required: criterion.required !== false,
      scoringType: criterion.scoringType ?? 'DECIMAL',
      order: index,
      publishBreakdown: criterion.publishBreakdown !== false,
    }));

    // Validate through the domain before touching the database, so an invalid
    // rubric never gets half-written.
    const candidate: RubricVersion = {
      id: versionId,
      rubricId,
      version: nextVersion,
      status: options.activate ? 'ACTIVE' : 'DRAFT',
      criteria,
      weightsMustSumToOne: true,
      rounding: { precision: 4, mode: 'HALF_UP' },
      tieBreakPriority: [],
      notes: input.notes ?? '',
    };
    const issues = validateRubricVersion(candidate);
    if (issues.length > 0) {
      throw errors.validation('That rubric is not valid.', issues.map((issue) => ({ field: 'criteria', issue })));
    }

    this.db.transaction(() => {
      this.db.exec(
        `INSERT INTO rubric_versions (
           id, rubric_id, event_id, version, status, weights_must_sum_to_one, rounding_precision,
           rounding_mode, tie_break_priority, judge_guidance, notes, activated_at, created_by, created_at, updated_at
         ) VALUES (
           :id, :rubric_id, :e, :version, :status, 1, 4, 'HALF_UP', '[]', :guidance, :notes, :activated, :by, :at, :at
         )`,
        {
          id: versionId,
          rubric_id: rubricId,
          e: eventId,
          version: nextVersion,
          status: options.activate ? 'ACTIVE' : 'DRAFT',
          guidance: validatePlainText(input.judgeGuidance ?? '', { field: 'judgeGuidance', max: 4000 }),
          notes: validatePlainText(input.notes ?? '', { field: 'notes', max: 2000 }),
          activated: options.activate ? ctx.at : null,
          by: actor.id,
          at: ctx.at,
        },
      );

      for (const criterion of criteria) {
        this.db.exec(
          `INSERT INTO rubric_criteria (
             id, rubric_version_id, field_key, name, description, weight, min_value, max_value,
             required, scoring_type, display_order, publish_breakdown, created_at, updated_at
           ) VALUES (
             :id, :version, :key, :name, :desc, :weight, :min, :max,
             :required, :type, :order, :publish, :at, :at
           )`,
          {
            id: criterion.id,
            version: versionId,
            key: criterion.key,
            name: criterion.name,
            desc: criterion.description,
            weight: criterion.weight,
            min: criterion.min,
            max: criterion.max,
            required: criterion.required ? 1 : 0,
            type: criterion.scoringType,
            order: criterion.order,
            publish: criterion.publishBreakdown ? 1 : 0,
            at: ctx.at,
          },
        );
      }
    });

    return versionId;
  }

  /* ----------------------------------------------------------- update */

  updateVersion(
    versionId: string,
    input: { notes?: string; judgeGuidance?: string; tieBreakPriority?: string[] },
    ctx: ActorContext,
  ): RubricVersionRow {
    const actor = requireActor(ctx);
    const version = this.requireVersion(versionId);
    this.events.assertOrganizer(actor, this.events.require(version.event_id), ctx);
    this.assertMutable(version.event_id, ctx);

    const patch: Record<string, string> = { updated_at: ctx.at };
    if (input.notes !== undefined) patch.notes = validatePlainText(input.notes, { field: 'notes', max: 2000 });
    if (input.judgeGuidance !== undefined) patch.judge_guidance = validatePlainText(input.judgeGuidance, { field: 'judgeGuidance', max: 4000 });
    if (input.tieBreakPriority !== undefined) {
      const keys = new Set(this.criteria(versionId).map((c) => c.key));
      const unknown = input.tieBreakPriority.filter((key) => !keys.has(key));
      if (unknown.length > 0) {
        throw errors.validation('Tie-break priority references unknown criteria.', unknown.map((issue) => ({ field: 'tieBreakPriority', issue })));
      }
      patch.tie_break_priority = JSON.stringify(input.tieBreakPriority);
    }
    const assignments = Object.keys(patch).map((key) => `"${key}" = :${key}`);
    this.db.exec(`UPDATE rubric_versions SET ${assignments.join(', ')} WHERE id = :id`, { ...patch, id: versionId });
    return this.requireVersion(versionId);
  }

  /** Freeze the active version. Judging start does this automatically. */
  lock(versionId: string, ctx: ActorContext): RubricVersionRow {
    const actor = requireActor(ctx);
    const version = this.requireVersion(versionId);
    this.events.assertOrganizer(actor, this.events.require(version.event_id), ctx);

    this.db.exec("UPDATE rubric_versions SET status = 'LOCKED', locked_at = :at, updated_at = :at WHERE id = :id", {
      at: ctx.at,
      id: versionId,
    });
    this.audit.record({
      action: 'rubric.locked',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: version.event_id,
      resourceType: 'rubricVersion',
      resourceId: versionId,
      requestId: ctx.requestId,
      previousState: version.status,
      newState: 'LOCKED',
      at: ctx.at,
    });
    return this.requireVersion(versionId);
  }

  /* ---------------------------------------------------------- queries */

  listRubrics(eventId: string) {
    return this.db.all(
      `SELECT r.*, (SELECT COUNT(*) FROM rubric_versions v WHERE v.rubric_id = r.id) AS version_count,
              (SELECT v.id FROM rubric_versions v WHERE v.rubric_id = r.id AND v.status IN ('ACTIVE','LOCKED') ORDER BY v.version DESC LIMIT 1) AS active_version_id
       FROM rubrics r WHERE r.event_id = :e ORDER BY r.name`,
      { e: eventId },
    );
  }

  listVersions(rubricId: string): RubricVersionRow[] {
    return this.db.all<RubricVersionRow>('SELECT * FROM rubric_versions WHERE rubric_id = :r ORDER BY version DESC', { r: rubricId });
  }

  /** The version judges must currently use. */
  activeVersion(eventId: string): RubricVersionRow | null {
    return this.db.get<RubricVersionRow>(
      `SELECT * FROM rubric_versions WHERE event_id = :e AND status IN ('ACTIVE','LOCKED')
       ORDER BY (status = 'LOCKED') DESC, version DESC LIMIT 1`,
      { e: eventId },
    );
  }

  requireActiveVersion(eventId: string): RubricVersionRow {
    const version = this.activeVersion(eventId);
    if (version === null) {
      throw errors.preconditionFailed('No rubric is active for this event. Create and activate one before judging.', [
        { field: 'rubric', issue: 'no active rubric version' },
      ]);
    }
    return version;
  }

  latestVersion(rubricId: string): RubricVersionRow | null {
    return this.db.get<RubricVersionRow>('SELECT * FROM rubric_versions WHERE rubric_id = :r ORDER BY version DESC LIMIT 1', {
      r: rubricId,
    });
  }

  findVersion(id: string): RubricVersionRow | null {
    return this.db.get<RubricVersionRow>('SELECT * FROM rubric_versions WHERE id = :id', { id });
  }

  requireVersion(id: string): RubricVersionRow {
    const row = this.findVersion(id);
    if (row === null) throw errors.notFound('Rubric version', id);
    return row;
  }

  criteria(versionId: string): RubricCriterion[] {
    const rows = this.db.all<{
      id: string; field_key: string; name: string; description: string; weight: number;
      min_value: number; max_value: number; required: number; scoring_type: 'INTEGER' | 'DECIMAL' | 'BOOLEAN';
      display_order: number; publish_breakdown: number;
    }>('SELECT * FROM rubric_criteria WHERE rubric_version_id = :v ORDER BY display_order, name', { v: versionId });

    return rows.map((row) => ({
      id: row.id,
      key: row.field_key,
      name: row.name,
      description: row.description,
      weight: Number(row.weight),
      min: Number(row.min_value),
      max: Number(row.max_value),
      required: row.required === 1,
      scoringType: row.scoring_type,
      order: Number(row.display_order),
      publishBreakdown: row.publish_breakdown === 1,
    }));
  }

  /** Hydrate the domain object the scoring engine consumes. */
  toDomain(row: RubricVersionRow): RubricVersion {
    const criteria = this.criteria(row.id);
    const version: RubricVersion = {
      id: row.id,
      rubricId: row.rubric_id,
      version: Number(row.version),
      status: row.status,
      criteria,
      weightsMustSumToOne: row.weights_must_sum_to_one === 1,
      rounding: { precision: Number(row.rounding_precision), mode: 'HALF_UP' },
      tieBreakPriority: safeArray(row.tie_break_priority),
      notes: row.notes,
    };
    assertValidRubricVersion(version);
    return version;
  }

  /** Public shape for the judge scoring form. */
  toPublicView(row: RubricVersionRow, includeGuidance = true) {
    return {
      id: row.id,
      version: Number(row.version),
      status: row.status,
      rounding: { precision: Number(row.rounding_precision) },
      judgeGuidance: includeGuidance ? row.judge_guidance : undefined,
      criteria: this.criteria(row.id).map((criterion) => ({
        id: criterion.id,
        key: criterion.key,
        name: criterion.name,
        description: criterion.description,
        weight: criterion.weight,
        min: criterion.min,
        max: criterion.max,
        required: criterion.required,
        scoringType: criterion.scoringType,
        order: criterion.order,
      })),
    };
  }

  private assertMutable(eventId: string, ctx: ActorContext): void {
    const event = this.events.require(eventId);
    if (event.state === 'JUDGING') {
      this.lockIfActive(eventId, ctx.at);
      throw errors.immutable(
        'Judging has started, so the active rubric version is now locked. Create a new version if you need to change the criteria — existing scores keep their original meaning.',
      );
    }
    if (event.state === 'RESULTS_PENDING' || event.state === 'PUBLISHED' || event.state === 'ARCHIVED') {
      throw errors.immutable(`The rubric cannot be changed while the event is ${event.state.toLowerCase().replace('_', ' ')}.`);
    }
  }

  /** Called when judging opens: freeze whatever version is active. */
  lockIfActive(eventId: string, at: string): string | null {
    const version = this.activeVersion(eventId);
    if (version === null || version.status === 'LOCKED') return version?.id ?? null;
    this.db.exec("UPDATE rubric_versions SET status = 'LOCKED', locked_at = :at, updated_at = :at WHERE id = :id", { at, id: version.id });
    return version.id;
  }
}

function slugKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

function safeArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

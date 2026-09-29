/**
 * The result pipeline as a service: normalization runs, judge diagnostics,
 * anomaly flags, result runs, immutable snapshots, publication and reproduction.
 *
 * This service is a thin, honest adapter. All of the mathematics lives in
 * `@verdict/core`, which is pure and independently tested. What this file owns
 * is everything the core deliberately does not: reading the current state out of
 * the database, persisting a run with its provenance, enforcing immutability,
 * and refusing to publish something that would not reproduce.
 */

import { newId } from '@verdict/core/ids';
import {
  computeResultRun,
  verifyResultRun,
  type JudgeReviewInput,
  type ResultRun,
  type ResultRunInput,
} from '@verdict/core/result-pipeline';
import {
  DEFAULT_AGGREGATION_CONFIG,
  type AggregationConfig,
  type AggregationMethod,
  type Prize,
} from '@verdict/core/aggregation';
import { configForMethod, type NormalizationConfig, type NormalizationMethod } from '@verdict/core/normalization';
import type { RubricVersion } from '@verdict/core/rubric';
import { computeDiagnostics, type ReviewRecord } from '@verdict/core/diagnostics';
import { canonicalJson, contentHash, sha256Hex, verificationCode } from '@verdict/core/integrity';
import type { PairwiseComparison } from '@verdict/core/pairwise';
import { isOneOf, type AnomalySeverity, type AnomalyStatus, type NormalizationMethod as Method } from '@verdict/core/types';
import { errors } from '../lib/errors.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';
import { safeJson } from './submission-service.ts';

export type SnapshotRow = {
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

export type RunRow = {
  id: string;
  event_id: string;
  rubric_version_id: string;
  assignment_version: number;
  normalization_run_id: string | null;
  engine_version: string;
  config: string;
  input_hash: string;
  integrity_hash: string;
  provenance: string;
  pairwise: string | null;
  warnings: string;
  notes: string;
  computed_by: string;
  computed_at: string;
};

export class ResultService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];
  private readonly rubrics: Services['rubrics'];
  private readonly assignments: Services['assignments'];
  /** Held for its `webhooks` entry; see the note in `finalize`. */
  private readonly services: Services;

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
    this.rubrics = services.rubrics;
    this.assignments = services.assignments;
    this.services = services;
  }

  /* =================================================== the computation */

  /**
   * Read the current judged state and run the pipeline over it.
   *
   * Pure with respect to the database. The same call with the same data always
   * produces the same `integrityHash`, which is what makes `reproduce()` below
   * meaningful.
   */
  compute(
    eventId: string,
    options: {
      normalization?: Partial<NormalizationConfig>;
      aggregation?: Partial<AggregationConfig>;
      enablePairwise?: boolean;
      notes?: string;
    },
    ctx: ActorContext,
  ): ResultRun {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);

    const rubricRow = this.rubrics.requireActiveVersion(eventId);
    const domain = this.rubrics.toDomain(rubricRow);
    const assignmentVersion = this.assignments.currentVersion(eventId);

    const reviews = this.collectReviews(eventId, rubricRow.id);
    const projectMeta = this.collectProjectMeta(eventId);
    const prizes = this.collectPrizes(eventId);
    const criterionSlices = this.collectCriterionSlices(eventId);
    const comparisons = options.enablePairwise === true ? this.collectComparisons(eventId) : [];

    const input: ResultRunInput = {
      eventId,
      rubricVersion: domain,
      assignmentVersion,
      reviews,
      projectMeta,
      prizes,
      normalization: configForMethod(
        (options.normalization?.method ?? 'RAW') as NormalizationMethod,
        options.normalization ?? {},
      ),
      aggregation: { ...DEFAULT_AGGREGATION_CONFIG, ...(options.aggregation ?? {}) },
      criterionSlices,
      ...(comparisons.length > 0 ? { pairwise: { enabled: true, comparisons } } : {}),
      computedAt: ctx.at,
      runId: newId('resultRun'),
      actorId: actor.id,
      notes: options.notes ?? '',
    };

    const run = computeResultRun(input);

    /*
     * The per-judge score the pipeline ranks on is `scores.raw_score`, and the
     * per-criterion breakdown published alongside it comes from
     * `criterion_scores.value`. The application writes both from a single
     * `evaluateReview` call, so they cannot disagree through the API — but
     * nothing *checks* that, and a restore from backup, a manual fix, or a
     * future code path could leave them inconsistent.
     *
     * When they disagree the ranking still follows `raw_score`, because that is
     * the value that was actually stored and verified. The run therefore
     * records a warning naming the affected reviews rather than silently
     * publishing a breakdown that does not add up to the published score.
     */
    const drifted = this.findCriterionDrift(reviews, domain);
    if (drifted.length > 0) {
      const worst = drifted[0] as { gap: number; reviewLabel: string };
      run.diagnostics.warnings.push(
        `${drifted.length} review(s) have a per-criterion breakdown that does not reconcile with the stored score ` +
          `(largest gap ${worst.gap.toFixed(4)} points on ${worst.reviewLabel}). The ranking follows the stored ` +
          'score. Re-submit those reviews to bring the published breakdown back in line with it.',
      );
    }

    return run;
  }

  /**
   * Reviews whose weighted criterion values disagree with the stored
   * aggregate, worst first.
   */
  private findCriterionDrift(
    reviews: JudgeReviewInput[],
    domain: RubricVersion,
  ): { reviewLabel: string; gap: number }[] {
    const byId = new Map(domain.criteria.map((criterion) => [criterion.id, criterion]));
    const out: { reviewLabel: string; gap: number }[] = [];

    for (const review of reviews) {
      let weighted = 0;
      let weightUsed = 0;
      for (const criterion of review.evaluation.criteria) {
        const known = byId.get(criterion.criterionId);
        if (known === undefined) continue;
        const span = known.max - known.min;
        if (span <= 0) continue;
        const normalised = (criterion.rawValue - known.min) / span;
        weighted += normalised * known.weight;
        weightUsed += known.weight;
      }
      if (weightUsed === 0) continue;
      const derived = weighted * 100;
      const gap = Math.abs(derived - review.rawScore);
      // A hundredth of a point is well inside the rounding the engine applies
      // when it stores a score, so anything larger is a real disagreement.
      if (gap > 0.01) {
        out.push({ reviewLabel: `judge ${review.judgeId} on project ${review.projectId}`, gap });
      }
    }
    return out.sort((a, b) => b.gap - a.gap);
  }

  /** Persist a computed run. Returns the stored row. */
  finalize(
    eventId: string,
    run: ResultRun,
    options: { persistNormalization?: boolean },
    ctx: ActorContext,
  ): RunRow {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);

    let normalizationRunId: string | null = null;
    if (options.persistNormalization !== false) {
      normalizationRunId = this.persistNormalizationRun(eventId, run, ctx);
    }

    this.db.exec(
      `INSERT INTO result_runs (
         id, event_id, rubric_version_id, assignment_version, normalization_run_id, engine_version,
         config, input_hash, integrity_hash, provenance, pairwise, warnings, notes, computed_by, computed_at
       ) VALUES (
         :id, :e, :rv, :av, :nr, :engine,
         :config, :input_hash, :integrity, :provenance, :pairwise, :warnings, :notes, :by, :at
       )`,
      {
        id: run.id,
        e: eventId,
        rv: run.rubricVersionId,
        av: run.assignmentVersion,
        nr: normalizationRunId,
        engine: run.engineVersion,
        config: canonicalJson({ normalization: run.normalization.config, aggregation: run.aggregation.config }),
        input_hash: run.provenance.inputHash,
        integrity: run.integrityHash,
        provenance: canonicalJson(run.provenance),
        pairwise: run.pairwise ? canonicalJson(run.pairwise) : null,
        warnings: JSON.stringify(run.diagnostics.warnings),
        notes: run.provenance.notes,
        by: actor.id,
        at: ctx.at,
      },
    );

    // The run's entries are stored here, not at publication time. A run has to
    // be rehydratable and verifiable on its own: a correction re-publishes an
    // existing run rather than recomputing it, and `verify` runs against runs
    // that were never published at all.
    for (const entry of run.entries) {
      this.db.exec(
        `INSERT INTO result_run_entries (
           id, result_run_id, submission_id, rank, tie_group, aggregate_score, raw_aggregate,
           rank_raw, rank_delta, judge_count, assigned_judges, coverage, validation, track_id,
           pairwise_rank, prizes, criteria, notes, review_hashes
         ) VALUES (
           :id, :run, :submission, :rank, :tie_group, :aggregate, :raw,
           :rank_raw, :rank_delta, :judge_count, :assigned, :coverage, :validation, :track,
           :pairwise, :prizes, :criteria, :notes, :hashes
         )`,
        {
          id: newId('resultRunEntry'),
          run: run.id,
          submission: entry.projectId,
          rank: Number(entry.rank),
          tie_group: Number(entry.tieGroup),
          aggregate: entry.aggregateScore,
          raw: entry.rawAggregate,
          rank_raw: entry.rankRaw,
          rank_delta: entry.rankDelta,
          judge_count: Number(entry.judgeCount),
          assigned: Number(entry.assignedJudges),
          coverage: entry.coverage,
          validation: entry.validation,
          track: entry.trackId,
          pairwise: entry.pairwiseRank,
          prizes: JSON.stringify(entry.prizes),
          criteria: JSON.stringify(entry.criteria),
          notes: JSON.stringify(entry.notes),
          hashes: JSON.stringify(entry.integrity.reviewHashes),
        },
      );
    }

    this.audit.record({
      action: 'results.finalized',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'resultRun',
      resourceId: run.id,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: {
        entries: run.entries.length,
        prizes: run.prizes.length,
        normalization: run.normalization.method,
        aggregation: run.aggregation.method,
        assignmentVersion: run.assignmentVersion,
        integrityHash: run.integrityHash,
        warnings: run.diagnostics.warnings,
        confidence: run.diagnostics.confidence,
      },
      at: ctx.at,
    });

    /*
     * The integrity hash and the shape of the run, not the standings. A
     * hundred-project board is a body no receiver needs, and the hash is the
     * part worth having: a receiver can pin it and prove later that the result
     * it saw is the one this run produced.
     */
    this.services.webhooks.dispatch(
      eventId,
      'results.finalized',
      {
        runId: run.id,
        rubricVersionId: run.rubricVersionId,
        assignmentVersion: run.assignmentVersion,
        engineVersion: run.engineVersion,
        inputHash: run.provenance.inputHash,
        integrityHash: run.integrityHash,
        entries: run.entries.length,
        prizes: run.prizes.length,
        normalization: run.normalization.method,
        aggregation: run.aggregation.method,
        confidence: run.diagnostics.confidence,
        warnings: run.diagnostics.warnings.length,
      },
      ctx,
    );

    return this.requireRun(run.id);
  }

  /**
   * Freeze a run as a snapshot. Snapshots are immutable and sequenced; a
   * correction creates a new snapshot that supersedes the old one rather than
   * rewriting it.
   */
  createSnapshot(eventId: string, runId: string, options: { correctionReason?: string; supersedesId?: string } = {}, ctx: ActorContext): SnapshotRow {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);

    const run = this.requireRun(runId);
    if (run.event_id !== eventId) throw errors.badRequest('That result run belongs to a different event.');

    // Refuse to snapshot an empty result: publishing "no projects" is never the
    // outcome anyone wanted, and catching it here is cheaper than explaining it later.
    const submitted = run.provenance.includes(`"reviewCount":0`) || /"reviewCount":\s*0/.test(run.provenance);
    if (submitted) {
      throw errors.preconditionFailed('There are no submitted reviews, so there is nothing to finalize. Assign judges and collect scores first.', [
        { field: 'reviews', issue: 'reviewCount is 0' },
      ]);
    }

    const sequence = (this.db.value<number>('SELECT COALESCE(MAX(sequence), 0) + 1 AS s FROM result_snapshots WHERE event_id = :e', { e: eventId }) ?? 1) as number;
    const id = newId('resultSnapshot');
    const isCorrection = options.supersedesId !== undefined;

    this.db.transaction(() => {
      this.db.exec(
        `INSERT INTO result_snapshots (id, event_id, result_run_id, sequence, is_published, is_correction, supersedes_id, correction_reason, integrity_hash, entry_count, created_at)
         VALUES (:id, :e, :run, :seq, 0, :correction, :supersedes, :reason, :integrity, :count, :at)`,
        {
          id,
          e: eventId,
          run: runId,
          seq: sequence,
          correction: isCorrection ? 1 : 0,
          supersedes: options.supersedesId ?? null,
          reason: (options.correctionReason ?? '').slice(0, 1000),
          integrity: run.integrity_hash,
          count: this.runEntries(runId).length,
          at: ctx.at,
        },
      );

      for (const entry of this.runEntries(runId)) {
        this.db.exec(
          `INSERT INTO result_entries (
             id, snapshot_id, submission_id, rank, tie_group, aggregate_score, raw_aggregate,
             rank_raw, rank_delta, judge_count, assigned_judges, coverage, validation, track_id,
             pairwise_rank, prizes, criteria, notes, review_hashes
           ) VALUES (
             :id, :snapshot, :submission, :rank, :tie_group, :aggregate, :raw,
             :rank_raw, :rank_delta, :judge_count, :assigned, :coverage, :validation, :track,
             :pairwise, :prizes, :criteria, :notes, :hashes
           )`,
          {
            id: newId('resultEntry'),
            snapshot: id,
            submission: entry.submission_id,
            rank: Number(entry.rank),
            tie_group: Number(entry.tie_group),
            aggregate: entry.aggregate_score,
            raw: entry.raw_aggregate,
            rank_raw: entry.rank_raw,
            rank_delta: entry.rank_delta,
            judge_count: Number(entry.judge_count),
            assigned: Number(entry.assigned_judges),
            coverage: entry.coverage,
            validation: entry.validation,
            track: entry.track_id,
            pairwise: entry.pairwise_rank,
            prizes: JSON.stringify(parseArray(entry.prizes)),
            criteria: JSON.stringify(parseArray(entry.criteria)),
            notes: JSON.stringify(parseArray(entry.notes)),
            hashes: JSON.stringify(parseArray(entry.review_hashes)),
          },
        );
      }

      this.audit.record({
        action: isCorrection ? 'result.corrected' : 'results.finalized',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId,
        resourceType: 'resultSnapshot',
        resourceId: id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        metadata: { runId, sequence, entries: entryCountOf(this.runEntries(runId)), integrityHash: run.integrity_hash, correctionReason: options.correctionReason ?? null },
        at: ctx.at,
      });
    });

    return this.requireSnapshot(id);
  }

  /**
   * Publish a snapshot. This is the point of no return: the database refuses to
   * modify a published snapshot's hash, entries, or deletion afterwards.
   */
  publish(eventId: string, snapshotId: string, ctx: ActorContext & { override?: boolean }): SnapshotRow {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);

    const snapshot = this.requireSnapshot(snapshotId);
    if (snapshot.is_published === 1) {
      throw errors.conflict('That snapshot is already published.');
    }

    /*
     * Results are hidden while voting is open, and this is where that is
     * enforced.
     *
     * Vote *totals* were already hidden properly: the gallery omits the key
     * entirely when the event hides them, rather than sending a count and
     * trusting the client not to render it. But the *ranking* had no such guard.
     * An organizer could compute, snapshot and publish with the voting window
     * still open, and the leaderboard - the thing people are voting on - went
     * public mid-vote. Nothing stopped it, and the requirement is not an
     * organiser's good intentions.
     *
     * Only enforced when voting is actually enabled, and escapable with an
     * explicit `override` that is written to the audit ledger with the same
     * shape as every other override in the system. An organizer who has closed
     * voting early by hand and needs to publish should not be locked out of
     * their own event; an organizer who publishes over a live vote should have
     * to say so in writing.
     */
    if (event.voting_enabled === 1) {
      const voting = this.events.window(event, 'voting', ctx.at);
      if (voting.open && ctx.override !== true) {
        this.audit.record({
          action: 'results.published',
          actorId: actor.id,
          actorRoles: actor.roles,
          eventId,
          resourceType: 'resultSnapshot',
          resourceId: snapshotId,
          requestId: ctx.requestId,
          outcome: 'DENIED',
          metadata: { reason: 'voting window still open', votingOpensAt: voting.opensAt, votingClosesAt: voting.closesAt },
          at: ctx.at,
        });
        throw errors.preconditionFailed(
          `Community voting for "${event.name}" is still open${voting.closesAt === null ? '' : ` until ${voting.closesAt}`}, so the result cannot be published. ` +
            'Close voting first, or re-send with override and a reason - either way it will be recorded in the audit ledger.',
        );
      }
    }

    // Recompute before publishing. Publishing a result that no longer
    // reproduces from the stored scores would be indefensible, so we refuse.
    const verification = this.verify(snapshotId, ctx);
    if (verification.status !== 'MATCH') {
      this.audit.record({
        action: 'results.published',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId,
        resourceType: 'resultSnapshot',
        resourceId: snapshotId,
        requestId: ctx.requestId,
        outcome: 'DENIED',
        metadata: { reason: 'reproduction failed', differences: verification.differences.length },
        at: ctx.at,
      });
      throw errors.preconditionFailed(
        `This snapshot does not reproduce from the stored scores, so it will not be published. ${verification.explanation}`,
        verification.differences.slice(0, 10).map((d) => ({ field: d.projectId ?? d.field, issue: `${d.field}: stored ${String(d.stored)} vs recomputed ${String(d.recomputed)}` })),
      );
    }

    this.db.transaction(() => {
      this.db.exec(
        'UPDATE result_snapshots SET is_published = 1, published_at = :at, published_by = :by WHERE id = :id',
        { at: ctx.at, by: actor.id, id: snapshotId },
      );
      this.db.exec('UPDATE events SET results_published_at = :at, updated_at = :at WHERE id = :e', { at: ctx.at, e: eventId });

      this.audit.record({
        action: 'results.published',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId,
        resourceType: 'resultSnapshot',
        resourceId: snapshotId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        newState: 'PUBLISHED',
        metadata: {
          integrityHash: snapshot.integrity_hash,
          entryCount: snapshot.entry_count,
          verification: 'MATCH',
          reference: verificationCode(snapshot.integrity_hash, 2, 5),
        },
        at: ctx.at,
      });
    });

    // The snapshot row carries no rubric or assignment version; both live on the
    // run it froze, and a receiver pinning "this is the result for rubric v3,
    // assignment v5" needs them.
    const publishedRun = this.requireRun(snapshot.result_run_id);
    this.services.webhooks.dispatch(
      eventId,
      'results.published',
      {
        snapshotId,
        runId: snapshot.result_run_id,
        integrityHash: snapshot.integrity_hash,
        entryCount: snapshot.entry_count,
        reference: verificationCode(snapshot.integrity_hash, 2, 5),
        rubricVersionId: publishedRun.rubric_version_id,
        assignmentVersion: publishedRun.assignment_version,
        isCorrection: snapshot.is_correction === 1,
        supersedesId: snapshot.supersedes_id,
      },
      ctx,
    );

    return this.requireSnapshot(snapshotId);
  }

  /**
   * Recompute a stored snapshot from the database and compare.
   *
   * This is the operation an auditor runs. It is exposed in the API, wired to
   * the acceptance suite, and the publish path calls it too.
   */
  verify(snapshotId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const snapshot = this.requireSnapshot(snapshotId);
    this.events.assertOrganizer(actor, this.events.require(snapshot.event_id), ctx);

    const stored = this.rehydrateRun(this.requireRun(snapshot.result_run_id));
    const recomputed = this.recompute(snapshot.result_run_id, ctx);
    return verifyResultRun(stored, recomputed, ctx.at);
  }

  /** Public reproduction endpoint: no organizer role required. */
  verifyPublic(eventId: string, snapshotId: string, at: string) {
    const snapshot = this.requireSnapshot(snapshotId);
    if (snapshot.event_id !== eventId) throw errors.notFound('Result snapshot', snapshotId);
    if (snapshot.is_published !== 1) {
      throw errors.notFound('Published result snapshot', snapshotId);
    }
    const stored = this.rehydrateRun(this.requireRun(snapshot.result_run_id));
    const recomputed = computeResultRun(this.buildInput(snapshot.result_run_id, at));
    return {
      status: verifyResultRun(stored, recomputed, at).status,
      integrityHash: snapshot.integrity_hash,
      reference: verificationCode(snapshot.integrity_hash, 2, 5),
      publishedAt: snapshot.published_at,
      entryCount: snapshot.entry_count,
    };
  }

  private recompute(runId: string, ctx: ActorContext): ResultRun {
    // Reading the run first turns a deleted run into a 404 rather than an
    // empty recomputation that would report a spurious MISMATCH.
    this.requireRun(runId);
    return computeResultRun(this.buildInput(runId, ctx.at));
  }

  /** Rebuild the exact inputs a stored run was computed from. */
  private buildInput(runId: string, at: string): ResultRunInput {
    const row = this.requireRun(runId);
    const config = parseJson<{ normalization: NormalizationConfig; aggregation: AggregationConfig }>(row.config);
    const rubricRow = this.rubrics.requireVersion(row.rubric_version_id);

    return {
      eventId: row.event_id,
      rubricVersion: this.rubrics.toDomain(rubricRow),
      assignmentVersion: Number(row.assignment_version),
      reviews: this.collectReviews(row.event_id, row.rubric_version_id),
      projectMeta: this.collectProjectMeta(row.event_id),
      prizes: this.collectPrizes(row.event_id),
      normalization: config?.normalization ?? configForMethod('RAW'),
      aggregation: config?.aggregation ?? DEFAULT_AGGREGATION_CONFIG,
      criterionSlices: this.collectCriterionSlices(row.event_id),
      ...(row.pairwise ? { pairwise: { enabled: true, comparisons: this.collectComparisons(row.event_id) } } : {}),
      computedAt: at,
      runId: row.id,
      actorId: row.computed_by,
      notes: row.notes,
    };
  }

  private rehydrateRun(row: RunRow): ResultRun {
    const provenance = parseJson<ResultRun['provenance']>(row.provenance) as ResultRun['provenance'];
    const config = parseJson<{ normalization: NormalizationConfig; aggregation: AggregationConfig }>(row.config);
    const entries = this.db
      .all<{
        rank: number; tie_group: number; submission_id: string; aggregate_score: number | null; raw_aggregate: number | null;
        rank_raw: number | null; rank_delta: number | null; judge_count: number; assigned_judges: number; coverage: number | null;
        validation: string; track_id: string | null; pairwise_rank: number | null; prizes: string; criteria: string; notes: string; review_hashes: string;
      }>('SELECT * FROM result_entries WHERE snapshot_id IN (SELECT id FROM result_snapshots WHERE result_run_id = :r) ORDER BY rank', { r: row.id })
      .map((entry) => ({
        rank: Number(entry.rank),
        tieGroup: Number(entry.tie_group),
        projectId: entry.submission_id,
        aggregateScore: entry.aggregate_score,
        rawAggregate: entry.raw_aggregate,
        rankRaw: entry.rank_raw,
        rankDelta: entry.rank_delta,
        judgeCount: Number(entry.judge_count),
        assignedJudges: Number(entry.assigned_judges),
        coverage: entry.coverage,
        validation: entry.validation as ResultRun['entries'][number]['validation'],
        trackId: entry.track_id,
        pairwiseRank: entry.pairwise_rank,
        prizes: parseArray(entry.prizes),
        criteria: parseJson<ResultRun['entries'][number]['criteria']>(entry.criteria) ?? [],
        notes: parseArray(entry.notes),
        integrity: { reviewHashes: parseArray(entry.review_hashes) },
      }));

    const normalizationRun = row.normalization_run_id
      ? this.db.get<{ result: string }>('SELECT result FROM normalization_runs WHERE id = :id', { id: row.normalization_run_id })
      : null;

    return {
      id: row.id,
      eventId: row.event_id,
      engineVersion: row.engine_version,
      rubricVersionId: row.rubric_version_id,
      rubricVersionNumber: this.rubrics.requireVersion(row.rubric_version_id).version,
      assignmentVersion: Number(row.assignment_version),
      normalization: {
        method: (config?.normalization.method ?? 'RAW') as NormalizationMethod,
        config: config?.normalization ?? configForMethod('RAW'),
        run: (parseJson(normalizationRun?.result ?? null) ?? { scores: [], judgeStats: [], warnings: [] }) as ResultRun['normalization']['run'],
      },
      aggregation: { method: (config?.aggregation.method ?? 'MEAN') as AggregationMethod, config: config?.aggregation ?? DEFAULT_AGGREGATION_CONFIG },
      pairwise: parseJson<NonNullable<ResultRun['pairwise']>>(row.pairwise),
      entries,
      prizes: [],
      diagnostics: { signals: [], warnings: parseArray(row.warnings), confidence: { marginToRunnerUp: null, marginInSigma: null, tierSize: 1 } },
      provenance,
      integrityHash: row.integrity_hash,
    };
  }

  /* ==================================================== normalization */

  private persistNormalizationRun(eventId: string, run: ResultRun, ctx: ActorContext): string {
    const id = newId('normalizationRun');
    this.db.exec(
      `INSERT INTO normalization_runs (
         id, event_id, rubric_version_id, assignment_version, method, config, config_hash,
         engine_version, scope, input_hash, result, warnings, computed_by, computed_at
       ) VALUES (
         :id, :e, :rv, :av, :method, :config, :config_hash,
         :engine, 'EVENT', :input, :result, :warnings, :by, :at
       )`,
      {
        id,
        e: eventId,
        rv: run.rubricVersionId,
        av: run.assignmentVersion,
        method: run.normalization.method,
        config: canonicalJson(run.normalization.config),
        config_hash: sha256Hex(canonicalJson(run.normalization.config)),
        engine: run.normalization.run.engineVersion,
        input: contentHash(run.normalization.run.scores),
        result: canonicalJson(run.normalization.run),
        warnings: JSON.stringify(run.normalization.run.warnings),
        by: ctx.actor?.id ?? '',
        at: ctx.at,
      },
    );
    return id;
  }

  listNormalizationRuns(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    return this.db.all(
      `SELECT id, method, config, config_hash AS configHash, engine_version AS engineVersion,
              scope, input_hash AS inputHash, warnings, computed_at AS computedAt,
              json_array_length(json_extract(result, '$.scores')) AS scoreCount
       FROM normalization_runs WHERE event_id = :e ORDER BY computed_at DESC`,
      { e: eventId },
    );
  }

  /**
   * The "raw vs normalized" comparison the organizer needs to justify a method
   * choice, plus the measured outlier sensitivity of the chosen method.
   */
  normalizationComparison(
    eventId: string,
    method: NormalizationMethod,
    ctx: ActorContext,
  ) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);

    const raw = this.compute(eventId, { normalization: configForMethod('RAW') }, ctx);
    const alternative = this.compute(eventId, { normalization: configForMethod(method) }, ctx);

    const byProject = new Map<
      string,
      { raw: number | null; normalized: number | null; rawRank: number | null; normalizedRank: number | null; judges: number }
    >();
    for (const entry of raw.entries) {
      byProject.set(entry.projectId, {
        raw: entry.aggregateScore,
        normalized: entry.rawAggregate,
        rawRank: entry.rank,
        normalizedRank: null,
        judges: entry.judgeCount,
      });
    }
    for (const entry of alternative.entries) {
      const row = byProject.get(entry.projectId);
      if (row) {
        row.normalized = entry.aggregateScore;
        row.normalizedRank = entry.rank;
      }
    }

    const rows = [...byProject.entries()]
      .map(([projectId, value]) => ({
        projectId,
        rawScore: value.raw,
        normalizedScore: value.normalized,
        rawRank: value.rawRank,
        normalizedRank: value.normalizedRank,
        rankDelta: value.rawRank !== null && value.normalizedRank !== null ? value.rawRank - value.normalizedRank : null,
        judges: value.judges,
      }))
      .sort((a, b) => (a.normalizedRank ?? 999) - (b.normalizedRank ?? 999));

    const moved = rows.filter((row) => row.rankDelta !== null && row.rankDelta !== 0);

    return {
      method,
      rows,
      movedProjects: moved.length,
      warnings: alternative.diagnostics.warnings,
      judgeStats: alternative.normalization.run.judgeStats,
      explanation: buildNormalizationExplanation(method, moved, rows.length),
    };
  }

  /* ===================================================== diagnostics */

  /**
   * Read the panel's health. Pure: it computes and returns, and writes nothing.
   *
   * This used to also record the signals as review flags, from a `GET`. The
   * reasoning at the time was defensible - computing diagnostics is how you
   * notice things, so a link preview that computed them would not lose the
   * signal - but it made a read something nobody can reason about safely: the
   * same call from an organizer, a crawler, a prefetch and a retry produced four
   * audit rows and four flag writes, and a `GET` that writes cannot be cached,
   * crawled, or speculatively prefetched by anything.
   *
   * Recording is a deliberate act now: `POST /api/events/{eventId}/diagnostics`.
   * The computation is identical, so the two cannot disagree about what the panel
   * looks like.
   */
  readDiagnostics(eventId: string, ctx: ActorContext) {
    return this.diagnosticReport(eventId, ctx);
  }

  /**
   * Compute the panel's health and record the signals as review flags, so a
   * signal noticed at 2am is still there in the morning.
   */
  recordDiagnostics(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const diagnostics = this.diagnosticReport(eventId, ctx);

    this.persistAnomalies(eventId, diagnostics.signals, ctx);

    this.audit.record({
      action: 'diagnostics.computed',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'judgeDiagnostic',
      requestId: ctx.requestId,
      metadata: { signals: diagnostics.signals.length, judges: diagnostics.judges.length, projects: diagnostics.projects.length, recorded: true },
      at: ctx.at,
    });

    return diagnostics;
  }

  /** The computation itself, shared by both routes. Writes nothing. */
  private diagnosticReport(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const rubricRow = this.rubrics.requireActiveVersion(eventId);
    const event = this.events.require(eventId);

    const records = this.diagnosticRecords(eventId);
    const assignments = new Map<string, number>();
    const targets = new Map<string, string[]>();
    for (const row of this.db.all<{ judge_id: string; submission_id: string }>(
      "SELECT judge_id, submission_id FROM judge_assignments WHERE event_id = :e AND status <> 'REASSIGNED'",
      { e: eventId },
    )) {
      assignments.set(row.judge_id, (assignments.get(row.judge_id) ?? 0) + 1);
      targets.set(row.judge_id, [...(targets.get(row.judge_id) ?? []), row.submission_id]);
    }

    const votes =
      event.voting_enabled === 1 && event.voting_opens_at !== null
        ? {
            votes: this.db.all<{ userId: string; createdAt: string }>(
              'SELECT user_id AS userId, created_at AS createdAt FROM community_votes WHERE event_id = :e',
              { e: eventId },
            ),
            windowStart: event.voting_opens_at,
            windowEnd: event.voting_closes_at ?? ctx.at,
          }
        : undefined;

    return computeDiagnostics({
      eventId,
      rubricVersionId: rubricRow.id,
      assignmentVersion: this.assignments.currentVersion(eventId),
      reviews: records,
      assignments,
      assignmentTargets: targets,
      criteria: this.rubrics.criteria(rubricRow.id).map((c) => c.key),
      minimumJudges: event.minimum_judges,
      computedAt: ctx.at,
      ...(votes ? { votes } : {}),
    });
  }

  private diagnosticRecords(eventId: string): ReviewRecord[] {
    return this.db
      .all<{
        judgeId: string; projectId: string; raw_score: number; submitted_at: string | null; state: string;
        started_at: string; criterionJson: string | null;
      }>(
        `SELECT s.judge_id AS judgeId, s.submission_id AS projectId, s.raw_score, s.submitted_at,
                s.state, s.started_at,
                (SELECT GROUP_CONCAT(rc.field_key || '=' || cs.points, ';')
                 FROM criterion_scores cs JOIN rubric_criteria rc ON rc.id = cs.criterion_id
                 WHERE cs.score_id = s.id) AS criterionJson
         FROM scores s WHERE s.event_id = :e AND s.state IN ('SUBMITTED','LOCKED')`,
        { e: eventId },
      )
      .map((row) => ({
        judgeId: row.judgeId,
        projectId: row.projectId,
        score: Number(row.raw_score),
        submittedAt: row.submitted_at ?? row.started_at,
        state: row.state as ReviewRecord['state'],
        criteria: (row.criterionJson ?? '')
          .split(';')
          .filter(Boolean)
          .map((pair) => {
            const [key, points] = pair.split('=');
            return { key: key ?? '', points: Number(points) };
          }),
      }));
  }

  /**
   * Persist diagnostic signals as review flags.
   *
   * Flags are never deleted silently: the dedupe key keeps one row per
   * (event, type, subject, threshold) so a recurring signal updates its
   * evidence rather than piling up duplicates, and an organizer who dismisses
   * one can see that history.
   */
  private persistAnomalies(
    eventId: string,
    signals: { type: string; severity: AnomalySeverity; subjectId: string; subjectKind: string; metric: number | null; threshold: number | null; sampleSize: number; evidence: string; recommendedAction: string }[],
    ctx: ActorContext,
  ): void {
    for (const signal of signals) {
      const dedupeKey = `${signal.type}:${signal.subjectKind}:${signal.subjectId}:${String(signal.threshold ?? 'na')}`;
      this.db.exec(
        `INSERT INTO anomaly_flags (
           id, event_id, anomaly_type, severity, subject_kind, subject_id, metric, threshold,
           sample_size, evidence, recommended_action, status, dedupe_key, created_at, updated_at
         ) VALUES (
           :id, :e, :type, :severity, :subject_kind, :subject, :metric, :threshold,
           :sample, :evidence, :action, 'OPEN', :key, :at, :at
         )
         ON CONFLICT (event_id, dedupe_key) DO UPDATE SET
           metric = excluded.metric, sample_size = excluded.sample_size,
           evidence = excluded.evidence, recommended_action = excluded.recommended_action,
           severity = excluded.severity, updated_at = excluded.updated_at`,
        {
          id: newId('anomalyFlag'),
          e: eventId,
          type: signal.type,
          severity: signal.severity,
          subject_kind: signal.subjectKind,
          subject: signal.subjectId,
          metric: signal.metric,
          threshold: signal.threshold,
          sample: signal.sampleSize,
          evidence: signal.evidence,
          action: signal.recommendedAction,
          key: dedupeKey,
          at: ctx.at,
        },
      );
    }

    this.audit.record({
      action: 'anomaly.flagged',
      actorId: ctx.actor?.id ?? null,
      actorRoles: ctx.actor?.roles ?? [],
      eventId,
      resourceType: 'anomalyFlag',
      metadata: { signals: signals.length },
      at: ctx.at,
    });
  }

  listAnomalies(eventId: string, filter: { status?: AnomalyStatus; severity?: AnomalySeverity; limit: number; offset: number }, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const conditions = ['event_id = :e'];
    const params: Record<string, string | number> = { e: eventId, limit: filter.limit, offset: filter.offset };
    if (filter.status) {
      conditions.push('status = :status');
      params.status = filter.status;
    }
    if (filter.severity) {
      conditions.push('severity = :severity');
      params.severity = filter.severity;
    }
    const clause = `WHERE ${conditions.join(' AND ')}`;
    return {
      rows: this.db.all(
        `SELECT * FROM anomaly_flags ${clause}
         ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, created_at DESC
         LIMIT :limit OFFSET :offset`,
        params,
      ),
      total: this.db.value<number>(`SELECT COUNT(*) AS c FROM anomaly_flags ${clause}`, params) ?? 0,
    };
  }

  setAnomalyStatus(
    eventId: string,
    anomalyId: string,
    status: AnomalyStatus,
    resolution: string,
    ctx: ActorContext,
  ) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    if (!['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'DISMISSED', 'RESOLVED'].includes(status)) {
      throw errors.validation('Unknown anomaly status.', [{ field: 'status' }]);
    }
    if (['DISMISSED', 'RESOLVED'].includes(status) && resolution.trim().length < 5) {
      throw errors.validation('Dismissing or resolving a flag requires a short written conclusion.', [{ field: 'resolution' }]);
    }
    const before = this.db.get<{ status: string }>('SELECT status FROM anomaly_flags WHERE id = :id AND event_id = :e', { id: anomalyId, e: eventId });
    if (before === null) throw errors.notFound('Anomaly flag', anomalyId);

    this.db.exec(
      'UPDATE anomaly_flags SET status = :status, resolution = :resolution, reviewed_by = :by, reviewed_at = :at, updated_at = :at WHERE id = :id',
      { status, resolution: resolution.slice(0, 2000), by: actor.id, at: ctx.at, id: anomalyId },
    );
    this.audit.record({
      action: 'anomaly.status_changed',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'anomalyFlag',
      resourceId: anomalyId,
      requestId: ctx.requestId,
      previousState: before.status,
      newState: status,
      metadata: { resolution },
      at: ctx.at,
    });
    return this.db.get('SELECT * FROM anomaly_flags WHERE id = :id', { id: anomalyId });
  }

  /* ======================================================= queries */

  requireRun(id: string): RunRow {
    const row = this.db.get<RunRow>('SELECT * FROM result_runs WHERE id = :id', { id });
    if (row === null) throw errors.notFound('Result run', id);
    return row;
  }

  listRuns(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    return this.db.all(
      `SELECT r.id, r.assignment_version AS assignmentVersion, r.engine_version AS engineVersion,
              r.input_hash AS inputHash, r.integrity_hash AS integrityHash, r.notes, r.computed_at AS computedAt,
              rv.version AS rubricVersion, json_extract(r.config, '$.normalization.method') AS normalizationMethod,
              json_extract(r.config, '$.aggregation.method') AS aggregationMethod,
              (SELECT id FROM result_snapshots s WHERE s.result_run_id = r.id AND s.is_published = 1 LIMIT 1) AS publishedSnapshotId
       FROM result_runs r JOIN rubric_versions rv ON rv.id = r.rubric_version_id
       WHERE r.event_id = :e ORDER BY r.computed_at DESC`,
      { e: eventId },
    );
  }

  requireSnapshot(id: string): SnapshotRow {
    const row = this.db.get<SnapshotRow>('SELECT * FROM result_snapshots WHERE id = :id', { id });
    if (row === null) throw errors.notFound('Result snapshot', id);
    return row;
  }

  listSnapshots(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    return this.db.all<SnapshotRow & { reference: string }>(
      'SELECT * FROM result_snapshots WHERE event_id = :e ORDER BY sequence DESC',
      { e: eventId },
    );
  }

  /** The published snapshot, for the public results page. */
  publishedSnapshot(eventId: string): SnapshotRow | null {
    return this.db.get<SnapshotRow>(
      'SELECT * FROM result_snapshots WHERE event_id = :e AND is_published = 1 ORDER BY sequence DESC LIMIT 1',
      { e: eventId },
    );
  }

  entries(snapshotId: string) {
    return this.db.all(
      `SELECT re.*, s.project_name AS projectName, s.slug, s.short_description AS shortDescription,
              s.technologies, s.repository_url AS repositoryUrl, s.demo_url AS demoUrl,
              s.cover_image_url AS coverImageUrl, s.track_id AS trackId, t.name AS trackName, t.color AS trackColor
       FROM result_entries re
       JOIN submissions s ON s.id = re.submission_id
       LEFT JOIN event_tracks t ON t.id = s.track_id
       WHERE re.snapshot_id = :s ORDER BY re.rank`,
      { s: snapshotId },
    );
  }

  /**
   * The rows behind a run, in rank order. This is the source of truth for both
   * publication and verification, and it exists for every run — published or
   * not. The `snapshotEntries` variant reads the frozen copy under a snapshot
   * and is only for showing a participant exactly what was published.
   */
  private runEntries(runId: string) {
    return this.db.all<{
      rank: number; tie_group: number; submission_id: string; aggregate_score: number | null; raw_aggregate: number | null;
      rank_raw: number | null; rank_delta: number | null; judge_count: number; assigned_judges: number; coverage: number | null;
      validation: string; track_id: string | null; pairwise_rank: number | null; prizes: string; criteria: string; notes: string; review_hashes: string;
    }>('SELECT * FROM result_run_entries WHERE result_run_id = :r ORDER BY rank', { r: runId });
  }

  /* ==================================================== data gathering */

  private collectReviews(eventId: string, rubricVersionId: string): JudgeReviewInput[] {
    const rows = this.db.all<{
      id: string; judge_id: string; submission_id: string; state: string; raw_score: number | null;
      total_score: number | null; submitted_at: string | null; started_at: string;
    }>(
      `SELECT id, judge_id, submission_id, state, raw_score, total_score, submitted_at, started_at
       FROM scores WHERE event_id = :e AND state IN ('DRAFT','SUBMITTED','LOCKED')`,
      { e: eventId },
    );

    const criteria = this.rubrics.criteria(rubricVersionId);
    return rows
      .filter((row) => row.raw_score !== null)
      .map((row) => {
        const criterionScores = this.db.all<{ criterion_id: string; value: number; comment: string }>(
          'SELECT criterion_id, value, comment FROM criterion_scores WHERE score_id = :id',
          { id: row.id },
        );
        return {
          judgeId: row.judge_id,
          projectId: row.submission_id,
          rawScore: Number(row.raw_score),
          state: row.state as JudgeReviewInput['state'],
          submittedAt: row.submitted_at ?? row.started_at,
          evaluation: {
            total: Number(row.total_score ?? 0),
            score100: Number(row.raw_score ?? 0),
            criteria: criteria.map((criterion) => {
              const found = criterionScores.find((c) => c.criterion_id === criterion.id);
              return {
                criterionId: criterion.id,
                key: criterion.key,
                name: criterion.name,
                weight: criterion.weight,
                min: criterion.min,
                max: criterion.max,
                rawValue: found ? Number(found.value) : criterion.min,
                normalised: 0,
                contribution: 0,
                pointsOutOf100: 0,
                comment: found?.comment ?? null,
                required: criterion.required,
              };
            }),
            missingRequired: [],
            unknownCriterionIds: [],
            complete: true,
          },
        };
      });
  }

  private collectProjectMeta(eventId: string) {
    return this.db
      .all<{
        projectId: string; submittedAt: string; trackId: string | null; teamId: string | null;
        voteCount: number; eligibleForPrizes: number; assignedJudgeCount: number;
      }>(
        `SELECT s.id AS projectId, COALESCE(s.submitted_at, s.created_at) AS submittedAt,
                s.track_id AS trackId, s.team_id AS teamId,
                (SELECT COUNT(*) FROM community_votes v WHERE v.submission_id = s.id) AS voteCount,
                s.eligible_for_prizes AS eligibleForPrizes,
                (SELECT COUNT(*) FROM judge_assignments a WHERE a.submission_id = s.id AND a.status <> 'REASSIGNED') AS assignedJudgeCount
         FROM submissions s
         WHERE s.event_id = :e AND s.withdrawn = 0 AND s.state IN ('SUBMITTED','LOCKED','JUDGING','FINALIZED')
         ORDER BY s.submitted_at, s.id`,
        { e: eventId },
      )
      .map((row) => ({
        projectId: row.projectId,
        submittedAt: row.submittedAt,
        trackId: row.trackId,
        teamId: row.teamId,
        voteCount: Number(row.voteCount),
        eligibleForPrizes: row.eligibleForPrizes === 1,
        assignedJudgeCount: Number(row.assignedJudgeCount),
      }));
  }

  private collectPrizes(eventId: string): Prize[] {
    return this.db
      .all<{ id: string; name: string; quantity: number; eligible_ranks: string; eligible_track_id: string | null; priority: number }>(
        'SELECT id, name, quantity, eligible_ranks, eligible_track_id, priority FROM prizes WHERE event_id = :e',
        { e: eventId },
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        eligibleProjectIds: [],
        quantity: Number(row.quantity),
        eligibleRanks: parseArray(row.eligible_ranks).map((r) => Number(r)).filter((r) => Number.isInteger(r) && r >= 1),
        trackId: row.eligible_track_id,
        priority: Number(row.priority),
      }));
  }

  private collectCriterionSlices(eventId: string) {
    return this.db
      .all<{ projectId: string; key: string; points: number; judgeId: string }>(
        `SELECT s.submission_id AS projectId, rc.field_key AS key, cs.points, s.judge_id AS judgeId
         FROM criterion_scores cs
         JOIN scores s ON s.id = cs.score_id
         JOIN rubric_criteria rc ON rc.id = cs.criterion_id
         WHERE s.event_id = :e AND s.state IN ('SUBMITTED','LOCKED') AND rc.publish_breakdown = 1`,
        { e: eventId },
      )
      .map((row) => ({ projectId: row.projectId, key: row.key, points: Number(row.points), judgeId: row.judgeId }));
  }

  private collectComparisons(eventId: string): PairwiseComparison[] {
    return this.db
      .all<PairwiseComparison>(
        `SELECT id, judge_id AS judgeId, left_submission_id AS leftProjectId,
                right_submission_id AS rightProjectId, outcome, created_at AS decidedAt
         FROM pairwise_comparisons WHERE event_id = :e`,
        { e: eventId },
      );
  }
}

/* --------------------------------------------------------- helpers */

function entryCountOf(rows: unknown[]): number {
  return rows.length;
}

function parseJson<T>(value: string | null): T | null {
  if (value === null || value === '') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseArray(value: string | null): string[] {
  const parsed = parseJson<unknown>(value);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

function buildNormalizationExplanation(
  method: Method,
  moved: { projectId: string; rankDelta: number | null }[],
  total: number,
): string {
  if (moved.length === 0) {
    return `${method} produced the same ordering as raw scoring for all ${String(total)} project(s).`;
  }
  const direction = method === 'MIN_MAX' ? 'MIN_MAX is the most outlier-sensitive method; verify the panel before relying on it.' : '';
  return (
    `${method} moved ${String(moved.length)} of ${String(total)} project(s) relative to raw scoring. ` +
    `A positive change means the project climbed once judge generosity and severity were removed. ${direction}`
  ).trim();
}

export { isOneOf, safeJson };

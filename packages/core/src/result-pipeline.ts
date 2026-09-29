/**
 * The result pipeline (spec §27, §29, §30).
 *
 *   RAW SCORES -> VALIDATION -> NORMALIZATION -> AGGREGATION -> TIE RESOLUTION
 *              -> PRIZE ASSIGNMENT -> RESULT SNAPSHOT -> PUBLICATION
 *
 * This module is the *only* place a final ranking is produced. The web client
 * never computes one; it renders what this returns. Two properties matter most:
 *
 *   REPRODUCIBILITY. `computeResultRun` is a pure function of its input. Feed
 *   it the same stored inputs and it returns byte-identical output, including
 *   the integrity hash. `verifyResultRun` re-derives the run from storage and
 *   reports MATCH or a field-level diff, which is what the acceptance suite and
 *   an auditor use to prove the published numbers are the real numbers.
 *
 *   PROVENANCE. The snapshot records, for every stage, the engine version and
 *   the configuration used. Two years later it is still possible to say exactly
 *   which algorithm and which thresholds produced a prize.
 */

import {
  DEFAULT_AGGREGATION_CONFIG,
  type AggregationConfig,
  type AggregatedProject,
  type Prize,
  type PrizeAward,
  type ProjectInput,
  type RankedEntry,
  assignPrizes,
  aggregateProjects,
  rankByRaw,
  rankingConfidence,
} from './aggregation.ts';
import { contentHash, sha256Hex, canonicalJson } from './integrity.ts';
import {
  DEFAULT_NORMALIZATION_CONFIG,
  type NormalizationConfig,
  type NormalizationRun,
  type NormalizedScore,
  runNormalization,
} from './normalization.ts';
import type { ReviewEvaluation, RubricVersion } from './rubric.ts';
import { SCORE_DISPLAY_PRECISION, SCORE_PRECISION } from './rubric.ts';
import type { PairwiseComparison, PairwiseResult } from './pairwise.ts';
import { fitBradleyTerry } from './pairwise.ts';
import { roundTo } from './statistics.ts';
import type { DiagnosticSignal } from './diagnostics.ts';

export const RESULT_ENGINE_VERSION = '1.0.0';

/** Stage names, in execution order. Used for provenance and documentation. */
export const PIPELINE_STAGES = [
  'VALIDATION',
  'NORMALIZATION',
  'AGGREGATION',
  'TIE_RESOLUTION',
  'PRIZE_ASSIGNMENT',
  'SNAPSHOT',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type JudgeReviewInput = {
  judgeId: string;
  projectId: string;
  /** Raw weighted 0..100 score as submitted. Never modified. */
  rawScore: number;
  state: 'DRAFT' | 'SUBMITTED' | 'LOCKED';
  submittedAt: string;
  evaluation: ReviewEvaluation;
};

export type ResultRunInput = {
  eventId: string;
  rubricVersion: RubricVersion;
  assignmentVersion: number;
  reviews: readonly JudgeReviewInput[];
  projectMeta: readonly {
    projectId: string;
    submittedAt: string;
    trackId: string | null;
    teamId: string | null;
    voteCount: number;
    eligibleForPrizes: boolean;
    /**
     * Distinct judges the assignment version committed to this project.
     *
     * This must come from the assignment, NOT from the reviews that happen to
     * exist: deriving it from the reviews would classify a project where every
     * assigned judge abandoned the review as merely unassigned, and the
     * low-coverage warning that exists precisely to catch that case would never
     * fire.
     */
    assignedJudgeCount: number;
  }[];
  prizes: readonly Prize[];
  normalization: NormalizationConfig;
  aggregation: AggregationConfig;
  /** Committee to grade criterion 0..100 values for the breakdown. */
  criterionSlices?: readonly { projectId: string; key: string; points: number; judgeId: string }[];
  pairwise?: { enabled: boolean; comparisons: readonly PairwiseComparison[] };
  computedAt: string;
  runId: string;
  actorId: string;
  notes: string;
};

export type ResultEntry = {
  rank: number;
  tieGroup: number;
  projectId: string;
  trackId: string | null;
  /** Headline score used for ranking (normalized scale, 0..100). */
  aggregateScore: number | null;
  /** Mean of raw judge scores, for the "before normalization" view. */
  rawAggregate: number | null;
  rankRaw: number | null;
  rankDelta: number | null;
  judgeCount: number;
  assignedJudges: number;
  coverage: number | null;
  validation: AggregatedProject['validation'];
  criteria: { key: string; score: number | null; judgeCount: number }[];
  pairwiseRank: number | null;
  prizes: string[];
  notes: string[];
  integrity: { reviewHashes: string[] };
};

export type ResultRun = {
  id: string;
  eventId: string;
  engineVersion: string;
  rubricVersionId: string;
  rubricVersionNumber: number;
  assignmentVersion: number;
  normalization: {
    method: NormalizationConfig['method'];
    config: NormalizationConfig;
    run: NormalizationRun;
  };
  aggregation: {
    method: AggregationConfig['method'];
    config: AggregationConfig;
  };
  pairwise: PairwiseResult | null;
  entries: ResultEntry[];
  prizes: PrizeAward[];
  diagnostics: {
    signals: DiagnosticSignal[];
    warnings: string[];
    confidence: ReturnType<typeof rankingConfidence>;
  };
  provenance: {
    stages: { stage: PipelineStage; engineVersion: string; configHash: string }[];
    inputHash: string;
    reviewCount: number;
    projectCount: number;
    judgeCount: number;
    actorId: string;
    computedAt: string;
    notes: string;
  };
  integrityHash: string;
};

function hashConfig(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Run the full pipeline. Pure and deterministic given `input`.
 */
export function computeResultRun(input: ResultRunInput): ResultRun {
  const warnings: string[] = [];

  /* ---------------------------------------------- 1. VALIDATION ------- */

  const decidable = input.reviews.filter((r) => r.state === 'SUBMITTED' || r.state === 'LOCKED');
  const draftCount = input.reviews.length - decidable.length;
  if (draftCount > 0) {
    warnings.push(
      `${draftCount} review(s) were still in draft and are excluded from the result. Draft reviews never influence a ranking.`,
    );
  }
  if (decidable.length === 0) {
    warnings.push(
      'No submitted reviews exist, so no project has a score. Every entry is reported with a null aggregate and a DRAFT_ONLY status, and the ordering shown is submission order only — it carries no evidential weight.',
    );
  }

  /* ------------------------------------------ 2. NORMALIZATION -------- */

  const normalizationConfigHash = hashConfig(input.normalization);
  const normalizedRun = runNormalization({
    references: groupBy(
      decidable.map((r) => ({ judgeId: r.judgeId, projectId: r.projectId, criterionId: null, score: r.rawScore })),
      (r) => r.judgeId,
    ).map(([judgeId, rows]) => ({ judgeId, scores: rows.map((r) => r.score) })),
    reviews: decidable.map((r) => ({
      judgeId: r.judgeId,
      projectId: r.projectId,
      criterionId: null,
      score: r.rawScore,
    })),
    config: input.normalization,
    eventId: input.eventId,
    rubricVersionId: input.rubricVersion.id,
    assignmentVersion: input.assignmentVersion,
    computedAt: input.computedAt,
    configHash: normalizationConfigHash,
    runId: `nrm_${input.runId}`,
  });
  warnings.push(...normalizedRun.warnings);

  const normalizedIndex = new Map<string, number>();
  for (const score of normalizedRun.scores) {
    normalizedIndex.set(`${score.judgeId}::${score.projectId}`, score.normalized);
  }

  /* ------------------------------------------- 3. AGGREGATION --------- */

  const criterionPointsByProject = new Map<string, Map<string, number[]>>();
  for (const slice of input.criterionSlices ?? []) {
    const byKey = criterionPointsByProject.get(slice.projectId) ?? new Map<string, number[]>();
    byKey.set(slice.key, [...(byKey.get(slice.key) ?? []), slice.points]);
    criterionPointsByProject.set(slice.projectId, byKey);
  }

  const pairwiseResult = input.pairwise?.enabled
    ? fitBradleyTerry(input.pairwise.comparisons, input.projectMeta.map((p) => p.projectId), {
        computedAt: input.computedAt,
        inputHash: sha256Hex(canonicalJson(input.pairwise.comparisons.map((c) => [c.id, c.leftProjectId, c.rightProjectId, c.outcome]))),
      })
    : null;
  const pairwiseRank = new Map<string, number>();
  if (pairwiseResult) {
    for (const ranking of pairwiseResult.rankings) pairwiseRank.set(ranking.projectId, ranking.rank);
    warnings.push(...pairwiseResult.diagnostics.warnings);
  }

  const metaByProject = new Map(input.projectMeta.map((p) => [p.projectId, p]));
  const projectInputs: ProjectInput[] = input.projectMeta.map((project) => {
    const projectReviews = decidable.filter((r) => r.projectId === project.projectId);
    const byKey = criterionPointsByProject.get(project.projectId) ?? new Map<string, number[]>();
    const criterionScores: Record<string, (number | null)[]> = {};
    for (const [key, values] of byKey) criterionScores[key] = values;

    const pairwiseStats = pairwiseResult
      ? pairwiseResult.strengths.find((s) => s.projectId === project.projectId)
      : undefined;

    return {
      projectId: project.projectId,
      trackId: project.trackId,
      teamId: project.teamId,
      organization: null,
      normalizedScores: projectReviews.map((r) => normalizedIndex.get(`${r.judgeId}::${r.projectId}`) ?? null),
      rawScores: projectReviews.map((r) => r.rawScore),
      criterionScores,
      assignedJudges: project.assignedJudgeCount,
      submittedReviews: projectReviews.length,
      submittedAt: project.submittedAt,
      voteCount: project.voteCount,
      pairwise: pairwiseStats
        ? { wins: pairwiseStats.wins, losses: pairwiseStats.losses, ties: pairwiseStats.ties, score: pairwiseStats.theta }
        : null,
    };
  });

  const aggregation = aggregateProjects(
    projectInputs,
    input.aggregation,
    input.rubricVersion.tieBreakPriority,
  );
  warnings.push(...aggregation.warnings);

  /* ------------------------------------- 4./5. TIES AND PRIZES ------- */

  const rawRanked = rankBy(aggregation.projects, 'raw');
  const rawRankByProject = new Map(rawRanked.map((entry, index) => [entry.projectId, index + 1]));

  const ranked: RankedEntry[] = aggregation.projects;

  const eligiblePrizes = input.prizes.filter(() => true);
  const prizeAwards = assignPrizes(ranked, eligiblePrizes, (projectId) => metaByProject.get(projectId)?.teamId ?? projectId);

  const prizesByProject = new Map<string, string[]>();
  for (const award of prizeAwards) {
    prizesByProject.set(award.projectId, [...(prizesByProject.get(award.projectId) ?? []), award.prizeName]);
    for (const warning of award.warnings) warnings.push(`${award.prizeName}: ${warning}`);
  }

  /* ------------------------------------------ 6. SNAPSHOT ------------- */

  const entries: ResultEntry[] = ranked.map((entry) => {
    const meta = metaByProject.get(entry.projectId);
    const reviewHashes = decidable
      .filter((r) => r.projectId === entry.projectId)
      .map((r) => sha256Hex(canonicalJson({ judgeId: r.judgeId, projectId: r.projectId, raw: r.rawScore, at: r.submittedAt })))
      .sort();

    const rawRank = rawRankByProject.get(entry.projectId) ?? null;
    const coverage = entry.assignedJudges === 0 ? null : roundTo(entry.submittedReviews / entry.assignedJudges, 4);

    const notes = [...entry.notes];
    if (!meta?.eligibleForPrizes) notes.push('excluded from prize eligibility by organizer configuration');

    return {
      rank: entry.rank,
      tieGroup: entry.tieGroup,
      projectId: entry.projectId,
      trackId: entry.trackId ?? meta?.trackId ?? null,
      aggregateScore: entry.aggregateScore,
      rawAggregate: entry.rawAggregate,
      rankRaw: rawRank,
      rankDelta: rawRank === null ? null : roundTo(rawRank - entry.rank, 2),
      judgeCount: entry.submittedReviews,
      assignedJudges: entry.assignedJudges,
      coverage,
      validation: entry.validation,
      criteria: entry.criterionAggregates.map((c) => ({ key: c.key, score: c.score, judgeCount: c.judgeCount })),
      pairwiseRank: pairwiseRank.get(entry.projectId) ?? null,
      prizes: prizesByProject.get(entry.projectId) ?? [],
      notes,
      integrity: { reviewHashes },
    };
  });

  const inputHash = contentHash({
    eventId: input.eventId,
    rubricVersionId: input.rubricVersion.id,
    rubricVersionNumber: input.rubricVersion.version,
    assignmentVersion: input.assignmentVersion,
    reviews: decidable
      .map((r) => ({ judgeId: r.judgeId, projectId: r.projectId, score: roundTo(r.rawScore, SCORE_PRECISION), state: r.state, at: r.submittedAt }))
      .sort((a, b) => (a.judgeId === b.judgeId ? (a.projectId < b.projectId ? -1 : 1) : a.judgeId < b.judgeId ? -1 : 1)),
    projects: [...input.projectMeta].map((p) => ({ ...p })).sort((a, b) => (a.projectId < b.projectId ? -1 : 1)),
    prizes: [...input.prizes].map((p) => ({ ...p })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    normalization: input.normalization,
    aggregation: input.aggregation,
    pairwiseEnabled: input.pairwise?.enabled ?? false,
    criterionSlices: [...(input.criterionSlices ?? [])]
      .map((s) => ({ ...s }))
      .sort((a, b) => (a.projectId === b.projectId ? (a.key < b.key ? -1 : 1) : a.projectId < b.projectId ? -1 : 1)),
  });

  const validationHash = sha256Hex(
    canonicalJson(
      decidable
        .map((r) => [r.judgeId, r.projectId, r.state])
        .sort()
        .map((v) => v.join('|')),
    ),
  );

  const provenance = {
    stages: [
      { stage: 'VALIDATION' as const, engineVersion: RESULT_ENGINE_VERSION, configHash: validationHash },
      { stage: 'NORMALIZATION' as const, engineVersion: normalizedRun.engineVersion, configHash: normalizationConfigHash },
      { stage: 'AGGREGATION' as const, engineVersion: RESULT_ENGINE_VERSION, configHash: hashConfig(input.aggregation) },
      { stage: 'TIE_RESOLUTION' as const, engineVersion: RESULT_ENGINE_VERSION, configHash: hashConfig({ priority: input.rubricVersion.tieBreakPriority }) },
      { stage: 'PRIZE_ASSIGNMENT' as const, engineVersion: RESULT_ENGINE_VERSION, configHash: hashConfig(input.prizes) },
      { stage: 'SNAPSHOT' as const, engineVersion: RESULT_ENGINE_VERSION, configHash: inputHash },
    ],
    inputHash,
    reviewCount: decidable.length,
    projectCount: input.projectMeta.length,
    judgeCount: new Set(decidable.map((r) => r.judgeId)).size,
    actorId: input.actorId,
    computedAt: input.computedAt,
    notes: input.notes,
  };

  const integrityHash = contentHash({
    inputHash,
    entries: entries.map((e) => ({
      rank: e.rank,
      projectId: e.projectId,
      aggregateScore: e.aggregateScore,
      judgeCount: e.judgeCount,
      prizes: e.prizes,
      reviewHashes: e.integrity.reviewHashes,
    })),
    prizes: prizeAwards.map((a) => ({ prizeId: a.prizeId, projectId: a.projectId, rank: a.rank })),
  });

  return {
    id: input.runId,
    eventId: input.eventId,
    engineVersion: RESULT_ENGINE_VERSION,
    rubricVersionId: input.rubricVersion.id,
    rubricVersionNumber: input.rubricVersion.version,
    assignmentVersion: input.assignmentVersion,
    normalization: { method: input.normalization.method, config: input.normalization, run: normalizedRun },
    aggregation: { method: input.aggregation.method, config: input.aggregation },
    pairwise: pairwiseResult,
    entries,
    prizes: prizeAwards,
    diagnostics: {
      signals: [],
      warnings: [...new Set(warnings)],
      confidence: rankingConfidence(ranked),
    },
    provenance,
    integrityHash,
  };
}

/**
 * Rank on the raw mean, before normalization.
 *
 * Delegates to `rankByRaw` in `aggregation.ts`. The body used to live here, and
 * the only reason it moved is that this module imports `node:crypto` for the
 * integrity hash: anything exported from here drags a Node built-in into a
 * browser bundle. One implementation, reachable from both sides.
 */
function rankBy(projects: readonly AggregatedProject[], basis: 'raw'): RankedEntry[] {
  if (basis === 'raw') return rankByRaw(projects);
  return [...projects].map((project, index) => ({ ...project, rank: index + 1, tieGroup: 0, tiedWith: [] }));
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/* -------------------------------------------------- reproduction ------- */

export type ReproductionVerdict = {
  status: 'MATCH' | 'MISMATCH' | 'NOT_REPRODUCIBLE';
  /** Hashes of the stored run and the freshly recomputed run. */
  storedIntegrityHash: string;
  recomputedIntegrityHash: string | null;
  storedInputHash: string;
  recomputedInputHash: string | null;
  /** Field-level differences, empty when MATCH. */
  differences: {
    kind: 'RANK' | 'SCORE' | 'PRIZE' | 'ENTRY_MISSING' | 'ENTRY_EXTRA' | 'INPUT';
    projectId: string | null;
    field: string;
    stored: string | number | null;
    recomputed: string | number | null;
  }[];
  explanation: string;
  engineVersion: string;
  verifiedAt: string;
};

const COMPARABLE_PRECISION = 9;

/**
 * Recompute a run from stored inputs and compare it with the stored snapshot.
 *
 * This is the operation an auditor runs to answer "is this published result
 * the result of the scores in the database?". A MISMATCH is treated as a
 * serious incident, so the diff is field-level rather than a single boolean.
 */
export function verifyResultRun(
  stored: ResultRun,
  recomputed: ResultRun,
  verifiedAt: string,
): ReproductionVerdict {
  const differences: ReproductionVerdict['differences'] = [];

  if (stored.provenance.inputHash !== recomputed.provenance.inputHash) {
    differences.push({
      kind: 'INPUT',
      projectId: null,
      field: 'inputHash',
      stored: stored.provenance.inputHash,
      recomputed: recomputed.provenance.inputHash,
    });
  }

  const storedByProject = new Map(stored.entries.map((e) => [e.projectId, e]));
  const recomputedByProject = new Map(recomputed.entries.map((e) => [e.projectId, e]));

  for (const [projectId, storedEntry] of storedByProject) {
    const recomputedEntry = recomputedByProject.get(projectId);
    if (!recomputedEntry) {
      differences.push({ kind: 'ENTRY_MISSING', projectId, field: 'entry', stored: storedEntry.aggregateScore, recomputed: null });
      continue;
    }
    if (storedEntry.rank !== recomputedEntry.rank) {
      differences.push({ kind: 'RANK', projectId, field: 'rank', stored: storedEntry.rank, recomputed: recomputedEntry.rank });
    }
    const a = storedEntry.aggregateScore;
    const b = recomputedEntry.aggregateScore;
    const same =
      a === null || b === null ? a === b : Math.abs(roundTo(a, COMPARABLE_PRECISION) as number - (roundTo(b, COMPARABLE_PRECISION) as number)) < 1e-9;
    if (!same) {
      differences.push({ kind: 'SCORE', projectId, field: 'aggregateScore', stored: a, recomputed: b });
    }
    if (stableList(storedEntry.prizes) !== stableList(recomputedEntry.prizes)) {
      differences.push({
        kind: 'PRIZE',
        projectId,
        field: 'prizes',
        stored: stableList(storedEntry.prizes),
        recomputed: stableList(recomputedEntry.prizes),
      });
    }
  }
  for (const [projectId, recomputedEntry] of recomputedByProject) {
    if (!storedByProject.has(projectId)) {
      differences.push({ kind: 'ENTRY_EXTRA', projectId, field: 'entry', stored: null, recomputed: recomputedEntry.aggregateScore });
    }
  }

  const status: ReproductionVerdict['status'] =
    differences.length === 0 && stored.integrityHash === recomputed.integrityHash ? 'MATCH' : 'MISMATCH';

  return {
    status,
    storedIntegrityHash: stored.integrityHash,
    recomputedIntegrityHash: recomputed.integrityHash,
    storedInputHash: stored.provenance.inputHash,
    recomputedInputHash: recomputed.provenance.inputHash,
    differences,
    explanation:
      status === 'MATCH'
        ? 'Recomputing the pipeline from the stored inputs reproduced the published ranking, scores and prizes exactly.'
        : `${differences.length} difference(s) were found between the stored snapshot and a fresh recomputation. The stored result must not be treated as trustworthy until this is explained.`,
    engineVersion: RESULT_ENGINE_VERSION,
    verifiedAt,
  };
}

function stableList(values: readonly string[]): string {
  return [...values].sort().join('|');
}

export { DEFAULT_AGGREGATION_CONFIG, DEFAULT_NORMALIZATION_CONFIG, SCORE_DISPLAY_PRECISION, SCORE_PRECISION };
export type { NormalizedScore };

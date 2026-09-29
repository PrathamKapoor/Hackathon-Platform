/**
 * Aggregation and deterministic ranking (spec §27, §28).
 *
 * Pipeline: RAW SCORES -> VALIDATION -> NORMALIZATION -> AGGREGATION ->
 *            TIE RESOLUTION -> PRIZE ASSIGNMENT -> SNAPSHOT -> PUBLICATION
 *
 * This module owns AGGREGATION, VALIDATION and TIE RESOLUTION. All of it is
 * pure and deterministic; nothing here touches the database or the network.
 *
 * ---------------------------------------------------------------------------
 * AGGREGATION
 * ---------------------------------------------------------------------------
 * For project p with normalized judge scores S_p = {s_1 ... s_n}:
 *
 *   MEAN          A_p = (1/n) * SUM s_i
 *   MEDIAN        A_p = quantile(S_p, 0.5)          (R-7 interpolation)
 *   TRIMMED_MEAN  A_p = mean(S_p with floor(0.2n) dropped from each tail)
 *
 * The default is MEAN because it uses all available evidence and has the
 * smallest variance of the three. TRIMMED_MEAN is offered for panels where one
 * outlier review is a real risk; MEDIAN is offered for very small panels
 * (n <= 3) where the mean is dominated by a single review.
 *
 * Criterion-level project scores use the same aggregation so a criterion
 * breakdown is always consistent with the headline number.
 *
 * ---------------------------------------------------------------------------
 * VALIDATION
 * ---------------------------------------------------------------------------
 * Before aggregation a run is validated. A project is `EXCLUDED` when it has no
 * usable score at all; a project is `LOW_COVERAGE` when it is judged by fewer
 * than `minimumJudges`. Low-coverage projects are still ranked (we never
 * silently drop a submission) but they are marked, and any prize they win is
 * flagged for organizer attention. This is a judgement call we make
 * deliberately: hiding a submission is worse than ranking it with a warning.
 *
 * ---------------------------------------------------------------------------
 * TIE RESOLUTION (strict, documented order)
 * ---------------------------------------------------------------------------
 * 1. higher aggregate score
 * 2. higher normalized score
 * 3. higher mean score on the highest-priority *available* criterion
 *      (criterion order comes from the rubric's configured tieBreakPriority,
 *       then remaining criteria in rubric order)
 * 4. better pairwise win record (Bradley-Terry), when pairwise data exists
 * 5. higher raw mean
 * 6. higher community vote count (only when the event enables it for ranking)
 * 7. EARLIER submission timestamp  — favours projects that finished first,
 *    a tie-break that is unfair but *deterministic* and therefore safe; it is
 *    only ever reached when steps 1-6 are all exactly equal
 * 8. UNRESOLVED TIE: the projects are reported as sharing a rank and share a
 *    `tieGroup`. We never fall back on database row order.
 *
 * Every comparison above is on a value rounded to a fixed precision, so
 * floating-point noise can never decide a prize.
 */

import { mean as meanOf, median as medianOf, quantile, roundTo, stableMean, trimmedMean } from './statistics.ts';
import type { AggregationMethod } from './types.ts';

export type { AggregationMethod };
import { SCORE_DISPLAY_PRECISION, SCORE_PRECISION } from './rubric.ts';

/** Precision used for every rank comparison. Prevents 1e-17 noise deciding a prize. */
export const RANK_PRECISION = 6;

export type ProjectInput = {
  projectId: string;
  trackId: string | null;
  teamId: string | null;
  organization: string | null;
  /** Normalized 0..100 review scores, one per assigned judge that submitted. */
  normalizedScores: (number | null)[];
  /** Raw 0..100 review scores, aligned with `normalizedScores`. */
  rawScores: (number | null)[];
  /** criterionKey -> list of 0..100 criterion points for this project. */
  criterionScores: Record<string, (number | null)[]>;
  /** Distinct judge count, which may exceed the number of submitted scores. */
  assignedJudges: number;
  submittedReviews: number;
  submittedAt: string;
  voteCount?: number;
  /** Bradley-Terry win/loss record, when pairwise judging is enabled. */
  pairwise?: { wins: number; losses: number; ties: number; score: number | null } | null;
};

export type AggregationConfig = {
  method: AggregationMethod;
  /** Trim proportion for TRIMMED_MEAN. */
  trim: number;
  /** Minimum distinct judges before a project is flagged LOW_COVERAGE. */
  minimumJudges: number;
  /** Whether community votes may act as a tie-break. */
  allowVoteTieBreak: boolean;
  /** Whether pairwise results may act as a tie-break. */
  allowPairwiseTieBreak: boolean;
};

export const DEFAULT_AGGREGATION_CONFIG: AggregationConfig = {
  method: 'MEAN',
  trim: 0.2,
  minimumJudges: 3,
  allowVoteTieBreak: false,
  allowPairwiseTieBreak: true,
};

export type ValidationStatus = 'OK' | 'LOW_COVERAGE' | 'EXCLUDED' | 'DRAFT_ONLY';

export type AggregatedProject = {
  projectId: string;
  trackId: string | null;
  aggregateScore: number | null;
  rawAggregate: number | null;
  normalizedAggregate: number | null;
  criterionAggregates: { key: string; score: number | null; judgeCount: number }[];
  assignedJudges: number;
  submittedReviews: number;
  submittedAt: string;
  voteCount: number;
  pairwise: { wins: number; losses: number; ties: number; score: number | null } | null;
  validation: ValidationStatus;
  notes: string[];
  sortKey: SortKey;
};

export type SortKey = {
  aggregate: number;
  normalized: number;
  criterionChain: number[];
  pairwise: number;
  raw: number;
  votes: number;
  submittedAt: string;
  projectId: string;
};

export type AggregationResult = {
  method: AggregationMethod;
  config: AggregationConfig;
  projects: RankedEntry[];
  warnings: string[];
  excludedProjectIds: string[];
};

function aggregateValues(values: number[], method: AggregationMethod, trim: number): number | null {
  if (values.length === 0) return null;
  switch (method) {
    case 'MEDIAN':
      return medianOf(values);
    case 'TRIMMED_MEAN':
      return trimmedMean(values, trim);
    case 'MEAN':
    default:
      return meanOf(values);
  }
}

export function aggregateProjects(
  projects: readonly ProjectInput[],
  config: AggregationConfig = DEFAULT_AGGREGATION_CONFIG,
  tieBreakPriority: readonly string[] = [],
): AggregationResult {
  const warnings: string[] = [];
  const excludedProjectIds: string[] = [];

  const aggregated: AggregatedProject[] = projects.map((project) => {
    const notes: string[] = [];
    const normalizedValues = project.normalizedScores.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const rawValues = project.rawScores.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    const aggregateScore = aggregateValues(normalizedValues, config.method, config.trim);
    const rawAggregate = aggregateValues(rawValues, config.method, config.trim);

    const criterionKeys = Object.keys(project.criterionScores).sort();
    const criterionAggregates = criterionKeys.map((key) => {
      const values = (project.criterionScores[key] ?? []).filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v),
      );
      return {
        key,
        score: aggregateValues(values, config.method, config.trim),
        judgeCount: values.length,
      };
    });

    let validation: ValidationStatus = 'OK';
    if (normalizedValues.length === 0) {
      validation = project.assignedJudges > 0 ? 'DRAFT_ONLY' : 'EXCLUDED';
      notes.push('no submitted reviews; ranked last and excluded from prizes');
      if (project.assignedJudges > 0) excludedProjectIds.push(project.projectId);
    } else if (project.submittedReviews < config.minimumJudges) {
      validation = 'LOW_COVERAGE';
      notes.push(
        `judged by ${project.submittedReviews} of ${project.assignedJudges} assigned judges; below the minimum of ${config.minimumJudges}`,
      );
    }

    const criterionChain = buildCriterionChain(criterionAggregates, tieBreakPriority);

    return {
      projectId: project.projectId,
      trackId: project.trackId,
      aggregateScore: aggregateScore === null ? null : roundTo(aggregateScore, RANK_PRECISION),
      rawAggregate: rawAggregate === null ? null : roundTo(rawAggregate, RANK_PRECISION),
      normalizedAggregate: normalizedScoreOf(normalizedValues, config),
      criterionAggregates,
      assignedJudges: project.assignedJudges,
      submittedReviews: normalizedValues.length,
      submittedAt: project.submittedAt,
      voteCount: project.voteCount ?? 0,
      pairwise: project.pairwise ?? null,
      validation,
      notes,
      sortKey: {
        aggregate: aggregateScore === null ? Number.NEGATIVE_INFINITY : roundTo(aggregateScore, RANK_PRECISION),
        normalized: roundTo(
          aggregateValues(normalizedValues, config.method, config.trim) ?? Number.NEGATIVE_INFINITY,
          RANK_PRECISION,
        ),
        criterionChain,
        pairwise: project.pairwise?.score ?? Number.NEGATIVE_INFINITY,
        raw: rawAggregate === null ? Number.NEGATIVE_INFINITY : roundTo(rawAggregate, RANK_PRECISION),
        votes: project.voteCount ?? 0,
        submittedAt: project.submittedAt,
        projectId: project.projectId,
      },
    };
  });

  const ranked = rankProjects(aggregated, config);
  for (const item of ranked) {
    if (item.validation === 'LOW_COVERAGE') {
      warnings.push(
        `${item.projectId} is ranked with low coverage (${item.submittedReviews}/${item.assignedJudges} reviews).`,
      );
    }
  }
  if (ranked.some((p) => p.validation === 'DRAFT_ONLY')) {
    warnings.push('At least one project has no submitted reviews and is ranked last.');
  }

  return {
    method: config.method,
    config,
    projects: ranked,
    warnings,
    excludedProjectIds,
  };
}

function normalizedScoreOf(
  normalizedValues: number[],
  config: AggregationConfig,
): number | null {
  // The normalized aggregate is the aggregate itself when the run used RAW
  // normalization; otherwise it is the mean of the normalized scores. Both are
  // the same number, kept separate so the snapshot can prove which pipeline
  // stage produced the headline figure.
  if (config.method === 'MEDIAN') return medianOf(normalizedValues);
  if (config.method === 'TRIMMED_MEAN') return trimmedMean(normalizedValues, config.trim);
  return stableMean(normalizedValues);
}

function buildCriterionChain(
  criterionAggregates: { key: string; score: number | null }[],
  tieBreakPriority: readonly string[],
): number[] {
  const byKey = new Map(criterionAggregates.map((c) => [c.key, c.score]));
  const ordered: string[] = [];
  for (const key of tieBreakPriority) ordered.push(key);
  const remaining = criterionAggregates.map((c) => c.key).filter((k) => !ordered.includes(k));
  return [...ordered, ...remaining].map((key) => {
    const value = byKey.get(key);
    return value === null || value === undefined ? Number.NEGATIVE_INFINITY : roundTo(value, RANK_PRECISION);
  });
}

/* ------------------------------------------------------------ ranking */

export type RankedEntry = AggregatedProject & {
  rank: number;
  tieGroup: number;
  tiedWith: string[];
};

function compareRankKeys(a: SortKey, b: SortKey, config: AggregationConfig): number {
  // 1. aggregate
  if (a.aggregate !== b.aggregate) return a.aggregate > b.aggregate ? -1 : 1;
  // 2. normalized
  if (a.normalized !== b.normalized) return a.normalized > b.normalized ? -1 : 1;
  // 3. criterion priority chain
  const len = Math.max(a.criterionChain.length, b.criterionChain.length);
  for (let i = 0; i < len; i += 1) {
    const ca = a.criterionChain[i] ?? Number.NEGATIVE_INFINITY;
    const cb = b.criterionChain[i] ?? Number.NEGATIVE_INFINITY;
    if (ca !== cb) return ca > cb ? -1 : 1;
  }
  // 4. pairwise
  if (config.allowPairwiseTieBreak && a.pairwise !== b.pairwise) {
    return a.pairwise > b.pairwise ? -1 : 1;
  }
  // 5. raw
  if (a.raw !== b.raw) return a.raw > b.raw ? -1 : 1;
  // 6. community votes
  if (config.allowVoteTieBreak && a.votes !== b.votes) return a.votes > b.votes ? -1 : 1;
  // 7. earlier submission
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? -1 : 1;
  // 8. total tie; projectId is NOT used to break it (see assignRanks)
  return 0;
}

function rankProjects(projects: AggregatedProject[], config: AggregationConfig): RankedEntry[] {
  const sorted = [...projects].sort((a, b) => compareRankKeys(a.sortKey, b.sortKey, config));
  const ranked: RankedEntry[] = [];
  let tieGroup = 0;
  let currentGroup: AggregatedProject[] = [];
  let previousKey: SortKey | null = null;

  const flush = () => {
    if (currentGroup.length === 0) return;
    const shareRank = ranked.length + 1;
    const ids = currentGroup.map((p) => p.projectId);
    for (const project of currentGroup) {
      ranked.push({
        ...project,
        rank: shareRank,
        tieGroup,
        tiedWith: ids.filter((id) => id !== project.projectId),
      });
    }
    tieGroup += 1;
    currentGroup = [];
  };

  for (const project of sorted) {
    if (previousKey !== null && compareRankKeys(previousKey, project.sortKey, config) === 0) {
      currentGroup.push(project);
    } else {
      flush();
      tieGroup += 1;
      currentGroup = [project];
    }
    previousKey = project.sortKey;
  }
  flush();

  return ranked.sort((a, b) => a.rank - b.rank || (a.projectId < b.projectId ? -1 : 1));
}

/* ------------------------------------------------------------- prizes */

export type Prize = {
  id: string;
  name: string;
  /** Project ids eligible for this prize; empty means "any ranked project". */
  eligibleProjectIds: string[];
  /** Number of recipients; the default 1. */
  quantity: number;
  /** Only consider these ranks (1-based, inclusive). Empty means "any rank". */
  eligibleRanks: number[];
  /** Restrict to a track. */
  trackId: string | null;
  priority: number;
};

export type PrizeAward = {
  prizeId: string;
  prizeName: string;
  projectId: string;
  recipientLabel: string;
  rank: number;
  warnings: string[];
};

/**
 * Assign prizes in `priority` order, then by prize id for full determinism.
 * A project may win multiple prizes unless `exclusive` is set on the prize
 * (expressed by a prize with `eligibleRanks: [1]` acting as the overall win).
 */
export function assignPrizes(
  ranked: readonly RankedEntry[],
  prizes: readonly Prize[],
  resolveLabel: (projectId: string) => string,
): PrizeAward[] {
  const awards: PrizeAward[] = [];
  const claimed = new Set<string>();

  const ordered = [...prizes].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));

  for (const prize of ordered) {
    const candidates = ranked.filter((entry) => {
      if (entry.validation === 'EXCLUDED' || entry.validation === 'DRAFT_ONLY') return false;
      if (prize.eligibleProjectIds.length > 0 && !prize.eligibleProjectIds.includes(entry.projectId)) return false;
      if (prize.eligibleRanks.length > 0 && !prize.eligibleRanks.includes(entry.rank)) return false;
      if (claimed.has(entry.projectId)) return false;
      return true;
    });
    for (const candidate of candidates.slice(0, Math.max(0, prize.quantity))) {
      const warnings: string[] = [];
      if (candidate.validation === 'LOW_COVERAGE') {
        warnings.push('awarded to a low-coverage project; organizer review recommended');
      }
      if (candidate.tiedWith.length > 0) {
        warnings.push(`resolved from a tie shared with ${candidate.tiedWith.length} other project(s)`);
      }
      awards.push({
        prizeId: prize.id,
        prizeName: prize.name,
        projectId: candidate.projectId,
        recipientLabel: resolveLabel(candidate.projectId),
        rank: candidate.rank,
        warnings,
      });
      claimed.add(candidate.projectId);
    }
  }

  return awards;
}

/* ------------------------------------------------- ranking confidence */

/**
 * Rank aggregated projects on the *raw* mean, before normalization.
 *
 * This exists to answer one question honestly: what would a leaderboard have
 * said if nobody had corrected for how generous each judge is? It is the
 * counterfactual the published result is measured against, and
 * `ResultEntry.rankRaw` carries it.
 *
 * It lives here rather than in `result-pipeline.ts` because it operates on
 * `RankedEntry` and needs no hashing - which also means the browser can import
 * it. The result pipeline computes its integrity hash with `node:crypto`, so
 * importing anything from that module pulls a Node built-in into a bundle that
 * has no business having one. Ranking does not need a hash, so ranking lives on
 * this side of that line, and both the server and the browser get this exact
 * function rather than two implementations that agree today.
 */
export function rankByRaw(projects: readonly AggregatedProject[]): RankedEntry[] {
  const sorted = [...projects].sort((a, b) => {
    const av = a.rawAggregate;
    const bv = b.rawAggregate;
    if (av === null && bv === null) return a.projectId < b.projectId ? -1 : 1;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return bv - av;
    return a.projectId < b.projectId ? -1 : 1;
  });
  return sorted.map((project, index) => ({ ...project, rank: index + 1, tieGroup: 0, tiedWith: [] }));
}

/**
 * A small, honest confidence signal for the organizer dashboard: the spread
 * between the winner and the runner-up, expressed both absolutely and relative
 * to the panel's own dispersion. Not a probability — a descriptive statistic.
 */
export function rankingConfidence(ranked: readonly RankedEntry[]): {
  marginToRunnerUp: number | null;
  marginInSigma: number | null;
  tierSize: number;
} {
  const withScores = ranked.filter((entry) => entry.aggregateScore !== null);
  if (withScores.length < 2) return { marginToRunnerUp: null, marginInSigma: null, tierSize: withScores.length };
  const top = withScores[0] as RankedEntry;
  const second = withScores[1] as RankedEntry;
  const margin = (top.aggregateScore as number) - (second.aggregateScore as number);
  const scores = withScores.map((entry) => entry.aggregateScore as number);
  const dispersion = stddevSafe(scores);
  return {
    marginToRunnerUp: roundTo(margin, SCORE_DISPLAY_PRECISION),
    marginInSigma: dispersion && dispersion > 0 ? roundTo(margin / dispersion, 3) : null,
    tierSize: top.tieGroup > 0 ? (withScores.find((e) => e.tieGroup === top.tieGroup)?.rank ?? 1) : 1,
  };
}

function stddevSafe(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = stableMean(values)!;
  const acc = values.reduce((a, v) => a + (v - m) * (v - m), 0);
  return Math.sqrt(acc / values.length);
}

export { SCORE_PRECISION, SCORE_DISPLAY_PRECISION, quantile };

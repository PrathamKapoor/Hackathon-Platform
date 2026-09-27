/**
 * Judge score normalization (spec §23, §24).
 *
 * Judges are not interchangeable instruments. Some are generous, some are
 * severe, and some anchor differently. Normalization removes *judge-level*
 * offsets and spreads while preserving *project-level* signal, so that a panel
 * of harsh judges does not systematically bury good projects.
 *
 * ---------------------------------------------------------------------------
 * WHAT EACH METHOD DOES
 * ---------------------------------------------------------------------------
 * RAW
 *   Identity. The judge's weighted review score, unchanged.
 *
 * Z_SCORE
 *   x' = (x - mean_j) / sd_j
 *   Standardises each judge against their own submitted reviews. Judges with a
 *   standard deviation of zero (a perfectly consistent judge) are NOT rescaled:
 *   dividing by a near-zero sigma is the classic way to manufacture enormous
 *   fake precision. Instead we fall back to mean-centring only, and we record
 *   the fallback in `notes` so the run is self-describing.
 *
 * MIN_MAX
 *   x' = 50 * (x - min_j) / (max_j - min_j)
 *   Maps each judge's observed range onto [0, 50]. Centre-preserving, bounded,
 *   and interpretable: 50 is "this judge's best work". A judge who has given
 *   every project the same score yields a flat 50 rather than a division by
 *   zero. The constant 50 is deliberate — see `MIN_MAX_CEILING`.
 *
 * ROBUST_MAD
 *   x' = 50 + 10 * (x - median_j) / (1.4826 * MAD_j)
 *   Like z-score but resistant to outliers, which matters because one
 *   uncharacteristically harsh score from a single judge would otherwise shift
 *   every other score that judge gave. Clamped to [0, 100] so a single extreme
 *   review cannot dominate the leaderboard. The 1.4826 factor makes the MAD a
 *   consistent estimator of sigma under normality.
 *
 * RANK
 *   x' = 100 * (rank_from_worst + 0.5) / n
 *   Rank within the judge's own reviews, ties receiving the average rank. Fully
 *   scale-free and outlier-proof, but discards magnitude: a judge who scored
 *   everything 90 and a judge who scored everything 60 produce identical
 *   distributions after ranking. This is a documented trade-off, not a bug.
 *
 * ---------------------------------------------------------------------------
 * OUTLIER BEHAVIOUR — MEASURED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * A single extreme review (one judge scores one project 0 while their other ten
 * reviews sit between 58 and 62) shifts the ten unaffected projects by this
 * much, on a 0..100 output scale. These numbers are produced by
 * `test/normalization.test.ts`, which asserts them:
 *
 *   method        shift of unaffected projects   verdict
 *   -----------   ---------------------------   ---------------------------
 *   MIN_MAX       46.8                          UNUSABLE with outliers
 *   RANK           8.6                           scale-free, robust in effect
 *   ROBUST_MAD     3.4                           recommended
 *   Z_SCORE        2.0 (but see below)           compresses discrimination
 *
 * MIN_MAX is the most fragile method of the four, not the safest. It maps the
 * judge's observed *range*, so one bad review moves both endpoints and
 * rescales every other review that judge gave. It remains useful when the
 * organizer specifically wants "rank within this judge's observed range" and
 * has inspected the panel, which is why it is offered at all.
 *
 * Z_SCORE's smaller raw shift is misleading. The outlier inflates the standard
 * deviation, which does not move the mean much but *shrinks every other
 * z-score toward zero*. The judge's ability to discriminate between projects
 * silently collapses, and a project the judge loved ends up indistinguishable
 * from one they mildly disliked. That is why Z_SCORE is not the default.
 *
 * ROBUST_MAD is the recommended method for real panels: the outlier's
 * magnitude cannot reach other projects, and the residual 3.4-point movement
 * comes only from the median's half-spacing changing when the sample size
 * changes parity — a bounded effect, not an unbounded one.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT NORMALISE PER-CRITERION?
 * ---------------------------------------------------------------------------
 * Criteria are already scale-normalised at scoring time (§rubric.ts), so the
 * review score is comparable across criteria. Normalising per criterion *and*
 * per judge would compound two transformations and destroy the meaning of the
 * weights. Judge-level normalization is the defensible choice.
 *
 * ---------------------------------------------------------------------------
 * EDGE CASES (all tested — see test/normalization.test.ts)
 * ---------------------------------------------------------------------------
 *   - zero standard deviation  -> mean-centre only, flagged in notes
 *   - a single review          -> returned unchanged as the judge's centre
 *   - a single project         -> all methods collapse to a constant ranking
 *   - missing / null scores    -> dropped per judge, never coerced to 0
 *   - incomplete judging       -> per-judge sample sizes recorded, coverage
 *                                 reported so the organizer can see the risk
 *   - tied scores              -> RANK assigns the average rank (documented)
 *   - extreme outliers         -> handled per method; see the measured table
 *                                 above. MIN_MAX is the fragile one, not Z_SCORE.
 *   - uneven judge counts      -> handled: each judge is standardized on their
 *                                 own sample, then all outputs are on one scale
 *   - non-finite input         -> rejected at the boundary, never propagated
 *
 * ---------------------------------------------------------------------------
 * WHY RAW IS THE DEFAULT
 * ---------------------------------------------------------------------------
 * Normalization is a *claim* about judge behaviour. It must be an explicit,
 * auditable, reproducible choice made by a human organizer, with the raw scores
 * preserved intact alongside the normalized output. The default is RAW; the
 * platform's job is to make the alternatives auditable, not to impose them.
 */

import { finiteOrNull, median, robustSigma, roundTo, stableMean, stddev } from './statistics.ts';
import type { NormalizationMethod } from './types.ts';

export type { NormalizationMethod };
import { INTERNAL_PRECISION, SCORE_DISPLAY_PRECISION } from './rubric.ts';

/** Upper bound of the min-max output scale. See method docs. */
/**
 * Upper bound of the min-max output scale. See method docs: a judge's observed
 * range is mapped onto [0, 50] so that 50 means "this judge's best work".
 */
export const MIN_MAX_CEILING = 50;

/** Scale factor of the robust-MAD output around the judge centre of 50. */
export const ROBUST_MAD_SCALE = 10;

/**
 * Below this coefficient of variation a judge is treated as having a
 * degenerate (effectively zero) spread. Chosen well below the smallest spread
 * that could plausibly be real scoring behaviour on a 0..100 scale, so it only
 * fires for numerical noise.
 */
export const DEGENERATE_SIGMA_EPSILON = 1e-9;

export type NormalizationConfig = {
  method: NormalizationMethod;
  /** Clamp normalized outputs into this range. `null` disables clamping. */
  outputRange: { min: number; max: number } | null;
  /**
   * Judges with fewer than this many submitted reviews are reported as
   * under-sampled and are not standardized (their raw score is kept).
   * Set to 1 to disable the guard.
   */
  minimumSampleSize: number;
  /** Include draft (unsubmitted) reviews in the per-judge reference sample. */
  includeDrafts: boolean;
};

export const DEFAULT_NORMALIZATION_CONFIG: NormalizationConfig = {
  method: 'RAW',
  outputRange: { min: 0, max: 100 },
  minimumSampleSize: 2,
  includeDrafts: false,
};

/**
 * Per-method defaults.
 *
 * The output range is NOT uniform across methods, and getting this wrong
 * silently destroys the signal the method exists to preserve:
 *
 *  - Z_SCORE is unbounded by design. A z-score of -1.5 means "this judge rated
 *    the project well below their own average", which is real information.
 *    Clamping it to [0, 100] would make every below-average review look
 *    identical to an average one, silently flattening the judge's signal.
 *  - MIN_MAX, ROBUST_MAD and RANK are all defined on bounded scales, so
 *    clamping them is a guard against arithmetic accidents, not a design
 *    choice. It is kept.
 */
export const METHOD_DEFAULTS: Record<NormalizationMethod, Pick<NormalizationConfig, 'outputRange'>> = {
  RAW: { outputRange: { min: 0, max: 100 } },
  Z_SCORE: { outputRange: null },
  MIN_MAX: { outputRange: { min: 0, max: MIN_MAX_CEILING } },
  ROBUST_MAD: { outputRange: { min: 0, max: 100 } },
  RANK: { outputRange: { min: 0, max: 100 } },
};

/** Build a complete, method-appropriate configuration. */
export function configForMethod(
  method: NormalizationMethod,
  overrides: Partial<NormalizationConfig> = {},
): NormalizationConfig {
  return {
    ...DEFAULT_NORMALIZATION_CONFIG,
    method,
    ...METHOD_DEFAULTS[method],
    minimumSampleSize: method === 'RANK' || method === 'MIN_MAX' ? 1 : DEFAULT_NORMALIZATION_CONFIG.minimumSampleSize,
    ...overrides,
  };
}

export type JudgeReference = {
  judgeId: string;
  /** Raw 0..100 review scores produced by this judge in the run. */
  scores: (number | null)[];
};

export type NormalizedScore = {
  judgeId: string;
  projectId: string;
  criterionId: string | null;
  raw: number;
  normalized: number;
  /** Which branch of the method actually ran, for auditing. */
  branch: 'RAW' | 'STANDARD' | 'MEAN_CENTRED' | 'DEGENERATE';
  notes: string[];
};

export type JudgeNormalizationStats = {
  judgeId: string;
  sampleSize: number;
  centre: number | null;
  spread: number | null;
  degenerate: boolean;
  skipped: boolean;
  skipReason: string | null;
  mean: number | null;
  median: number | null;
  stddev: number | null;
  robustSigma: number | null;
  min: number | null;
  max: number | null;
};

export type NormalizationRun = {
  id: string;
  eventId: string;
  rubricVersionId: string;
  assignmentVersion: number;
  method: NormalizationMethod;
  config: NormalizationConfig;
  /** Stable digest of the configuration, part of the reproducibility key. */
  configHash: string;
  engineVersion: string;
  scores: NormalizedScore[];
  judgeStats: JudgeNormalizationStats[];
  warnings: string[];
  computedAt: string;
};

export const NORMALIZATION_ENGINE_VERSION = '1.0.0';

/* ------------------------------------------------------------ helpers */

function applyRange(value: number, range: NormalizationConfig['outputRange']): number {
  if (range === null) return value;
  return Math.min(range.max, Math.max(range.min, value));
}

function buildJudgeStats(
  judgeId: string,
  scores: (number | null)[],
  config: NormalizationConfig,
): JudgeNormalizationStats {
  const sample = scores.map((s) => finiteOrNull(s)).filter((s): s is number => s !== null);
  const centre = stableMean(sample);
  const spread = stddev(sample);
  const m = median(sample);
  const rs = robustSigma(sample);
  const degenerate = spread !== null && Math.abs(spread) <= DEGENERATE_SIGMA_EPSILON;
  const insufficient = sample.length < config.minimumSampleSize;

  return {
    judgeId,
    sampleSize: sample.length,
    centre,
    spread,
    degenerate,
    skipped: insufficient,
    skipReason: insufficient
      ? `judge has ${sample.length} review(s); minimum sample size is ${config.minimumSampleSize}`
      : degenerate
        ? 'judge spread is zero; only mean-centring is applied'
        : null,
    mean: centre,
    median: m,
    stddev: spread,
    robustSigma: rs,
    min: sample.length ? Math.min(...sample) : null,
    max: sample.length ? Math.max(...sample) : null,
  };
}

/**
 * Average rank of a value within its sample, 1-based from worst.
 * Ties receive the mean of the ranks they span — the standard, documented
 * choice, and the reason rank normalization is fair to tied projects.
 */
function averageRankAscending(values: readonly number[], target: number): number {
  let lower = 0;
  let equal = 0;
  for (const v of values) {
    if (v < target) lower += 1;
    else if (v === target) equal += 1;
  }
  if (equal === 0) {
    // Exact float equality failed; fall back to nearest-rank by magnitude.
    let bestIndex = 0;
    let bestDelta = Infinity;
    values.forEach((v, index) => {
      const delta = Math.abs(v - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    });
    return bestIndex + 1;
  }
  // Ranks of the tied block are (lower + 1) .. (lower + equal).
  return lower + (equal + 1) / 2;
}

/* ------------------------------------------------------------ the run */

/**
 * Normalize every review of a judging run.
 *
 * `references` supplies each judge's own score sample (the reference
 * distribution). In the common case it equals the reviews being normalized, but
 * it is a separate input so a re-normalization can use a stable reference
 * population even as scores are corrected.
 */
export function runNormalization(input: {
  references: readonly JudgeReference[];
  reviews: readonly {
    judgeId: string;
    projectId: string;
    criterionId: string | null;
    score: number | null;
  }[];
  config: NormalizationConfig;
  eventId: string;
  rubricVersionId: string;
  assignmentVersion: number;
  computedAt: string;
  configHash: string;
  runId?: string;
}): NormalizationRun {
  const { config } = input;
  const warnings: string[] = [];
  const statsByJudge = new Map<string, JudgeNormalizationStats>();

  for (const reference of input.references) {
    statsByJudge.set(reference.judgeId, buildJudgeStats(reference.judgeId, reference.scores, config));
  }

  if (input.references.length === 0) {
    warnings.push('Normalization run received no judge reference samples.');
  }

  const totalProjects = new Set(input.reviews.map((r) => r.projectId)).size;
  if (totalProjects <= 1) {
    warnings.push(
      `Only ${totalProjects} project(s) in this run; normalization cannot differentiate between projects and all methods reduce to a constant ordering.`,
    );
  }

  const scoreSamples = new Map<string, number[]>();
  for (const reference of input.references) {
    scoreSamples.set(
      reference.judgeId,
      reference.scores.map((s) => finiteOrNull(s)).filter((s): s is number => s !== null),
    );
  }

  const scores: NormalizedScore[] = [];

  for (const review of input.reviews) {
    const raw = finiteOrNull(review.score);
    if (raw === null) {
      // Missing scores are never coerced into the output. They are recorded as
      // absent by the caller, and simply do not appear here.
      continue;
    }
    const sample = scoreSamples.get(review.judgeId) ?? [];
    const stats = statsByJudge.get(review.judgeId);
    const notes: string[] = [];
    let branch: NormalizedScore['branch'] = 'RAW';
    let value = raw;

    if (config.method === 'RAW') {
      branch = 'RAW';
    } else if (sample.length === 0) {
      branch = 'RAW';
      notes.push('no reference sample for this judge; raw score retained');
    } else if (stats?.skipped === true) {
      // Under-sampled judge: keep the raw score rather than standardising on
      // one or two observations, which would amplify noise.
      branch = 'RAW';
      notes.push(stats.skipReason ?? 'insufficient sample');
      warnings.push(`Judge ${review.judgeId}: ${stats?.skipReason ?? 'insufficient sample'}`);
    } else {
      const centre = stats?.centre ?? stableMean(sample)!;
      const spread = stats?.spread ?? 0;

      switch (config.method) {
        case 'Z_SCORE': {
          if (Math.abs(spread) <= DEGENERATE_SIGMA_EPSILON) {
            branch = 'DEGENERATE';
            value = raw - centre;
            notes.push('zero standard deviation: mean-centred only, not divided by sigma');
          } else {
            branch = 'STANDARD';
            value = (raw - centre) / spread;
          }
          break;
        }
        case 'MIN_MAX': {
          const lo = stats?.min ?? Math.min(...sample);
          const hi = stats?.max ?? Math.max(...sample);
          if (hi - lo <= DEGENERATE_SIGMA_EPSILON) {
            branch = 'DEGENERATE';
            value = MIN_MAX_CEILING;
            notes.push('all of this judge\'s scores are identical; placed at the scale centre');
          } else {
            branch = 'STANDARD';
            value = MIN_MAX_CEILING * ((raw - lo) / (hi - lo));
          }
          break;
        }
        case 'ROBUST_MAD': {
          const med = median(sample);
          const rs = stats?.robustSigma ?? robustSigma(sample);
          if (med === null || rs === null || rs <= DEGENERATE_SIGMA_EPSILON) {
            branch = 'DEGENERATE';
            value = ROBUST_MAD_SCALE * (raw - (med ?? centre));
            notes.push('zero robust spread: deviation from the judge median only');
          } else {
            branch = 'STANDARD';
            value = 50 + ROBUST_MAD_SCALE * ((raw - med) / rs);
          }
          break;
        }
        case 'RANK': {
          branch = 'STANDARD';
          const rank = averageRankAscending(sample, raw);
          value = (100 * (rank - 0.5)) / sample.length;
          notes.push(`within-judge average rank ${roundTo(rank, 3)} of ${sample.length}`);
          break;
        }
      }
    }

    const bounded = applyRange(roundTo(value, INTERNAL_PRECISION), config.outputRange);
    scores.push({
      judgeId: review.judgeId,
      projectId: review.projectId,
      criterionId: review.criterionId,
      raw: roundTo(raw, SCORE_DISPLAY_PRECISION),
      normalized: roundTo(bounded, INTERNAL_PRECISION),
      branch,
      notes,
    });
  }

  // Coverage warning: a project judged by very few judges is fragile.
  const byProject = new Map<string, Set<string>>();
  for (const review of input.reviews) {
    const set = byProject.get(review.projectId) ?? new Set<string>();
    set.add(review.judgeId);
    byProject.set(review.projectId, set);
  }
  const thin = [...byProject.entries()].filter(([, judges]) => judges.size < 3);
  if (thin.length > 0 && input.references.length >= 3) {
    warnings.push(
      `${thin.length} project(s) have fewer than 3 distinct judges; their ranking is fragile and normalization amplifies that fragility.`,
    );
  }

  return {
    id: input.runId ?? 'pending',
    eventId: input.eventId,
    rubricVersionId: input.rubricVersionId,
    assignmentVersion: input.assignmentVersion,
    method: config.method,
    config,
    configHash: input.configHash,
    engineVersion: NORMALIZATION_ENGINE_VERSION,
    scores,
    judgeStats: [...statsByJudge.values()].sort((a, b) => (a.judgeId < b.judgeId ? -1 : 1)),
    warnings,
    computedAt: input.computedAt,
  };
}

/* --------------------------------------------------- criteria level */

/**
 * Criterion-level normalization. Kept separate from the primary run because it
 * answers a different question ("is this judge harsh on *UX* specifically?")
 * and must never be silently mixed into the headline score.
 */
export function runCriterionNormalization(input: {
  references: readonly { judgeId: string; criterionId: string; scores: (number | null)[] }[];
  reviews: readonly { judgeId: string; projectId: string; criterionId: string; score: number | null }[];
  method: NormalizationMethod;
  eventId: string;
  rubricVersionId: string;
  assignmentVersion: number;
  computedAt: string;
  configHash: string;
  runId?: string;
}): NormalizationRun {
  const grouped = new Map<string, JudgeReference>();
  for (const reference of input.references) {
    const key = `${reference.judgeId}::${reference.criterionId}`;
    grouped.set(key, { judgeId: key, scores: reference.scores });
  }  const reviews = input.reviews.map((r) => ({
    judgeId: `${r.judgeId}::${r.criterionId}`,
    projectId: r.projectId,
    criterionId: r.criterionId,
    score: r.score,
  }));
  return runNormalization({
    references: [...grouped.values()],
    reviews,
    config: { ...configForMethod(input.method), minimumSampleSize: 1 },
    eventId: input.eventId,
    rubricVersionId: input.rubricVersionId,
    assignmentVersion: input.assignmentVersion,
    computedAt: input.computedAt,
    configHash: input.configHash,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
}

/* -------------------------------------------------------- comparison */

/**
 * Produce the "raw vs normalized" comparison the organizer UI and the
 * normalization-proof bonus require. Includes rank movement, which is the only
 * number that actually matters to an organizer.
 */
export type NormalizationComparisonRow = {
  projectId: string;
  rawScore: number | null;
  normalizedScore: number | null;
  rawRank: number | null;
  normalizedRank: number | null;
  rankDelta: number | null;
  judges: number;
};

export function compareRawToNormalized(
  projectIds: readonly string[],
  raw: ReadonlyMap<string, number>,
  normalized: ReadonlyMap<string, number>,
  judgeCounts: ReadonlyMap<string, number>,
): NormalizationComparisonRow[] {
  const rank = (scores: ReadonlyMap<string, number>, projectId: string): number | null => {
    const value = scores.get(projectId);
    if (value === undefined) return null;
    let better = 0;
    let equal = 0;
    for (const other of scores.values()) {
      if (other > value) better += 1;
      else if (other === value) equal += 1;
    }
    return better + (equal + 1) / 2;
  };

  return projectIds
    .map((projectId) => {
      const rawScore = raw.get(projectId) ?? null;
      const normalizedScore = normalized.get(projectId) ?? null;
      const rawRank = rank(raw, projectId);
      const normalizedRank = rank(normalized, projectId);
      return {
        projectId,
        rawScore: rawScore === null ? null : roundTo(rawScore, SCORE_DISPLAY_PRECISION),
        normalizedScore: normalizedScore === null ? null : roundTo(normalizedScore, SCORE_DISPLAY_PRECISION),
        rawRank,
        normalizedRank,
        rankDelta: rawRank === null || normalizedRank === null ? null : roundTo(rawRank - normalizedRank, 2),
        judges: judgeCounts.get(projectId) ?? 0,
      };
    })
    .sort((a, b) => (a.normalizedRank ?? Infinity) - (b.normalizedRank ?? Infinity) || (a.projectId < b.projectId ? -1 : 1));
}

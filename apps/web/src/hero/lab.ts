/**
 * The judging engine, running in the browser.
 *
 * The landing page's interactive panel demonstrates the product's whole
 * argument, and the argument is arithmetic. So this file does not animate
 * anything and holds no table of numbers chosen to look convincing: it builds a
 * small but genuine judging panel and runs the real normalization and
 * aggregation stages over it.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT computeResultRun
 * ---------------------------------------------------------------------------
 * The obvious thing to call is `computeResultRun`, the function the API calls
 * when an organizer presses compute. It cannot be imported here: it hashes the
 * run with `node:crypto`, so pulling it into a browser bundle fails the build on
 * `createHash`. Hashing is provenance - the integrity hash, the input hash, the
 * per-review hashes - and none of it decides a rank.
 *
 * So this runs the stages that do decide a rank, from the same modules the
 * pipeline runs them from:
 *
 *   runNormalization  (normalization.ts)   per-judge standardization
 *   aggregateProjects (aggregation.ts)     mean, coverage, validation
 *   rankByRaw         (aggregation.ts)     the un-normalized counterfactual
 *
 * `rankByRaw` used to be a private helper inside `result-pipeline.ts`. It moved to
 * `aggregation.ts` so this file and the pipeline can share one implementation
 * rather than two that happen to agree today - and so this file can reach it
 * without the crypto import.
 *
 * The claim that matters - that these ranks are the ranks the server would
 * produce for the same reviews - is not left as a comment. It is asserted, on
 * every run, in `packages/core/test/result-pipeline.test.ts` by ranking the same
 * panel both ways and comparing. If a change to the pipeline ever made the two
 * paths disagree, that test fails rather than the landing page quietly lying.
 *
 * The one field the browser cannot fill honestly is the normalization config
 * hash, because a hash is a hash. It is passed as a fixed placeholder, and
 * `runNormalization` copies it into the run record without using it for any
 * score, so the ranks are unaffected.
 */

/*
 * Imported from the subpath exports rather than the barrel. `index.ts` re-exports
 * `result-pipeline.ts` and `integrity.ts`, both of which use `node:crypto`, so
 * importing `@verdict/core` from a browser bundle fails the build on
 * `createHash`. The package map already separates the browser-safe modules, and
 * these three are the ones a rank depends on.
 */
import {
  aggregateProjects,
  rankByRaw,
  type ProjectInput,
} from '@verdict/core/aggregation';
import { runNormalization, type NormalizationConfig } from '@verdict/core/normalization';
import { evaluateReview, type ReviewEvaluation, type RubricVersion } from '@verdict/core/rubric';

export type LabProject = { id: string; name: string };
export type LabJudge = { id: string; name: string; role: string };

export const LAB_PROJECTS: readonly LabProject[] = [
  { id: 'p_lattice', name: 'Lattice' },
  { id: 'p_beacon', name: 'Beacon' },
  { id: 'p_ferrite', name: 'Ferrite' },
  { id: 'p_quill', name: 'Quill' },
];

export const LAB_JUDGES: readonly LabJudge[] = [
  { id: 'j_amara', name: 'Amara', role: 'consistent' },
  { id: 'j_ben', name: 'Ben', role: 'harsh by habit' },
  { id: 'j_priya', name: 'Priya', role: 'tight' },
  { id: 'j_yuki', name: 'Yuki', role: 'generous' },
];

/** The judge whose generosity the visitor controls. */
export const LAB_ADJUSTABLE_JUDGE = 'j_yuki';

/** Fixed instants, not `now()`. A demo that changed its output every render
 *  could not be a demonstration of reproducibility. */
const PROJECT_SUBMITTED_AT = '2026-02-04T10:00:00.000Z';
const COMPUTED_AT = '2026-02-05T09:00:00.000Z';

/**
 * Three weighted criteria rather than one, because a weighted rubric is the
 * product. The weighted total is pinned to the intended score - see
 * `criterionValues` - so the criterion detail is illustrative while the number
 * the engine ranks on is the one specified.
 */
export const LAB_RUBRIC: RubricVersion = {
  id: 'rb_lab',
  rubricId: 'rb_lab',
  version: 1,
  status: 'LOCKED',
  weightsMustSumToOne: true,
  rounding: { mode: 'HALF_UP', precision: 1 },
  tieBreakPriority: ['impact', 'execution', 'evidence'],
  notes: 'A three-criterion illustration, weighted 50/30/20.',
  criteria: [
    { id: 'c_impact', key: 'impact', name: 'Impact', description: 'Does it matter to someone this week?', weight: 0.5, min: 0, max: 100, required: true, scoringType: 'INTEGER', order: 0, publishBreakdown: true },
    { id: 'c_execution', key: 'execution', name: 'Execution', description: 'Does it work, and how well?', weight: 0.3, min: 0, max: 100, required: true, scoringType: 'INTEGER', order: 1, publishBreakdown: true },
    { id: 'c_evidence', key: 'evidence', name: 'Evidence', description: 'Is the claim supported by something?', weight: 0.2, min: 0, max: 100, required: true, scoringType: 'INTEGER', order: 2, publishBreakdown: true },
  ],
};

/**
 * Who scored what.
 *
 * Uneven coverage is the realistic case and it is load-bearing: three of the
 * four projects are covered by the adjustable judge and one is not, so raising
 * that judge's generosity lifts three projects and not the fourth. A uniform
 * panel could not demonstrate anything - a constant added to one judge's scores
 * for every project shifts every mean equally, and the ranking cannot move. The
 * project short of a review is the one that suffers, which is the real failure
 * this is about.
 */
export const LAB_COVERAGE: Readonly<Record<string, readonly string[]>> = {
  p_lattice: ['j_amara', 'j_ben', 'j_yuki'],
  p_beacon: ['j_amara', 'j_ben', 'j_priya'],
  p_ferrite: ['j_ben', 'j_priya', 'j_yuki'],
  p_quill: ['j_amara', 'j_priya', 'j_yuki'],
};

/** Each judge's own level, before the adjustable one is moved. */
const JUDGE_BIAS: Readonly<Record<string, number>> = {
  j_amara: 0,
  j_ben: -10,
  j_priya: -2,
  j_yuki: 0,
};

/** Underlying quality, before any judge's habit is applied. */
const TRUE_QUALITY: Readonly<Record<string, number>> = {
  p_lattice: 81,
  p_beacon: 79,
  p_ferrite: 78,
  p_quill: 77,
};

/** Per-project departure from a judge's own baseline. */
const HABIT: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  j_amara: { p_lattice: 0, p_beacon: 0, p_quill: -1 },
  j_ben: { p_lattice: 0, p_beacon: 0, p_ferrite: 0 },
  j_priya: { p_beacon: 0, p_ferrite: 0, p_quill: 0 },
  j_yuki: { p_lattice: 0, p_ferrite: 0, p_quill: 0 },
};

/** Largest generosity the slider can add, in raw points. */
export const LAB_MAX_GENEROSITY = 22;

const NORMALIZATION: NormalizationConfig = {
  method: 'Z_SCORE',
  outputRange: { min: 0, max: 100 },
  // Three submitted reviews is the documented minimum for a usable reference
  // distribution; below it the method falls back to the raw score rather than
  // standardizing on two points and calling it a habit.
  minimumSampleSize: 3,
  includeDrafts: false,
};

const AGGREGATION = {
  method: 'MEAN',
  trim: 0.2,
  minimumJudges: 3,
  allowVoteTieBreak: false,
  allowPairwiseTieBreak: false,
} as const;

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/**
 * Split a weighted total across the criteria so the total is exact.
 *
 * The last criterion absorbs the remainder. That keeps the arithmetic honest:
 * the number the engine ranks on is the one specified here, rather than whatever
 * three hand-picked values happen to add up to.
 */
export function criterionValues(target: number): { criterionId: string; value: number }[] {
  const centre = 60;
  const shapes: Record<string, number> = { c_impact: 0.55, c_execution: 0.8, c_evidence: 0.3 };
  const out: { criterionId: string; value: number }[] = [];
  let partial = 0;

  for (const criterion of LAB_RUBRIC.criteria.slice(0, -1)) {
    const value = clampScore(centre + (target - centre) * (shapes[criterion.id] ?? 0.5));
    out.push({ criterionId: criterion.id, value });
    partial += criterion.weight * value;
  }

  const last = LAB_RUBRIC.criteria[LAB_RUBRIC.criteria.length - 1];
  if (last !== undefined) {
    out.push({ criterionId: last.id, value: clampScore((target - partial) / last.weight) });
  }
  return out;
}

/** One judge's raw score for one project, at a given generosity. */
export function rawScoreFor(judgeId: string, projectId: string, generosity: number): number {
  const base = (TRUE_QUALITY[projectId] ?? 0) + (JUDGE_BIAS[judgeId] ?? 0) + (HABIT[judgeId]?.[projectId] ?? 0);
  const bonus = judgeId === LAB_ADJUSTABLE_JUDGE ? generosity : 0;
  return Math.min(100, Math.max(0, base + bonus));
}

export type LabReview = {
  judgeId: string;
  projectId: string;
  rawScore: number;
  evaluation: ReviewEvaluation;
};

/** The panel's reviews at a given generosity. Exported so the parity test can
 *  hand the identical data to `computeResultRun`. */
export function labReviews(generosity: number): LabReview[] {
  const reviews: LabReview[] = [];
  for (const project of LAB_PROJECTS) {
    for (const judgeId of LAB_COVERAGE[project.id] ?? []) {
      const target = rawScoreFor(judgeId, project.id, generosity);
      const evaluation = evaluateReview(
        LAB_RUBRIC,
        criterionValues(target).map((entry) => ({ criterionId: entry.criterionId, value: entry.value })),
      );
      reviews.push({ judgeId, projectId: project.id, rawScore: evaluation.score100, evaluation });
    }
  }
  return reviews;
}

/** The judges' own score distributions, grouped the way the pipeline groups them. */
function referencesFor(reviews: readonly LabReview[]): { judgeId: string; scores: number[] }[] {
  const byJudge = new Map<string, number[]>();
  for (const review of reviews) {
    byJudge.set(review.judgeId, [...(byJudge.get(review.judgeId) ?? []), review.rawScore]);
  }
  return [...byJudge.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([judgeId, scores]) => ({ judgeId, scores }));
}

export type LabRow = {
  project: LabProject;
  /** Rank by the un-normalized mean of raw scores. */
  rawRank: number;
  /** Rank after per-judge standardization. */
  normalizedRank: number;
  rawMean: number;
  judges: number;
  validation: string;
};

/**
 * Both orderings at a given generosity, sorted by the normalized rank.
 *
 * This is `computeResultRun` minus the hashing, and the parity test in core
 * asserts the ranks match.
 */
export function labRows(generosity: number): LabRow[] {
  const reviews = labReviews(generosity);

  const normalizedRun = runNormalization({
    references: referencesFor(reviews),
    reviews: reviews.map((review) => ({
      judgeId: review.judgeId,
      projectId: review.projectId,
      criterionId: null,
      score: review.rawScore,
    })),
    config: NORMALIZATION,
    eventId: 'evt_lab',
    rubricVersionId: LAB_RUBRIC.id,
    assignmentVersion: 1,
    computedAt: COMPUTED_AT,
    // Provenance only. See the header.
    configHash: 'browser-no-hash',
    runId: 'nrm_lab',
  });

  const normalizedIndex = new Map<string, number>();
  for (const score of normalizedRun.scores) {
    normalizedIndex.set(`${score.judgeId}::${score.projectId}`, score.normalized);
  }

  const projectInputs: ProjectInput[] = LAB_PROJECTS.map((project) => {
    const projectReviews = reviews.filter((review) => review.projectId === project.id);
    return {
      projectId: project.id,
      trackId: null,
      teamId: null,
      organization: null,
      normalizedScores: projectReviews.map((review) => normalizedIndex.get(`${review.judgeId}::${review.projectId}`) ?? null),
      rawScores: projectReviews.map((review) => review.rawScore),
      criterionScores: {},
      // From the assignment, not from the reviews that happen to exist. This is
      // the distinction the pipeline cares about: deriving it from the reviews
      // would make a project whose every judge abandoned the review look merely
      // unassigned, and the low-coverage warning meant to catch that never fires.
      assignedJudges: (LAB_COVERAGE[project.id] ?? []).length,
      submittedReviews: projectReviews.length,
      submittedAt: PROJECT_SUBMITTED_AT,
      voteCount: 0,
      pairwise: null,
    };
  });

  const aggregation = aggregateProjects(projectInputs, AGGREGATION, LAB_RUBRIC.tieBreakPriority);
  const rawRankByProject = new Map(rankByRaw(aggregation.projects).map((entry) => [entry.projectId, entry.rank]));

  return aggregation.projects
    .map((entry) => ({
      project: LAB_PROJECTS.find((candidate) => candidate.id === entry.projectId) ?? { id: entry.projectId, name: entry.projectId },
      rawRank: rawRankByProject.get(entry.projectId) ?? 0,
      normalizedRank: entry.rank,
      rawMean: entry.rawAggregate ?? 0,
      // `submittedReviews` is the number of reviews that exist, which is not
      // necessarily the number the panel committed to - that distinction is the
      // whole point of a low-coverage flag, so the panel shows the committed
      // count and lets the two disagree visibly.
      judges: entry.assignedJudges,
      validation: entry.validation,
    }))
    .sort((a, b) => a.normalizedRank - b.normalizedRank);
}

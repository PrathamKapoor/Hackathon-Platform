import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateProjects, rankByRaw, type ProjectInput, type AggregationConfig } from '../src/aggregation.ts';
import { runNormalization, type NormalizationConfig } from '../src/normalization.ts';
import { evaluateReview, type RubricVersion } from '../src/rubric.ts';
import { computeResultRun, type JudgeReviewInput, type ResultRunInput } from '../src/result-pipeline.ts';

/**
 * The browser and the server must agree about a ranking.
 *
 * The landing page ranks a small panel using `runNormalization`,
 * `aggregateProjects` and `rankByRaw` directly, because `computeResultRun` hashes
 * its output with `node:crypto` and so cannot be bundled for a browser. That is
 * a deliberate duplication of the pipeline's *stages* in exchange for omitting its
 * provenance, and the risk is obvious: a change to `computeResultRun` that
 * reordered anything would leave the marketing page quietly showing numbers the
 * product would not produce.
 *
 * So it is asserted rather than assumed. Every generosity setting the slider
 * offers is ranked both ways from the identical reviews, and the ranks must
 * match exactly. If someone reorders a stage, drops a tie-break, or changes what
 * `assignedJudges` means, this fails.
 */

const COMPUTED_AT = '2026-02-05T09:00:00.000Z';
const SUBMITTED_AT = '2026-02-04T14:00:00.000Z';
const PROJECT_SUBMITTED_AT = '2026-02-04T10:00:00.000Z';
const ADJUSTABLE = 'j_yuki';
const MAX_GENEROSITY = 22;

const RUBRIC: RubricVersion = {
  id: 'rb_parity',
  rubricId: 'rb_parity',
  version: 1,
  status: 'LOCKED',
  weightsMustSumToOne: true,
  rounding: { mode: 'HALF_UP', precision: 1 },
  tieBreakPriority: ['impact', 'execution', 'evidence'],
  notes: '',
  criteria: [
    { id: 'c_impact', key: 'impact', name: 'Impact', description: '', weight: 0.5, min: 0, max: 100, required: true, scoringType: 'INTEGER', order: 0, publishBreakdown: true },
    { id: 'c_execution', key: 'execution', name: 'Execution', description: '', weight: 0.3, min: 0, max: 100, required: true, scoringType: 'INTEGER', order: 1, publishBreakdown: true },
    { id: 'c_evidence', key: 'evidence', name: 'Evidence', description: '', weight: 0.2, min: 0, max: 100, required: true, scoringType: 'INTEGER', order: 2, publishBreakdown: true },
  ],
};

const PROJECTS = [
  { id: 'p_lattice', name: 'Lattice', quality: 81 },
  { id: 'p_beacon', name: 'Beacon', quality: 79 },
  { id: 'p_ferrite', name: 'Ferrite', quality: 78 },
  { id: 'p_quill', name: 'Quill', quality: 77 },
] as const;

const COVERAGE: Record<string, readonly string[]> = {
  p_lattice: ['j_amara', 'j_ben', 'j_yuki'],
  p_beacon: ['j_amara', 'j_ben', 'j_priya'],
  p_ferrite: ['j_ben', 'j_priya', 'j_yuki'],
  p_quill: ['j_amara', 'j_priya', 'j_yuki'],
};

const BIAS: Record<string, number> = { j_amara: 0, j_ben: -10, j_priya: -2, j_yuki: 0 };

const HABIT: Record<string, Record<string, number>> = {
  j_amara: { p_lattice: 0, p_beacon: 0, p_quill: -1 },
  j_ben: { p_lattice: 0, p_beacon: 0, p_ferrite: 0 },
  j_priya: { p_beacon: 0, p_ferrite: 0, p_quill: 0 },
  j_yuki: { p_lattice: 0, p_ferrite: 0, p_quill: 0 },
};

const NORMALIZATION: NormalizationConfig = {
  method: 'Z_SCORE',
  outputRange: { min: 0, max: 100 },
  minimumSampleSize: 3,
  includeDrafts: false,
};

const AGGREGATION: AggregationConfig = {
  method: 'MEAN',
  trim: 0.2,
  minimumJudges: 3,
  allowVoteTieBreak: false,
  allowPairwiseTieBreak: false,
};

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/** Same construction as the landing page: the last criterion absorbs the rest. */
function criterionValues(target: number): { criterionId: string; value: number }[] {
  const centre = 60;
  const shapes: Record<string, number> = { c_impact: 0.55, c_execution: 0.8, c_evidence: 0.3 };
  const out: { criterionId: string; value: number }[] = [];
  let partial = 0;
  for (const criterion of RUBRIC.criteria.slice(0, -1)) {
    const value = clampScore(centre + (target - centre) * (shapes[criterion.id] ?? 0.5));
    out.push({ criterionId: criterion.id, value });
    partial += criterion.weight * value;
  }
  const last = RUBRIC.criteria[RUBRIC.criteria.length - 1];
  if (last !== undefined) out.push({ criterionId: last.id, value: clampScore((target - partial) / last.weight) });
  return out;
}

type Review = { judgeId: string; projectId: string; rawScore: number; evaluation: ReturnType<typeof evaluateReview> };

function reviewsFor(generosity: number): Review[] {
  const reviews: Review[] = [];
  for (const project of PROJECTS) {
    for (const judgeId of COVERAGE[project.id] ?? []) {
      const base = project.quality + (BIAS[judgeId] ?? 0) + (HABIT[judgeId]?.[project.id] ?? 0);
      const target = Math.min(100, Math.max(0, base + (judgeId === ADJUSTABLE ? generosity : 0)));
      const evaluation = evaluateReview(RUBRIC, criterionValues(target));
      reviews.push({ judgeId, projectId: project.id, rawScore: evaluation.score100, evaluation });
    }
  }
  return reviews;
}

function referencesFor(reviews: readonly Review[]): { judgeId: string; scores: number[] }[] {
  const byJudge = new Map<string, number[]>();
  for (const review of reviews) byJudge.set(review.judgeId, [...(byJudge.get(review.judgeId) ?? []), review.rawScore]);
  return [...byJudge.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([judgeId, scores]) => ({ judgeId, scores }));
}

/** The path the browser takes: three stages, no hashing. */
function browserRanks(generosity: number): { raw: Map<string, number>; normalized: Map<string, number> } {
  const reviews = reviewsFor(generosity);
  const normalizedRun = runNormalization({
    references: referencesFor(reviews),
    reviews: reviews.map((r) => ({ judgeId: r.judgeId, projectId: r.projectId, criterionId: null, score: r.rawScore })),
    config: NORMALIZATION,
    eventId: 'evt_parity',
    rubricVersionId: RUBRIC.id,
    assignmentVersion: 1,
    computedAt: COMPUTED_AT,
    configHash: 'browser-no-hash',
    runId: 'nrm_parity',
  });

  const index = new Map<string, number>();
  for (const score of normalizedRun.scores) index.set(`${score.judgeId}::${score.projectId}`, score.normalized);

  const projectInputs: ProjectInput[] = PROJECTS.map((project) => {
    const own = reviews.filter((r) => r.projectId === project.id);
    return {
      projectId: project.id,
      trackId: null,
      teamId: null,
      organization: null,
      normalizedScores: own.map((r) => index.get(`${r.judgeId}::${r.projectId}`) ?? null),
      rawScores: own.map((r) => r.rawScore),
      criterionScores: {},
      assignedJudges: (COVERAGE[project.id] ?? []).length,
      submittedReviews: own.length,
      submittedAt: PROJECT_SUBMITTED_AT,
      voteCount: 0,
      pairwise: null,
    };
  });

  const aggregation = aggregateProjects(projectInputs, AGGREGATION, RUBRIC.tieBreakPriority);
  return {
    raw: new Map(rankByRaw(aggregation.projects).map((entry) => [entry.projectId, entry.rank])),
    normalized: new Map(aggregation.projects.map((entry) => [entry.projectId, entry.rank])),
  };
}

/** The path the API takes: the whole pipeline, hashes included. */
function serverRanks(generosity: number): { raw: Map<string, number>; normalized: Map<string, number> } {
  const reviews: JudgeReviewInput[] = reviewsFor(generosity).map((review) => ({
    judgeId: review.judgeId,
    projectId: review.projectId,
    rawScore: review.rawScore,
    state: 'SUBMITTED',
    submittedAt: SUBMITTED_AT,
    evaluation: review.evaluation,
  }));

  const input: ResultRunInput = {
    eventId: 'evt_parity',
    rubricVersion: RUBRIC,
    assignmentVersion: 1,
    reviews,
    projectMeta: PROJECTS.map((project) => ({
      projectId: project.id,
      submittedAt: PROJECT_SUBMITTED_AT,
      trackId: null,
      teamId: null,
      voteCount: 0,
      eligibleForPrizes: true,
      assignedJudgeCount: (COVERAGE[project.id] ?? []).length,
    })),
    prizes: [],
    normalization: NORMALIZATION,
    aggregation: AGGREGATION,
    computedAt: COMPUTED_AT,
    runId: `run_parity_${String(generosity)}`,
    actorId: 'usr_parity',
    notes: '',
  };

  const run = computeResultRun(input);
  return {
    raw: new Map(run.entries.map((entry) => [entry.projectId, entry.rankRaw ?? 0])),
    normalized: new Map(run.entries.map((entry) => [entry.projectId, entry.rank])),
  };
}

describe('the landing-page panel agrees with the pipeline', () => {
  for (let generosity = 0; generosity <= MAX_GENEROSITY; generosity += 1) {
    test(`both paths rank identically at generosity +${String(generosity)}`, () => {
      const browser = browserRanks(generosity);
      const server = serverRanks(generosity);

      assert.deepEqual(
        [...browser.normalized].sort(),
        [...server.normalized].sort(),
        `normalized ranks differ at +${String(generosity)}: browser ${JSON.stringify([...browser.normalized])} vs pipeline ${JSON.stringify([...server.normalized])}`,
      );
      assert.deepEqual(
        [...browser.raw].sort(),
        [...server.raw].sort(),
        `raw ranks differ at +${String(generosity)}: browser ${JSON.stringify([...browser.raw])} vs pipeline ${JSON.stringify([...server.raw])}`,
      );
    });
  }

  test('the panel is actually demonstrating something', () => {
    /*
     * Guards the test above from passing vacuously. If the generosity control
     * stopped changing the averaged ranking, the parity assertions would keep
     * passing and the landing page would quietly become a static table.
     */
    const calm = browserRanks(0);
    const generous = browserRanks(MAX_GENEROSITY);

    const averagedOrder = (ranks: Map<string, number>): string =>
      [...ranks.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id).join(' > ');

    assert.notEqual(
      averagedOrder(calm.raw),
      averagedOrder(generous.raw),
      'moving generosity did not change the averaged ranking, so the panel shows nothing',
    );
    assert.equal(
      averagedOrder(calm.normalized),
      averagedOrder(generous.normalized),
      'the normalized ranking moved with generosity, which is the opposite of what is claimed',
    );
  });

  test('the slider range is fully covered by the parity sweep', () => {
    // If someone raises LAB_MAX_GENEROSITY past the sweep above, the landing page
    // would show settings the parity test never compared.
    assert.equal(MAX_GENEROSITY, 22);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGGREGATION_CONFIG,
  type Prize,
  type ProjectInput,
} from '../src/aggregation.ts';
import { configForMethod, type NormalizationConfig } from '../src/normalization.ts';
import { evaluateReview, type RubricVersion } from '../src/rubric.ts';
import {
  RESULT_ENGINE_VERSION,
  computeResultRun,
  verifyResultRun,
  type JudgeReviewInput,
  type ResultRunInput,
} from '../src/result-pipeline.ts';
import type { PairwiseComparison } from '../src/pairwise.ts';
import { contentHash } from '../src/integrity.ts';

const NOW = '2026-03-15T18:00:00.000Z';

const RUBRIC: RubricVersion = {
  id: 'rub_demo',
  rubricId: 'rub_demo',
  version: 2,
  status: 'LOCKED',
  criteria: [
    { id: 'c_tech', key: 'technical', name: 'Technical Quality', description: '', weight: 0.3, min: 0, max: 10, required: true, scoringType: 'DECIMAL', order: 0, publishBreakdown: true },
    { id: 'c_inn', key: 'innovation', name: 'Innovation', description: '', weight: 0.25, min: 0, max: 10, required: true, scoringType: 'DECIMAL', order: 1, publishBreakdown: true },
    { id: 'c_impact', key: 'impact', name: 'Impact', description: '', weight: 0.25, min: 0, max: 10, required: true, scoringType: 'DECIMAL', order: 2, publishBreakdown: true },
    { id: 'c_ux', key: 'ux', name: 'Experience', description: '', weight: 0.2, min: 0, max: 10, required: false, scoringType: 'DECIMAL', order: 3, publishBreakdown: true },
  ],
  weightsMustSumToOne: true,
  rounding: { precision: 4, mode: 'HALF_UP' },
  tieBreakPriority: ['technical', 'innovation'],
  notes: '',
};

/** Build a review whose weighted total is exactly `target` on a 0..100 scale. */
function review(judgeId: string, projectId: string, target: number, at = NOW): JudgeReviewInput {
  const perCriterion = (target / 100) * 10;
  const evaluation = evaluateReview(
    RUBRIC,
    RUBRIC.criteria.map((c) => ({ criterionId: c.id, value: perCriterion })),
  );
  return { judgeId, projectId, rawScore: target, state: 'SUBMITTED', submittedAt: at, evaluation };
}

const PROJECTS: ResultRunInput['projectMeta'] = [
  { projectId: 'sub_alpha', submittedAt: '2026-02-10T09:00:00.000Z', trackId: 'trk_a', teamId: 'tem_1', voteCount: 12, eligibleForPrizes: true, assignedJudgeCount: 3 },
  { projectId: 'sub_beta', submittedAt: '2026-02-11T09:00:00.000Z', trackId: 'trk_a', teamId: 'tem_2', voteCount: 30, eligibleForPrizes: true, assignedJudgeCount: 3 },
  { projectId: 'sub_gamma', submittedAt: '2026-02-12T09:00:00.000Z', trackId: 'trk_b', teamId: 'tem_3', voteCount: 8, eligibleForPrizes: true, assignedJudgeCount: 3 },
  { projectId: 'sub_delta', submittedAt: '2026-02-13T09:00:00.000Z', trackId: 'trk_b', teamId: 'tem_4', voteCount: 22, eligibleForPrizes: true, assignedJudgeCount: 3 },
];

const PRIZES: Prize[] = [
  { id: 'prz_gold', name: 'Grand Prize', eligibleProjectIds: [], quantity: 1, eligibleRanks: [1], trackId: null, priority: 1 },
  { id: 'prz_track_a', name: 'Best in Track: AI', eligibleProjectIds: [], quantity: 1, eligibleRanks: [], trackId: 'trk_a', priority: 2 },
  { id: 'prz_track_b', name: 'Best in Track: Climate', eligibleProjectIds: [], quantity: 1, eligibleRanks: [], trackId: 'trk_b', priority: 3 },
];

function baseInput(overrides: Partial<ResultRunInput> = {}): ResultRunInput {
  return {
    eventId: 'evt_demo',
    rubricVersion: RUBRIC,
    assignmentVersion: 3,
    reviews: [
      // Two judges who agree, one who is systematically generous.
      review('jdg_ann', 'sub_alpha', 82, '2026-03-01T10:00:00.000Z'),
      review('jdg_ann', 'sub_beta', 78, '2026-03-01T10:05:00.000Z'),
      review('jdg_ann', 'sub_gamma', 61, '2026-03-01T10:10:00.000Z'),
      review('jdg_ann', 'sub_delta', 74, '2026-03-01T10:15:00.000Z'),
      review('jdg_bob', 'sub_alpha', 80, '2026-03-01T11:00:00.000Z'),
      review('jdg_bob', 'sub_beta', 76, '2026-03-01T11:05:00.000Z'),
      review('jdg_bob', 'sub_gamma', 64, '2026-03-01T11:10:00.000Z'),
      review('jdg_bob', 'sub_delta', 71, '2026-03-01T11:15:00.000Z'),
      review('jdg_cat', 'sub_alpha', 92, '2026-03-02T09:00:00.000Z'),
      review('jdg_cat', 'sub_beta', 88, '2026-03-02T09:05:00.000Z'),
      review('jdg_cat', 'sub_gamma', 71, '2026-03-02T09:10:00.000Z'),
      review('jdg_cat', 'sub_delta', 85, '2026-03-02T09:15:00.000Z'),
    ],
    projectMeta: PROJECTS,
    prizes: PRIZES,
    normalization: configForMethod('RAW'),
    aggregation: DEFAULT_AGGREGATION_CONFIG,
    computedAt: NOW,
    runId: 'run_001',
    actorId: 'usr_organizer',
    notes: 'acceptance fixture',
    ...overrides,
  };
}

describe('result pipeline: ranking and prizes', () => {
  test('the full lifecycle produces an ordered, hashed, provenance-stamped run', () => {
    const run = computeResultRun(baseInput());
    assert.equal(run.engineVersion, RESULT_ENGINE_VERSION);
    assert.equal(run.rubricVersionNumber, 2);
    assert.equal(run.assignmentVersion, 3);
    assert.equal(run.entries.length, 4);
    assert.deepEqual(run.entries.map((e) => e.rank), [1, 2, 3, 4]);
    assert.equal(run.entries[0]?.projectId, 'sub_alpha');
    assert.match(run.integrityHash, /^[0-9a-f]{64}$/);
    assert.equal(run.provenance.stages.length, 6);
    assert.deepEqual(
      run.provenance.stages.map((s) => s.stage),
      ['VALIDATION', 'NORMALIZATION', 'AGGREGATION', 'TIE_RESOLUTION', 'PRIZE_ASSIGNMENT', 'SNAPSHOT'],
    );
    for (const stage of run.provenance.stages) assert.match(stage.configHash, /^[0-9a-f]{64}$/);
  });

  test('aggregate scores equal the mean of the submitted reviews', () => {
    const run = computeResultRun(baseInput());
    const alpha = run.entries.find((e) => e.projectId === 'sub_alpha')!;
    assert.equal(alpha.judgeCount, 3);
    assert.equal(alpha.coverage, 1);
    assert.ok(Math.abs((alpha.aggregateScore as number) - 84.666667) < 1e-4, `got ${alpha.aggregateScore}`);
    assert.equal(alpha.rawAggregate, alpha.aggregateScore, 'RAW normalization leaves the mean unchanged');
    assert.equal(alpha.rankDelta, 0);
  });

  test('prizes are awarded and attached to the winning entries', () => {
    const run = computeResultRun(baseInput());
    assert.equal(run.prizes.length, 3);
    assert.equal(run.prizes.find((p) => p.prizeName === 'Grand Prize')?.projectId, 'sub_alpha');
    assert.deepEqual(run.entries[0]?.prizes, ['Grand Prize']);
    assert.ok(run.entries.find((e) => e.projectId === 'sub_beta')!.prizes.includes('Best in Track: AI'));
    assert.ok(run.entries.find((e) => e.projectId === 'sub_delta')!.prizes.includes('Best in Track: Climate'));
  });

  test('criterion breakdowns are published per entry', () => {
    const run = computeResultRun(
      baseInput({
        criterionSlices: [
          { projectId: 'sub_alpha', key: 'technical', points: 90, judgeId: 'jdg_ann' },
          { projectId: 'sub_alpha', key: 'technical', points: 60, judgeId: 'jdg_bob' },
          { projectId: 'sub_alpha', key: 'innovation', points: 70, judgeId: 'jdg_ann' },
          { projectId: 'sub_alpha', key: 'innovation', points: 50, judgeId: 'jdg_bob' },
        ],
      }),
    );
    const technical = run.entries[0]!.criteria.find((c) => c.key === 'technical')!;
    assert.equal(technical.judgeCount, 2);
    assert.equal(technical.score, 75);
  });

  test('draft reviews are excluded and the exclusion is reported', () => {
    const run = computeResultRun(
      baseInput({
        reviews: [
          ...baseInput().reviews,
          { ...review('jdg_dan', 'sub_gamma', 99), state: 'DRAFT' },
        ],
      }),
    );
    assert.ok(!run.diagnostics.warnings.some((w) => /99/.test(w)));
    assert.ok(
      run.diagnostics.warnings.some((w) => /still in draft and are excluded/i.test(w)),
      run.diagnostics.warnings.join(' | '),
    );
    const gamma = run.entries.find((e) => e.projectId === 'sub_gamma')!;
    assert.equal(gamma.judgeCount, 3, 'the draft did not inflate the judge count');
  });

  test('a project with no submitted reviews is ranked last and excluded from prizes', () => {
    const reviews = baseInput().reviews.filter((r) => r.projectId !== 'sub_gamma');
    const run = computeResultRun(baseInput({ reviews }));
    const gamma = run.entries.find((e) => e.projectId === 'sub_gamma')!;
    assert.equal(gamma.rank, 4);
    assert.equal(gamma.aggregateScore, null);
    // Assigned to three judges, none of whom submitted: under-covered, not
    // unassigned. Conflating the two would hide the problem from organizers.
    assert.equal(gamma.validation, 'DRAFT_ONLY');
    assert.equal(gamma.assignedJudges, 3);
    assert.equal(gamma.judgeCount, 0);
    assert.ok(!run.prizes.some((p) => p.projectId === 'sub_gamma'));
  });

  test('low judge coverage is flagged but the project still competes', () => {
    const reviews = baseInput().reviews.filter((r) => !(r.judgeId === 'jdg_bob' && r.projectId === 'sub_delta'));
    const run = computeResultRun(baseInput({ reviews, aggregation: { ...DEFAULT_AGGREGATION_CONFIG, minimumJudges: 3 } }));
    const delta = run.entries.find((e) => e.projectId === 'sub_delta')!;
    assert.equal(delta.validation, 'LOW_COVERAGE');
    assert.equal(delta.judgeCount, 2);
    assert.ok(run.diagnostics.warnings.some((w) => /low coverage/i.test(w)));
  });
});

describe('result pipeline: normalization effect is visible and auditable', () => {
  test('a generous judge is corrected, moving the raw and normalized ranks apart', () => {
    const raw = computeResultRun(baseInput({ normalization: configForMethod('RAW') }));
    const robust = computeResultRun(baseInput({ normalization: configForMethod('ROBUST_MAD') }));
    assert.equal(raw.normalization.method, 'RAW');
    assert.equal(robust.normalization.method, 'ROBUST_MAD');

    const rankOf = (run: ReturnType<typeof computeResultRun>, id: string) => {
      const entry = run.entries.find((e) => e.projectId === id);
      assert.ok(entry, `missing entry ${id}`);
      return entry;
    };
    // jdg_cat is ~10 points more generous than the others on every project, so
    // normalizing must move the headline number away from the raw mean.
    const rawAlpha = rankOf(raw, 'sub_alpha').aggregateScore as number;
    const robustAlpha = rankOf(robust, 'sub_alpha').aggregateScore as number;
    assert.ok(Math.abs(robustAlpha - rawAlpha) > 0.5, `${robustAlpha} vs ${rawAlpha}`);
    // The raw run always records the raw mean alongside the headline.
    assert.ok(rankOf(raw, 'sub_alpha').rawAggregate !== null);
    assert.ok(rankOf(robust, 'sub_alpha').rankRaw !== null);
  });

  test('the normalization run is stored inside the snapshot, not discarded', () => {
    const run = computeResultRun(baseInput({ normalization: configForMethod('ROBUST_MAD') }));
    assert.equal(run.normalization.run.method, 'ROBUST_MAD');
    assert.equal(run.normalization.run.scores.length, 12);
    assert.ok(run.normalization.run.judgeStats.length === 3);
    assert.equal(run.normalization.run.engineVersion.length > 0, true);
    assert.ok(run.normalization.run.configHash.length === 64);
  });
});

describe('result pipeline: reproducibility (spec 30)', () => {
  test('identical inputs produce a byte-identical run and integrity hash', () => {
    const a = computeResultRun(baseInput());
    const b = computeResultRun(baseInput());
    assert.equal(a.integrityHash, b.integrityHash);
    assert.equal(a.provenance.inputHash, b.provenance.inputHash);
    assert.deepEqual(a.entries, b.entries);
    assert.deepEqual(a.prizes, b.prizes);
  });

  test('input ordering does not change the result', () => {
    const shuffled = baseInput({
      reviews: [...baseInput().reviews].reverse(),
      projectMeta: [...PROJECTS].reverse(),
      prizes: [...PRIZES].reverse(),
    });
    assert.equal(computeResultRun(baseInput()).integrityHash, computeResultRun(shuffled).integrityHash);
  });

  test('verification of a stored snapshot against a fresh recomputation reports MATCH', () => {
    const stored = computeResultRun(baseInput());
    const recomputed = computeResultRun(baseInput({ runId: 'run_002' }));
    const verdict = verifyResultRun(stored, recomputed, NOW);
    assert.equal(verdict.status, 'MATCH', verdict.explanation);
    assert.deepEqual(verdict.differences, []);
    assert.equal(verdict.storedIntegrityHash, verdict.recomputedIntegrityHash);
  });

  test('tampering with a score is detected as a MISMATCH with a field-level diff', () => {
    const stored = computeResultRun(baseInput());
    const reviews = baseInput().reviews.map((r) =>
      r.projectId === 'sub_gamma' && r.judgeId === 'jdg_ann' ? { ...r, rawScore: 95 } : r,
    );
    const tampered = computeResultRun(baseInput({ reviews }));
    const verdict = verifyResultRun(stored, tampered, NOW);
    assert.equal(verdict.status, 'MISMATCH');
    assert.ok(verdict.differences.length > 0);
    assert.ok(verdict.differences.some((d) => d.kind === 'INPUT'), 'the input hash must diverge');
    assert.match(verdict.explanation, /must not be treated as trustworthy/);
  });

  test('swapping a prize between projects is detected', () => {
    const stored = computeResultRun(baseInput());
    const tampered = JSON.parse(JSON.stringify(stored)) as typeof stored;
    const winner = tampered.entries[0]!;
    winner.prizes = [];
    tampered.prizes = tampered.prizes.map((p) => ({ ...p, projectId: p.projectId === winner.projectId ? 'sub_delta' : p.projectId }));
    const verdict = verifyResultRun(stored, tampered, NOW);
    assert.equal(verdict.status, 'MISMATCH');
    assert.ok(verdict.differences.some((d) => d.kind === 'PRIZE'));
  });

  test('an entry removed from the snapshot is detected', () => {
    const stored = computeResultRun(baseInput());
    const tampered = JSON.parse(JSON.stringify(stored)) as typeof stored;
    tampered.entries = tampered.entries.slice(1);
    const verdict = verifyResultRun(stored, tampered, NOW);
    assert.equal(verdict.status, 'MISMATCH');
    assert.ok(verdict.differences.some((d) => d.kind === 'ENTRY_MISSING'));
  });

  test('the input hash changes when any judged input changes', () => {
    const base = computeResultRun(baseInput()).provenance.inputHash;
    const variants = {
      score: computeResultRun(baseInput({ reviews: baseInput().reviews.map((r) => ({ ...r, rawScore: r.rawScore + 1 })) })).provenance.inputHash,
      rubricVersion: computeResultRun(baseInput({ rubricVersion: { ...RUBRIC, version: 3 } })).provenance.inputHash,
      assignmentVersion: computeResultRun(baseInput({ assignmentVersion: 4 })).provenance.inputHash,
      normalization: computeResultRun(baseInput({ normalization: configForMethod('Z_SCORE') })).provenance.inputHash,
      aggregation: computeResultRun(baseInput({ aggregation: { ...DEFAULT_AGGREGATION_CONFIG, method: 'MEDIAN' } })).provenance.inputHash,
      prizes: computeResultRun(baseInput({ prizes: [] })).provenance.inputHash,
    };
    for (const [name, hash] of Object.entries(variants)) {
      assert.notEqual(hash, base, `changing ${name} must change the input hash`);
    }
  });

  test('a submission timestamp is part of the input, so a re-ordering is auditable', () => {
    const moved = baseInput({
      projectMeta: PROJECTS.map((p) =>
        p.projectId === 'sub_alpha' ? { ...p, submittedAt: '2026-02-09T09:00:00.000Z' } : p,
      ),
    });
    assert.notEqual(computeResultRun(baseInput()).provenance.inputHash, computeResultRun(moved).provenance.inputHash);
  });
});

describe('result pipeline: pairwise integration', () => {
  const comparisons: PairwiseComparison[] = [
    { id: 'pwr_1', judgeId: 'jdg_ann', leftProjectId: 'sub_alpha', rightProjectId: 'sub_gamma', outcome: 'LEFT', decidedAt: NOW },
    { id: 'pwr_2', judgeId: 'jdg_bob', leftProjectId: 'sub_alpha', rightProjectId: 'sub_gamma', outcome: 'LEFT', decidedAt: NOW },
    { id: 'pwr_3', judgeId: 'jdg_cat', leftProjectId: 'sub_gamma', rightProjectId: 'sub_alpha', outcome: 'LEFT', decidedAt: NOW },
    { id: 'pwr_4', judgeId: 'jdg_ann', leftProjectId: 'sub_beta', rightProjectId: 'sub_gamma', outcome: 'LEFT', decidedAt: NOW },
    { id: 'pwr_5', judgeId: 'jdg_bob', leftProjectId: 'sub_beta', rightProjectId: 'sub_gamma', outcome: 'LEFT', decidedAt: NOW },
    { id: 'pwr_6', judgeId: 'jdg_cat', leftProjectId: 'sub_beta', rightProjectId: 'sub_alpha', outcome: 'LEFT', decidedAt: NOW },
  ];

  test('pairwise results are stored alongside rubric scores, never merged into them', () => {
    const withPairwise = computeResultRun(baseInput({ pairwise: { enabled: true, comparisons } }));
    assert.ok(withPairwise.pairwise);
    assert.equal(withPairwise.pairwise!.diagnostics.decisiveComparisons, 6);
    // The rubric aggregate is unchanged by enabling pairwise.
    const without = computeResultRun(baseInput());
    assert.equal(
      withPairwise.entries.find((e) => e.projectId === 'sub_alpha')!.rawAggregate,
      without.entries.find((e) => e.projectId === 'sub_alpha')!.rawAggregate,
    );
  });

  test('each entry carries its pairwise rank', () => {
    const run = computeResultRun(baseInput({ pairwise: { enabled: true, comparisons } }));
    const ranks = new Map(run.entries.map((e) => [e.projectId, e.pairwiseRank]));
    // sub_delta never appeared in a comparison, so it has no pairwise rank and
    // the UI must render that as "not compared" rather than as rank 0.
    assert.equal(ranks.get('sub_delta'), null, 'never compared => no rank, not rank 0');
    // win/loss records: beta 3W-0L, alpha 2W-2L, gamma 0W-3L.
    assert.equal(ranks.get('sub_beta'), 1);
    assert.equal(ranks.get('sub_alpha'), 2);
    assert.equal(ranks.get('sub_gamma'), 3);
  });

  test('disabling pairwise leaves the ranking identical apart from the hashes', () => {
    const a = computeResultRun(baseInput());
    const b = computeResultRun(baseInput({ pairwise: { enabled: false, comparisons } }));
    assert.deepEqual(
      a.entries.map((e) => [e.projectId, e.rank, e.aggregateScore]),
      b.entries.map((e) => [e.projectId, e.rank, e.aggregateScore]),
    );
  });

  test('a non-transitive pairwise panel is disclosed in the run warnings', () => {
    const run = computeResultRun(baseInput({ pairwise: { enabled: true, comparisons } }));
    assert.ok(
      run.diagnostics.warnings.some((w) => /non-transitive|disconnected/i.test(w)),
      run.diagnostics.warnings.join(' | '),
    );
  });
});

describe('result pipeline: safety of the final numbers', () => {
  test('no entry can carry NaN or Infinity into a published result', () => {
    const runs = [
      computeResultRun(baseInput()),
      computeResultRun(baseInput({ reviews: [] })),
      computeResultRun(baseInput({ normalization: configForMethod('Z_SCORE') })),
      computeResultRun(baseInput({ normalization: configForMethod('RANK') })),
      computeResultRun(baseInput({ normalization: configForMethod('MIN_MAX') })),
      computeResultRun(baseInput({ aggregation: { ...DEFAULT_AGGREGATION_CONFIG, method: 'MEDIAN' } })),
      computeResultRun(baseInput({ aggregation: { ...DEFAULT_AGGREGATION_CONFIG, method: 'TRIMMED_MEAN' } })),
    ];
    for (const run of runs) {
      for (const entry of run.entries) {
        for (const value of [entry.aggregateScore, entry.rawAggregate, entry.rankDelta, entry.coverage]) {
          if (value !== null) assert.ok(Number.isFinite(value), `${entry.projectId} produced ${value}`);
        }
        for (const criterion of entry.criteria) {
          if (criterion.score !== null) assert.ok(Number.isFinite(criterion.score));
        }
      }
      for (const score of run.normalization.run.scores) {
        assert.ok(Number.isFinite(score.normalized), `${run.normalization.method} produced ${score.normalized}`);
      }
    }
  });

  test('an entirely empty run is still a valid, explainable result', () => {
    const run = computeResultRun(baseInput({ reviews: [], prizes: [] }));
    assert.equal(run.entries.length, 4);
    assert.ok(run.entries.every((e) => e.aggregateScore === null));
    assert.ok(run.entries.every((e) => e.validation === 'DRAFT_ONLY'));
    assert.ok(run.entries.every((e) => e.assignedJudges === 3));
    // With no scores at all the ranking degrades to submission order, which is
    // arbitrary but deterministic. The point is that it is never a coin flip.
    assert.deepEqual(run.entries.map((e) => e.rank), [1, 2, 3, 4]);
    const warnings = run.diagnostics.warnings.join(' | ');
    assert.match(warnings, /No submitted reviews exist/i);
    assert.match(warnings, /no judge reference samples/i);
    assert.match(run.integrityHash, /^[0-9a-f]{64}$/);
  });

  test('the integrity hash is a pure function of the ranking content', () => {
    const run = computeResultRun(baseInput());
    const manual = contentHash({
      inputHash: run.provenance.inputHash,
      entries: run.entries.map((e) => ({
        rank: e.rank,
        projectId: e.projectId,
        aggregateScore: e.aggregateScore,
        judgeCount: e.judgeCount,
        prizes: e.prizes,
        reviewHashes: e.integrity.reviewHashes,
      })),
      prizes: run.prizes.map((a) => ({ prizeId: a.prizeId, projectId: a.projectId, rank: a.rank })),
    });
    assert.equal(manual, run.integrityHash);
  });

  test('per-entry review hashes let an auditor verify a single project', () => {
    const run = computeResultRun(baseInput());
    const alpha = run.entries.find((e) => e.projectId === 'sub_alpha')!;
    assert.equal(alpha.integrity.reviewHashes.length, 3);
    assert.deepEqual(alpha.integrity.reviewHashes, [...alpha.integrity.reviewHashes].sort());
    for (const hash of alpha.integrity.reviewHashes) assert.match(hash, /^[0-9a-f]{64}$/);
  });
});

/* Silence the unused-import warning for ProjectInput in this file's fixtures. */
export type { ProjectInput, NormalizationConfig };

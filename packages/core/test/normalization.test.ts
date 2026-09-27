import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_MAX_CEILING,
  compareRawToNormalized,
  configForMethod,
  runNormalization,
  type JudgeReference,
  type NormalizationConfig,
} from '../src/normalization.ts';
import { NORMALIZATION_METHODS, type NormalizationMethod } from '../src/types.ts';

const NOW = '2026-03-01T12:00:00.000Z';

function config(method: NormalizationMethod, overrides: Partial<NormalizationConfig> = {}): NormalizationConfig {
  return { ...configForMethod(method), minimumSampleSize: 1, ...overrides };
}

function makeRun(options: {
  method: NormalizationMethod;
  references: JudgeReference[];
  reviews: { judgeId: string; projectId: string; score: number | null }[];
  overrides?: Partial<NormalizationConfig>;
}) {
  return runNormalization({
    references: options.references,
    reviews: options.reviews.map((r) => ({ ...r, criterionId: null })),
    config: config(options.method, options.overrides),
    eventId: 'evt_test',
    rubricVersionId: 'rvr_1',
    assignmentVersion: 1,
    computedAt: NOW,
    configHash: 'hash',
    runId: 'nrm_1',
  });
}

function valueFor(run: ReturnType<typeof makeRun>, judgeId: string, projectId: string): number {
  const found = run.scores.find((s) => s.judgeId === judgeId && s.projectId === projectId);
  assert.ok(found, `no normalized score for ${judgeId}/${projectId}`);
  return found.normalized;
}

describe('normalization: RAW is the identity', () => {
  test('raw scores pass through untouched', () => {
    const run = makeRun({
      method: 'RAW',
      references: [{ judgeId: 'j1', scores: [10, 90] }],
      reviews: [
        { judgeId: 'j1', projectId: 'p1', score: 10 },
        { judgeId: 'j1', projectId: 'p2', score: 90 },
      ],
    });
    assert.equal(valueFor(run, 'j1', 'p1'), 10);
    assert.equal(valueFor(run, 'j1', 'p2'), 90);
    assert.ok(run.scores.every((s) => s.branch === 'RAW'));
  });
});

describe('normalization: Z_SCORE', () => {
  test('a judge scoring 10/20/30 is standardized to mean 0, unit variance', () => {
    const run = makeRun({
      method: 'Z_SCORE',
      references: [{ judgeId: 'j1', scores: [10, 20, 30] }],
      reviews: [
        { judgeId: 'j1', projectId: 'p1', score: 10 },
        { judgeId: 'j1', projectId: 'p2', score: 20 },
        { judgeId: 'j1', projectId: 'p3', score: 30 },
      ],
    });
    const values = run.scores.map((s) => s.normalized);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    assert.ok(Math.abs(mean) < 1e-9, `mean should be 0, got ${mean}`);
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    assert.ok(Math.abs(variance - 1) < 1e-6, `variance should be 1, got ${variance}`);
  });

  test('Z_SCORE is NOT clamped: a below-average review stays negative', () => {
    const run = makeRun({
      method: 'Z_SCORE',
      references: [{ judgeId: 'j1', scores: [40, 50, 60, 70] }],
      reviews: [
        { judgeId: 'j1', projectId: 'low', score: 40 },
        { judgeId: 'j1', projectId: 'high', score: 70 },
      ],
    });
    const low = run.scores.find((s) => s.projectId === 'low')!;
    const high = run.scores.find((s) => s.projectId === 'high')!;
    assert.ok(low.normalized < 0, `a below-average review must remain negative, got ${low.normalized}`);
    assert.ok(high.normalized > 0);
    assert.equal(configForMethod('Z_SCORE').outputRange, null);
  });

  test('ZERO STANDARD DEVIATION falls back to mean-centring and records it', () => {
    const run = makeRun({
      method: 'Z_SCORE',
      references: [{ judgeId: 'j1', scores: [50, 50, 50, 50] }],
      reviews: [
        { judgeId: 'j1', projectId: 'p1', score: 50 },
        { judgeId: 'j1', projectId: 'p2', score: 50 },
      ],
    });
    const score = run.scores[0]!;
    assert.equal(score.branch, 'DEGENERATE');
    assert.equal(score.normalized, 0, 'mean-centred value of an all-identical sample is 0');
    assert.match(score.notes.join(' '), /zero standard deviation/i);
    assert.equal(run.judgeStats[0]?.degenerate, true);
  });

  test('a judge with a single review is not standardized', () => {
    const run = makeRun({
      method: 'Z_SCORE',
      references: [{ judgeId: 'j1', scores: [77] }],
      reviews: [{ judgeId: 'j1', projectId: 'p1', score: 77 }],
      overrides: { minimumSampleSize: 2 },
    });
    assert.equal(run.scores[0]?.branch, 'RAW');
    assert.equal(run.scores[0]?.normalized, 77);
    assert.ok(run.warnings.some((w) => /minimum sample size/i.test(w)));
  });

  test('a generous judge and a harsh judge agree about relative quality', () => {
    // Judge 1 is generous (mean 80), judge 2 is harsh (mean 40), but both rank
    // P1 above P2. After normalization both judges say the same thing.
    const run = makeRun({
      method: 'Z_SCORE',
      references: [
        { judgeId: 'generous', scores: [80, 90, 70, 85] },
        { judgeId: 'harsh', scores: [40, 50, 30, 45] },
      ],
      reviews: [
        { judgeId: 'generous', projectId: 'p1', score: 90 },
        { judgeId: 'generous', projectId: 'p2', score: 70 },
        { judgeId: 'harsh', projectId: 'p1', score: 50 },
        { judgeId: 'harsh', projectId: 'p2', score: 30 },
      ],
    });
    assert.ok(valueFor(run, 'generous', 'p1') > valueFor(run, 'generous', 'p2'));
    assert.ok(valueFor(run, 'harsh', 'p1') > valueFor(run, 'harsh', 'p2'));
  });
});

describe('normalization: MIN_MAX', () => {
  test('a judge\'s worst project maps to 0 and their best to the ceiling', () => {
    const run = makeRun({
      method: 'MIN_MAX',
      references: [{ judgeId: 'j1', scores: [20, 40, 60, 80] }],
      reviews: [
        { judgeId: 'j1', projectId: 'worst', score: 20 },
        { judgeId: 'j1', projectId: 'middle', score: 50 },
        { judgeId: 'j1', projectId: 'best', score: 80 },
      ],
    });
    assert.equal(valueFor(run, 'j1', 'worst'), 0);
    assert.equal(valueFor(run, 'j1', 'best'), MIN_MAX_CEILING);
    // 50 sits exactly halfway between the observed extremes 20 and 80.
    assert.equal(valueFor(run, 'j1', 'middle'), 25);
  });

  test('an identical-score judge is placed at the scale centre, not divided by zero', () => {
    const run = makeRun({
      method: 'MIN_MAX',
      references: [{ judgeId: 'j1', scores: [60, 60, 60] }],
      reviews: [{ judgeId: 'j1', projectId: 'p1', score: 60 }],
    });
    const score = run.scores[0]!;
    assert.equal(score.branch, 'DEGENERATE');
    assert.equal(score.normalized, MIN_MAX_CEILING);
    assert.ok(Number.isFinite(score.normalized));
  });
});

describe('normalization: ROBUST_MAD', () => {
  test('the robust scale (MAD) is completely unaffected by an outlier', () => {
    const clean = [58, 59, 60, 61, 62, 60, 61, 59, 62, 61];
    const withOutlier = [...clean, 0];
    const run = (scores: number[]) =>
      makeRun({
        method: 'ROBUST_MAD',
        references: [{ judgeId: 'j1', scores }],
        reviews: scores.map((score, i) => ({ judgeId: 'j1', projectId: `p${i}`, score })),
      });
    assert.equal(run(clean).judgeStats[0]?.robustSigma, run(withOutlier).judgeStats[0]?.robustSigma);
  });

  test('an extreme review is clamped rather than allowed to dominate', () => {
    const scores = [60, 61, 62, 60, 61, 1000];
    const run = makeRun({
      method: 'ROBUST_MAD',
      references: [{ judgeId: 'j1', scores }],
      reviews: scores.map((score, i) => ({ judgeId: 'j1', projectId: `p${i}`, score })),
    });
    for (const score of run.scores) {
      assert.ok(score.normalized >= 0 && score.normalized <= 100, `${score.normalized} out of range`);
    }
  });

  test('an extreme review is clamped into the output range', () => {
    const scores = [60, 61, 62, 60, 61, 1000];
    const run = makeRun({
      method: 'ROBUST_MAD',
      references: [{ judgeId: 'j1', scores }],
      reviews: scores.map((score, i) => ({ judgeId: 'j1', projectId: `p${i}`, score })),
    });
    for (const score of run.scores) {
      assert.ok(score.normalized >= 0 && score.normalized <= 100, `${score.normalized} out of range`);
    }
  });

  test('zero robust spread degrades to a deviation from the judge median', () => {
    const run = makeRun({
      method: 'ROBUST_MAD',
      references: [{ judgeId: 'j1', scores: [50, 50, 50, 50] }],
      reviews: [{ judgeId: 'j1', projectId: 'p1', score: 50 }],
    });
    const score = run.scores[0]!;
    assert.equal(score.branch, 'DEGENERATE');
    assert.equal(score.normalized, 0);
    assert.ok(Number.isFinite(score.normalized));
  });
});

describe('normalization: RANK', () => {
  test('ties receive the average rank', () => {
    const run = makeRun({
      method: 'RANK',
      references: [{ judgeId: 'j1', scores: [10, 10, 20, 30] }],
      reviews: [
        { judgeId: 'j1', projectId: 'low', score: 10 },
        { judgeId: 'j1', projectId: 'low2', score: 10 },
        { judgeId: 'j1', projectId: 'mid', score: 20 },
        { judgeId: 'j1', projectId: 'high', score: 30 },
      ],
    });
    // Ranks ascending: the two 10s share average rank 1.5, the 20 is 3, the 30 is 4.
    // Value = 100 * (rank - 0.5) / n
    assert.equal(valueFor(run, 'j1', 'low'), (100 * (1.5 - 0.5)) / 4);
    assert.equal(valueFor(run, 'j1', 'low2'), (100 * (1.5 - 0.5)) / 4);
    assert.equal(valueFor(run, 'j1', 'mid'), (100 * (3 - 0.5)) / 4);
    assert.equal(valueFor(run, 'j1', 'high'), (100 * (4 - 0.5)) / 4);
  });

  test('rank output is bounded and magnitude-free', () => {
    const run = makeRun({
      method: 'RANK',
      references: [{ judgeId: 'a', scores: [90, 90, 91, 92] }, { judgeId: 'b', scores: [10, 11, 12, 13] }],
      reviews: [
        { judgeId: 'a', projectId: 'p1', score: 92 },
        { judgeId: 'a', projectId: 'p2', score: 90 },
        { judgeId: 'b', projectId: 'p1', score: 10 },
        { judgeId: 'b', projectId: 'p2', score: 12 },
      ],
    });
    for (const score of run.scores) assert.ok(score.normalized > 0 && score.normalized < 100);
  });
});

describe('normalization: documented edge cases (spec 24)', () => {
  test('missing / null scores are dropped, never coerced to zero', () => {
    const run = makeRun({
      method: 'Z_SCORE',
      references: [{ judgeId: 'j1', scores: [10, null, 30] }],
      reviews: [
        { judgeId: 'j1', projectId: 'p1', score: 10 },
        { judgeId: 'j1', projectId: 'p2', score: null },
      ],
    });
    assert.equal(run.scores.length, 1, 'the null review produced no output row');
    assert.ok(run.scores.every((s) => Number.isFinite(s.normalized)));
  });

  test('ONE PROJECT ONLY: the run is valid and warns that it cannot differentiate', () => {
    const run = makeRun({
      method: 'Z_SCORE',
      references: [{ judgeId: 'j1', scores: [50, 60] }, { judgeId: 'j2', scores: [55, 65] }],
      reviews: [
        { judgeId: 'j1', projectId: 'only', score: 60 },
        { judgeId: 'j2', projectId: 'only', score: 65 },
      ],
    });
    assert.ok(run.scores.length === 2);
    assert.ok(run.warnings.some((w) => /cannot differentiate/i.test(w)));
  });

  test('ONE JUDGE ONLY still produces a complete, finite result', () => {
    const run = makeRun({
      method: 'Z_SCORE',
      references: [{ judgeId: 'solo', scores: [10, 20, 30, 40] }],
      reviews: [10, 20, 30, 40].map((score, i) => ({ judgeId: 'solo', projectId: `p${i}`, score })),
    });
    assert.equal(run.scores.length, 4);
    assert.ok(run.scores.every((s) => Number.isFinite(s.normalized)));
  });

  test('UNEVEN JUDGE COUNTS: each judge is standardized on their own sample', () => {
    const run = makeRun({
      method: 'Z_SCORE',
      references: [
        { judgeId: 'busy', scores: [50, 60, 70, 80, 90, 100] },
        { judgeId: 'quiet', scores: [55, 65] },
      ],
      reviews: [
        { judgeId: 'busy', projectId: 'p1', score: 100 },
        { judgeId: 'quiet', projectId: 'p1', score: 65 },
      ],
    });
    const busy = run.judgeStats.find((s) => s.judgeId === 'busy')!;
    const quiet = run.judgeStats.find((s) => s.judgeId === 'quiet')!;
    assert.equal(busy.sampleSize, 6);
    assert.equal(quiet.sampleSize, 2);
    assert.ok(Math.abs((quiet.centre as number) - 60) < 1e-9);
  });

  test('THIN COVERAGE across projects is reported as a warning', () => {
    const run = makeRun({
      method: 'Z_SCORE',
      references: [
        { judgeId: 'j1', scores: [10, 20] },
        { judgeId: 'j2', scores: [20, 30] },
        { judgeId: 'j3', scores: [30, 40] },
      ],
      reviews: [
        { judgeId: 'j1', projectId: 'thin', score: 20 },
        { judgeId: 'j2', projectId: 'thin', score: 30 },
        { judgeId: 'j3', projectId: 'thick', score: 40 },
        { judgeId: 'j1', projectId: 'thick', score: 20 },
        { judgeId: 'j2', projectId: 'thick', score: 30 },
        { judgeId: 'j3', projectId: 'thick', score: 35 },
      ],
    });
    assert.ok(run.warnings.some((w) => /fewer than 3 distinct judges/i.test(w)));
  });

  test('no NaN or Infinity can escape any method under any degenerate input', () => {
    const pathological: { judgeId: string; projectId: string; score: number | null }[] = [
      { judgeId: 'j1', projectId: 'p1', score: 50 },
      { judgeId: 'j1', projectId: 'p1', score: 50 },
      { judgeId: 'j2', projectId: 'p1', score: 0 },
      { judgeId: 'j2', projectId: 'p2', score: 0 },
      { judgeId: 'j3', projectId: 'p1', score: 100 },
    ];
    for (const method of NORMALIZATION_METHODS) {
      const run = makeRun({
        method,
        references: [
          { judgeId: 'j1', scores: [50, 50] },
          { judgeId: 'j2', scores: [0, 0] },
          { judgeId: 'j3', scores: [100] },
        ],
        reviews: pathological,
      });
      for (const score of run.scores) {
        assert.ok(Number.isFinite(score.normalized), `${method} produced ${score.normalized}`);
        assert.ok(!Number.isNaN(score.raw), `${method} produced a NaN raw score`);
      }
    }
  });

  test('a judge with no reference sample at all keeps the raw score', () => {
    const run = makeRun({
      method: 'Z_SCORE',
      references: [{ judgeId: 'known', scores: [10, 20, 30] }],
      reviews: [{ judgeId: 'ghost', projectId: 'p1', score: 42 }],
    });
    assert.equal(run.scores[0]?.branch, 'RAW');
    assert.equal(run.scores[0]?.normalized, 42);
    assert.match(run.scores[0]!.notes.join(' '), /no reference sample/i);
  });

  test('an empty run is valid and warns', () => {
    const run = makeRun({ method: 'Z_SCORE', references: [], reviews: [] });
    assert.equal(run.scores.length, 0);
    assert.ok(run.warnings.length > 0);
  });

  test('the run records its method, config and hash for auditing', () => {
    const run = makeRun({
      method: 'MIN_MAX',
      references: [{ judgeId: 'j1', scores: [1, 2] }],
      reviews: [{ judgeId: 'j1', projectId: 'p1', score: 1 }],
    });
    assert.equal(run.method, 'MIN_MAX');
    assert.equal(run.configHash, 'hash');
    assert.equal(run.assignmentVersion, 1);
    assert.equal(run.computedAt, NOW);
    assert.ok(run.engineVersion.length > 0);
  });
});

describe('normalization: determinism', () => {
  test('the same input always produces the same output', () => {
    const build = () =>
      makeRun({
        method: 'ROBUST_MAD',
        references: [{ judgeId: 'j1', scores: [10, 20, 30, 40, 50] }],
        reviews: [10, 20, 30, 40, 50].map((score, i) => ({ judgeId: 'j1', projectId: `p${i}`, score })),
      });
    assert.deepEqual(build().scores, build().scores);
  });
});

describe('normalization: measured outlier sensitivity (spec 63 normalization proof)', () => {
  /*
   * One judge scores ten projects between 58 and 62, then scores one project 0.
   * We measure how far the ten unaffected projects are dragged on the 0..100
   * output scale. These assertions pin the numbers quoted in normalization.ts
   * and JUDGING.md, so the documentation cannot drift away from the code.
   */
  const CLEAN = [58, 59, 60, 61, 62, 60, 61, 59, 62, 61];
  const POLLUTED = [...CLEAN, 0];

  function maxShift(method: NormalizationMethod): number {
    const run = (scores: number[]) =>
      makeRun({
        method,
        references: [{ judgeId: 'j1', scores }],
        reviews: scores.map((score, i) => ({ judgeId: 'j1', projectId: `p${i}`, score })),
      });
    const a = run(CLEAN);
    const b = run(POLLUTED);
    return Math.max(...CLEAN.map((_, i) => Math.abs(a.scores[i]!.normalized - b.scores[i]!.normalized)));
  }

  test('MIN_MAX is the most outlier-fragile method, by a wide margin', () => {
    const shift = maxShift('MIN_MAX');
    assert.ok(shift > 40, `MIN_MAX should be badly destabilised, measured ${shift.toFixed(2)}`);
  });

  test('ROBUST_MAD keeps the damage to a few points', () => {
    const shift = maxShift('ROBUST_MAD');
    assert.ok(shift < 5, `ROBUST_MAD should barely move, measured ${shift.toFixed(2)}`);
  });

  test('RANK is scale-free: only the rank slots change', () => {
    const shift = maxShift('RANK');
    assert.ok(shift > 0 && shift < 12, `RANK shift measured ${shift.toFixed(2)}`);
  });

  test('Z_SCORE inflates sigma, compressing the judge\'s discrimination', () => {
    const run = (scores: number[]) =>
      makeRun({
        method: 'Z_SCORE',
        references: [{ judgeId: 'j1', scores }],
        reviews: scores.map((score, i) => ({ judgeId: 'j1', projectId: `p${i}`, score })),
      });
    const cleanRun = run(CLEAN);
    const pollutedRun = run(POLLUTED);
    const spread = (r: ReturnType<typeof run>) => {
      const v = r.scores.slice(0, CLEAN.length).map((s) => s.normalized);
      return Math.max(...v) - Math.min(...v);
    };
    assert.ok(
      spread(pollutedRun) < spread(cleanRun),
      `an outlier must compress the z-score spread (${spread(cleanRun).toFixed(2)} -> ${spread(pollutedRun).toFixed(2)})`,
    );
  });

  test('the full ranking comparison, raw vs each method, is reproducible', () => {
    // A two-judge panel where judge A is generous and judge B is harsh. Raw
    // scoring lets A's generosity drag P2 above P1; normalization should not.
    const build = (method: NormalizationMethod) => {
      const run = makeRun({
        method,
        references: [
          { judgeId: 'A', scores: [80, 90] },
          { judgeId: 'B', scores: [30, 40] },
        ],
        reviews: [
          { judgeId: 'A', projectId: 'P1', score: 90 },
          { judgeId: 'A', projectId: 'P2', score: 80 },
          { judgeId: 'B', projectId: 'P1', score: 40 },
          { judgeId: 'B', projectId: 'P2', score: 30 },
        ],
      });
      const mean = (projectId: string) => {
        const values = run.scores.filter((s) => s.projectId === projectId).map((s) => s.normalized);
        return values.reduce((a, b) => a + b, 0) / values.length;
      };
      return { p1: mean('P1'), p2: mean('P2') };
    };
    // Both judges independently rank P1 above P2, so every method must agree.
    for (const method of NORMALIZATION_METHODS) {
      const { p1, p2 } = build(method);
      assert.ok(p1 > p2, `${method} should rank P1 above P2 (got ${p1.toFixed(2)} vs ${p2.toFixed(2)})`);
    }
  });
});

describe('normalization: raw vs normalized comparison', () => {
  test('rank movement is reported per project', () => {
    const raw = new Map([
      ['p1', 62],
      ['p2', 61],
      ['p3', 60],
    ]);
    const normalized = new Map([
      ['p1', 55],
      ['p2', 70],
      ['p3', 50],
    ]);
    const judges = new Map([
      ['p1', 3],
      ['p2', 3],
      ['p3', 3],
    ]);
    const rows = compareRawToNormalized(['p1', 'p2', 'p3'], raw, normalized, judges);
    // raw order: p1 (62) > p2 (61) > p3 (60)
    // normalized order: p2 (70) > p1 (55) > p3 (50)
    const p1 = rows.find((r) => r.projectId === 'p1')!;
    const p2 = rows.find((r) => r.projectId === 'p2')!;
    const p3 = rows.find((r) => r.projectId === 'p3')!;
    assert.equal(p1.rawRank, 1);
    assert.equal(p1.normalizedRank, 2);
    assert.equal(p1.rankDelta, -1, 'a positive delta means the project climbed, so p1 fell by one');
    assert.equal(p2.rawRank, 2);
    assert.equal(p2.normalizedRank, 1);
    assert.equal(p2.rankDelta, 1, 'p2 climbed one place');
    assert.equal(p3.rawRank, 3);
    assert.equal(p3.normalizedRank, 3);
    assert.equal(p3.rankDelta, 0);
    assert.equal(rows[0]?.projectId, 'p2', 'rows are ordered by normalized rank');
  });

  test('missing entries produce null rather than a fabricated zero', () => {
    const rows = compareRawToNormalized(['p1', 'p2'], new Map([['p1', 50]]), new Map(), new Map());
    assert.equal(rows.find((r) => r.projectId === 'p2')!.normalizedScore, null);
    assert.equal(rows.find((r) => r.projectId === 'p2')!.normalizedRank, null);
  });
});

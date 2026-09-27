import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGGREGATION_CONFIG,
  aggregateProjects,
  assignPrizes,
  rankingConfidence,
  type Prize,
  type ProjectInput,
} from '../src/aggregation.ts';
import { buildPairSchedule, fitBradleyTerry, type PairwiseComparison } from '../src/pairwise.ts';
import {
  generateAssignmentPreview,
  type ConflictDeclaration,
  type JudgeCandidate,
  type ProjectCandidate,
} from '../src/assignment.ts';
import { THRESHOLDS, computeDiagnostics, diagnoseJudge, diagnoseVoting, type ReviewRecord } from '../src/diagnostics.ts';

const NOW = '2026-03-01T12:00:00.000Z';

function project(overrides: Partial<ProjectInput> & { projectId: string }): ProjectInput {
  return {
    trackId: null,
    teamId: null,
    organization: null,
    normalizedScores: [],
    rawScores: [],
    criterionScores: {},
    assignedJudges: 0,
    submittedReviews: 0,
    submittedAt: '2026-02-01T00:00:00.000Z',
    voteCount: 0,
    pairwise: null,
    ...overrides,
  };
}

describe('aggregation: core behaviour', () => {
  test('the mean of normalized scores is the aggregate', () => {
    const result = aggregateProjects([
      project({ projectId: 'p1', normalizedScores: [60, 70, 80], rawScores: [60, 70, 80], assignedJudges: 3, submittedReviews: 3 }),
    ]);
    assert.equal(result.projects[0]?.aggregateScore, 70);
    assert.equal(result.projects[0]?.rank, 1);
  });

  test('projects are ranked by aggregate score descending', () => {
    const result = aggregateProjects([
      project({ projectId: 'low', normalizedScores: [10, 20], assignedJudges: 2, submittedReviews: 2 }),
      project({ projectId: 'high', normalizedScores: [90, 95], assignedJudges: 2, submittedReviews: 2 }),
      project({ projectId: 'mid', normalizedScores: [50, 55], assignedJudges: 2, submittedReviews: 2 }),
    ]);
    assert.deepEqual(result.projects.map((p) => p.projectId), ['high', 'mid', 'low']);
    assert.deepEqual(result.projects.map((p) => p.rank), [1, 2, 3]);
  });

  test('MEDIAN and TRIMMED_MEAN aggregation methods are honoured', () => {
    const projects = [project({ projectId: 'p1', normalizedScores: [10, 20, 30, 90], assignedJudges: 4, submittedReviews: 4 })];
    assert.equal(aggregateProjects(projects, { ...DEFAULT_AGGREGATION_CONFIG, method: 'MEDIAN' }).projects[0]?.aggregateScore, 25);
    assert.equal(aggregateProjects(projects, { ...DEFAULT_AGGREGATION_CONFIG, method: 'TRIMMED_MEAN', trim: 0.25 }).projects[0]?.aggregateScore, 25);
    assert.equal(aggregateProjects(projects, { ...DEFAULT_AGGREGATION_CONFIG, method: 'MEAN' }).projects[0]?.aggregateScore, 37.5);
  });

  test('a project with no reviews is ranked last and marked, never dropped', () => {
    const result = aggregateProjects([
      project({ projectId: 'empty', normalizedScores: [], rawScores: [], assignedJudges: 2, submittedReviews: 0 }),
      project({ projectId: 'scored', normalizedScores: [50], rawScores: [50], assignedJudges: 1, submittedReviews: 1 }),
    ]);
    assert.equal(result.projects.length, 2);
    assert.equal(result.projects[0]?.projectId, 'scored');
    const empty = result.projects[1]!;
    assert.equal(empty.projectId, 'empty');
    assert.equal(empty.validation, 'DRAFT_ONLY');
    assert.equal(empty.aggregateScore, null);
    assert.ok(result.excludedProjectIds.includes('empty'));
  });

  test('low coverage is flagged but the project is still ranked', () => {
    const result = aggregateProjects(
      [project({ projectId: 'thin', normalizedScores: [80], rawScores: [80], assignedJudges: 5, submittedReviews: 1 })],
      { ...DEFAULT_AGGREGATION_CONFIG, minimumJudges: 3 },
    );
    const entry = result.projects[0]!;
    assert.equal(entry.validation, 'LOW_COVERAGE');
    assert.equal(entry.rank, 1, 'a thinly covered project is still ranked, with a warning');
    assert.ok(result.warnings.some((w) => /low coverage/i.test(w)));
  });

  test('criterion aggregates are computed with the same method as the headline', () => {
    const result = aggregateProjects([
      project({
        projectId: 'p1',
        normalizedScores: [70],
        rawScores: [70],
        assignedJudges: 1,
        submittedReviews: 1,
        criterionScores: { technical: [8, 6, 10], innovation: [5, 5] },
      }),
    ]);
    const technical = result.projects[0]!.criterionAggregates.find((c) => c.key === 'technical')!;
    assert.equal(technical.score, 8);
    assert.equal(technical.judgeCount, 3);
    assert.equal(result.projects[0]!.criterionAggregates.find((c) => c.key === 'innovation')!.score, 5);
  });

  test('ranking is stable and independent of input order', () => {
    const inputs = [
      project({ projectId: 'a', normalizedScores: [50], rawScores: [50], assignedJudges: 1, submittedReviews: 1 }),
      project({ projectId: 'b', normalizedScores: [50], rawScores: [50], assignedJudges: 1, submittedReviews: 1 }),
      project({ projectId: 'c', normalizedScores: [50], rawScores: [50], assignedJudges: 1, submittedReviews: 1 }),
    ];
    const forward = aggregateProjects(inputs).projects.map((p) => [p.rank, p.projectId]);
    const reversed = aggregateProjects([...inputs].reverse()).projects.map((p) => [p.rank, p.projectId]);
    assert.deepEqual(forward, reversed, 'a genuine three-way tie must be order-independent');
  });
});

describe('aggregation: deterministic tie resolution', () => {
  test('identical aggregates with different criterion profiles are separated by criterion priority', () => {
    const result = aggregateProjects(
      [
        project({
          projectId: 'lowTechnical',
          normalizedScores: [70],
          rawScores: [70],
          assignedJudges: 1,
          submittedReviews: 1,
          criterionScores: { technical: [4], innovation: [10] },
        }),
        project({
          projectId: 'highTechnical',
          normalizedScores: [70],
          rawScores: [70],
          assignedJudges: 1,
          submittedReviews: 1,
          criterionScores: { technical: [10], innovation: [4] },
        }),
      ],
      DEFAULT_AGGREGATION_CONFIG,
      ['technical'],
    );
    assert.equal(result.projects[0]?.projectId, 'highTechnical');
    assert.equal(result.projects[1]?.projectId, 'lowTechnical');
  });

  test('a genuine unresolved tie shares a rank and reports tieGroup + tiedWith', () => {
    const result = aggregateProjects([
      project({ projectId: 'p1', normalizedScores: [70], rawScores: [70], assignedJudges: 1, submittedReviews: 1 }),
      project({ projectId: 'p2', normalizedScores: [70], rawScores: [70], assignedJudges: 1, submittedReviews: 1 }),
      project({ projectId: 'p3', normalizedScores: [70], rawScores: [70], assignedJudges: 1, submittedReviews: 1, submittedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    // p3 loses on the earlier-submission rule, so p1 and p2 genuinely tie.
    assert.equal(result.projects[0]?.projectId, 'p3');
    assert.equal(result.projects[1]?.rank, result.projects[2]?.rank);
    assert.equal(result.projects[1]?.tieGroup, result.projects[2]?.tieGroup);
    assert.deepEqual(result.projects[1]?.tiedWith, ['p2']);
  });

  test('tie resolution walks the documented hierarchy in order', () => {
    const base = {
      normalizedScores: [70],
      rawScores: [70],
      assignedJudges: 1,
      submittedReviews: 1,
      submittedAt: '2026-06-01T00:00:00.000Z',
    };
    // Step 4: pairwise record breaks what criteria could not.
    const withPairwise = aggregateProjects([
      project({ ...base, projectId: 'noBt', pairwise: { wins: 0, losses: 2, ties: 0, score: -0.5 } }),
      project({ ...base, projectId: 'hasBt', pairwise: { wins: 2, losses: 0, ties: 0, score: 0.9 } }),
    ]);
    assert.equal(withPairwise.projects[0]?.projectId, 'hasBt');

    // Step 5: raw mean breaks it when pairwise is unavailable.
    const withRaw = aggregateProjects([
      project({ ...base, projectId: 'lowRaw', normalizedScores: [70], rawScores: [40] }),
      project({ ...base, projectId: 'highRaw', normalizedScores: [70], rawScores: [95] }),
    ]);
    assert.equal(withRaw.projects[0]?.projectId, 'highRaw');

    // Step 6: community votes, only when the organizer enables them.
    const withVotes = aggregateProjects(
      [
        project({ ...base, projectId: 'noVotes', voteCount: 3 }),
        project({ ...base, projectId: 'manyVotes', voteCount: 40 }),
      ],
      { ...DEFAULT_AGGREGATION_CONFIG, allowVoteTieBreak: true },
    );
    assert.equal(withVotes.projects[0]?.projectId, 'manyVotes');
    // With votes disabled the two projects are genuinely tied on every rule, so
    // they share a rank; the display order among tied entries is by id.
    const votesIgnored = aggregateProjects(
      [project({ ...base, projectId: 'noVotes', voteCount: 3 }), project({ ...base, projectId: 'manyVotes', voteCount: 40 })],
      { ...DEFAULT_AGGREGATION_CONFIG, allowVoteTieBreak: false },
    );
    assert.equal(votesIgnored.projects[0]?.rank, votesIgnored.projects[1]?.rank, 'votes must not break the tie');
    assert.equal(votesIgnored.projects[0]?.tieGroup, votesIgnored.projects[1]?.tieGroup);
  });

  test('floating point noise below the rank precision cannot decide a prize', () => {
    const result = aggregateProjects([
      project({ projectId: 'a', normalizedScores: [0.1 + 0.2], rawScores: [0.3], assignedJudges: 1, submittedReviews: 1 }),
      project({ projectId: 'b', normalizedScores: [0.3], rawScores: [0.3], assignedJudges: 1, submittedReviews: 1 }),
    ]);
    assert.equal(result.projects[0]?.rank, result.projects[1]?.rank, '0.1+0.2 === 0.3, so this is a real tie');
    assert.equal(result.projects[0]?.tieGroup, result.projects[1]?.tieGroup);
  });
});

describe('aggregation: prizes', () => {
  const ranked = aggregateProjects([
    project({ projectId: 'gold', normalizedScores: [95], rawScores: [95], assignedJudges: 1, submittedReviews: 1 }),
    project({ projectId: 'silver', normalizedScores: [88], rawScores: [88], assignedJudges: 1, submittedReviews: 1 }),
    project({ projectId: 'bronze', normalizedScores: [80], rawScores: [80], assignedJudges: 1, submittedReviews: 1 }),
  ]).projects;

  test('prizes are awarded by rank in priority order', () => {
    const prizes: Prize[] = [
      { id: 'p3', name: 'Bronze', eligibleProjectIds: [], quantity: 1, eligibleRanks: [3], trackId: null, priority: 3 },
      { id: 'p1', name: 'Gold', eligibleProjectIds: [], quantity: 1, eligibleRanks: [1], trackId: null, priority: 1 },
      { id: 'p2', name: 'Silver', eligibleProjectIds: [], quantity: 1, eligibleRanks: [2], trackId: null, priority: 2 },
    ];
    const awards = assignPrizes(ranked, prizes, (id) => id);
    assert.deepEqual(awards.map((a) => [a.prizeName, a.projectId]), [
      ['Gold', 'gold'],
      ['Silver', 'silver'],
      ['Bronze', 'bronze'],
    ]);
  });

  test('a project cannot win two prizes', () => {
    const prizes: Prize[] = [
      { id: 'a', name: 'Overall', eligibleProjectIds: [], quantity: 1, eligibleRanks: [1], trackId: null, priority: 1 },
      { id: 'b', name: 'Best UI', eligibleProjectIds: ['gold'], quantity: 1, eligibleRanks: [], trackId: null, priority: 2 },
    ];
    const awards = assignPrizes(ranked, prizes, (id) => id);
    assert.equal(awards.length, 1);
    assert.equal(awards[0]?.prizeName, 'Overall');
  });

  test('an empty project is never awarded a prize', () => {
    const withEmpty = [
      ...ranked,
      ...aggregateProjects([project({ projectId: 'empty', normalizedScores: [], assignedJudges: 1, submittedReviews: 0 })]).projects,
    ];
    const prizes: Prize[] = [{ id: 'a', name: 'Anything', eligibleProjectIds: [], quantity: 5, eligibleRanks: [], trackId: null, priority: 1 }];
    const awards = assignPrizes(withEmpty, prizes, (id) => id);
    assert.ok(!awards.some((a) => a.projectId === 'empty'));
  });

  test('a low-coverage winner is flagged for organizer review', () => {
    const thin = aggregateProjects(
      [project({ projectId: 'thin', normalizedScores: [90], rawScores: [90], assignedJudges: 6, submittedReviews: 1 })],
      { ...DEFAULT_AGGREGATION_CONFIG, minimumJudges: 3 },
    ).projects;
    const awards = assignPrizes(
      thin,
      [{ id: 'a', name: 'Best', eligibleProjectIds: [], quantity: 1, eligibleRanks: [], trackId: null, priority: 1 }],
      (id) => id,
    );
    assert.equal(awards.length, 1);
    assert.ok(awards[0]?.warnings.some((w) => /low-coverage/i.test(w)));
  });

  test('ranking confidence reports the margin to the runner-up', () => {
    const confidence = rankingConfidence(ranked);
    assert.equal(confidence.marginToRunnerUp, 7);
    assert.ok((confidence.marginInSigma as number) > 0);
  });
});

describe('pairwise: Bradley-Terry', () => {
  const cmp = (id: string, left: string, right: string, outcome: 'LEFT' | 'RIGHT' | 'TIE' | 'SKIPPED', judgeId = 'j1'): PairwiseComparison => ({
    id,
    judgeId,
    leftProjectId: left,
    rightProjectId: right,
    outcome,
    decidedAt: NOW,
  });

  test('a dominant project gets the highest strength', () => {
    const comparisons = [
      cmp('1', 'A', 'B', 'LEFT'),
      cmp('2', 'A', 'C', 'LEFT'),
      cmp('3', 'A', 'D', 'LEFT'),
      cmp('4', 'B', 'C', 'LEFT'),
      cmp('5', 'C', 'D', 'LEFT'),
    ];
    const result = fitBradleyTerry(comparisons, ['A', 'B', 'C', 'D'], { computedAt: NOW, inputHash: 'h' });
    const ranked = result.rankings.map((r) => r.projectId);
    assert.equal(ranked[0], 'A');
    assert.deepEqual([...ranked].sort(), ['A', 'B', 'C', 'D']);
    assert.equal(result.diagnostics.converged, true);
  });

  test('strengths are gauge-fixed to mean zero and shares sum to 1', () => {
    const comparisons = [cmp('1', 'A', 'B', 'LEFT'), cmp('2', 'B', 'C', 'LEFT'), cmp('3', 'A', 'C', 'LEFT')];
    const result = fitBradleyTerry(comparisons, ['A', 'B', 'C'], { computedAt: NOW, inputHash: 'h' });
    const meanTheta = result.strengths.reduce((a, s) => a + s.theta, 0) / result.strengths.length;
    assert.ok(Math.abs(meanTheta) < 1e-6, `mean theta should be 0, got ${meanTheta}`);
    const totalShare = result.strengths.reduce((a, s) => a + s.share, 0);
    assert.ok(Math.abs(totalShare - 1) < 1e-5, `shares should sum to 1, got ${totalShare}`);
  });

  test('transitive data gives a monotonically decreasing ladder', () => {
    const comparisons: PairwiseComparison[] = [];
    const order = ['A', 'B', 'C', 'D', 'E'];
    for (let i = 0; i < order.length; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        comparisons.push(cmp(`${i}-${j}`, order[i]!, order[j]!, 'LEFT'));
      }
    }
    const result = fitBradleyTerry(comparisons, order, { computedAt: NOW, inputHash: 'h' });
    assert.deepEqual(result.rankings.map((r) => r.projectId), order);
    const thetas = result.strengths.map((s) => s.theta);
    for (let i = 1; i < thetas.length; i += 1) assert.ok(thetas[i]! < thetas[i - 1]!);
  });

  test('ties count as half a win each', () => {
    const result = fitBradleyTerry([cmp('1', 'A', 'B', 'TIE')], ['A', 'B'], { computedAt: NOW, inputHash: 'h' });
    assert.equal(result.strengths[0]?.theta, result.strengths[1]?.theta);
    assert.equal(result.diagnostics.ties, 1);
  });

  test('an undefeated project is bounded by the prior, not reported as infinite', () => {
    const result = fitBradleyTerry([cmp('1', 'A', 'B', 'LEFT')], ['A', 'B'], { computedAt: NOW, inputHash: 'h' });
    const a = result.strengths.find((s) => s.projectId === 'A')!;
    assert.ok(Number.isFinite(a.theta));
    assert.ok(Math.abs(a.theta) < 5, `an undefeated project must be bounded, got theta ${a.theta}`);
    assert.ok(a.theta > 0);
    assert.equal(result.diagnostics.priorApplied, true);
    assert.ok(result.diagnostics.warnings.some((w) => /ridge strength lambda/i.test(w)));
  });

  test('a disconnected comparison graph is reported, not silently merged', () => {
    const result = fitBradleyTerry(
      [cmp('1', 'A', 'B', 'LEFT'), cmp('2', 'C', 'D', 'LEFT'), cmp('3', 'A', 'B', 'LEFT', 'j2')],
      ['A', 'B', 'C', 'D'],
      { computedAt: NOW, inputHash: 'h' },
    );
    assert.equal(result.diagnostics.connectedComponents, 2);
    assert.ok(result.diagnostics.warnings.some((w) => /disconnected components/i.test(w)));
    assert.ok(result.strengths.every((s) => Number.isFinite(s.theta)));
  });

  test('non-transitive cycles are counted and disclosed as a violated assumption', () => {
    // A > B, B > C, C > A is a cycle.
    const result = fitBradleyTerry(
      [cmp('1', 'A', 'B', 'LEFT'), cmp('2', 'B', 'C', 'LEFT'), cmp('3', 'C', 'A', 'LEFT')],
      ['A', 'B', 'C'],
      { computedAt: NOW, inputHash: 'h' },
    );
    assert.equal(result.diagnostics.nonTransitiveTriplets, 1);
    assert.ok(result.diagnostics.warnings.some((w) => /non-transitive/i.test(w)));
  });

  test('skipped comparisons are counted and excluded from the fit', () => {
    const result = fitBradleyTerry([cmp('1', 'A', 'B', 'SKIPPED'), cmp('2', 'A', 'C', 'LEFT')], ['A', 'B', 'C'], {
      computedAt: NOW,
      inputHash: 'h',
    });
    assert.equal(result.diagnostics.skipped, 1);
    assert.equal(result.diagnostics.decisiveComparisons, 1);
    assert.equal(result.strengths.find((s) => s.projectId === 'B')!.comparisons, 0);
  });

  test('an empty comparison set yields a valid empty result with a reason', () => {
    const result = fitBradleyTerry([], ['A', 'B'], { computedAt: NOW, inputHash: 'h' });
    assert.equal(result.strengths.length, 0);
    assert.ok(result.diagnostics.warnings.some((w) => /cannot rank anything/i.test(w)));
  });

  test('a single all-tie comparison set gives everyone the same strength', () => {
    const result = fitBradleyTerry([cmp('1', 'A', 'B', 'TIE'), cmp('2', 'B', 'C', 'TIE')], ['A', 'B', 'C'], {
      computedAt: NOW,
      inputHash: 'h',
    });
    const thetas = result.strengths.map((s) => s.theta);
    assert.ok(Math.abs(thetas[0]! - thetas[1]!) < 1e-9);
    assert.ok(Math.abs(thetas[1]! - thetas[2]!) < 1e-9);
  });

  test('the fit is deterministic', () => {
    const comparisons = Array.from({ length: 40 }, (_, i) => cmp(`${i}`, `p${i % 7}`, `p${(i * 3 + 1) % 7}`, i % 5 === 0 ? 'TIE' : 'LEFT'));
    const ids = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const a = fitBradleyTerry(comparisons, ids, { computedAt: NOW, inputHash: 'h' });
    const b = fitBradleyTerry(comparisons, ids, { computedAt: NOW, inputHash: 'h' });
    assert.deepEqual(a.strengths, b.strengths);
    assert.equal(a.diagnostics.iterations, b.diagnostics.iterations);
  });

  test('the likelihood ratio over the null model is positive when the data is ordered', () => {
    const result = fitBradleyTerry(
      [cmp('1', 'A', 'B', 'LEFT'), cmp('2', 'A', 'B', 'LEFT'), cmp('3', 'B', 'C', 'LEFT')],
      ['A', 'B', 'C'],
      { computedAt: NOW, inputHash: 'h' },
    );
    assert.ok(result.diagnostics.likelihoodRatio > 0);
    assert.ok((result.diagnostics.goodnessOfFit as number) >= 0);
  });
});

describe('pairwise: schedule generation', () => {
  test('every unordered pair appears exactly once in a full round robin', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const pairs = buildPairSchedule(ids, 'judge-1', { pairsPerComparison: 1000, seed: 'seed' });
    assert.equal(pairs.length, (ids.length * (ids.length - 1)) / 2);
    const keys = new Set(pairs.map((p) => [p.left, p.right].sort().join('|')));
    assert.equal(keys.size, pairs.length, 'no pair may repeat');
    for (const p of pairs) assert.notEqual(p.left, p.right, 'a project is never compared with itself');
  });

  test('the schedule is stable per judge and differs between judges', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const first = buildPairSchedule(ids, 'judge-1', { pairsPerComparison: 8, seed: 's' });
    const again = buildPairSchedule(ids, 'judge-1', { pairsPerComparison: 8, seed: 's' });
    const other = buildPairSchedule(ids, 'judge-2', { pairsPerComparison: 8, seed: 's' });
    assert.deepEqual(first, again, 'a judge resuming their queue must see the same order');
    assert.notDeepEqual(first, other, 'different judges should get different orderings');
  });

  test('a workload cap limits the schedule', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    assert.equal(buildPairSchedule(ids, 'j', { pairsPerComparison: 5, seed: 's' }).length, 5);
  });

  test('fewer than two projects yields no pairs', () => {
    assert.deepEqual(buildPairSchedule(['a'], 'j', { pairsPerComparison: 10, seed: 's' }), []);
  });
});

/* ---------------------------------------------------------- assignment */

function judge(id: string, overrides: Partial<JudgeCandidate> = {}): JudgeCandidate {
  return {
    judgeId: id,
    displayName: id,
    state: 'ACTIVE',
    capacity: 5,
    existingLoad: 0,
    expertise: [],
    excluded: false,
    exclusionReason: null,
    ...overrides,
  };
}

function proj(id: string, overrides: Partial<ProjectCandidate> = {}): ProjectCandidate {
  return {
    projectId: id,
    trackId: null,
    teamId: null,
    organization: null,
    existingJudges: [],
    hardConflicts: [],
    softConflicts: [],
    relatedJudges: [],
    reviewsNeeded: 3,
    ...overrides,
  };
}

describe('assignment: coverage and balance', () => {
  test('every project reaches the requested coverage when capacity allows', () => {
    const preview = generateAssignmentPreview(
      {
        eventId: 'evt_1',
        strategy: 'WORKLOAD_AWARE',
        judges: [judge('j1'), judge('j2'), judge('j3')],
        projects: [proj('p1'), proj('p2')],
        conflicts: [],
        reviewsPerProject: 3,
        seed: 'seed',
      },
      NOW,
    );
    assert.equal(preview.summary.totalPairs, 6);
    assert.equal(preview.summary.projectsFullyCovered, 2);
    assert.equal(preview.summary.projectsUncovered, 0);
    for (const row of preview.judgeLoad) assert.equal(row.total, 2, 'load should be even');
    assert.equal(preview.summary.loadSpread.max - preview.summary.loadSpread.min, 0);
  });

  test('RANDOM is reproducible from its seed and differs across seeds', () => {
    const request = {
      eventId: 'evt_1',
      strategy: 'RANDOM' as const,
      judges: [judge('j1'), judge('j2'), judge('j3'), judge('j4')],
      projects: [proj('p1', { reviewsNeeded: 2 }), proj('p2', { reviewsNeeded: 2 })],
      conflicts: [],
      reviewsPerProject: 2,
      seed: 'seed-alpha',
    };
    const a = generateAssignmentPreview(request, NOW);
    const b = generateAssignmentPreview(request, NOW);
    assert.deepEqual(a.pairs, b.pairs, 'the same seed must reproduce the same assignment');
    const different = generateAssignmentPreview({ ...request, seed: 'seed-beta' }, NOW);
    assert.notDeepEqual(a.pairs, different.pairs);
  });

  test('insufficient capacity is reported honestly instead of under-assigning silently', () => {
    const preview = generateAssignmentPreview(
      {
        eventId: 'evt_1',
        strategy: 'BALANCED',
        judges: [judge('j1', { capacity: 2 })],
        projects: [proj('p1', { reviewsNeeded: 3 }), proj('p2', { reviewsNeeded: 3 })],
        conflicts: [],
        reviewsPerProject: 3,
        seed: 's',
      },
      NOW,
    );
    assert.equal(preview.summary.totalPairs, 2);
    // One judge with capacity 2 spreads one review over each of two projects
    // that each need three: both are partially covered, none is fully covered
    // and none is completely unassigned.
    assert.equal(preview.summary.projectsFullyCovered, 0);
    assert.equal(preview.summary.projectsPartiallyCovered, 2);
    assert.equal(preview.summary.projectsUncovered, 0);
    assert.equal(preview.summary.coverageRatio, 0.3333, 'one third of the requested coverage was deliverable');
    assert.ok(preview.summary.warnings.some((w) => /Insufficient judging capacity/.test(w)));
    assert.equal(preview.unassignedProjects.length, 2);
    assert.match(preview.unassignedProjects[0]?.reason ?? '', /insufficient judge capacity/i);
  });

  test('a judge already at capacity receives nothing', () => {
    const preview = generateAssignmentPreview(
      {
        eventId: 'evt_1',
        strategy: 'BALANCED',
        judges: [judge('full', { capacity: 2, existingLoad: 2 }), judge('free')],
        projects: [proj('p1', { reviewsNeeded: 2 })],
        conflicts: [],
        reviewsPerProject: 2,
        seed: 's',
      },
      NOW,
    );
    assert.ok(!preview.pairs.some((p) => p.judgeId === 'full'), 'a judge at capacity must not be assigned');
    // A judge at capacity is still an eligible judge; they simply have no
    // headroom, which the workload table must make obvious.
    const row = preview.judgeLoad.find((j) => j.judgeId === 'full')!;
    assert.equal(row.assigned, 0);
    assert.equal(row.total, 2);
    assert.equal(row.capacity, 2);
    assert.equal(row.utilisation, 1);
    assert.deepEqual(preview.pairs.map((p) => p.judgeId), ['free']);
  });

  test('unconfirmed and completed judges are excluded with a reason', () => {
    const preview = generateAssignmentPreview(
      {
        eventId: 'evt_1',
        strategy: 'BALANCED',
        judges: [judge('invited', { state: 'INVITED' }), judge('done', { state: 'COMPLETED' }), judge('ok')],
        projects: [proj('p1', { reviewsNeeded: 1 })],
        conflicts: [],
        reviewsPerProject: 1,
        seed: 's',
      },
      NOW,
    );
    assert.deepEqual(preview.pairs.map((p) => p.judgeId), ['ok']);
    assert.equal(preview.excludedJudges.length, 2);
    assert.match(preview.excludedJudges[0]?.reason ?? '', /Invitation not yet accepted/);
  });

  test('no eligible judges produces an empty, explained preview', () => {
    const preview = generateAssignmentPreview(
      { eventId: 'e', strategy: 'BALANCED', judges: [judge('j', { excluded: true, exclusionReason: 'On leave' })], projects: [proj('p1')], conflicts: [], reviewsPerProject: 1, seed: 's' },
      NOW,
    );
    assert.equal(preview.pairs.length, 0);
    assert.ok(preview.summary.warnings.some((w) => /No eligible judges/.test(w)));
  });
});

describe('assignment: conflict enforcement', () => {
  test('a HARD conflict is never assigned under any strategy', () => {
    const conflict: ConflictDeclaration = {
      judgeId: 'j1',
      projectId: 'p1',
      kind: 'TEAM',
      severity: 'HARD',
      subjectId: 'tem_1',
      note: 'I built this project last year',
    };
    for (const strategy of ['RANDOM', 'BALANCED', 'CONFLICT_AWARE', 'WORKLOAD_AWARE', 'PANEL_DIVERSITY'] as const) {
      const preview = generateAssignmentPreview(
        {
          eventId: 'e',
          strategy,
          judges: [judge('j1'), judge('j2')],
          projects: [proj('p1', { reviewsNeeded: 1 })],
          conflicts: [conflict],
          reviewsPerProject: 1,
          seed: 's',
        },
        NOW,
      );
      assert.ok(!preview.pairs.some((p) => p.judgeId === 'j1' && p.projectId === 'p1'), `${strategy} assigned a conflicted judge`);
    }
  });

  test('hard conflicts are expanded from team and organization declarations', () => {
    const preview = generateAssignmentPreview(
      {
        eventId: 'e',
        strategy: 'CONFLICT_AWARE',
        judges: [judge('j1'), judge('j2')],
        projects: [proj('p1', { teamId: 'tem_1' }), proj('p2', { teamId: 'tem_1' }), proj('p3', { organization: 'Acme' })],
        conflicts: [
          { judgeId: 'j1', projectId: null, kind: 'TEAM', severity: 'HARD', subjectId: 'tem_1', note: '' },
          { judgeId: 'j1', projectId: null, kind: 'ORGANIZATION', severity: 'HARD', subjectId: 'Acme', note: '' },
        ],
        reviewsPerProject: 1,
        seed: 's',
      },
      NOW,
    );
    assert.ok(!preview.pairs.some((p) => p.judgeId === 'j1'), 'j1 is conflicted with every project');
    assert.equal(preview.enforcedHardConflicts.length, 3);
  });

  test('accepted SOFT conflicts are reported so the cost is never invisible', () => {
    const preview = generateAssignmentPreview(
      {
        eventId: 'e',
        strategy: 'RANDOM',
        judges: [judge('j1')],
        projects: [proj('p1', { reviewsNeeded: 1, softConflicts: ['j1'] })],
        conflicts: [{ judgeId: 'j1', projectId: 'p1', kind: 'MENTOR', severity: 'SOFT', subjectId: null, note: '' }],
        reviewsPerProject: 1,
        seed: 's',
      },
      NOW,
    );
    assert.equal(preview.pairs.length, 1, 'the naive baseline may still assign a soft conflict');
    assert.equal(preview.acceptedSoftConflicts.length, 1);
    assert.ok(preview.summary.warnings.some((w) => /soft conflict/i.test(w)));
  });

  test('a project with only conflicted judges is reported as unassignable with a reason', () => {
    const preview = generateAssignmentPreview(
      {
        eventId: 'e',
        strategy: 'CONFLICT_AWARE',
        judges: [judge('j1'), judge('j2')],
        projects: [proj('p1', { reviewsNeeded: 2 })],
        conflicts: [
          { judgeId: 'j1', projectId: 'p1', kind: 'TEAM', severity: 'HARD', subjectId: null, note: '' },
          { judgeId: 'j2', projectId: 'p1', kind: 'TEAM', severity: 'HARD', subjectId: null, note: '' },
        ],
        reviewsPerProject: 2,
        seed: 's',
      },
      NOW,
    );
    assert.equal(preview.pairs.length, 0);
    assert.match(preview.unassignedProjects[0]?.reason ?? '', /hard conflict/);
  });
});

describe('assignment: panel diversity and track restrictions', () => {
  test('PANEL_DIVERSITY avoids giving a project the same judge panel repeatedly', () => {
    const projects = [proj('p1', { reviewsNeeded: 2 }), proj('p2', { reviewsNeeded: 2 }), proj('p3', { reviewsNeeded: 2 })];
    const judges = [judge('j1'), judge('j2'), judge('j3'), judge('j4')];
    const diverse = generateAssignmentPreview(
      { eventId: 'e', strategy: 'PANEL_DIVERSITY', judges, projects, conflicts: [], reviewsPerProject: 2, seed: 's' },
      NOW,
    );
    const panels = projects.map((p) => diverse.pairs.filter((x) => x.projectId === p.projectId).map((x) => x.judgeId).sort());
    const unique = new Set(panels.map((p) => p.join('|')));
    assert.equal(unique.size, 3, 'each project should get a different panel');
  });

  test('a track restriction limits which judges may review its projects', () => {
    const preview = generateAssignmentPreview(
      {
        eventId: 'e',
        strategy: 'BALANCED',
        judges: [judge('specialist'), judge('generalist')],
        projects: [proj('p1', { trackId: 'trk_ai', reviewsNeeded: 1 })],
        conflicts: [],
        reviewsPerProject: 1,
        seed: 's',
        trackJudgeRestrictions: { trk_ai: ['specialist'] },
      },
      NOW,
    );
    assert.deepEqual(preview.pairs.map((p) => p.judgeId), ['specialist']);
  });

  test('existing assignments are preserved and counted toward coverage', () => {
    const preview = generateAssignmentPreview(
      {
        eventId: 'e',
        strategy: 'WORKLOAD_AWARE',
        judges: [judge('j1'), judge('j2')],
        projects: [proj('p1', { reviewsNeeded: 2, existingJudges: ['j1'] })],
        conflicts: [],
        reviewsPerProject: 2,
        seed: 's',
      },
      NOW,
    );
    assert.equal(preview.pairs.length, 1, 'only one new pair is needed');
    assert.equal(preview.pairs[0]?.judgeId, 'j2', 'j1 is already assigned and must not be duplicated');
    assert.equal(preview.projectCoverage[0]?.assigned, 2);
  });
});

/* --------------------------------------------------------- diagnostics */

function review(judgeId: string, projectId: string, score: number, submittedAt = NOW, state: ReviewRecord['state'] = 'SUBMITTED'): ReviewRecord {
  return { judgeId, projectId, score, submittedAt, state };
}

describe('diagnostics: judge signals', () => {
  test('a wide-spread judge is flagged HIGH_VARIANCE with the statistic attached', () => {
    const reviews = [10, 20, 95, 5, 88, 12, 91, 15].map((s, i) => review('j1', `p${i}`, s));
    const d = diagnoseJudge('j1', reviews, 40, 20, 8, reviews.map((r) => r.projectId));
    const signal = d.signals.find((s) => s.type === 'HIGH_VARIANCE');
    assert.ok(signal, 'expected a HIGH_VARIANCE signal');
    assert.equal(signal!.subjectKind, 'JUDGE');
    assert.ok((signal!.metric as number) > THRESHOLDS.highJudgeVarianceCv);
    assert.equal(signal!.threshold, THRESHOLDS.highJudgeVarianceCv);
    assert.ok(signal!.evidence.includes('span'));
  });

  test('a suspiciously consistent judge is flagged LOW_VARIANCE', () => {
    const reviews = [70, 70.2, 70.1, 69.9, 70.05, 70.3].map((s, i) => review('j1', `p${i}`, s));
    const d = diagnoseJudge('j1', reviews, 70, 1, 6, reviews.map((r) => r.projectId));
    assert.ok(d.signals.some((s) => s.type === 'LOW_VARIANCE'));
  });

  test('a generous judge is flagged PANEL_DEVIATION as a neutral, correctable signal', () => {
    const reviews = Array.from({ length: 10 }, (_, i) => review('j1', `p${i}`, 90 + (i % 3)));
    const d = diagnoseJudge('j1', reviews, 60, 5, 10, reviews.map((r) => r.projectId));
    const signal = d.signals.find((s) => s.type === 'PANEL_DEVIATION');
    assert.ok(signal);
    assert.match(signal!.evidence, /above the panel mean/);
    assert.match(signal!.recommendedAction, /normalization corrects/i);
  });

  test('an incomplete judge is flagged with the exact completion rate', () => {
    const reviews = [review('j1', 'p1', 70), review('j1', 'p2', 75)];
    const d = diagnoseJudge('j1', reviews, 72, 5, 6, ['p1', 'p2']);
    const signal = d.signals.find((s) => s.type === 'INCOMPLETE');
    assert.ok(signal);
    assert.equal(signal!.metric, 0.3333, 'the rate is rounded to 4dp for reporting');
    assert.equal(d.completionRate, 0.3333);
    assert.match(signal!.evidence, /2 of 6/);
  });

  test('a run of identical total scores is flagged IDENTICAL_SCORING', () => {
    const reviews = Array.from({ length: 5 }, (_, i) => review('j1', `p${i}`, 72, `2026-03-01T10:0${i}:00.000Z`));
    const d = diagnoseJudge('j1', reviews, 72, 3, 5, reviews.map((r) => r.projectId));
    const signal = d.signals.find((s) => s.type === 'IDENTICAL_SCORING');
    assert.ok(signal);
    assert.equal(signal!.metric, 5);
  });

  test('no judge signal is emitted from a sample too small to mean anything', () => {
    const d = diagnoseJudge('j1', [review('j1', 'p1', 10), review('j1', 'p2', 90)], 50, 40, 2, ['p1', 'p2']);
    assert.ok(!d.signals.some((s) => s.type === 'HIGH_VARIANCE' || s.type === 'LOW_VARIANCE'));
  });

  test('draft reviews are excluded from the statistics but counted', () => {
    const reviews = [review('j1', 'p1', 70), review('j1', 'p2', 99, NOW, 'DRAFT')];
    const d = diagnoseJudge('j1', reviews, 70, 5, 2, ['p1', 'p2']);
    assert.equal(d.sampleSize, 1, 'the draft is not part of the sample');
    assert.equal(d.draftReviews, 1);
  });
});

describe('diagnostics: project signals', () => {
  test('an under-covered project is flagged', () => {
    // Three judges were assigned; only two submitted. Coverage must be measured
    // against the assignment, not against who happened to submit.
    const d = computeDiagnostics({
      eventId: 'e',
      rubricVersionId: 'r',
      assignmentVersion: 1,
      reviews: [review('j1', 'p1', 70), review('j2', 'p1', 72)],
      assignments: new Map([
        ['j1', 1],
        ['j2', 1],
        ['j3', 1],
      ]),
      assignmentTargets: new Map([
        ['j1', ['p1']],
        ['j2', ['p1']],
        ['j3', ['p1']],
      ]),
      criteria: ['technical'],
      minimumJudges: 3,
      computedAt: NOW,
    });
    const project = d.projects.find((p) => p.projectId === 'p1')!;
    assert.equal(project.assignedJudges, 3);
    assert.equal(project.coverage, 0.6667);
    const signal = project.signals.find((s) => s.type === 'INCOMPLETE');
    assert.ok(signal, 'an abandoned review must be visible');
    assert.match(signal!.evidence, /2 of 3/);
  });

  test('a field outlier is flagged but framed as a review signal, not a verdict', () => {
    const reviews = [
      ...Array.from({ length: 9 }, (_, i) => review(`j${i}`, `p${i}`, 60 + i)),
      review('jx', 'outlier', 99),
    ];
    const d = computeDiagnostics({
      eventId: 'e',
      rubricVersionId: 'r',
      assignmentVersion: 1,
      reviews,
      assignments: new Map(reviews.map((r) => [r.judgeId, 1])),
      assignmentTargets: new Map(),
      criteria: [],
      minimumJudges: 3,
      computedAt: NOW,
    });
    const outlier = d.projects.find((p) => p.projectId === 'outlier')!;
    const signal = outlier.signals.find((s) => s.type === 'SCORE_MANIPULATION');
    assert.ok(signal, 'an extreme project should be surfaced');
    assert.match(signal!.recommendedAction, /Outliers are normal/);
  });

  test('panel summary statistics are reported', () => {
    const d = computeDiagnostics({
      eventId: 'e',
      rubricVersionId: 'r',
      assignmentVersion: 1,
      reviews: [review('j1', 'p1', 60), review('j1', 'p2', 80), review('j2', 'p1', 70)],
      assignments: new Map([
        ['j1', 2],
        ['j2', 1],
      ]),
      assignmentTargets: new Map(),
      criteria: ['technical'],
      minimumJudges: 2,
      computedAt: NOW,
    });
    assert.equal(d.panel.judgeCount, 2);
    assert.equal(d.panel.reviewCount, 3);
    assert.equal(d.panel.mean, 70);
    assert.equal(d.panel.median, 70);
  });
});

describe('diagnostics: voting abuse signals', () => {
  test('a burst of votes is flagged VOTE VELOCITY', () => {
    const votes = Array.from({ length: 200 }, (_, i) => ({ userId: `u${i % 40}`, createdAt: NOW }));
    const d = diagnoseVoting({ eventId: 'e', votes, windowStart: '2026-03-01T00:00:00.000Z', windowEnd: '2026-03-01T00:10:00.000Z' });
    assert.ok(d.signals.some((s) => s.type === 'VOTING_VELOCITY'));
    assert.ok((d.velocityPerHour as number) > THRESHOLDS.votingVelocityPerHour);
  });

  test('one account dominating the vote is flagged CONCENTRATION', () => {
    const votes = [
      ...Array.from({ length: 40 }, () => ({ userId: 'whale', createdAt: NOW })),
      ...Array.from({ length: 20 }, (_, i) => ({ userId: `u${i}`, createdAt: NOW })),
    ];
    const d = diagnoseVoting({ eventId: 'e', votes, windowStart: '2026-03-01T00:00:00.000Z', windowEnd: '2026-03-01T10:00:00.000Z' });
    const signal = d.signals.find((s) => s.type === 'VOTING_CONCENTRATION');
    assert.ok(signal);
    assert.equal(signal!.subjectKind, 'ACCOUNT');
    assert.match(signal!.recommendedAction, /not a fraudster/);
  });

  test('ordinary distributed voting raises no signal', () => {
    const votes = Array.from({ length: 60 }, (_, i) => ({ userId: `u${i % 30}`, createdAt: NOW }));
    const d = diagnoseVoting({ eventId: 'e', votes, windowStart: '2026-03-01T00:00:00.000Z', windowEnd: '2026-03-02T00:00:00.000Z' });
    assert.equal(d.signals.length, 0, `unexpected signals: ${d.signals.map((s) => s.type).join(', ')}`);
  });

  test('concentration is ignored below the minimum vote volume', () => {
    const votes = Array.from({ length: 10 }, () => ({ userId: 'whale', createdAt: NOW }));
    const d = diagnoseVoting({ eventId: 'e', votes, windowStart: '2026-03-01T00:00:00.000Z', windowEnd: '2026-03-02T00:00:00.000Z' });
    assert.ok(!d.signals.some((s) => s.type === 'VOTING_CONCENTRATION'));
  });
});

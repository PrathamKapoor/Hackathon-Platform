import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RubricValidationError,
  assertValidRubricVersion,
  evaluateReview,
  normaliseCriterionValue,
  normaliseWeights,
  validateRubricVersion,
  weightedCriterionBreakdown,
  type RubricVersion,
} from '../src/rubric.ts';
import {
  MACHINES,
  TransitionError,
  assertTransition,
  canTransition,
  describeMachine,
  transitionCheck,
  type TransitionContext,
} from '../src/state-machines.ts';
import type { EventState, ScoreState, SubmissionState } from '../src/types.ts';

function criterion(id: string, key: string, weight: number, min: number, max: number, required = true) {
  return {
    id,
    key,
    name: key,
    description: '',
    weight,
    min,
    max,
    required,
    scoringType: 'DECIMAL' as const,
    order: 0,
    publishBreakdown: true,
  };
}

const RUBRIC: RubricVersion = {
  id: 'rub_1',
  rubricId: 'rub_1',
  version: 1,
  status: 'ACTIVE',
  criteria: [
    criterion('c1', 'technical', 0.3, 0, 10),
    criterion('c2', 'innovation', 0.2, 0, 10),
    criterion('c3', 'impact', 0.2, 0, 10),
    criterion('c4', 'ux', 0.15, 0, 5),
    criterion('c5', 'presentation', 0.15, 0, 10),
  ],
  weightsMustSumToOne: true,
  rounding: { precision: 4, mode: 'HALF_UP' },
  tieBreakPriority: ['technical', 'innovation'],
  notes: '',
};

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return { override: false, facts: {}, actor: { id: 'usr_1', roles: ['ORGANIZER'] }, ...overrides };
}

describe('rubric: validation', () => {
  test('a well-formed rubric passes', () => {
    assert.deepEqual(validateRubricVersion(RUBRIC), []);
  });

  test('weights must sum to 1 when the rubric requires it', () => {
    const bad = { ...RUBRIC, criteria: RUBRIC.criteria.map((c) => ({ ...c, weight: c.weight * 0.9 })) };
    const issues = validateRubricVersion(bad);
    assert.ok(issues.some((i) => /weights must sum to 1\.0/.test(i)), issues.join('; '));
  });

  test('percentages are rejected with a helpful message', () => {
    const percent = {
      ...RUBRIC,
      criteria: [
        criterion('c1', 'technical', 30, 0, 10),
        criterion('c2', 'innovation', 20, 0, 10),
        criterion('c3', 'impact', 20, 0, 10),
        criterion('c4', 'ux', 15, 0, 5),
        criterion('c5', 'presentation', 15, 0, 10),
      ],
    };
    const issues = validateRubricVersion(percent);
    assert.ok(issues.some((i) => /sum to 1\.0 \(they sum to 100\)/.test(i)), issues.join('; '));
  });

  test('duplicate keys, empty names, negative weights and degenerate scales are caught', () => {
    const issues = validateRubricVersion({
      ...RUBRIC,
      criteria: [
        criterion('c1', 'dup', 0.5, 0, 10),
        criterion('c2', 'dup', 0.5, 5, 5),
        criterion('c3', '', 0, 0, 10, false),
      ],
    });
    assert.ok(issues.some((i) => /duplicate criterion key/.test(i)));
    assert.ok(issues.some((i) => /needs a name/.test(i)));
    assert.ok(issues.some((i) => /max > min/.test(i)));
  });

  test('an empty rubric and a rubric with no required criterion are rejected', () => {
    assert.ok(validateRubricVersion({ ...RUBRIC, criteria: [] }).some((i) => /at least one criterion/.test(i)));
    const allOptional = { ...RUBRIC, criteria: RUBRIC.criteria.map((c) => ({ ...c, required: false })) };
    assert.ok(validateRubricVersion(allOptional).some((i) => /at least one criterion must be required/.test(i)));
  });

  test('tie-break priorities must reference real criteria', () => {
    const issues = validateRubricVersion({ ...RUBRIC, tieBreakPriority: ['nope'] });
    assert.ok(issues.some((i) => /unknown criterion "nope"/.test(i)));
  });

  test('assertValidRubricVersion throws with every issue attached', () => {
    try {
      assertValidRubricVersion({ ...RUBRIC, criteria: [] });
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof RubricValidationError);
      assert.ok(error.issues.length > 0);
    }
  });
});

describe('rubric: weight normalisation', () => {
  test('percentages are rescaled to sum to exactly 1', () => {
    const weights = normaliseWeights([30, 20, 20, 15, 15]);
    const total = weights.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, `sum was ${total}`);
    assert.equal(weights[0], 0.3);
  });

  test('a zero total is rejected rather than producing NaN weights', () => {
    assert.throws(() => normaliseWeights([0, 0]), RubricValidationError);
  });
});

describe('rubric: criterion normalisation', () => {
  test('values map onto 0..1 using the criterion scale', () => {
    assert.equal(normaliseCriterionValue(0, 0, 10), 0);
    assert.equal(normaliseCriterionValue(10, 0, 10), 1);
    assert.equal(normaliseCriterionValue(5, 0, 10), 0.5);
    assert.equal(normaliseCriterionValue(2.5, 0, 5), 0.5);
  });

  test('out-of-range values are clamped, degenerate scales return null', () => {
    assert.equal(normaliseCriterionValue(20, 0, 10), 1);
    assert.equal(normaliseCriterionValue(-5, 0, 10), 0);
    assert.equal(normaliseCriterionValue(5, 5, 5), null);
    assert.equal(normaliseCriterionValue(Number.NaN, 0, 10), null);
  });
});

describe('rubric: review evaluation', () => {
  test('a perfect review scores exactly 100 and a zero review exactly 0', () => {
    const perfect = evaluateReview(RUBRIC, RUBRIC.criteria.map((c) => ({ criterionId: c.id, value: c.max })));
    assert.equal(perfect.total, 1);
    assert.equal(perfect.score100, 100);
    assert.ok(perfect.complete);

    const zero = evaluateReview(RUBRIC, RUBRIC.criteria.map((c) => ({ criterionId: c.id, value: c.min })));
    assert.equal(zero.total, 0);
    assert.equal(zero.score100, 0);
  });

  test('a half-score review scores 50 regardless of the criterion scales', () => {
    const half = evaluateReview(
      RUBRIC,
      RUBRIC.criteria.map((c) => ({ criterionId: c.id, value: (c.min + c.max) / 2 })),
    );
    assert.ok(Math.abs(half.total - 0.5) < 1e-12);
    assert.equal(half.score100, 50);
  });

  test('weights are respected: technical quality alone drives most of the score', () => {
    const onlyTechnical = evaluateReview(RUBRIC, [
      { criterionId: 'c1', value: 10 },
      { criterionId: 'c2', value: 0 },
      { criterionId: 'c3', value: 0 },
      { criterionId: 'c4', value: 0 },
      { criterionId: 'c5', value: 0 },
    ]);
    assert.ok(Math.abs(onlyTechnical.total - 0.3) < 1e-12, `expected 0.30, got ${onlyTechnical.total}`);
    assert.equal(onlyTechnical.score100, 30);
  });

  test('a missing REQUIRED criterion makes the review incomplete and is never silently re-weighted', () => {
    const partial = evaluateReview(RUBRIC, [{ criterionId: 'c1', value: 10 }]);
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.missingRequired.sort(), ['impact', 'innovation', 'presentation', 'ux']);
    // The single scored criterion still contributes its own weight only; the
    // missing criteria contribute nothing rather than being rescaled to 1.0.
    assert.ok(Math.abs(partial.total - 0.3) < 1e-12);
  });

  test('missing OPTIONAL criteria contribute zero rather than redistributing weight', () => {
    const withOptional = evaluateReview(
      { ...RUBRIC, criteria: [{ ...RUBRIC.criteria[0]!, required: true }, { ...RUBRIC.criteria[1]!, required: false }] },
      [{ criterionId: 'c1', value: 10 }],
    );
    assert.ok(Math.abs(withOptional.total - 0.3) < 1e-12);
  });

  test('out-of-range and non-finite scores are rejected', () => {
    assert.throws(() => evaluateReview(RUBRIC, [{ criterionId: 'c1', value: 11 }]), /between 0 and 10/);
    assert.throws(() => evaluateReview(RUBRIC, [{ criterionId: 'c1', value: Number.NaN }]), /finite/);
    assert.throws(() => evaluateReview(RUBRIC, [{ criterionId: 'c1', value: Number.POSITIVE_INFINITY }]), /finite/);
  });

  test('criterion ids outside the rubric are reported, not ignored', () => {
    const result = evaluateReview(RUBRIC, [{ criterionId: 'ghost', value: 5 }]);
    assert.deepEqual(result.unknownCriterionIds, ['ghost']);
  });

  test('the score is always inside 0..100 even with floating point weights', () => {
    const messy = {
      ...RUBRIC,
      criteria: [
        criterion('c1', 'a', 0.3333333333, 0, 3),
        criterion('c2', 'b', 0.3333333333, 0, 7),
        criterion('c3', 'c', 0.3333333334, 0, 11),
      ],
    };
    const max = evaluateReview(messy, messy.criteria.map((c) => ({ criterionId: c.id, value: c.max })));
    assert.ok(max.total <= 1 && max.total >= 0.999, `got ${max.total}`);
    assert.ok(max.score100 <= 100);
  });

  test('evaluation is pure: repeated calls give identical results', () => {
    const inputs = RUBRIC.criteria.map((c) => ({ criterionId: c.id, value: c.min + (c.max - c.min) * 0.7 }));
    assert.deepEqual(evaluateReview(RUBRIC, inputs), evaluateReview(RUBRIC, inputs));
  });

  test('criterion breakdown aggregates the same way the total does', () => {
    const perfect = evaluateReview(RUBRIC, RUBRIC.criteria.map((c) => ({ criterionId: c.id, value: c.max })));
    const zero = evaluateReview(RUBRIC, RUBRIC.criteria.map((c) => ({ criterionId: c.id, value: c.min })));
    const breakdown = weightedCriterionBreakdown(RUBRIC, [perfect, zero]);
    assert.equal(breakdown.length, 5);
    for (const row of breakdown) {
      assert.equal(row.judgeCount, 2);
      assert.ok(Math.abs((row.meanNormalised as number) - 0.5) < 1e-12);
    }
    // Technical quality: weight 0.30, mean normalised 0.5 -> 15 of 100 points.
    const technical = breakdown.find((b) => b.key === 'technical')!;
    assert.equal(technical.pointsOutOf100, 15);
    const ux = breakdown.find((b) => b.key === 'ux')!;
    assert.equal(ux.pointsOutOf100, 7.5);
  });
});

describe('state machines: structure', () => {
  test('every machine declares its transitions and can be documented', () => {
    for (const name of Object.keys(MACHINES) as (keyof typeof MACHINES)[]) {
      const doc = describeMachine(name);
      assert.ok(doc.entity.length > 0);
      assert.ok(doc.transitions.length > 0, `${name} has no transitions`);
    }
  });

  test('no machine declares a transition to an unknown state', () => {
    const eventStates = new Set<string>(MACHINES.Event.transitions.map((t) => t.to));
    assert.ok(eventStates.size > 3);
    for (const t of MACHINES.Event.transitions) assert.ok(MACHINES.Event.outgoing(t.from).length > 0);
  });
});

describe('state machines: event lifecycle', () => {
  test('the happy path is legal end to end', () => {
    const path: EventState[] = ['DRAFT', 'REGISTRATION', 'ACTIVE', 'SUBMISSIONS_LOCKED', 'JUDGING', 'RESULTS_PENDING', 'PUBLISHED', 'ARCHIVED'];
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i]!;
      const to = path[i + 1]!;
      const check = transitionCheck<EventState>('Event', from, to, ctx({ facts: { registrationOpensAt: '2026-01-01T00:00:00.000Z', deadlinePassed: true, submissionCount: 5, incompleteAssignments: 0 } }));
      assert.equal(check.allowed, true, `${from} -> ${to} should be allowed: ${check.reason}`);
    }
  });

  test('an undefined transition is rejected', () => {
    assert.equal(canTransition<EventState>('Event', 'DRAFT', 'PUBLISHED'), false);
    assert.throws(() => assertTransition<EventState>('Event', 'DRAFT', 'PUBLISHED', ctx()), TransitionError);
  });

  test('locking submissions before the deadline requires an explicit override', () => {
    const denied = transitionCheck<EventState>('Event', 'ACTIVE', 'SUBMISSIONS_LOCKED', ctx({ facts: { deadlinePassed: false } }));
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? '', /deadline has not passed/);
    assert.match(denied.reason ?? '', /override is required/);

    const withDeadline = transitionCheck<EventState>('Event', 'ACTIVE', 'SUBMISSIONS_LOCKED', ctx({ facts: { deadlinePassed: true } }));
    assert.equal(withDeadline.allowed, true);

    const withOverride = transitionCheck<EventState>('Event', 'ACTIVE', 'SUBMISSIONS_LOCKED', ctx({ facts: { deadlinePassed: false }, override: true }));
    assert.equal(withOverride.allowed, true);
  });

  test('judging cannot start with zero submissions', () => {
    const denied = transitionCheck<EventState>('Event', 'SUBMISSIONS_LOCKED', 'JUDGING', ctx({ facts: { submissionCount: 0 } }));
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? '', /no submitted projects/);
  });

  test('leaving JUDGING is blocked while assignments are incomplete', () => {
    const denied = transitionCheck<EventState>('Event', 'JUDGING', 'RESULTS_PENDING', ctx({ facts: { incompleteAssignments: 3 } }));
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? '', /3 assignment\(s\) are still incomplete/);
    assert.equal(transitionCheck<EventState>('Event', 'JUDGING', 'RESULTS_PENDING', ctx({ facts: { incompleteAssignments: 3 }, override: true })).allowed, true);
  });

  test('registration cannot open before a registration window exists', () => {
    const denied = transitionCheck<EventState>('Event', 'DRAFT', 'REGISTRATION', ctx({ facts: {} }));
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? '', /registration window/);
  });
});

describe('state machines: submission lifecycle', () => {
  test('submitting is blocked outside the submission window without an override', () => {
    const denied = transitionCheck<SubmissionState>('Submission', 'DRAFT', 'SUBMITTED', ctx({ facts: { submissionWindowOpen: false } }));
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? '', /submission window is closed/);
    assert.equal(transitionCheck<SubmissionState>('Submission', 'DRAFT', 'SUBMITTED', ctx({ facts: { submissionWindowOpen: true } })).allowed, true);
    assert.equal(transitionCheck<SubmissionState>('Submission', 'DRAFT', 'SUBMITTED', ctx({ facts: { submissionWindowOpen: false }, override: true })).allowed, true);
  });

  test('a locked submission cannot silently return to SUBMITTED', () => {
    assert.equal(canTransition<SubmissionState>('Submission', 'LOCKED', 'SUBMITTED'), true, 'the edge exists but is guarded');
    const denied = transitionCheck<SubmissionState>('Submission', 'LOCKED', 'SUBMITTED', ctx());
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? '', /authorized organizer/);
  });

  test('finalization can be reversed only under override', () => {
    assert.equal(transitionCheck<SubmissionState>('Submission', 'FINALIZED', 'LOCKED', ctx()).allowed, false);
    assert.equal(transitionCheck<SubmissionState>('Submission', 'FINALIZED', 'LOCKED', ctx({ override: true })).allowed, true);
  });
});

describe('state machines: score lifecycle', () => {
  test('a submitted score cannot be revised after judging closes without an override', () => {
    const open = transitionCheck<ScoreState>('Score', 'SUBMITTED', 'DRAFT', ctx({ facts: { judgingOpen: true } }));
    assert.equal(open.allowed, true);
    const closed = transitionCheck<ScoreState>('Score', 'SUBMITTED', 'DRAFT', ctx({ facts: { judgingOpen: false } }));
    assert.equal(closed.allowed, false);
    assert.equal(transitionCheck<ScoreState>('Score', 'SUBMITTED', 'DRAFT', ctx({ facts: { judgingOpen: false }, override: true })).allowed, true);
  });

  test('locked scores are immutable to everyone but an overriding organizer', () => {
    assert.equal(transitionCheck<ScoreState>('Score', 'LOCKED', 'DRAFT', ctx()).allowed, false);
    assert.equal(transitionCheck<ScoreState>('Score', 'LOCKED', 'DRAFT', ctx({ override: true })).allowed, true);
  });

  test('locking always works so unfinished judging can still be closed out', () => {
    assert.equal(transitionCheck<ScoreState>('Score', 'DRAFT', 'SUBMITTED', ctx()).allowed, true);
    assert.equal(transitionCheck<ScoreState>('Score', 'SUBMITTED', 'LOCKED', ctx()).allowed, true);
  });
});

describe('state machines: error surface', () => {
  test('TransitionError carries machine-readable context', () => {
    try {
      assertTransition<EventState>('Event', 'ARCHIVED', 'JUDGING', ctx());
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof TransitionError);
      assert.equal(error.code, 'ILLEGAL_TRANSITION');
      assert.equal(error.entity, 'Event');
      assert.equal(error.from, 'ARCHIVED');
      assert.equal(error.to, 'JUDGING');
    }
  });
});

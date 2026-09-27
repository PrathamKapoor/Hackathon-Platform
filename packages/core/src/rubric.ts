/**
 * Rubric model and weighted scoring (spec §19, §21).
 *
 * A rubric version is an immutable, ordered set of criteria. Each criterion
 * declares a scale `[min, max]`, a non-negative weight, whether it is required,
 * and a scoring type. The mathematical contract is fixed here and documented in
 * JUDGING.md:
 *
 *   normalised_i  = clamp((value_i - min_i) / (max_i - min_i), 0, 1)
 *   rawScore_j    = 100 * SUM_i ( weight_i * normalised_i )      with SUM weight_i = 1
 *
 * Consequences, all deliberate:
 *  - Criteria on different scales (0-10, 0-5, 0/1) are directly comparable.
 *  - Weights summing to 1 keep every review inside [0, 100].
 *  - A criterion with min == max is rejected at configuration time, so the
 *    denominator is never zero.
 *  - Missing required criteria make a review invalid rather than silently
 *    re-weighting the remaining criteria (which would let judges inflate
 *    scores by skipping hard criteria).
 */

import { clamp, roundTo } from './statistics.ts';
import type { ScoringType } from './types.ts';

/** Weights are compared with this tolerance when validating a sum of 1. */
export const WEIGHT_SUM_TOLERANCE = 1e-6;

/** Internal precision for weighted arithmetic; display precision is separate. */
export const INTERNAL_PRECISION = 10;

/** Decimal places used when persisting a computed 0..100 score. */
export const SCORE_PRECISION = 6;

/** Decimal places used for display in the UI and CSV exports. */
export const SCORE_DISPLAY_PRECISION = 2;

export type RubricCriterion = {
  id: string;
  /** Stable machine key, unique within the rubric version. */
  key: string;
  name: string;
  description: string;
  /**
   * Relative importance. Must be in [0, 1]; the set must sum to 1 when the
   * rubric version requires it (the default).
   */
  weight: number;
  min: number;
  max: number;
  required: boolean;
  scoringType: ScoringType;
  order: number;
  /** Marks a criterion whose breakdown is shown publicly in the results. */
  publishBreakdown: boolean;
};

export type RoundingPolicy = {
  /** Decimal places for the persisted 0..100 score. */
  precision: number;
  /** How ties in the final rank are broken; documented in JUDGING.md. */
  mode: 'HALF_UP';
};

export type RubricVersion = {
  id: string;
  rubricId: string;
  version: number;
  status: 'DRAFT' | 'ACTIVE' | 'LOCKED' | 'RETIRED';
  criteria: RubricCriterion[];
  /** When true the weights must sum to exactly 1 (within tolerance). */
  weightsMustSumToOne: boolean;
  rounding: RoundingPolicy;
  /** Tie-break criterion keys, highest priority first. */
  tieBreakPriority: string[];
  notes: string;
};

export class RubricValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Rubric is invalid: ${issues.join('; ')}`);
    this.name = 'RubricValidationError';
    this.issues = issues;
  }
}

/**
 * A value fell outside the range its criterion declares.
 *
 * Its own error type rather than a bare `RangeError`, because the two mean
 * different things to a caller: a `RangeError` reaching the HTTP layer is an
 * unmapped unknown and renders as a 500, whereas this is the ordinary,
 * expected consequence of a judge typing a value the slider could not produce —
 * which is a 422 with the field and the bound named. Throwing `RangeError` here
 * meant a mis-typed score tripped server-error alerting during a live event.
 */
export class ScoreOutOfRangeError extends Error {
  readonly field: string;
  readonly min: number;
  readonly max: number;
  readonly received: number;

  /**
   * @param label already a human description of the field, e.g.
   *        `Score for "technical"`. It is used verbatim rather than wrapped in
   *        another prefix, because the call sites already phrase it well and
   *        wrapping produced messages like `Score for "Score for "x""`.
   */
  constructor(label: string, min: number, max: number, received: number) {
    // A non-finite value is called out as such rather than printed. JSON has no
    // NaN, so a client that produced one sent null, "" or a truncated number —
    // and "must be a finite number" is the only message that tells them what to
    // fix.
    const detail = Number.isFinite(received)
      ? `must be between ${min} and ${max}, received ${received}`
      : `must be a finite number between ${min} and ${max}`;
    super(`${label} ${detail}`);
    this.name = 'ScoreOutOfRangeError';
    this.field = label;
    this.min = min;
    this.max = max;
    this.received = received;
  }
}

/* ------------------------------------------------------- normalisation */

/**
 * Map a raw criterion value onto [0, 1] using the criterion's own scale.
 * Returns `null` only for a non-finite value or a degenerate scale, both of
 * which are configuration errors surfaced at validation time.
 */
export function normaliseCriterionValue(
  value: number,
  min: number,
  max: number,
): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max <= min) return null;
  const raw = (value - min) / (max - min);
  return clamp(raw, 0, 1) as number;
}

export function assertValueInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new ScoreOutOfRangeError(label, min, max, value);
  }
  if (max <= min) {
    // A degenerate scale is a configuration fault, not a judge fault, so it
    // stays a plain error: the rubric is broken and the organizer must fix it.
    throw new RubricValidationError([`${label} has a degenerate scale (min ${min} >= max ${max})`]);
  }
  const tolerance = 1e-9;
  if (value < min - tolerance || value > max + tolerance) {
    throw new ScoreOutOfRangeError(label, min, max, value);
  }
}

/* ---------------------------------------------------------- validation */

export function validateRubricVersion(version: RubricVersion): string[] {
  const issues: string[] = [];

  if (version.criteria.length === 0) {
    issues.push('at least one criterion is required');
  }

  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const criterion of version.criteria) {
    if (criterion.key.trim() === '') issues.push('every criterion needs a key');
    if (keys.has(criterion.key)) issues.push(`duplicate criterion key "${criterion.key}"`);
    keys.add(criterion.key);
    if (ids.has(criterion.id)) issues.push(`duplicate criterion id "${criterion.id}"`);
    ids.add(criterion.id);
    if (criterion.name.trim() === '') issues.push(`criterion "${criterion.key}" needs a name`);
    if (!Number.isFinite(criterion.weight) || criterion.weight < 0) {
      issues.push(`criterion "${criterion.key}" has a negative or non-finite weight`);
    }
    if (!Number.isFinite(criterion.min) || !Number.isFinite(criterion.max)) {
      issues.push(`criterion "${criterion.key}" has a non-finite scale`);
    } else if (criterion.max <= criterion.min) {
      issues.push(`criterion "${criterion.key}" must have max > min`);
    }
    if (criterion.scoringType === 'INTEGER' && !Number.isInteger(criterion.min)) {
      issues.push(`criterion "${criterion.key}" is INTEGER but min is not an integer`);
    }
  }

  if (!version.criteria.some((c) => c.required)) {
    issues.push('at least one criterion must be required');
  }

  const totalWeight = version.criteria.reduce((acc, c) => acc + (Number.isFinite(c.weight) ? c.weight : 0), 0);
  if (version.weightsMustSumToOne) {
    if (Math.abs(totalWeight - 1) > WEIGHT_SUM_TOLERANCE) {
      issues.push(
        `weights must sum to 1.0 (they sum to ${roundTo(totalWeight, 6)}) — express them as fractions such as 0.30`,
      );
    }
  } else if (totalWeight <= 0) {
    issues.push('the total weight must be greater than zero');
  }

  for (const key of version.tieBreakPriority) {
    if (!keys.has(key)) issues.push(`tie-break priority references unknown criterion "${key}"`);
  }

  if (version.rounding.precision < 0 || version.rounding.precision > 12) {
    issues.push('rounding precision must be between 0 and 12');
  }

  return issues;
}

export function assertValidRubricVersion(version: RubricVersion): void {
  const issues = validateRubricVersion(version);
  if (issues.length > 0) throw new RubricValidationError(issues);
}

/**
 * Renormalise weights to sum to exactly 1 so that a rubric configured with
 * "30 / 20 / 20 / 15 / 15" (percentages) behaves identically to fractions.
 * The largest-remainder method keeps the result deterministic and exact.
 */
export function normaliseWeights(weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || !Number.isFinite(total)) {
    throw new RubricValidationError(['cannot normalise weights with a non-positive total']);
  }
  const exact = weights.map((w) => w / total);
  // Guard against floating point drift so the sum is exactly 1.
  const rounded = exact.map((w) => roundTo(w, 12));
  const drift = roundTo(1 - rounded.reduce((a, b) => a + b, 0), 12);
  if (drift !== 0) {
    let largestIndex = 0;
    for (let i = 1; i < rounded.length; i += 1) {
      if ((exact[i] as number) > (exact[largestIndex] as number)) largestIndex = i;
    }
    rounded[largestIndex] = roundTo((rounded[largestIndex] as number) + drift, 12);
  }
  return rounded;
}

/* ---------------------------------------------------------- evaluation */

export type CriterionInput = {
  criterionId: string;
  value: number;
  comment?: string | null;
};

export type ScoredCriterion = {
  criterionId: string;
  key: string;
  name: string;
  weight: number;
  min: number;
  max: number;
  rawValue: number;
  normalised: number;
  /** weight * normalised, the criterion's contribution to the 0..1 total. */
  contribution: number;
  /** normalised * 100, the criterion's contribution to the 0..100 score. */
  pointsOutOf100: number;
  comment: string | null;
  required: boolean;
};

export type ReviewEvaluation = {
  /** 0..1, unrounded. */
  total: number;
  /** 0..100, rounded to the rubric's precision. */
  score100: number;
  criteria: ScoredCriterion[];
  missingRequired: string[];
  unknownCriterionIds: string[];
  /** True when every required criterion is present and within range. */
  complete: boolean;
};

export type EvaluationOptions = {
  /**
   * When true, missing optional criteria are treated as scoring the criterion
   * minimum (contributing zero). When false they are simply excluded, which is
   * the default: weights are never silently redistributed.
   */
  missingOptionalAsMin?: boolean;
};

/**
 * Evaluate a single judge's review against a rubric version.
 * Pure: no I/O, no mutation, fully deterministic.
 */
export function evaluateReview(
  version: RubricVersion,
  inputs: readonly CriterionInput[],
  options: EvaluationOptions = {},
): ReviewEvaluation {
  const byCriterion = new Map<string, CriterionInput>();
  for (const input of inputs) {
    byCriterion.set(input.criterionId, input);
  }

  const weights = version.weightsMustSumToOne
    ? version.criteria.map((c) => c.weight)
    : normaliseWeights(version.criteria.map((c) => c.weight));

  const scored: ScoredCriterion[] = [];
  const missingRequired: string[] = [];
  const unknownCriterionIds: string[] = [];

  version.criteria.forEach((criterion, index) => {
    const weight = weights[index] as number;
    const input = byCriterion.get(criterion.id);

    if (!input) {
      if (criterion.required) missingRequired.push(criterion.key);
      if (options.missingOptionalAsMin) {
        scored.push({
          criterionId: criterion.id,
          key: criterion.key,
          name: criterion.name,
          weight,
          min: criterion.min,
          max: criterion.max,
          rawValue: criterion.min,
          normalised: 0,
          contribution: 0,
          pointsOutOf100: 0,
          comment: null,
          required: criterion.required,
        });
      }
      return;
    }

    assertValueInRange(input.value, criterion.min, criterion.max, `Score for "${criterion.key}"`);
    const normalised = normaliseCriterionValue(input.value, criterion.min, criterion.max) as number;
    const contribution = roundTo(normalised * weight, INTERNAL_PRECISION);
    scored.push({
      criterionId: criterion.id,
      key: criterion.key,
      name: criterion.name,
      weight,
      min: criterion.min,
      max: criterion.max,
      rawValue: input.value,
      normalised: roundTo(normalised, INTERNAL_PRECISION),
      contribution,
      pointsOutOf100: roundTo(normalised * weight * 100, INTERNAL_PRECISION),
      comment: input.comment ?? null,
      required: criterion.required,
    });
  });

  for (const input of inputs) {
    if (!version.criteria.some((c) => c.id === input.criterionId)) {
      unknownCriterionIds.push(input.criterionId);
    }
  }

  const total = roundTo(scored.reduce((acc, c) => acc + c.contribution, 0), INTERNAL_PRECISION);
  const bounded = clamp(total, 0, 1) as number;

  return {
    total: bounded,
    score100: roundTo(bounded * 100, version.rounding.precision),
    criteria: scored,
    missingRequired,
    unknownCriterionIds,
    complete: missingRequired.length === 0,
  };
}

/** Averages a set of criterion-level contributions, ignoring absent judges. */
export function weightedCriterionBreakdown(
  version: RubricVersion,
  evaluations: readonly ReviewEvaluation[],
): { key: string; name: string; weight: number; meanNormalised: number | null; pointsOutOf100: number | null; judgeCount: number }[] {
  return version.criteria.map((criterion) => {
    const values: number[] = [];
    for (const evaluation of evaluations) {
      const found = evaluation.criteria.find((c) => c.criterionId === criterion.id);
      if (found) values.push(found.normalised);
    }
    const meanNormalised =
      values.length === 0 ? null : roundTo(values.reduce((a, b) => a + b, 0) / values.length, INTERNAL_PRECISION);
    return {
      key: criterion.key,
      name: criterion.name,
      weight: criterion.weight,
      meanNormalised,
      pointsOutOf100: meanNormalised === null ? null : roundTo(meanNormalised * criterion.weight * 100, SCORE_DISPLAY_PRECISION),
      judgeCount: values.length,
    };
  });
}

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  coefficientOfVariation,
  finiteOrNull,
  mean,
  median,
  quantile,
  robustOutlierRate,
  robustSigma,
  roundTo,
  safeDiv,
  sortedAsc,
  stableMean,
  stddev,
  stddevPopulation,
  stddevSample,
  sum,
  toPercent,
  trimmedMean,
  variancePopulation,
  varianceSample,
  assertFiniteScore,
} from '../src/statistics.ts';

describe('statistics: safe arithmetic', () => {
  test('safeDiv returns null rather than Infinity or NaN', () => {
    assert.equal(safeDiv(1, 0), null);
    assert.equal(safeDiv(0, 0), null);
    assert.equal(safeDiv(10, 4), 2.5);
    assert.equal(safeDiv(1, Number.NaN), null);
    assert.equal(safeDiv(Number.POSITIVE_INFINITY, 2), null);
  });

  test('finiteOrNull rejects NaN and Infinity, normalises -0', () => {
    assert.equal(finiteOrNull(Number.NaN), null);
    assert.equal(finiteOrNull(Number.POSITIVE_INFINITY), null);
    assert.equal(finiteOrNull(Number.NEGATIVE_INFINITY), null);
    assert.ok(Object.is(finiteOrNull(-0), 0));
    assert.equal(finiteOrNull('42'), null);
    assert.equal(finiteOrNull(42), 42);
  });

  test('clamp rejects inverted bounds instead of returning nonsense', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-5, 0, 10), 0);
    assert.equal(clamp(50, 0, 10), 10);
    assert.equal(clamp(5, 10, 0), null);
    assert.equal(clamp(Number.NaN, 0, 10), null);
  });
});

describe('statistics: descriptive measures', () => {
  test('empty samples yield null everywhere', () => {
    assert.equal(mean([]), null);
    assert.equal(median([]), null);
    assert.equal(stddev([]), null);
    assert.equal(varianceSample([]), null);
    assert.equal(variancePopulation([]), null);
    assert.equal(quantile([], 0.5), null);
    assert.equal(sum([]), 0);
  });

  test('known-value checks', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    assert.equal(mean(xs), 5);
    assert.equal(stableMean(xs), 5);
    assert.equal(median(xs), 4.5);
    assert.equal(quantile(xs, 0), 2);
    assert.equal(quantile(xs, 1), 9);
    assert.equal(quantile(xs, 0.25), 4);
    assert.equal(variancePopulation(xs), 4);
    assert.equal(varianceSample(xs), 32 / 7);
    assert.ok(Math.abs((stddevPopulation(xs) as number) - 2) < 1e-12);
    assert.equal(stddevSample([5]), 0, 'a single observation has no observed dispersion');
    assert.equal(stddev([5, 5, 5]), 0, 'identical values have zero spread');
  });

  test('quantile uses the R-7 / PERCENTILE.INC convention', () => {
    // n=4: h = 3 * 0.5 = 1.5 -> interpolate between index 1 and 2.
    assert.equal(quantile([10, 20, 30, 40], 0.5), 25);
    // n=3, p=0.25: h = 0.5 -> midpoint of the two lowest.
    assert.equal(quantile([1, 2, 3], 0.25), 1.5);
    assert.equal(quantile([7], 0.9), 7);
    assert.equal(quantile([1, 2], 0.5), 1.5);
  });

  test('quantile rejects out-of-range probabilities', () => {
    assert.equal(quantile([1, 2], -0.1), null);
    assert.equal(quantile([1, 2], 1.1), null);
    assert.equal(quantile([1, 2], Number.NaN), null);
  });

  test('median of an even-length sample interpolates', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([10, 20]), 15);
  });

  test('medianAbsoluteDeviation is zero for identical values', () => {
    assert.equal(robustSigma([3, 3, 3, 3]), 0);
    assert.equal(robustOutlierRate([3, 3, 3, 3]), 0, 'identical values contain no outliers');
  });

  test('robustSigma uses the 1.4826 normal-consistency factor', () => {
    // median([1,2,3,4,5]) = 3, deviations = [2,1,0,1,2], MAD = 1.
    assert.equal(robustSigma([1, 2, 3, 4, 5]), 1.4826);
  });

  test('robustSigma is far more outlier-resistant than the standard deviation', () => {
    const clean = [50, 52, 48, 51, 49, 50, 53, 47];
    const polluted = [...clean, 1000];
    const sigmaGrowth = (stddev(polluted) as number) / (stddev(clean) as number);
    const robustGrowth = (robustSigma(polluted) as number) / (robustSigma(clean) as number);
    assert.ok(sigmaGrowth > 4, `a single outlier should multiply the stddev (grew ${sigmaGrowth.toFixed(2)}x)`);
    assert.ok(robustGrowth < 1.6, `robust sigma should barely move (grew ${robustGrowth.toFixed(2)}x)`);
  });

  test('robustOutlierRate flags a single extreme value', () => {
    const xs = [10, 11, 10, 12, 10, 11, 10, 90];
    const rate = robustOutlierRate(xs, 3) as number;
    assert.ok(rate > 0, 'the outlier should be detected');
    assert.ok(rate <= 1);
  });

  test('coefficientOfVariation is undefined for a zero mean', () => {
    assert.equal(coefficientOfVariation([-1, 1]), null);
    assert.ok(coefficientOfVariation([10, 20, 30]) !== null);
  });

  test('trimmedMean drops floor(n * trim) observations from each tail', () => {
    // n = 5, trim = 0.2 -> k = 1 dropped from each tail -> mean of [2,3,4]
    assert.equal(trimmedMean([1, 2, 3, 4, 5], 0.2), 3);
    assert.equal(trimmedMean([1, 2, 3, 4, 100], 0.2), 3, 'the outlier is excluded');
    assert.equal(trimmedMean([1, 2, 3, 4, 100], 0), 22);
    assert.equal(trimmedMean([1, 2, 3, 4, 100], 0.5), 3, 'trim >= 0.5 degrades to the median');
    // n = 10, trim = 0.2 -> k = 2 from each tail -> mean of [3..8]
    assert.equal(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 0.2), 5.5);
  });

  test('trimmedMean with tiny samples falls back to the mean', () => {
    assert.equal(trimmedMean([5], 0.2), 5);
    assert.equal(trimmedMean([5, 7], 0.2), 6);
  });
});

describe('statistics: rounding', () => {
  test('roundTo applies half-away-from-zero deterministically', () => {
    assert.equal(roundTo(0.125, 2), 0.13);
    assert.equal(roundTo(-0.125, 2), -0.13);
    assert.equal(roundTo(2.345, 2), 2.35);
    assert.equal(roundTo(1.004, 2), 1, 'binary representation error is corrected');
    assert.equal(roundTo(2, 0), 2);
    assert.equal(roundTo(1.5, 0), 2);
    assert.equal(roundTo(-1.5, 0), -2);
  });

  test('roundTo neutralises non-finite input', () => {
    assert.equal(roundTo(Number.NaN, 2), 0);
    assert.equal(roundTo(Number.POSITIVE_INFINITY, 2), 0);
  });

  test('toPercent never renders NaN', () => {
    assert.equal(toPercent(0.5), 50);
    assert.equal(toPercent(null), null);
    assert.equal(toPercent(0.12345, 2), 12.35);
  });
});

describe('statistics: final score gate', () => {
  test('assertFiniteScore rejects anything that could poison a result', () => {
    assert.equal(assertFiniteScore(42.5), 42.5);
    assert.throws(() => assertFiniteScore(Number.NaN), RangeError);
    assert.throws(() => assertFiniteScore(Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => assertFiniteScore('80'), RangeError);
    assert.throws(() => assertFiniteScore(null), RangeError);
  });
});

describe('statistics: numeric stability', () => {
  test('stableMean is accurate for large-magnitude, low-variance samples', () => {
    // Naive summation loses the low-order bits here; the two-pass form does not.
    const xs = Array.from({ length: 10_000 }, (_, i) => 1e9 + (i % 2));
    const naive = xs.reduce((a, b) => a + b, 0) / xs.length;
    const stable = stableMean(xs) as number;
    assert.ok(Math.abs(stable - 1e9 - 0.5) < 1e-6, `stableMean was ${stable}`);
    assert.ok(Number.isFinite(naive));
  });

  test('sortedAsc does not mutate its input', () => {
    const xs = [3, 1, 2];
    const sorted = sortedAsc(xs);
    assert.deepEqual(sorted, [1, 2, 3]);
    assert.deepEqual(xs, [3, 1, 2]);
  });

  test('stddev is the population form by default', () => {
    const xs = [1, 2, 3, 4];
    assert.equal(stddev(xs), stddevPopulation(xs));
    assert.notEqual(stddev(xs), stddevSample(xs));
  });
});

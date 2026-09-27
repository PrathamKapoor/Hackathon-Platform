/**
 * Deterministic numeric helpers.
 *
 * Every judging computation in Verdict flows through this module. The rules are
 * deliberately boring and explicit because reproducibility is a product
 * requirement, not an implementation detail:
 *
 *  1. Division by zero yields `null`, never `Infinity` and never `NaN`.
 *  2. Empty samples yield `null` for every statistic.
 *  3. Degenerate samples (n = 1, zero variance, all-equal values) yield the
 *     mathematically correct degenerate answer (`0` spread) rather than an error.
 *  4. All public functions are pure and side-effect free.
 */

/** A finite number, or `null` when the value is mathematically undefined. */
export type MaybeNumber = number | null;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Coerce anything into a finite number or `null`.
 * Rejects NaN, Infinity, -0 is normalised to 0.
 */
export function finiteOrNull(value: unknown): MaybeNumber {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return value === 0 ? 0 : value;
}

/** Safe division. Returns `null` when the divisor is zero or invalid. */
export function safeDiv(numerator: number, denominator: number): MaybeNumber {
  if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator)) return null;
  if (denominator === 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

/** Discard nulls / non-finite entries from a sample. */
export function compact(values: readonly (number | null | undefined)[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    const n = finiteOrNull(value);
    if (n !== null) out.push(n);
  }
  return out;
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function count(values: readonly number[]): number {
  return values.length;
}

export function min(values: readonly number[]): MaybeNumber {
  if (values.length === 0) return null;
  let m = values[0] as number;
  for (const v of values) if (v < m) m = v;
  return m;
}

export function max(values: readonly number[]): MaybeNumber {
  if (values.length === 0) return null;
  let m = values[0] as number;
  for (const v of values) if (v > m) m = v;
  return m;
}

/**
 * Round half away from zero at `precision` decimal places.
 *
 * We use half-away-from-zero rather than JavaScript's `toFixed` (which is
 * notoriously inconsistent for negative halves) and rather than IEEE-754
 * banker's rounding, because "0.125 -> 0.13" is far easier to explain to an
 * organizer than either alternative. Ties are rare in real score data, but the
 * rule must still be deterministic and documented.
 */
export function roundTo(value: number, precision: number): number {
  if (!isFiniteNumber(value)) return 0;
  const factor = 10 ** precision;
  const scaled = value * factor;
  // Correct for binary representation error before applying the half-up rule.
  const nudged = scaled >= 0 ? Math.round(scaled + Number.EPSILON * Math.abs(scaled)) : -Math.round(-scaled + Number.EPSILON * Math.abs(scaled));
  return nudged / factor;
}

/** Round to a fixed number of decimals, guaranteeing a finite result. */
export function round(value: MaybeNumber, precision = 4): MaybeNumber {
  if (value === null) return null;
  return roundTo(value, precision);
}

export function mean(values: readonly (number | null | undefined)[]): MaybeNumber {
  const sample = compact(values);
  if (sample.length === 0) return null;
  return sum(sample) / sample.length;
}

/**
 * Arithmetic mean computed with a numerically stable two-pass algorithm
 * (subtract the midpoint first). Matters when normalising large score sets
 * where naive summation loses low-order bits and therefore breaks
 * bit-for-bit reproducibility across engines.
 */
export function stableMean(values: readonly number[]): MaybeNumber {
  if (values.length === 0) return null;
  const mid = (min(values)! + max(values)!) / 2;
  let acc = 0;
  for (const v of values) acc += v - mid;
  return mid + acc / values.length;
}

/** Ascending sort of a copy. */
export function sortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Ascending sort of a copy, NaN-safe. */
export function sortedAscSafe(values: readonly (number | null | undefined)[]): number[] {
  return sortedAsc(compact(values));
}

/**
 * Linear-interpolated quantile on the sorted sample.
 *
 * `p` is a probability in [0, 1]. Uses the R-7 / Excel PERCENTILE.INC /
 * numpy default convention, documented here so results are reproducible by
 * third parties.
 */
export function quantile(values: readonly number[], p: number): MaybeNumber {
  if (!isFiniteNumber(p) || p < 0 || p > 1) return null;
  const s = sortedAsc(values);
  const n = s.length;
  if (n === 0) return null;
  if (n === 1) return s[0] as number;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return s[lo] as number;
  return (s[lo] as number) + ((h - lo) * ((s[hi] as number) - (s[lo] as number)));
}

export function median(values: readonly (number | null | undefined)[]): MaybeNumber {
  return quantile(compact(values), 0.5);
}

/**
 * Sample variance (Bessel-corrected, n - 1 denominator).
 * Returns 0 for a single observation, which is the correct degenerate result:
 * a judge who has submitted exactly one score has no observed dispersion.
 */
export function varianceSample(values: readonly number[]): MaybeNumber {
  const n = values.length;
  if (n < 2) return n === 1 ? 0 : null;
  const m = stableMean(values)!;
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return acc / (n - 1);
}

/** Population variance (n denominator). */
export function variancePopulation(values: readonly number[]): MaybeNumber {
  const n = values.length;
  if (n === 0) return null;
  const m = stableMean(values)!;
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return acc / n;
}

export function stddevSample(values: readonly number[]): MaybeNumber {
  const v = varianceSample(values);
  return v === null ? null : Math.sqrt(v);
}

export function stddevPopulation(values: readonly number[]): MaybeNumber {
  const v = variancePopulation(values);
  return v === null ? null : Math.sqrt(v);
}

/** Population standard deviation — the default for judging panels. */
export function stddev(values: readonly number[]): MaybeNumber {
  return stddevPopulation(values);
}

/**
 * Median absolute deviation, scaled by 1.4826 so that it is a consistent
 * estimator of the standard deviation for normally distributed data.
 * Returns 0 when all values are identical (a real, meaningful signal).
 */
export function medianAbsoluteDeviation(values: readonly number[]): MaybeNumber {
  const n = values.length;
  if (n === 0) return null;
  const med = median(values)!;
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations)!;
}

export function robustSigma(values: readonly number[]): MaybeNumber {
  const mad = medianAbsoluteDeviation(values);
  return mad === null ? null : mad * 1.4826;
}

export function range(values: readonly number[]): MaybeNumber {
  const lo = min(values);
  const hi = max(values);
  if (lo === null || hi === null) return null;
  return hi - lo;
}

/** Coefficient of variation; `null` when the mean is zero (undefined). */
export function coefficientOfVariation(values: readonly number[]): MaybeNumber {
  const m = stableMean(values);
  const sd = stddev(values);
  if (m === null || sd === null || m === 0) return null;
  return safeDiv(sd, Math.abs(m));
}

/**
 * Fraction of observations that deviate more than `threshold` robust sigmas
 * from the median. `null` when robust sigma is zero, because in that case the
 * statistic is undefined rather than infinite.
 */
export function robustOutlierRate(values: readonly number[], threshold = 3): MaybeNumber {
  if (values.length === 0) return null;
  const med = median(values);
  const sigma = robustSigma(values);
  if (med === null || sigma === null) return null;
  if (sigma === 0) {
    // Degenerate spread: every value equals the median, hence zero outliers.
    const allEqual = values.every((v) => v === med);
    return allEqual ? 0 : null;
  }
  let outliers = 0;
  for (const v of values) if (Math.abs(v - med) > threshold * sigma) outliers += 1;
  return outliers / values.length;
}

/** Trimmed mean: drops `trim` proportions from each tail. */
export function trimmedMean(values: readonly number[], trim = 0.2): MaybeNumber {
  const s = sortedAsc(values);
  const n = s.length;
  if (n === 0) return null;
  if (trim <= 0) return stableMean(s);
  if (trim >= 0.5) return median(s);
  const k = Math.floor(n * trim);
  if (k === 0) return stableMean(s);
  const kept = s.slice(k, n - k);
  if (kept.length === 0) return median(s);
  return stableMean(kept);
}

/** Clamp a value into [lo, hi]; returns `null` if any bound is invalid. */
export function clamp(value: number, lo: number, hi: number): MaybeNumber {
  if (!isFiniteNumber(value) || !isFiniteNumber(lo) || !isFiniteNumber(hi)) return null;
  if (lo > hi) return null;
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Convert a value to a display-friendly 0..100 percentage.
 * `null` when the value is undefined — we never render "NaN%".
 */
export function toPercent(value: MaybeNumber, precision = 1): MaybeNumber {
  if (value === null) return null;
  return roundTo(value * 100, precision);
}

/**
 * Final gate before any score enters a result snapshot.
 * Returns `null` for anything that is not a finite number in a sane range.
 * This is the last line of defence against NaN/Infinity reaching published
 * results (spec §24).
 */
export function assertFiniteScore(value: unknown, label = 'score'): number {
  const n = finiteOrNull(value);
  if (n === null) {
    throw new RangeError(`Non-finite ${label} rejected: ${String(value)}`);
  }
  return n;
}

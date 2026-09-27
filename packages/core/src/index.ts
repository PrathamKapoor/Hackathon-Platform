/**
 * @verdict/core — the judging engine.
 *
 * Everything exported here is a pure function or an immutable constant. There
 * are no database handles, no HTTP objects and no clocks other than values
 * passed in by the caller. That constraint is what makes the judging
 * mathematics testable, reproducible and auditable.
 *
 * The API layer supplies context (which judge, which event, what time is it)
 * and persists the results; it never computes them.
 */

export * from './types.ts';
export * from './statistics.ts';
export * from './random.ts';
export * from './integrity.ts';
export * from './time.ts';
export * from './state-machines.ts';
export * from './rubric.ts';
export * from './normalization.ts';
export * from './aggregation.ts';
export * from './pairwise.ts';
export * from './assignment.ts';
export * from './diagnostics.ts';
export * from './csv.ts';
export * from './validation.ts';
export * from './result-pipeline.ts';
export * from './ids.ts';

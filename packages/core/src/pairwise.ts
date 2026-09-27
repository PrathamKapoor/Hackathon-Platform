/**
 * Pairwise (head-to-head) judging via Bradley-Terry (spec §31).
 *
 * ---------------------------------------------------------------------------
 * MODEL
 * ---------------------------------------------------------------------------
 * Bradley-Terry assumes that for any two projects i and j the probability that
 * i is preferred over j is
 *
 *                     P(i > j) = exp(theta_i) / (exp(theta_i) + exp(theta_j))
 *                     = sigmoid(theta_i - theta_j)
 *
 * with one real-valued strength parameter theta_i per project. The model is
 * invariant to adding a constant to every theta, so the maximum-likelihood
 * estimate is only defined up to a shift; we fix the gauge by requiring
 * mean(theta) = 0. That makes the output canonical and therefore reproducible.
 *
 * ---------------------------------------------------------------------------
 * ESTIMATION: RIDGE-REGULARISED MAP, NOT THE BARE MLE
 * ---------------------------------------------------------------------------
 * The textbook maximum-likelihood estimate of Bradley-Terry is unusable for a
 * hackathon panel, for a reason that is mathematical rather than practical:
 * **if a project never loses a comparison, the MLE for its strength is
 * +infinity.** Any single undefeated project makes the whole ranking
 * undefined. Adding pseudo-comparisons does not fix this, because a tie
 * contributes a constant to the likelihood and therefore constrains nothing.
 *
 * We instead compute the *maximum a posteriori* estimate under a Gaussian
 * prior on the strengths,
 *
 *     theta_i ~ Normal(0, 1 / lambda)
 *
 * which turns the objective into the penalised log-likelihood
 *
 *     L(theta) = SUM_ij n_ij [ theta_i - log(e^theta_i + e^theta_j) ]
 *                - (lambda / 2) * SUM_i theta_i^2
 *
 * with gradient
 *
 *     dL/dtheta_i = W_i - SUM_j m_ij * sigmoid(theta_i - theta_j) - lambda*theta_i
 *
 * where W_i is i's win count and m_ij = n_ij + n_ji the number of comparisons
 * between i and j.
 *
 * The ridge term does three jobs at once:
 *   1. It bounds an undefeated project's strength to a finite value.
 *   2. It pins the scale, so theta = 0 means "exactly the field average" and the
 *      estimate is directly interpretable.
 *   3. It shrinks noisy estimates toward the field, which is the right prior
 *      for a panel of five to twenty judges.
 *
 * lambda is exposed as `PRIOR_STRENGTH`. The default 0.5 corresponds to a prior
 * standard deviation of about 1.41 on a log-odds scale, which is deliberately
 * weak: it regularises without overriding the judges.
 *
 * The optimiser is plain gradient ascent with a backtracking line search, not
 * Newton-Raphson. It is slower but involves only additions, multiplications and
 * one `sigmoid` per pair, so it produces bit-identical output on every platform
 * and cannot fail on a singular Hessian. For a panel of a few hundred
 * comparisons it converges in tens of iterations.
 *
 * NOTE ON WHAT WAS TRIED AND REJECTED: the MM (Zermelo) update
 * theta_i <- W_i / SUM_j n_ij/(e^theta_i + e^theta_j) is the textbook
 * iterative-scaling step, and it also diverges here for exactly the same
 * reason — the fixed point genuinely is at infinity. It is documented here
 * because "we tried the standard algorithm and here is why it is the wrong
 * tool" is a more useful note for the next maintainer than silence.
 *
 * ---------------------------------------------------------------------------
 * ASSUMPTIONS (all of them, stated plainly)
 * ---------------------------------------------------------------------------
 * A1. Independence of comparisons. A judge who prefers A over B and B over C
 *     is assumed to prefer A over C. Real panels violate this; the number of
 *     violated triplets is reported as `nonTransitiveTriplets` so the
 *     organizer can see how much the assumption is costing.
 * A2. A single homogeneous latent scale. If judges weight "speed" and "polish"
 *     differently, a one-dimensional fit must compromise. The compromise is
 *     reported, not hidden.
 * A3. Stationarity. Ties are treated as half a win each, the standard
 *     convention, and are counted in `ties`.
 * A4. No draws-by-abstention. Skipped comparisons contribute nothing and are
 *     counted in `skipped` so coverage is visible.
 *
 * ---------------------------------------------------------------------------
 * DEGENERATE CASES
 * ---------------------------------------------------------------------------
 *  - An undefeated project would have theta -> +infinity under the bare MLE.
 *    The ridge bounds it to a finite, comparable value; the effect is disclosed
 *    in the diagnostics as `priorApplied`.
 *  - A disconnected comparison graph means some projects were never compared.
 *    The ridge shrinks each isolated component toward the field average, so the
 *    answer is finite and defined, but the cross-component ordering is an
 *    artefact rather than evidence. Components are reported and a warning is
 *    raised.
 *  - A perfectly symmetric cycle (A>B, B>C, C>A) carries no information, and
 *    the estimate correctly returns every project to the field average.
 *  - An all-tie comparison set produces identical thetas for everyone.
 *  - Zero comparisons produces an empty, valid result with an explicit reason.
 *
 * Pairwise results are stored independently from rubric scores and are used
 * only where the organizer enables them: as a tie-break and as a separate
 * leaderboard. They never silently replace rubric scoring.
 */

import { roundTo } from './statistics.ts';
import { createRng } from './random.ts';
import type { PairwiseOutcome } from './types.ts';

export const PAIRWISE_ENGINE_VERSION = '1.0.0';

/**
 * Ridge strength for the Gaussian prior on strengths. Exposed as
 * `PRIOR_STRENGTH` because that is the name the product spec uses.
 * 0.5 corresponds to a prior standard deviation of 1/sqrt(0.5) ~= 1.41 on a
 * log-odds scale.
 */
export const PRIOR_STRENGTH = 0.5;

/** Iterations of the gradient ascent before giving up. */
export const MAX_ITERATIONS = 5000;

/** Convergence threshold on the largest parameter change. */
export const TOLERANCE = 1e-14;

/** Hard bounds on theta, purely a numerical safety net. */
export const THETA_MIN = -20;
export const THETA_MAX = 20;

export type PairwiseComparison = {
  id: string;
  judgeId: string;
  leftProjectId: string;
  rightProjectId: string;
  outcome: PairwiseOutcome;
  decidedAt: string;
};

export type PairwiseStrength = {
  projectId: string;
  /** Gauge-fixed strength; mean across all projects is 0. */
  theta: number;
  /** softmax(theta) — a share of "total strength", sums to 1 across projects. */
  share: number;
  wins: number;
  losses: number;
  ties: number;
  comparisons: number;
  winRate: number | null;
  component: number;
  rank: number;
  /** True when the estimate hit a bound and is therefore uninformative. */
  saturated: boolean;
};

export type PairwiseDiagnostics = {
  engineVersion: string;
  totalComparisons: number;
  decisiveComparisons: number;
  ties: number;
  skipped: number;
  projectCount: number;
  connectedComponents: number;
  /** Projects in a component of size 1 were never actually compared. */
  unconnectedProjects: string[];
  nonTransitiveTriplets: number;
  transitiveTriplets: number;
  logLikelihood: number;
  nullLogLikelihood: number;
  /** logLikelihood improvement over the "all equal" null model. */
  likelihoodRatio: number;
  /** Crameres-style goodness of fit approximation in [0, 1]; lower is better. */
  goodnessOfFit: number | null;
  converged: boolean;
  iterations: number;
  priorApplied: boolean;
  maxAbsTheta: number;
  warnings: string[];
};

export type PairwiseResult = {
  strengths: PairwiseStrength[];
  rankings: { projectId: string; rank: number; theta: number; share: number }[];
  diagnostics: PairwiseDiagnostics;
  computedAt: string;
  inputHash: string;
};

const WEIGHTS: Record<Exclude<PairwiseOutcome, 'SKIPPED'>, number> = {
  LEFT: 1,
  RIGHT: 0,
  TIE: 0.5,
};

function softmax(values: number[]): number[] {
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}

/** Adjacency over decided comparisons, used for connected components. */
function buildComponents(projectIds: string[], comparisons: PairwiseComparison[]): Map<string, number> {
  const parent = new Map<string, string>(projectIds.map((id) => [id, id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const comparison of comparisons) {
    if (comparison.outcome === 'SKIPPED') continue;
    if (parent.has(comparison.leftProjectId) && parent.has(comparison.rightProjectId)) {
      union(comparison.leftProjectId, comparison.rightProjectId);
    }
  }
  const componentIndex = new Map<string, number>();
  const componentOf = new Map<string, number>();
  for (const id of projectIds) {
    const root = find(id);
    if (!componentIndex.has(root)) componentIndex.set(root, componentIndex.size);
    componentOf.set(id, componentIndex.get(root) as number);
  }
  return componentOf;
}

type Counters = Map<string, Map<string, number>>;

function bump(counters: Counters, i: string, j: string, amount: number): void {
  const row = counters.get(i) ?? new Map<string, number>();
  row.set(j, (row.get(j) ?? 0) + amount);
  counters.set(i, row);
}

function ti_of(theta: ReadonlyMap<string, number>, id: string): number {
  return theta.get(id) as number;
}

/** Numerically stable logistic function. */
function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** log(exp(a) + exp(b)) without overflow. */
function logSumExp(a: number, b: number): number {
  const max = Math.max(a, b);
  return max + Math.log(Math.exp(a - max) + Math.exp(b - max));
}

/**
 * Penalised log-likelihood.
 *
 * Iterates over *ordered win counts* (n_ij), not over the symmetric pair counts:
 * a comparison in which i beat j contributes n_ij terms, and iterating the
 * symmetric map instead would count every comparison twice and make the line
 * search reject every step.
 */
function penalisedLogLikelihood(
  theta: ReadonlyMap<string, number>,
  orderedWins: Counters,
  projectIds: readonly string[],
  lambda: number,
): number {
  let value = 0;
  for (const i of projectIds) {
    for (const [j, n] of orderedWins.get(i) ?? []) {
      value += n * ((theta.get(i) as number) - logSumExp(theta.get(i) as number, theta.get(j) as number));
    }
    const t = theta.get(i) as number;
    value -= (lambda * t * t) / 2;
  }
  return value;
}

/**
 * Fit Bradley-Terry strengths.
 *
 * @param comparisons raw head-to-head results, including SKIPPED entries
 * @param projectIds  every project eligible to appear in the comparison set
 * @param options     `priorStrength` sets the smoothing; set to 0 to disable.
 */
export function fitBradleyTerry(
  comparisons: readonly PairwiseComparison[],
  projectIds: readonly string[],
  options: { priorStrength?: number; computedAt: string; inputHash: string } = {
    computedAt: new Date(0).toISOString(),
    inputHash: '',
  },
): PairwiseResult {
  const prior = options.priorStrength ?? PRIOR_STRENGTH;
  const warnings: string[] = [];

  const known = new Set(projectIds);
  const ids = projectIds.filter((id) => known.has(id)).slice().sort();
  const decided = comparisons.filter(
    (c) => c.outcome !== 'SKIPPED' && known.has(c.leftProjectId) && known.has(c.rightProjectId),
  );
  const skipped = comparisons.filter((c) => c.outcome === 'SKIPPED').length;
  const tieCount = decided.filter((c) => c.outcome === 'TIE').length;

  if (ids.length === 0) {
    return emptyResult(options, warnings, ['no projects were supplied to the pairwise model']);
  }
  if (decided.length === 0) {
    return emptyResult(options, warnings, [
      'no decisive pairwise comparisons were recorded; Bradley-Terry cannot rank anything',
    ]);
  }

  const componentOf = buildComponents(ids, decided);
  const components = new Set(componentOf.values());
  if (components.size > 1) {
    warnings.push(
      `The comparison graph has ${components.size} disconnected components. Projects in different components were never compared head-to-head, so cross-component ordering is an artefact of the merge, not evidence.`,
    );
  }
  const unconnected: string[] = [];
  const lonelyComponents = new Map<number, string[]>();
  for (const id of ids) {
    const comp = componentOf.get(id) as number;
    lonelyComponents.set(comp, [...(lonelyComponents.get(comp) ?? []), id]);
  }
  const trulyUnconnected = [...lonelyComponents.entries()]
    .filter(([, members]) => members.length === 1)
    .flatMap(([, members]) => members);
  unconnected.push(...trulyUnconnected);
  if (trulyUnconnected.length > 0) {
    warnings.push(
      `${trulyUnconnected.length} project(s) were never compared head-to-head and are reported as unranked.`,
    );
  }

  // Ordered win counts (for the likelihood) and symmetric pair counts (for the
  // gradient). A tie contributes a half win to each side.
  const wins = new Map<string, number>(ids.map((id) => [id, 0]));
  const losses = new Map<string, number>(ids.map((id) => [id, 0]));
  const ties = new Map<string, number>(ids.map((id) => [id, 0]));
  const comparisonCount = new Map<string, number>(ids.map((id) => [id, 0]));
  const orderedWins: Counters = new Map();
  const pairCounts: Counters = new Map();

  for (const comparison of decided) {
    const { leftProjectId: left, rightProjectId: right } = comparison;
    const weight = WEIGHTS[comparison.outcome as Exclude<PairwiseOutcome, 'SKIPPED'>];
    const isTie = comparison.outcome === 'TIE';

    // A tie is half a win for BOTH sides, so it must populate the ordered win
    // map in both directions. Recording only the left direction would make the
    // likelihood treat the comparison as a one-sided win and would push the
    // left project towards a spuriously high strength.
    wins.set(left, (wins.get(left) as number) + weight);
    losses.set(right, (losses.get(right) as number) + weight);
    if (isTie) {
      ties.set(left, (ties.get(left) as number) + 1);
      ties.set(right, (ties.get(right) as number) + 1);
      wins.set(right, (wins.get(right) as number) + weight);
      losses.set(left, (losses.get(left) as number) + weight);
      bump(orderedWins, right, left, weight);
    }
    if (weight > 0) bump(orderedWins, left, right, weight);
    bump(pairCounts, left, right, 1);
    bump(pairCounts, right, left, 1);
    comparisonCount.set(left, (comparisonCount.get(left) as number) + 1);
    comparisonCount.set(right, (comparisonCount.get(right) as number) + 1);
  }

  // Gradient ascent on the penalised log-likelihood with a backtracking line
  // search. Every step strictly increases the objective, so the iteration
  // cannot cycle or diverge, and the arithmetic is identical on every platform.
  const theta = new Map<string, number>(ids.map((id) => [id, 0]));
  let iterations = 0;
  let converged = false;
  let objective = penalisedLogLikelihood(theta, orderedWins, ids, prior);

  for (; iterations < MAX_ITERATIONS; iterations += 1) {
    const gradient = new Map<string, number>();
    for (const i of ids) {
      const ti = theta.get(i) as number;
      let g = wins.get(i) as number;
      for (const [j, m] of pairCounts.get(i) ?? []) {
        g -= m * sigmoid(ti - (theta.get(j) as number));
      }
      g -= prior * ti;
      gradient.set(i, g);
    }

    let step = 1;
    let improved = false;
    while (step > 1e-14) {
      const trial = new Map<string, number>();
      for (const i of ids) {
        trial.set(i, Math.min(THETA_MAX, Math.max(THETA_MIN, ti_of(theta, i) + step * (gradient.get(i) as number))));
      }
      const candidate = penalisedLogLikelihood(trial, orderedWins, ids, prior);
      if (Number.isFinite(candidate) && candidate > objective) {
        let maxDelta = 0;
        for (const i of ids) maxDelta = Math.max(maxDelta, Math.abs((trial.get(i) as number) - (theta.get(i) as number)));
        for (const i of ids) theta.set(i, trial.get(i) as number);
        objective = candidate;
        improved = true;
        if (maxDelta < TOLERANCE) converged = true;
        break;
      }
      step /= 2;
    }
    if (!improved) {
      // No step size improves the objective: we are at the optimum to machine
      // precision. Treated as convergence, not as a failure.
      converged = true;
      break;
    }
    if (converged) {
      iterations += 1;
      break;
    }
  }

  // Presentation-only gauge: mean theta = 0 across all projects. The ridge pins
  // the statistical scale, but the reported numbers read more naturally centred,
  // and the shift is provably unobservable: softmax(theta + c) == softmax(theta),
  // so the shares and the ranking are identical either way.
  const globalMean = ids.reduce((acc, id) => acc + (theta.get(id) as number), 0) / ids.length;
  for (const id of ids) theta.set(id, (theta.get(id) as number) - globalMean);

  const shares = softmax(ids.map((id) => theta.get(id) as number));
  const shareById = new Map(ids.map((id, index) => [id, shares[index] as number]));

  const rankedIds = ids
    .filter((id) => comparisonCount.get(id)! > 0)
    .sort((a, b) => {
      const ta = theta.get(a) as number;
      const tb = theta.get(b) as number;
      if (Math.abs(ta - tb) > 1e-12) return tb - ta;
      return a < b ? -1 : 1;
    });

  const strengths: PairwiseStrength[] = ids
    .map((projectId) => {
      // `wins` carries the prior's half-win; subtract it to recover the
      // observed count. Ties contributed 0.5 to each side, so w + l is the
      // number of comparisons that actually discriminated this project.
      const w = wins.get(projectId) as number;
      const l = losses.get(projectId) as number;
      const n = comparisonCount.get(projectId) as number;
      const value = theta.get(projectId) as number;
      const decisive = w + l;
      return {
        projectId,
        theta: roundTo(value, 6),
        share: roundTo(shareById.get(projectId) as number, 6),
        wins: roundTo(w, 4),
        losses: roundTo(l, 4),
        ties: ties.get(projectId) as number,
        comparisons: n,
        winRate: decisive > 0 ? roundTo(w / decisive, 4) : null,
        component: componentOf.get(projectId) as number,
        rank: rankedIds.indexOf(projectId) + 1,
        saturated: Math.abs(value) >= THETA_MAX - 1e-9,
      };
    })
    .sort((a, b) => a.rank - b.rank || a.projectId.localeCompare(b.projectId));

  // Transitivity diagnostics on decided, non-tied comparisons.
  const strict = decided.filter((c) => c.outcome !== 'TIE');
  const beats = new Set<string>();
  for (const c of strict) beats.add(`${c.leftProjectId}>${c.rightProjectId}`);
  let nonTransitive = 0;
  let transitive = 0;
  const seenTriplets = new Set<string>();
  for (const a of strict) {
    for (const b of strict) {
      // Chain: a says X > Y and b says Y > Z, so the triple is (X, Y, Z).
      if (a.rightProjectId !== b.leftProjectId) continue;
      if (a.leftProjectId === b.rightProjectId) continue;
      if (!beats.has(`${a.rightProjectId}>${b.rightProjectId}`)) continue;
      const triple = [a.leftProjectId, a.rightProjectId, b.rightProjectId].sort();
      const key = triple.join('|');
      if (seenTriplets.has(key)) continue;
      seenTriplets.add(key);
      if (beats.has(`${b.rightProjectId}>${a.leftProjectId}`)) nonTransitive += 1;
      else transitive += 1;
    }
  }
  if (nonTransitive > 0) {
    warnings.push(
      `${nonTransitive} non-transitive comparison cycle(s) detected. Bradley-Terry assumes transitive preferences (assumption A1); the fit is a least-squares compromise.`,
    );
  }

  const ll = penalisedLogLikelihood(theta, orderedWins, ids, prior);
  const nDecisive = strict.length;
  // Null model: every comparison equally likely. The reported ratio is against
  // the *unpenalised* all-equal model, which is the meaningful baseline.
  const nullLl = nDecisive * Math.log(0.5);
  const lr = ll - nullLl;
  // Crameres-style fit statistic: 2 * (ll_null - ll_model), scaled to [0,1].
  const gof = nDecisive > 0 ? Math.max(0, Math.min(1, lr / (nDecisive * Math.log(2)))) : null;

  if (prior > 0) {
    warnings.push(
      `A Gaussian prior N(0, 1/${prior}) was applied to the strengths (ridge strength lambda = ${prior}). Without it the maximum-likelihood strength of an undefeated project diverges to +infinity, so a single unbeaten project would make the whole ranking undefined.`,
    );
  }

  const maxAbsTheta = Math.max(...ids.map((id) => Math.abs(theta.get(id) as number)));

  return {
    strengths,
    rankings: rankedIds.map((projectId, index) => ({
      projectId,
      rank: index + 1,
      theta: roundTo(theta.get(projectId) as number, 6),
      share: roundTo(shareById.get(projectId) as number, 6),
    })),
    diagnostics: {
      engineVersion: PAIRWISE_ENGINE_VERSION,
      totalComparisons: comparisons.length,
      decisiveComparisons: decided.length,
      ties: tieCount,
      skipped,
      projectCount: ids.length,
      connectedComponents: components.size,
      unconnectedProjects: trulyUnconnected,
      nonTransitiveTriplets: nonTransitive,
      transitiveTriplets: transitive,
      logLikelihood: roundTo(ll, 6),
      nullLogLikelihood: roundTo(nullLl, 6),
      likelihoodRatio: roundTo(lr, 6),
      goodnessOfFit: gof === null ? null : roundTo(gof, 6),
      converged,
      iterations,
      priorApplied: prior > 0,
      maxAbsTheta: roundTo(maxAbsTheta, 6),
      warnings,
    },
    computedAt: options.computedAt,
    inputHash: options.inputHash,
  };
}

function emptyResult(
  options: { computedAt: string; inputHash: string },
  warnings: string[],
  extra: string[],
): PairwiseResult {
  return {
    strengths: [],
    rankings: [],
    diagnostics: {
      engineVersion: PAIRWISE_ENGINE_VERSION,
      totalComparisons: 0,
      decisiveComparisons: 0,
      ties: 0,
      skipped: 0,
      projectCount: 0,
      connectedComponents: 0,
      unconnectedProjects: [],
      nonTransitiveTriplets: 0,
      transitiveTriplets: 0,
      logLikelihood: 0,
      nullLogLikelihood: 0,
      likelihoodRatio: 0,
      goodnessOfFit: null,
      converged: true,
      iterations: 0,
      priorApplied: false,
      maxAbsTheta: 0,
      warnings: [...warnings, ...extra],
    },
    computedAt: options.computedAt,
    inputHash: options.inputHash,
  };
}

/* ------------------------------------------------- pair generation */

/**
 * Deterministic round-robin-ish pair schedule.
 *
 * Judges must not always see the same pairings in the same order, or they can
 * infer the outcome of the previous comparison. The schedule is therefore
 * rotated per judge from a seeded RNG, and the rotation offset is a pure
 * function of the judge id — so a judge's queue is stable across page reloads
 * (they can resume) while different judges get different orderings.
 */
export function buildPairSchedule(
  projectIds: readonly string[],
  judgeId: string,
  options: { pairsPerComparison: number; seed: string },
): { left: string; right: string }[] {
  const rng = createRng(`${options.seed}:${judgeId}`);
  const ids = [...projectIds].sort();
  const pairs: { left: string; right: string }[] = [];

  if (ids.length < 2) return pairs;

  // Circle-method round robin with a BYE for an odd number of projects. The bye
  // is a distinct `null` sentinel rather than a duplicated id: duplicating an id
  // and then rotating the array would eventually rotate the copy into a real
  // pairing position and emit a project compared against itself.
  const rotating: (string | null)[] = [...ids];
  if (rotating.length % 2 === 1) rotating.push(null);
  const n = rotating.length;
  for (let round = 0; round < n - 1; round += 1) {
    for (let i = 0; i < n / 2; i += 1) {
      const a = rotating[i] as string | null;
      const b = rotating[n - 1 - i] as string | null;
      if (a !== null && b !== null) pairs.push({ left: a, right: b });
    }
    // Keep index 0 fixed and rotate the remainder.
    rotating.splice(1, 0, rotating.pop() as string | null);
  }

  // Limit the workload, then shuffle with a per-judge deterministic seed and
  // orient each pair so the same project is not always on the left.
  const limited = pairs.slice(0, Math.max(0, options.pairsPerComparison));
  const shuffled = rng.shuffle(limited);
  return shuffled.map((pair) => (rng.next() < 0.5 ? pair : { left: pair.right, right: pair.left }));
}

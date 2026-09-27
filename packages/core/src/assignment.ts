/**
 * Judge assignment engine (spec §18).
 *
 * Assignment is the step most likely to be quietly fudged in a hackathon
 * judging tool, so it is treated here as a first-class, previewable, versioned
 * computation:
 *
 *   1. Eligibility filtering   — who may judge what (state, conflicts, capacity)
 *   2. Strategy                — random | balanced | conflict_aware | workload_aware | panel_diversity
 *   3. Preview                 — a full dry run the organizer must confirm
 *   4. Version                 — committed assignments are versioned and auditable
 *
 * Every strategy is deterministic given (event, judges, projects, conflicts,
 * seed). The only randomness is the explicitly seeded `RANDOM` strategy, whose
 * seed is stored with the run so the same event can be regenerated identically.
 *
 * Conflict handling:
 *  - HARD conflicts are never assigned, under any strategy, and there is no
 *    override flag that changes that inside this module. An organizer override
 *    is a separate, explicitly audited action in the service layer, precisely
 *    so that "the engine assigned a conflicted judge" can never be true.
 *  - SOFT conflicts are avoided by the conflict-aware and workload-aware
 *    strategies and are permitted by `random`/`balanced` (which are documented
 *    as naive baselines). The preview reports how many soft conflicts were
 *    accepted so the choice is never invisible.
 */

import { createRng } from './random.ts';
import { roundTo, stableMean } from './statistics.ts';
import type { ConflictSeverity } from './types.ts';

export const ASSIGNMENT_ENGINE_VERSION = '1.0.0';

export type AssignmentStrategy =
  | 'RANDOM'
  | 'BALANCED'
  | 'CONFLICT_AWARE'
  | 'WORKLOAD_AWARE'
  | 'PANEL_DIVERSITY';

export const ASSIGNMENT_STRATEGIES: readonly AssignmentStrategy[] = [
  'RANDOM',
  'BALANCED',
  'CONFLICT_AWARE',
  'WORKLOAD_AWARE',
  'PANEL_DIVERSITY',
];

/**
 * Cost function used by the greedy optimising strategies. Lower is better.
 * The weights encode our priorities explicitly and are documented in
 * JUDGING.md so an organizer can reason about the trade-off.
 */
export const COST_WEIGHTS = {
  /** Additional review assigned to a judge. */
  load: 1,
  /** Review beyond the mean load. */
  overload: 6,
  /** Project whose coverage is still below the target. */
  underCoverage: 24,
  /** Judge who has already reviewed this project. */
  duplicate: 1000,
  /** Hard conflict: forbidden entirely (not merely expensive). */
  hardConflict: Number.POSITIVE_INFINITY,
  /** Accepted soft conflict. */
  softConflict: 40,
  /** Panel diversity: judge already co-assigned with these peers on this project. */
  peerOverlap: 3,
  /** Judge judged this project's team/organization elsewhere. */
  relatedAssignment: 12,
} as const;

export type JudgeCandidate = {
  judgeId: string;
  displayName: string;
  state: 'INVITED' | 'ACCEPTED' | 'ACTIVE' | 'COMPLETED';
  /** Total reviews the judge is willing to take. */
  capacity: number;
  /** Reviews already committed in earlier assignment versions. */
  existingLoad: number;
  expertise: string[];
  /** Excluded because the judge is not in a state that permits judging. */
  excluded: boolean;
  exclusionReason: string | null;
};

export type ProjectCandidate = {
  projectId: string;
  trackId: string | null;
  teamId: string | null;
  organization: string | null;
  /** Judges already assigned to this project in earlier versions. */
  existingJudges: string[];
  /** Judges who declared a conflict, keyed by severity. */
  hardConflicts: string[];
  softConflicts: string[];
  /** Judges with prior exposure to this project (calibration, past event). */
  relatedJudges: string[];
  /**
   * TOTAL number of distinct reviewers this project should end up with,
   * counting reviewers already committed in earlier assignment versions.
   */
  reviewsNeeded: number;
};

export type ConflictDeclaration = {
  judgeId: string;
  projectId: string | null;
  kind: string;
  severity: ConflictSeverity;
  subjectId: string | null;
  note: string;
};

export type AssignmentRequest = {
  eventId: string;
  strategy: AssignmentStrategy;
  judges: JudgeCandidate[];
  projects: ProjectCandidate[];
  conflicts: ConflictDeclaration[];
  /** Reviews each project should end up with, including existing assignments. */
  reviewsPerProject: number;
  /** Seed for the RANDOM strategy; stored with the run for reproducibility. */
  seed: string;
  /** Existing co-assignment map used by PANEL_DIVERSITY: project -> judge ids. */
  existingPanels?: Record<string, string[]>;
  /** Tracks that limit which judges may review which projects. */
  trackJudgeRestrictions?: Record<string, string[]>;
};

export type AssignmentPair = {
  judgeId: string;
  projectId: string;
  /** True when a SOFT conflict was accepted for this pair. */
  softConflict: boolean;
  /** Why the engine chose this pair, for the preview UI. */
  reason: string;
};

export type AssignmentPreview = {
  engineVersion: string;
  strategy: AssignmentStrategy;
  seed: string;
  reviewsPerProject: number;
  pairs: AssignmentPair[];
  /** Projects that could not reach the target coverage. */
  unassignedProjects: { projectId: string; assigned: number; needed: number; reason: string }[];
  /** Judges that were not given any additional work. */
  idleJudges: { judgeId: string; load: number; capacity: number; reason: string }[];
  judgeLoad: {
    judgeId: string;
    displayName: string;
    existing: number;
    assigned: number;
    total: number;
    capacity: number;
    utilisation: number;
  }[];
  projectCoverage: { projectId: string; assigned: number; needed: number; coverage: number }[];
  /** Judges excluded from the pool, with the reason. */
  excludedJudges: { judgeId: string; displayName: string; reason: string }[];
  /** Soft conflicts that were accepted, so the organizer can see the cost. */
  acceptedSoftConflicts: { judgeId: string; projectId: string; kind: string }[];
  /** Hard conflicts that were honoured. */
  enforcedHardConflicts: { judgeId: string; projectId: string; kind: string }[];
  summary: {
    totalPairs: number;
    projectsFullyCovered: number;
    projectsPartiallyCovered: number;
    projectsUncovered: number;
    judgesUsed: number;
    loadSpread: { min: number; max: number; mean: number; standardDeviation: number };
    coverageRatio: number;
    warnings: string[];
  };
  computedAt: string;
};

/** Expand conflict declarations into per-project judge sets. */
function indexConflicts(
  conflicts: readonly ConflictDeclaration[],
  projects: readonly ProjectCandidate[],
): { hard: Map<string, Set<string>>; soft: Map<string, Set<string>>; detail: Map<string, { kind: string; severity: ConflictSeverity }> } {
  const hard = new Map<string, Set<string>>();
  const soft = new Map<string, Set<string>>();
  const detail = new Map<string, { kind: string; severity: ConflictSeverity }>();

  const projectById = new Map(projects.map((p) => [p.projectId, p]));
  const teamToProjects = new Map<string, string[]>();
  const participantToProjects = new Map<string, string[]>();
  for (const project of projects) {
    if (project.teamId) teamToProjects.set(project.teamId, [...(teamToProjects.get(project.teamId) ?? []), project.projectId]);
    for (const judge of [...project.hardConflicts, ...project.softConflicts]) {
      participantToProjects.set(judge, [...(participantToProjects.get(judge) ?? []), project.projectId]);
    }
  }

  const add = (projectId: string, judgeId: string, kind: string, severity: ConflictSeverity) => {
    const key = `${judgeId}::${projectId}`;
    detail.set(key, { kind, severity });
    const target = severity === 'HARD' ? hard : soft;
    const set = target.get(projectId) ?? new Set<string>();
    set.add(judgeId);
    target.set(projectId, set);
  };

  for (const conflict of conflicts) {
    if (conflict.projectId) {
      if (!projectById.has(conflict.projectId)) continue;
      add(conflict.projectId, conflict.judgeId, conflict.kind, conflict.severity);
      continue;
    }
    if (conflict.kind === 'TEAM' && conflict.subjectId) {
      for (const projectId of teamToProjects.get(conflict.subjectId) ?? []) {
        add(projectId, conflict.judgeId, 'TEAM', conflict.severity);
      }
      continue;
    }
    if (conflict.kind === 'PARTICIPANT' && conflict.subjectId) {
      for (const projectId of participantToProjects.get(conflict.subjectId) ?? []) {
        add(projectId, conflict.judgeId, 'PARTICIPANT', conflict.severity);
      }
      continue;
    }
    if (conflict.kind === 'ORGANIZATION' && conflict.subjectId) {
      for (const project of projects) {
        if (project.organization === conflict.subjectId) {
          add(project.projectId, conflict.judgeId, 'ORGANIZATION', conflict.severity);
        }
      }
    }
  }

  return { hard, soft, detail };
}

type Candidate = {
  judge: JudgeCandidate;
  load: number;
  peers: Set<string>;
  related: number;
};

export function generateAssignmentPreview(
  request: AssignmentRequest,
  computedAt: string,
): AssignmentPreview {
  const warnings: string[] = [];
  const { hard, detail } = indexConflicts(request.conflicts, request.projects);

  const eligible = request.judges.filter((j) => !j.excluded && j.state !== 'INVITED' && j.state !== 'COMPLETED');
  const excludedJudges = request.judges
    .filter((j) => j.excluded || j.state === 'INVITED' || j.state === 'COMPLETED')
    .map((j) => ({
      judgeId: j.judgeId,
      displayName: j.displayName,
      reason: j.exclusionReason ?? (j.state === 'INVITED' ? 'Invitation not yet accepted' : `Judge state is ${j.state}`),
    }));

  if (eligible.length === 0) {
    warnings.push('No eligible judges: every judge is either unconfirmed or at capacity. Assignment is empty.');
  }

  const totalCapacity = eligible.reduce((acc, j) => acc + Math.max(0, j.capacity - j.existingLoad), 0);
  const totalNeeded = request.projects.reduce((acc, p) => acc + Math.max(0, p.reviewsNeeded), 0);
  if (totalCapacity < totalNeeded) {
    warnings.push(
      `Insufficient judging capacity: ${totalNeeded} review(s) requested but only ${totalCapacity} available across ${eligible.length} eligible judge(s).`,
    );
  }

  const candidates = new Map<string, Candidate>(
    eligible.map((j) => [
      j.judgeId,
      { judge: j, load: j.existingLoad, peers: new Set<string>(), related: 0 },
    ]),
  );

  // Seed the running state with pre-existing assignments so incremental
  // re-assignment behaves the same as a from-scratch run.
  const assignedJudgesByProject = new Map<string, Set<string>>(
    request.projects.map((p) => [p.projectId, new Set(p.existingJudges)]),
  );
  const pairKeys = new Set<string>();
  for (const project of request.projects) {
    for (const judgeId of project.existingJudges) pairKeys.add(`${judgeId}::${project.projectId}`);
  }
  for (const project of request.projects) {
    for (const judgeId of project.existingJudges) {
      const candidate = candidates.get(judgeId);
      if (candidate) {
        for (const peer of project.existingJudges) if (peer !== judgeId) candidate.peers.add(peer);
      }
    }
  }

  const rng = createRng(`${request.seed}:${request.strategy}`);
  const pairs: AssignmentPair[] = [];
  const acceptedSoft: { judgeId: string; projectId: string; kind: string }[] = [];
  const enforcedHard: { judgeId: string; projectId: string; kind: string }[] = [];

  const projectById = new Map(request.projects.map((p) => [p.projectId, p]));
  const isForbidden = (judgeId: string, projectId: string): boolean => (hard.get(projectId)?.has(judgeId) ?? false);

  const trackAllowed = (judgeId: string, project: ProjectCandidate): boolean => {
    if (!project.trackId) return true;
    const restricted = request.trackJudgeRestrictions?.[project.trackId];
    if (!restricted) return true;
    return restricted.includes(judgeId);
  };

  const currentCoverage = (projectId: string): number => assignedJudgesByProject.get(projectId)?.size ?? 0;

  const buildPool = (project: ProjectCandidate): Candidate[] => {
    const pool: Candidate[] = [];
    for (const candidate of candidates.values()) {
      if (candidate.load >= candidate.judge.capacity) continue;
      if (isForbidden(candidate.judge.judgeId, project.projectId)) continue;
      if (!trackAllowed(candidate.judge.judgeId, project)) continue;
      if ((assignedJudgesByProject.get(project.projectId)?.has(candidate.judge.judgeId) ?? false)) continue;
      pool.push(candidate);
    }
    return pool;
  };

  const costOf = (candidate: Candidate, project: ProjectCandidate, strategy: AssignmentStrategy): number => {
    const judgeId = candidate.judge.judgeId;
    const hardForbidden = isForbidden(judgeId, project.projectId);
    if (hardForbidden) return COST_WEIGHTS.hardConflict;
    if (pairKeys.has(`${judgeId}::${project.projectId}`)) return COST_WEIGHTS.duplicate;

    const coverage = currentCoverage(project.projectId);
    const target = project.reviewsNeeded;
    const underCoverage = coverage < target ? target - coverage : 0;

    const overload = Math.max(0, candidate.load + 1 - target * (request.reviewsPerProject / Math.max(1, eligible.length)));
    let cost = candidate.load * COST_WEIGHTS.load + overload * COST_WEIGHTS.overload + underCoverage * COST_WEIGHTS.underCoverage;

    if (strategy === 'PANEL_DIVERSITY') {
      // Penalise re-creating a judge pairing that has already served a project.
      let repeats = 0;
      for (const peer of assignedJudgesByProject.get(project.projectId) ?? []) {
        repeats += pairHistory.get(pairKey(judgeId, peer)) ?? 0;
      }
      cost += repeats * COST_WEIGHTS.peerOverlap;
    }
    if (project.relatedJudges.includes(judgeId)) cost += COST_WEIGHTS.relatedAssignment;
    if (project.softConflicts.includes(judgeId)) cost += COST_WEIGHTS.softConflict;

    // Naive baselines deliberately ignore conflicts and balance to make the
    // difference between strategies visible in the preview.
    if (strategy === 'RANDOM') return rng.next() * 1e-6;
    if (strategy === 'BALANCED') return candidate.load * COST_WEIGHTS.load;
    return cost;
  };

  /**
   * How many times each unordered judge pair has been co-assigned so far.
   *
   * Panel diversity needs to penalise *repeating a panel*, not merely reusing a
   * judge. Counting "how many peers has this judge ever had" saturates: after
   * two rounds every judge has exactly one peer and the signal disappears, so
   * the engine happily hands the third project the same {j1,j2} panel as the
   * first. Counting the specific pair keeps discriminating.
   */
  const pairHistory = new Map<string, number>();
  const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const assign = (candidate: Candidate, project: ProjectCandidate, reason: string, softConflict: boolean) => {
    const existing = assignedJudgesByProject.get(project.projectId) ?? new Set<string>();
    for (const peer of existing) {
      const key = pairKey(candidate.judge.judgeId, peer);
      pairHistory.set(key, (pairHistory.get(key) ?? 0) + 1);
      candidate.peers.add(peer);
      const otherCandidate = candidates.get(peer);
      if (otherCandidate) otherCandidate.peers.add(candidate.judge.judgeId);
    }
    candidate.load += 1;
    candidate.related += 1;
    existing.add(candidate.judge.judgeId);
    assignedJudgesByProject.set(project.projectId, existing);
    pairKeys.add(`${candidate.judge.judgeId}::${project.projectId}`);
    pairs.push({ judgeId: candidate.judge.judgeId, projectId: project.projectId, softConflict, reason });
  };

  // Greedy assignment: repeatedly take the globally cheapest feasible pair.
  // A full linear-programming or Hungarian solver would be overkill here and
  // would be *less* explainable to an organizer, which matters more.
  const queue = [...request.projects];
  if (request.strategy === 'RANDOM') queue.sort(() => rng.next() - 0.5);

  let guard = 0;
  const maxIterations = Math.max(64, totalNeeded * 8 + request.projects.length * 8);
  let progressed = true;
  while (progressed && guard < maxIterations) {
    progressed = false;
    guard += 1;
    for (const project of queue) {
      while (currentCoverage(project.projectId) < project.reviewsNeeded) {
        const pool = buildPool(project);
        if (pool.length === 0) break;
        let best: Candidate | null = null;
        let bestCost = Number.POSITIVE_INFINITY;
        for (const candidate of pool) {
          const cost = costOf(candidate, project, request.strategy);
          if (cost < bestCost - 1e-12) {
            bestCost = cost;
            best = candidate;
          }
        }
        if (best === null || !Number.isFinite(bestCost)) break;
        const softConflict = project.softConflicts.includes(best.judge.judgeId);
        if (softConflict) {
          const info = detail.get(`${best.judge.judgeId}::${project.projectId}`);
          acceptedSoft.push({ judgeId: best.judge.judgeId, projectId: project.projectId, kind: info?.kind ?? 'SOFT' });
        }
        assign(best, project, describeChoice(request.strategy, best, project), softConflict);
        progressed = true;
      }
    }
  }

  // Report the hard conflicts that were honoured.
  for (const [projectId, judgeIds] of hard) {
    for (const judgeId of judgeIds) {
      if (projectById.has(projectId) && candidates.has(judgeId)) {
        const info = detail.get(`${judgeId}::${projectId}`);
        enforcedHard.push({ judgeId, projectId, kind: info?.kind ?? 'HARD' });
      }
    }
  }

  const judgeLoad = eligible
    .map((j) => {
      const candidate = candidates.get(j.judgeId)!;
      return {
        judgeId: j.judgeId,
        displayName: j.displayName,
        existing: j.existingLoad,
        assigned: candidate.load - j.existingLoad,
        total: candidate.load,
        capacity: j.capacity,
        utilisation: roundTo(j.capacity === 0 ? 0 : candidate.load / j.capacity, 4),
      };
    })
    .sort((a, b) => b.total - a.total || a.judgeId.localeCompare(b.judgeId));

  const projectCoverage = request.projects
    .map((p) => {
      const assigned = currentCoverage(p.projectId);
      return {
        projectId: p.projectId,
        assigned,
        needed: p.reviewsNeeded,
        coverage: p.reviewsNeeded === 0 ? 1 : roundTo(Math.min(1, assigned / p.reviewsNeeded), 4),
      };
    })
    .sort((a, b) => a.coverage - b.coverage || a.projectId.localeCompare(b.projectId));

  const unassignedProjects = projectCoverage
    .filter((p) => p.assigned < p.needed)
    .map((p) => {
      const hardCount = hard.get(p.projectId)?.size ?? 0;
      return {
        projectId: p.projectId,
        assigned: p.assigned,
        needed: p.needed,
        reason:
          hardCount > 0
            ? `${hardCount} judge(s) excluded by a hard conflict, leaving too few eligible reviewers`
            : 'insufficient judge capacity or every eligible judge already reviews this project',
      };
    });

  const idleJudges = judgeLoad
    .filter((j) => j.assigned === 0 && j.existing === 0)
    .map((j) => ({
      judgeId: j.judgeId,
      load: j.total,
      capacity: j.capacity,
      reason:
        j.capacity === 0
          ? 'judge has zero capacity configured'
          : request.judges.find((x) => x.judgeId === j.judgeId)?.exclusionReason ?? 'no eligible project remained for this judge',
    }));

  const loads = judgeLoad.map((j) => j.total);
  const loadSpread = {
    min: loads.length ? Math.min(...loads) : 0,
    max: loads.length ? Math.max(...loads) : 0,
    mean: roundTo(stableMean(loads) ?? 0, 4),
    standardDeviation: roundTo(standardDeviation(loads), 4),
  };

  const fullyCovered = projectCoverage.filter((p) => p.coverage >= 1).length;
  const partial = projectCoverage.filter((p) => p.coverage > 0 && p.coverage < 1).length;
  const uncovered = projectCoverage.filter((p) => p.coverage <= 0).length;
  const coverageRatio =
    projectCoverage.length === 0
      ? 1
      : roundTo(projectCoverage.reduce((acc, p) => acc + p.coverage, 0) / projectCoverage.length, 4);

  if (loadSpread.max - loadSpread.min > Math.max(2, request.reviewsPerProject)) {
    warnings.push(
      `Judge workload is uneven (min ${loadSpread.min}, max ${loadSpread.max}). Consider WORKLOAD_AWARE or PANEL_DIVERSITY.`,
    );
  }
  if (acceptedSoft.length > 0) {
    warnings.push(
      `${acceptedSoft.length} soft conflict(s) were accepted because the strategy is a naive baseline or no alternative judge was available.`,
    );
  }
  if (uncovered > 0) {
    warnings.push(`${uncovered} project(s) received no reviewer at all and cannot be judged.`);
  }

  return {
    engineVersion: ASSIGNMENT_ENGINE_VERSION,
    strategy: request.strategy,
    seed: request.seed,
    reviewsPerProject: request.reviewsPerProject,
    pairs,
    unassignedProjects,
    idleJudges,
    judgeLoad,
    projectCoverage,
    excludedJudges,
    acceptedSoftConflicts: acceptedSoft,
    enforcedHardConflicts: enforcedHard,
    summary: {
      totalPairs: pairs.length,
      projectsFullyCovered: fullyCovered,
      projectsPartiallyCovered: partial,
      projectsUncovered: uncovered,
      judgesUsed: judgeLoad.filter((j) => j.assigned > 0).length,
      loadSpread,
      coverageRatio,
      warnings,
    },
    computedAt,
  };
}

function describeChoice(
  strategy: AssignmentStrategy,
  candidate: Candidate,
  project: ProjectCandidate,
): string {
  // `candidate.load` has NOT yet been incremented: this function is evaluated
  // as an argument to `assign`, before the mutation happens.
  const load = candidate.load;
  const coverage = project.reviewsNeeded;
  switch (strategy) {
    case 'RANDOM':
      return 'random baseline assignment from a seeded generator';
    case 'BALANCED':
      return `lowest current load (${load} review${load === 1 ? '' : 's'} before this one)`;
    case 'CONFLICT_AWARE':
      return project.softConflicts.includes(candidate.judge.judgeId)
        ? 'least-bad option; the remaining candidates carried soft conflicts'
        : 'conflict-free judge, chosen by lowest load';
    case 'WORKLOAD_AWARE':
      return `minimises total cost: load ${load}/${candidate.judge.capacity}, project still needs ${Math.max(0, coverage - candidate.related)} more review(s)`;
    case 'PANEL_DIVERSITY':
      return `lowest load (${load}) with the fewest already-repeated pairings (${candidate.peers.size} prior co-assignment(s))`;
    default:
      return 'assigned';
  }
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = stableMean(values)!;
  const acc = values.reduce((a, v) => a + (v - m) * (v - m), 0);
  return Math.sqrt(acc / values.length);
}

/**
 * Judge diagnostics and anomaly detection (spec §25, §26).
 *
 * DESIGN COMMITMENT: everything in this module is a *review signal*, never a
 * verdict. A flag means "a human organizer should look at this". It never
 * means "this judge cheated". The platform refuses to encode guilt, because a
 * scoring platform that accuses judges automatically is a scoring platform
 * nobody will trust with a real event.
 *
 * Each signal therefore carries:
 *   - the statistic that triggered it (so it can be checked by hand)
 *   - a human-readable explanation
 *   - a severity that reflects *how anomalous*, not *how guilty*
 *   - the sample size, because almost every signal here is meaningless at n=2
 *
 * Thresholds are exported constants, documented in JUDGING.md, and reported in
 * the diagnostics payload so a result is always interpretable after the fact.
 */

import { coefficientOfVariation, median, robustOutlierRate, robustSigma, roundTo, stableMean, stddev, toPercent } from './statistics.ts';
import type { AnomalySeverity, AnomalyType } from './types.ts';

export const DIAGNOSTICS_ENGINE_VERSION = '1.0.0';

/* ------------------------------------------------------------- thresholds */

export const THRESHOLDS = {
  /** Coefficient of variation above which a judge's spread is flagged HIGH_VARIANCE. */
  highJudgeVarianceCv: 0.45,
  /** CV below which a judge is flagged LOW_VARIANCE (suspiciously consistent). */
  lowJudgeVarianceCv: 0.04,
  /** |z| of a judge's mean deviation from the panel mean, per project. */
  panelDeviationZ: 2.0,
  /** Minimum number of reviews before judge-level signals are emitted at all. */
  minimumSampleForJudgeSignals: 3,
  /** Judging completion fraction below which a judge is INCOMPLETE. */
  incompleteCompletionRate: 0.999,
  /** Identical-score run length that triggers IDENTICAL_SCORING. */
  identicalScoringRun: 4,
  /** Standard deviations from the panel that count as an extreme project score. */
  extremeProjectZ: 2.5,
  /** Votes per hour per account above which velocity is flagged. */
  votingVelocityPerHour: 30,
  /** Share of an event's votes coming from one account above which it is flagged. */
  votingConcentrationShare: 0.25,
  /** Minimum vote volume before concentration is meaningful. */
  votingConcentrationMinVotes: 40,
} as const;

/* -------------------------------------------------------------- signals */

export type DiagnosticSignal = {
  type: AnomalyType;
  severity: AnomalySeverity;
  /** Subject of the signal: a judge id, project id, or user id. */
  subjectId: string;
  subjectKind: 'JUDGE' | 'PROJECT' | 'ACCOUNT' | 'EVENT';
  /** The measured statistic, so the signal can be verified by hand. */
  metric: number | null;
  /** Threshold the metric was compared against. */
  threshold: number | null;
  sampleSize: number;
  evidence: string;
  /** What the organizer can do about it. */
  recommendedAction: string;
};

export type JudgeDiagnostic = {
  judgeId: string;
  sampleSize: number;
  mean: number | null;
  median: number | null;
  stddev: number | null;
  min: number | null;
  max: number | null;
  range: number | null;
  coefficientOfVariation: number | null;
  /** Distance of this judge's mean from the panel mean, in panel sigmas. */
  panelDeviationZ: number | null;
  /** Mean absolute deviation from the panel mean for this judge's reviews. */
  panelMeanAbsoluteDeviation: number | null;
  assigned: number;
  completed: number;
  completionRate: number | null;
  draftReviews: number;
  /** Distinct scores used; a very low ratio suggests patterned scoring. */
  distinctScoreRatio: number | null;
  signals: DiagnosticSignal[];
};

export type ProjectDiagnostic = {
  projectId: string;
  assignedJudges: number;
  submittedReviews: number;
  coverage: number | null;
  mean: number | null;
  median: number | null;
  stddev: number | null;
  range: number | null;
  /** How far this project's mean sits from the field, in field sigmas. */
  fieldDeviationZ: number | null;
  /** Per-judge disagreement on this project specifically. */
  judgeDisagreement: number | null;
  criterionSpread: { key: string; stddev: number | null; range: number | null }[];
  signals: DiagnosticSignal[];
};

export type VotingDiagnostics = {
  totalVotes: number;
  distinctVoters: number;
  votesPerVoter: number | null;
  velocityPerHour: number | null;
  topAccountShare: number | null;
  topAccounts: { userId: string; votes: number; share: number }[];
  signals: DiagnosticSignal[];
};

export type EventDiagnostics = {
  engineVersion: string;
  eventId: string;
  rubricVersionId: string;
  assignmentVersion: number;
  computedAt: string;
  panel: {
    judgeCount: number;
    reviewCount: number;
    mean: number | null;
    median: number | null;
    stddev: number | null;
  };
  judges: JudgeDiagnostic[];
  projects: ProjectDiagnostic[];
  voting: VotingDiagnostics | null;
  signals: DiagnosticSignal[];
  thresholds: typeof THRESHOLDS;
};

export type ReviewRecord = {
  judgeId: string;
  projectId: string;
  /** Weighted 0..100 review score. */
  score: number;
  submittedAt: string;
  state: 'DRAFT' | 'SUBMITTED' | 'LOCKED';
  /** Optional per-criterion 0..100 contributions. */
  criteria?: { key: string; points: number }[];
};

function severityForRatio(ratio: number): AnomalySeverity {
  if (ratio >= 2) return 'HIGH';
  if (ratio >= 1.4) return 'MEDIUM';
  return 'LOW';
}

/* -------------------------------------------------------- judge signals */

export function diagnoseJudge(
  judgeId: string,
  reviews: readonly ReviewRecord[],
  panelMean: number | null,
  panelStddev: number | null,
  assigned: number,
  submitted: readonly string[],
): JudgeDiagnostic {
  const decided = reviews.filter((r) => r.state !== 'DRAFT');
  const scores = decided.map((r) => r.score).filter((n) => Number.isFinite(n));
  const m = stableMean(scores);
  const sd = stddev(scores);
  const cv = coefficientOfVariation(scores);
  const lo = scores.length ? Math.min(...scores) : null;
  const hi = scores.length ? Math.max(...scores) : null;
  const range = lo !== null && hi !== null ? roundTo(hi - lo, 4) : null;

  const deviation = m !== null && panelMean !== null ? m - panelMean : null;
  const panelDeviationZ = deviation !== null && panelStddev !== null && panelStddev > 0 ? roundTo(deviation / panelStddev, 4) : null;

  const panelDeviations = decided
    .map((r) => (panelMean === null ? null : r.score - panelMean))
    .filter((d): d is number => d !== null);
  const panelMeanAbsoluteDeviation = panelDeviations.length
    ? roundTo(panelDeviations.reduce((a, b) => a + Math.abs(b), 0) / panelDeviations.length, 4)
    : null;

  const distinct = new Set(scores).size;
  const distinctScoreRatio = scores.length ? roundTo(distinct / scores.length, 4) : null;
  const completionRate = assigned === 0 ? null : roundTo(submitted.length / assigned, 4);

  const signals: DiagnosticSignal[] = [];

  if (scores.length >= THRESHOLDS.minimumSampleForJudgeSignals && cv !== null) {
    if (cv > THRESHOLDS.highJudgeVarianceCv) {
      signals.push({
        type: 'HIGH_VARIANCE',
        severity: severityForRatio(cv / THRESHOLDS.highJudgeVarianceCv),
        subjectId: judgeId,
        subjectKind: 'JUDGE',
        metric: roundTo(cv, 4),
        threshold: THRESHOLDS.highJudgeVarianceCv,
        sampleSize: scores.length,
        evidence: `This judge's scores span ${range} points (CV ${toPercent(cv)}%), well above the ${toPercent(THRESHOLDS.highJudgeVarianceCv)}% guideline.`,
        recommendedAction: 'Compare this judge\'s reviews against another judge on the same projects; wide spread is sometimes a specialist viewpoint rather than an error.',
      });
    } else if (cv < THRESHOLDS.lowJudgeVarianceCv && scores.length >= THRESHOLDS.minimumSampleForJudgeSignals + 2) {
      signals.push({
        type: 'LOW_VARIANCE',
        severity: 'MEDIUM',
        subjectId: judgeId,
        subjectKind: 'JUDGE',
        metric: roundTo(cv, 4),
        threshold: THRESHOLDS.lowJudgeVarianceCv,
        sampleSize: scores.length,
        evidence: `All ${scores.length} submitted reviews fall within a ${range}-point band (CV ${toPercent(cv)}%). Genuine critical judgement rarely compresses this far.`,
        recommendedAction: 'Check whether the judge is anchoring on a single criterion, or transcribing from a previous review. Normalization exists precisely because of judges like this.',
      });
    }
  }

  if (panelDeviationZ !== null && Math.abs(panelDeviationZ) >= THRESHOLDS.panelDeviationZ) {
    signals.push({
      type: 'PANEL_DEVIATION',
      severity: Math.abs(panelDeviationZ) >= THRESHOLDS.panelDeviationZ * 1.75 ? 'HIGH' : 'MEDIUM',
      subjectId: judgeId,
      subjectKind: 'JUDGE',
      metric: panelDeviationZ,
      threshold: THRESHOLDS.panelDeviationZ,
      sampleSize: scores.length,
      evidence: `This judge averages ${toPercent(panelDeviationZ)}% of a panel standard deviation ${panelDeviationZ > 0 ? 'above' : 'below'} the panel mean.`,
      recommendedAction: 'This is a legitimate generosity or severity offset, which normalization corrects automatically. No action is required unless the projects affected are extreme.',
    });
  }

  if (assigned > 0 && completionRate !== null && completionRate < THRESHOLDS.incompleteCompletionRate) {
    signals.push({
      type: 'INCOMPLETE',
      severity: completionRate < 0.5 ? 'HIGH' : 'LOW',
      subjectId: judgeId,
      subjectKind: 'JUDGE',
      metric: completionRate,
      threshold: THRESHOLDS.incompleteCompletionRate,
      sampleSize: assigned,
      evidence: `${submitted.length} of ${assigned} assigned reviews submitted (${toPercent(completionRate)}%).`,
      recommendedAction: 'Projects with missing reviews rank with lower coverage. Either wait, reassign, or finalize under an audited override.',
    });
  }

  // Identical repeated scoring: a run of consecutive identical total scores.
  const ordered = [...decided].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
  let run = 1;
  let longestRun = decided.length > 0 ? 1 : 0;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.score === ordered[i - 1]!.score) run += 1;
    else run = 1;
    longestRun = Math.max(longestRun, run);
  }
  if (longestRun >= THRESHOLDS.identicalScoringRun) {
    signals.push({
      type: 'IDENTICAL_SCORING',
      severity: longestRun >= THRESHOLDS.identicalScoringRun * 2 ? 'HIGH' : 'MEDIUM',
      subjectId: judgeId,
      subjectKind: 'JUDGE',
      metric: longestRun,
      threshold: THRESHOLDS.identicalScoringRun,
      sampleSize: decided.length,
      evidence: `${longestRun} consecutive reviews received exactly the same total score.`,
      recommendedAction: 'Verify the judge is scoring each criterion rather than carrying a total forward. This is the most common accidental scoring fault.',
    });
  }

  return {
    judgeId,
    sampleSize: scores.length,
    mean: m === null ? null : roundTo(m, 4),
    median: roundToOrNull(median(scores)),
    stddev: sd === null ? null : roundTo(sd, 4),
    min: roundToOrNull(lo),
    max: roundToOrNull(hi),
    range,
    coefficientOfVariation: cv === null ? null : roundTo(cv, 4),
    panelDeviationZ,
    panelMeanAbsoluteDeviation,
    assigned,
    completed: submitted.length,
    completionRate,
    draftReviews: reviews.length - decided.length,
    distinctScoreRatio,
    signals,
  };
}

function roundToOrNull(value: number | null): number | null {
  return value === null ? null : roundTo(value, 4);
}

/* ------------------------------------------------------ project signals */

export function diagnoseProject(
  projectId: string,
  reviews: readonly ReviewRecord[],
  assignedJudges: number,
  fieldMean: number | null,
  fieldStddev: number | null,
  criteria: readonly string[],
  minimumJudges: number,
): ProjectDiagnostic {
  const decided = reviews.filter((r) => r.state !== 'DRAFT');
  const scores = decided.map((r) => r.score).filter(Number.isFinite);
  const m = stableMean(scores);
  const sd = stddev(scores);
  const lo = scores.length ? Math.min(...scores) : null;
  const hi = scores.length ? Math.max(...scores) : null;

  const signals: DiagnosticSignal[] = [];

  const coverage = assignedJudges === 0 ? null : roundTo(scores.length / assignedJudges, 4);
  if (assignedJudges > 0 && scores.length < minimumJudges) {
    signals.push({
      type: 'INCOMPLETE',
      severity: scores.length === 0 ? 'HIGH' : 'MEDIUM',
      subjectId: projectId,
      subjectKind: 'PROJECT',
      metric: scores.length,
      threshold: minimumJudges,
      sampleSize: assignedJudges,
      evidence: `Only ${scores.length} of ${assignedJudges} assigned reviews were submitted.`,
      recommendedAction: 'Reassign the outstanding reviews before finalizing, or accept the low-coverage warning explicitly.',
    });
  }

  const fieldDeviationZ = m !== null && fieldMean !== null && fieldStddev !== null && fieldStddev > 0 ? roundTo((m - fieldMean) / fieldStddev, 4) : null;
  if (fieldDeviationZ !== null && Math.abs(fieldDeviationZ) >= THRESHOLDS.extremeProjectZ) {
    signals.push({
      type: 'SCORE_MANIPULATION',
      severity: 'MEDIUM',
      subjectId: projectId,
      subjectKind: 'PROJECT',
      metric: fieldDeviationZ,
      threshold: THRESHOLDS.extremeProjectZ,
      sampleSize: scores.length,
      evidence: `This project's mean sits ${toPercent(fieldDeviationZ)}% of a field standard deviation ${fieldDeviationZ > 0 ? 'above' : 'below'} the field mean.`,
      recommendedAction: 'Outliers are normal in open hackathons. Inspect the individual reviews to confirm the panel agrees before acting.',
    });
  }

  if (sd !== null && sd / Math.max(1, fieldStddev ?? sd) > 2.5 && scores.length >= 3) {
    signals.push({
      type: 'HIGH_VARIANCE',
      severity: 'MEDIUM',
      subjectId: projectId,
      subjectKind: 'PROJECT',
      metric: roundTo(sd, 4),
      threshold: roundTo((fieldStddev ?? 0) * 2.5, 4),
      sampleSize: scores.length,
      evidence: `Judges disagree sharply on this project (spread ${roundTo(sd, 2)} points).`,
      recommendedAction: 'Read the per-criterion breakdown; a single contested criterion is often the cause and may be a rubric wording problem.',
    });
  }

  const outlierRate = robustOutlierRate(scores, 3);
  if (outlierRate !== null && outlierRate > 0 && scores.length >= 4) {
    signals.push({
      type: 'PANEL_DEVIATION',
      severity: 'LOW',
      subjectId: projectId,
      subjectKind: 'PROJECT',
      metric: roundTo(outlierRate, 4),
      threshold: 0,
      sampleSize: scores.length,
      evidence: `${toPercent(outlierRate)}% of reviews on this project are more than 3 robust sigmas from the median.`,
      recommendedAction: 'Consider excluding the outlier review only through a documented, audited correction — never silently.',
    });
  }

  const criterionSpread = criteria.map((key) => {
    const values = decided
      .flatMap((r) => r.criteria ?? [])
      .filter((c) => c.key === key)
      .map((c) => c.points)
      .filter(Number.isFinite);
    const valuesSd = stddev(values);
    const valuesLo = values.length ? Math.min(...values) : null;
    const valuesHi = values.length ? Math.max(...values) : null;
    return {
      key,
      stddev: valuesSd === null ? null : roundTo(valuesSd, 4),
      range: valuesLo !== null && valuesHi !== null ? roundTo(valuesHi - valuesLo, 4) : null,
    };
  });

  return {
    projectId,
    assignedJudges,
    submittedReviews: scores.length,
    coverage,
    mean: m === null ? null : roundTo(m, 4),
    median: roundToOrNull(median(scores)),
    stddev: sd === null ? null : roundTo(sd, 4),
    range: lo !== null && hi !== null ? roundTo(hi - lo, 4) : null,
    fieldDeviationZ,
    judgeDisagreement: sd === null ? null : roundTo(sd, 4),
    criterionSpread,
    signals,
  };
}

/* ------------------------------------------------------- voting signals */

export function diagnoseVoting(input: {
  eventId: string;
  votes: readonly { userId: string; createdAt: string }[];
  windowStart: string;
  windowEnd: string;
}): VotingDiagnostics {
  const signals: DiagnosticSignal[] = [];
  const total = input.votes.length;
  const byUser = new Map<string, number>();
  for (const vote of input.votes) byUser.set(vote.userId, (byUser.get(vote.userId) ?? 0) + 1);

  const accounts = [...byUser.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = accounts.slice(0, 10).map(([userId, votes]) => ({
    userId,
    votes,
    share: total === 0 ? 0 : roundTo(votes / total, 4),
  }));
  const topShare = top[0]?.share ?? null;

  const hours = Math.max(1e-9, (Date.parse(input.windowEnd) - Date.parse(input.windowStart)) / 3_600_000);
  const velocity = roundTo(total / hours, 4);

  if (velocity !== null && velocity > THRESHOLDS.votingVelocityPerHour) {
    signals.push({
      type: 'VOTING_VELOCITY',
      severity: velocity > THRESHOLDS.votingVelocityPerHour * 3 ? 'HIGH' : 'MEDIUM',
      subjectId: input.eventId,
      subjectKind: 'EVENT',
      metric: velocity,
      threshold: THRESHOLDS.votingVelocityPerHour,
      sampleSize: total,
      evidence: `${total} votes arrived over ${roundTo(hours, 2)}h (${velocity}/hour against a ${THRESHOLDS.votingVelocityPerHour}/hour guideline).`,
      recommendedAction: 'A launch spike is normal. Look for bursts outside peak hours before treating this as automation.',
    });
  }

  if (total >= THRESHOLDS.votingConcentrationMinVotes && topShare !== null && topShare > THRESHOLDS.votingConcentrationShare) {
    signals.push({
      type: 'VOTING_CONCENTRATION',
      severity: topShare > THRESHOLDS.votingConcentrationShare * 1.8 ? 'HIGH' : 'MEDIUM',
      subjectId: top[0]!.userId,
      subjectKind: 'ACCOUNT',
      metric: topShare,
      threshold: THRESHOLDS.votingConcentrationShare,
      sampleSize: total,
      evidence: `The most active account supplied ${toPercent(topShare)}% of all votes.`,
      recommendedAction: 'Review the account\'s registration and voting history. Concentration can indicate a community organiser, not a fraudster.',
    });
  }

  return {
    totalVotes: total,
    distinctVoters: byUser.size,
    votesPerVoter: byUser.size === 0 ? null : roundTo(total / byUser.size, 4),
    velocityPerHour: velocity,
    topAccountShare: topShare,
    topAccounts: top,
    signals,
  };
}

/* --------------------------------------------------------- orchestration */

export function computeDiagnostics(input: {
  eventId: string;
  rubricVersionId: string;
  assignmentVersion: number;
  reviews: readonly ReviewRecord[];
  /** judgeId -> total assigned review count. */
  assignments: ReadonlyMap<string, number>;
  /** judgeId -> project ids assigned. Used to derive per-project coverage. */
  assignmentTargets: ReadonlyMap<string, string[]>;
  criteria: readonly string[];
  minimumJudges: number;
  votes?: { votes: readonly { userId: string; createdAt: string }[]; windowStart: string; windowEnd: string };
  computedAt: string;
}): EventDiagnostics {
  const decided = input.reviews.filter((r) => r.state !== 'DRAFT');
  const allScores = decided.map((r) => r.score).filter(Number.isFinite);
  const panelMean = stableMean(allScores);
  const panelStddev = stddev(allScores);

  const byJudge = new Map<string, ReviewRecord[]>();
  const byProject = new Map<string, ReviewRecord[]>();
  for (const review of decided) {
    byJudge.set(review.judgeId, [...(byJudge.get(review.judgeId) ?? []), review]);
    byProject.set(review.projectId, [...(byProject.get(review.projectId) ?? []), review]);
  }

  /**
   * The authoritative assignment list, inverted. Coverage must be measured
   * against who was *supposed to* review a project, not against who did —
   * otherwise a project where every assigned judge abandoned the review looks
   * like a fully covered project and the INCOMPLETE signal can never fire.
   */
  const assignedJudgesByProject = new Map<string, Set<string>>();
  for (const [judgeId, projectIds] of input.assignmentTargets) {
    for (const projectId of projectIds) {
      const set = assignedJudgesByProject.get(projectId) ?? new Set<string>();
      set.add(judgeId);
      assignedJudgesByProject.set(projectId, set);
    }
  }

  const judges: JudgeDiagnostic[] = [];
  const judgeIds = new Set<string>([
    ...byJudge.keys(),
    ...input.assignments.keys(),
    ...input.assignmentTargets.keys(),
  ]);
  for (const judgeId of [...judgeIds].sort()) {
    const reviews = byJudge.get(judgeId) ?? [];
    judges.push(
      diagnoseJudge(
        judgeId,
        reviews,
        panelMean,
        panelStddev,
        input.assignments.get(judgeId) ?? input.assignmentTargets.get(judgeId)?.length ?? reviews.length,
        reviews.map((r) => r.projectId),
      ),
    );
  }

  const projectIds = new Set<string>([...byProject.keys(), ...assignedJudgesByProject.keys()]);
  const projects: ProjectDiagnostic[] = [];
  for (const projectId of [...projectIds].sort()) {
    const reviews = byProject.get(projectId) ?? [];
    const assignedJudges = Math.max(
      assignedJudgesByProject.get(projectId)?.size ?? 0,
      new Set(reviews.map((r) => r.judgeId)).size,
    );
    projects.push(
      diagnoseProject(projectId, reviews, assignedJudges, panelMean, panelStddev, input.criteria, input.minimumJudges),
    );
  }

  const voting = input.votes
    ? diagnoseVoting({
        eventId: input.eventId,
        votes: input.votes.votes,
        windowStart: input.votes.windowStart,
        windowEnd: input.votes.windowEnd,
      })
    : null;

  const signals = [
    ...judges.flatMap((j) => j.signals),
    ...projects.flatMap((p) => p.signals),
    ...(voting?.signals ?? []),
  ].sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity) || a.type.localeCompare(b.type));

  return {
    engineVersion: DIAGNOSTICS_ENGINE_VERSION,
    eventId: input.eventId,
    rubricVersionId: input.rubricVersionId,
    assignmentVersion: input.assignmentVersion,
    computedAt: input.computedAt,
    panel: {
      judgeCount: judgeIds.size,
      reviewCount: allScores.length,
      mean: roundToOrNull(panelMean),
      median: roundToOrNull(median(allScores)),
      stddev: roundToOrNull(panelStddev),
    },
    judges,
    projects,
    voting,
    signals,
    thresholds: THRESHOLDS,
  };
}

function severityWeight(severity: AnomalySeverity): number {
  return severity === 'HIGH' ? 3 : severity === 'MEDIUM' ? 2 : 1;
}

export { robustSigma };

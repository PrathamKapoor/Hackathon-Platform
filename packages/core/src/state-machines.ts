/**
 * Explicit lifecycle state machines (spec §5.2).
 *
 * Every workflow that matters has a named state, a declared set of legal
 * transitions, and a documented reason for each one. Illegal transitions are
 * rejected by a pure function that both the HTTP layer and the tests use, so
 * "can this happen?" has exactly one answer in the codebase.
 */

import type {
  EventState,
  JudgeState,
  RegistrationState,
  SubmissionState,
  ScoreState,
  Role,
} from './types.ts';

export class TransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly entity: string;
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string, reason: string) {
    super(`${entity} cannot move from ${from} to ${to}: ${reason}`);
    this.name = 'TransitionError';
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export type Transition<S extends string> = {
  from: S;
  to: S;
  /** Why this transition exists. Surfaced in docs and audit metadata. */
  reason: string;
  /**
   * Guard evaluated before the transition is applied. Returning a string denies
   * the transition with that explanation. Guards exist so that business rules
   * (e.g. "cannot lock submissions unless the deadline passed or an override is
   * supplied") are expressed once, declaratively.
   */
  guard?: (context: TransitionContext) => string | null;
};

export type TransitionContext = {
  /** True when an authorised organizer is explicitly overriding the workflow. */
  override: boolean;
  /** Free-form facts the guard may consult (deadline state, counts, ...). */
  facts: Record<string, unknown>;
  actor: { id: string; roles: Role[] };
};

const ALLOW: (context: TransitionContext) => string | null = () => null;

function transitionTable<S extends string>(entity: string, list: Transition<S>[]) {
  const map = new Map<string, Transition<S>[]>();
  for (const t of list) {
    const key = t.from;
    const existing = map.get(key);
    if (existing) existing.push(t);
    else map.set(key, [t]);
  }
  return {
    entity,
    transitions: list,
    outgoing(from: S): Transition<S>[] {
      return map.get(from) ?? [];
    },
    targets(from: S): S[] {
      return (map.get(from) ?? []).map((t) => t.to);
    },
  };
}

/* ------------------------------------------------------------- event */

const eventMachine = transitionTable<EventState>('Event', [
  {
    from: 'DRAFT',
    to: 'REGISTRATION',
    reason: 'Organizer opens registration once the event is configured.',
    guard: (ctx) => {
      if (ctx.facts.registrationOpensAt === undefined) return 'Event must define a registration window before registration can open.';
      return ALLOW(ctx);
    },
  },
  { from: 'DRAFT', to: 'ARCHIVED', reason: 'Abandoned or merged event is archived.' },
  {
    from: 'REGISTRATION',
    to: 'ACTIVE',
    reason: 'Event goes live for participants (registration may still be open).',
  },
  { from: 'REGISTRATION', to: 'DRAFT', reason: 'Organizer reopens configuration before launch.' },
  { from: 'REGISTRATION', to: 'ARCHIVED', reason: 'Cancelled event.' },
  {
    from: 'ACTIVE',
    to: 'SUBMISSIONS_LOCKED',
    reason: 'Submission deadline reached; the project set is frozen.',
    guard: (ctx) => {
      if (ctx.override) return ALLOW(ctx);
      if (ctx.facts.deadlinePassed !== true) {
        return 'The submission deadline has not passed yet. An authorized organizer override is required.';
      }
      return ALLOW(ctx);
    },
  },
  { from: 'ACTIVE', to: 'ARCHIVED', reason: 'Cancelled event.' },
  { from: 'ACTIVE', to: 'REGISTRATION', reason: 'Rollback to reopen registration.' },
  {
    from: 'SUBMISSIONS_LOCKED',
    to: 'JUDGING',
    reason: 'Judging opens for the frozen project set.',
    guard: (ctx) => {
      if (ctx.facts.submissionCount !== undefined && (ctx.facts.submissionCount as number) === 0) {
        return 'Cannot start judging: the event has no submitted projects.';
      }
      return ALLOW(ctx);
    },
  },
  { from: 'SUBMISSIONS_LOCKED', to: 'ACTIVE', reason: 'Reopen submissions after an erroneous lock.' },
  { from: 'SUBMISSIONS_LOCKED', to: 'ARCHIVED', reason: 'Cancelled event.' },
  {
    from: 'JUDGING',
    to: 'RESULTS_PENDING',
    reason: 'Judging closed; results are computed but not published.',
    guard: (ctx) => {
      if (ctx.override) return ALLOW(ctx);
      const incomplete = (ctx.facts.incompleteAssignments as number | undefined) ?? 0;
      if (incomplete > 0) {
        return `${incomplete} assignment(s) are still incomplete. Complete them or use an authorized override.`;
      }
      return ALLOW(ctx);
    },
  },
  { from: 'JUDGING', to: 'SUBMISSIONS_LOCKED', reason: 'Send judging back for more scores.' },
  { from: 'JUDGING', to: 'ARCHIVED', reason: 'Cancelled event.' },
  { from: 'RESULTS_PENDING', to: 'PUBLISHED', reason: 'Results are made public.' },
  { from: 'RESULTS_PENDING', to: 'JUDGING', reason: 'Withdraw results for correction.' },
  { from: 'RESULTS_PENDING', to: 'ARCHIVED', reason: 'Event abandoned before publication.' },
  { from: 'PUBLISHED', to: 'ARCHIVED', reason: 'Event concluded and archived.' },
  { from: 'PUBLISHED', to: 'RESULTS_PENDING', reason: 'Unpublish results (creates a new audit record).' },
  { from: 'ARCHIVED', to: 'DRAFT', reason: 'Restore an archived event for editing.' },
]);

export const EVENT_MACHINE = eventMachine;

/* -------------------------------------------------------- submission */

const submissionMachine = transitionTable<SubmissionState>('Submission', [
  {
    from: 'DRAFT',
    to: 'SUBMITTED',
    reason: 'Participant submits the project for review.',
    guard: (ctx) => {
      if (ctx.override) return ALLOW(ctx);
      if (ctx.facts.submissionWindowOpen !== true) {
        return 'The submission window is closed. An authorized organizer override is required.';
      }
      return ALLOW(ctx);
    },
  },
  { from: 'SUBMITTED', to: 'DRAFT', reason: 'Participant withdraws back to editing before the deadline.', guard: (ctx) => (ctx.facts.submissionWindowOpen === true || ctx.override ? null : 'The submission window is closed.') },
  {
    from: 'SUBMITTED',
    to: 'LOCKED',
    reason: 'Organizer locks the submission; the current version becomes immutable.',
  },
  { from: 'SUBMITTED', to: 'FINALIZED', reason: 'Direct finalize for small events.' },
  { from: 'LOCKED', to: 'JUDGING', reason: 'Assignment engine begins judging this submission.' },
  { from: 'LOCKED', to: 'SUBMITTED', reason: 'Unlock before judging starts (audited).', guard: (ctx) => (ctx.override ? null : 'Only an authorized organizer may unlock.') },
  { from: 'LOCKED', to: 'FINALIZED', reason: 'Withdrawn from judging.' },
  { from: 'JUDGING', to: 'FINALIZED', reason: 'Judging complete and results computed.' },
  { from: 'JUDGING', to: 'LOCKED', reason: 'Reopen judging for additional scores.' },
  { from: 'FINALIZED', to: 'LOCKED', reason: 'Reverse a finalization for correction (audited).', guard: (ctx) => (ctx.override ? null : 'Only an authorized organizer may reverse finalization.') },
]);

export const SUBMISSION_MACHINE = submissionMachine;

/* ------------------------------------------------------------- judge */

const judgeMachine = transitionTable<JudgeState>('Judge', [
  { from: 'INVITED', to: 'ACCEPTED', reason: 'Judge accepts the invitation and completes their profile.' },
  { from: 'INVITED', to: 'INVITED', reason: 'Invitation resent.', },
  { from: 'ACCEPTED', to: 'ACTIVE', reason: 'Judge begins reviewing; activated on first scoring activity or explicitly by an organizer.' },
  { from: 'ACCEPTED', to: 'INVITED', reason: 'Judge declines or invitation is withdrawn.', guard: (ctx) => (ctx.override ? null : 'Judges may withdraw themselves; organizers must use an override.') },
  {
    from: 'ACTIVE',
    to: 'COMPLETED',
    reason: 'All assigned reviews are submitted.',
    /*
     * This edge asserts a *fact* about the panel, not a preference of the
     * judge. "All assigned reviews are submitted" is checkable, and the count
     * is already computed and handed to the guards as `outstandingAssignments` -
     * it simply was not consulted here.
     *
     * That mattered, because this edge has no guard at all, so any actor the
     * service authorised could walk through it. A judge authorised to move
     * their own record could therefore mark themselves complete with work
     * outstanding, which is a self-certification problem rather than a cosmetic
     * one: a participation record attests to how much of the panel was
     * completed, and that attestation is what the completed state feeds.
     *
     * The override escape is kept, and is the right escape. An organizer who
     * genuinely needs to close a judge out - a panel reassigned wholesale, a
     * judge who has left - passes `override`, and the outcome is recorded as an
     * override rather than being quietly indistinguishable from the ordinary
     * path.
     */
    guard: (ctx) => {
      if (ctx.override) return null;
      const outstanding = ctx.facts.outstandingAssignments;
      if (typeof outstanding !== 'number') {
        return 'Cannot verify the assignment count; refusing to record a completion that may not be true.';
      }
      return outstanding === 0
        ? null
        : `${String(outstanding)} assignment(s) are still outstanding. Complete or reassign them, or pass an explicit organizer override.`;
    },
  },
  { from: 'ACTIVE', to: 'ACCEPTED', reason: 'Organizer deactivates the judge; assignments must be reassigned.', guard: (ctx) => (ctx.override ? null : 'Deactivation requires an authorized organizer override.') },
  { from: 'COMPLETED', to: 'ACTIVE', reason: 'Judge is reactivated for additional assignments.' },
]);

export const JUDGE_MACHINE = judgeMachine;

/* ------------------------------------------------------ registration */

const registrationMachine = transitionTable<RegistrationState>('Registration', [
  { from: 'APPLICATION', to: 'PENDING', reason: 'Application submitted for review.' },
  { from: 'APPLICATION', to: 'WITHDRAWN', reason: 'Applicant withdraws before review.' },
  { from: 'PENDING', to: 'ACCEPTED', reason: 'Organizer admits the applicant.' },
  { from: 'PENDING', to: 'REJECTED', reason: 'Organizer declines the applicant.' },
  { from: 'PENDING', to: 'WAITLISTED', reason: 'Organizer defers the applicant.' },
  { from: 'PENDING', to: 'WITHDRAWN', reason: 'Applicant withdraws.' },
  { from: 'WAITLISTED', to: 'ACCEPTED', reason: 'Waitlisted applicant is admitted.' },
  { from: 'WAITLISTED', to: 'REJECTED', reason: 'Waitlisted applicant is declined.' },
  { from: 'WAITLISTED', to: 'WITHDRAWN', reason: 'Applicant withdraws from the waitlist.' },
  { from: 'REJECTED', to: 'ACCEPTED', reason: 'Rejection is reversed by an organizer.', guard: (ctx) => (ctx.override ? null : 'Reversing a rejection requires an authorized organizer override.') },
  { from: 'REJECTED', to: 'PENDING', reason: 'Rejection is reversed for re-review.', guard: (ctx) => (ctx.override ? null : 'Reversing a rejection requires an authorized organizer override.') },
]);

export const REGISTRATION_MACHINE = registrationMachine;

/* ------------------------------------------------------------- score */

const scoreMachine = transitionTable<ScoreState>('Score', [
  { from: 'DRAFT', to: 'SUBMITTED', reason: 'Judge submits the review; it becomes visible to organizers.' },
  { from: 'DRAFT', to: 'DRAFT', reason: 'Autosave of an in-progress review.' },
  {
    from: 'SUBMITTED',
    to: 'LOCKED',
    reason: 'Judging closed for the event; scores become immutable.',
  },
  {
    from: 'SUBMITTED',
    to: 'DRAFT',
    reason: 'Judge revises before the event leaves the judging state.',
    guard: (ctx) => (ctx.override || ctx.facts.judgingOpen === true ? null : 'Judging is closed; an authorized override is required.'),
  },
  { from: 'DRAFT', to: 'LOCKED', reason: 'Discarded review is locked for the record.', guard: (ctx) => (ctx.override ? null : 'Only an organizer override may lock a draft.') },
  { from: 'LOCKED', to: 'DRAFT', reason: 'Score is corrected under override.', guard: (ctx) => (ctx.override ? null : 'Locked scores may only be corrected by an authorized organizer.') },
]);

export const SCORE_MACHINE = scoreMachine;

/* -------------------------------------------------------- generic api */

export type Machine<S extends string> = {
  entity: string;
  transitions: Transition<S>[];
  outgoing(from: S): Transition<S>[];
  targets(from: S): S[];
};

export const MACHINES = {
  Event: EVENT_MACHINE,
  Submission: SUBMISSION_MACHINE,
  Judge: JUDGE_MACHINE,
  Registration: REGISTRATION_MACHINE,
  Score: scoreMachine,
} as const;

export function machineFor<S extends string>(name: keyof typeof MACHINES): Machine<S> {
  return MACHINES[name] as unknown as Machine<S>;
}

export function canTransition<S extends string>(
  name: keyof typeof MACHINES,
  from: S,
  to: S,
): boolean {
  return machineFor<S>(name).outgoing(from).some((t) => t.to === to);
}

/**
 * Validate and authorise a transition. Throws `TransitionError` when the
 * transition is illegal or its guard denies it. This is the single choke point
 * used by every service that mutates lifecycle state.
 */
export function assertTransition<S extends string>(
  name: keyof typeof MACHINES,
  from: S,
  to: S,
  context: TransitionContext,
): void {
  const machine = machineFor<S>(name);
  const candidates = machine.outgoing(from).filter((t) => t.to === to);
  if (candidates.length === 0) {
    throw new TransitionError(machine.entity, from, to, 'no such transition is defined');
  }
  const denials: string[] = [];
  for (const candidate of candidates) {
    const denial = candidate.guard ? candidate.guard(context) : null;
    if (denial === null) return;
    denials.push(denial);
  }
  throw new TransitionError(machine.entity, from, to, denials.join(' '));
}

/** Non-throwing probe used by the UI to decide which buttons to enable. */
export function transitionCheck<S extends string>(
  name: keyof typeof MACHINES,
  from: S,
  to: S,
  context: TransitionContext,
): { allowed: boolean; reason: string | null } {
  try {
    assertTransition(name, from, to, context);
    return { allowed: true, reason: null };
  } catch (error) {
    if (error instanceof TransitionError) return { allowed: false, reason: error.message };
    throw error;
  }
}

/** Flat documentation of the lifecycle, used to generate API docs. */
export function describeMachine(name: keyof typeof MACHINES): {
  entity: string;
  transitions: { from: string; to: string; reason: string; guarded: boolean }[];
} {
  const machine = MACHINES[name];
  return {
    entity: machine.entity,
    transitions: machine.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      reason: t.reason,
      guarded: Boolean(t.guard),
    })),
  };
}

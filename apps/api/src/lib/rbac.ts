/**
 * Role-based access control.
 *
 * ---------------------------------------------------------------------------
 * WHY AN EXPLICIT MATRIX INSTEAD OF SCATTERED `if` STATEMENTS
 * ---------------------------------------------------------------------------
 * Authorization bugs are almost never "the check was missing". They are "the
 * check exists in eleven handlers and one of them was written slightly
 * differently". So the entire policy lives in one table, it is the only place a
 * permission is granted, and a test walks every cell of it.
 *
 * A permission is a (resource, action, scope) triple:
 *   resource : the domain object being touched
 *   action   : what is being done to it
 *   scope    : whose data it must be:
 *               PUBLIC   no authentication required
 *               OWN      the caller's own record
 *               ASSIGNED the caller is an assigned judge for it, or owns it
 *               EVENT    any record inside an event the actor organizes
 *               ANY      platform-wide; granted only to a global admin
 *
 * `can()` resolves a request against this table and nothing else. Handlers call
 * `requirePermission(...)`, which throws rather than returning a boolean, so a
 * forgotten check becomes a 403 instead of a silent allow.
 *
 * ---------------------------------------------------------------------------
 * SCOPE RESOLUTION
 * ---------------------------------------------------------------------------
 * Ownership is established by the *domain*, not by the request. `can()` receives
 * an `Ownership` object assembled by the service that loaded the record, so
 * "is this my team" is answered from the row that was actually read rather than
 * from a client-supplied id.
 */

import { ROLES, ROLE_RANK, type Role } from '@verdict/core/types';

export const RESOURCES = [
  'profile', 'event', 'track', 'prize', 'registration', 'team', 'submission',
  'submissionVersion', 'upload', 'judge', 'conflict', 'assignment', 'rubric',
  'calibration', 'score', 'pairwise', 'normalization', 'diagnostic', 'anomaly',
  'result', 'certificate', 'participationRecord', 'vote', 'comment', 'webhook',
  'import', 'export', 'audit', 'user', 'session',
] as const;
export type Resource = (typeof RESOURCES)[number];

export const ACTIONS = ['read', 'create', 'update', 'delete', 'publish', 'moderate', 'override', 'export'] as const;
export type Action = (typeof ACTIONS)[number];

export const SCOPES = ['PUBLIC', 'OWN', 'ASSIGNED', 'EVENT', 'ANY'] as const;
export type Scope = (typeof SCOPES)[number];

export type Actor = {
  id: string;
  roles: Role[];
  /** Event ids in which the actor holds an event-scoped role. */
  eventIds: string[];
  state: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
};

export type Ownership = {
  ownerId: string | null;
  /** The actor is an assigned judge for this record. */
  assignedJudge: boolean;
  /** The record belongs to an event the actor organizes or administers. */
  inOrganizedEvent: boolean;
  /** The record is publicly visible (gallery entry, published results, rubric). */
  publiclyVisible: boolean;
  /** The actor is a member of the owning team. */
  teamMember: boolean;
};

export const NO_OWNERSHIP: Ownership = {
  ownerId: null,
  assignedJudge: false,
  inOrganizedEvent: false,
  publiclyVisible: false,
  teamMember: false,
};

export const ANONYMOUS: Actor = { id: '', roles: [], eventIds: [], state: 'ACTIVE' };

/**
 * ---------------------------------------------------------------------------
 * THE MATRIX
 * ---------------------------------------------------------------------------
 * Written as a compact literal per role and expanded into a full table, so a
 * missing cell is a `undefined` (denied by default) rather than a copy-paste of
 * somebody else's grant. Anything not listed is denied.
 */
const SPEC: Record<Role, Partial<Record<Action, Partial<Record<Resource, Scope>>>>> = {
  PARTICIPANT: {
    read: {
      profile: 'OWN', event: 'PUBLIC', track: 'PUBLIC', prize: 'PUBLIC',
      registration: 'OWN', team: 'OWN', submission: 'OWN', submissionVersion: 'OWN',
      upload: 'OWN', judge: 'PUBLIC', rubric: 'ASSIGNED', calibration: 'ASSIGNED',
      score: 'OWN', assignment: 'ASSIGNED', pairwise: 'ASSIGNED', conflict: 'OWN',
      result: 'PUBLIC', certificate: 'OWN', participationRecord: 'OWN',
      vote: 'OWN', comment: 'OWN', session: 'OWN', user: 'OWN',
    },
    create: {
      profile: 'OWN', registration: 'OWN', team: 'OWN', submission: 'OWN',
      submissionVersion: 'OWN', upload: 'OWN', comment: 'OWN', vote: 'OWN',
      session: 'PUBLIC', user: 'PUBLIC',
    },
    update: {
      profile: 'OWN', registration: 'OWN', team: 'OWN', submission: 'OWN',
      upload: 'OWN', comment: 'OWN', session: 'OWN',
    },
    delete: {
      profile: 'OWN', registration: 'OWN', team: 'OWN', submission: 'OWN',
      comment: 'OWN', session: 'OWN', upload: 'OWN',
    },
    export: { certificate: 'OWN', participationRecord: 'OWN' },
  },

  JUDGE: {
    read: {
      profile: 'OWN', event: 'PUBLIC', track: 'PUBLIC', prize: 'PUBLIC',
      rubric: 'ASSIGNED', calibration: 'ASSIGNED', score: 'OWN', assignment: 'OWN',
      pairwise: 'ASSIGNED', conflict: 'OWN', submission: 'ASSIGNED', team: 'ASSIGNED',
      certificate: 'OWN', participationRecord: 'OWN', comment: 'OWN',
      session: 'OWN', user: 'OWN', judge: 'PUBLIC',
    },
    create: {
      profile: 'OWN', score: 'ASSIGNED', pairwise: 'ASSIGNED', calibration: 'ASSIGNED',
      conflict: 'OWN', comment: 'OWN', session: 'PUBLIC', user: 'PUBLIC',
    },
    update: {
      profile: 'OWN', score: 'ASSIGNED', pairwise: 'ASSIGNED', calibration: 'ASSIGNED',
      conflict: 'OWN', comment: 'OWN', session: 'OWN',
    },
    delete: { profile: 'OWN', comment: 'OWN', session: 'OWN' },
    export: { certificate: 'OWN', participationRecord: 'OWN' },
  },

  ORGANIZER: {
    read: {
      profile: 'OWN', session: 'OWN',
      // Everything inside an event the actor organizes.
      event: 'EVENT', track: 'EVENT', prize: 'EVENT', registration: 'EVENT',
      team: 'EVENT', submission: 'EVENT', submissionVersion: 'EVENT', upload: 'EVENT',
      judge: 'EVENT', conflict: 'EVENT', assignment: 'EVENT', rubric: 'EVENT',
      calibration: 'EVENT', score: 'EVENT', pairwise: 'EVENT', normalization: 'EVENT',
      diagnostic: 'EVENT', anomaly: 'EVENT', result: 'EVENT', certificate: 'EVENT',
      participationRecord: 'EVENT', vote: 'EVENT', comment: 'EVENT', webhook: 'EVENT',
      import: 'EVENT', export: 'EVENT', audit: 'EVENT', user: 'EVENT',
    },
    create: {
      profile: 'OWN', session: 'PUBLIC', comment: 'OWN', upload: 'OWN',
      // Platform-wide event creation is why 'create event' uses ANY, not EVENT.
      event: 'ANY',
      track: 'EVENT', prize: 'EVENT', registration: 'EVENT', team: 'EVENT',
      submission: 'EVENT', submissionVersion: 'EVENT', judge: 'EVENT', conflict: 'EVENT',
      assignment: 'EVENT', rubric: 'EVENT', calibration: 'EVENT', certificate: 'EVENT',
      participationRecord: 'EVENT', webhook: 'EVENT', import: 'EVENT', export: 'EVENT',
      // Computing, snapshotting and correcting results is the organizer's job.
      // Without these the whole judging pipeline is unreachable over HTTP: a
      // run could be created by the seeder but never by the person running the
      // event. A normalization run and its diagnostics are created in the same
      // operation, so they are granted together.
      result: 'EVENT', normalization: 'EVENT', diagnostic: 'EVENT', anomaly: 'EVENT',
    },
    update: {
      profile: 'OWN', session: 'OWN', upload: 'OWN',
      event: 'EVENT', track: 'EVENT', prize: 'EVENT', registration: 'EVENT', team: 'EVENT',
      submission: 'EVENT', judge: 'EVENT', conflict: 'EVENT', assignment: 'EVENT',
      rubric: 'EVENT', calibration: 'EVENT', webhook: 'EVENT', comment: 'EVENT',
      normalization: 'EVENT', diagnostic: 'EVENT', result: 'EVENT', certificate: 'EVENT',
      participationRecord: 'EVENT', score: 'EVENT', pairwise: 'EVENT', anomaly: 'EVENT',
    },
    delete: {
      profile: 'OWN', session: 'OWN', upload: 'OWN',
      track: 'EVENT', prize: 'EVENT', registration: 'EVENT', team: 'EVENT',
      submission: 'EVENT', judge: 'EVENT', conflict: 'EVENT', assignment: 'EVENT',
      rubric: 'EVENT', calibration: 'EVENT', webhook: 'EVENT', import: 'EVENT',
      comment: 'EVENT', anomaly: 'EVENT',
      // An event is never deleted, only archived: history is the product.
      event: null as unknown as Scope,
    },
    publish: {
      event: 'EVENT', result: 'EVENT', registration: 'EVENT', submission: 'EVENT',
      rubric: 'EVENT', comment: 'EVENT',
    },
    moderate: { comment: 'EVENT', anomaly: 'EVENT', vote: 'EVENT', registration: 'EVENT' },
    override: {
      event: 'EVENT', track: 'EVENT', prize: 'EVENT', registration: 'EVENT', team: 'EVENT',
      submission: 'EVENT', judge: 'EVENT', conflict: 'EVENT', assignment: 'EVENT',
      rubric: 'EVENT', calibration: 'EVENT', score: 'EVENT', pairwise: 'EVENT',
      normalization: 'EVENT', diagnostic: 'EVENT', anomaly: 'EVENT', result: 'EVENT',
      certificate: 'EVENT', comment: 'EVENT', vote: 'EVENT', import: 'EVENT',
    },
    export: {
      event: 'EVENT', track: 'EVENT', prize: 'EVENT', registration: 'EVENT', team: 'EVENT',
      submission: 'EVENT', judge: 'EVENT', rubric: 'EVENT', assignment: 'EVENT',
      score: 'EVENT', pairwise: 'EVENT', normalization: 'EVENT', diagnostic: 'EVENT',
      anomaly: 'EVENT', result: 'EVENT', certificate: 'EVENT', participationRecord: 'EVENT',
      vote: 'EVENT', comment: 'EVENT', audit: 'EVENT',
    },
  },

  ADMIN: {},
};

/** Expand the compact spec into a dense, fully-populated table. */
const POLICY: Record<Role, Record<Action, Record<Resource, Scope | null>>> = (() => {
  const build = (role: Role): Record<Action, Record<Resource, Scope | null>> => {
    if (role === 'ADMIN') {
      // An admin may do anything within any scope, so the table is generated
      // rather than typed out 248 times.
      const table = {} as Record<Action, Record<Resource, Scope | null>>;
      for (const action of ACTIONS) {
        table[action] = {} as Record<Resource, Scope | null>;
        for (const resource of RESOURCES) table[action][resource] = 'ANY';
      }
      return table;
    }
    const spec = SPEC[role];
    const table = {} as Record<Action, Record<Resource, Scope | null>>;
    for (const action of ACTIONS) {
      table[action] = {} as Record<Resource, Scope | null>;
      const forAction = spec[action] ?? {};
      for (const resource of RESOURCES) {
        const scope = forAction[resource];
        // An explicit `null` in the spec means "deny"; an absent key also denies.
        table[action][resource] = scope ?? null;
      }
    }
    return table;
  };

  return Object.fromEntries(ROLES.map((role) => [role, build(role)])) as Record<Role, Record<Action, Record<Resource, Scope | null>>>;
})();

/* ------------------------------------------------------------- runtime */

export type Decision = {
  allowed: boolean;
  /** The role that actually granted access, for the audit trail. */
  viaRole: Role | null;
  reason: string;
};

/** Resources whose `read` may be satisfied without authentication. */
const PUBLIC_READABLE: ReadonlySet<Resource> = new Set<Resource>([
  'event', 'track', 'prize', 'submission', 'judge', 'result', 'rubric', 'certificate', 'comment',
]);

function scopeSatisfied(scope: Scope, actor: Actor, ownership: Ownership): boolean {
  switch (scope) {
    case 'PUBLIC':
      return ownership.publiclyVisible;
    case 'OWN':
      return ownership.ownerId !== null && ownership.ownerId === actor.id;
    case 'ASSIGNED':
      return ownership.assignedJudge || ownership.ownerId === actor.id || ownership.teamMember;
    case 'EVENT':
      return ownership.inOrganizedEvent;
    case 'ANY':
      // 'ANY' means the operation is not tied to a record: only a global admin
      // gets it, which is what stops an event organizer creating platform-wide
      // objects such as another event's admin.
      return actor.roles.includes('ADMIN');
    default:
      return false;
  }
}

/** Evaluate the matrix. Pure, and the only place a permission is decided. */
export function can(
  actor: Actor | null,
  resource: Resource,
  action: Action,
  ownership: Ownership = NO_OWNERSHIP,
): Decision {
  const effective: Actor = actor ?? ANONYMOUS;

  if (effective.id === '') {
    if (action === 'read' && PUBLIC_READABLE.has(resource) && ownership.publiclyVisible) {
      return { allowed: true, viaRole: null, reason: 'publicly visible content' };
    }
    return { allowed: false, viaRole: null, reason: 'authentication required' };
  }

  if (effective.state !== 'ACTIVE') {
    return { allowed: false, viaRole: null, reason: `account is ${effective.state.toLowerCase()}` };
  }

  // Highest-privilege role first, so the audit trail names the role that
  // actually granted access rather than the first one that happened to match.
  const ordered = [...effective.roles].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a]);
  const denials: string[] = [];

  for (const role of ordered) {
    const scope = POLICY[role]?.[action]?.[resource] ?? null;
    if (scope === null) {
      denials.push(`${role} is never granted ${action} on ${resource}`);
      continue;
    }
    if (scopeSatisfied(scope, effective, ownership)) {
      return { allowed: true, viaRole: role, reason: `${role} may ${action} ${resource} (scope ${scope})` };
    }
    denials.push(`${role} requires ${scope} scope for ${action} on ${resource}`);
  }

  return { allowed: false, viaRole: null, reason: denials.length > 0 ? denials.join('; ') : 'no role grants this action' };
}

export function hasRole(actor: Actor | null, ...roles: Role[]): boolean {
  if (actor === null) return false;
  return roles.some((role) => actor.roles.includes(role));
}

export function isAdmin(actor: Actor | null): boolean {
  return hasRole(actor, 'ADMIN');
}

export function isOrganizer(actor: Actor | null): boolean {
  return hasRole(actor, 'ORGANIZER', 'ADMIN');
}

/** Event-scoped check: does this actor organize (or administer) this event? */
export function canManageEvent(actor: Actor | null, eventId: string): boolean {
  if (actor === null) return false;
  if (actor.roles.includes('ADMIN')) return true;
  if (!actor.roles.includes('ORGANIZER')) return false;
  return actor.eventIds.includes(eventId);
}

export function canJudgeEvent(actor: Actor | null, eventId: string): boolean {
  if (actor === null) return false;
  if (actor.roles.includes('ADMIN')) return true;
  if (!actor.roles.includes('JUDGE')) return false;
  return actor.eventIds.includes(eventId);
}

/** Flatten the matrix for documentation and the coverage test. */
export function describeMatrix(): {
  role: Role;
  grants: { resource: Resource; action: Action; scope: Scope | null }[];
}[] {
  return ROLES.map((role) => {
    const grants: { resource: Resource; action: Action; scope: Scope | null }[] = [];
    for (const action of ACTIONS) {
      for (const resource of RESOURCES) {
        grants.push({ resource, action, scope: POLICY[role][action][resource] });
      }
    }
    return { role, grants };
  });
}

/** Direct table access for tests and documentation. */
export function matrixCell(role: Role, action: Action, resource: Resource): Scope | null {
  return POLICY[role][action][resource] ?? null;
}

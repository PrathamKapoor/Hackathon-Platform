/**
 * Team formation.
 *
 * The rules that matter for integrity:
 *  - Team mutations are blocked once the event's project set is frozen, unless
 *    an authorized organizer uses an explicit override, and every override is
 *    audited with the reason.
 *  - Team size limits come from the event, not from the client.
 *  - A captain is always also a member; the two are kept consistent in one
 *    place rather than by convention.
 */

import { newId, newInviteCode } from '@verdict/core/ids';
import { addSeconds, compare, toEpochMs, type Instant } from '@verdict/core/time';
import { validateEmail, validatePlainText, validateSlug } from '@verdict/core/validation';
import { errors } from '../lib/errors.ts';
import { canManageEvent } from '../lib/rbac.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';
import { slugify, type EventRow } from './event-service.ts';

export type TeamRow = {
  id: string;
  event_id: string;
  slug: string;
  name: string;
  description: string;
  captain_id: string;
  organization: string;
  track_id: string | null;
  is_locked: number;
  created_at: string;
  updated_at: string;
};

export type TeamMemberRow = {
  id: string;
  team_id: string;
  user_id: string;
  role: 'CAPTAIN' | 'MEMBER';
  joined_at: string;
  created_at: string;
  updated_at: string;
};

const INVITE_TTL_DAYS = 14;

export class TeamService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];
  /** Held for its `webhooks` entry; see the note in `create`. */
  private readonly services: Services;

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
    this.services = services;
  }

  create(
    eventId: string,
    input: { name: string; description?: string; organization?: string; trackId?: string | null },
    ctx: ActorContext,
  ): TeamRow {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    const name = validatePlainText(input.name, { field: 'team name', min: 2, max: 100 });
    const slug = this.uniqueSlug(eventId, validateSlug(slugify(name), 'team slug'));

    const team = this.db.transaction(() => {
      const id = newId('team');
      this.db.exec(
        `INSERT INTO teams (id, event_id, slug, name, description, captain_id, organization, track_id, created_at, updated_at)
         VALUES (:id, :event_id, :slug, :name, :description, :captain_id, :organization, :track_id, :at, :at)`,
        {
          id,
          event_id: eventId,
          slug,
          name,
          description: validatePlainText(input.description ?? '', { field: 'description', max: 2000 }),
          captain_id: actor.id,
          organization: validatePlainText(input.organization ?? '', { field: 'organization', max: 200 }),
          track_id: input.trackId ?? null,
          at: ctx.at,
        },
      );
      this.addMember(id, actor.id, 'CAPTAIN', ctx.at);
      this.lockTeamIfFull(event, id, ctx.at);

      this.audit.record({
        action: 'team.created',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId,
        resourceType: 'team',
        resourceId: id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        newState: 'CAPTAIN',
        metadata: { name, slug },
        at: ctx.at,
      });

      return this.require(id);
    });

    // Dispatched after the transaction commits, not inside it: `dispatch` kicks
    // off an unawaited HTTP attempt that writes its result back to the database,
    // and a write landing inside an open transaction would race the commit.
    this.services.webhooks.dispatch(
      eventId,
      'team.created',
      { teamId: team.id, slug: team.slug, name: team.name, trackId: team.track_id },
      ctx,
    );

    return team;
  }

  update(teamId: string, patch: { name?: string; description?: string; organization?: string; trackId?: string | null }, ctx: ActorContext): TeamRow {
    const team = this.require(teamId);
    const actor = requireActor(ctx);
    this.assertMutable(team, actor, ctx);
    this.assertCaptain(team, actor, ctx);

    const fields: Record<string, string | null> = { updated_at: ctx.at };
    if (patch.name !== undefined) {
      const name = validatePlainText(patch.name, { field: 'team name', min: 2, max: 100 });
      fields.name = name;
      fields.slug = this.uniqueSlug(team.event_id, validateSlug(slugify(name), 'team slug'), team.id);
    }
    if (patch.description !== undefined) fields.description = validatePlainText(patch.description, { field: 'description', max: 2000 });
    if (patch.organization !== undefined) fields.organization = validatePlainText(patch.organization, { field: 'organization', max: 200 });
    if (patch.trackId !== undefined) fields.track_id = patch.trackId;

    const assignments = Object.keys(fields).map((key) => `"${key}" = :${key}`);
    this.db.exec(`UPDATE teams SET ${assignments.join(', ')} WHERE id = :id`, { ...fields, id: teamId });

    this.audit.record({
      action: 'team.updated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: team.event_id,
      resourceType: 'team',
      resourceId: teamId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      metadata: { changed: Object.keys(fields).filter((k) => k !== 'updated_at') },
      at: ctx.at,
    });
    return this.require(teamId);
  }

  /* -------------------------------------------------------- membership */

  invite(teamId: string, input: { email?: string; username?: string }, ctx: ActorContext) {
    const team = this.require(teamId);
    const actor = requireActor(ctx);
    this.assertMutable(team, actor, ctx);
    this.assertCaptain(team, actor, ctx);

    let email: string;
    if (input.email) {
      email = validateEmail(input.email);
    } else if (input.username) {
      const user = this.db.get<{ email: string }>('SELECT email FROM users WHERE username_normalized = :u', {
        u: input.username.trim().toLowerCase(),
      });
      if (user === null) throw errors.notFound('User', input.username);
      email = user.email;
    } else {
      throw errors.validation('An email address or username is required.', [{ field: 'email' }]);
    }

    const existing = this.db.get(
      "SELECT id, status FROM team_invitations WHERE team_id = :t AND email = :e AND status = 'PENDING'",
      { t: teamId, e: email },
    );
    if (existing !== null) {
      throw errors.conflict('That person already has a pending invitation to this team.', [{ field: 'email' }]);
    }

    const id = newId('teamInvitation');
    const code = newInviteCode();
    const expires = addSeconds(ctx.at, INVITE_TTL_DAYS * 86_400);

    this.db.exec(
      `INSERT INTO team_invitations (id, team_id, email, code, role, invited_by, status, expires_at, expires_ms, created_at, updated_at)
       VALUES (:id, :team_id, :email, :code, 'MEMBER', :invited_by, 'PENDING', :expires_at, :expires_ms, :at, :at)`,
      { id, team_id: teamId, email, code, invited_by: actor.id, expires_at: expires, expires_ms: toEpochMs(expires), at: ctx.at },
    );

    this.audit.record({
      action: 'team.invitation_created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: team.event_id,
      resourceType: 'teamInvitation',
      resourceId: id,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { teamId, email },
      at: ctx.at,
    });

    return this.invitation(id);
  }

  acceptInvitation(code: string, ctx: ActorContext): TeamRow {
    const actor = requireActor(ctx);
    const invitation = this.db.get<{
      id: string; team_id: string; email: string; status: string; expires_ms: number; role: 'CAPTAIN' | 'MEMBER';
    }>('SELECT * FROM team_invitations WHERE code = :code', { code: code.trim().toUpperCase() });

    if (invitation === null) throw errors.notFound('Invitation', code);
    if (invitation.status !== 'PENDING') {
      throw errors.conflict(`This invitation was already ${invitation.status.toLowerCase()}.`);
    }
    if (toEpochMs(ctx.at) >= invitation.expires_ms) {
      this.db.exec("UPDATE team_invitations SET status = 'EXPIRED', updated_at = :at WHERE id = :id", { at: ctx.at, id: invitation.id });
      throw errors.windowClosed('This invitation has expired. Ask the captain for a new one.');
    }

    const user = this.db.get<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = :id', { id: actor.id });
    if (user === null || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      this.audit.record({
        action: 'team.invitation_accepted',
        actorId: actor.id,
        actorRoles: actor.roles,
        resourceType: 'teamInvitation',
        resourceId: invitation.id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        outcome: 'DENIED',
        metadata: { reason: 'invitation was issued to a different email address' },
        at: ctx.at,
      });
      throw errors.forbidden('This invitation was issued to a different email address.');
    }

    const team = this.require(invitation.team_id);
    this.assertMutable(team, actor, ctx, { selfService: true });

    return this.db.transaction(() => {
      this.addMember(team.id, actor.id, invitation.role, ctx.at);
      this.db.exec(
        "UPDATE team_invitations SET status = 'ACCEPTED', accepted_by = :user, responded_at = :at, updated_at = :at WHERE id = :id",
        { user: actor.id, at: ctx.at, id: invitation.id },
      );
      this.lockTeamIfFull(this.events.require(team.event_id), team.id, ctx.at);

      this.audit.record({
        action: 'team.invitation_accepted',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: team.event_id,
        resourceType: 'team',
        resourceId: team.id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        newState: invitation.role,
        metadata: { invitationId: invitation.id },
        at: ctx.at,
      });

      return this.require(team.id);
    });
  }

  rejectInvitation(code: string, ctx: ActorContext): void {
    const actor = requireActor(ctx);
    const invitation = this.db.get<{ id: string; team_id: string; status: string; email: string }>(
      'SELECT id, team_id, status, email FROM team_invitations WHERE code = :code',
      { code: code.trim().toUpperCase() },
    );
    if (invitation === null) throw errors.notFound('Invitation', code);
    if (invitation.status !== 'PENDING') throw errors.conflict(`This invitation was already ${invitation.status.toLowerCase()}.`);

    const user = this.db.get<{ email: string }>('SELECT email FROM users WHERE id = :id', { id: actor.id });
    const team = this.require(invitation.team_id);
    const isRecipient = user !== null && user.email.toLowerCase() === invitation.email.toLowerCase();
    if (!isRecipient && !canManageEvent(actor as never, team.event_id)) {
      throw errors.forbidden('Only the invited person or an organizer can decline this invitation.');
    }

    this.db.exec("UPDATE team_invitations SET status = 'REJECTED', responded_at = :at, updated_at = :at WHERE id = :id", {
      at: ctx.at,
      id: invitation.id,
    });
    this.audit.record({
      action: 'team.invitation_rejected',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: team.event_id,
      resourceType: 'teamInvitation',
      resourceId: invitation.id,
      requestId: ctx.requestId,
      at: ctx.at,
    });
  }

  removeMember(teamId: string, userId: string, ctx: ActorContext): void {
    const team = this.require(teamId);
    const actor = requireActor(ctx);
    this.assertMutable(team, actor, ctx);

    const member = this.member(teamId, userId);
    if (member === null) throw errors.notFound('Team member', userId);

    const isSelf = actor.id === userId;
    if (!isSelf) this.assertCaptain(team, actor, ctx);
    if (member.role === 'CAPTAIN') {
      throw errors.conflict('A captain cannot be removed. Promote another member or transfer the role first.');
    }

    this.db.transaction(() => {
      this.db.exec('DELETE FROM team_members WHERE id = :id', { id: member.id });
      // A submission owned solely by a departing member would dangle otherwise.
      this.audit.record({
        action: isSelf ? 'team.member_left' : 'team.member_removed',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: team.event_id,
        resourceType: 'team',
        resourceId: teamId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        previousState: 'MEMBER',
        newState: null,
        metadata: { removedUserId: userId, self: isSelf },
        at: ctx.at,
      });
    });
  }

  promote(teamId: string, userId: string, ctx: ActorContext): TeamRow {
    const team = this.require(teamId);
    const actor = requireActor(ctx);
    this.assertMutable(team, actor, ctx);
    this.assertCaptain(team, actor, ctx);

    const member = this.member(teamId, userId);
    if (member === null) throw errors.notFound('Team member', userId);

    this.db.transaction(() => {
      this.db.exec("UPDATE team_members SET role = 'MEMBER', updated_at = :at WHERE team_id = :t AND role = 'CAPTAIN'", {
        at: ctx.at,
        t: teamId,
      });
      this.db.exec("UPDATE team_members SET role = 'CAPTAIN', updated_at = :at WHERE id = :id", { at: ctx.at, id: member.id });
      this.db.exec('UPDATE teams SET captain_id = :user, updated_at = :at WHERE id = :id', { user: userId, at: ctx.at, id: teamId });
      this.audit.record({
        action: 'team.updated',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: team.event_id,
        resourceType: 'team',
        resourceId: teamId,
        requestId: ctx.requestId,
        previousState: team.captain_id,
        newState: userId,
        metadata: { promoted: userId },
        at: ctx.at,
      });
    });
    return this.require(teamId);
  }

  /**
   * Organizer override: the only way to mutate a frozen team, and it always
   * writes an audit record naming the person who authorised it.
   */
  override(teamId: string, action: 'add' | 'remove', userId: string, reason: string, ctx: ActorContext): void {
    const team = this.require(teamId);
    const actor = requireActor(ctx);
    if (!canManageEvent(actor as never, team.event_id)) {
      throw errors.forbidden('Only an organizer of this event can override a team lock.');
    }
    if (reason.trim().length < 8) {
      throw errors.validation('An override requires a written reason of at least 8 characters.', [{ field: 'reason' }]);
    }

    this.db.transaction(() => {
      if (action === 'add') {
        this.addMember(teamId, userId, 'MEMBER', ctx.at);
      } else {
        const member = this.member(teamId, userId);
        if (member === null) throw errors.notFound('Team member', userId);
        if (member.role === 'CAPTAIN') throw errors.conflict('The captain cannot be removed, even by override.');
        this.db.exec('DELETE FROM team_members WHERE id = :id', { id: member.id });
      }
      this.audit.record({
        action: 'team.override',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId: team.event_id,
        resourceType: 'team',
        resourceId: teamId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { override: action, targetUserId: userId, reason: reason.trim() },
        at: ctx.at,
      });
    });
  }

  /* ----------------------------------------------------------- queries */

  findById(id: string): TeamRow | null {
    return this.db.get<TeamRow>('SELECT * FROM teams WHERE id = :id', { id });
  }

  require(id: string): TeamRow {
    const team = this.findById(id);
    if (team === null) throw errors.notFound('Team', id);
    return team;
  }

  findForUser(eventId: string, userId: string): TeamRow | null {
    return this.db.get<TeamRow>(
      `SELECT t.* FROM teams t
       JOIN team_members m ON m.team_id = t.id
       WHERE t.event_id = :e AND m.user_id = :u LIMIT 1`,
      { e: eventId, u: userId },
    );
  }

  members(teamId: string) {
    return this.db.all(
      `SELECT m.*, u.display_name, u.username, u.email, u.avatar_color
       FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = :t ORDER BY CASE m.role WHEN 'CAPTAIN' THEN 0 ELSE 1 END, m.joined_at`,
      { t: teamId },
    );
  }

  member(teamId: string, userId: string): TeamMemberRow | null {
    return this.db.get<TeamMemberRow>('SELECT * FROM team_members WHERE team_id = :t AND user_id = :u', {
      t: teamId,
      u: userId,
    });
  }

  memberCount(teamId: string): number {
    return this.db.value<number>('SELECT COUNT(*) AS c FROM team_members WHERE team_id = :t', { t: teamId }) ?? 0;
  }

  list(eventId: string, filter: { search?: string; limit: number; offset: number }): { rows: TeamRow[]; total: number } {
    const conditions = ['t.event_id = :e'];
    const params: Record<string, string | number> = { e: eventId, limit: filter.limit, offset: filter.offset };
    if (filter.search) {
      conditions.push("(LOWER(t.name) LIKE :search ESCAPE '\\' OR LOWER(t.description) LIKE :search ESCAPE '\\')");
      params.search = `%${filter.search.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    }
    const clause = `WHERE ${conditions.join(' AND ')}`;
    const total = this.db.value<number>(`SELECT COUNT(*) AS c FROM teams t ${clause}`, params) ?? 0;
    const rows = this.db.all<TeamRow>(`SELECT t.* FROM teams t ${clause} ORDER BY t.name LIMIT :limit OFFSET :offset`, params);
    return { rows, total };
  }

  invitations(teamId: string) {
    return this.db.all("SELECT * FROM team_invitations WHERE team_id = :t ORDER BY created_at DESC", { t: teamId });
  }

  invitation(id: string) {
    return this.db.get('SELECT * FROM team_invitations WHERE id = :id', { id });
  }

  findInvitationByCode(code: string) {
    return this.db.get(
      `SELECT i.*, t.name AS team_name, t.event_id, e.slug AS event_slug, e.name AS event_name, e.state AS event_state
       FROM team_invitations i
       JOIN teams t ON t.id = i.team_id
       JOIN events e ON e.id = t.event_id
       WHERE i.code = :code`,
      { code: code.trim().toUpperCase() },
    );
  }

  /* ---------------------------------------------------------- helpers */

  private addMember(teamId: string, userId: string, role: 'CAPTAIN' | 'MEMBER', at: Instant): TeamMemberRow {
    const existing = this.member(teamId, userId);
    if (existing !== null) return existing;
    const id = newId('teamMember');
    this.db.exec(
      `INSERT INTO team_members (id, team_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (:id, :team_id, :user_id, :role, :at, :at, :at)`,
      { id, team_id: teamId, user_id: userId, role, at },
    );
    return this.db.get<TeamMemberRow>('SELECT * FROM team_members WHERE id = :id', { id })!;
  }

  private assertCaptain(team: TeamRow, actor: { id: string; roles: string[]; eventIds: string[] }, _ctx: ActorContext): void {
    if (team.captain_id === actor.id) return;
    if (canManageEvent(actor as never, team.event_id)) return;
    throw errors.forbidden('Only the team captain or an organizer can do that.');
  }

  /**
   * Block mutations once the project set freezes, unless an organizer is
   * explicitly overriding (which they do through `override`, and which is
   * always audited with a written reason).
   */
  private assertMutable(team: TeamRow, actor: { id: string; roles: string[]; eventIds: string[] }, ctx: ActorContext, options: { selfService?: boolean } = {}): void {
    const event = this.events.require(team.event_id);
    if (!this.events.isFrozen(event, ctx.at)) return;
    if (canManageEvent(actor as never, team.event_id)) return;

    const deadline = event.submission_closes_at ?? 'the submission deadline';
    throw errors.deadlinePassed(
      `Teams for "${event.name}" are locked because ${deadline} has passed.` +
        (options.selfService
          ? ' Ask an organizer if you need a change.'
          : ' An organizer can apply an audited override.'),
    );
  }

  private lockTeamIfFull(event: EventRow, teamId: string, at: Instant): void {
    if (this.memberCount(teamId) >= event.max_team_size) {
      this.db.exec('UPDATE teams SET is_locked = 1, updated_at = :at WHERE id = :id', { at, id: teamId });
    }
  }

  private uniqueSlug(eventId: string, base: string, excludeId?: string): string {
    let candidate = base;
    let suffix = 1;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const clash = this.db.get<{ id: string }>('SELECT id FROM teams WHERE event_id = :e AND slug = :s', {
        e: eventId,
        s: candidate,
      });
      if (clash === null || clash.id === excludeId) return candidate;
      suffix += 1;
      candidate = `${base}-${String(suffix)}`;
    }
    throw errors.conflict('Could not derive a unique team slug; please choose a different name.');
  }
}


export { compare };

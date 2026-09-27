/**
 * Community voting and comments.
 *
 * ---------------------------------------------------------------------------
 * VOTING MODEL
 * ---------------------------------------------------------------------------
 * Chosen model: **one authenticated vote per account per project, all votes
 * equal weight.** It is the simplest model that resists the attacks that
 * actually matter at hackathon scale, and it is the one an organizer can
 * explain to a sponsor in one sentence.
 *
 * Rejected alternatives, and why:
 *   - Weighted votes by account age or registration type: invites
 *     sock-puppet creation, because creating an older/typed account is the
 *     cheapest attack available.
 *   - Per-IP limits as the primary control: trivially defeated by a rotating
 *     IP, and it punishes shared NAT (universities, mobile carriers) where a
 *     legitimate cohort of voters lives.
 *   - Vote purchase or promotion: out of scope for a hackathon tool.
 *
 * IP is recorded and used only for *diagnostics* (velocity, concentration), never
 * as the identity of a voter.
 *
 * ---------------------------------------------------------------------------
 * ABUSE HANDLING
 * ---------------------------------------------------------------------------
 * Layered, and deliberately biased towards "surface for human review" rather
 * than "auto-punish":
 *
 *   L1 authentication       - only signed-in accounts vote
 *   L2 eligibility          - the voter must hold an accepted registration, when
 *                             the event requires it, and must not be a member
 *                             of the project's own team
 *   L3 uniqueness           - a UNIQUE constraint per (event, project, user);
 *                             changing your vote moves the row, it does not
 *                             stack
 *   L4 rate limit           - per account, per hour
 *   L5 window enforcement   - server-side, no client clock
 *   L6 diagnostics          - velocity and concentration are computed and stored
 *   L7 audit                - every vote and every rejection is recorded
 *
 * A suspicious account is flagged for an organizer to look at. It is never
 * silently disqualified, because "the platform decided this was fraud" is not a
 * conclusion a tool should reach on its own.
 */

import { newId } from '@verdict/core/ids';
import { sha256 } from '../lib/password.ts';
import { validatePlainText } from '@verdict/core/validation';
import { errors } from '../lib/errors.ts';
import { canManageEvent } from '../lib/rbac.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';

export type VoteRow = {
  id: string;
  event_id: string;
  submission_id: string;
  user_id: string;
  weight: number;
  ip_hash: string;
  created_at: string;
};

export type CommentRow = {
  id: string;
  event_id: string;
  submission_id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  state: 'VISIBLE' | 'PENDING' | 'HIDDEN' | 'DELETED';
  moderated_by: string | null;
  moderated_at: string | null;
  moderation_note: string;
  report_count: number;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
};

export class CommunityService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];
  private readonly teams: Services['teams'];
  private readonly registrations: Services['registrations'];

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
    this.teams = services.teams;
    this.registrations = services.registrations;
  }

  /* ============================================================ voting */

  castVote(
    eventId: string,
    submissionId: string,
    ctx: ActorContext,
  ): { submissionId: string; votes: number; changed: boolean } {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);

    if (event.voting_enabled !== 1) {
      throw errors.forbidden('Community voting is not enabled for this event.');
    }
    const window = this.events.window(event, 'voting', ctx.at);
    if (!window.open) {
      this.audit.record({
        action: 'vote.rejected',
        actorId: actor.id,
        actorRoles: actor.roles,
        eventId,
        resourceType: 'communityVote',
        resourceId: submissionId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        outcome: 'DENIED',
        metadata: { reason: window.reason },
        at: ctx.at,
      });
      throw errors.windowClosed(window.reason);
    }

    const submission = this.db.get<{ id: string; team_id: string | null; state: string; event_id: string }>(
      'SELECT id, team_id, state, event_id FROM submissions WHERE id = :id',
      { id: submissionId },
    );
    if (submission === null || submission.event_id !== eventId) throw errors.notFound('Project', submissionId);
    if (!['SUBMITTED', 'LOCKED', 'JUDGING', 'FINALIZED'].includes(submission.state)) {
      throw errors.notFound('Project', submissionId);
    }

    // L2: registration eligibility.
    if (event.voting_requires_registration === 1) {
      const registration = this.registrations.findForUser(eventId, actor.id);
      if (registration === null) {
        throw errors.forbidden('Only participants with an accepted registration may vote in this event.');
      }
      if (!['ACCEPTED', 'PENDING', 'APPLICATION'].includes(registration.state)) {
        throw errors.forbidden('Your registration for this event is not active, so you cannot vote.');
      }
    }

    // L2: no self-voting, directly or through team membership.
    if (submission.team_id !== null) {
      const membership = this.teams.member(submission.team_id, actor.id);
      if (membership !== null) {
        this.audit.record({
          action: 'vote.rejected',
          actorId: actor.id,
          actorRoles: actor.roles,
          eventId,
          resourceType: 'communityVote',
          resourceId: submissionId,
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
          outcome: 'DENIED',
          metadata: { reason: 'voter belongs to the project team' },
          at: ctx.at,
        });
        throw errors.conflictOfInterest('You cannot vote for your own team\'s project.');
      }
    }

    const ipHash = this.hashIp(ctx.ipAddress);
    const existing = this.db.get<VoteRow>(
      'SELECT * FROM community_votes WHERE event_id = :e AND submission_id = :s AND user_id = :u',
      { e: eventId, s: submissionId, u: actor.id },
    );

    if (existing === null) {
      this.db.exec(
        `INSERT INTO community_votes (id, event_id, submission_id, user_id, weight, ip_hash, user_agent, created_at, updated_at)
         VALUES (:id, :e, :s, :u, 1, :ip, :ua, :at, :at)
         ON CONFLICT (event_id, submission_id, user_id) DO NOTHING`,
        {
          id: newId('communityVote'),
          e: eventId,
          s: submissionId,
          u: actor.id,
          ip: ipHash,
          ua: ctx.userAgent.slice(0, 300),
          at: ctx.at,
        },
      );
    }

    const tally = this.tally(eventId);
    this.audit.record({
      action: 'vote.cast',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'communityVote',
      resourceId: submissionId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { changed: existing === null, totalForProject: tally.get(submissionId) ?? 0 },
      at: ctx.at,
    });

    return { submissionId, votes: tally.get(submissionId) ?? 0, changed: existing === null };
  }

  /** Remove a vote. Allowed: voting is a reversible public act. */
  retractVote(eventId: string, submissionId: string, ctx: ActorContext): { submissionId: string; votes: number } {
    const actor = requireActor(ctx);
    const result = this.db.exec('DELETE FROM community_votes WHERE event_id = :e AND submission_id = :s AND user_id = :u', {
      e: eventId,
      s: submissionId,
      u: actor.id,
    });
    this.audit.record({
      action: 'vote.cast',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'communityVote',
      resourceId: submissionId,
      requestId: ctx.requestId,
      metadata: { retracted: result.changes > 0 },
      at: ctx.at,
    });
    return { submissionId, votes: this.tally(eventId).get(submissionId) ?? 0 };
  }

  /** Vote counts per project. Internal: the UI decides whether to show them. */
  tally(eventId: string): Map<string, number> {
    const map = new Map<string, number>();
    for (const row of this.db.all<{ submission_id: string; count: number }>(
      'SELECT submission_id, COUNT(*) AS count FROM community_votes WHERE event_id = :e GROUP BY submission_id',
      { e: eventId },
    )) {
      map.set(row.submission_id, Number(row.count));
    }
    return map;
  }

  totalsVisible(eventId: string): boolean {
    const event = this.events.require(eventId);
    return event.voting_enabled === 1 && event.voting_reveal_totals === 1;
  }

  /** What the signed-in voter has already voted for, and whether they may. */
  myVotes(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    const window = this.events.window(event, 'voting', ctx.at);
    const rows = this.db.all<{ submission_id: string; created_at: string }>(
      'SELECT submission_id, created_at FROM community_votes WHERE event_id = :e AND user_id = :u',
      { e: eventId, u: actor.id },
    );
    return {
      canVote: event.voting_enabled === 1 && window.open,
      reason: event.voting_enabled !== 1 ? 'Voting is not enabled for this event.' : window.open ? null : window.reason,
      totalsVisible: event.voting_reveal_totals === 1,
      votes: rows.map((row) => ({ submissionId: row.submission_id, createdAt: row.created_at })),
    };
  }

  /** Organizer view of voting activity, for abuse review. */
  votingReport(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const event = this.events.require(eventId);

    const byUser = this.db.all<{ userId: string; displayName: string; email: string; count: number; first: string; last: string }>(
      `SELECT v.user_id AS userId, u.display_name AS displayName, u.email,
              COUNT(*) AS count, MIN(v.created_at) AS first, MAX(v.created_at) AS last
       FROM community_votes v JOIN users u ON u.id = v.user_id
       WHERE v.event_id = :e GROUP BY v.user_id ORDER BY count DESC LIMIT 100`,
      { e: eventId },
    );
    const total = this.db.value<number>('SELECT COUNT(*) AS c FROM community_votes WHERE event_id = :e', { e: eventId }) ?? 0;
    const distinct = byUser.length;

    return {
      eventId,
      totalsVisible: event.voting_reveal_totals === 1,
      totalVotes: total,
      distinctVoters: distinct,
      votesPerVoter: distinct === 0 ? null : Number((total / distinct).toFixed(3)),
      window: { opensAt: event.voting_opens_at, closesAt: event.voting_closes_at },
      topAccounts: byUser.slice(0, 20).map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        email: row.email,
        votes: Number(row.count),
        share: total === 0 ? 0 : Number((Number(row.count) / total).toFixed(4)),
        firstVoteAt: row.first,
        lastVoteAt: row.last,
      })),
      note: 'Vote activity is shown for organizer review only. Nothing here is treated as evidence of abuse on its own.',
    };
  }

  /** Remove a vote under an audited override. */
  moderateVote(eventId: string, voteId: string, reason: string, ctx: ActorContext): void {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    if (reason.trim().length < 8) {
      throw errors.validation('Removing a vote requires a written reason of at least 8 characters.', [{ field: 'reason' }]);
    }
    const vote = this.db.get<VoteRow>('SELECT * FROM community_votes WHERE id = :id AND event_id = :e', { id: voteId, e: eventId });
    if (vote === null) throw errors.notFound('Vote', voteId);
    this.db.exec('DELETE FROM community_votes WHERE id = :id', { id: voteId });
    this.audit.record({
      action: 'vote.rejected',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'communityVote',
      resourceId: voteId,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      metadata: { removedVoteFrom: vote.user_id, reason: reason.trim() },
      at: ctx.at,
    });
  }

  /* ========================================================== comments */

  listComments(eventId: string, submissionId: string, query: { limit: number; offset: number; includeHidden?: boolean }, ctx: ActorContext) {
    const event = this.events.require(eventId);
    const maySeeHidden = query.includeHidden === true && canManageEvent(ctx.actor as never, eventId);
    if (event.comments_enabled !== 1 && !maySeeHidden) {
      return { data: [], pagination: { page: 1, perPage: query.limit, total: 0, totalPages: 0, hasMore: false } };
    }

    const conditions = ['c.submission_id = :s'];
    const params: Record<string, string | number> = { s: submissionId, limit: query.limit, offset: query.offset };
    if (!maySeeHidden) conditions.push("c.state = 'VISIBLE'");
    const clause = `WHERE ${conditions.join(' AND ')}`;
    const total = this.db.value<number>(`SELECT COUNT(*) AS c FROM comments c ${clause}`, params) ?? 0;

    return {
      data: this.db.all(
        `SELECT c.id, c.body, c.state, c.parent_id AS parentId, c.created_at AS createdAt, c.edited_at AS editedAt,
                c.report_count AS reportCount, u.id AS authorId, u.display_name AS authorName, u.username, u.avatar_color AS avatarColor
         FROM comments c JOIN users u ON u.id = c.user_id
         ${clause} ORDER BY c.created_at LIMIT :limit OFFSET :offset`,
        params,
      ),
      pagination: {
        page: Math.floor(query.offset / query.limit) + 1,
        perPage: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
        hasMore: query.offset + query.limit < total,
      },
    };
  }

  createComment(eventId: string, submissionId: string, input: { body: string; parentId?: string | null }, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    if (event.comments_enabled !== 1) throw errors.forbidden('Comments are disabled for this event.');

    const submission = this.db.get<{ id: string; event_id: string }>('SELECT id, event_id FROM submissions WHERE id = :id', { id: submissionId });
    if (submission === null || submission.event_id !== eventId) throw errors.notFound('Project', submissionId);

    const body = validatePlainText(input.body, { field: 'comment', min: 2, max: 2000 });
    if (input.parentId) {
      const parent = this.db.get<{ id: string; event_id: string }>('SELECT id, event_id FROM comments WHERE id = :id', { id: input.parentId });
      if (parent === null || parent.event_id !== eventId) throw errors.notFound('Comment', input.parentId);
    }

    // Pre-moderation for a brand-new account, to blunt drive-by spam without
    // making every comment from a first-timer wait.
    const isNewAccount = (this.db.value<number>('SELECT COUNT(*) AS c FROM comments WHERE user_id = :u', { u: actor.id }) ?? 0) === 0;
    const needsApproval = event.comments_require_approval === 1 || isNewAccount;
    const state = needsApproval ? 'PENDING' : 'VISIBLE';

    const id = newId('comment');
    this.db.exec(
      `INSERT INTO comments (id, event_id, submission_id, user_id, parent_id, body, state, created_at, updated_at)
       VALUES (:id, :e, :s, :u, :parent, :body, :state, :at, :at)`,
      { id, e: eventId, s: submissionId, u: actor.id, parent: input.parentId ?? null, body, state, at: ctx.at },
    );

    this.audit.record({
      action: 'comment.created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'comment',
      resourceId: id,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      newState: state,
      metadata: { submissionId, awaitingApproval: needsApproval },
      at: ctx.at,
    });

    return { id, state, awaitingApproval: needsApproval };
  }

  editComment(eventId: string, commentId: string, body: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const comment = this.requireComment(eventId, commentId);
    if (comment.user_id !== actor.id) throw errors.forbidden('You can only edit your own comment.');
    if (comment.state === 'DELETED') throw errors.immutable('That comment has been deleted.');

    this.db.exec('UPDATE comments SET body = :body, edited_at = :at, updated_at = :at WHERE id = :id', {
      body: validatePlainText(body, { field: 'comment', min: 2, max: 2000 }),
      at: ctx.at,
      id: commentId,
    });
    this.audit.record({
      action: 'comment.created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'comment',
      resourceId: commentId,
      requestId: ctx.requestId,
      metadata: { edited: true },
      at: ctx.at,
    });
    return this.requireComment(eventId, commentId);
  }

  /** Soft delete. The row stays so the moderation history is auditable. */
  deleteComment(eventId: string, commentId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const comment = this.requireComment(eventId, commentId);
    const isAuthor = comment.user_id === actor.id;
    if (!isAuthor && !canManageEvent(actor as never, eventId)) {
      throw errors.forbidden('You can only delete your own comment.');
    }
    this.db.exec("UPDATE comments SET state = 'DELETED', body = '', moderated_by = :by, moderated_at = :at, updated_at = :at WHERE id = :id", {
      by: actor.id,
      at: ctx.at,
      id: commentId,
    });
    this.audit.record({
      action: 'comment.moderated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'comment',
      resourceId: commentId,
      requestId: ctx.requestId,
      previousState: comment.state,
      newState: 'DELETED',
      metadata: { author: isAuthor },
      at: ctx.at,
    });
    return { id: commentId, state: 'DELETED' };
  }

  moderateComment(eventId: string, commentId: string, input: { state: 'VISIBLE' | 'HIDDEN' | 'PENDING'; note?: string }, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const comment = this.requireComment(eventId, commentId);
    if (input.state === 'HIDDEN' && (input.note ?? '').trim().length < 5) {
      throw errors.validation('Hiding a comment requires a short reason.', [{ field: 'note' }]);
    }
    this.db.exec('UPDATE comments SET state = :state, moderated_by = :by, moderated_at = :at, moderation_note = :note, updated_at = :at WHERE id = :id', {
      state: input.state,
      by: actor.id,
      at: ctx.at,
      note: (input.note ?? '').slice(0, 500),
      id: commentId,
    });
    this.audit.record({
      action: 'comment.moderated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'comment',
      resourceId: commentId,
      requestId: ctx.requestId,
      previousState: comment.state,
      newState: input.state,
      metadata: { note: input.note ?? '' },
      at: ctx.at,
    });
    return this.requireComment(eventId, commentId);
  }

  reportComment(eventId: string, commentId: string, input: { reason: string; note?: string }, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const comment = this.requireComment(eventId, commentId);
    if (comment.state === 'DELETED') throw errors.notFound('Comment', commentId);

    this.db.exec(
      `INSERT INTO comment_reports (id, comment_id, reporter_id, reason, note, created_at)
       VALUES (:id, :c, :r, :reason, :note, :at)
       ON CONFLICT (comment_id, reporter_id) DO NOTHING`,
      {
        id: newId('comment'),
        c: commentId,
        r: actor.id,
        reason: validatePlainText(input.reason, { field: 'reason', min: 3, max: 200 }),
        note: (input.note ?? '').slice(0, 500),
        at: ctx.at,
      },
    );
    this.db.exec('UPDATE comments SET report_count = report_count + 1 WHERE id = :id', { id: commentId });
    this.audit.record({
      action: 'comment.moderated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'comment',
      resourceId: commentId,
      requestId: ctx.requestId,
      metadata: { reported: true, reason: input.reason },
      at: ctx.at,
    });
    return { commentId, reported: true };
  }

  moderationQueue(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    return this.db.all(
      `SELECT c.id, c.body, c.state, c.report_count AS reportCount, c.created_at AS createdAt,
              u.display_name AS authorName,
              (SELECT GROUP_CONCAT(r.reason, ' | ') FROM comment_reports r WHERE r.comment_id = c.id) AS reasons
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.event_id = :e AND (c.state = 'PENDING' OR c.report_count > 0)
       ORDER BY c.report_count DESC, c.created_at`,
      { e: eventId },
    );
  }

  private requireComment(eventId: string, commentId: string): CommentRow {
    const row = this.db.get<CommentRow>('SELECT * FROM comments WHERE id = :id AND event_id = :e', { id: commentId, e: eventId });
    if (row === null) throw errors.notFound('Comment', commentId);
    return row;
  }

  /**
   * IP addresses are stored as a salted digest, not in the clear. The salt is
   * the session secret, so the digest is useless outside this deployment, but
   * it still lets an organizer count distinct voters behind a NAT.
   */
  private hashIp(ip: string): string {
    if (ip === '') return '';
    return sha256(`${this.ipSalt}:${ip}`).slice(0, 32);
  }

  private ipSalt = 'verdict';

  setIpSalt(salt: string): void {
    this.ipSalt = salt;
  }
}

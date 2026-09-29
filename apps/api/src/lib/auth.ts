/**
 * Authentication and identity.
 *
 * The backend is authoritative for every one of these decisions. A hidden
 * button in the client is a usability affordance, never a control: `requireUser`
 * and `requirePermission` throw regardless of what the UI did or did not render.
 */

import { newId, newToken } from '@verdict/core/ids';
import { now, addSeconds, toEpochMs, type Instant } from '@verdict/core/time';
import { assessPassword, validateEmail, validatePlainText, validateUsername, ValidationError } from '@verdict/core/validation';
import { ROLES, type Role } from '@verdict/core/types';
import type { Database } from '../db/database.ts';
import { errors } from '../lib/errors.ts';
import { dummyVerify, hashPassword, sha256, verifyPassword } from '../lib/password.ts';
import { SessionStore, type SessionOptions, type SessionRow } from '../lib/session.ts';
import type { Actor, Ownership } from '../lib/rbac.ts';
import { NO_OWNERSHIP } from '../lib/rbac.ts';
import type { AuditLedger } from '../lib/audit.ts';
import type { Logger } from '../lib/logger.ts';

export type UserRow = {
  id: string;
  email: string;
  email_normalized: string;
  username: string;
  username_normalized: string;
  display_name: string;
  password_hash: string;
  bio: string;
  organization: string;
  github_url: string | null;
  portfolio_url: string | null;
  skills: string;
  avatar_color: string;
  state: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  email_verified: number;
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  bio: string;
  organization: string;
  githubUrl: string | null;
  portfolioUrl: string | null;
  skills: string[];
  avatarColor: string;
  state: string;
  roles: Role[];
  createdAt: string;
  lastLoginAt: string | null;
};

export type RequestContext = {
  requestId: string;
  ipAddress: string;
  userAgent: string;
  session: SessionRow | null;
  user: UserRow | null;
  actor: Actor | null;
  at: Instant;
};

const AVATAR_COLORS = ['#5227FF', '#B497CF', '#FF9FFC', '#2F6BFF', '#0E9F6E', '#C2410C', '#7C3AED', '#0F766E'];

export class AuthService {
  readonly sessions: SessionStore;
  private readonly db: Database;
  private readonly audit: AuditLedger;
  private readonly logger: Logger;
  private readonly sessionOptions: SessionOptions;

  constructor(db: Database, audit: AuditLedger, logger: Logger, sessionOptions: SessionOptions) {
    this.db = db;
    this.audit = audit;
    this.logger = logger;
    this.sessionOptions = sessionOptions;
    this.sessions = new SessionStore(db);
  }

  /* ------------------------------------------------------------- users */

  register(
    input: {
      email: string;
      username: string;
      password: string;
      displayName?: string;
      organization?: string;
      roles?: Role[];
      eventId?: string | null;
    },
    ctx: { requestId: string; ipAddress: string; userAgent: string; at?: Instant },
  ): { user: PublicUser; session: { token: string; csrfToken: string } } {
    const at = ctx.at ?? now();
    const email = validateEmail(input.email);
    const username = validateUsername(input.username);
    const displayName = input.displayName ? validatePlainText(input.displayName, { field: 'display name', min: 1, max: 120 }) : username;

    const quality = assessPassword(input.password, { email, username });
    if (!quality.ok) {
      throw errors.validation('That password is not acceptable.', quality.problems.map((issue) => ({ field: 'password', issue })));
    }

    if (this.findByEmail(email) !== null) {
      throw errors.conflict('An account already exists for that email address.', [{ field: 'email', issue: 'already registered' }]);
    }
    if (this.findByUsername(username) !== null) {
      throw errors.conflict('That username is taken.', [{ field: 'username', issue: 'already registered' }]);
    }

    const passwordHash = hashPassword(input.password);
    const id = newId('user');
    const roles = input.roles && input.roles.length > 0 ? input.roles : (['PARTICIPANT'] as Role[]);

    return this.db.transaction(() => {
      this.db.exec(
        `INSERT INTO users (
           id, email, email_normalized, username, username_normalized, display_name,
           password_hash, organization, avatar_color, state, created_at, updated_at
         ) VALUES (
           :id, :email, :email_normalized, :username, :username_normalized, :display_name,
           :password_hash, :organization, :avatar_color, 'ACTIVE', :at, :at
         )`,
        {
          id,
          email,
          email_normalized: email,
          username,
          username_normalized: username,
          display_name: displayName,
          password_hash: passwordHash,
          organization: input.organization?.slice(0, 200) ?? '',
          avatar_color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] as string,
          at,
        },
      );

      for (const role of roles) {
        this.grantRole({ userId: id, role, eventId: input.eventId ?? null, grantedBy: id, at });
      }

      const created = this.sessions.create({
        userId: id,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        options: this.sessionOptions,
        at,
      });
      this.db.exec('UPDATE users SET last_login_at = :at WHERE id = :id', { at, id });

      this.audit.record({
        action: 'auth.register',
        actorId: id,
        actorRoles: roles,
        actorLabel: displayName,
        eventId: input.eventId ?? null,
        resourceType: 'user',
        resourceId: id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        newState: 'ACTIVE',
        at,
      });

      const user = this.requireUser(id);
      return {
        user: this.toPublicUser(user),
        session: { token: created.token, csrfToken: created.csrfToken },
      };
    });
  }

  /**
   * Verify credentials.
   *
   * Failure modes are deliberately indistinguishable from the outside: a wrong
   * password, an unknown address and a suspended account all take comparable
   * time (the unknown-address path runs a real hash against a dummy) and return
   * the same 401 body. The specific reason is written to the audit log, which
   * only organizers can read.
   */
  login(
    input: { email: string; password: string },
    ctx: { requestId: string; ipAddress: string; userAgent: string; at?: Instant },
  ): { user: PublicUser; session: { token: string; csrfToken: string } } {
    const at = ctx.at ?? now();
    const email = input.email.trim().toLowerCase();
    const user = this.findByEmail(email);

    if (user === null) {
      dummyVerify(input.password);
      this.audit.record({
        action: 'auth.login_failed',
        actorId: null,
        actorRoles: [],
        eventId: null,
        resourceType: 'user',
        resourceId: '',
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        outcome: 'FAILED',
        metadata: { email, reason: 'no such account' },
        at,
      });
      throw errors.invalidCredentials();
    }

    if (user.locked_until !== null && toEpochMs(user.locked_until) > toEpochMs(at)) {
      dummyVerify(input.password);
      throw errors.accountLocked('Too many failed sign-in attempts. Try again in a few minutes.');
    }

    const verdict = verifyPassword(input.password, user.password_hash);
    if (!verdict.valid) {
      this.registerFailedLogin(user, at);
      this.audit.record({
        action: 'auth.login_failed',
        actorId: user.id,
        actorRoles: [],
        eventId: null,
        resourceType: 'user',
        resourceId: user.id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        outcome: 'FAILED',
        metadata: { reason: 'password mismatch', attempt: user.failed_login_count + 1 },
        at,
      });
      throw errors.invalidCredentials();
    }

    if (user.state === 'SUSPENDED') throw errors.accountSuspended();
    if (user.state === 'DEACTIVATED') {
      throw errors.forbidden('This account has been deactivated. Contact an administrator.');
    }

    return this.db.transaction(() => {
      if (verdict.needsRehash) {
        // Opportunistic upgrade: the stored hash used weaker parameters.
        this.db.exec('UPDATE users SET password_hash = :hash, updated_at = :at WHERE id = :id', {
          hash: hashPassword(input.password),
          at,
          id: user.id,
        });
        this.logger.info('password hash upgraded', { userId: user.id });
      }
      this.db.exec('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = :at WHERE id = :id', {
        at,
        id: user.id,
      });

      const created = this.sessions.create({
        userId: user.id,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        options: this.sessionOptions,
        at,
      });

      this.audit.record({
        action: 'auth.login',
        actorId: user.id,
        actorRoles: this.rolesFor(user.id),
        eventId: null,
        resourceType: 'session',
        resourceId: created.session.id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        at,
      });

      return {
        user: this.toPublicUser(this.requireUser(user.id)),
        session: { token: created.token, csrfToken: created.csrfToken },
      };
    });
  }

  logout(sessionId: string, ctx: { requestId: string; actor: Actor | null; at?: Instant }): void {
    const at = ctx.at ?? now();
    this.sessions.revoke(sessionId, 'signed out', at);
    this.audit.record({
      action: 'auth.logout',
      actorId: ctx.actor?.id ?? null,
      actorRoles: ctx.actor?.roles ?? [],
      resourceType: 'session',
      resourceId: sessionId,
      requestId: ctx.requestId,
      at,
    });
  }

  changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
    ctx: { requestId: string; ipAddress: string; userAgent: string; at?: Instant; keepCurrentSession?: boolean; currentSessionId?: string },
  ): void {
    const at = ctx.at ?? now();
    const user = this.requireUser(userId);
    const verdict = verifyPassword(input.currentPassword, user.password_hash);
    if (!verdict.valid) {
      this.audit.record({
        action: 'auth.password_changed',
        actorId: userId,
        actorRoles: [],
        resourceType: 'user',
        resourceId: userId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        outcome: 'FAILED',
        metadata: { reason: 'current password incorrect' },
        at,
      });
      throw errors.invalidCredentials('Your current password is not correct.');
    }

    const quality = assessPassword(input.newPassword, { email: user.email, username: user.username });
    if (!quality.ok) {
      throw errors.validation('That password is not acceptable.', quality.problems.map((issue) => ({ field: 'newPassword', issue })));
    }

    this.db.transaction(() => {
      this.db.exec('UPDATE users SET password_hash = :hash, updated_at = :at WHERE id = :id', {
        hash: hashPassword(input.newPassword),
        at,
        id: userId,
      });
      // Changing a password signs out every other device. A stolen session must
      // not survive the legitimate owner changing their credentials.
      // Keep the caller's own session alive so they are not signed out of the
      // page they just used to change their password; revoke every other device.
      const revoked = ctx.keepCurrentSession
        ? this.sessions.revokeAllForUser(userId, 'password changed', at, ctx.currentSessionId ?? null)
        : this.sessions.revokeAllForUser(userId, 'password changed', at);
      this.audit.record({
        action: 'auth.password_changed',
        actorId: userId,
        actorRoles: this.rolesFor(userId),
        resourceType: 'user',
        resourceId: userId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { otherSessionsRevoked: revoked },
        at,
      });
    });
  }

  requestPasswordReset(
    input: { email: string },
    ctx: { requestId: string; ipAddress: string; userAgent: string; at?: Instant },
  ): { token: string | null; userId: string | null } {
    const at = ctx.at ?? now();
    const email = input.email.trim().toLowerCase();
    const user = this.findByEmail(email);

    // Always report success, so this endpoint cannot be used to enumerate which
    // addresses have accounts.
    this.audit.record({
      action: 'auth.password_reset_requested',
      actorId: user?.id ?? null,
      actorRoles: [],
      resourceType: 'user',
      resourceId: user?.id ?? '',
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      at,
    });

    if (user === null || user.state !== 'ACTIVE') return { token: null, userId: null };

    const token = newToken(32);
    const id = newId('passwordReset');
    const expiry = addSeconds(at, 3600);
    this.db.exec(
      `INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, expires_ms, request_ip)
       VALUES (:id, :user_id, :hash, :at, :expires, :expires_ms, :ip)`,
      { id, user_id: user.id, hash: sha256(token), at, expires: expiry, expires_ms: toEpochMs(expiry), ip: ctx.ipAddress },
    );
    return { token, userId: user.id };
  }

  completePasswordReset(
    input: { token: string; newPassword: string },
    ctx: { requestId: string; ipAddress: string; userAgent: string; at?: Instant },
  ): void {
    const at = ctx.at ?? now();
    const row = this.db.get<{ id: string; user_id: string; expires_ms: number; used_at: string | null }>(
      'SELECT id, user_id, expires_ms, used_at FROM password_resets WHERE token_hash = :hash',
      { hash: sha256(input.token) },
    );

    if (row === null || row.used_at !== null || toEpochMs(at) >= row.expires_ms) {
      this.audit.record({
        action: 'auth.password_reset_completed',
        actorId: null,
        actorRoles: [],
        resourceType: 'passwordReset',
        resourceId: row?.id ?? '',
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        outcome: 'FAILED',
        metadata: { reason: 'token invalid, used or expired' },
        at,
      });
      throw errors.badRequest('That reset link is no longer valid. Request a new one.');
    }

    const user = this.requireUser(row.user_id);
    const quality = assessPassword(input.newPassword, { email: user.email, username: user.username });
    if (!quality.ok) {
      throw errors.validation('That password is not acceptable.', quality.problems.map((issue) => ({ field: 'newPassword', issue })));
    }

    this.db.transaction(() => {
      this.db.exec('UPDATE users SET password_hash = :hash, updated_at = :at WHERE id = :id', {
        hash: hashPassword(input.newPassword),
        at,
        id: row.user_id,
      });
      this.db.exec('UPDATE password_resets SET used_at = :at WHERE id = :id', { at, id: row.id });
      this.sessions.revokeAllForUser(row.user_id, 'password reset', at);
      this.audit.record({
        action: 'auth.password_reset_completed',
        actorId: row.user_id,
        actorRoles: this.rolesFor(row.user_id),
        resourceType: 'user',
        resourceId: row.user_id,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        at,
      });
    });
  }

  /* -------------------------------------------------------------- roles */

  grantRole(input: { userId: string; role: Role; eventId: string | null; grantedBy: string; at?: Instant }): void {
    if (!ROLES.includes(input.role)) throw errors.badRequest(`Unknown role "${String(input.role)}"`);
    const at = input.at ?? now();
    // 'scope' mirrors event_id with NULL collapsed to '', because the primary key
    // needs a non-null value while a global role genuinely has no event. The
    // table's CHECK keeps the two from drifting apart.
    this.db.exec(
      `INSERT INTO user_roles (user_id, role, event_id, scope, granted_by, granted_at)
       VALUES (:user_id, :role, :event_id, :scope, :granted_by, :at)
       ON CONFLICT (user_id, role, scope, granted_at) DO NOTHING`,
      {
        user_id: input.userId,
        role: input.role,
        event_id: input.eventId,
        scope: input.eventId ?? '',
        granted_by: input.grantedBy,
        at,
      },
    );
  }

  revokeRole(input: { userId: string; role: Role; eventId: string | null; actor: Actor; at?: Instant }): void {
    const at = input.at ?? now();
    const before = this.rolesFor(input.userId);
    const result = this.db.exec(
      `UPDATE user_roles SET revoked_at = :at
       WHERE user_id = :user_id AND role = :role AND scope = :scope
         AND revoked_at IS NULL`,
      { at, user_id: input.userId, role: input.role, scope: input.eventId ?? '' },
    );
    if (result.changes === 0) {
      throw errors.notFound('Role assignment', `${input.userId}:${input.role}`);
    }
    const after = this.rolesFor(input.userId);
    this.audit.record({
      action: 'user.role_changed',
      actorId: input.actor.id,
      actorRoles: input.actor.roles,
      eventId: input.eventId,
      resourceType: 'user',
      resourceId: input.userId,
      previousState: before.join(','),
      newState: after.join(','),
      metadata: { role: input.role, eventId: input.eventId },
      at,
    });
  }

  /** Global + event-scoped roles, de-duplicated. */
  rolesFor(userId: string, eventId?: string | null): Role[] {
    const rows =
      eventId === undefined
        ? this.db.all<{ role: Role }>('SELECT DISTINCT role FROM user_roles WHERE user_id = :id AND revoked_at IS NULL', { id: userId })
        : this.db.all<{ role: Role }>(
            `SELECT DISTINCT role FROM user_roles
             WHERE user_id = :id AND revoked_at IS NULL AND (event_id IS NULL OR event_id = :event_id)`,
            { id: userId, event_id: eventId },
          );
    return rows.map((row) => row.role).sort();
  }

  eventIdsFor(userId: string, role: Role): string[] {
    return this.db
      .all<{ event_id: string }>(
        'SELECT DISTINCT event_id FROM user_roles WHERE user_id = :id AND role = :role AND revoked_at IS NULL AND event_id IS NOT NULL',
        { id: userId, role },
      )
      .map((row) => row.event_id);
  }

  setUserState(userId: string, state: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED', actor: Actor, at: Instant = now()): void {
    const before = this.requireUser(userId);
    if (before.state === state) return;
    this.db.transaction(() => {
      this.db.exec('UPDATE users SET state = :state, updated_at = :at WHERE id = :id', { state, at, id: userId });
      if (state !== 'ACTIVE') this.sessions.revokeAllForUser(userId, `account ${state.toLowerCase()}`, at);
      this.audit.record({
        action: state === 'ACTIVE' ? 'user.activated' : 'user.deactivated',
        actorId: actor.id,
        actorRoles: actor.roles,
        resourceType: 'user',
        resourceId: userId,
        previousState: before.state,
        newState: state,
        at,
      });
    });
  }

  updateProfile(
    userId: string,
    patch: {
      displayName?: string;
      bio?: string;
      organization?: string;
      githubUrl?: string | null;
      portfolioUrl?: string | null;
      skills?: string[];
      avatarColor?: string;
    },
    at: Instant = now(),
  ): PublicUser {
    const fields: Record<string, string | null> = { updated_at: at };
    if (patch.displayName !== undefined) fields.display_name = validatePlainText(patch.displayName, { field: 'display name', min: 1, max: 120 });
    if (patch.bio !== undefined) fields.bio = validatePlainText(patch.bio, { field: 'bio', max: 2000 });
    if (patch.organization !== undefined) fields.organization = validatePlainText(patch.organization, { field: 'organization', max: 200 });
    if (patch.githubUrl !== undefined) fields.github_url = patch.githubUrl;
    if (patch.portfolioUrl !== undefined) fields.portfolio_url = patch.portfolioUrl;
    if (patch.skills !== undefined) fields.skills = JSON.stringify(patch.skills.slice(0, 40).map((s) => validatePlainText(s, { field: 'skill', max: 60 })));
    if (patch.avatarColor !== undefined) fields.avatar_color = patch.avatarColor;

    const assignments = Object.keys(fields).map((key) => `"${key}" = :${key}`);
    this.db.exec(`UPDATE users SET ${assignments.join(', ')} WHERE id = :id`, { ...fields, id: userId });
    return this.toPublicUser(this.requireUser(userId));
  }

  /* ---------------------------------------------------------- lookups */

  findById(id: string): UserRow | null {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = :id', { id });
  }

  requireUser(id: string): UserRow {
    const user = this.findById(id);
    if (user === null) throw errors.notFound('User', id);
    return user;
  }

  findByEmail(email: string): UserRow | null {
    return this.db.get<UserRow>('SELECT * FROM users WHERE email_normalized = :email', { email: email.trim().toLowerCase() });
  }

  findByUsername(username: string): UserRow | null {
    return this.db.get<UserRow>('SELECT * FROM users WHERE username_normalized = :username', {
      username: username.trim().toLowerCase(),
    });
  }

  findByEmailOrUsername(identifier: string): UserRow | null {
    const value = identifier.trim().toLowerCase();
    return (
      this.db.get<UserRow>('SELECT * FROM users WHERE email_normalized = :value', { value }) ??
      this.db.get<UserRow>('SELECT * FROM users WHERE username_normalized = :value', { value })
    );
  }

  search(query: string, limit: number, offset: number): { rows: UserRow[]; total: number } {
    const like = `%${query.trim().toLowerCase().replace(/[%_]/g, '')}%`;
    const total = this.db.value<number>(
      `SELECT COUNT(*) AS c FROM users
       WHERE (LOWER(display_name) LIKE :like OR email_normalized LIKE :like OR username_normalized LIKE :like
              OR LOWER(organization) LIKE :like)`,
      { like },
    ) ?? 0;
    const rows = this.db.all<UserRow>(
      `SELECT * FROM users
       WHERE (LOWER(display_name) LIKE :like OR email_normalized LIKE :like OR username_normalized LIKE :like
              OR LOWER(organization) LIKE :like)
       ORDER BY display_name LIMIT :limit OFFSET :offset`,
      { like, limit, offset },
    );
    return { rows, total };
  }

  /* ------------------------------------------------------------- actor */

  buildActor(user: UserRow | null): Actor | null {
    if (user === null) return null;
    const roles = this.rolesFor(user.id);
    const eventIds = new Set<string>();
    /*
     * Bound per role, not unioned. The union was the bug: it made
     * `canManageEvent` answer yes to a person who organized one event and only
     * judged another, because the flat list contained both. See the note on
     * `Actor.roleEventIds`.
     */
    const roleEventIds = {} as Record<Role, string[]>;
    for (const role of roles) {
      const ids = this.eventIdsFor(user.id, role);
      roleEventIds[role] = ids;
      for (const id of ids) eventIds.add(id);
    }
    for (const role of ROLES) {
      if (roleEventIds[role] === undefined) roleEventIds[role] = [];
    }
    return { id: user.id, roles, roleEventIds, eventIds: [...eventIds], state: user.state };
  }

  toPublicUser(user: UserRow): PublicUser {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.display_name,
      bio: user.bio,
      organization: user.organization,
      githubUrl: user.github_url,
      portfolioUrl: user.portfolio_url,
      skills: safeParseArray(user.skills),
      avatarColor: user.avatar_color,
      state: user.state,
      roles: this.rolesFor(user.id),
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
    };
  }

  private registerFailedLogin(user: UserRow, at: Instant): void {
    const attempts = user.failed_login_count + 1;
    // Lock after 8 consecutive failures for 15 minutes. Enough to blunt online
    // guessing, short enough that a legitimate user is not locked out of their
    // own event by a typo storm.
    const lock = attempts >= 8 ? addSeconds(at, 900) : null;
    this.db.exec('UPDATE users SET failed_login_count = :attempts, locked_until = :lock WHERE id = :id', {
      attempts,
      lock,
      id: user.id,
    });
    if (lock !== null) {
      this.logger.warn('account locked after repeated failures', { userId: user.id, attempts });
    }
  }
}

export function safeParseArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function ownershipFor(userId: string | null, extra: Partial<Ownership> = {}): Ownership {
  return { ...NO_OWNERSHIP, ownerId: userId, ...extra };
}

export { ValidationError };

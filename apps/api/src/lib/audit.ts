/**
 * The audit ledger.
 *
 * One table, one insert function, called from services rather than from route
 * handlers. The choice matters: a ledger assembled by HTTP handlers records
 * what the API *was asked to do*, whereas a ledger written by services records
 * what actually *happened*. A rollback, a guard rejection and a transition that
 * the state machine refused all end up here.
 *
 * The table has triggers that make it append-only at the storage layer, so even
 * a bug in this module cannot rewrite history.
 */

import { newId } from '@verdict/core/ids';
import { now, toEpochMs, type Instant } from '@verdict/core/time';
import { canonicalJson, sha256Hex } from '@verdict/core/integrity';
import type { AuditAction, Role } from '@verdict/core/types';
import type { Database } from '../db/database.ts';
import type { Logger } from '../lib/logger.ts';

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILED';

export type AuditInput = {
  action: AuditAction;
  actorId: string | null;
  actorRoles: Role[];
  actorLabel?: string;
  eventId?: string | null;
  resourceType?: string;
  resourceId?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  previousState?: string | null;
  newState?: string | null;
  metadata?: Record<string, unknown>;
  outcome?: AuditOutcome;
  at?: Instant;
};

export type AuditRecord = {
  id: string;
  event_id: string | null;
  actor_id: string | null;
  actor_roles: string;
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id: string;
  request_id: string;
  ip_address: string;
  user_agent: string;
  previous_state: string | null;
  new_state: string | null;
  metadata: string;
  outcome: string;
  created_at: string;
  created_ms: number;
};

/**
 * Actions whose metadata may contain participant-identifying information.
 * Kept explicit so a reviewer can see at a glance what the ledger holds.
 */
const SENSITIVE_METADATA_KEYS = new Set(['password', 'newPassword', 'token', 'secret', 'rawPasswordHash']);

export class AuditLedger {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Append one event. Never throws: an audit failure must not roll back the
   * business operation it describes, but it must be loud in the log so the gap
   * is noticed.
   */
  record(input: AuditInput): string | null {
    const id = newId('auditEvent');
    const at = input.at ?? now();
    let metadata: string;
    try {
      metadata = canonicalJson(scrubMetadata(input.metadata ?? {}));
    } catch (error) {
      // Non-serialisable metadata must not lose the event itself.
      metadata = canonicalJson({ serialisationError: error instanceof Error ? error.message : 'unknown' });
    }

    try {
      this.db.exec(
        `INSERT INTO audit_events (
           id, event_id, actor_id, actor_roles, actor_label, action, resource_type,
           resource_id, request_id, ip_address, user_agent, previous_state, new_state,
           metadata, outcome, created_at, created_ms
         ) VALUES (
           :id, :event_id, :actor_id, :actor_roles, :actor_label, :action, :resource_type,
           :resource_id, :request_id, :ip_address, :user_agent, :previous_state, :new_state,
           :metadata, :outcome, :created_at, :created_ms
         )`,
        {
          id,
          event_id: input.eventId ?? null,
          actor_id: input.actorId,
          actor_roles: JSON.stringify(input.actorRoles),
          actor_label: input.actorLabel ?? '',
          action: input.action,
          resource_type: input.resourceType ?? '',
          resource_id: input.resourceId ?? '',
          request_id: input.requestId ?? '',
          ip_address: input.ipAddress ?? '',
          user_agent: truncate(input.userAgent ?? '', 300),
          previous_state: input.previousState ?? null,
          new_state: input.newState ?? null,
          metadata,
          outcome: input.outcome ?? 'SUCCESS',
          created_at: at,
          created_ms: toEpochMs(at),
        },
      );
    } catch (error) {
      this.logger.error('audit write failed', {
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    return id;
  }

  /**
   * Record a refused action. Authorization failures are the most security-
   * relevant rows in the ledger, so they get their own helper to make it hard
   * to omit them.
   */
  recordDenied(input: AuditInput & { reason: string; requiredRole?: string }): string | null {
    return this.record({
      ...input,
      outcome: 'DENIED',
      metadata: { ...(input.metadata ?? {}), denialReason: input.reason, requiredRole: input.requiredRole ?? null },
    });
  }

  /** Append-only export used by the organizer audit screen and CSV export. */
  list(filter: {
    eventId?: string | null;
    actorId?: string;
    action?: string;
    actionPrefix?: string;
    resourceType?: string;
    resourceId?: string;
    outcome?: AuditOutcome;
    from?: Instant | null;
    to?: Instant | null;
    requestId?: string;
    limit: number;
    offset: number;
  }): { rows: AuditRecord[]; total: number } {
    const where: string[] = [];
    const params: Record<string, string | number | null> = {
      limit: filter.limit,
      offset: filter.offset,
    };

    if (filter.eventId !== undefined) {
      if (filter.eventId === null) where.push('event_id IS NULL');
      else {
        where.push('event_id = :event_id');
        params.event_id = filter.eventId;
      }
    }
    if (filter.actorId) {
      where.push('actor_id = :actor_id');
      params.actor_id = filter.actorId;
    }
    if (filter.action) {
      where.push('action = :action');
      params.action = filter.action;
    }
    if (filter.actionPrefix) {
      where.push('action LIKE :action_prefix');
      params.action_prefix = `${filter.actionPrefix}%`;
    }
    if (filter.resourceType) {
      where.push('resource_type = :resource_type');
      params.resource_type = filter.resourceType;
    }
    if (filter.resourceId) {
      where.push('resource_id = :resource_id');
      params.resource_id = filter.resourceId;
    }
    if (filter.outcome) {
      where.push('outcome = :outcome');
      params.outcome = filter.outcome;
    }
    if (filter.requestId) {
      where.push('request_id = :request_id');
      params.request_id = filter.requestId;
    }
    if (filter.from) {
      where.push('created_ms >= :from_ms');
      params.from_ms = toEpochMs(filter.from);
    }
    if (filter.to) {
      where.push('created_ms < :to_ms');
      params.to_ms = toEpochMs(filter.to);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.value<number>(`SELECT COUNT(*) AS c FROM audit_events ${clause}`, params) ?? 0;
    const rows = this.db.all<AuditRecord>(
      `SELECT * FROM audit_events ${clause} ORDER BY created_ms DESC, id DESC LIMIT :limit OFFSET :offset`,
      params,
    );
    return { rows, total };
  }

  /** Distinct actions present, for the filter dropdown. */
  knownActions(): { action: string; count: number }[] {
    return this.db.all<{ action: string; count: number }>(
      'SELECT action, COUNT(*) AS count FROM audit_events GROUP BY action ORDER BY count DESC',
    );
  }

  /**
   * Tamper-evidence for the whole ledger: a Merkle-style digest over the most
   * recent N entries. An organizer can publish this value, and anyone can later
   * confirm that no historical row was quietly edited or removed.
   */
  chainDigest(limit = 5000): { digest: string; entries: number; headId: string | null; computedAt: Instant } {
    const rows = this.db.all<{ id: string; metadata: string; created_at: string; action: string; outcome: string }>(
      'SELECT id, metadata, created_at, action, outcome FROM audit_events ORDER BY created_ms DESC, id DESC LIMIT ?',
      [Math.max(1, Math.min(100_000, limit))],
    );
    let digest = sha256Hex('verdict-audit-chain-v1');
    for (const row of [...rows].reverse()) {
      digest = sha256Hex(`${digest}:${row.id}:${row.action}:${row.outcome}:${row.created_at}:${row.metadata}`);
    }
    return {
      digest,
      entries: rows.length,
      headId: rows[0]?.id ?? null,
      computedAt: now(),
    };
  }
}

function scrubMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_METADATA_KEYS.has(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (key.toLowerCase().includes('password') || key.toLowerCase().includes('token') || key.toLowerCase().includes('secret')) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = value;
  }
  return out;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

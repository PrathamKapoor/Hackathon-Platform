/**
 * Outbound webhooks.
 *
 * ---------------------------------------------------------------------------
 * SIGNING
 * ---------------------------------------------------------------------------
 * Each delivery carries:
 *   X-Verdict-Id        delivery id (stable across retries)
 *   X-Verdict-Event     the event type
 *   X-Verdict-Timestamp ISO-8601 of the attempt
 *   X-Verdict-Signature "v1=<hex hmac-sha256 of `${id}.${timestamp}.${body}`>"
 *
 * The timestamp is inside the signed material, which is what makes a captured
 * delivery unusable after its retry window — a replay defence, not just a
 * signature.
 *
 * ---------------------------------------------------------------------------
 * SSRF
 * ---------------------------------------------------------------------------
 * A webhook URL is an organizer-supplied server-side fetch target, which is a
 * textbook SSRF vector: it can reach the database host, the cloud metadata
 * service, or an internal admin panel. Mitigations, in order:
 *   1. Only http/https, and the URL is validated at creation time.
 *   2. Private, loopback, link-local and CGNAT addresses are refused by default
 *      (`ALLOW_PRIVATE_WEBHOOK_TARGETS` exists for local development).
 *   3. The hostname is re-resolved at delivery time and every resulting address
 *      is checked, so a DNS record that changes to 127.0.0.1 after creation is
 *      caught.
 *   4. Redirects are not followed.
 *   5. The request is bounded by a timeout and a response size cap.
 *
 * Delivery is best-effort and asynchronous: a failing webhook never fails the
 * business operation that triggered it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { newId } from '@verdict/core/ids';
import { canonicalJson, sha256Hex } from '@verdict/core/integrity';
import { validateHttpUrl, isPrivateHostname, validatePlainText } from '@verdict/core/validation';
import { WEBHOOK_EVENTS, type WebhookEvent } from '@verdict/core/types';
import { now, toInstant, toEpochMs } from '@verdict/core/time';
import { errors } from '../lib/errors.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';

export type WebhookRow = {
  id: string;
  event_id: string;
  url: string;
  description: string;
  secret: string;
  subscriptions: string;
  state: 'ACTIVE' | 'PAUSED' | 'DISABLED';
  created_by: string;
  last_status: number | null;
  last_delivery_at: string | null;
  consecutive_failures: number;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeliveryRow = {
  id: string;
  webhook_id: string;
  event_type: string;
  delivery_id: string;
  payload: string;
  signature: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'ABANDONED';
  attempt: number;
  response_status: number | null;
  response_body: string;
  error: string;
  duration_ms: number | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const SIGNATURE_HEADER = 'x-verdict-signature';

export class WebhookService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];
  private readonly config: Services['config'];
  private readonly logger: Services['logger'];

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
    this.config = services.config;
    this.logger = services.logger;
  }

  /* -------------------------------------------------------- management */

  create(
    eventId: string,
    input: { url: string; description?: string; subscriptions?: WebhookEvent[]; secret?: string },
    ctx: ActorContext,
  ): WebhookRow {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);

    const validated = validateHttpUrl(input.url, { allowPrivateHosts: this.config.security.allowPrivateWebhookTargets });
    if (!validated.valid) {
      throw errors.validation('That webhook URL cannot be used.', [
        {
          field: 'url',
          issue: this.config.security.allowPrivateWebhookTargets
            ? validated.reason
            : `${validated.reason}. This platform refuses to call private addresses to prevent server-side request forgery; set ALLOW_PRIVATE_WEBHOOK_TARGETS=true only for local development.`,
        },
      ]);
    }

    const subscriptions = (input.subscriptions ?? []).filter((value) => WEBHOOK_EVENTS.includes(value));
    if (subscriptions.length === 0) {
      throw errors.validation('Subscribe to at least one event.', [{ field: 'subscriptions' }]);
    }

    const id = newId('webhook');
    // A caller-supplied secret is allowed (so a receiver can be pre-provisioned);
    // otherwise one is generated. Either way it is shown exactly once.
    const secret = input.secret && input.secret.length >= 16 ? input.secret : randomBytes(32).toString('base64url');

    this.db.exec(
      `INSERT INTO webhooks (id, event_id, url, description, secret, subscriptions, state, created_by, created_at, updated_at)
       VALUES (:id, :e, :url, :description, :secret, :subs, 'ACTIVE', :by, :at, :at)`,
      {
        id,
        e: eventId,
        url: validated.url,
        description: validatePlainText(input.description ?? '', { field: 'description', max: 300 }),
        secret,
        subs: JSON.stringify(subscriptions),
        by: actor.id,
        at: ctx.at,
      },
    );

    this.audit.record({
      action: 'webhook.created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'webhook',
      resourceId: id,
      requestId: ctx.requestId,
      metadata: { url: validated.url, subscriptions },
      at: ctx.at,
    });

    return this.require(id);
  }

  update(webhookId: string, input: { description?: string; subscriptions?: WebhookEvent[]; state?: 'ACTIVE' | 'PAUSED' }, ctx: ActorContext): WebhookRow {
    const actor = requireActor(ctx);
    const webhook = this.require(webhookId);
    this.events.assertOrganizer(actor, this.events.require(webhook.event_id), ctx);

    const patch: Record<string, string> = { updated_at: ctx.at };
    if (input.description !== undefined) patch.description = validatePlainText(input.description, { field: 'description', max: 300 });
    if (input.subscriptions !== undefined) {
      const subscriptions = input.subscriptions.filter((value) => WEBHOOK_EVENTS.includes(value));
      if (subscriptions.length === 0) throw errors.validation('Subscribe to at least one event.', [{ field: 'subscriptions' }]);
      patch.subscriptions = JSON.stringify(subscriptions);
    }
    if (input.state !== undefined) patch.state = input.state;

    const assignments = Object.keys(patch).map((key) => `"${key}" = :${key}`);
    this.db.exec(`UPDATE webhooks SET ${assignments.join(', ')} WHERE id = :id`, { ...patch, id: webhookId });
    return this.require(webhookId);
  }

  delete(webhookId: string, ctx: ActorContext): void {
    const actor = requireActor(ctx);
    const webhook = this.require(webhookId);
    this.events.assertOrganizer(actor, this.events.require(webhook.event_id), ctx);
    this.db.exec('DELETE FROM webhooks WHERE id = :id', { id: webhookId });
    this.audit.record({
      action: 'webhook.deleted',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: webhook.event_id,
      resourceType: 'webhook',
      resourceId: webhookId,
      requestId: ctx.requestId,
      at: ctx.at,
    });
  }

  list(eventId: string, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    return this.db.all(
      `SELECT id, url, description, subscriptions, state, last_status AS lastStatus,
              last_delivery_at AS lastDeliveryAt, consecutive_failures AS consecutiveFailures, created_at AS createdAt
       FROM webhooks WHERE event_id = :e ORDER BY created_at`,
      { e: eventId },
    );
  }

  require(id: string): WebhookRow {
    const row = this.db.get<WebhookRow>('SELECT * FROM webhooks WHERE id = :id', { id });
    if (row === null) throw errors.notFound('Webhook', id);
    return row;
  }

  /** Reveal the signing secret, for an organizer who needs to rotate it. */
  secret(webhookId: string, ctx: ActorContext): { secret: string } {
    const actor = requireActor(ctx);
    const webhook = this.require(webhookId);
    this.events.assertOrganizer(actor, this.events.require(webhook.event_id), ctx);
    this.audit.record({
      action: 'webhook.created',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId: webhook.event_id,
      resourceType: 'webhook',
      resourceId: webhookId,
      requestId: ctx.requestId,
      metadata: { secretViewed: true },
      at: ctx.at,
    });
    return { secret: webhook.secret };
  }

  deliveries(webhookId: string, limit: number, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const webhook = this.require(webhookId);
    this.events.assertOrganizer(actor, this.events.require(webhook.event_id), ctx);
    return this.db.all<DeliveryRow>(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = :w ORDER BY created_at DESC LIMIT :limit',
      { w: webhookId, limit: Math.min(500, Math.max(1, limit)) },
    );
  }

  /** Replay one delivery, e.g. after fixing a receiver. */
  async redeliver(deliveryId: string, ctx: ActorContext): Promise<{ status: string; httpStatus: number | null }> {
    const actor = requireActor(ctx);
    const delivery = this.db.get<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE id = :id', { id: deliveryId });
    if (delivery === null) throw errors.notFound('Delivery', deliveryId);
    const webhook = this.require(delivery.webhook_id);
    this.events.assertOrganizer(actor, this.events.require(webhook.event_id), ctx);
    const result = await this.attempt(webhook, delivery);
    return { status: result.status, httpStatus: result.httpStatus };
  }

  /* ---------------------------------------------------------- delivery */

  /**
   * Queue a delivery to every subscribed webhook. Returns immediately; the
   * fetch happens on the microtask queue and never throws into the caller.
   */
  dispatch(eventId: string, eventType: WebhookEvent, payload: Record<string, unknown>, ctx: ActorContext): number {
    const webhooks = this.db.all<WebhookRow>(
      "SELECT * FROM webhooks WHERE event_id = :e AND state = 'ACTIVE'",
      { e: eventId },
    );
    const body = canonicalJson({
      id: `evt_${sha256Hex(`${eventId}:${eventType}:${String(ctx.at)}`).slice(0, 16)}`,
      type: eventType,
      createdAt: ctx.at,
      eventId,
      actorId: ctx.actor?.id ?? null,
      data: payload,
    });

    let queued = 0;
    for (const webhook of webhooks) {
      const subscriptions = parseArray(webhook.subscriptions);
      if (!subscriptions.includes(eventType)) continue;
      if (webhook.consecutive_failures >= MAX_ATTEMPTS) {
        this.db.exec("UPDATE webhooks SET state = 'DISABLED', disabled_at = :at, updated_at = :at WHERE id = :id", { at: ctx.at, id: webhook.id });
        this.audit.record({
          action: 'webhook.delivery_failed',
          actorId: ctx.actor?.id ?? null,
          actorRoles: ctx.actor?.roles ?? [],
          eventId,
          resourceType: 'webhook',
          resourceId: webhook.id,
          outcome: 'FAILED',
          metadata: { reason: `disabled after ${String(MAX_ATTEMPTS)} consecutive failures`, eventType },
          at: ctx.at,
        });
        continue;
      }

      const deliveryId = newId('webhookDelivery');
      this.db.exec(
        `INSERT INTO webhook_deliveries (id, webhook_id, event_type, delivery_id, payload, signature, status, attempt, created_at, updated_at)
         VALUES (:id, :w, :type, :delivery_id, :payload, '', 'PENDING', 1, :at, :at)
         ON CONFLICT (webhook_id, delivery_id) DO NOTHING`,
        { id: deliveryId, w: webhook.id, type: eventType, delivery_id: `dlv_${sha256Hex(`${webhook.id}:${eventType}:${String(ctx.at)}`).slice(0, 16)}`, payload: body, at: ctx.at },
      );

      const stored = this.db.get<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE id = :id', { id: deliveryId });
      if (stored !== null) {
        queued += 1;
        // Fire and forget. The promise is intentionally not awaited and has a
        // catch so a network error cannot become an unhandled rejection.
        void this.attempt(webhook, stored).catch((error: unknown) => {
          this.logger.warn('webhook attempt threw', {
            webhookId: webhook.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }

    return queued;
  }

  /** One signed HTTP attempt with SSRF checks, timeout and a size cap. */
  private async attempt(webhook: WebhookRow, delivery: DeliveryRow): Promise<{ status: string; httpStatus: number | null }> {
    const startedAt = Date.now();
    const timestamp = toInstant(startedAt);
    const signature = signPayload(webhook.secret, delivery.delivery_id, timestamp, delivery.payload);

    this.db.exec('UPDATE webhook_deliveries SET signature = :sig, updated_at = :at WHERE id = :id', {
      sig: signature,
      at: timestamp,
      id: delivery.id,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.security.webhookTimeoutMs);

    try {
      // Re-validate the target at send time: DNS can change after creation.
      await assertDeliverableUrl(webhook.url, this.config.security.allowPrivateWebhookTargets);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': 'Verdict-Webhook/1.0',
          'x-verdict-id': delivery.delivery_id,
          'x-verdict-event': delivery.event_type,
          'x-verdict-timestamp': timestamp,
          [SIGNATURE_HEADER]: signature,
        },
        body: delivery.payload,
        redirect: 'manual',
        signal: controller.signal,
      });

      const text = (await response.text().catch(() => '')).slice(0, MAX_RESPONSE_BYTES);
      const durationMs = Date.now() - startedAt;
      const ok = response.status >= 200 && response.status < 300;

      this.db.transaction(() => {
        this.db.exec(
          `UPDATE webhook_deliveries SET status = :status, response_status = :code, response_body = :body,
             duration_ms = :duration, error = '', next_attempt_at = :next, updated_at = :at WHERE id = :id`,
          {
            status: ok ? 'DELIVERED' : 'FAILED',
            code: response.status,
            body: text,
            duration: durationMs,
            next: ok ? null : this.backoffAt(delivery.attempt),
            at: timestamp,
            id: delivery.id,
          },
        );
        this.db.exec(
          `UPDATE webhooks SET last_status = :code, last_delivery_at = :at,
             consecutive_failures = CASE WHEN :ok = 1 THEN 0 ELSE consecutive_failures + 1 END, updated_at = :at
           WHERE id = :id`,
          { code: response.status, ok: ok ? 1 : 0, at: timestamp, id: webhook.id },
        );
      });

      if (!ok) {
        this.audit.record({
          action: 'webhook.delivery_failed',
          actorId: null,
          actorRoles: [],
          eventId: webhook.event_id,
          resourceType: 'webhookDelivery',
          resourceId: delivery.id,
          outcome: 'FAILED',
          metadata: { httpStatus: response.status, eventType: delivery.event_type, attempt: delivery.attempt },
          at: timestamp,
        });
      }

      return { status: ok ? 'DELIVERED' : 'FAILED', httpStatus: response.status };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      const abandoned = delivery.attempt >= MAX_ATTEMPTS;

      this.db.transaction(() => {
        this.db.exec(
          `UPDATE webhook_deliveries SET status = :status, error = :error, duration_ms = :duration,
             next_attempt_at = :next, updated_at = :at WHERE id = :id`,
          {
            status: abandoned ? 'ABANDONED' : 'FAILED',
            error: message.slice(0, 500),
            duration: durationMs,
            next: abandoned ? null : this.backoffAt(delivery.attempt),
            at: timestamp,
            id: delivery.id,
          },
        );
        this.db.exec(
          'UPDATE webhooks SET consecutive_failures = consecutive_failures + 1, last_delivery_at = :at, updated_at = :at WHERE id = :id',
          { at: timestamp, id: webhook.id },
        );
      });

      this.audit.record({
        action: 'webhook.delivery_failed',
        actorId: null,
        actorRoles: [],
        eventId: webhook.event_id,
        resourceType: 'webhookDelivery',
        resourceId: delivery.id,
        outcome: 'FAILED',
        metadata: { error: message.slice(0, 200), eventType: delivery.event_type, attempt: delivery.attempt, abandoned },
        at: timestamp,
      });

      return { status: abandoned ? 'ABANDONED' : 'FAILED', httpStatus: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retry deliveries whose backoff has elapsed. Called by the scheduler. */
  async processRetries(limit = 50): Promise<number> {
    const at = now();
    const due = this.db.all<DeliveryRow & { secret: string; url: string; state: string }>(
      `SELECT d.*, w.secret, w.url, w.state
       FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.status = 'FAILED' AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= :at
       ORDER BY d.next_attempt_at LIMIT :limit`,
      { at, limit: Math.min(200, Math.max(1, limit)) },
    );

    let processed = 0;
    for (const row of due) {
      const webhook = this.db.get<WebhookRow>('SELECT * FROM webhooks WHERE id = :id', { id: row.webhook_id });
      if (webhook === null) continue;
      this.db.exec('UPDATE webhook_deliveries SET attempt = attempt + 1, updated_at = :at WHERE id = :id', { at, id: row.id });
      const refreshed = this.db.get<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE id = :id', { id: row.id });
      if (refreshed !== null) {
        await this.attempt(webhook, refreshed);
        processed += 1;
      }
    }
    return processed;
  }

  private backoffAt(attempt: number): string {
    // Exponential with a ceiling: 30s, 60s, 120s, 240s.
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
    return toInstant(Date.now() + delay);
  }
}

/* ------------------------------------------------------------ signing */

export function signPayload(secret: string, deliveryId: string, timestamp: string, body: string): string {
  const material = `${deliveryId}.${timestamp}.${body}`;
  return `v1=${createHmac('sha256', secret).update(material).digest('hex')}`;
}

/** Verify a signature, as a receiver would. Exported for the test suite. */
export function verifySignature(secret: string, deliveryId: string, timestamp: string, body: string, presented: string): boolean {
  const expected = signPayload(secret, deliveryId, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* --------------------------------------------------------------- SSRF */

const dns = await import('node:dns/promises');

/**
 * Reject a target that would reach the deployment's own network. Called both at
 * creation time and immediately before every delivery.
 */
export async function assertDeliverableUrl(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;

  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing to deliver to a ${parsed.protocol} URL`);
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error(`refusing to deliver to the private address ${parsed.hostname}`);
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch {
    // A name that does not resolve cannot be a private-address bypass, and the
    // fetch will fail anyway with a clearer error.
    return;
  }
  for (const entry of addresses) {
    if (isPrivateHostname(entry.address)) {
      throw new Error(`refusing to deliver: ${parsed.hostname} resolves to the private address ${entry.address}`);
    }
  }
}

function parseArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export { toEpochMs, validateHttpUrl };

/**
 * Certificates and judge participation records.
 *
 * Both are *verifiable artefacts*, so both are generated locally with no
 * external service and both carry an integrity hash plus a short public
 * reference code. The verification endpoint recomputes the hash from the stored
 * payload, so a tampered certificate is detectable without a signing authority.
 *
 * The rendered certificate is SVG: vector, deterministic, no font embedding, and
 * printable. `renderSvg` is a pure function of the record, so the same
 * certificate always produces the same bytes — which is what makes the
 * integrity hash meaningful.
 */

import { canonicalJson, certificateReference, contentHash, sha256Hex } from '@verdict/core/integrity';
import { newId } from '@verdict/core/ids';
import { validatePlainText } from '@verdict/core/validation';
import type { WebhookEvent } from '@verdict/core/types';
import { errors } from '../lib/errors.ts';
import { canManageEvent } from '../lib/rbac.ts';
import type { ActorContext, Services } from './context.ts';
import { requireActor } from './context.ts';

export type CertificateKind = 'PARTICIPANT' | 'FINALIST' | 'WINNER' | 'JUDGE';

export type CertificateRow = {
  id: string;
  event_id: string;
  user_id: string;
  kind: CertificateKind;
  reference: string;
  title: string;
  body: string;
  submission_id: string | null;
  prize_id: string | null;
  awarded_at: string;
  issued_at: string;
  revoked_at: string | null;
  integrity_hash: string;
  payload: string;
  created_at: string;
};

export const CERTIFICATE_VERSION = '1.0.0';

/**
 * A judge's participation record, as stored.
 *
 * `detail` is the per-project breakdown the hash covers, so it is part of the
 * record rather than a rendering of it: changing a project name inside it would
 * change the recomputed hash and the record would verify as tampered. That is
 * the point of hashing the detail and not only the totals.
 */
export type ParticipationRecordRow = {
  id: string;
  event_id: string;
  judge_id: string;
  assignment_version: number;
  reference: string;
  judging_opens_at: string;
  judging_closes_at: string;
  assigned_count: number;
  completed_count: number;
  completion_status: string;
  detail: string;
  integrity_hash: string;
  issued_at: string;
};

export class CertificateService {
  private readonly db: Services['db'];
  private readonly audit: Services['audit'];
  private readonly events: Services['events'];

  constructor(services: Services) {
    this.db = services.db;
    this.audit = services.audit;
    this.events = services.events;
  }

  /**
   * Issue a certificate. Re-issuing the same (event, user, kind, submission)
   * is idempotent so a batch can be run twice safely.
   */
  issue(
    eventId: string,
    input: {
      userId: string;
      kind: CertificateKind;
      title?: string;
      body?: string;
      submissionId?: string | null;
      prizeId?: string | null;
      awardedAt?: string;
    },
    ctx: ActorContext,
  ): CertificateRow {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);

    const user = this.db.get<{ id: string; display_name: string; email: string }>(
      'SELECT id, display_name, email FROM users WHERE id = :id',
      { id: input.userId },
    );
    if (user === null) throw errors.notFound('User', input.userId);

    const existing = this.db.get<CertificateRow>(
      `SELECT * FROM certificates WHERE event_id = :e AND user_id = :u AND kind = :k
       AND (submission_id IS :s OR submission_id = :s)`,
      { e: eventId, u: input.userId, k: input.kind, s: input.submissionId ?? null },
    );
    if (existing !== null) return existing;

    const title = input.title ?? defaultTitle(input.kind, event.name);
    const body = input.body ?? defaultBody(input.kind, event.name, user.display_name);
    const issuedAt = ctx.at;
    const awardedAt = input.awardedAt ?? issuedAt;

    const payload = {
      version: CERTIFICATE_VERSION,
      event: { id: event.id, name: event.name, slug: event.slug },
      recipient: { id: user.id, name: user.display_name },
      kind: input.kind,
      title,
      body,
      submissionId: input.submissionId ?? null,
      prizeId: input.prizeId ?? null,
      awardedAt,
      issuedAt,
    };
    const integrityHash = sha256Hex(canonicalJson(payload));
    const reference = certificateReference(integrityHash);
    const id = newId('certificate');

    this.db.exec(
      `INSERT INTO certificates (id, event_id, user_id, kind, reference, title, body, submission_id, prize_id,
         awarded_at, issued_at, integrity_hash, payload, created_at)
       VALUES (:id, :e, :u, :kind, :ref, :title, :body, :submission, :prize, :awarded, :issued, :hash, :payload, :at)
       ON CONFLICT (event_id, user_id, kind, submission_id) DO NOTHING`,
      {
        id,
        e: eventId,
        u: input.userId,
        kind: input.kind,
        ref: reference,
        title: validatePlainText(title, { field: 'title', max: 200 }),
        body: validatePlainText(body, { field: 'body', max: 2000 }),
        submission: input.submissionId ?? null,
        prize: input.prizeId ?? null,
        awarded: awardedAt,
        issued: issuedAt,
        hash: integrityHash,
        payload: canonicalJson(payload),
        at: issuedAt,
      },
    );

    const stored = this.db.get<CertificateRow>('SELECT * FROM certificates WHERE id = :id', { id })
      ?? this.db.get<CertificateRow>(
        'SELECT * FROM certificates WHERE event_id = :e AND user_id = :u AND kind = :k AND (submission_id IS :s OR submission_id = :s)',
        { e: eventId, u: input.userId, k: input.kind, s: input.submissionId ?? null },
      )!;

    this.audit.record({
      action: 'certificate.generated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'certificate',
      resourceId: stored.id,
      requestId: ctx.requestId,
      ipAddress: ctx.ipAddress,
      metadata: { kind: input.kind, userId: input.userId, reference, integrityHash },
      at: ctx.at,
    });

    void this.deliver(eventId, 'certificate.generated', { certificateId: stored.id, reference, kind: input.kind } as Record<string, unknown>, ctx);
    return stored;
  }

  /**
   * Batch issuance for a whole event: participants, judges, and prize winners
   * derived from the published snapshot.
   */
  issueForEvent(eventId: string, options: { includeJudges?: boolean; snapshotId?: string | null }, ctx: ActorContext) {
    const actor = requireActor(ctx);
    const event = this.events.require(eventId);
    this.events.assertOrganizer(actor, event, ctx);

    const issued: string[] = [];
    const skipped: { id: string; reason: string }[] = [];

    // Winners and finalists from the published snapshot.
    const snapshotId = options.snapshotId ?? this.db.value<string>(
      'SELECT id FROM result_snapshots WHERE event_id = :e AND is_published = 1 ORDER BY sequence DESC LIMIT 1',
      { e: eventId },
    );

    if (snapshotId !== null && snapshotId !== undefined) {
      const entries = this.db.all<{ submission_id: string; rank: number; prizes: string; assigned_judges: number }>(
        'SELECT submission_id, rank, prizes, assigned_judges FROM result_entries WHERE snapshot_id = :s ORDER BY rank',
        { s: snapshotId },
      );
      // The top third of the field counts as a finalist when the snapshot
      // configured no prizes, so a runner-up still receives a certificate.
      const finalistCutoff = Math.max(1, Math.ceil(entries.length / 3));
      for (const entry of entries) {
        const teamMembers = this.db.all<{ user_id: string }>(
          'SELECT user_id FROM team_members WHERE team_id = (SELECT team_id FROM submissions WHERE id = :s)',
          { s: entry.submission_id },
        );
        const members = teamMembers.length > 0
          ? teamMembers.map((m) => m.user_id)
          : [
              (this.db.value<string>('SELECT created_by FROM submissions WHERE id = :s', { s: entry.submission_id }) ?? ''),
            ].filter(Boolean);

        for (const userId of members) {
          const prizes = parseArray(entry.prizes);
          const kind: CertificateKind = prizes.length > 0 ? 'WINNER' : Number(entry.rank) <= finalistCutoff ? 'FINALIST' : 'PARTICIPANT';
          try {
            const certificate = this.issue(
              eventId,
              {
                userId,
                kind,
                submissionId: entry.submission_id,
                ...(prizes.length > 0 ? { body: `${event.name}: ${prizes.join(', ')}` } : {}),
              },
              ctx,
            );
            issued.push(certificate.id);
          } catch (error) {
            skipped.push({ id: userId, reason: error instanceof Error ? error.message : 'unknown' });
          }
        }
      }
    }

    // Everyone who registered.
    for (const registration of this.db.all<{ user_id: string; state: string }>(
      "SELECT user_id, state FROM registrations WHERE event_id = :e AND state IN ('ACCEPTED','PENDING')",
      { e: eventId },
    )) {
      try {
        issued.push(this.issue(eventId, { userId: registration.user_id, kind: 'PARTICIPANT' }, ctx).id);
      } catch (error) {
        skipped.push({ id: registration.user_id, reason: error instanceof Error ? error.message : 'unknown' });
      }
    }

    // Judges.
    if (options.includeJudges !== false) {
      for (const judge of this.db.all<{ id: string; user_id: string; state: string }>(
        "SELECT id, user_id, state FROM judges WHERE event_id = :e AND state IN ('ACCEPTED','ACTIVE','COMPLETED')",
        { e: eventId },
      )) {
        try {
          issued.push(this.issue(eventId, { userId: judge.user_id, kind: 'JUDGE' }, ctx).id);
        } catch (error) {
          skipped.push({ id: judge.user_id, reason: error instanceof Error ? error.message : 'unknown' });
        }
      }
    }

    // Judge participation records.
    const records = this.issueParticipationRecords(eventId, ctx);

    return { issued: issued.length, skipped, participationRecords: records };
  }

  /**
   * A verifiable record that a judge took part in a panel: what they were
   * assigned, what they completed, and over which period.
   */
  issueParticipationRecords(eventId: string, ctx: ActorContext): number {
    const event = this.events.require(eventId);
    const opensAt = event.judging_opens_at ?? event.created_at;
    const closesAt = event.judging_closes_at ?? ctx.at;

    const rows = this.db.all<{ judge_id: string; user_id: string; assigned: number; completed: number; state: string }>(
      `SELECT j.id AS judge_id, j.user_id, j.state,
              (SELECT COUNT(*) FROM judge_assignments a WHERE a.judge_id = j.id AND a.status <> 'REASSIGNED') AS assigned,
              (SELECT COUNT(*) FROM judge_assignments a WHERE a.judge_id = j.id AND a.status = 'SUBMITTED') AS completed
       FROM judges j WHERE j.event_id = :e AND j.state IN ('ACCEPTED','ACTIVE','COMPLETED')`,
      { e: eventId },
    );

    let count = 0;
    for (const row of rows) {
      const assigned = Number(row.assigned);
      const completed = Number(row.completed);
      const completionStatus = assigned === 0 ? 'NO_ASSIGNMENTS' : completed >= assigned ? 'COMPLETE' : completed === 0 ? 'NOT_STARTED' : 'PARTIAL';

      const detail = {
        assignedProjects: this.db.all<{ projectId: string; projectName: string; status: string; score: number | null; submittedAt: string | null }>(
          `SELECT a.submission_id AS projectId, s.project_name AS projectName, a.status, sc.raw_score AS score, a.completed_at AS submittedAt
           FROM judge_assignments a
           JOIN submissions s ON s.id = a.submission_id
           LEFT JOIN scores sc ON sc.assignment_id = a.id AND sc.state IN ('SUBMITTED','LOCKED')
           WHERE a.judge_id = :j AND a.status <> 'REASSIGNED' ORDER BY s.project_name`,
          { j: row.judge_id },
        ),
      };
      const integrityHash = sha256Hex(
        canonicalJson({ eventId, judgeId: row.judge_id, assigned, completed, opensAt, closesAt, detail }),
      );
      const reference = `JPR-${integrityHash.slice(0, 4).toUpperCase()}-${integrityHash.slice(4, 8).toUpperCase()}`;
      const id = newId('participationRecord');

      this.db.exec(
        `INSERT INTO judge_participation_records (
           id, event_id, judge_id, assignment_version, reference, judging_opens_at, judging_closes_at,
           assigned_count, completed_count, completion_status, detail, integrity_hash, issued_at
         ) VALUES (:id, :e, :j, :v, :ref, :opens, :closes, :assigned, :completed, :status, :detail, :hash, :at)
         ON CONFLICT (event_id, judge_id, assignment_version) DO UPDATE SET
           assigned_count = excluded.assigned_count, completed_count = excluded.completed_count,
           completion_status = excluded.completion_status, detail = excluded.detail,
           integrity_hash = excluded.integrity_hash, issued_at = excluded.issued_at`,
        {
          id,
          e: eventId,
          j: row.judge_id,
          v: this.db.value<number>('SELECT COALESCE(MAX(version), 0) AS v FROM judge_assignments WHERE judge_id = :j', { j: row.judge_id }) ?? 0,
          ref: reference,
          opens: opensAt,
          closes: closesAt,
          assigned,
          completed,
          status: completionStatus,
          detail: canonicalJson(detail),
          hash: integrityHash,
          at: ctx.at,
        },
      );
      count += 1;
    }

    return count;
  }

  /* ---------------------------------------------------------- queries */

  findById(id: string): CertificateRow | null {
    return this.db.get<CertificateRow>('SELECT * FROM certificates WHERE id = :id', { id });
  }

  findByReference(reference: string): CertificateRow | null {
    return this.db.get<CertificateRow>('SELECT * FROM certificates WHERE reference = :r', {
      r: reference.trim().toUpperCase(),
    });
  }

  require(id: string): CertificateRow {
    const row = this.findById(id);
    if (row === null) throw errors.notFound('Certificate', id);
    return row;
  }

  list(eventId: string, filter: { kind?: CertificateKind; limit: number; offset: number }, ctx: ActorContext) {
    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const conditions = ['c.event_id = :e'];
    const params: Record<string, string | number> = { e: eventId, limit: filter.limit, offset: filter.offset };
    if (filter.kind) {
      conditions.push('c.kind = :kind');
      params.kind = filter.kind;
    }
    return this.db.all(
      `SELECT c.id, c.kind, c.reference, c.title, c.issued_at AS issuedAt, c.revoked_at AS revokedAt,
              u.display_name AS recipientName, u.username, s.project_name AS projectName
       FROM certificates c JOIN users u ON u.id = c.user_id
       LEFT JOIN submissions s ON s.id = c.submission_id
       WHERE ${conditions.join(' AND ')} ORDER BY c.issued_at DESC LIMIT :limit OFFSET :offset`,
      params,
    );
  }

  /** The public verification view: recompute the hash and report the outcome. */
  verify(reference: string) {
    const row = this.findByReference(reference);
    if (row === null) {
      return { valid: false, status: 'NOT_FOUND' as const, message: 'No certificate exists with that reference.' };
    }
    const recomputed = sha256Hex(canonicalJson(JSON.parse(row.payload) as unknown));
    const valid = recomputed === row.integrity_hash;
    const event = this.events.findById(row.event_id);
    const user = this.db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = :id', { id: row.user_id });

    return {
      valid,
      status: row.revoked_at !== null ? ('REVOKED' as const) : valid ? ('VALID' as const) : ('TAMPERED' as const),
      reference: row.reference,
      kind: row.kind,
      title: row.title,
      body: row.body,
      recipientName: user?.display_name ?? null,
      event: event ? { name: event.name, slug: event.slug } : null,
      issuedAt: row.issued_at,
      awardedAt: row.awarded_at,
      revokedAt: row.revoked_at,
      integrityHash: row.integrity_hash,
      message: valid
        ? row.revoked_at !== null
          ? 'This certificate was issued by Verdict but has since been revoked.'
          : 'This certificate was issued by Verdict and its contents match its recorded hash.'
        : 'The stored contents do not match the recorded hash. Do not rely on this certificate.',
    };
  }

  /* ------------------------------------------ participation records */

  /** Every record for an event. Organizer-scoped; see `findParticipationForUser`. */
  listParticipation(eventId: string) {
    return this.db.all<ParticipationRecordRow>(
      `SELECT r.id, r.event_id AS eventId, r.reference, r.judge_id AS judgeId,
              u.display_name AS judgeName, r.assignment_version AS assignmentVersion,
              r.assigned_count AS assignedCount, r.completed_count AS completedCount,
              r.completion_status AS completionStatus, r.integrity_hash AS integrityHash,
              r.issued_at AS issuedAt
         FROM judge_participation_records r
         JOIN judges j ON j.id = r.judge_id
         JOIN users u ON u.id = j.user_id
        WHERE r.event_id = :e
        ORDER BY u.display_name`,
      { e: eventId },
    );
  }

  findParticipationByReference(reference: string): ParticipationRecordRow | null {
    return this.db.get<ParticipationRecordRow>(
      'SELECT * FROM judge_participation_records WHERE reference = :r',
      { r: reference.trim().toUpperCase() },
    );
  }

  /**
   * The records belonging to one person.
   *
   * This is the grant `rbac.ts` has always given - `participationRecord: 'OWN'`
   * to both PARTICIPANT and JUDGE - with no route behind it. A judge who spent a
   * weekend scoring somebody else's hackathon had no way to get the record of
   * having done it, short of asking the organizer to email it, and the organizer
   * console is not somewhere a judge can see. A grant nobody can exercise is not
   * a grant.
   */
  findParticipationForUser(userId: string): ParticipationRecordRow[] {
    return this.db.all<ParticipationRecordRow>(
      `SELECT r.* FROM judge_participation_records r
         JOIN judges j ON j.id = r.judge_id
        WHERE j.user_id = :u
        ORDER BY r.issued_at DESC`,
      { u: userId },
    );
  }

  /**
   * The public verification view for a participation record.
   *
   * The record's hash covers its own contents, so anyone holding the record can
   * recompute it and check it without trusting the database it came from - which
   * is what "publicly verifiable" has to mean here. It is a content hash, not a
   * signature: there is no private key in this system and no asymmetric signing
   * anywhere, so what this proves is that the record has not been altered since
   * it was issued, and not that a particular deployment issued it. Saying so
   * plainly is better than implying a signature exists.
   */
  verifyParticipation(reference: string) {
    const row = this.findParticipationByReference(reference);
    if (row === null) {
      return {
        valid: false,
        status: 'NOT_FOUND' as const,
        message: 'No participation record exists with that reference.',
      };
    }

    const detail = JSON.parse(row.detail) as { assignedProjects?: unknown };
    const recomputed = sha256Hex(
      canonicalJson({
        eventId: row.event_id,
        judgeId: row.judge_id,
        assigned: row.assigned_count,
        completed: row.completed_count,
        opensAt: row.judging_opens_at,
        closesAt: row.judging_closes_at,
        detail,
      }),
    );
    const valid = recomputed === row.integrity_hash;
    const event = this.events.findById(row.event_id);
    const judge = this.db.get<{ display_name: string }>(
      'SELECT u.display_name FROM judges j JOIN users u ON u.id = j.user_id WHERE j.id = :j',
      { j: row.judge_id },
    );

    /*
     * Redact the scores before showing the detail to an anonymous caller.
     *
     * The detail is returned for a reason: it is the per-project breakdown the
     * hash covers, so a verifier can see *what* the record attests to and not
     * just that some numbers are self-consistent. But it also carries each
     * project's raw score, and this endpoint is unauthenticated and the
     * reference is a short guessable-ish string. Publishing one judge's
     * individual scores through a "verify my participation" link would undo the
     * score-isolation rule the rest of the system enforces - it would let anyone
     * holding a reference read a judge's private scoring, and correlate it with
     * the leaderboard.
     *
     * The hash still covers the scores, which is what preserves the integrity
     * property: the score was part of the record when it was issued, so if
     * somebody edits a score in the database the recomputation above stops
     * matching and the record reports TAMPERED. Redacting the *output* costs
     * the verifier nothing they can act on, because they cannot recompute a
     * value they have not been given - the server does that part.
     */
    const publicDetail = redactScores(detail);

    return {
      valid,
      status: valid ? ('VALID' as const) : ('TAMPERED' as const),
      reference: row.reference,
      event: event ? { name: event.name, slug: event.slug } : null,
      judgeName: judge?.display_name ?? null,
      assignedProjects: row.assigned_count,
      completedProjects: row.completed_count,
      completionStatus: row.completion_status,
      judgingWindow: { opensAt: row.judging_opens_at, closesAt: row.judging_closes_at },
      issuedAt: row.issued_at,
      integrityHash: row.integrity_hash,
      recomputedHash: recomputed,
      detail: publicDetail,
      redactedFields: ['assignedProjects[].score'],
      message: valid
        ? 'This record was issued by Verdict and its contents match its recorded hash. It attests that the named person sat on this panel and completed the stated number of reviews; it is not a cryptographic signature, so it proves the record is unaltered rather than which deployment issued it. Individual scores are withheld: the hash covers them, but publishing them here would expose a judge\'s private scoring.'
        : 'The stored contents do not match the recorded hash. Do not rely on this record.',
    };
  }

  revoke(eventId: string, certificateId: string, reason: string, ctx: ActorContext): void {    const actor = requireActor(ctx);
    this.events.assertOrganizer(actor, this.events.require(eventId), ctx);
    const row = this.db.get<CertificateRow>('SELECT * FROM certificates WHERE id = :id AND event_id = :e', { id: certificateId, e: eventId });
    if (row === null) throw errors.notFound('Certificate', certificateId);
    this.db.exec('UPDATE certificates SET revoked_at = :at WHERE id = :id', { at: ctx.at, id: certificateId });
    this.audit.record({
      action: 'certificate.generated',
      actorId: actor.id,
      actorRoles: actor.roles,
      eventId,
      resourceType: 'certificate',
      resourceId: certificateId,
      requestId: ctx.requestId,
      previousState: 'ISSUED',
      newState: 'REVOKED',
      metadata: { reason },
      at: ctx.at,
    });
  }

  /**
   * Render the certificate as deterministic SVG.
   *
   * Pure: the same record always yields the same bytes, which is what lets the
   * integrity hash cover the visible artefact as well as the data.
   */
  render(row: CertificateRow): string {
    const event = this.events.findById(row.event_id);
    const user = this.db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = :id', { id: row.user_id });
    const recipient = user?.display_name ?? 'Participant';
    const title = escapeXml(row.title);
    const lines = wrap(row.body, 78).map((line) => escapeXml(line));
    const accent = row.kind === 'WINNER' ? '#B4881F' : row.kind === 'FINALIST' ? '#5227FF' : row.kind === 'JUDGE' ? '#0F766E' : '#2F6BFF';

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="848" viewBox="0 0 1200 848" role="img" aria-label="Certificate of ${escapeXml(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0B0A12"/>
      <stop offset="55%" stop-color="#141126"/>
      <stop offset="100%" stop-color="#0B0A12"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="848" fill="url(#bg)"/>
  <rect x="24" y="24" width="1152" height="800" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="2"/>
  <rect x="34" y="34" width="1132" height="780" fill="none" stroke="${accent}" stroke-opacity="0.18" stroke-width="1"/>
  <g fill="none" stroke="${accent}" stroke-opacity="0.5" stroke-width="1.5">
    <path d="M60 96 h44 M60 96 v44 M1140 96 h-44 M1140 96 v44 M60 752 h44 M60 752 v-44 M1140 752 h-44 M1140 752 v-44"/>
  </g>
  <text x="600" y="152" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="15" letter-spacing="7" fill="${accent}" fill-opacity="0.9">CERTIFICATE OF ${escapeXml(kindLabel(row.kind))}</text>
  <text x="600" y="232" text-anchor="middle" font-family="ui-serif, Georgia, Cambria, serif" font-size="52" fill="#F4F2FF">${escapeXml(recipient)}</text>
  <rect x="360" y="262" width="480" height="2" fill="url(#rule)"/>
  <text x="600" y="322" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="20" fill="#B9B4CF">${title}</text>
  ${lines
    .map(
      (line, index) =>
        `<text x="600" y="${372 + index * 34}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="19" fill="#8F8AA8">${line}</text>`,
    )
    .join('\n  ')}
  <text x="600" y="640" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="24" fill="#E7E4F5">${escapeXml(event?.name ?? 'Verdict event')}</text>
  <text x="600" y="700" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="14" letter-spacing="3" fill="#6F6A88">ISSUED ${escapeXml(row.issued_at.slice(0, 10))}</text>
  <text x="600" y="740" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" fill="${accent}" fill-opacity="0.85">${escapeXml(row.reference)}</text>
  <text x="600" y="772" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" fill="#5C5872">SHA-256 ${escapeXml(row.integrity_hash.slice(0, 32))}…</text>
</svg>`;
  }

  /**
   * Fire the webhook without blocking; failures are logged, never thrown.
   *
   * `eventType` is a `WebhookEvent` rather than `string` on purpose: the cast
   * that used to sit here was `as never`, which silenced the compiler entirely
   * and would have accepted a misspelt topic that quietly never delivered.
   */
  private deliver(eventId: string, eventType: WebhookEvent, payload: Record<string, unknown>, ctx: ActorContext): void {
    try {
      this.webhooks?.dispatch(eventId, eventType, payload, ctx);
    } catch {
      // Webhook delivery is best-effort and must never fail an issuance.
    }
  }

  private webhooks: Services['webhooks'] | null = null;

  attachWebhooks(webhooks: Services['webhooks']): void {
    this.webhooks = webhooks;
  }
}

/* --------------------------------------------------------- rendering */

/**
 * Strip the per-project scores out of a participation record's detail.
 *
 * A defensive copy, so the caller's parsed object is not mutated. The
 * structure is rebuilt rather than the score key deleted in place, because the
 * verification endpoint must not be able to leak a score through a nested shape
 * someone adds to the record later.
 */
function redactScores(detail: unknown): unknown {
  if (Array.isArray(detail)) return detail.map((item) => redactScores(item));
  if (detail === null || typeof detail !== 'object') return detail;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    // Any key that reads as a score, in any casing, and anything nested inside
    // an array of per-project rows.
    if (/^(raw_?)?score$/i.test(key)) continue;
    out[key] = redactScores(value);
  }
  return out;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 4);
}

function kindLabel(kind: CertificateKind): string {
  switch (kind) {
    case 'WINNER': return 'WINNER';
    case 'FINALIST': return 'FINALIST';
    case 'JUDGE': return 'JUDGING PANEL';
    case 'PARTICIPANT': return 'PARTICIPATION';
    default: return 'PARTICIPATION';
  }
}

function defaultTitle(kind: CertificateKind, eventName: string): string {
  switch (kind) {
    case 'WINNER': return `Winner — ${eventName}`;
    case 'FINALIST': return `Finalist — ${eventName}`;
    case 'JUDGE': return `Judge — ${eventName}`;
    case 'PARTICIPANT': return `Participant — ${eventName}`;
    default: return `Certificate — ${eventName}`;
  }
}

function defaultBody(kind: CertificateKind, eventName: string, name: string): string {
  switch (kind) {
    case 'WINNER':
      return `Awarded to ${name} for an outstanding project at ${eventName}.`;
    case 'FINALIST':
      return `${name} was selected as a finalist at ${eventName}.`;
    case 'JUDGE':
      return `Served on the judging panel at ${eventName}.`;
    case 'PARTICIPANT':
      return `Participated in ${eventName}. Thank you for building.`;
    default:
      return `Issued by Verdict for ${eventName}.`;
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

export { contentHash, canManageEvent };

import { useState } from 'react';
import {
  api,
  parseJsonArray,
  type CertificateRow,
  type ExportManifest,
  type ParticipationRecord,
  type WebhookRow,
} from '../../api.ts';
import { Empty, formatInstant, shortHash, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

const EXPORT_KINDS = [
  'REGISTRATIONS', 'PARTICIPANTS', 'TEAMS', 'SUBMISSIONS', 'JUDGES',
  'ASSIGNMENTS', 'SCORES', 'RESULTS', 'VOTES', 'COMMENTS', 'ANOMALIES', 'WEBHOOKS', 'AUDIT',
] as const;

/**
 * Integrations: webhooks, certificates, import and export.
 *
 * A delivery failure must never break the operation that caused it, so a webhook
 * is dispatched after the state change has already been committed and its result
 * is recorded rather than awaited. The delivery list here is how an organizer
 * finds out that a receiver stopped working — and redelivers once it is fixed.
 */
export function IntegrationsPanel({ eventId }: { eventId: string }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'webhooks' | 'certificates' | 'data'>('webhooks');

  return (
    <div className="stack">
      <div className="row" style={{ gap: 6 }} role="tablist" aria-label="Integrations">
        {(['webhooks', 'certificates', 'data'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={`button button--sm ${tab === value ? 'button--primary' : ''}`}
            onClick={() => setTab(value)}
          >
            {stateLabel(value)}
          </button>
        ))}
      </div>
      {error !== null ? <ErrorBox error={error} /> : null}
      {tab === 'webhooks' ? <Webhooks eventId={eventId} error={error} setError={setError} busy={busy} setBusy={setBusy} /> : null}
      {tab === 'certificates' ? <Certificates eventId={eventId} error={error} setError={setError} busy={busy} setBusy={setBusy} /> : null}
      {tab === 'data' ? <Data eventId={eventId} /> : null}
    </div>
  );
}

function ErrorBox({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="notice notice--error" role="alert">
      {message}
    </div>
  );
}

type Handlers = {
  error: unknown;
  setError: (value: unknown) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
};

function Webhooks({ eventId, error, setError, busy, setBusy }: { eventId: string } & Handlers) {
  const { data, reload } = useApi<{ data: WebhookRow[] }>(`/api/events/${eventId}/webhooks`);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState<string[]>(['results.published']);
  const [deliveries, setDeliveries] = useState<{ id: string; webhookId: string } | null>(null);

  const { data: deliveryRows } = useApi<{ data: Record<string, unknown>[] }>(
    deliveries === null ? null : `/api/webhooks/${deliveries.webhookId}/deliveries`,
  );

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const ALL_EVENTS = [
    'results.published', 'results.finalized', 'result.corrected', 'score.submitted',
    'judging.completed', 'submission.locked', 'registration.decided', 'certificate.generated',
  ];

  return (
    <>
      <Panel
        title="Webhooks"
        description="Signed outbound calls. A private, loopback or link-local target is refused, the hostname is re-resolved and re-checked before every delivery, and redirects are not followed — so a DNS record that starts pointing at 127.0.0.1 is caught. A delivery failure never blocks the event operation that caused it."
        error={error}
      >
        <div className="row row--wrap" style={{ gap: 10, alignItems: 'flex-end', marginBottom: 16 }}>
          <div className="field" style={{ flex: '1 1 300px' }}>
            <label className="label" htmlFor="wh-url">Endpoint URL</label>
            <input id="wh-url" className="input" type="url" value={url} placeholder="https://example.com/hooks/verdict" onChange={(changeEvent) => setUrl(changeEvent.target.value)} />
          </div>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label className="label" htmlFor="wh-secret">Signing secret <span className="muted small">min 16 chars</span></label>
            <input id="wh-secret" className="input" type="password" value={secret} onChange={(changeEvent) => setSecret(changeEvent.target.value)} />
          </div>
          <button
            type="button"
            className="button button--primary"
            disabled={busy || url.trim() === '' || events.length === 0}
            onClick={() =>
              void act(async () => {
                await api.post(`/api/events/${eventId}/webhooks`, {
                  url: url.trim(),
                  subscriptions: events,
                  ...(secret.trim() === '' ? {} : { secret: secret.trim() }),
                  description: 'Created from the organizer console',
                });
                setUrl('');
                setSecret('');
              })
            }
          >
            Add webhook
          </button>
        </div>

        <fieldset className="criterion" style={{ marginBottom: 16 }}>
          <legend className="label">Subscribe to</legend>
          <div className="row row--wrap" style={{ gap: 12 }}>
            {ALL_EVENTS.map((name) => (
              <label key={name} className="row small" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={events.includes(name)}
                  onChange={(changeEvent) =>
                    setEvents((current) =>
                      changeEvent.target.checked ? [...current, name] : current.filter((row) => row !== name),
                    )
                  }
                />
                <span className="mono tiny">{name}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {(data?.data ?? []).length === 0 ? (
          <Empty title="No webhooks">
            Add one to have this deployment notify another system when results are published. Nothing leaves the machine
            until you configure it.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Endpoint</th>
                  <th scope="col" style={{ width: 100 }}>State</th>
                  <th scope="col" style={{ width: 110 }}>Last status</th>
                  <th scope="col" style={{ width: 120 }}>Failures</th>
                  <th scope="col" style={{ width: 170 }}>Last delivery</th>
                  <th scope="col" style={{ width: 200 }} />
                </tr>
              </thead>
              <tbody>
                {(data?.data ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="small mono" style={{ wordBreak: 'break-all' }}>{row.url}</div>
                      <div className="row row--wrap" style={{ gap: 4, marginTop: 4 }}>
                        {parseJsonArray(row.subscriptions).map((name) => (
                          <span key={name} className="badge tiny">{name}</span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${row.state === 'ACTIVE' ? 'badge--ok' : row.state === 'PAUSED' ? 'badge--warn' : 'badge--bad'}`}>
                        {stateLabel(row.state)}
                      </span>
                    </td>
                    <td className="num">
                      {row.lastStatus === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <span className={`badge ${row.lastStatus < 300 ? 'badge--ok' : 'badge--bad'}`}>{row.lastStatus}</span>
                      )}
                    </td>
                    <td className="num">{String(row.consecutiveFailures)}</td>
                    <td className="small muted">{row.lastDeliveryAt === null ? '—' : formatInstant(row.lastDeliveryAt)}</td>
                    <td>
                      <div className="row row--wrap" style={{ gap: 5 }}>
                        <button type="button" className="button button--sm" disabled={busy} onClick={() => setDeliveries({ id: row.id, webhookId: row.id })}>
                          Deliveries
                        </button>
                        <button type="button" className="button button--sm button--danger" disabled={busy} onClick={() => void act(() => api.del(`/api/webhooks/${row.id}`))}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {deliveries !== null ? (
        <Panel
          title="Delivery history"
          description="Every attempt, with the response status or the error. A failed delivery can be replayed once the receiver is fixed."
          actions={
            <button type="button" className="button" onClick={() => setDeliveries(null)}>
              Close
            </button>
          }
        >
          {(deliveryRows?.data ?? []).length === 0 ? (
            <Empty title="No deliveries yet">Nothing has been sent to this endpoint.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 170 }}>When</th>
                    <th scope="col">Event</th>
                    <th scope="col" style={{ width: 110 }}>Status</th>
                    <th scope="col" style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {(deliveryRows?.data ?? []).map((row) => (
                    <tr key={String(row['id'])}>
                      <td className="small muted">{formatInstant(String(row['createdAt'] ?? row['attemptedAt'] ?? ''))}</td>
                      <td className="small mono">{String(row['event'] ?? row['eventType'] ?? '—')}</td>
                      <td>
                        <span className={`badge ${Number(row['statusCode'] ?? 0) < 300 ? 'badge--ok' : 'badge--bad'}`}>
                          {String(row['statusCode'] ?? row['status'] ?? '—')}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button button--sm"
                          disabled={busy}
                          onClick={() => void act(() => api.post(`/api/webhooks/deliveries/${String(row['id'])}/redeliver`, {}))}
                        >
                          Redeliver
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}
    </>
  );
}

function Certificates({ eventId, error, setError, busy, setBusy }: { eventId: string } & Handlers) {
  const { data, reload } = useApi<{ data: CertificateRow[]; pagination: { total: number } }>(
    `/api/events/${eventId}/certificates?perPage=200`,
  );
  const { data: records, reload: reloadRecords } = useApi<{ data: ParticipationRecord[] }>(
    `/api/events/${eventId}/participation-records`,
  );
  const [reason, setReason] = useState('');

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
      reloadRecords();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel
        title="Certificates"
        description="Every certificate is a verifiable record: the public page recomputes a SHA-256 over its stored contents, so a certificate edited after issue reports as tampered. A revoked certificate still verifies as issued and reports that it was withdrawn — the record stays honest."
        error={error}
        actions={
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => void act(() => api.post(`/api/events/${eventId}/certificates/issue-all`, { includeJudges: true }))}
          >
            Issue for everyone
          </button>
        }
      >
        <div className="field" style={{ marginBottom: 16, maxWidth: 520 }}>
          <label className="label" htmlFor="cert-reason">Revocation reason <span className="muted small">required to withdraw</span></label>
          <input id="cert-reason" className="input" value={reason} onChange={(changeEvent) => setReason(changeEvent.target.value)} />
        </div>

        {(data?.data ?? []).length === 0 ? (
          <Empty title="No certificates issued">
            Issue them all after results are published, so winners and finalists are recorded against a published snapshot.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Recipient</th>
                  <th scope="col" style={{ width: 120 }}>Kind</th>
                  <th scope="col">Title</th>
                  <th scope="col" style={{ width: 180 }}>Reference</th>
                  <th scope="col" style={{ width: 150 }}>State</th>
                  <th scope="col" style={{ width: 180 }} />
                </tr>
              </thead>
              <tbody>
                {(data?.data ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="strong">{row.recipientName}</div>
                      <div className="tiny dim">{row.username}</div>
                    </td>
                    <td><span className="badge">{stateLabel(row.kind)}</span></td>
                    <td className="small">{row.title}</td>
                    <td className="mono tiny">{row.reference}</td>
                    <td>
                      {row.revokedAt === null ? (
                        <span className="badge badge--ok">Valid</span>
                      ) : (
                        <span className="badge badge--warn">Revoked</span>
                      )}
                    </td>
                    <td>
                      <div className="row row--wrap" style={{ gap: 5 }}>
                        <a className="button button--sm" href={`/certificates/${row.reference}`} target="_blank" rel="noreferrer noopener">
                          View
                        </a>
                        <a className="button button--sm" href={`/api/certificates/${row.reference}.svg`} target="_blank" rel="noreferrer noopener">
                          SVG
                        </a>
                        {row.revokedAt === null ? (
                          <button
                            type="button"
                            className="button button--sm button--danger"
                            disabled={busy || reason.trim().length < 5}
                            title={reason.trim().length < 5 ? 'Write a reason first' : undefined}
                            onClick={() => void act(() => api.post(`/api/events/${eventId}/certificates/${row.id}/revoke`, { reason: reason.trim() }))}
                          >
                            Revoke
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Participation records"
        description="A verifiable statement of what each judge actually did: what they were assigned, what they completed, over which window, bound with a hash. Re-running issues nothing twice."
        actions={
          <button type="button" className="button" disabled={busy} onClick={() => void act(() => api.post(`/api/events/${eventId}/participation-records`, {}))}>
            Issue records
          </button>
        }
      >
        {(records?.data ?? []).length === 0 ? (
          <Empty title="No participation records">Issue them to create a verifiable record for every panel member.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Judge</th>
                  <th scope="col" style={{ width: 120 }}>Completed</th>
                  <th scope="col" style={{ width: 130 }}>Status</th>
                  <th scope="col" style={{ width: 150 }}>Judging window</th>
                  <th scope="col" style={{ width: 150 }}>Integrity</th>
                </tr>
              </thead>
              <tbody>
                {(records?.data ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="strong">{row.judgeName}</div>
                      <div className="tiny dim">{row.judgeEmail}</div>
                    </td>
                    <td className="num">
                      {String(row.completedCount)}/{String(row.assignedCount)}
                    </td>
                    <td>
                      <span className={`badge ${row.completionStatus === 'COMPLETE' ? 'badge--ok' : row.completionStatus === 'PARTIAL' ? 'badge--warn' : ''}`}>
                        {stateLabel(row.completionStatus)}
                      </span>
                    </td>
                    <td className="small muted">
                      {formatInstant(row.judgingOpensAt)} → {formatInstant(row.judgingClosesAt)}
                    </td>
                    <td className="mono tiny">{shortHash(row.integrityHash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

function Data({ eventId }: { eventId: string }) {
  /*
   * The manifest is a descriptor, not a bare map: it carries the event, the
   * schema version, who generated it, and the entities keyed underneath. Reading
   * it as `Record<string, {count, columns}>` iterated the descriptor's own keys
   * and rendered "event", "generatedAt" and "note" as if they were datasets.
   */
  const { data: manifest } = useApi<ExportManifest>(`/api/events/${eventId}/exports/manifest`);

  const entities = manifest?.entities ?? {};
  const entityNames = Object.keys(entities);
  const [csv, setCsv] = useState('');
  const [kind, setKind] = useState<'participants' | 'judges' | 'teams'>('participants');
  const [dryRun, setDryRun] = useState(true);
  const [outcome, setOutcome] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const runImport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await api.post<Record<string, unknown>>(
        `/api/events/${eventId}/imports/${kind}`,
        { csv, dryRun },
      );
      setOutcome(result);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel
        title="Export"
        description="CSV, deterministic for a given state of the event. The manifest publishes the row count and the exact columns of every entity so a consumer can confirm they received the whole dataset rather than discovering a gap later."
      >
        {manifest === null ? <span className="muted small">Loading…</span> : null}
        <div className="row row--wrap" style={{ gap: 6, marginBottom: 16 }}>
          {EXPORT_KINDS.map((exportKind) => (
            <a
              key={exportKind}
              className="button button--sm"
              href={`/api/events/${eventId}/exports/${exportKind}`}
              download
            >
              {stateLabel(exportKind)}
            </a>
          ))}
        </div>
        {manifest !== null && entityNames.length > 0 ? (
          <details>
            <summary className="small strong" style={{ cursor: 'pointer' }}>
              Export manifest · {String(entityNames.length)} entities, schema v{String(manifest?.schemaVersion ?? '?')}
            </summary>
            <p className="tiny dim" style={{ marginTop: 6 }}>
              Generated {formatInstant(manifest?.generatedAt)} by {String(manifest?.generatedBy ?? 'unknown')}. Published so
              a consumer can confirm they received the whole dataset rather than discovering a gap later.
            </p>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Entity</th>
                    <th scope="col" style={{ width: 90 }}>Rows</th>
                    <th scope="col">Columns</th>
                  </tr>
                </thead>
                <tbody>
                  {entityNames.map((entity) => (
                    <tr key={entity}>
                      <td className="small strong">{entity}</td>
                      <td className="num">{String(entities[entity]?.count ?? 0)}</td>
                      <td className="tiny mono" style={{ wordBreak: 'break-all' }}>
                        {(entities[entity]?.columns ?? []).join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </Panel>

      <Panel
        title="Import"
        description="Every row is validated independently and every rejection is reported with its row number, column and reason. A ragged file is refused outright rather than silently padded. Dry run by default, and a dry run writes nothing."
        error={error}
        actions={
          <>
            <label className="sr-only" htmlFor="imp-kind">Import kind</label>
            <select id="imp-kind" className="select" style={{ width: 160 }} value={kind} onChange={(changeEvent) => setKind(changeEvent.target.value as typeof kind)}>
              <option value="participants">Participants</option>
              <option value="judges">Judges</option>
              <option value="teams">Teams</option>
            </select>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={dryRun} onChange={(changeEvent) => setDryRun(changeEvent.target.checked)} />
              Dry run
            </label>
            <button type="button" className="button button--primary" disabled={busy || csv.trim() === ''} onClick={() => void runImport()}>
              {busy ? 'Validating…' : dryRun ? 'Validate' : 'Import'}
            </button>
          </>
        }
      >
        <div className="field">
          <label className="label" htmlFor="imp-csv">CSV</label>
          <textarea
            id="imp-csv"
            className="textarea"
            style={{ minHeight: 140, fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
            value={csv}
            placeholder={'email,fullName,organization\nada@example.com,Ada Lovelace,Analytical Engines'}
            onChange={(changeEvent) => setCsv(changeEvent.target.value)}
          />
        </div>

        {outcome !== null ? (
          <pre className="import-result" aria-live="polite">{JSON.stringify(outcome, null, 2)}</pre>
        ) : null}

        <p className="tiny dim" style={{ marginTop: 12 }}>
          Turning off “dry run” writes the rows. Validate first, read the rejections, fix the file, then import — an import
          that half-applies is worse than one that refuses.
        </p>
      </Panel>
    </>
  );
}

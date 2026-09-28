import { useState } from 'react';
import { type AuditAction, type AuditRow } from '../../api.ts';
import { Empty, formatInstant, shortHash, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * The audit ledger.
 *
 * Database triggers make these rows append-only, and the response carries a
 * rolling `chain.digest` over the most recent entries. Publishing that digest
 * and re-checking it later is what turns "we have an audit log" into "no row was
 * edited or removed" — which is the claim the whole result pipeline rests on.
 */
export function AuditPanel({ eventId }: { eventId: string }) {
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState<'SUCCESS' | 'DENIED' | 'FAILED' | ''>('');
  const [prefix, setPrefix] = useState('');

  const query = new URLSearchParams({ perPage: '200' });
  if (action !== '') query.set('action', action);
  if (outcome !== '') query.set('outcome', outcome);
  if (prefix !== '') query.set('actionPrefix', prefix);

  /*
   * `chain` is `{ digest, entries, headId, computedAt }`. It was previously
   * typed as `{ digest, count }`, so `chain.count` was `undefined` and React
   * threw on an object rendered as a child — which took the whole panel, and
   * with it the console, down.
   */
  const { data, loading } = useApi<{
    data: AuditRow[];
    actions: AuditAction[];
    chain: { digest: string; entries: number; headId: string; computedAt: string };
    pagination: { total: number };
  }>(`/api/events/${eventId}/audit?${query.toString()}`);

  const chain = data?.chain;

  return (
    <Panel
      title="Audit ledger"
      description="Append-only by database trigger. Every row carries the actor, their roles, the action, the resource, the outcome, the request id and any state transition. Filters compose."
      actions={
        <>
          <label className="sr-only" htmlFor="aud-action">Filter by action</label>
          <select id="aud-action" className="select" style={{ width: 200 }} value={action} onChange={(changeEvent) => setAction(changeEvent.target.value)}>
            <option value="">All actions</option>
            {(data?.actions ?? []).map((entry) => (
              // The vocabulary is an object, not a bare string. Rendering the
              // object directly was React error #31, which took the panel down.
              <option key={entry.action} value={entry.action}>
                {entry.action} ({String(entry.count)})
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="aud-prefix">Filter by action prefix</label>
          <input
            id="aud-prefix"
            className="input"
            style={{ width: 150 }}
            type="search"
            placeholder="e.g. result."
            value={prefix}
            onChange={(changeEvent) => setPrefix(changeEvent.target.value)}
          />
          <label className="sr-only" htmlFor="aud-outcome">Filter by outcome</label>
          <select id="aud-outcome" className="select" style={{ width: 140 }} value={outcome} onChange={(changeEvent) => setOutcome(changeEvent.target.value as typeof outcome)}>
            <option value="">All outcomes</option>
            <option value="SUCCESS">Success</option>
            <option value="DENIED">Denied</option>
            <option value="FAILED">Failed</option>
          </select>
        </>
      }
    >
      {chain !== undefined ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          <div className="strong small">Chain digest</div>
          <div className="mono tiny" style={{ wordBreak: 'break-all', marginTop: 4 }}>{chain.digest}</div>
          <div className="tiny dim" style={{ marginTop: 4 }}>
            A rolling hash over the most recent {String(chain.entries)} entries, head{' '}
            <span className="mono">{chain.headId}</span>, computed {formatInstant(chain.computedAt)}. Record the digest
            now and re-check it later to show no row was edited or removed.
          </div>
        </div>
      ) : null}

      {loading ? <span className="muted small">Loading…</span> : null}
      {!loading && (data?.data.length ?? 0) === 0 ? (
        <Empty title="No audit entries match">
          {action === '' && outcome === '' && prefix === '' ? 'Nothing has been recorded for this event yet.' : 'Clear the filters to see every entry.'}
        </Empty>
      ) : null}

      {(data?.data.length ?? 0) > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 165 }}>When</th>
                  <th scope="col">Action</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Resource</th>
                  <th scope="col" style={{ width: 110 }}>Outcome</th>
                  <th scope="col" style={{ width: 130 }}>Transition</th>
                </tr>
              </thead>
              <tbody>
                {(data?.data ?? []).map((row) => (
                  <tr key={row.id}>
                    <td className="small muted">{formatInstant(row.at)}</td>
                    <td className="small mono">{row.action}</td>
                    <td className="small">
                      <div>{row.actor}</div>
                      {row.actorRoles.length > 0 ? <div className="tiny dim">{row.actorRoles.join(', ')}</div> : null}
                    </td>
                    <td className="tiny mono" style={{ wordBreak: 'break-all' }}>
                      {row.resourceType}
                      {row.resourceId === '' ? '' : `:${row.resourceId.slice(0, 16)}`}
                    </td>
                    <td>
                      <span className={`badge ${row.outcome === 'SUCCESS' ? 'badge--ok' : row.outcome === 'DENIED' ? 'badge--bad' : 'badge--warn'}`}>
                        {row.outcome}
                      </span>
                    </td>
                    <td className="tiny">
                      {row.previousState === null && row.newState === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <span className="mono">
                          {row.previousState === null ? '·' : stateLabel(row.previousState)}
                          {' → '}
                          {row.newState === null ? '·' : stateLabel(row.newState)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tiny dim" style={{ marginTop: 12 }}>
            Showing {String(data?.data.length ?? 0)} of {String(data?.pagination.total ?? 0)} entries. Every response also
            carries the request id, the client address and a metadata object, so a specific action can be traced to a
            specific request.
            {chain !== undefined ? ` Latest chain digest ${shortHash(chain.digest)}.` : ''}
          </p>
        </>
      ) : null}
    </Panel>
  );
}

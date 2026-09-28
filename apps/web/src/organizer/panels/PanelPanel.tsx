import { useState } from 'react';
import { api, parseJsonArray, type ConflictRow, type JudgeRow } from '../../api.ts';
import { Empty, formatNumber, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * The judging panel: who is judging, how much work they have, and what they
 * have declared they cannot judge.
 *
 * The conflict register is the important half. A conflict is not a note: a HARD
 * conflict is never assigned by the engine under any strategy, and an organizer
 * who genuinely must proceed uses the separate, confirmed, audited
 * conflict-override path on the assignment that needs it. Declaring a conflict
 * against yourself is always allowed, at any time, including after judging has
 * started — blocking that would only encourage concealment.
 */
export function PanelPanel({ eventId }: { eventId: string }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState('');

  const { data: judges, loading, reload } = useApi<{
    data: JudgeRow[];
    workload: { assigned: number; completed: number }[];
  }>(`/api/events/${eventId}/judges?perPage=200`);

  const { data: conflicts, reload: reloadConflicts } = useApi<{ data: ConflictRow[] }>(
    `/api/events/${eventId}/conflicts`,
  );

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
      reloadConflicts();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const rows = judges?.data ?? [];
  const totalAssigned = rows.reduce((sum, row) => sum + Number(row.assigned), 0);
  const totalCompleted = rows.reduce((sum, row) => sum + Number(row.completed), 0);

  return (
    <div className="stack">
      <Panel
        title="Judges"
        description={
          totalAssigned === 0
            ? 'Invite judges, let them accept, then run the assignment engine. Capacity caps how many reviews a judge can carry.'
            : `${String(totalCompleted)} of ${String(totalAssigned)} assigned reviews submitted.`
        }
        error={error}
      >
        <div className="row row--wrap" style={{ gap: 10, marginBottom: 16, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 320px' }}>
            <label className="label" htmlFor="invite-judge">
              Invite by email or username
            </label>
            <input
              id="invite-judge"
              className="input"
              value={invite}
              placeholder="ada@example.com, or grace"
              onChange={(changeEvent) => setInvite(changeEvent.target.value)}
            />
          </div>
          <button
            type="button"
            className="button"
            disabled={busy || invite.trim() === ''}
            onClick={() =>
              void act(async () => {
                const parts = invite.split(/[,\s]+/).filter(Boolean);
                const result = await api.post<{ invited: { identifier: string }[]; skipped: { identifier: string; reason: string }[] }>(
                  `/api/events/${eventId}/judges/invite`,
                  { usernames: parts, note: 'Invited from the organizer console' },
                );
                setInvite('');
                // Surface per-identifier outcomes: one unknown address must not
                // abort the batch, and the organizer needs to know which failed.
                if (result.skipped.length > 0) {
                  setError(
                    new Error(
                      `Invited ${String(result.invited.length)}, skipped ${String(result.skipped.length)}: ` +
                        result.skipped.map((row) => `${row.identifier} (${row.reason})`).join(', '),
                    ),
                  );
                }
              })
            }
          >
            Invite
          </button>
        </div>

        {loading ? <span className="muted small">Loading…</span> : null}

        {!loading && rows.length === 0 ? (
          <Empty title="No judges yet">
            Invite someone above. They accept from their own workspace, and their queue appears the moment the assignment
            engine runs.
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Judge</th>
                  <th scope="col" style={{ width: 110 }}>State</th>
                  <th scope="col" style={{ width: 150 }}>Expertise</th>
                  <th scope="col" style={{ width: 90 }}>Capacity</th>
                  <th scope="col" style={{ width: 150 }}>Workload</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const over = Number(row.capacity) > 0 && Number(row.assigned) > Number(row.capacity);
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="strong">{row.display_name}</div>
                        <div className="small muted">{row.email}</div>
                        {row.title !== '' ? <div className="tiny dim">{row.title}</div> : null}
                      </td>
                      <td>
                        <span className={`badge ${row.state === 'ACTIVE' ? 'badge--ok' : row.state === 'INVITED' ? '' : 'badge--info'}`}>
                          {stateLabel(row.state)}
                        </span>
                      </td>
                      <td>
                        <div className="row row--wrap" style={{ gap: 4 }}>
                          {parseJsonArray(row.expertise).slice(0, 4).map((item) => (
                            <span key={item} className="badge tiny">{item}</span>
                          ))}
                          {parseJsonArray(row.expertise).length === 0 ? <span className="tiny dim">—</span> : null}
                        </div>
                      </td>
                      <td>
                        <label className="sr-only" htmlFor={`cap-${row.id}`}>Capacity for {row.display_name}</label>
                        <input
                          id={`cap-${row.id}`}
                          className="input"
                          type="number"
                          min={0}
                          max={500}
                          defaultValue={row.capacity}
                          style={{ width: 80 }}
                          disabled={busy}
                          onBlur={(changeEvent) => {
                            const next = Number(changeEvent.target.value);
                            if (Number.isInteger(next) && next !== Number(row.capacity) && next >= 0 && next <= 500) {
                              void act(() => api.patch(`/api/judges/${row.id}/capacity`, { capacity: next }));
                            }
                          }}
                        />
                      </td>
                      <td>
                        <div className="small">
                          {String(row.completed)}/{String(row.assigned)} done
                        </div>
                        {over ? <span className="badge badge--warn">over capacity</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Conflict register"
        description="A HARD conflict is never assigned by the engine under any strategy. A judge may always declare a conflict against themselves, including after judging has started. Withdrawing one is audited."
      >
        {(conflicts?.data ?? []).length === 0 ? (
          <Empty title="No conflicts declared">
            Nobody has declared one. The engine enforces conflicts it knows about; it cannot know about one that was never
            declared, which is why declaration is unrestricted.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Judge</th>
                  <th scope="col">Kind</th>
                  <th scope="col" style={{ width: 100 }}>Severity</th>
                  <th scope="col">Note</th>
                  <th scope="col" style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {(conflicts?.data ?? []).map((row) => (
                  <tr key={row.id}>
                    <td className="small">{row.judge_id}</td>
                    <td className="small">{stateLabel(row.kind)}</td>
                    <td>
                      <span className={`badge ${row.severity === 'HARD' ? 'badge--bad' : 'badge--warn'}`}>
                        {row.severity === 'HARD' ? 'Hard' : 'Soft'}
                      </span>
                    </td>
                    <td className="small muted">{row.note || '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="button button--sm"
                        disabled={busy}
                        onClick={() => void act(() => api.del(`/api/conflicts/${row.id}`))}
                      >
                        Withdraw
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Load balance" description="Capacity against actual load. A judge at 100% cannot absorb a reassignment without raising their cap first.">
        {rows.length === 0 ? (
          <span className="small muted">No judges to balance.</span>
        ) : (
          <div className="row row--wrap" style={{ gap: 12 }}>
            {rows.map((row) => {
              const capacity = Number(row.capacity);
              const assigned = Number(row.assigned);
              const pct = capacity === 0 ? 100 : Math.min(100, Math.round((assigned / capacity) * 100));
              return (
                <div key={row.id} style={{ minWidth: 170, flex: '1 1 170px' }}>
                  <div className="small strong">{row.display_name}</div>
                  <div className="meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${row.display_name} capacity used`}>
                    <span style={{ width: `${String(pct)}%` }} />
                  </div>
                  <div className="tiny dim">
                    {String(assigned)}/{capacity === 0 ? '∞' : String(capacity)} · {formatNumber(pct, 0)}%
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

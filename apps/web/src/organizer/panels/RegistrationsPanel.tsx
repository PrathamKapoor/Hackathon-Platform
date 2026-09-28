import { useState } from 'react';
import {
  api,
  parseJsonArray,
  type RegistrationField,
  type RegistrationRow,
} from '../../api.ts';
import { Empty, formatInstant, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * The applicant queue.
 *
 * A registration is the first thing an organizer actually processes, and the
 * decision is a state-machine transition, so an application can never end up in
 * a state the workflow has no way out of. The server enforces that; this page
 * only offers the decisions the event can currently make and reports the rest
 * of the queue.
 *
 * Bulk decisions validate each application independently: one bad id cannot roll
 * back the batch, and the response says exactly how many were applied and why
 * the rest were not.
 */
export function RegistrationsPanel({ eventId }: { eventId: string }) {
  const [state, setState] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const query = new URLSearchParams({ perPage: '200' });
  if (state !== undefined) query.set('state', state);
  if (search.trim() !== '') query.set('search', search.trim());

  const { data, loading, reload } = useApi<{ data: RegistrationRow[]; byState: Record<string, number> }>(
    `/api/events/${eventId}/registrations?${query.toString()}`,
  );
  const { data: form } = useApi<{ fields: RegistrationField[] }>(`/api/events/${eventId}/registration/form`);

  const rows = data?.data ?? [];
  const byState = data?.byState ?? {};

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setSelected(new Set());
      reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const decide = (id: string, to: RegistrationRow['state']): Promise<void> =>
    act(async () => {
      await api.post(`/api/events/${eventId}/registrations/${id}/decision`, { to, note: note.trim() || undefined, override: false });
    });

  const bulk = (to: 'ACCEPTED' | 'REJECTED' | 'WAITLISTED'): Promise<void> =>
    act(async () => {
      await api.post(`/api/events/${eventId}/registrations/bulk`, { ids: [...selected], to, note: note.trim() || undefined, override: false });
    });

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  return (
    <div className="stack">
      <Panel
        title="Application form"
        description="The questions every applicant answers. The form is per event, so two events on one instance can ask completely different things."
      >
        {form === null ? null : form.fields.length === 0 ? (
          <Empty title="No custom fields">
            The event asks for name, organisation, skills and links only. An organizer can add a field to collect what
            this event needs.
          </Empty>
        ) : (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {form.fields.map((field) => (
              <li key={field.id}>
                <strong>{field.label}</strong> <span className="muted">({field.type})</span>
                {field.required ? <span className="badge badge--warn" style={{ marginLeft: 6 }}>required</span> : null}
                {field.options.length > 0 ? <span className="muted"> — {field.options.join(', ')}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Applicants"
        description="Decisions are audited with the actor, the previous state and the note. An application can be decided again later, but it cannot be moved into a state the workflow has no exit from."
        error={error}
        actions={
          <>
            <label className="sr-only" htmlFor="reg-state">
              Filter by state
            </label>
            <select
              id="reg-state"
              className="select"
              style={{ width: 170 }}
              value={state ?? ''}
              onChange={(changeEvent) => setState(changeEvent.target.value === '' ? undefined : changeEvent.target.value)}
            >
              <option value="">All states</option>
              {['APPLICATION', 'PENDING', 'ACCEPTED', 'REJECTED', 'WAITLISTED', 'WITHDRAWN'].map((value) => (
                <option key={value} value={value}>
                  {stateLabel(value)} ({String(byState[value] ?? 0)})
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="reg-search">
              Search applicants
            </label>
            <input
              id="reg-search"
              className="input"
              style={{ width: 200 }}
              type="search"
              placeholder="Name or email"
              value={search}
              onChange={(changeEvent) => setSearch(changeEvent.target.value)}
            />
          </>
        }
      >
        <div className="field" style={{ marginBottom: 16, maxWidth: 420 }}>
          <label className="label" htmlFor="reg-note">
            Decision note <span className="muted small">optional, recorded on every decision below</span>
          </label>
          <input
            id="reg-note"
            className="input"
            value={note}
            placeholder="e.g. Judging experience confirmed at the April meetup"
            onChange={(changeEvent) => setNote(changeEvent.target.value)}
          />
        </div>

        {loading ? <span className="muted small">Loading…</span> : null}

        {!loading && rows.length === 0 ? (
          <Empty title="No applications match">
            {search.trim() !== '' || state !== undefined
              ? 'Clear the filter to see the whole queue.'
              : 'Nobody has applied yet. Check that the registration window is open.'}
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <>
            <div className="row row--wrap" style={{ gap: 8, marginBottom: 12 }}>
              <label className="row small" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)))}
                />
                Select all on this page
              </label>
              {selected.size > 0 ? (
                <>
                  <span className="small muted">{String(selected.size)} selected</span>
                  <button type="button" className="button button--sm" disabled={busy} onClick={() => void bulk('ACCEPTED')}>
                    Accept
                  </button>
                  <button type="button" className="button button--sm" disabled={busy} onClick={() => void bulk('WAITLISTED')}>
                    Waitlist
                  </button>
                  <button type="button" className="button button--sm" disabled={busy} onClick={() => void bulk('REJECTED')}>
                    Reject
                  </button>
                </>
              ) : null}
            </div>

            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 34 }}>
                      <span className="sr-only">Select</span>
                    </th>
                    <th scope="col">Applicant</th>
                    <th scope="col" style={{ width: 120 }}>State</th>
                    <th scope="col" style={{ width: 170 }}>Applied</th>
                    <th scope="col" style={{ width: 240 }}>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} aria-label={`Select ${row.display_name}`} />
                      </td>
                      <td>
                        <div className="strong">{row.full_name || row.display_name}</div>
                        <div className="small muted">{row.email}</div>
                        {parseJsonArray(row.skills).length > 0 ? (
                          <div className="row row--wrap" style={{ gap: 4, marginTop: 4 }}>
                            {parseJsonArray(row.skills).slice(0, 5).map((skill) => (
                              <span key={skill} className="badge tiny">{skill}</span>
                            ))}
                          </div>
                        ) : null}
                        {row.decision_note ? <div className="tiny dim" style={{ marginTop: 4 }}>“{row.decision_note}”</div> : null}
                      </td>
                      <td>
                        <span className={`badge ${row.state === 'ACCEPTED' ? 'badge--ok' : row.state === 'REJECTED' ? 'badge--bad' : row.state === 'WAITLISTED' ? 'badge--warn' : ''}`}>
                          {stateLabel(row.state)}
                        </span>
                      </td>
                      <td className="small muted">{formatInstant(row.submitted_at)}</td>
                      <td>
                        <div className="row row--wrap" style={{ gap: 5 }}>
                          {(['ACCEPTED', 'REJECTED', 'WAITLISTED'] as const)
                            .filter((to) => to !== row.state)
                            .map((to) => (
                              <button
                                key={to}
                                type="button"
                                className="button button--sm"
                                disabled={busy}
                                onClick={() => void decide(row.id, to)}
                              >
                                {stateLabel(to)}
                              </button>
                            ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </Panel>

      <Panel title="Export" description="CSV, including every custom form response, so the queue can be worked in a spreadsheet and re-imported.">
        <a className="button" href={`/api/events/${eventId}/registrations/export`}>
          Download registrations CSV
        </a>
      </Panel>
    </div>
  );
}

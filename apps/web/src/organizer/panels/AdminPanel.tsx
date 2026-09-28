import { useState } from 'react';
import { api, type AdminOverview, type PublicUser } from '../../api.ts';
import { Empty, formatNumber, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * The platform operator view (ADMIN only).
 *
 * Two things live here that have nowhere else to go:
 *
 *   - **Event creation.** `create event` is granted at ANY scope, so only a
 *     global admin can make one. That is deliberate: an event is a
 *     platform-wide object, and letting any organizer mint one would let an
 *     organizer on event A create event B and then be its organizer. The cost
 *     is that the first event on an instance is always an operator's job, which
 *     is what this screen is for.
 *
 *   - **Role grants.** Event-scoped organizer and judge roles are handed out
 *     here, and every grant is audited. The published matrix is shown in full
 *     because the security model should be inspectable by the people who most
 *     need to check it — an integrator can see exactly what the platform allows
 *     without reading the source.
 */
export function AdminPanel() {
  const { data, loading } = useApi<AdminOverview>('/api/admin/overview');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'events' | 'users' | 'matrix'>('events');

  return (
    <div className="stack">
      <Panel title="System" description="Counts read straight from the database. Nothing here is cached or estimated." error={error}>
        {loading ? <span className="muted small">Loading…</span> : null}
        {data === null ? null : (
          <>
            <div className="metrics metrics--tight">
              <div className="metric">
                <div className="metric__label">Users</div>
                <div className="metric__value">{String(data.users.total)}</div>
                <div className="metric__hint">{String(data.users.active)} active · {String(data.users.suspended)} not</div>
              </div>
              <div className="metric">
                <div className="metric__label">Events</div>
                <div className="metric__value">{String(data.events)}</div>
              </div>
              <div className="metric">
                <div className="metric__label">Published results</div>
                <div className="metric__value">{String(data.publishedResults)}</div>
              </div>
              <div className="metric">
                <div className="metric__label">Open review flags</div>
                <div className="metric__value">{String(data.openAnomalies)}</div>
              </div>
              <div className="metric">
                <div className="metric__label">Webhook failures</div>
                <div className="metric__value">{String(data.webhookFailures)}</div>
              </div>
              <div className="metric">
                <div className="metric__label">Database</div>
                <div className="metric__value" style={{ fontSize: '1rem' }}>{data.database.ok ? 'Healthy' : 'Degraded'}</div>
                <div className="metric__hint">{String(Object.keys(data.tables).length)} tables</div>
              </div>
            </div>
            {data.database.ok === false ? (
              <div className="notice notice--error" style={{ marginTop: 12 }}>{data.database.detail}</div>
            ) : null}
          </>
        )}
      </Panel>

      <div className="row" style={{ gap: 6 }} role="tablist" aria-label="Platform sections">
        {(['events', 'users', 'matrix'] as const).map((value) => (
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

      {tab === 'events' ? <CreateEvent error={error} setError={setError} busy={busy} setBusy={setBusy} /> : null}
      {tab === 'users' ? <Users error={error} setError={setError} busy={busy} setBusy={setBusy} /> : null}
      {tab === 'matrix' ? <Matrix data={data} /> : null}
    </div>
  );
}

function CreateEvent({
  error,
  setError,
  busy,
  setBusy,
}: {
  error: unknown;
  setError: (value: unknown) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [tagline, setTagline] = useState('');

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/events', {
        name: name.trim(),
        slug: slug.trim() === '' ? name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : slug.trim(),
        timezone,
        ...(tagline.trim() === '' ? {} : { tagline: tagline.trim() }),
      });
      setName('');
      setSlug('');
      setTagline('');
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Create an event"
      description="Only a platform administrator can create an event, and the creator becomes its organizer. A default application form is created so the event is immediately usable. Every other event on this instance is then run by someone the administrator grants an event-scoped role."
      error={error}
    >
      <div className="row row--wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: '1 1 240px' }}>
          <label className="label" htmlFor="ev-name">Name</label>
          <input id="ev-name" className="input" value={name} onChange={(changeEvent) => setName(changeEvent.target.value)} />
        </div>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label className="label" htmlFor="ev-slug">Slug <span className="muted small">optional</span></label>
          <input id="ev-slug" className="input" value={slug} placeholder="derived from the name" onChange={(changeEvent) => setSlug(changeEvent.target.value)} />
        </div>
        <div className="field" style={{ width: 150 }}>
          <label className="label" htmlFor="ev-tz">Timezone</label>
          <input id="ev-tz" className="input" value={timezone} onChange={(changeEvent) => setTimezone(changeEvent.target.value)} />
        </div>
      </div>
      <div className="field" style={{ marginTop: 10, maxWidth: 520 }}>
        <label className="label" htmlFor="ev-tagline">Tagline <span className="muted small">optional</span></label>
        <input id="ev-tagline" className="input" value={tagline} onChange={(changeEvent) => setTagline(changeEvent.target.value)} />
      </div>
      <button type="button" className="button button--primary" style={{ marginTop: 14 }} disabled={busy || name.trim().length < 3} onClick={() => void submit()}>
        {busy ? 'Creating…' : 'Create event'}
      </button>
    </Panel>
  );
}

function Users({
  error,
  setError,
  busy,
  setBusy,
}: {
  error: unknown;
  setError: (value: unknown) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const { data, loading, reload } = useApi<{ data: PublicUser[] }>(
    query.trim().length >= 2 ? `/api/users/search?search=${encodeURIComponent(query.trim())}` : null,
  );
  const [role, setRole] = useState<'PARTICIPANT' | 'JUDGE' | 'ORGANIZER' | 'ADMIN'>('ORGANIZER');
  const [eventId, setEventId] = useState('');
  const { data: events } = useApi<{ data: { id: string; name: string }[] }>('/api/events?perPage=200');

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

  return (
    <Panel
      title="Users and roles"
      description="Event-scoped roles take an event id; admin and participant are global. Every grant and revocation is audited, because a role is the thing an attacker most wants."
      error={error}
      actions={
        <>
          <label className="sr-only" htmlFor="us-search">Search users</label>
          <input
            id="us-search"
            className="input"
            style={{ width: 200 }}
            type="search"
            placeholder="Search name or email"
            value={query}
            onChange={(changeEvent) => setQuery(changeEvent.target.value)}
          />
        </>
      }
    >
      <div className="row row--wrap" style={{ gap: 10, alignItems: 'flex-end', marginBottom: 16 }}>
        <div className="field" style={{ width: 180 }}>
          <label className="label" htmlFor="us-role">Role</label>
          <select id="us-role" className="select" value={role} onChange={(changeEvent) => setRole(changeEvent.target.value as typeof role)}>
            <option value="ORGANIZER">Organizer</option>
            <option value="JUDGE">Judge</option>
            <option value="PARTICIPANT">Participant</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 240px' }}>
          <label className="label" htmlFor="us-event">
            Event scope <span className="muted small">{role === 'ORGANIZER' || role === 'JUDGE' ? 'required' : 'not used'}</span>
          </label>
          <select id="us-event" className="select" value={eventId} onChange={(changeEvent) => setEventId(changeEvent.target.value)}>
            <option value="">Platform-wide</option>
            {(events?.data ?? []).map((row) => (
              <option key={row.id} value={row.id}>{row.name}</option>
            ))}
          </select>
        </div>
      </div>

      {query.trim().length < 2 ? (
        <Empty title="Search for someone">
          Type at least two characters. The search is organizer-and-admin only, and returns public profile fields only.
        </Empty>
      ) : loading ? (
        <span className="muted small">Searching…</span>
      ) : (data?.data.length ?? 0) === 0 ? (
        <Empty title="No matching users">Nothing matched “{query.trim()}”.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col" style={{ width: 200 }}>Roles</th>
                <th scope="col" style={{ width: 110 }}>State</th>
                <th scope="col" style={{ width: 220 }} />
              </tr>
            </thead>
            <tbody>
              {(data?.data ?? []).map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="strong">{row.displayName}</div>
                    <div className="small muted">{row.email}</div>
                  </td>
                  <td>
                    <div className="row row--wrap" style={{ gap: 4 }}>
                      {row.roles.length === 0 ? <span className="muted small">none</span> : row.roles.map((value) => (
                        <span key={value} className="badge tiny">{value}</span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${row.state === 'ACTIVE' ? 'badge--ok' : 'badge--warn'}`}>{stateLabel(row.state ?? 'UNKNOWN')}</span>
                  </td>
                  <td>
                    <div className="row row--wrap" style={{ gap: 5 }}>
                      <button
                        type="button"
                        className="button button--sm"
                        disabled={busy || (role === 'ORGANIZER' || role === 'JUDGE') && eventId === ''}
                        onClick={() => void act(() => api.post(`/api/admin/users/${row.id}/roles`, { role, eventId: eventId === '' ? null : eventId, revoke: false }))}
                      >
                        Grant
                      </button>
                      <button
                        type="button"
                        className="button button--sm button--danger"
                        disabled={busy}
                        onClick={() => void act(() => api.post(`/api/admin/users/${row.id}/roles`, { role, eventId: eventId === '' ? null : eventId, revoke: true }))}
                      >
                        Revoke
                      </button>
                      {row.state === 'ACTIVE' ? (
                        <button
                          type="button"
                          className="button button--sm"
                          disabled={busy}
                          onClick={() => void act(() => api.post(`/api/admin/users/${row.id}/state`, { state: 'SUSPENDED' }))}
                        >
                          Suspend
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button button--sm"
                          disabled={busy}
                          onClick={() => void act(() => api.post(`/api/admin/users/${row.id}/state`, { state: 'ACTIVE' }))}
                        >
                          Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Matrix({ data }: { data: AdminOverview | null }) {
  if (data === null) return null;
  return (
    <Panel
      title="Authorization matrix"
      description="The live policy, exactly as the server enforces it. `null` means never granted. This is also published unauthenticated at /api/rbac/matrix, because a security model you cannot inspect is not much of a security model."
    >
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Granted cells</th>
              <th scope="col" style={{ width: 120 }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {data.authorizationMatrix.map((role) => (
              <tr key={role.role}>
                <td className="strong">{role.role}</td>
                <td>
                  <div className="row row--wrap" style={{ gap: 4 }}>
                    {role.role === 'ADMIN' ? (
                      <span className="small muted">Every action, at ANY scope. Generated rather than typed out.</span>
                    ) : (
                      role.grants
                        .filter((grant) => grant.scope !== null)
                        .map((grant) => (
                          <span key={`${grant.action}:${grant.resource}`} className="badge tiny">
                            {grant.action} {grant.resource}
                          </span>
                        ))
                    )}
                  </div>
                </td>
                <td className="num">
                  {role.role === 'ADMIN'
                    ? formatNumber(role.grants.length, 0)
                    : String(role.grants.filter((grant) => grant.scope !== null).length)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

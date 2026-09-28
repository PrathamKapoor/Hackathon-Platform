import { useState } from 'react';
import { api, type TeamRow } from '../../api.ts';
import { Empty, ErrorNotice, formatInstant, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * Team roster.
 *
 * Frozen teams are shown as frozen rather than hidden, because "why can I not
 * change this" is the question an organizer actually has during a hackathon, and
 * the answer belongs on the screen. Membership changes on a frozen team need the
 * override path, which requires a written justification and is audited.
 */
export function TeamsPanel({ eventId }: { eventId: string }) {
  const [search, setSearch] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const query = new URLSearchParams({ perPage: '200' });
  if (search.trim() !== '') query.set('search', search.trim());
  const { data, loading } = useApi<{ data: TeamRow[] }>(`/api/events/${eventId}/teams?${query.toString()}`);

  const rows = data?.data ?? [];

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Panel
        title="Teams"
        description="A team is frozen once the event's submission window has closed. That is a deadline, not a bug, and the override below records who changed a frozen team and why."
        error={error}
        actions={
          <input
            className="input"
            style={{ width: 200 }}
            type="search"
            placeholder="Search teams"
            aria-label="Search teams"
            value={search}
            onChange={(changeEvent) => setSearch(changeEvent.target.value)}
          />
        }
      >
        {loading ? <span className="muted small">Loading…</span> : null}
        {!loading && rows.length === 0 ? (
          <Empty title="No teams yet">
            Participants form teams from their workspace once they have registered. Nothing to do here yet.
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  <th scope="col" style={{ width: 90 }}>Members</th>
                  <th scope="col" style={{ width: 110 }}>State</th>
                  <th scope="col" style={{ width: 170 }}>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="strong">{row.name}</div>
                      {row.description ? <div className="small muted">{row.description}</div> : null}
                      {row.organization ? <div className="tiny dim">{row.organization}</div> : null}
                    </td>
                    <td className="num">{String(row.memberCount)}</td>
                    <td>
                      {row.is_locked === 1 ? (
                        <span className="badge badge--warn">Frozen</span>
                      ) : (
                        <span className="badge badge--ok">Open</span>
                      )}
                    </td>
                    <td className="small muted">{formatInstant(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Override a frozen team"
        description="For the real case: a team member's account failed, or a substitution has to be recorded. The reason is mandatory and lands in the audit ledger, so this is not a quiet edit."
      >
        <OverrideForm
          disabled={busy}
          onSubmit={(userId, action, reason) =>
            act(async () => {
              await api.post(`/api/teams/${userId.teamId}/override`, { userId: userId.userId, action, reason });
            })
          }
          teams={rows}
        />
      </Panel>
    </div>
  );
}

function OverrideForm({
  teams,
  disabled,
  onSubmit,
}: {
  teams: TeamRow[];
  disabled: boolean;
  onSubmit: (input: { teamId: string; userId: string }, action: 'add' | 'remove', reason: string) => Promise<void>;
}) {
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '');
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<'add' | 'remove'>('add');
  const [local, setLocal] = useState<unknown>(null);

  const team = teams.find((row) => row.id === teamId);
  const { data: detail } = useApi<{ members: { user_id: string; display_name: string; role: string }[] }>(
    teamId === '' ? null : `/api/teams/${teamId}`,
  );

  const valid = teamId !== '' && userId.trim() !== '' && reason.trim().length >= 8;

  return (
    <div className="stack stack--tight">
      <div className="row row--wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
        <div className="field">
          <label className="label" htmlFor="ov-team">Team</label>
          <select id="ov-team" className="select" value={teamId} onChange={(changeEvent) => { setTeamId(changeEvent.target.value); setUserId(''); }}>
            {teams.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}{row.is_locked === 1 ? ' (frozen)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label className="label" htmlFor="ov-user">User id or username</label>
          <input
            id="ov-user"
            className="input"
            value={userId}
            list="ov-users"
            placeholder={detail?.members[0]?.display_name ?? 'member id'}
            onChange={(changeEvent) => setUserId(changeEvent.target.value)}
          />
          <datalist id="ov-users">
            {(detail?.members ?? []).map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.display_name} ({stateLabel(member.role)})
              </option>
            ))}
          </datalist>
        </div>
        <div className="field">
          <label className="label" htmlFor="ov-action">Action</label>
          <select id="ov-action" className="select" value={action} onChange={(changeEvent) => setAction(changeEvent.target.value as 'add' | 'remove')}>
            <option value="add">Add member</option>
            <option value="remove">Remove member</option>
          </select>
        </div>
      </div>
      <div className="field" style={{ maxWidth: 640 }}>
        <label className="label" htmlFor="ov-reason">Justification (at least 8 characters)</label>
        <input id="ov-reason" className="input" value={reason} onChange={(changeEvent) => setReason(changeEvent.target.value)} />
      </div>
      {local !== null ? <ErrorNotice error={local} /> : null}
      <div>
        <button
          type="button"
          className="button"
          disabled={disabled || !valid}
          onClick={() => {
            setLocal(null);
            void onSubmit({ teamId, userId: userId.trim() }, action, reason.trim()).catch((cause: unknown) => setLocal(cause));
          }}
        >
          Apply override
        </button>
        {team !== undefined && team.is_locked === 1 ? (
          <span className="small muted" style={{ marginLeft: 10 }}>
            {team.name} is frozen, so this will be recorded as an override.
          </span>
        ) : null}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { useSession } from '../session.tsx';
import { Empty, ErrorNotice, Loading, useApi } from '../ui.tsx';

/**
 * Team invitation.
 *
 * `POST /api/teams/:id/invitations` returns `${PUBLIC_URL}/invite/${code}`, and
 * no route matched it, so every invitation link an organizer or team captain
 * shared landed on the app's 404. Invitations are how a team forms at all, so
 * this was a dead end in the middle of the most time-critical flow a
 * participant has.
 *
 * The preview deliberately does not disclose the invited address to a signed-out
 * visitor: the server returns `forYou: false` and the reason, so a leaked link
 * cannot be used to discover who a team is trying to recruit. Accepting without
 * the right account is refused by the server, not hidden here.
 */
export function InvitePage() {
  const { code } = useParams<{ code: string }>();
  const session = useSession();
  const navigate = useNavigate();

  const path = code === undefined ? null : `/api/invitations/${encodeURIComponent(code)}`;
  const { data, error, loading, reload } = useApi<{
    team: { name: string };
    event: { name: string; slug: string };
    status: string;
    expiresAt: string;
    forYou: boolean;
    note?: string;
  }>(path);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  if (loading) return <Loading label="Checking this invitation" />;
  if (error !== null) {
    return (
      <div className="page">
        <ErrorNotice error={error} />
      </div>
    );
  }
  if (data === null) return <Loading />;

  const act = async (accept: boolean): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      if (accept) await api.post(`/api/invitations/${encodeURIComponent(code as string)}/accept`, {});
      else await api.post(`/api/invitations/${encodeURIComponent(code as string)}/reject`, {});
      if (accept) {
        // The event is now in the user's scope, so the workspace can show it.
        await session.refresh();
        navigate('/workspace');
        return;
      }
      reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause : new Error(String(cause)));
    } finally {
      setBusy(false);
    }
  };

  const alreadyMember = data.status === 'ACCEPTED';

  return (
    <div className="page">
      <h1>Team invitation</h1>

      <section className="card card--pad" style={{ marginTop: 16 }}>
        <p className="muted small">You have been invited to join</p>
        <h2 style={{ marginTop: 4, fontSize: '1.3rem' }}>{data.team.name}</h2>
        <p className="small" style={{ marginTop: 6 }}>
          at <Link to={`/e/${encodeURIComponent(data.event.slug)}`}>{data.event.name}</Link>
        </p>
        <p className="tiny dim" style={{ marginTop: 10 }}>
          Status: {data.status.toLowerCase()} · expires {new Date(data.expiresAt).toLocaleString()}
        </p>
      </section>

      <ErrorNotice error={actionError} />

      {alreadyMember ? (
        <div style={{ marginTop: 16 }}>
          <Empty title="You are already on this team">
            Nothing to do. <Link to="/workspace">Open your workspace</Link>.
          </Empty>
        </div>
      ) : data.status !== 'PENDING' ? (
        <div style={{ marginTop: 16 }}>
          <Empty title="This invitation is no longer open">
            It has already been {data.status.toLowerCase()}. Ask a team captain for a new one.
          </Empty>
        </div>
      ) : session.user === null ? (
        <div style={{ marginTop: 16 }}>
          <Empty title="Sign in to accept">
            Invitations are tied to the address they were sent to. <Link to="/signin">Sign in</Link> with that address, then
            reopen this link.
          </Empty>
        </div>
      ) : !data.forYou ? (
        <div style={{ marginTop: 16 }}>
          <Empty title="This invitation is for a different address">
            {data.note ?? 'Sign in with the address this invitation was sent to.'} You are signed in as{' '}
            {session.user.email}.
          </Empty>
        </div>
      ) : (
        <div className="row row--wrap" style={{ gap: 10, marginTop: 20 }}>
          <button type="button" className="button button--primary" disabled={busy} onClick={() => void act(true)}>
            {busy ? 'Joining…' : `Join ${data.team.name}`}
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => void act(false)}>
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

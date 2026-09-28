import { useState } from 'react';
import { api, type CommentRow, type VoteReport } from '../../api.ts';
import { Empty, formatInstant, formatNumber, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * Community: voting activity and comment moderation.
 *
 * The voting report is deliberately framed as something a human reads, not a
 * score. Concentration and velocity are shown because they are worth noticing;
 * nothing here is evidence of abuse on its own, and no account is ever
 * automatically disqualified. Vote integrity is enforced at write time —
 * authentication, registration eligibility, no self-voting through team
 * membership, a UNIQUE constraint per (event, project, account), a per-account
 * hourly rate limit and a server-side window — so this page is reviewing
 * behaviour the database has already bounded, not deciding who cheated.
 */
export function CommunityPanel({ eventId }: { eventId: string }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const { data: report } = useApi<VoteReport>(`/api/events/${eventId}/votes/report`);
  const { data: queue, reload } = useApi<{ data: CommentRow[] }>(`/api/events/${eventId}/comments/moderation`);

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
    <div className="stack">
      <Panel
        title="Voting activity"
        description="For a human to review. Nothing here is treated as evidence of abuse on its own, and no account is ever auto-disqualified."
      >
        {report === null ? (
          <span className="muted small">Loading…</span>
        ) : (
          <>
            <div className="metrics metrics--tight">
              <div className="metric">
                <div className="metric__label">Total votes</div>
                <div className="metric__value">{String(report.totalVotes)}</div>
                <div className="metric__hint">{report.totalsVisible ? 'visible to the public' : 'hidden from the public'}</div>
              </div>
              <div className="metric">
                <div className="metric__label">Distinct voters</div>
                <div className="metric__value">{String(report.distinctVoters)}</div>
              </div>
              <div className="metric">
                <div className="metric__label">Votes per voter</div>
                <div className="metric__value">{formatNumber(report.votesPerVoter)}</div>
                <div className="metric__hint">mean across accounts</div>
              </div>
              <div className="metric">
                <div className="metric__label">Window</div>
                <div className="metric__value" style={{ fontSize: '0.95rem' }}>
                  {formatInstant(report.window.opensAt)}
                </div>
                <div className="metric__hint">closes {formatInstant(report.window.closesAt)}</div>
              </div>
            </div>

            <p className="small muted" style={{ marginTop: 16 }}>{report.note}</p>

            {report.topAccounts.length > 0 ? (
              <div className="table-wrap" style={{ marginTop: 16 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col" style={{ width: 90 }}>Votes</th>
                      <th scope="col" style={{ width: 90 }}>Share</th>
                      <th scope="col" style={{ width: 170 }}>First vote</th>
                      <th scope="col" style={{ width: 170 }}>Last vote</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.topAccounts.map((account) => (
                      <tr key={account.userId}>
                        <td>
                          <div className="strong">{account.displayName}</div>
                          <div className="tiny dim">{account.email}</div>
                        </td>
                        <td className="num">{String(account.votes)}</td>
                        <td className="num">{formatNumber(account.share * 100, 1)}%</td>
                        <td className="small muted">{formatInstant(account.firstVoteAt)}</td>
                        <td className="small muted">{formatInstant(account.lastVoteAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No votes yet">
                Voting has not started, or nobody has voted. Check the voting window in the event settings.
              </Empty>
            )}
          </>
        )}
      </Panel>

      <Panel
        title="Comment moderation"
        description="Reported comments and first comments from new accounts, which are held for approval. Moderation is a state change, not a delete: the row is retained so the history survives."
        error={error}
      >
        <div className="field" style={{ marginBottom: 16, maxWidth: 560 }}>
          <label className="label" htmlFor="mod-note">
            Moderation note <span className="muted small">stored with the action</span>
          </label>
          <input
            id="mod-note"
            className="input"
            value={note}
            placeholder="e.g. Link to an unrelated commercial site"
            onChange={(changeEvent) => setNote(changeEvent.target.value)}
          />
        </div>

        {(queue?.data ?? []).length === 0 ? (
          <Empty title="Nothing to moderate">
            No reported comments and nothing held for approval. A first comment from a brand-new account is the only
            pre-moderation rule, so this fills up only when someone reports something.
          </Empty>
        ) : (
          <div className="stack stack--tight">
            {(queue?.data ?? []).map((comment) => (
              <div key={comment.id} className="flag">
                <div className="row row--between row--wrap" style={{ gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row row--wrap" style={{ gap: 6 }}>
                      <span className="badge">{comment.authorName}</span>
                      <span className={`badge ${comment.state === 'PENDING' ? 'badge--warn' : comment.reportCount > 0 ? 'badge--bad' : ''}`}>
                        {stateLabel(comment.state)}
                      </span>
                      {comment.reportCount > 0 ? (
                        <span className="badge badge--bad">{String(comment.reportCount)} report(s)</span>
                      ) : null}
                      <span className="tiny dim">{formatInstant(comment.createdAt)}</span>
                    </div>
                    <p className="small" style={{ marginTop: 8, marginBottom: 0 }}>{comment.body}</p>
                  </div>
                  <div className="row row--wrap" style={{ gap: 6 }}>
                    {(['VISIBLE', 'HIDDEN', 'PENDING'] as const)
                      .filter((to) => to !== comment.state)
                      .map((to) => (
                        <button
                          key={to}
                          type="button"
                          className={`button button--sm ${to === 'HIDDEN' ? 'button--danger' : ''}`}
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              api.post(`/api/comments/${comment.id}/moderate`, {
                                state: to,
                                ...(note.trim() === '' ? {} : { note: note.trim() }),
                              }),
                            )
                          }
                        >
                          Mark {to.toLowerCase()}
                        </button>
                      ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

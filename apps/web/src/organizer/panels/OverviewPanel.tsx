import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AssignmentView, type EventSummary, type ScoreTableRow } from '../../api.ts';
import { Empty, formatInstant, formatNumber, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * Event overview.
 *
 * Every number here is counted from a real endpoint. There is no hard-coded
 * "142 submissions" anywhere in this file: if the seed changes, these change
 * with it, and a wrong number is a bug rather than a stale copy.
 *
 * The window statuses come from the event's own dates, so "registration is
 * open" is the server's answer rather than the client's arithmetic on
 * `Date.now()` — which matters because the client's clock is not the server's.
 */
export function OverviewPanel({ eventId }: { eventId: string }) {
  const { data: event } = useApi<EventSummary>(`/api/events/${eventId}`);
  const { data: registrations } = useApi<{ pagination: { total: number }; byState: Record<string, number> }>(
    `/api/events/${eventId}/registrations?perPage=1`,
  );
  const { data: teams } = useApi<{ pagination: { total: number } }>(`/api/events/${eventId}/teams?perPage=1`);
  const { data: submissions } = useApi<{ pagination: { total: number } }>(`/api/events/${eventId}/submissions?perPage=1`);
  const { data: judges } = useApi<{ data: unknown[] }>(`/api/events/${eventId}/judges?perPage=200`);
  const { data: assignments } = useApi<AssignmentView>(`/api/events/${eventId}/assignments?perPage=1`);
  const { data: scores } = useApi<{ data: ScoreTableRow[] }>(`/api/events/${eventId}/scores`);
  const { data: results } = useApi<{ published: boolean; snapshot: { integrityHash: string; publishedAt: string; entryCount: number } | null }>(
    `/api/events/${eventId}/results`,
  );

  const [transitionError, setTransitionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const coverage = assignments?.coverage ?? [];
  const short = coverage.filter((row) => row.completed < row.target);
  const totalAssigned = coverage.reduce((sum, row) => sum + row.assigned, 0);
  const totalCompleted = coverage.reduce((sum, row) => sum + row.completed, 0);
  const overallProgress = totalAssigned === 0 ? null : Math.round((totalCompleted / totalAssigned) * 100);

  const move = async (to: string): Promise<void> => {
    setBusy(true);
    setTransitionError(null);
    try {
      await api.post(`/api/events/${eventId}/transition`, { to, override: false, reason: 'Moved from the organizer console.' });
      window.location.reload();
    } catch (cause) {
      setTransitionError(cause);
    } finally {
      setBusy(false);
    }
  };

  if (event === null) return <Empty title="Loading this event" />;

  return (
    <div className="stack">
      <Panel
        title={event.name}
        description={
          <>
            {stateLabel(event.state)} · {event.timezone} · <Link to={`/e/${event.slug}`}>public page</Link> ·{' '}
            <Link to={`/e/${event.slug}/gallery`}>gallery</Link>
          </>
        }
        error={transitionError}
      >
        <div className="metrics">
          <Metric label="Registrations" value={String(registrations?.pagination?.total ?? '—')} hint={byStateHint(registrations?.byState)} />
          <Metric label="Teams" value={String(teams?.pagination.total ?? '—')} />
          <Metric label="Projects" value={String(submissions?.pagination.total ?? '—')} />
          <Metric label="Judges" value={String(judges?.data.length ?? '—')} />
          <Metric
            label="Judging"
            value={overallProgress === null ? '—' : `${String(overallProgress)}%`}
            hint={totalAssigned === 0 ? 'no assignments yet' : `${String(totalCompleted)}/${String(totalAssigned)} reviews`}
          />
          <Metric
            label="Results"
            value={results?.published === true ? 'Published' : 'Unpublished'}
            hint={
              results?.published === true && results.snapshot !== null
                ? `${String(results.snapshot.entryCount)} entries · ${formatInstant(results.snapshot.publishedAt)}`
                : 'nothing published'
            }
          />
        </div>
      </Panel>

      {short.length > 0 ? (
        <Panel
          title={`${String(short.length)} project${short.length === 1 ? '' : 's'} below the review target`}
          description="These publish with a coverage flag rather than being dropped, which is the honest outcome. Chase the missing reviews or lower the target deliberately and say so in the announcement."
        >
          <div className="row row--wrap" style={{ gap: 6 }}>
            {short.slice(0, 12).map((row) => (
              <span key={row.projectId} className="badge badge--warn">
                {row.projectName} · {String(row.target - row.completed)} short
              </span>
            ))}
            {short.length > 12 ? <span className="badge">+{String(short.length - 12)} more</span> : null}
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Lifecycle"
        description="Transitions are decided by the server's state machine, not by this list. An illegal move returns 409 with the machine's own explanation, and some moves need an explicit override with a reason."
      >
        <div className="row row--wrap" style={{ gap: 8 }}>
          {NEXT[event.state]?.map((to) => (
            <button key={to} type="button" className="button button--sm" disabled={busy} onClick={() => void move(to)}>
              Move to {stateLabel(to).toLowerCase()}
            </button>
          )) ?? <span className="small muted">No forward transitions are available from {stateLabel(event.state).toLowerCase()}.</span>}
        </div>
        <dl className="windows">
          <Window label="Registration closes" at={event.dates.registration.closesAt} />
          <Window label="Submissions close" at={event.dates.submission.closesAt} />
          <Window label="Judging closes" at={event.dates.judging.closesAt} />
          <Window label="Voting closes" at={event.dates.voting.closesAt} />
          <Window label="Results published" at={event.dates.resultsPublishedAt} />
        </dl>
      </Panel>

      {scores !== null && scores.data.length > 0 ? (
        <Panel
          title="Score table"
          description="Raw, per project, before any normalization. A wide spread means the panel disagreed, not that the project is unusual — check the per-criterion breakdown before changing the rubric."
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col" className="num">Mean</th>
                  <th scope="col" className="num">Min</th>
                  <th scope="col" className="num">Max</th>
                  <th scope="col" className="num">Spread</th>
                </tr>
              </thead>
              <tbody>
                {scores.data.map((row) => (
                  <tr key={row.submissionId}>
                    <td className="strong">{row.projectName}</td>
                    <td className="num">{formatNumber(row.meanScore)}</td>
                    <td className="num">{formatNumber(row.minScore)}</td>
                    <td className="num">{formatNumber(row.maxScore)}</td>
                    <td className="num">
                      {formatNumber(row.minScore !== null && row.maxScore !== null ? row.maxScore - row.minScore : null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

/**
 * The forward moves worth offering, derived from the machine's own table.
 *
 * This is a convenience list, not the policy: the server re-checks every one of
 * these, so a stale entry here costs an error message and nothing else.
 */
const NEXT: Record<string, string[] | undefined> = {
  DRAFT: ['PUBLISHED'],
  PUBLISHED: ['REGISTRATION_OPEN', 'CANCELLED'],
  REGISTRATION_OPEN: ['REGISTRATION_CLOSED', 'ACTIVE'],
  REGISTRATION_CLOSED: ['ACTIVE', 'DRAFT'],
  ACTIVE: ['SUBMISSION_CLOSED'],
  SUBMISSION_CLOSED: ['JUDGING'],
  JUDGING: ['RESULTS_PENDING', 'COMPLETED'],
  RESULTS_PENDING: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric">
      <div className="metric__label">{label}</div>
      <div className="metric__value">{value}</div>
      {hint !== undefined ? <div className="metric__hint">{hint}</div> : null}
    </div>
  );
}

function Window({ label, at }: { label: string; at: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{formatInstant(at)}</dd>
    </div>
  );
}

function byStateHint(byState: Record<string, number> | undefined): string | undefined {
  if (byState === undefined) return undefined;
  const accepted = byState['ACCEPTED'] ?? 0;
  const pending = byState['APPLICATION'] ?? 0;
  if (accepted === 0 && pending === 0) return 'none yet';
  return `${String(accepted)} accepted · ${String(pending)} awaiting a decision`;
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type AssignmentView,
  type ComputeRun,
  type Reproduction,
  type ScoreTableRow,
} from '../api.ts';
import { useSession } from '../session.tsx';
import { Empty, ErrorNotice, Loading, formatNumber, formatInstant, stateLabel, useApi } from '../ui.tsx';

/**
 * The organizer console.
 *
 * Ordered by what an organizer actually has to do, and by blast radius: check
 * coverage, then look at the score table, then compute, then freeze, then
 * publish. The publish button is only enabled once a snapshot exists, because
 * publishing is the one irreversible step.
 *
 * The role check at the top is a courtesy, not a control: a judge who navigates
 * here directly gets a message rather than a console full of `403`s. The server
 * refuses every request on this page regardless, which is covered by
 * `adversarial.test.ts` and by a browser journey.
 */
export function OrganizerPage() {
  const session = useSession();
  const eventId = session.user?.eventIds[0];
  const canOrganize = eventId !== undefined && session.canOrganize(eventId);

  const [tab, setTab] = useState<'coverage' | 'results'>('coverage');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<ComputeRun | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [verification, setVerification] = useState<Reproduction | null>(null);

  const { data: event } = useApi<{ slug: string; name: string; state: string; judging: { reviewsPerProject: number }; dates: { judging: { closesAt: string } } }>(
    eventId === undefined ? null : `/api/events/${eventId}`,
  );
  const { data: assignments, loading } = useApi<AssignmentView>(
    canOrganize ? `/api/events/${eventId}/assignments` : null,
  );
  const { data: scores, reload: reloadScores } = useApi<{ data: ScoreTableRow[] }>(
    canOrganize ? `/api/events/${eventId}/scores` : null,
  );

  /*
   * The role gate. Rendering nothing at all would leave a judge on a blank page
   * with no idea why, so this says what is wrong and what to do instead.
   */
  if (session.loading) return <Loading />;
  if (session.user === null) {
    return (
      <div className="page">
        <h1>Organizer console</h1>
        <Empty title="Sign in first">
          The organizer console is for event organizers. <Link to="/signin">Sign in</Link>.
        </Empty>
      </div>
    );
  }
  if (!canOrganize) {
    return (
      <div className="page">
        <h1>Organizer console</h1>
        <Empty title="You do not organize this event">
          {eventId === undefined
            ? 'You are not on a panel or organizing anything yet.'
            : 'Your account is not an organizer on this event.'}{' '}
          A platform administrator can grant the role. Every request on this page is refused by the server for anyone
          else, so this message is about clarity, not access.
        </Empty>
      </div>
    );
  }

  async function act<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (cause) {
      setError(cause);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const coverage = assignments?.coverage ?? [];
  const incomplete = coverage.filter((row) => row.completed < row.target);
  const canPublish = run !== null && snapshotId !== null;

  return (
    <div className="page page--wide">
      <div className="row row--between row--wrap" style={{ marginBottom: 20 }}>
        <div>
          <h1>Organizer console</h1>
          {event !== null ? (
            <p className="muted small" style={{ marginTop: 4 }}>
              <Link to={`/e/${event.slug}`}>{event.name}</Link> · {stateLabel(event.state)} · judging closes{' '}
              {formatInstant(event.dates.judging.closesAt)}
            </p>
          ) : null}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className={`button button--sm ${tab === 'coverage' ? 'button--primary' : ''}`}
            onClick={() => setTab('coverage')}
          >
            Judging
          </button>
          <button
            type="button"
            className={`button button--sm ${tab === 'results' ? 'button--primary' : ''}`}
            onClick={() => setTab('results')}
          >
            Results
          </button>
        </div>
      </div>

      <ErrorNotice error={error} />

      {tab === 'coverage' ? (
        <div className="stack">
          {incomplete.length > 0 ? (
            <div className="notice notice--warn">
              <div className="strong">
                {incomplete.length} project{incomplete.length === 1 ? '' : 's'} below the review target
              </div>
              <div className="small" style={{ marginTop: 4 }}>
                These will publish with a coverage flag rather than being dropped. Chase the missing reviews, or lower{' '}
                {event?.judging.reviewsPerProject ?? 3} deliberately and say so in the announcement.
              </div>
            </div>
          ) : null}

          {loading ? <Loading /> : null}

          {assignments !== null ? (
            <section className="card table-wrap">
              <h3 style={{ padding: '16px 20px 0' }}>Coverage by project</h3>
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col" style={{ width: 90 }}>
                      Assigned
                    </th>
                    <th scope="col" style={{ width: 90 }}>
                      Completed
                    </th>
                    <th scope="col" style={{ width: 90 }}>
                      Target
                    </th>
                    <th scope="col" style={{ width: 140 }}>
                      Coverage
                    </th>
                    <th scope="col" style={{ width: 110 }}>
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.map((row) => (
                    <tr key={row.projectId}>
                      <td className="strong">{row.projectName}</td>
                      <td className="num">{String(row.assigned)}</td>
                      <td className="num">{String(row.completed)}</td>
                      <td className="num">{String(row.target)}</td>
                      <td>
                        <div
                          className="meter"
                          role="progressbar"
                          aria-valuenow={Math.round(row.coverage * 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`${row.projectName} review coverage`}
                        >
                          <span style={{ width: `${String(Math.round(row.coverage * 100))}%` }} />
                        </div>
                        <div className="tiny dim">{formatNumber(row.coverage * 100, 0)}%</div>
                      </td>
                      <td>
                        {row.completed >= row.target ? (
                          <span className="badge badge--ok">Complete</span>
                        ) : (
                          <span className="badge badge--warn">Short by {String(row.target - row.completed)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {scores !== null ? (
            <section className="card table-wrap">
              <h3 style={{ padding: '16px 20px 0' }}>Score table</h3>
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col" style={{ width: 100 }}>
                      Mean
                    </th>
                    <th scope="col" style={{ width: 100 }}>
                      Min
                    </th>
                    <th scope="col" style={{ width: 100 }}>
                      Max
                    </th>
                    <th scope="col" style={{ width: 100 }}>
                      Spread
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {scores.data.map((row) => {
                    const spread = row.minScore !== null && row.maxScore !== null ? row.maxScore - row.minScore : null;
                    return (
                      <tr key={row.submissionId}>
                        <td className="strong">{row.projectName}</td>
                        <td className="num">{formatNumber(row.meanScore)}</td>
                        <td className="num">{formatNumber(row.minScore)}</td>
                        <td className="num">{formatNumber(row.maxScore)}</td>
                        <td className="num">{formatNumber(spread)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="tiny dim" style={{ padding: '12px 20px 16px' }}>
                A wide spread on one project usually means the panel disagreed, not that the project is unusual. Check the
                per-criterion breakdown before changing the rubric.
              </p>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <section className="card card--pad">
            <h3>Publish</h3>
            <p className="small muted" style={{ marginTop: 6, marginBottom: 16 }}>
              Four steps, in order. Computing is free and repeatable. Snapshotting freezes a run. Publishing is the only
              irreversible one — corrections are published as a new snapshot, never as an edit.
            </p>

            <div className="row row--wrap" style={{ gap: 10 }}>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await api.post<ComputeRun>(`/api/events/${eventId}/results/compute`, {});
                    setRun(result);
                    setVerification(null);
                    return result;
                  })
                }
              >
                1 · Compute
              </button>

              <button
                type="button"
                className="button"
                disabled={busy || run === null}
                onClick={() =>
                  void act(async () => {
                    const snapshot = await api.post<{ id: string; sequence: number; entry_count: number }>(
                      `/api/events/${eventId}/results/${run?.runId}/snapshot`,
                      {},
                    );
                    setSnapshotId(snapshot.id);
                    return snapshot;
                  })
                }
              >
                2 · Snapshot
              </button>

              <button
                type="button"
                className="button"
                disabled={busy || !canPublish}
                onClick={() =>
                  void act(async () => {
                    await api.post(`/api/events/${eventId}/results/snapshots/${snapshotId}/publish`, {});
                    reloadScores();
                    return true;
                  })
                }
              >
                3 · Publish
              </button>

              <button
                type="button"
                className="button"
                disabled={busy || !canPublish}
                onClick={() =>
                  void act(async () => {
                    const verdict = await api.post<Reproduction>(
                      `/api/events/${eventId}/results/snapshots/${snapshotId}/reproduce`,
                      {},
                    );
                    setVerification(verdict);
                    return verdict;
                  })
                }
              >
                4 · Verify reproduction
              </button>
            </div>

            {!canPublish ? (
              <p className="tiny dim" style={{ margin: '12px 0 0' }}>
                Snapshot and publish stay disabled until a run exists, because publishing a snapshot that was never taken
                would freeze a ranking nobody has seen.
              </p>
            ) : null}

            {busy ? (
              <div className="row" style={{ marginTop: 14 }}>
                <span className="spinner" aria-hidden="true" />
                <span className="small muted">Working…</span>
              </div>
            ) : null}
          </section>

          {run !== null ? (
            <section className="card card--pad">
              <h3>Last computed run</h3>
              <dl className="small" style={{ marginTop: 10 }}>
                <Line label="Run" value={run.runId} mono />
                <Line label="Entries" value={String(run.entries.length)} />
                <Line label="Rubric version" value={String(run.rubricVersion)} />
                <Line label="Assignment version" value={String(run.assignmentVersion)} />
                <Line label="Normalization" value={run.normalizationMethod} />
                <Line label="Aggregation" value={run.aggregationMethod} />
                <Line label="Integrity hash" value={run.integrityHash} mono wrap />
                <Line label="Input hash" value={run.inputHash} mono wrap />
              </dl>
              {run.warnings.length > 0 ? (
                <div className="notice notice--warn" style={{ marginTop: 12 }}>
                  <div className="strong small">
                    {run.warnings.length} warning{run.warnings.length === 1 ? '' : 's'} from the engine
                  </div>
                  <ul className="tiny" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {run.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}

          {verification !== null ? (
            <section className={`card card--pad ${verification.status === 'MATCH' ? 'notice--ok' : 'notice--error'}`}>
              <h3>Reproduction: {verification.status}</h3>
              <p className="small" style={{ marginTop: 6 }}>
                {verification.status === 'MATCH'
                  ? 'Recomputing the pipeline from the stored reviews produced exactly this ranking. Anyone can check it.'
                  : 'The engine no longer reproduces this snapshot. The differences below say where.'}
              </p>
              {verification.differences.length > 0 ? (
                <ul className="tiny" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                  {verification.differences.map((difference, index) => (
                    <li key={index}>{JSON.stringify(difference)}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {assignments !== null && assignments.data.length === 0 ? (
            <Empty title="No assignments yet">
              Assign judges before computing. A run with no assignments produces a ranking of nothing, which the engine
              will happily compute and which would be meaningless to publish.
            </Empty>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Line({ label, value, mono, wrap }: { label: string; value: string; mono?: boolean; wrap?: boolean }) {
  return (
    <div className="row row--between" style={{ padding: '5px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <span className="muted">{label}</span>
      <span className={mono ? 'mono' : ''} style={{ wordBreak: wrap === true ? 'break-all' : 'normal', textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}

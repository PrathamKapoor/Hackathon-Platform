import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EventSummary, ResultsBoard } from '../api.ts';
import { Empty, ErrorNotice, Loading, formatNumber, shortHash, stateLabel, useApi, validationBadge } from '../ui.tsx';

/**
 * The public results board.
 *
 * This is the page a losing team will read closely, so it is explicit about
 * the parts that usually get hidden: the snapshot's integrity hash, the judge
 * count per project, and any coverage warning. A result people trust is one
 * that shows its seams.
 */
export function ResultsPage({ eventRef }: { eventRef: string }) {
  const { data: event, loading: eventLoading } = useApi<EventSummary>(`/api/events/${encodeURIComponent(eventRef)}`);
  const { data, error, loading } = useApi<ResultsBoard>(`/api/events/${encodeURIComponent(eventRef)}/results`);
  const [showHash, setShowHash] = useState(false);

  if (eventLoading || loading) return <Loading label="Loading results" />;
  <ErrorNotice error={error} />;
  if (data === null) return null;

  if (!data.published || data.snapshot === null) {
    return (
      <div className="page">
        <h1>Results</h1>
        <Empty title="Not published yet">
          {event === null ? 'Results have not been published for this event.' : `${event.name} has not published results.`}{' '}
          Nothing is shown here until an organizer freezes a snapshot and publishes it — an unpublished run is not a
          result.
        </Empty>
      </div>
    );
  }

  return (
    <div className="page page--wide">
      <div className="row row--between row--wrap" style={{ marginBottom: 8 }}>
        <div>
          <h1>Results</h1>
          {event !== null ? (
            <p className="muted small">
              <Link to={`/e/${event.slug}`}>{event.name}</Link>
            </p>
          ) : null}
        </div>
        <div className="row row--wrap">
          {data.snapshot.isCorrection ? <span className="badge badge--warn">Correction</span> : null}
          <span className="badge">Snapshot {String(data.snapshot.sequence)}</span>
          <span className="badge">{data.entries.length} projects</span>
        </div>
      </div>

      <div className="notice notice--ok" style={{ marginBottom: 20 }}>
        <div className="row row--between row--wrap">
          <div>
            <div className="strong">Published {formatDate(data.snapshot.publishedAt)}</div>
            <div className="tiny muted">
              Frozen from result run <span className="mono">{shortHash(data.snapshot.id)}</span>. Every score below is
              reproducible from the stored reviews.
            </div>
          </div>
          <button type="button" className="button button--sm" onClick={() => setShowHash((v) => !v)} aria-expanded={showHash}>
            {showHash ? 'Hide' : 'Show'} integrity hash
          </button>
        </div>
        {showHash ? (
          <div className="mono tiny" style={{ marginTop: 10, wordBreak: 'break-all', userSelect: 'all' }}>
            {data.snapshot.integrityHash}
          </div>
        ) : null}
      </div>

      <div className="card table-wrap">
        <table className="data">
          <caption className="sr-only">Final ranking</caption>
          <thead>
            <tr>
              <th scope="col" style={{ width: 60 }}>
                Rank
              </th>
              <th scope="col">Project</th>
              <th scope="col">Track</th>
              {data.showJudgeCount ? (
                <th scope="col" style={{ width: 110 }}>
                  Judges
                </th>
              ) : null}
              <th scope="col" style={{ width: 110 }}>
                Score
              </th>
              <th scope="col" style={{ width: 150 }}>
                Validation
              </th>
              <th scope="col" style={{ width: 200 }}>
                Prizes
              </th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((entry) => {
              const badge = validationBadge(entry.validation);
              return (
                <tr key={entry.projectId}>
                  <td className="num strong" style={{ fontSize: 16 }}>
                    {entry.rank}
                  </td>
                  <td>
                    <div className="strong">{entry.projectName}</div>
                    <div className="tiny muted">{entry.shortDescription}</div>
                    {entry.notes.length > 0 ? (
                      <ul className="tiny muted" style={{ margin: '6px 0 0', paddingLeft: 16 }}>
                        {entry.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    ) : null}
                    {data.showCriterionBreakdown && entry.criteria.length > 0 ? (
                      <details style={{ marginTop: 6 }}>
                        <summary className="tiny muted" style={{ cursor: 'pointer' }}>
                          Criterion breakdown
                        </summary>
                        <div className="stack stack--tight" style={{ marginTop: 6 }}>
                          {entry.criteria.map((criterion) => (
                            <div key={criterion.criterionId} className="row row--between tiny">
                              <span className="muted">
                                {criterion.name} <span className="dim">×{formatNumber(criterion.weight, 2)}</span>
                              </span>
                              <span className="mono">{formatNumber(criterion.normalized, 3)}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </td>
                  <td>
                    {entry.track === null ? (
                      <span className="dim">—</span>
                    ) : (
                      <span className="row" style={{ gap: 6 }}>
                        <span
                          aria-hidden="true"
                          style={{ width: 9, height: 9, borderRadius: 999, background: entry.trackColor ?? 'var(--border-strong)' }}
                        />
                        <span className="small">{entry.track}</span>
                      </span>
                    )}
                  </td>
                  {data.showJudgeCount ? (
                    <td>
                      <div className="small">
                        {entry.judgeCount} {entry.judgeCount === 1 ? 'judge' : 'judges'}
                      </div>
                      <div className="meter" style={{ marginTop: 4 }}>
                        <span style={{ width: `${String(Math.round(entry.coverage * 100))}%` }} />
                      </div>
                    </td>
                  ) : null}
                  <td className="num">{formatNumber(entry.aggregateScore)}</td>
                  <td>
                    <span className={`badge ${badge.tone}`}>{badge.label}</span>
                  </td>
                  <td>
                    {entry.prizes.length === 0 ? (
                      <span className="dim small">—</span>
                    ) : (
                      <div className="row row--wrap" style={{ gap: 4 }}>
                        {entry.prizes.map((prize) => (
                          <span key={prize} className="badge badge--info">
                            {prize}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.entries.some((e) => e.validation !== 'OK') ? (
        <div className="notice notice--warn" style={{ marginTop: 20 }}>
          <div className="strong">Some projects were not fully judged</div>
          <div className="small" style={{ marginTop: 4 }}>
            A project flagged as low coverage was scored by fewer judges than this event asked for. It is shown at its
            rank, with the shortfall stated, rather than being quietly dropped.
          </div>
        </div>
      ) : null}

      <p className="tiny dim" style={{ marginTop: 20 }}>
        Scores are normalized per judge and aggregated by the published rubric. The snapshot is append-only: a correction
        is published as a new snapshot rather than an edit. <span className="mono">{stateLabel('reproducible')}</span>
      </p>
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

import { useState } from 'react';
import { api, type AnomalyRow, type ComparisonRow, type EventDiagnostics } from '../../api.ts';
import { Empty, formatInstant, formatNumber, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * ---------------------------------------------------------------------------
 * DIAGNOSTICS
 * ---------------------------------------------------------------------------
 * The framing matters more than the numbers. Nothing here is an accusation. A
 * judge with a high mean is not a lenient judge; a judge who finished in ninety
 * seconds may have been reading carefully or may have been careless, and the
 * data cannot tell the difference. These are *review signals*: numbers that
 * justify a human asking a question.
 *
 * That is why the panel leads with that framing, why the register records a
 * written conclusion before a flag can be dismissed, and why dismissing a flag
 * requires saying something. The platform's claim is that it makes the process
 * auditable; a system that quietly auto-disqualified judges on a threshold
 * would be the thing it claims to replace.
 *
 * An anomaly is never equated with misconduct. Where it could be, the wording
 * says what was measured.
 */
export function DiagnosticsPanel({ eventId }: { eventId: string }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AnomalyRow['status'] | ''>('');
  const [severity, setSeverity] = useState<AnomalyRow['severity'] | ''>('');
  const [conclusion, setConclusion] = useState('');

  const { data: diagnostics, loading, reload } = useApi<EventDiagnostics>(`/api/events/${eventId}/diagnostics`);

  const query = new URLSearchParams({ perPage: '200' });
  if (status !== '') query.set('status', status);
  if (severity !== '') query.set('severity', severity);
  const { data: flags, reload: reloadFlags } = useApi<{ data: AnomalyRow[] }>(`/api/events/${eventId}/anomalies?${query.toString()}`);

  const { data: comparisons } = useApi<{ data: ComparisonRow[]; counts: { total: number; ties: number; skipped: number } }>(
    `/api/events/${eventId}/comparisons`,
  );

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
      reloadFlags();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Panel
        title="Panel health"
        description="Per-judge and per-project statistics computed from the submitted reviews. An anomaly is not misconduct — it is a number that justifies a human asking a question."
        error={error}
        actions={
          <>
            {/*
              A POST, not a GET. This button files the signals as review flags,
              so the read that renders the panel above stays a read - it can be
              cached, prefetched and reloaded without writing four audit rows and
              four flag writes each time somebody looks at the page.
            */}
            <button type="button" className="button button--primary" disabled={busy} onClick={() => void act(() => api.post(`/api/events/${eventId}/diagnostics`))}>
              {busy ? 'Recomputing…' : 'Recompute and file signals'}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => void act(() => api.get(`/api/events/${eventId}/diagnostics`))}>
              Recompute only
            </button>
          </>
        }
      >
        {loading ? <span className="muted small">Computing…</span> : null}
        {diagnostics === null ? null : (
          <>
            {/* There is no `warnings` array on this payload; the warnings that
                matter are the signals themselves, listed below with their
                evidence. Reading a field that does not exist crashed the panel. */}
            {diagnostics.panel !== null ? (
              <p className="small muted" style={{ marginTop: 0 }}>
                Engine {diagnostics.engineVersion}, computed {formatInstant(diagnostics.computedAt)} against assignment
                version {String(diagnostics.assignmentVersion)}. Panel of {String(diagnostics.panel.judges)} judge(s) over{' '}
                {String(diagnostics.panel.reviews)} review(s), mean {formatNumber(diagnostics.panel.mean)}, sd{' '}
                {formatNumber(diagnostics.panel.stddev)}.
              </p>
            ) : (
              <p className="small muted" style={{ marginTop: 0 }}>
                Engine {diagnostics.engineVersion}, computed {formatInstant(diagnostics.computedAt)}. No submitted reviews
                yet, so there is nothing to describe.
              </p>
            )}

            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Signal threshold</th>
                    <th scope="col" style={{ width: 140 }}>Value</th>
                    <th scope="col">Applies when</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(diagnostics.thresholds).map(([name, value]) => (
                    <tr key={name}>
                      <td className="small mono">{stateLabel(name)}</td>
                      <td className="num">{formatNumber(value, 3)}</td>
                      <td className="small muted">
                        A signal is recorded when the measured value crosses this. Publish the thresholds with the result
                        so a signal can be argued with rather than merely trusted.
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="small strong" style={{ marginBottom: 8 }}>Judges</h3>
            {diagnostics.judges.length === 0 ? (
              <p className="small muted">No submitted reviews yet, so there is nothing to describe.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Judge</th>
                      <th scope="col" style={{ width: 110 }}>Completion</th>
                      <th scope="col" style={{ width: 90 }}>Mean</th>
                      <th scope="col" style={{ width: 90 }}>Median</th>
                      <th scope="col" style={{ width: 100 }}>Std dev</th>
                      <th scope="col" style={{ width: 90 }}>Range</th>
                      <th scope="col" style={{ width: 100 }}>Panel z</th>
                      <th scope="col" style={{ width: 100 }}>CoV</th>
                      <th scope="col" style={{ width: 110 }}>Distinct</th>
                      <th scope="col">Signals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diagnostics.judges.map((judge) => (
                      <tr key={judge.judgeId}>
                        <td>
                          {/* The engine reports judge ids, not display names: the
                              diagnostics path deliberately does not join the
                              users table, so a name here would be fabricated.
                              The judge roster panel is where names live. */}
                          <div className="mono tiny">{judge.judgeId.slice(0, 18)}</div>
                          <div className="tiny dim">{String(judge.sampleSize)} review(s)</div>
                        </td>
                        <td>
                          <div className="small">
                            {String(judge.completed)}/{String(judge.assigned)}
                          </div>
                          <div className="meter" role="progressbar" aria-valuenow={Math.round(judge.completionRate * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Completion rate">
                            <span style={{ width: `${String(Math.round(judge.completionRate * 100))}%` }} />
                          </div>
                        </td>
                        <td className="num">{formatNumber(judge.mean)}</td>
                        <td className="num">{formatNumber(judge.median)}</td>
                        <td className="num">{formatNumber(judge.stddev)}</td>
                        <td className="num">{formatNumber(judge.range)}</td>
                        <td className="num">{formatNumber(judge.panelDeviationZ)}</td>
                        <td className="num small">
                          {formatNumber(judge.coefficientOfVariation)}
                        </td>
                        <td className="num small">
                          {formatNumber(judge.distinctScoreRatio)}
                        </td>
                        <td>
                          <div className="row row--wrap" style={{ gap: 4 }}>
                            {judge.signals.length === 0 ? (
                              <span className="muted small">none</span>
                            ) : (
                              /* Each signal is an object carrying its own
                                 evidence, not a bare label. Rendering signal
                                 directly called toLowerCase on an object. */
                              judge.signals.map((signal) => (
                                <span
                                  key={signal.type + ':' + signal.subjectId}
                                  className={
                                    'badge tiny ' +
                                    (signal.severity === 'HIGH' ? 'badge--bad' : signal.severity === 'MEDIUM' ? 'badge--warn' : '')
                                  }
                                  title={signal.evidence}
                                >
                                  {stateLabel(signal.type)}
                                </span>
                              ))
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {diagnostics.projects.length > 0 ? (
              <>
                <h3 className="small strong" style={{ margin: '20px 0 8px' }}>Projects</h3>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th scope="col">Project</th>
                        <th scope="col" style={{ width: 110 }}>Coverage</th>
                        <th scope="col" style={{ width: 90 }}>Mean</th>
                        <th scope="col" style={{ width: 90 }}>Range</th>
                        <th scope="col">Signals</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diagnostics.projects.map((project) => (
                        <tr key={project.projectId}>
                          <td className="mono tiny">{project.projectId.slice(0, 18)}</td>
                          <td>
                            <div className="small">
                              {String(project.submittedReviews)}/{String(project.assignedJudges)}
                            </div>
                            <div className="meter" role="progressbar" aria-valuenow={Math.round(project.coverage * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Review coverage">
                              <span style={{ width: `${String(Math.round(project.coverage * 100))}%` }} />
                            </div>
                          </td>
                          <td className="num">{formatNumber(project.mean)}</td>
                          <td className="num">{formatNumber(project.range)}</td>
                          <td>
                            <div className="row row--wrap" style={{ gap: 4 }}>
                              {project.signals.length === 0 ? (
                                <span className="muted small">none</span>
                              ) : (
                                project.signals.map((signal) => (
                                  <span
                                    key={signal.type + ':' + signal.subjectId}
                                    className={
                                      'badge tiny ' +
                                      (signal.severity === 'HIGH' ? 'badge--bad' : signal.severity === 'MEDIUM' ? 'badge--warn' : '')
                                    }
                                    title={signal.evidence}
                                  >
                                    {stateLabel(signal.type)}
                                  </span>
                                ))
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}

            {diagnostics.signals.length > 0 ? (
              <details style={{ marginTop: 20 }}>
                <summary className="small strong" style={{ cursor: 'pointer' }}>
                  All {String(diagnostics.signals.length)} signals, with evidence and a recommended next step
                </summary>
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table className="data">
                    <thead>
                      <tr>
                        <th scope="col" style={{ width: 110 }}>Severity</th>
                        <th scope="col" style={{ width: 150 }}>Type</th>
                        <th scope="col">Evidence</th>
                        <th scope="col">Suggested next step</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diagnostics.signals.map((signal) => (
                        <tr key={`${signal.type}:${signal.subjectId}`}>
                          <td>
                            <span className={`badge ${signal.severity === 'HIGH' ? 'badge--bad' : signal.severity === 'MEDIUM' ? 'badge--warn' : ''}`}>
                              {signal.severity}
                            </span>
                          </td>
                          <td className="small">{stateLabel(signal.type)}</td>
                          <td className="small muted">{signal.evidence}</td>
                          <td className="small">{signal.recommendedAction}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}
          </>
        )}
      </Panel>

      <Panel
        title="Review flags"
        description="Signals that have been recorded so they cannot be lost between being computed and being looked at. Dismissing or resolving one requires a written conclusion, and the whole history is kept."
        error={error}
        actions={
          <>
            <label className="sr-only" htmlFor="flag-status">Filter by status</label>
            <select id="flag-status" className="select" style={{ width: 160 }} value={status} onChange={(changeEvent) => setStatus(changeEvent.target.value as AnomalyRow['status'] | '')}>
              <option value="">All statuses</option>
              {['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'DISMISSED', 'RESOLVED'].map((value) => (
                <option key={value} value={value}>{stateLabel(value)}</option>
              ))}
            </select>
            <label className="sr-only" htmlFor="flag-severity">Filter by severity</label>
            <select id="flag-severity" className="select" style={{ width: 140 }} value={severity} onChange={(changeEvent) => setSeverity(changeEvent.target.value as AnomalyRow['severity'] | '')}>
              <option value="">All severities</option>
              {['HIGH', 'MEDIUM', 'LOW'].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </>
        }
      >
        <div className="field" style={{ marginBottom: 16, maxWidth: 560 }}>
          <label className="label" htmlFor="flag-conclusion">
            Written conclusion <span className="muted small">required to dismiss or resolve</span>
          </label>
          <input
            id="flag-conclusion"
            className="input"
            value={conclusion}
            placeholder="e.g. Spoke to the judge; the score reflects a deliberate reading of the rubric."
            onChange={(changeEvent) => setConclusion(changeEvent.target.value)}
          />
        </div>

        {(flags?.data ?? []).length === 0 ? (
          <Empty title="No flags match">
            {status === '' && severity === '' ? 'Nothing has been flagged for this event.' : 'Clear the filter to see every flag.'}
          </Empty>
        ) : (
          <div className="stack stack--tight">
            {(flags?.data ?? []).map((flag) => (
              <div key={flag.id} className="flag">
                <div className="row row--between row--wrap" style={{ gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row row--wrap" style={{ gap: 6 }}>
                      <span className={`badge ${flag.severity === 'HIGH' ? 'badge--bad' : flag.severity === 'MEDIUM' ? 'badge--warn' : ''}`}>
                        {flag.severity}
                      </span>
                      <span className="badge">{stateLabel(flag.anomaly_type)}</span>
                      <span className={`badge ${flag.status === 'OPEN' ? 'badge--warn' : flag.status === 'DISMISSED' || flag.status === 'RESOLVED' ? 'badge--ok' : ''}`}>
                        {stateLabel(flag.status)}
                      </span>
                      <span className="tiny dim">raised {formatInstant(flag.created_at)}</span>
                    </div>
                    <p className="small" style={{ marginTop: 8, marginBottom: 0 }}>{flag.evidence}</p>
                    <p className="small muted" style={{ margin: '4px 0 0' }}>Suggested: {flag.recommended_action}</p>
                    {flag.resolution !== '' ? (
                      <p className="small" style={{ margin: '8px 0 0' }}>
                        <strong>Conclusion:</strong> {flag.resolution}
                      </p>
                    ) : null}
                  </div>
                  <div className="row row--wrap" style={{ gap: 6 }}>
                    {(['ACKNOWLEDGED', 'INVESTIGATING', 'DISMISSED', 'RESOLVED'] as const)
                      .filter((to) => to !== flag.status)
                      .map((to) => {
                        const needsConclusion = to === 'DISMISSED' || to === 'RESOLVED';
                        return (
                          <button
                            key={to}
                            type="button"
                            className={`button button--sm ${to === 'DISMISSED' ? 'button--danger' : ''}`}
                            disabled={busy || (needsConclusion && conclusion.trim().length < 5)}
                            title={needsConclusion && conclusion.trim().length < 5 ? 'Write a conclusion first' : undefined}
                            onClick={() =>
                              void act(() =>
                                api.post(`/api/events/${eventId}/anomalies/${flag.id}`, {
                                  status: to,
                                  resolution: conclusion.trim(),
                                }),
                              )
                            }
                          >
                            {stateLabel(to)}
                          </button>
                        );
                      })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Head-to-head comparisons"
        description="Recorded by judges for projects they are assigned. These feed a Bradley-Terry fit when a result run is computed with pairwise enabled — an explicit, recorded choice, not a default."
      >
        {(comparisons?.data ?? []).length === 0 ? (
          <Empty title="No comparisons recorded">
            Judges can work a comparison queue from their own console. The seeded event has some, so this is empty only
            before judging starts.
          </Empty>
        ) : (
          <>
            <p className="small muted">
              {String(comparisons?.counts.total ?? 0)} recorded · {String(comparisons?.counts.ties ?? 0)} tied ·{' '}
              {String(comparisons?.counts.skipped ?? 0)} skipped
            </p>
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Left</th>
                    <th scope="col" style={{ width: 100 }}>Outcome</th>
                    <th scope="col">Right</th>
                    <th scope="col" style={{ width: 170 }}>Decided</th>
                  </tr>
                </thead>
                <tbody>
                  {(comparisons?.data ?? []).slice(0, 50).map((row) => (
                    <tr key={row.id}>
                      <td className="small">{row.leftProjectName}</td>
                      <td>
                        <span className="badge">{row.outcome}</span>
                      </td>
                      <td className="small">{row.rightProjectName}</td>
                      <td className="small muted">{formatInstant(row.decidedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

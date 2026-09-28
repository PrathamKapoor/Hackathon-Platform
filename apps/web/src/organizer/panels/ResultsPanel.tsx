import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type ComputeRun,
  type NormalizationComparison,
  type NormalizationRunRow,
  type ResultRun,
  type ResultSnapshotRow,
  type Reproduction,
} from '../../api.ts';
import { Empty, formatInstant, formatNumber, shortHash, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * ---------------------------------------------------------------------------
 * RESULTS
 * ---------------------------------------------------------------------------
 * The four steps are separated because they have very different consequences:
 * computing is free and repeatable, snapshotting freezes a run, and publishing
 * is the only irreversible one. The publish button stays disabled until a
 * snapshot exists, because publishing a snapshot that was never taken would
 * freeze a ranking nobody has seen.
 *
 * The method choice is not a dropdown that silently decides the winner. Choosing
 * `Z_SCORE` shows exactly which projects moved relative to raw scoring, and by
 * how much, before anything is committed. That is the difference between "we
 * normalized" and "we normalized, here is what it did, and we looked".
 */
const METHODS = [
  { value: 'RAW', label: 'Raw — no per-judge correction' },
  { value: 'Z_SCORE', label: 'Z-score — remove judge generosity and severity' },
  { value: 'MIN_MAX', label: 'Min-max — rescale each judge to the panel range' },
  { value: 'ROBUST_MAD', label: 'Robust MAD — median and MAD, outlier resistant' },
  { value: 'RANK', label: 'Rank — replace each score with its within-judge rank' },
] as const;

const AGGREGATIONS = [
  { value: 'MEAN', label: 'Mean' },
  { value: 'TRIMMED_MEAN', label: 'Trimmed mean — drop the tails' },
  { value: 'MEDIAN', label: 'Median' },
  { value: 'WEIGHTED_MEAN', label: 'Weighted mean' },
  { value: 'BEST_WORST', label: 'Best and worst, trimmed' },
] as const;

export function ResultsPanel({ eventId }: { eventId: string }) {
  const [normalization, setNormalization] = useState<string>('RAW');
  const [aggregation, setAggregation] = useState<string>('MEAN');
  const [trim, setTrim] = useState(0.2);
  const [enablePairwise, setEnablePairwise] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [run, setRun] = useState<ComputeRun | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [verification, setVerification] = useState<Reproduction | null>(null);

  /*
   * These three are `{ data: [...] }` envelopes, not bare arrays. Typing them
   * as `T[]` compiles, silently yields `undefined` for `[0]`, and then blows up
   * inside a render — which is exactly what happened: the Results panel threw
   * `?.find is not a function`, and with no error boundary that unmounted the
   * entire application. The types below now match what the server sends.
   */
  const { data: runsEnvelope, reload: reloadRuns } = useApi<{ data: ResultRun[] }>(`/api/events/${eventId}/results/runs`);
  const { data: snapshotEnvelope, reload: reloadSnapshots } = useApi<{ data: ResultSnapshotRow[] }>(`/api/events/${eventId}/results/snapshots`);
  const runs = runsEnvelope?.data;
  const snapshots = snapshotEnvelope?.data;
  const { data: board, reload: reloadBoard } = useApi<{ published: boolean; snapshot: { integrityHash: string; publishedAt: string; entryCount: number; isCorrection: boolean } | null }>(
    `/api/events/${eventId}/results`,
  );

  const act = async (fn: () => Promise<void>): Promise<void> => {
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

  const published = snapshots?.find((row) => row.is_published === 1) ?? null;
  const canPublish = snapshotId !== null;

  return (
    <div className="stack">
      <Panel
        title="1 · Compute"
        description="RAW → VALIDATION → NORMALIZATION → AGGREGATION → TIE RESOLUTION → PRIZES. Raw scores are never modified; the method is an explicit, recorded, reproducible choice. Computing is free and repeatable — run it as often as you like."
        error={error}
      >
        <div className="row row--wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 280px' }}>
            <label className="label" htmlFor="res-norm">Normalization</label>
            <select id="res-norm" className="select" value={normalization} onChange={(changeEvent) => setNormalization(changeEvent.target.value)}>
              {METHODS.map((method) => (
                <option key={method.value} value={method.value}>{method.label}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label className="label" htmlFor="res-agg">Aggregation</label>
            <select id="res-agg" className="select" value={aggregation} onChange={(changeEvent) => setAggregation(changeEvent.target.value)}>
              {AGGREGATIONS.map((method) => (
                <option key={method.value} value={method.value}>{method.label}</option>
              ))}
            </select>
          </div>
          {aggregation === 'TRIMMED_MEAN' || aggregation === 'BEST_WORST' ? (
            <div className="field" style={{ width: 130 }}>
              <label className="label" htmlFor="res-trim">Trim</label>
              <input
                id="res-trim"
                className="input"
                type="number"
                min={0}
                max={0.5}
                step={0.05}
                value={trim}
                onChange={(changeEvent) => setTrim(Math.max(0, Math.min(0.5, Number(changeEvent.target.value) || 0)))}
              />
            </div>
          ) : null}
          <div className="field">
            <label className="label" htmlFor="res-notes">Run note</label>
            <input id="res-notes" className="input" style={{ width: 220 }} value={notes} onChange={(changeEvent) => setNotes(changeEvent.target.value)} />
          </div>
        </div>
        <label className="row small" style={{ gap: 6, marginTop: 12 }}>
          <input type="checkbox" checked={enablePairwise} onChange={(changeEvent) => setEnablePairwise(changeEvent.target.checked)} />
          Fold in the Bradley-Terry fit from head-to-head comparisons
        </label>
        <div className="row row--wrap" style={{ gap: 8, marginTop: 16 }}>
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const computed = await api.post<ComputeRun>(`/api/events/${eventId}/results/compute`, {
                  normalizationMethod: normalization,
                  aggregationMethod: aggregation,
                  ...(aggregation === 'TRIMMED_MEAN' || aggregation === 'BEST_WORST' ? { trim } : {}),
                  enablePairwise,
                  notes,
                  persist: true,
                });
                setRun(computed);
                setSnapshotId(null);
                setVerification(null);
                reloadRuns();
                reloadSnapshots();
              })
            }
          >
            {busy ? 'Computing…' : 'Compute'}
          </button>
        </div>
      </Panel>

      {run !== null ? (
        <Panel title="Computed run" description="A run is stored with its engine version, every configuration hash and an integrity hash over the ranking. It is rehydratable and verifiable on its own.">
          <dl className="detail-list">
            <Line label="Run" value={run.runId} mono />
            <Line label="Entries" value={String(run.entries.length)} />
            <Line label="Rubric version" value={`v${String(run.rubricVersion)}`} />
            <Line label="Assignment version" value={String(run.assignmentVersion)} />
            <Line label="Normalization" value={run.normalizationMethod} />
            <Line label="Aggregation" value={run.aggregationMethod} />
            <Line label="Integrity hash" value={run.integrityHash} mono wrap />
            <Line label="Input hash" value={run.inputHash} mono wrap />
          </dl>
          {run.warnings.length > 0 ? (
            <div className="notice notice--warn" style={{ marginTop: 12 }}>
              <div className="strong small">{String(run.warnings.length)} warning(s) from the engine</div>
              <ul className="tiny" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {run.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          ) : null}
        </Panel>
      ) : null}

      <Panel
        title="2 · Snapshot, 3 · Publish, 4 · Verify"
        description="Snapshotting freezes a computed run as an immutable, sequenced artifact. Publishing recomputes the pipeline from the stored scores and refuses if it does not match, so a result that no longer reproduces cannot go live."
        actions={
          <>
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
                  reloadSnapshots();
                })
              }
            >
              2 · Snapshot
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={busy || !canPublish}
              onClick={() =>
                void act(async () => {
                  await api.post(`/api/events/${eventId}/results/snapshots/${snapshotId}/publish`, {});
                  setSnapshotId(null);
                  reloadSnapshots();
                  reloadBoard();
                })
              }
            >
              3 · Publish
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || snapshotId === null}
              onClick={() =>
                void act(async () => {
                  setVerification(await api.post<Reproduction>(`/api/events/${eventId}/results/snapshots/${snapshotId}/reproduce`, {}));
                })
              }
            >
              4 · Verify reproduction
            </button>
          </>
        }
      >
        {snapshotId === null ? (
          <p className="tiny dim" style={{ margin: 0 }}>
            Snapshot and publish stay disabled until a run exists. Publishing a snapshot that was never taken would freeze
            a ranking nobody has seen.
          </p>
        ) : (
          <p className="small">Working with snapshot <span className="mono">{shortHash(snapshotId)}</span>.</p>
        )}

        {verification !== null ? (
          <div className={`notice ${verification.status === 'MATCH' ? 'notice--ok' : 'notice--error'}`} style={{ marginTop: 14 }} role="status">
            <div className="strong">Reproduction: {verification.status}</div>
            <p className="small" style={{ marginTop: 6 }}>
              {verification.status === 'MATCH'
                ? 'Recomputing the pipeline from the stored reviews produced exactly this ranking. Anyone can check it.'
                : 'The engine no longer reproduces this snapshot. The differences below say where.'}
            </p>
            {verification.differences.length > 0 ? (
              <ul className="tiny" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {verification.differences.map((difference, index) => <li key={index}>{JSON.stringify(difference)}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}

        {board?.published === true && board.snapshot !== null ? (
          <div className="notice notice--ok" style={{ marginTop: 14 }}>
            <div className="strong small">Published {formatInstant(board.snapshot.publishedAt)}</div>
            <div className="small" style={{ marginTop: 4 }}>
              {String(board.snapshot.entryCount)} entries · integrity <span className="mono">{shortHash(board.snapshot.integrityHash)}</span>
              {board.snapshot.isCorrection ? ' · this is a correction superseding an earlier snapshot' : ''}
            </div>
            <Link className="button button--sm" to={`/e/${eventId}/results`} style={{ marginTop: 10 }}>
              View the public results page
            </Link>
          </div>
        ) : null}
      </Panel>

      <NormalizationPanel eventId={eventId} />

      <Panel
        title="Computation history"
        description="Every run ever computed, newest first, with the method it used and whether it was published."
      >
        {(runs ?? []).length === 0 ? (
          <Empty title="No runs yet">Compute a result above and it will appear here.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Computed</th>
                  <th scope="col" style={{ width: 90 }}>Rubric</th>
                  <th scope="col" style={{ width: 150 }}>Normalization</th>
                  <th scope="col" style={{ width: 130 }}>Aggregation</th>
                  <th scope="col" style={{ width: 170 }}>Integrity</th>
                  <th scope="col" style={{ width: 110 }}>Published</th>
                </tr>
              </thead>
              <tbody>
                {(runs ?? []).map((row) => (
                  <tr key={row.id}>
                    <td className="small muted">{formatInstant(row.computedAt)}</td>
                    <td className="small">v{String(row.rubricVersion)}</td>
                    <td className="small">{row.normalizationMethod}</td>
                    <td className="small">{row.aggregationMethod}</td>
                    <td className="mono tiny">{shortHash(row.integrityHash)}</td>
                    <td>
                      {row.publishedSnapshotId === null ? (
                        <span className="muted small">—</span>
                      ) : (
                        <span className="badge badge--ok">Yes</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Snapshots"
        description="Append-only and sequenced. A correction is a new snapshot that supersedes the old one; database triggers refuse to modify or delete a published snapshot."
      >
        {(snapshots ?? []).length === 0 ? (
          <Empty title="No snapshots">Take a snapshot above to freeze a computed run.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 80 }}>#</th>
                  <th scope="col" style={{ width: 110 }}>State</th>
                  <th scope="col" style={{ width: 90 }}>Entries</th>
                  <th scope="col" style={{ width: 180 }}>Integrity</th>
                  <th scope="col">Correction</th>
                  <th scope="col" style={{ width: 150 }}>Published</th>
                </tr>
              </thead>
              <tbody>
                {(snapshots ?? []).map((row) => (
                  <tr key={row.id}>
                    <td className="num">{String(row.sequence)}</td>
                    <td>
                      {row.is_published === 1 ? (
                        <span className="badge badge--ok">Published</span>
                      ) : (
                        <span className="badge">Draft</span>
                      )}
                    </td>
                    <td className="num">{String(row.entry_count)}</td>
                    <td className="mono tiny">{shortHash(row.integrity_hash)}</td>
                    <td className="small muted">
                      {row.is_correction === 1 ? (row.correction_reason || `supersedes ${String(row.supersedes_id)}`) : '—'}
                    </td>
                    <td className="small muted">{row.published_at === null ? '—' : formatInstant(row.published_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {published !== null ? (
          <p className="tiny dim" style={{ marginTop: 12 }}>
            Anyone can verify the published snapshot without an account through{' '}
            <span className="mono">GET /api/results/verify/{'{eventId}'}::{'{snapshotId}'}</span>.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

/**
 * The normalization proof.
 *
 * Pick a method, see the same reviews scored both ways. `rankDelta` is positive
 * when a project climbed once judge generosity and severity were removed, which
 * is the number that makes "we normalized" reviewable rather than a matter of
 * trust.
 */
function NormalizationPanel({ eventId }: { eventId: string }) {
  const [method, setMethod] = useState('Z_SCORE');
  const path = method === 'RAW' ? null : `/api/events/${eventId}/normalization/comparison?method=${encodeURIComponent(method)}`;
  const { data, loading } = useApi<NormalizationComparison>(path);
  const { data: runs } = useApi<NormalizationRunRow[]>(`/api/events/${eventId}/normalization/runs`);

  return (
    <Panel
      title="Normalization proof"
      description="Run the same stored reviews through raw scoring and one alternative method, side by side. The raw scores are never modified — this is a comparison, not a replacement."
      actions={
        <label className="sr-only" htmlFor="norm-method">Comparison method</label>
      }
    >
      <div className="row row--wrap" style={{ gap: 10, alignItems: 'flex-end', marginBottom: 16 }}>
        <div className="field" style={{ flex: '1 1 280px' }}>
          <label className="label" htmlFor="norm-method">Compare against raw using</label>
          <select id="norm-method" className="select" value={method} onChange={(changeEvent) => setMethod(changeEvent.target.value)}>
            {METHODS.filter((row) => row.value !== 'RAW').map((row) => (
              <option key={row.value} value={row.value}>{row.label}</option>
            ))}
          </select>
        </div>
      </div>

      {method === 'RAW' ? (
        <p className="small muted" style={{ margin: 0 }}>
          Pick a method to see the comparison. Raw scoring is the baseline, so comparing it with itself shows nothing.
        </p>
      ) : loading ? (
        <span className="muted small">Running both pipelines…</span>
      ) : data === null ? null : (
        <>
          <p className="small">{data.explanation}</p>
          <div className="metrics metrics--tight" style={{ marginTop: 12 }}>
            <div className="metric">
              <div className="metric__label">Projects moved</div>
              <div className="metric__value">{String(data.movedProjects)}</div>
              <div className="metric__hint">of {String(data.rows.length)}</div>
            </div>
            <div className="metric">
              <div className="metric__label">Judges measured</div>
              <div className="metric__value">{String(data.judgeStats.length)}</div>
            </div>
          </div>

          {data.warnings.length > 0 ? (
            <div className="notice notice--warn" style={{ marginTop: 14 }}>
              <ul className="tiny" style={{ margin: 0, paddingLeft: 18 }}>
                {data.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          ) : null}

          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col" style={{ width: 100 }}>Raw</th>
                  <th scope="col" style={{ width: 100 }}>Rank</th>
                  <th scope="col" style={{ width: 110 }}>{method}</th>
                  <th scope="col" style={{ width: 100 }}>Rank</th>
                  <th scope="col" style={{ width: 110 }}>Change</th>
                  <th scope="col" style={{ width: 70 }}>Judges</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.projectId}>
                    <td className="strong">{row.projectId.slice(0, 14)}…</td>
                    <td className="num">{formatNumber(row.rawScore)}</td>
                    <td className="num">{row.rawRank === null ? '—' : `#${String(row.rawRank)}`}</td>
                    <td className="num">{formatNumber(row.normalizedScore)}</td>
                    <td className="num">{row.normalizedRank === null ? '—' : `#${String(row.normalizedRank)}`}</td>
                    <td>
                      {row.rankDelta === null || row.rankDelta === 0 ? (
                        <span className="muted small">—</span>
                      ) : row.rankDelta > 0 ? (
                        <span className="badge badge--ok">▲ {String(row.rankDelta)}</span>
                      ) : (
                        <span className="badge badge--warn">▼ {String(Math.abs(row.rankDelta))}</span>
                      )}
                    </td>
                    <td className="num">{String(row.judges)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tiny dim" style={{ marginTop: 10 }}>
            A positive change means the project climbed once judge generosity and severity were removed. Min-max is the
            most outlier-sensitive method here; verify the panel before relying on it.
          </p>

          {data.judgeStats.length > 0 ? (
            <details style={{ marginTop: 16 }}>
              <summary className="small strong" style={{ cursor: 'pointer' }}>
                Judge statistics for {method} ({String(data.judgeStats.length)})
              </summary>
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Judge</th>
                      <th scope="col" style={{ width: 80 }}>Reviews</th>
                      <th scope="col" style={{ width: 100 }}>Mean</th>
                      <th scope="col" style={{ width: 100 }}>Std dev</th>
                      <th scope="col" style={{ width: 120 }}>Generosity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.judgeStats.map((stat) => (
                      <tr key={stat.judgeId}>
                        <td className="small">{stat.displayName ?? stat.judgeId.slice(0, 14)}</td>
                        <td className="num">{String(stat.count)}</td>
                        <td className="num">{formatNumber(stat.mean)}</td>
                        <td className="num">{formatNumber(stat.stddev)}</td>
                        <td className="num">{formatNumber(stat.generosity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </>
      )}

      {(runs ?? []).length > 0 ? (
        <details style={{ marginTop: 16 }}>
          <summary className="small strong" style={{ cursor: 'pointer' }}>
            Normalization run history ({String(runs?.length ?? 0)})
          </summary>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Method</th>
                  <th scope="col" style={{ width: 80 }}>Scores</th>
                  <th scope="col" style={{ width: 180 }}>Config hash</th>
                  <th scope="col" style={{ width: 170 }}>Computed</th>
                </tr>
              </thead>
              <tbody>
                {(runs ?? []).map((row) => (
                  <tr key={row.id}>
                    <td className="small">{row.method}</td>
                    <td className="num">{String(row.scoreCount)}</td>
                    <td className="mono tiny">{shortHash(row.configHash)}</td>
                    <td className="small muted">{formatInstant(row.computedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </Panel>
  );
}

function Line({ label, value, mono, wrap }: { label: string; value: string; mono?: boolean; wrap?: boolean }) {
  return (
    <div className="detail-line">
      <dt>{label}</dt>
      <dd className={mono === true ? 'mono' : ''} style={wrap === true ? { wordBreak: 'break-all' } : undefined}>{value}</dd>
    </div>
  );
}

export { stateLabel };

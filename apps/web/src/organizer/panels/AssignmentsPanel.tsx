import { useState } from 'react';
import { api, type AssignmentPreview, type AssignmentView } from '../../api.ts';
import { Empty, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * The assignment engine.
 *
 * The workflow is deliberately two calls with a token between them:
 *
 *   1. `POST /assignments/preview` runs the engine and writes nothing. It
 *      returns the generated pairs, the load distribution, per-project coverage
 *      and — crucially — an `inputHash` binding the plan to the exact panel,
 *      project set and conflict register it was generated from.
 *   2. `POST /assignments/commit` presents that `inputHash`. The server refuses
 *      if the data moved underneath, so a plan cannot be committed against a
 *      panel that has since changed. A plan with warnings has to be confirmed
 *      explicitly.
 *
 * Showing the dry run before the commit is the difference between an assignment
 * an organizer chose and one the engine produced at them.
 */
export function AssignmentsPanel({ eventId }: { eventId: string }) {
  const [strategy, setStrategy] = useState('WORKLOAD_AWARE');
  const [reviewsPerProject, setReviewsPerProject] = useState(3);
  const [seed, setSeed] = useState('');
  const [preview, setPreview] = useState<AssignmentPreview | null>(null);
  const [inputHash, setInputHash] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const { data: committed, loading, reload } = useApi<AssignmentView>(`/api/events/${eventId}/assignments?perPage=200`);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setConfirmed(false);
    setResult(null);
    try {
      const plan = await api.post<AssignmentPreview>(`/api/events/${eventId}/assignments/preview`, {
        strategy,
        reviewsPerProject,
        ...(seed.trim() === '' ? {} : { seed: seed.trim() }),
      });
      setPreview(plan);
      setInputHash(plan.inputHash);
    } catch (cause) {
      setError(cause);
      setPreview(null);
      setInputHash(null);
    } finally {
      setBusy(false);
    }
  };

  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const applied = await api.post<{ version: number; created: number; skipped: number; summary: { projectsFullyCovered: number; projectsUncovered: number } }>(
        `/api/events/${eventId}/assignments/commit`,
        { strategy, reviewsPerProject, ...(seed.trim() === '' ? {} : { seed: seed.trim() }), inputHash: inputHash as string, confirmWarnings: confirmed },
      );
      setResult(
        `Committed version ${String(applied.version)}: ${String(applied.created)} new assignment(s), ${String(applied.skipped)} already existed. ` +
          `${String(applied.summary.projectsFullyCovered)} project(s) fully covered, ${String(applied.summary.projectsUncovered)} uncovered.`,
      );
      setPreview(null);
      setInputHash(null);
      setConfirmed(false);
      reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const warnings = preview?.summary.warnings ?? [];
  const coverage = committed?.coverage ?? [];
  const short = coverage.filter((row) => row.completed < row.target);

  return (
    <div className="stack">
      <Panel
        title="Generate an assignment plan"
        description="A dry run. Nothing is written until you commit the exact plan you are shown, by presenting the input hash it returns."
        error={error}
      >
        <div className="row row--wrap" style={{ gap: 10, alignItems: 'flex-end', marginBottom: 16 }}>
          <div className="field">
            <label className="label" htmlFor="as-strategy">Strategy</label>
            <select id="as-strategy" className="select" value={strategy} onChange={(changeEvent) => setStrategy(changeEvent.target.value)}>
              <option value="ROUND_ROBIN">Round robin — even spread, no expertise</option>
              <option value="WORKLOAD_AWARE">Workload aware — respects capacity</option>
              <option value="EXPERTISE_MATCHED">Expertise matched — judges see their own track</option>
              <option value="CONFLICT_AWARE">Conflict aware — minimise adjacency</option>
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="as-rpp">Reviews per project</label>
            <input
              id="as-rpp"
              className="input"
              type="number"
              min={1}
              max={20}
              style={{ width: 90 }}
              value={reviewsPerProject}
              onChange={(changeEvent) => setReviewsPerProject(Math.max(1, Math.min(20, Number(changeEvent.target.value) || 1)))}
            />
          </div>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label className="label" htmlFor="as-seed">Seed <span className="muted small">optional</span></label>
            <input
              id="as-seed"
              className="input"
              value={seed}
              placeholder="leave blank for the event's own seed"
              onChange={(changeEvent) => setSeed(changeEvent.target.value)}
            />
          </div>
          <button type="button" className="button button--primary" disabled={busy} onClick={() => void run()}>
            {busy && preview === null ? 'Generating…' : 'Preview plan'}
          </button>
        </div>
        <p className="tiny dim" style={{ margin: 0 }}>
          The same panel, project set, conflicts and seed always produce the same plan. That is what makes the commit
          hash meaningful.
        </p>
      </Panel>

      {preview !== null && inputHash !== null ? (
        <Panel
          title={`Dry run · ${stateLabel(preview.strategy)} · ${String(preview.summary.totalPairs)} pair(s)`}
          description={preview.note}
          actions={
            <>
              <button type="button" className="button" disabled={busy} onClick={() => { setPreview(null); setInputHash(null); setConfirmed(false); }}>
                Discard
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy || (warnings.length > 0 && !confirmed)}
                onClick={() => void commit()}
              >
                {busy ? 'Committing…' : 'Commit this plan'}
              </button>
            </>
          }
        >
          <div className="metrics metrics--tight">
            <Metric label="Fully covered" value={String(preview.summary.projectsFullyCovered)} />
            <Metric label="Partially" value={String(preview.summary.projectsPartiallyCovered)} />
            <Metric label="Uncovered" value={String(preview.summary.projectsUncovered)} />
            <Metric label="Judges used" value={String(preview.summary.judgesUsed)} />
            <Metric
              label="Load spread"
              value={`${String(preview.summary.loadSpread.min)}–${String(preview.summary.loadSpread.max)}`}
              hint={`sd ${preview.summary.loadSpread.standardDeviation.toFixed(2)}`}
            />
          </div>

          {warnings.length > 0 ? (
            <div className="notice notice--warn" style={{ marginTop: 16 }}>
              <div className="strong small">{warnings.length} warning(s) from the engine</div>
              <ul className="tiny" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
              <label className="row small" style={{ gap: 6, marginTop: 10 }}>
                <input type="checkbox" checked={confirmed} onChange={(changeEvent) => setConfirmed(changeEvent.target.checked)} />
                I have read these and want to commit anyway.
              </label>
            </div>
          ) : null}

          {preview.excludedJudges.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <h3 className="small strong">Judges excluded from the pool</h3>
              <ul className="small muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {preview.excludedJudges.map((row) => (
                  <li key={row.judgeId}>{row.displayName} — {row.reason}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.unassignedProjects.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <h3 className="small strong">Projects that could not reach the target</h3>
              <ul className="small muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {preview.unassignedProjects.map((row) => (
                  <li key={row.projectId}>
                    {row.projectId.slice(0, 12)}… — {row.reason} ({String(row.assigned)}/{String(row.needed)})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.enforcedHardConflicts.length > 0 ? (
            <p className="small muted" style={{ marginTop: 16 }}>
              {String(preview.enforcedHardConflicts.length)} hard conflict(s) were honoured: those judge/project pairs are
              not in the plan under any strategy.
            </p>
          ) : null}

          {preview.acceptedSoftConflicts.length > 0 ? (
            <p className="small muted" style={{ marginTop: 8 }}>
              {String(preview.acceptedSoftConflicts.length)} soft conflict(s) were accepted. They are recorded, so the
              cost of the plan is visible rather than hidden.
            </p>
          ) : null}

          <p className="tiny dim mono" style={{ marginTop: 16, wordBreak: 'break-all' }}>
            inputHash {inputHash}
          </p>
        </Panel>
      ) : null}

      {result !== null ? (
        <div className="notice notice--ok" role="status">{result}</div>
      ) : null}

      <Panel
        title="Committed assignments"
        description={
          committed === null
            ? 'Loading…'
            : `Version ${String(committed.currentVersion)} · ${String(committed.data.length)} assignment(s). A review already submitted cannot be moved; the server refuses and says why.`
        }
      >
        {short.length > 0 ? (
          <div className="notice notice--warn" style={{ marginBottom: 16 }}>
            {String(short.length)} project(s) below the review target. Raising judge capacity and re-running the engine is
            usually enough.
          </div>
        ) : null}

        {loading ? <span className="muted small">Loading…</span> : null}
        {!loading && (committed?.data.length ?? 0) === 0 ? (
          <Empty title="No assignments committed">
            Generate a plan above. A run with no assignments ranks nothing, which the engine will happily compute and which
            would be meaningless to publish.
          </Empty>
        ) : null}

        {(committed?.data.length ?? 0) > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col" style={{ width: 120 }}>Status</th>
                  <th scope="col" style={{ width: 110 }}>Review</th>
                  <th scope="col" style={{ width: 100 }}>Score</th>
                </tr>
              </thead>
              <tbody>
                {committed?.data.map((row) => (
                  <tr key={row.id}>
                    <td className="strong">{row.project_name}</td>
                    <td>
                      <span className={`badge ${row.status === 'SUBMITTED' ? 'badge--ok' : row.soft_conflict === 1 ? 'badge--warn' : ''}`}>
                        {stateLabel(row.status)}
                      </span>
                    </td>
                    <td className="small muted">{row.score_state === null ? '—' : stateLabel(row.score_state)}</td>
                    <td className="num">{row.total_score === null ? '—' : row.total_score.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric">
      <div className="metric__label">{label}</div>
      <div className="metric__value">{value}</div>
      {hint !== undefined ? <div className="metric__hint">{hint}</div> : null}
    </div>
  );
}

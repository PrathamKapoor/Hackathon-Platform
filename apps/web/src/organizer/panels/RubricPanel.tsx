import { useMemo, useState } from 'react';
import { api, type RubricCriterion, type RubricRow, type RubricVersion } from '../../api.ts';
import { Empty, ErrorNotice, formatNumber, stateLabel, useApi } from '../../ui.tsx';
import { Panel } from '../Console.tsx';

/**
 * ---------------------------------------------------------------------------
 * THE RUBRIC EDITOR
 * ---------------------------------------------------------------------------
 * The rubric is the thing being argued about, so the editor's most important job
 * is refusing to lie about what is fixed.
 *
 * A rubric version is `DRAFT` while an organizer may still change the questions,
 * and it is `LOCKED` the moment any score exists against it. Once locked, the
 * server refuses edits to the criteria, and this editor stops offering them —
 * because "a judge was asked something different from the one in the published
 * breakdown" is precisely the failure that makes a result indefensible.
 *
 * Changing the questions therefore means publishing a *new version*. The old one
 * is retained unchanged, every review keeps the version it was started against,
 * and the result run records which version produced it. That is what makes
 * "the judges were asked X" answerable for ever.
 *
 * Validation is computed here so the organizer sees the problem before the
 * server does, and the server still recomputes all of it — a browser check is a
 * convenience, never the control.
 */
type Draft = {
  key: string;
  name: string;
  description: string;
  weight: number;
  min: number;
  max: number;
  required: boolean;
  scoringType: 'INTEGER' | 'DECIMAL' | 'BOOLEAN';
  publishBreakdown: boolean;
};

const BLANK: Draft = {
  key: '',
  name: '',
  description: '',
  weight: 0,
  min: 0,
  max: 10,
  required: true,
  scoringType: 'INTEGER',
  publishBreakdown: true,
};

export function RubricPanel({ eventId }: { eventId: string }) {
  const { data: rubrics, loading, reload } = useApi<{ data: RubricRow[] }>(`/api/events/${eventId}/rubrics`);
  const [rubricId, setRubricId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const activeId = rubricId ?? rubrics?.data[0]?.id ?? null;
  const active = rubrics?.data.find((row) => row.id === activeId) ?? null;

  // A `{ data: [...] }` envelope. Declared as `RubricVersion[]` this silently
  // gave `versions[0] === undefined`, so the panel reported "no version yet" for
  // a rubric that has one.
  //
  // The path is `/api/rubrics/{id}/versions`, not `/api/events/{id}/versions`.
  // It was the latter, which 404s — so the panel rendered a perfectly correct
  // "No version yet" for a rubric that had a locked version, with no error
  // anywhere, because a 404 on a secondary fetch is easy to overlook.
  const { data: versionEnvelope } = useApi<{ data: RubricVersion[]; note: string }>(
    activeId === null ? null : `/api/rubrics/${activeId}/versions`,
  );
  const versions = versionEnvelope?.data;

  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const problems = useMemo(() => validate(draft ?? []), [draft]);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
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

  const latest = versions === null || versions === undefined ? null : (versions[0] ?? null);
  const locked = latest !== null && latest.status !== 'DRAFT';

  const startNewVersion = (): void => {
    if (latest === null) {
      setDraft([{ ...BLANK, weight: 1 }]);
      setCreating(true);
      return;
    }
    // Seed from the current version so an organizer edits rather than retypes.
    setDraft(
      latest.criteria.map((criterion) => ({
        key: criterion.key,
        name: criterion.name,
        description: criterion.description,
        weight: criterion.weight,
        min: criterion.min,
        max: criterion.max,
        required: criterion.required,
        scoringType: (criterion.scoringType === 'DECIMAL' || criterion.scoringType === 'BOOLEAN' ? criterion.scoringType : 'INTEGER') as Draft['scoringType'],
        publishBreakdown: true,
      })),
    );
    setCreating(true);
  };

  const totalWeight = (draft ?? []).reduce((sum, row) => sum + (Number.isFinite(row.weight) ? row.weight : 0), 0);

  return (
    <div className="stack">
      <Panel
        title="Rubrics"
        description="An event can hold more than one rubric over time. What matters is which version the current reviews were started against, and the result run records it."
        error={error}
        actions={
          rubrics !== null && rubrics.data.length > 1 ? (
            <label className="sr-only" htmlFor="rubric-pick">Choose a rubric</label>
          ) : null
        }
      >
        {loading ? <span className="muted small">Loading…</span> : null}
        {!loading && (rubrics?.data.length ?? 0) === 0 ? (
          <Empty title="No rubric yet">
            Create one below. A rubric is the set of weighted questions judges answer; without it nothing can be scored.
          </Empty>
        ) : null}

        {(rubrics?.data.length ?? 0) > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Rubric</th>
                  <th scope="col" style={{ width: 100 }}>Versions</th>
                  <th scope="col" style={{ width: 160 }}>Active version</th>
                </tr>
              </thead>
              <tbody>
                {rubrics?.data.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <label className="row small" style={{ gap: 6 }}>
                        <input
                          type="radio"
                          name="rubric"
                          checked={row.id === activeId}
                          onChange={() => { setRubricId(row.id); setCreating(false); setDraft(null); }}
                        />
                        <span className="strong">{row.name}</span>
                      </label>
                      {row.description ? <div className="small muted" style={{ marginLeft: 22 }}>{row.description}</div> : null}
                    </td>
                    <td className="num">{String(row.version_count)}</td>
                    <td className="small">
                      {versions !== null && versions !== undefined && versions.length > 0 ? (
                        <span className="row" style={{ gap: 6 }}>
                          <span className="mono">v{String(versions[0]?.version ?? 1)}</span>
                          <span className={`badge ${versions[0]?.status === 'DRAFT' ? 'badge--warn' : 'badge--ok'}`}>
                            {stateLabel(versions[0]?.status ?? 'DRAFT')}
                          </span>
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      {active === null ? null : (
        <Panel
          title="Current version"
          description={
            locked === true && latest !== null
              ? 'Locked. Scores exist against this version, so the questions can no longer be changed — publishing a new version is the only way to ask something different.'
              : 'Still a draft. Nothing has been scored against it, so the questions can be edited directly.'
          }
          actions={
            creating ? null : (
              <button type="button" className="button button--primary" onClick={startNewVersion}>
                {latest === null ? 'Create the first version' : locked === true ? 'Publish a new version' : 'Edit as a new version'}
              </button>
            )
          }
        >
          {latest === null ? (
            <Empty title="No version yet">Create version 1 to start asking judges questions.</Empty>
          ) : (
            <>
              <VersionSummary version={latest} />
              {versions !== null && versions !== undefined && versions.length > 1 ? (
                <details style={{ marginTop: 16 }}>
                  <summary className="small strong" style={{ cursor: 'pointer' }}>
                    Version history ({String(versions.length)})
                  </summary>
                  <div className="table-wrap" style={{ marginTop: 10 }}>
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Version</th>
                          <th scope="col" style={{ width: 120 }}>Status</th>
                          <th scope="col">Criteria</th>
                          <th scope="col" style={{ width: 120 }}>Total weight</th>
                        </tr>
                      </thead>
                      <tbody>
                        {versions.map((version) => (
                          <tr key={version.id}>
                            <td className="mono">v{String(version.version)}</td>
                            <td>
                              <span className={`badge ${version.status === 'DRAFT' ? 'badge--warn' : 'badge--ok'}`}>
                                {stateLabel(version.status)}
                              </span>
                            </td>
                            <td className="small">
                              {version.criteria.map((criterion) => `${criterion.name} (${formatNumber(criterion.weight * 100, 0)}%)`).join(' · ')}
                            </td>
                            <td className="num">
                              {formatNumber(version.criteria.reduce((sum, criterion) => sum + criterion.weight, 0) * 100, 0)}%
                            </td>
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
      )}

      {creating && draft !== null ? (
        <Panel
          title={active === null ? 'Create the rubric' : 'Publish a new version'}
          description="Weights are fractions: 30% is written 0.30. Every criterion needs max greater than min, and at least one must be required."
          error={error}
          actions={
            <>
              <button type="button" className="button" disabled={busy} onClick={() => { setCreating(false); setDraft(null); }}>
                Cancel
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy || problems.length > 0 || (active === null && newName.trim() === '')}
                onClick={() =>
                  void run(async () => {
                    const criteria = draft.map((row, index) => ({
                      key: row.key.trim() === '' ? `criterion_${String(index + 1)}` : row.key.trim(),
                      name: row.name.trim(),
                      description: row.description.trim() === '' ? undefined : row.description.trim(),
                      weight: row.weight,
                      min: row.min,
                      max: row.max,
                      required: row.required,
                      scoringType: row.scoringType,
                      publishBreakdown: row.publishBreakdown,
                    }));
                    if (active === null) {
                      await api.post(`/api/events/${eventId}/rubrics`, {
                        name: newName.trim(),
                        description: 'Created from the organizer console.',
                        criteria,
                      });
                    } else {
                      await api.post(`/api/rubrics/${active.id}/versions`, { criteria, activate: true });
                    }
                    setCreating(false);
                    setDraft(null);
                    setNewName('');
                  })
                }
              >
                {active === null ? 'Create rubric' : 'Publish version'}
              </button>
            </>
          }
        >
          {active === null ? (
            <div className="field" style={{ marginBottom: 16, maxWidth: 420 }}>
              <label className="label" htmlFor="rubric-name">Rubric name</label>
              <input id="rubric-name" className="input" value={newName} onChange={(changeEvent) => setNewName(changeEvent.target.value)} />
            </div>
          ) : null}

          {problems.length > 0 ? (
            <div className="notice notice--error" style={{ marginBottom: 16 }} role="alert">
              <div className="strong small">Fix before publishing</div>
              <ul className="tiny" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {problems.map((problem) => <li key={problem}>{problem}</li>)}
              </ul>
            </div>
          ) : null}

          <p className="small" style={{ marginBottom: 12 }}>
            Total weight:{' '}
            <strong className={Math.abs(totalWeight - 1) < 1e-9 ? '' : 'var(--verdict-red)'}>
              {formatNumber(totalWeight * 100, 1)}%
            </strong>
            {Math.abs(totalWeight - 1) < 1e-9 ? ' — valid' : ' — must equal 100%'}
          </p>

          <div className="stack stack--tight">
            {draft.map((row, index) => (
              <CriterionEditor
                key={index}
                value={row}
                index={index}
                total={draft.length}
                disabled={busy}
                onChange={(next) => setDraft(draft.map((existing, i) => (i === index ? next : existing)))}
                onMove={(direction) =>
                  setDraft((current) => {
                    if (current === null) return current;
                    const target = index + direction;
                    if (target < 0 || target >= current.length) return current;
                    const copy = [...current];
                    const [moved] = copy.splice(index, 1);
                    if (moved === undefined) return current;
                    copy.splice(target, 0, moved);
                    return copy;
                  })
                }
                onRemove={() => setDraft(draft.filter((_existing, i) => i !== index))}
              />
            ))}
          </div>

          <button
            type="button"
            className="button"
            style={{ marginTop: 12 }}
            disabled={busy || draft.length >= 30}
            onClick={() => setDraft([...draft, { ...BLANK, weight: 0 }])}
          >
            Add criterion
          </button>
        </Panel>
      ) : null}
    </div>
  );
}

function VersionSummary({ version }: { version: RubricVersion }) {
  return (
    <>
      <div className="row row--wrap" style={{ gap: 6, marginBottom: 12 }}>
        <span className="badge">v{String(version.version)}</span>
        <span className={`badge ${version.status === 'DRAFT' ? 'badge--warn' : 'badge--ok'}`}>{stateLabel(version.status)}</span>
        <span className="badge">
          {String(version.criteria.length)} criteria ·{' '}
          {formatNumber(version.criteria.reduce((sum, criterion) => sum + criterion.weight, 0) * 100, 0)}% total
        </span>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Criterion</th>
              <th scope="col" style={{ width: 90 }}>Weight</th>
              <th scope="col" style={{ width: 100 }}>Scale</th>
              <th scope="col" style={{ width: 90 }}>Type</th>
              <th scope="col" style={{ width: 90 }}>Required</th>
            </tr>
          </thead>
          <tbody>
            {version.criteria.map((criterion: RubricCriterion) => (
              <tr key={criterion.id}>
                <td>
                  <div className="strong">{criterion.name}</div>
                  {criterion.description ? <div className="small muted">{criterion.description}</div> : null}
                </td>
                <td className="num">{formatNumber(criterion.weight * 100, 0)}%</td>
                <td className="num small">
                  {criterion.min}–{criterion.max}
                </td>
                <td className="small">{criterion.scoringType}</td>
                <td>{criterion.required ? <span className="badge badge--warn">Yes</span> : <span className="muted small">No</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {version.judgeGuidance !== undefined && version.judgeGuidance.trim() !== '' ? (
        <div className="notice" style={{ marginTop: 16 }}>
          <div className="strong small">Shown to judges before they score</div>
          <p className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{version.judgeGuidance}</p>
        </div>
      ) : null}
    </>
  );
}

function CriterionEditor({
  value,
  index,
  total,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  value: Draft;
  index: number;
  total: number;
  disabled: boolean;
  onChange: (next: Draft) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <fieldset className="criterion" disabled={disabled}>
      <legend className="sr-only">Criterion {String(index + 1)}</legend>
      <div className="criterion__grid">
        <div className="field">
          <label className="label" htmlFor={`cr-name-${String(index)}`}>Name</label>
          <input
            id={`cr-name-${String(index)}`}
            className="input"
            value={value.name}
            onChange={(changeEvent) => onChange({ ...value, name: changeEvent.target.value })}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`cr-key-${String(index)}`}>Key</label>
          <input
            id={`cr-key-${String(index)}`}
            className="input"
            value={value.key}
            placeholder="auto"
            onChange={(changeEvent) => onChange({ ...value, key: changeEvent.target.value })}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`cr-weight-${String(index)}`}>Weight (0–1)</label>
          <input
            id={`cr-weight-${String(index)}`}
            className="input"
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={value.weight}
            onChange={(changeEvent) => onChange({ ...value, weight: Number(changeEvent.target.value) })}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`cr-min-${String(index)}`}>Min</label>
          <input
            id={`cr-min-${String(index)}`}
            className="input"
            type="number"
            value={value.min}
            onChange={(changeEvent) => onChange({ ...value, min: Number(changeEvent.target.value) })}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`cr-max-${String(index)}`}>Max</label>
          <input
            id={`cr-max-${String(index)}`}
            className="input"
            type="number"
            value={value.max}
            onChange={(changeEvent) => onChange({ ...value, max: Number(changeEvent.target.value) })}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`cr-type-${String(index)}`}>Scoring</label>
          <select
            id={`cr-type-${String(index)}`}
            className="select"
            value={value.scoringType}
            onChange={(changeEvent) => onChange({ ...value, scoringType: changeEvent.target.value as Draft['scoringType'] })}
          >
            <option value="INTEGER">Integer</option>
            <option value="DECIMAL">Decimal</option>
            <option value="BOOLEAN">Yes / no</option>
          </select>
        </div>
        <div className="field criterion__checks">
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={value.required} onChange={(changeEvent) => onChange({ ...value, required: changeEvent.target.checked })} />
            Required
          </label>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={value.publishBreakdown} onChange={(changeEvent) => onChange({ ...value, publishBreakdown: changeEvent.target.checked })} />
            Publish breakdown
          </label>
        </div>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label className="label" htmlFor={`cr-desc-${String(index)}`}>Description <span className="muted small">shown to judges</span></label>
        <textarea
          id={`cr-desc-${String(index)}`}
          className="textarea"
          style={{ minHeight: 56 }}
          value={value.description}
          onChange={(changeEvent) => onChange({ ...value, description: changeEvent.target.value })}
        />
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button type="button" className="button button--sm" disabled={disabled || index === 0} onClick={() => onMove(-1)} aria-label={`Move ${value.name || `criterion ${String(index + 1)}`} up`}>
          ↑ Up
        </button>
        <button type="button" className="button button--sm" disabled={disabled || index === total - 1} onClick={() => onMove(1)} aria-label={`Move ${value.name || `criterion ${String(index + 1)}`} down`}>
          ↓ Down
        </button>
        <button type="button" className="button button--sm" disabled={disabled || total <= 1} onClick={onRemove}>
          Remove
        </button>
      </div>
    </fieldset>
  );
}

/**
 * Client-side mirror of the server's rubric validation, so the organizer sees
 * the problem before submitting. The server recomputes all of it; this is a
 * convenience, never the control.
 */
function validate(rows: Draft[]): string[] {
  const problems: string[] = [];
  if (rows.length === 0) problems.push('A rubric needs at least one criterion.');
  const total = rows.reduce((sum, row) => sum + (Number.isFinite(row.weight) ? row.weight : 0), 0);
  if (Math.abs(total - 1) > 1e-9) problems.push(`Weights total ${formatNumber(total * 100, 2)}%. They must total 100%.`);
  if (!rows.some((row) => row.required)) problems.push('At least one criterion must be required, or a judge can submit a review answering nothing.');
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const label = `Criterion ${String(index + 1)}${row.name === '' ? '' : ` (${row.name})`}`;
    if (row.name.trim() === '') problems.push(`${label}: needs a name.`);
    if (!Number.isFinite(row.weight) || row.weight < 0 || row.weight > 1) problems.push(`${label}: weight must be between 0 and 1.`);
    if (row.max <= row.min) problems.push(`${label}: max (${String(row.max)}) must be greater than min (${String(row.min)}).`);
    if (row.required && row.weight === 0) problems.push(`${label}: a required criterion with zero weight is never decisive.`);
    const key = row.key.trim();
    if (key !== '') {
      if (seen.has(key)) problems.push(`${label}: key "${key}" is used more than once.`);
      seen.add(key);
    }
  });
  return problems;
}

export { ErrorNotice };

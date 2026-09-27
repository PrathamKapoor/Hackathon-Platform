import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Review, type ReviewInput, type RubricCriterion } from '../api.ts';
import { ErrorNotice, Loading, stateLabel, useApi } from '../ui.tsx';

/**
 * Judge scoring form.
 *
 * Two bugs worth naming, both found by a browser test rather than by a unit
 * test:
 *
 *  1. The form used to iterate `review.criteria` to decide which questions to
 *     render. `criteria` holds stored ANSWERS, so on a review nobody has touched
 *     it is an empty array: the form rendered no inputs, and clicking "Start
 *     review" looked like a crash. The questions are in `review.rubric.criteria`.
 *  2. It posted to `/api/submissions/:id/reviews/me`. That endpoint does not
 *     exist. Reviews are addressed by ASSIGNMENT, and drafting and submitting
 *     are separate calls — `PUT .../review` then `POST .../review/submit`.
 *
 * The rubric version the review was started against is authoritative for the
 * form. If an organizer edits a DRAFT rubric while a judge is mid-review, the
 * judge keeps the questions they were asked, which is the only defensible
 * behaviour.
 */
export function ReviewPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>();
  const navigate = useNavigate();


  const path =
    assignmentId === undefined ? null : `/api/assignments/${encodeURIComponent(assignmentId)}/review`;
  const { data: review, error, loading, reload } = useApi<Review>(path);

  const [summary, setSummary] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'draft' | 'submit'>(null);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [startedAt] = useState(() => Date.now());

  /*
   * Seed the form from the loaded review. Keyed on the score id, not the object,
   * so a background reload of the same review does not discard what the judge is
   * currently typing — and so switching reviews never leaves the previous
   * review's numbers in the boxes.
   */
  const scoreId = review?.score.id ?? null;
  useEffect(() => {
    if (review === null) return;
    setSummary(review.score.summary);
    const nextAnswers: Record<string, string> = {};
    const nextComments: Record<string, string> = {};
    for (const answer of review.criteria) {
      nextAnswers[answer.criterionId] = String(answer.value);
      nextComments[answer.criterionId] = answer.comment;
    }

    setAnswers(nextAnswers);
    setComments(nextComments);
  }, [scoreId, review]);

  const criteria: RubricCriterion[] = review?.rubric.criteria ?? [];
  const state = review?.score.state ?? 'DRAFT';
  const locked = state === 'SUBMITTED' || state === 'LOCKED';
  const required = useMemo(() => criteria.filter((criterion) => criterion.required), [criteria]);
  const missing = useMemo(
    () => required.filter((criterion) => (answers[criterion.id] ?? '') === ''),
    [required, answers],
  );

  const buildInput = useCallback((): ReviewInput => {
    return {
      criteria: criteria.map((criterion) => ({
        criterionId: criterion.id,
        value: Number(answers[criterion.id] ?? 0),
        comment: comments[criterion.id] ?? '',
      })),
      summary,
      durationMs: Math.min(Date.now() - startedAt, 86_400_000),
    };
  }, [criteria, answers, comments, summary, startedAt]);

  if (loading) return <Loading label="Opening your review" />;

  if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
    return (
      <div className="page">
        <h1>Review unavailable</h1>
        <ErrorNotice error={error} />
        <p className="muted">
          This review is not in your queue, or it belongs to another judge. Both are refused by the server, not just hidden
          in the client.
        </p>
        <Link className="button" to="/judge">
          Back to queue
        </Link>
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="page">
        <ErrorNotice error={error} />
      </div>
    );
  }

  if (review === null || assignmentId === undefined) return <Loading />;

  /*
   * A review with no score row yet still needs a form, because the judge has to
   * be able to start it. POST opens or resumes, which creates the score.
   */
  const total = criteria.reduce((sum, criterion) => sum + (Number(answers[criterion.id]) || 0) * criterion.weight, 0);
  // Optional: an organizer's view of a review omits judge guidance, so this
  // must not be dereferenced unconditionally.
  const guidance = (review.rubric.judgeGuidance ?? '').trim();
  const rubricLocked = review.rubric.status !== 'DRAFT';


  const act = async (mode: 'draft' | 'submit'): Promise<void> => {
    setBusy(mode);
    setBanner(null);
    const base = `/api/assignments/${encodeURIComponent(assignmentId)}/review`;
    try {
      if (mode === 'submit') {
        await api.post(`${base}/submit`, buildInput());
        await reload();
        // Straight back to the queue: a judge working a list should never have to
        // navigate to find the next item.
        navigate('/judge');

        return;
      }
      await api.put(base, buildInput());
      await reload();
      setBanner({ tone: 'ok', text: 'Draft saved.' });
    } catch (caught) {
      setBanner({
        tone: 'bad',
        text: caught instanceof ApiError ? caught.message : 'Could not save the review.',
      });
      // The server rejected it, so its copy is still authoritative. Pull it back
      // rather than leaving numbers on screen the server never accepted.
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="row row--between row--wrap" style={{ marginBottom: 18 }}>
        <div>
          <h1>Review</h1>
          <p className="muted small" style={{ marginTop: 4 }}>
            Rubric v{review.rubric.version} · {stateLabel(state)}
            {review.score.submitted_at !== null
              ? ` · submitted ${new Date(review.score.submitted_at).toLocaleString()}`
              : ''}
          </p>
        </div>
        <Link className="button button--ghost" to="/judge">
          Back to queue
        </Link>
      </div>

      {rubricLocked ? (
        <p className="small muted" style={{ marginTop: -8, marginBottom: 16 }}>
          This rubric version is locked because scores exist against it. You are answering exactly the questions judges
          were asked at the time.
        </p>
      ) : null}

      {guidance !== '' ? (
        <section className="card card--pad" style={{ marginBottom: 20, borderLeft: '3px solid var(--accent)' }}>
          <h2 className="small" style={{ margin: 0 }}>
            What this rubric is asking
          </h2>
          <p className="small" style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
            {guidance}
          </p>
        </section>
      ) : null}

      {banner !== null ? (
        <div className={`notice notice--${banner.tone}`} role="status" style={{ marginBottom: 16 }}>
          {banner.text}
        </div>
      ) : null}

      {criteria.map((criterion) => {
        const value = answers[criterion.id] ?? '';
        const outOfRange = value !== '' && (Number(value) < criterion.min || Number(value) > criterion.max);
        return (
          <section key={criterion.id} className="card card--pad" style={{ marginBottom: 14 }}>
            <div className="row row--between row--wrap" style={{ marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{criterion.name}</h2>
              <span className="muted small nowrap">
                {criterion.min}–{criterion.max} · weight {(criterion.weight * 100).toFixed(0)}%
                {criterion.required ? '' : ' · optional'}
              </span>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              {criterion.description}
            </p>
            <label className="label" htmlFor={`score-${criterion.id}`}>
              {criterion.name} score
            </label>
            <ScoreControl
              criterion={criterion}
              value={value}
              disabled={locked || busy !== null}
              invalid={outOfRange}
              onChange={(next) => setAnswers((current) => ({ ...current, [criterion.id]: next }))}
            />
            {outOfRange ? (
              <p id={`err-${criterion.id}`} className="small" style={{ color: 'var(--danger)', margin: '6px 0 0' }}>
                Out of range: {criterion.min}–{criterion.max}. The server rejects this with a 422 rather than clamping it,
                so a typo cannot quietly become a real score.
              </p>
            ) : null}
            <label className="label" htmlFor={`comment-${criterion.id}`} style={{ marginTop: 12 }}>
              Comment <span className="muted small">optional</span>
            </label>
            <textarea
              id={`comment-${criterion.id}`}
              className="input"
              rows={3}
              value={comments[criterion.id] ?? ''}
              disabled={locked || busy !== null}
              placeholder="What did you see? Specific enough that the team could act on it."
              onChange={(changeEvent) =>
                setComments((current) => ({ ...current, [criterion.id]: changeEvent.target.value }))
              }
            />
          </section>
        );
      })}

      <section className="card card--pad" style={{ marginBottom: 20 }}>
        <label className="label" htmlFor="review-summary">
          Summary
        </label>
        <textarea
          id="review-summary"
          className="input"
          rows={4}
          value={summary}
          disabled={locked || busy !== null}
          placeholder="One paragraph the team can act on."
          onChange={(changeEvent) => setSummary(changeEvent.target.value)}
        />
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Weighted total from the scores above: <strong>{total.toFixed(2)}</strong>. The published result uses the
          normalization the organizer chose, not this number — that is why your raw score and the ranking are allowed to
          disagree.
        </p>
      </section>

      {locked ? (
        <p className="muted">This review is submitted and can no longer be changed.</p>
      ) : (
        <>
          <div className="row row--wrap" style={{ gap: 10 }}>
            <button
              type="button"
              className="button button--ghost"
              disabled={busy !== null}
              onClick={() => void act('draft')}
            >
              {busy === 'draft' ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy !== null || missing.length > 0}
              onClick={() => void act('submit')}
            >
              {busy === 'submit' ? 'Submitting…' : 'Submit review'}
            </button>
          </div>
          {missing.length > 0 ? (
            <p className="small" style={{ color: 'var(--danger)', marginTop: 10 }} role="status">
              Score every required criterion first: {missing.map((criterion) => criterion.name).join(', ')}.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The score input for one criterion, chosen from its `scoringType`.
 *
 * The engine supports INTEGER, DECIMAL and BOOLEAN (`SCORING_TYPES` in
 * `packages/core/src/types.ts`). A single range slider cannot express all three:
 * a slider snaps to integers, so a DECIMAL criterion could not be scored at
 * 7.5, and a BOOLEAN criterion rendered as a 0..1 drag is a worse control than
 * two buttons. The step is therefore `1` for INTEGER and `any` for DECIMAL, and
 * BOOLEAN on a 0..1 scale is a pair of explicit choices.
 *
 * Every control carries `data-criterion`, which is what the browser tests use to
 * find the scores. Selecting by role and name is brittle here because the
 * accessible name is the criterion's name, and a rubric can have two criteria
 * with similar names.
 */
function ScoreControl({
  criterion,
  value,
  disabled,
  invalid,
  onChange,
}: {
  criterion: RubricCriterion;
  value: string;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const id = `score-${criterion.id}`;
  const describedBy = invalid ? `err-${criterion.id}` : undefined;

  if (criterion.scoringType === 'BOOLEAN' && criterion.min === 0 && criterion.max === 1) {
    return (
      <div className="row" style={{ gap: 8 }} role="group" aria-labelledby={`${id}-label`}>
        <span id={`${id}-label`} className="sr-only">
          {criterion.name} score
        </span>
        {[
          { label: 'No', next: '0' },
          { label: 'Yes', next: '1' },
        ].map((option) => (
          <button
            key={option.next}
            type="button"
            id={option.next === '0' ? id : `${id}-yes`}
            data-criterion={criterion.id}
            className={`button button--sm ${value === option.next ? 'button--primary' : ''}`}
            aria-pressed={value === option.next}
            disabled={disabled}
            onClick={() => onChange(option.next)}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <input
      id={id}
      data-criterion={criterion.id}
      className="input"
      type="number"
      inputMode={criterion.scoringType === 'INTEGER' ? 'numeric' : 'decimal'}
      step={criterion.scoringType === 'INTEGER' ? 1 : 'any'}
      min={criterion.min}
      max={criterion.max}
      value={value}
      disabled={disabled}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      onChange={(changeEvent) => onChange(changeEvent.target.value)}
      style={{ maxWidth: 200 }}
    />
  );
}

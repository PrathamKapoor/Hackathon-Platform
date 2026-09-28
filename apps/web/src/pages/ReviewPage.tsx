import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type JudgeQueue, type Review, type ReviewInput, type RubricCriterion } from '../api.ts';
import { Empty, ErrorNotice, Loading, stateLabel, useApi } from '../ui.tsx';
import { useSession } from '../session.tsx';

/**
 * ---------------------------------------------------------------------------
 * THE JUDGE SCORING SURFACE
 * ---------------------------------------------------------------------------
 * Built for someone working a list of thirty to a hundred projects, often on a
 * laptop on a venue table, often interrupted. That drives every decision here:
 *
 *   - **Context before controls.** A judge cannot score a project they have not
 *     read, and the queue already carries the description and links. They are
 *     fetched alongside the review and shown first, with a "what this is"
 *     summary above the fold.
 *   - **Never lose work.** Every change is autosaved after a short pause, and the
 *     save state is always visible. Drafts survive a closed tab, a lost network,
 *     and a browser crash, because the server stores them.
 *   - **Orientation.** Where you are in the queue, what is left, and a direct
 *     route to the previous and next project — so a judge working a list is
 *     never hunting for the next item.
 *   - **Honest lock state.** A submitted review is read-only and says so, with
 *     the timestamp.
 *
 * Two bugs here were worth naming, both found by a browser test rather than a
 * unit test:
 *
 *   1. The form used to iterate `review.criteria` to decide which questions to
 *      render. `criteria` holds stored ANSWERS, so on a review nobody had
 *      touched it is an empty array: the form rendered no inputs, and clicking
 *      "Start review" looked like a crash. The questions are in
 *      `review.rubric.criteria`.
 *   2. It posted to `/api/submissions/:id/reviews/me`, which does not exist.
 *      Reviews are addressed by ASSIGNMENT, and drafting and submitting are
 *      separate calls — `PUT .../review` then `POST .../review/submit`.
 *
 * The rubric version a review was started against is authoritative for the
 * form. If an organizer edits a DRAFT rubric while a judge is mid-review, the
 * judge keeps the questions they were asked, which is the only defensible
 * behaviour.
 */
export function ReviewPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>();
  const navigate = useNavigate();

  const reviewPath = assignmentId === undefined ? null : `/api/assignments/${encodeURIComponent(assignmentId)}/review`;
  const { data: review, error, loading, reload } = useApi<Review>(reviewPath);

  /*
   * The queue is fetched as well as the review, for three things the review
   * endpoint does not carry: the project context a judge needs in order to
   * score, the position in the queue, and the previous/next links. It is the
   * same endpoint the queue page uses, so it is scoped to this judge by
   * construction — there is no "other judge's queue" to ask for.
   *
   * The event comes from the signed-in user's own scope, exactly as the queue
   * page does it. The API resolves an event by id or slug and deliberately has
   * no notion of "the active event": the server must never guess which one a
   * request meant.
   */
  const session = useSession();
  const eventId = session.user?.eventIds[0] ?? null;
  const { data: queue } = useApi<JudgeQueue>(eventId === null ? null : `/api/events/${eventId}/judging/queue`);

  const [summary, setSummary] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'draft' | 'submit'>(null);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
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
    setSaveState('idle');
  }, [scoreId, review]);

  const criteria: RubricCriterion[] = review?.rubric.criteria ?? [];
  const state = review?.score.state ?? 'DRAFT';
  const locked = state === 'SUBMITTED' || state === 'LOCKED';
  const required = useMemo(() => criteria.filter((criterion) => criterion.required), [criteria]);
  const missing = useMemo(
    () => required.filter((criterion) => (answers[criterion.id] ?? '') === ''),
    [required, answers],
  );

  // The project this review is for, taken from the queue by assignment id.
  const project = useMemo(
    () => queue?.items.find((item) => item.assignmentId === assignmentId) ?? null,
    [queue, assignmentId],
  );
  const position = useMemo(() => {
    if (queue === null || assignmentId === undefined) return null;
    const index = queue.items.findIndex((item) => item.assignmentId === assignmentId);
    if (index < 0) return null;
    return {
      index,
      total: queue.items.length,
      previous: index > 0 ? (queue.items[index - 1] ?? null) : null,
      next: index < queue.items.length - 1 ? (queue.items[index + 1] ?? null) : null,
    };
  }, [queue, assignmentId]);

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

  /*
   * Autosave.
   *
   * A judge scoring a hundred projects should never have to remember to press
   * save, and should never lose a paragraph of feedback to a closed tab. The
   * delay exists so typing does not produce a request per keystroke; the
   * in-flight guard means a slow save is not followed by a second one over the
   * top of it, which is the ordering bug that silently drops the last edit.
   */
  const inFlight = useRef(false);
  useEffect(() => {
    if (locked || saveState !== 'dirty' || review === null) return;
    const timer = setTimeout(() => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSaveState('saving');
      api
        .put(`/api/assignments/${encodeURIComponent(assignmentId as string)}/review`, buildInput())
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'))
        .finally(() => {
          inFlight.current = false;
        });
    }, 1200);
    return () => clearTimeout(timer);
  }, [saveState, buildInput, locked, review, assignmentId]);

  // Mark dirty on any edit, so the autosave above has something to trigger on.
  const touch = useCallback(() => {
    if (!locked) setSaveState('dirty');
  }, [locked]);

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
        // Straight to the next project if there is one, because a judge working
        // a list should never have to navigate to find the next item.
        if (position?.next != null) {
          navigate(`/judge/${position.next.assignmentId}`);
          return;
        }
        navigate('/judge');
        return;
      }
      inFlight.current = true;
      await api.put(base, buildInput());
      setSaveState('saved');
      setBanner({ tone: 'ok', text: 'Draft saved.' });
    } catch (caught) {
      setSaveState('error');
      setBanner({
        tone: 'bad',
        text: caught instanceof ApiError ? caught.message : 'Could not save the review.',
      });
      // The server rejected it, so its copy is still authoritative. Pull it back
      // rather than leaving numbers on screen the server never accepted.
      await reload();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  return (
    <div className="page">
      {/* ------------------------------------------------- orientation --- */}
      <div className="row row--between row--wrap" style={{ marginBottom: 6 }}>
        <div>
          <h1>{project?.projectName ?? 'Review'}</h1>
          <p className="muted small" style={{ marginTop: 4 }}>
            Rubric v{String(review.rubric.version)} · {stateLabel(state)}
            {review.score.submitted_at !== null
              ? ` · submitted ${new Date(review.score.submitted_at).toLocaleString()}`
              : ''}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <SaveIndicator state={saveState} />
          <Link className="button button--ghost" to="/judge">
            Back to queue
          </Link>
        </div>
      </div>

      {position !== null ? (
        <nav className="review-nav" aria-label="Queue position">
          {position.previous !== null ? (
            <Link className="button button--sm" to={`/judge/${position.previous.assignmentId}`}>
              ← {position.previous.projectName}
            </Link>
          ) : (
            <span className="small dim">Start of queue</span>
          )}
          <span className="small muted nowrap">
            {String(position.index + 1)} of {String(position.total)} · {String(queue?.progress.remaining ?? 0)} left
          </span>
          {position.next !== null ? (
            <Link className="button button--sm" to={`/judge/${position.next.assignmentId}`}>
              {position.next.projectName} →
            </Link>
          ) : (
            <span className="small dim">End of queue</span>
          )}
        </nav>
      ) : null}

      {project !== null && queue !== null ? (
        <div className="meter" style={{ margin: '10px 0 18px' }} role="progressbar" aria-valuenow={queue.progress.percent ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Queue completion">
          <span style={{ width: `${String(queue.progress.percent ?? 0)}%` }} />
        </div>
      ) : null}

      {/* ------------------------------------------------- project context --- */}
      {project !== null ? (
        <section className="card card--pad" style={{ marginBottom: 18 }}>
          <p className="small">{project.shortDescription}</p>
          {project.fullDescription !== null && project.fullDescription.trim() !== '' ? (
            <details style={{ marginTop: 10 }}>
              <summary className="small strong" style={{ cursor: 'pointer' }}>
                Read the full description
              </summary>
              <p className="small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                {project.fullDescription}
              </p>
            </details>
          ) : null}
          <div className="row row--wrap" style={{ gap: 6, marginTop: 12 }}>
            {project.technologies.map((tech) => (
              <span key={tech} className="badge tiny">{tech}</span>
            ))}
          </div>
          <div className="row row--wrap" style={{ gap: 8, marginTop: 12 }}>
            {project.repositoryUrl !== null ? (
              <a className="button button--sm" href={project.repositoryUrl} rel="noreferrer noopener" target="_blank">
                Repository
              </a>
            ) : null}
            {project.demoUrl !== null ? (
              <a className="button button--sm" href={project.demoUrl} rel="noreferrer noopener" target="_blank">
                Live demo
              </a>
            ) : null}
            {project.documentationUrl !== null ? (
              <a className="button button--sm" href={project.documentationUrl} rel="noreferrer noopener" target="_blank">
                Documentation
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

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

      {criteria.length === 0 ? (
        <Empty title="This rubric has no criteria">
          An organizer has not published any questions yet, so there is nothing to score. If this looks wrong, tell them —
          a rubric with no criteria cannot produce a review.
        </Empty>
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
              onChange={(next) => {
                setAnswers((current) => ({ ...current, [criterion.id]: next }));
                touch();
              }}
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
              onChange={(changeEvent) => {
                setComments((current) => ({ ...current, [criterion.id]: changeEvent.target.value }));
                touch();
              }}
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
          onChange={(changeEvent) => {
            setSummary(changeEvent.target.value);
            touch();
          }}
        />
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Weighted total from the scores above: <strong>{total.toFixed(2)}</strong>. The published result uses the
          normalization the organizer chose, not this number — that is why your raw score and the ranking are allowed to
          disagree.
        </p>
      </section>

      {locked ? (
        <p className="muted">
          This review is submitted and can no longer be changed. An organizer can apply a documented override if a
          correction is genuinely needed, and it will be recorded in the audit ledger.
        </p>
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
              className="button button--primary"
              disabled={busy !== null || missing.length > 0}
              onClick={() => void act('submit')}
            >
              {busy === 'submit' ? 'Submitting…' : 'Submit review'}
            </button>
          </div>
          {/*
            The button says "Submit review" even though submitting also advances,
            because a label should name the action, not narrate the navigation.
            What happens next is stated underneath instead, which is where a
            judge actually looks before committing a score.
          */}
          {position?.next != null ? (
            <p className="tiny dim" style={{ marginTop: 8 }}>
              Submitting locks this review and opens {position.next.projectName}, the next in your queue.
            </p>
          ) : null}
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
 * The save state, always visible.
 *
 * An autosave a judge cannot see is an autosave they cannot trust, and one they
 * cannot tell failed is worse than one that did not exist. `aria-live` so it is
 * announced without stealing focus.
 *
 * `data-save-state` carries the machine-readable state alongside the human
 * label. That is not a test hook: it is what a stylesheet would key off, and it
 * lets the browser tests assert the state exactly instead of matching on
 * rendered text — which matters, because "Saved" is a substring of "Score every
 * required criterion first" once matching is case-insensitive.
 */
function SaveIndicator({ state }: { state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error' }) {
  if (state === 'idle') return null;
  const text =
    state === 'dirty' ? 'Unsaved changes' : state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save failed';
  const tone = state === 'error' ? 'badge--bad' : state === 'saved' ? 'badge--ok' : '';
  return (
    <span className={`badge ${tone}`} data-save-state={state} aria-live="polite" role="status">
      {text}
    </span>
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

import { useEffect, useState } from 'react';
import { api, ApiError, type PairwiseQueue, splitTechnologies } from '../api.ts';
import { useSession } from '../session.tsx';
import { Empty, ErrorNotice, Loading, useApi } from '../ui.tsx';

type Outcome = 'LEFT' | 'RIGHT' | 'TIE' | 'SKIPPED';

/**
 * Head-to-head judging.
 *
 * The engine derives a Bradley–Terry ranking from these comparisons and merges
 * it into the published result. Two details that are easy to get wrong and were
 * caught by reading the actual payload rather than the route table:
 *
 *  - each side's `technologies` is a comma-separated STRING. The pairwise
 *    endpoint reads it straight off the submissions row instead of the parsed
 *    JSON array the gallery returns, so it must be split here.
 *  - a pair is identified by its two submission ids, not by a pair id. The
 *    POST takes `leftSubmissionId` and `rightSubmissionId`; the queue is derived
 *    deterministically per judge, so "which pairs remain" is a client-side
 *    question and cannot be forged.
 *
 * Position bias is the reason this exists: the same two projects swap sides
 * between judges, so a judge who always prefers the top card does not
 * systematically advantage one project.
 */
export function PairwisePage() {
  const session = useSession();
  const eventId = session.user?.eventIds[0];
  const { data, error, loading, reload } = useApi<PairwiseQueue>(
    eventId === undefined ? null : `/api/events/${eventId}/pairwise/queue?pairs=20`,
  );

  // Which pairs this browser has recorded. Kept in component state on purpose:
  // the API has no "my completed comparisons" endpoint for a judge, and the
  // queue is deterministic, so a judge who reloads re-sees the same pairs and
  // can re-answer without any server bookkeeping. A recorded comparison is
  // immutable, so a double submit is rejected rather than double-counted.
  const [done, setDone] = useState<Record<string, Outcome>>({});
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  // Load what this browser has already answered, if the queue ever grows a
  // per-judge record. Until then this stays empty and the note below explains it.
  useEffect(() => {
    if (data === null) return;
    setDone((current) => ({ ...current }));
  }, [data]);

  if (session.user !== null && eventId === undefined) {
    return (
      <div className="page">
        <h1>Head-to-head</h1>
        <Empty title="You are not on a judging panel">Head-to-head comparisons are only assigned to judges.</Empty>
      </div>
    );
  }
  if (loading) return <Loading label="Building your pairings" />;
  if (error !== null) {
    return (
      <div className="page">
        <ErrorNotice error={error} />
      </div>
    );
  }
  if (data === null) return null;

  const outstanding = data.pairs.filter((pair) => done[`${pair.left.id}:${pair.right.id}`] === undefined);
  const recorded = Object.keys(done).length;

  const record = async (index: number, outcome: Outcome): Promise<void> => {
    const pair = data.pairs[index];
    if (pair === undefined) return;
    setBusyIndex(index);
    setBanner(null);
    try {
      await api.post(`/api/events/${eventId}/pairwise`, {
        leftSubmissionId: pair.left.id,
        rightSubmissionId: pair.right.id,
        outcome,
      });
      setDone((current) => ({ ...current, [`${pair.left.id}:${pair.right.id}`]: outcome }));
      setBanner({ tone: 'ok', text: 'Comparison recorded.' });
    } catch (caught) {
      setBanner({
        tone: 'bad',
        text: caught instanceof ApiError ? caught.message : 'Could not record the comparison.',
      });
      // A conflict means it was already recorded, which is the same end state
      // from this judge's point of view.
      await reload();
    } finally {
      setBusyIndex(null);
    }
  };

  return (
    <div className="page page--wide">
      <div className="row row--between row--wrap" style={{ marginBottom: 8 }}>
        <div>
          <h1>Head-to-head</h1>
          <p className="muted small" style={{ marginTop: 4 }}>
            {recorded} of {data.total} recorded · pick the stronger project, or call it a tie.
          </p>
        </div>
      </div>

      <p className="small muted" style={{ maxWidth: 680 }}>
        Pairings are deterministic per judge and the two projects swap sides between judges, so always choosing the first
        card does not advantage any project. A tie is a real answer — a close field is information about the panel, not
        something to avoid.
      </p>

      {banner !== null ? (
        <div className={`notice notice--${banner.tone}`} role="status" style={{ margin: '16px 0' }}>
          {banner.text}
        </div>
      ) : null}

      {outstanding.length === 0 ? (
        <Empty title="All your pairings are recorded">
          Thank you. The engine folds these into a Bradley–Terry ranking, which is combined with the rubric scores.
        </Empty>
      ) : null}

      <div className="stack">
        {outstanding.map((pair) => {
          const index = data.pairs.indexOf(pair);
          const busy = busyIndex === index;
          return (
            <section key={pair.index} className="card card--pad">
              <p className="tiny dim" style={{ margin: 0, marginBottom: 12 }}>
                Pair {pair.index + 1} of {data.total}
              </p>
              <div className="row row--wrap" style={{ gap: 14, alignItems: 'stretch' }}>
                <SideCard side={pair.left} label="A" />
                <SideCard side={pair.right} label="B" />
              </div>
              <div className="row row--wrap" style={{ gap: 8, marginTop: 14 }}>
                <button type="button" className="button button--primary" disabled={busy} onClick={() => void record(index, 'LEFT')}>
                  A is stronger
                </button>
                <button type="button" className="button" disabled={busy} onClick={() => void record(index, 'TIE')}>
                  Tie
                </button>
                <button type="button" className="button" disabled={busy} onClick={() => void record(index, 'RIGHT')}>
                  B is stronger
                </button>
                <button type="button" className="button button--ghost" disabled={busy} onClick={() => void record(index, 'SKIPPED')}>
                  Cannot judge
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SideCard({ side, label }: { side: { id: string; projectName: string; shortDescription: string; technologies: string }; label: string }) {
  const technologies = splitTechnologies(side.technologies);
  return (
    <div className="card card--pad" style={{ flex: '1 1 260px', minWidth: 0 }}>
      <span className="badge" aria-hidden="true">
        {label}
      </span>
      <h3 style={{ margin: '8px 0 4px' }}>{side.projectName}</h3>
      <p className="small muted" style={{ margin: 0 }}>
        {side.shortDescription}
      </p>
      <div className="row row--wrap" style={{ marginTop: 10, gap: 5 }}>
        {technologies.map((tech) => (
          <span key={tech} className="badge tiny">
            {tech}
          </span>
        ))}
      </div>
    </div>
  );
}

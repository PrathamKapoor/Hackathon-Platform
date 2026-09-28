import { Link } from 'react-router-dom';
import type { JudgeQueue } from '../api.ts';
import { useSession } from '../session.tsx';
import { Empty, ErrorNotice, Loading, stateLabel, useApi } from '../ui.tsx';

/**
 * A judge's queue.
 *
 * The page deliberately shows only the projects this judge is assigned. There is
 * no "all projects" view to navigate to, because the endpoint that would back
 * one does not exist — blind judging here is a property of the API, not a filter
 * applied in the browser.
 *
 * Each row links to `/e/:slug/judge/:assignmentId`, not to the submission. The
 * review endpoints are addressed by assignment, because an assignment is what
 * carries the judge-to-submission pairing that authorizes the read.
 */
export function JudgeQueuePage() {
  const session = useSession();

  /*
   * The event comes from the signed-in user's own scopes. The API resolves an
   * event by id or slug and deliberately has no notion of "the active event":
   * an organizer running two events in parallel should never have the server
   * guess which one a request meant.
   */
  const eventId = session.user?.eventIds[0];
  const { data, error, loading } = useApi<JudgeQueue>(
    eventId === undefined ? null : `/api/events/${eventId}/judging/queue`,
  );

  if (session.user !== null && eventId === undefined) {
    return (
      <div className="page">
        <h1>Your judging queue</h1>
        <div className="empty" style={{ marginTop: 16 }}>
          <div className="strong">You are not on a judging panel</div>
          <div className="small" style={{ marginTop: 6 }}>
            An organizer has to invite you to an event first. Once you accept, your queue appears here.
          </div>
        </div>
      </div>
    );
  }

  if (loading) return <Loading label="Loading your queue" />;
  <ErrorNotice error={error} />;

  if (data === null) return null;

  const { progress } = data;
  const done = progress.percent;

  return (
    <div className="page page--wide">
      <div className="row row--between row--wrap" style={{ marginBottom: 20 }}>
        <div>
          <h1>Your judging queue</h1>
          <p className="muted small" style={{ marginTop: 4 }}>
            {progress.assigned} assigned · {progress.completed} submitted · {progress.inProgress} in progress
          </p>
        </div>
        <div style={{ minWidth: 200 }}>
          <div
            className="meter"
            role="progressbar"
            aria-valuenow={done}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Reviews completed"
          >
            <span style={{ width: `${String(done)}%` }} />
          </div>
          <div className="tiny dim" style={{ marginTop: 4, textAlign: 'right' }}>
            {done}% complete
          </div>
        </div>
      </div>

      {progress.inProgress > 0 ? (
        <div className="notice notice--warn" style={{ marginBottom: 16 }}>
          You have {progress.inProgress} review{progress.inProgress === 1 ? '' : 's'} in progress. Drafts save as you
          type, so you can close this tab and come back.
        </div>
      ) : null}

      {data.items.length === 0 ? (
        <Empty title="Nothing assigned yet">
          An organizer assigns projects after the panel accepts. Conflicts you have declared are excluded from
          assignment automatically.
        </Empty>
      ) : null}

      <div className="stack">
        {data.items.map((item) => (
          <article key={item.assignmentId} className="card card--pad">
            <div className="row row--between row--wrap">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row row--wrap" style={{ gap: 6, marginBottom: 6 }}>
                  <ScoreStateBadge state={item.scoreState} />
                  {item.status !== 'ASSIGNED' ? <span className="badge">{stateLabel(item.status)}</span> : null}
                </div>
                <h2 className="card-title" style={{ marginBottom: 4 }}>{item.projectName}</h2>
                <p className="small muted" style={{ margin: 0 }}>
                  {item.shortDescription}
                </p>
                <div className="row row--wrap" style={{ marginTop: 10, gap: 5 }}>
                  {item.technologies.map((tech) => (
                    <span key={tech} className="badge tiny">
                      {tech}
                    </span>
                  ))}
                </div>
              </div>

              <div className="row row--wrap" style={{ gap: 8, marginTop: 12 }}>
                {item.repositoryUrl !== null ? (
                  <a className="button button--sm" href={item.repositoryUrl} rel="noreferrer noopener" target="_blank">
                    Repository
                  </a>
                ) : null}
                {item.demoUrl !== null ? (
                  <a className="button button--sm" href={item.demoUrl} rel="noreferrer noopener" target="_blank">
                    Demo
                  </a>
                ) : null}
                <Link
                  to={`/judge/${item.assignmentId}`}
                  className={`button button--sm ${item.scoreState === 'SUBMITTED' ? '' : 'button--primary'}`}
                >
                  {item.scoreState === 'SUBMITTED' ? 'Review again' : item.scoreState === 'DRAFT' ? 'Continue' : 'Start review'}
                </Link>
              </div>
            </div>
          </article>
        ))}
      </div>

      <p className="tiny dim" style={{ marginTop: 24 }}>
        Signed in as {session.user?.displayName}. Your scores are visible to organizers in aggregate, and to nobody else
        individually. The queue you see is the only queue the API will give you.
      </p>
    </div>
  );
}

function ScoreStateBadge({ state }: { state: string }) {
  if (state === 'SUBMITTED' || state === 'LOCKED') return <span className="badge badge--ok">Submitted</span>;
  if (state === 'DRAFT') return <span className="badge badge--warn">Draft</span>;
  return <span className="badge">Not started</span>;
}

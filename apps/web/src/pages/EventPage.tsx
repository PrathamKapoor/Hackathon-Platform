import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type EventSummary } from '../api.ts';
import { useSession } from '../session.tsx';
import { ErrorNotice, Loading, formatInstant, stateLabel } from '../ui.tsx';

/**
 * Event landing page.
 *
 * The route accepts a slug or an id, because a shareable link should be a slug
 * and an operator pasting an id from a log should also work.
 */
export function EventPage({ eventRef }: { eventRef: string }) {
  const session = useSession();
  const [event, setEvent] = useState<EventSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api
      .get<EventSummary>(`/api/events/${encodeURIComponent(eventRef)}`, controller.signal)
      .then((value) => {
        setEvent(value);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [eventRef]);

  if (loading) return <Loading label="Loading event" />;
  <ErrorNotice error={error} />;
  if (event === null) return null;

  const organizes = session.canOrganize(event.id);
  const published = event.dates.resultsPublishedAt !== null;

  return (
    <div className="page">
      <div className="hero">
        <div className="row row--wrap" style={{ marginBottom: 10 }}>
          <span className="badge" style={{ background: 'rgb(255 255 255 / 18%)', color: '#fff', borderColor: 'transparent' }}>
            {stateLabel(event.state)}
          </span>
          {published ? (
            <span className="badge badge--ok">Results published</span>
          ) : (
            <span className="badge">Results not published</span>
          )}
        </div>
        <h1>{event.name}</h1>
        <p style={{ marginTop: 8 }}>{event.tagline}</p>
      </div>

      <div className="row row--wrap" style={{ margin: '24px 0' }}>
        <Link to={`/e/${event.slug}/gallery`} className="button">
          Project gallery
        </Link>
        <Link to={`/e/${event.slug}/results`} className="button button--primary">
          {published ? 'View results' : 'Results (not published)'}
        </Link>
        {organizes ? (
          <Link to="/organize" className="button">
            Organizer console
          </Link>
        ) : null}
      </div>

      <div className="row row--wrap" style={{ alignItems: 'stretch' }}>
        <Panel title="Schedule">
          <ScheduleRow label="Registration" from={event.dates.registration.opensAt} to={event.dates.registration.closesAt} />
          <ScheduleRow label="Submissions" from={event.dates.submission.opensAt} to={event.dates.submission.closesAt} />
          <ScheduleRow label="Judging" from={event.dates.judging.opensAt} to={event.dates.judging.closesAt} />
          <ScheduleRow label="Voting" from={event.dates.voting.opensAt} to={event.dates.voting.closesAt} />
        </Panel>

        <Panel title="Format">
          <Row label="Team size" value={`${String(event.teams.min)}–${String(event.teams.max)}`} />
          <Row label="Individuals" value={event.teams.allowIndividual ? 'Allowed' : 'Not allowed'} />
          <Row label="Reviews per project" value={String(event.judging.reviewsPerProject)} />
          <Row label="Minimum judges" value={String(event.judging.minimumJudges)} />
          <Row label="Timezone" value={event.timezone} />
        </Panel>

        <Panel title="Published decisions">
          <Row label="Gallery" value={stateLabel(event.gallery.visibility)} />
          <Row label="Results" value={stateLabel(event.results.visibility)} />
          <Row label="Judge counts" value={event.results.publishJudgeCount ? 'Shown' : 'Hidden'} />
          <Row label="Criterion breakdown" value={event.results.publishCriterionBreakdown ? 'Shown' : 'Hidden'} />
        </Panel>
      </div>

      <div className="row row--wrap" style={{ marginTop: 24, alignItems: 'stretch' }}>
        <Panel title="About">
          <p className="small muted">{event.description}</p>
        </Panel>
        <Panel title="Rules">
          <p className="small muted">{event.rules}</p>
        </Panel>
      </div>
    </div>
  );
}

/**
 * A top-level section of the page.
 *
 * `h2`, not `h3`: each panel sits directly under the page's `h1`, and a heading
 * that skips a level breaks the outline a screen reader user navigates by. The
 * heading level is a structural fact about the page, not a size choice - the
 * size comes from the stylesheet.
 */
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card card--pad" style={{ flex: '1 1 280px' }}>
      <h2>{title}</h2>
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row row--between small" style={{ padding: '5px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <span className="muted">{label}</span>
      <span className="strong">{value}</span>
    </div>
  );
}

function ScheduleRow({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <div className="small" style={{ padding: '5px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div className="strong">{label}</div>
      <div className="muted">
        {formatInstant(from)} → {formatInstant(to)}
      </div>
    </div>
  );
}

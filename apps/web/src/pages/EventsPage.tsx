import { Link } from 'react-router-dom';
import type { EventSummary, Page } from '../api.ts';
import { Empty, ErrorNotice, Loading, formatInstant, stateLabel, useApi } from '../ui.tsx';

export function EventsPage() {
  const { data, error, loading } = useApi<Page<EventSummary>>('/api/events?perPage=50');

  return (
    <div className="page">
      <div className="row row--between" style={{ marginBottom: 20 }}>
        <div>
          <h1>Events</h1>
          <p className="muted small">Every event on this instance. Public by design — results and galleries are meant to be read.</p>
        </div>
      </div>

      {loading ? <Loading /> : null}
      <ErrorNotice error={error} />

      {data !== null && data.data.length === 0 ? <Empty title="No events yet">An organizer has to create the first one.</Empty> : null}

      <div className="stack">
        {data?.data.map((event) => (
          <article key={event.id} className="card card--pad">
            <div className="row row--between row--wrap">
              <div style={{ minWidth: 0 }}>
                <div className="row row--wrap" style={{ marginBottom: 4 }}>
                  <span className="badge badge--info">{stateLabel(event.state)}</span>
                  {event.dates.resultsPublishedAt !== null ? <span className="badge badge--ok">Results published</span> : null}
                  <span className="badge">{event.judging.reviewsPerProject} reviews per project</span>
                </div>
                <h2>
                  <Link to={`/e/${event.slug}`}>{event.name}</Link>
                </h2>
                <p className="muted small" style={{ marginTop: 4 }}>
                  {event.tagline}
                </p>
              </div>
              <dl className="small muted" style={{ margin: 0, textAlign: 'right', minWidth: 200 }}>
                <div>
                  <dt className="dim">Submissions close</dt>
                  <dd style={{ margin: 0 }}>{formatInstant(event.dates.submission.closesAt)}</dd>
                </div>
                <div style={{ marginTop: 6 }}>
                  <dt className="dim">Judging closes</dt>
                  <dd style={{ margin: 0 }}>{formatInstant(event.dates.judging.closesAt)}</dd>
                </div>
              </dl>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

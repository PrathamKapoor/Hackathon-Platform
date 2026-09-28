import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type GalleryCard,
  type GalleryPage as GalleryPageData,
  type TechnologyCount,
} from '../api.ts';
import { Empty, ErrorNotice, Loading, stateLabel, useApi } from '../ui.tsx';

/**
 * Public project gallery.
 *
 * Two things here were wrong before a browser test caught them, and both are
 * worth recording:
 *
 *  - The card carries `team: { name, slug }` and `track: { name, color }` as
 *    nested objects. The client used to read `project.teamName`, which is
 *    `undefined`, so no team ever appeared and searching by team name silently
 *    matched nothing.
 *  - The technology filter list is `{ data: [{ technology, count }] }`, not
 *    `string[]`. Reading it as an array produced zero chips.
 *
 * Search is done client-side on purpose. The server paginates and filters, but
 * for an event's worth of projects fetching a single page keeps typing instant
 * and keeps the input working on a slow venue connection, which matters more
 * here than saving a round trip.
 */
export function GalleryPage({ eventRef }: { eventRef: string }) {
  const { data: event } = useApi<{ id: string; slug: string; name: string; gallery: { visibility: string; order: string } }>(
    `/api/events/${encodeURIComponent(eventRef)}`,
  );
  const [query, setQuery] = useState('');
  const [technology, setTechnology] = useState<string | null>(null);

  const technologiesPath = `/api/events/${encodeURIComponent(eventRef)}/gallery/technologies`;
  const { data: technologyData } = useApi<{ data: TechnologyCount[] }>(technologiesPath);

  const galleryPath =
    `/api/events/${encodeURIComponent(eventRef)}/gallery?perPage=200` +
    (technology === null ? '' : `&technology=${encodeURIComponent(technology)}`);
  const { data, error, loading } = useApi<GalleryPageData>(galleryPath);

  const search = query.trim().toLowerCase();
  const projects = (data?.data ?? []).filter((project) => {
    if (search === '') return true;
    return (
      project.projectName.toLowerCase().includes(search) ||
      project.shortDescription.toLowerCase().includes(search) ||
      // The nested read, not `teamName`.
      (project.team?.name ?? '').toLowerCase().includes(search) ||
      project.technologies.some((tech) => tech.toLowerCase().includes(search))
    );
  });

  const technologies = technologyData?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const orderMode = data?.ordering.mode ?? 'curated';

  return (
    <div className="page page--wide">
      <div className="row row--between row--wrap" style={{ marginBottom: 16 }}>
        <div>
          <h1>Projects</h1>
          {event !== null ? (
            <p className="muted small">
              <Link to={`/e/${event.slug}`}>{event.name}</Link> · {stateLabel(event.gallery.visibility)} gallery,{' '}
              {orderMode} order
              {data !== null ? ` · ${total} ${total === 1 ? 'project' : 'projects'}` : ''}
            </p>
          ) : null}
        </div>
        <div style={{ minWidth: 260, flex: '0 1 320px' }}>
          <label className="sr-only" htmlFor="gallery-search">
            Search projects
          </label>
          <input
            id="gallery-search"
            className="input"
            type="search"
            placeholder="Search name, team, technology"
            value={query}
            onChange={(changeEvent) => setQuery(changeEvent.target.value)}
          />
        </div>
      </div>

      {technologies.length > 0 ? (
        <div className="row row--wrap" style={{ marginBottom: 20, gap: 6 }} role="group" aria-label="Filter by technology">
          <button
            type="button"
            className={`badge ${technology === null ? 'badge--info' : ''}`}
            style={{ cursor: 'pointer' }}
            aria-pressed={technology === null}
            onClick={() => setTechnology(null)}
          >
            All
          </button>
          {technologies.map((tech) => (
            <button
              key={tech.technology}
              type="button"
              className={`badge ${technology === tech.technology ? 'badge--info' : ''}`}
              style={{ cursor: 'pointer' }}
              aria-pressed={technology === tech.technology}
              onClick={() => setTechnology(technology === tech.technology ? null : tech.technology)}
            >
              {tech.technology} <span className="muted">{tech.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {loading ? <Loading /> : null}
      <ErrorNotice error={error} />

      {!loading && data !== null && projects.length === 0 ? (
        <Empty title="No projects match">
          {search !== '' || technology !== null
            ? 'Clear the search or pick a different technology.'
            : 'No project has been published to the gallery yet.'}
        </Empty>
      ) : null}

      <div className="row row--wrap" style={{ alignItems: 'stretch' }}>
        {projects.map((project) => (
          <GalleryCardView key={project.id} project={project} eventSlug={event?.slug ?? eventRef} />
        ))}
      </div>
    </div>
  );
}

function GalleryCardView({ project, eventSlug }: { project: GalleryCard; eventSlug: string }) {
  return (
    <article className="card" style={{ flex: '1 1 320px', overflow: 'hidden' }}>
      {project.coverImageUrl !== null ? (
        <img
          src={project.coverImageUrl}
          alt=""
          loading="lazy"
          style={{ width: '100%', height: 150, objectFit: 'cover', display: 'block' }}
        />
      ) : null}
      <div className="card--pad">
        <div className="row row--wrap" style={{ marginBottom: 6, gap: 6 }}>
          {project.track !== null ? (
            <span className="badge">
              <span
                aria-hidden="true"
                style={{ width: 8, height: 8, borderRadius: 999, background: project.track.color }}
              />
              {project.track.name}
            </span>
          ) : null}
          {project.team !== null ? <span className="badge">{project.team.name}</span> : null}
        </div>
        <h2 className="card-title">
          <Link to={`/e/${eventSlug}/projects/${project.slug}`}>{project.projectName}</Link>
        </h2>
        <p className="small muted" style={{ marginTop: 6 }}>
          {project.shortDescription}
        </p>
        <div className="row row--wrap" style={{ marginTop: 12, gap: 5 }}>
          {project.technologies.map((tech) => (
            <span key={tech} className="badge tiny">
              {tech}
            </span>
          ))}
        </div>
        <div className="row row--wrap" style={{ marginTop: 14, gap: 8 }}>
          {project.repositoryUrl !== null ? (
            <a className="button button--sm" href={project.repositoryUrl} rel="noreferrer noopener" target="_blank">
              Repository
            </a>
          ) : null}
          {project.demoUrl !== null ? (
            <a className="button button--sm" href={project.demoUrl} rel="noreferrer noopener" target="_blank">
              Demo
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** The same loader the organizer view uses, kept here so the two agree. */
export async function fetchGallery(eventId: string): Promise<GalleryPageData> {
  return api.get<GalleryPageData>(`/api/events/${encodeURIComponent(eventId)}/gallery?perPage=200`);
}

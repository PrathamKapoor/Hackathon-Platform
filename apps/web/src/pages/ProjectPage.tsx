import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type GalleryProjectDetail } from '../api.ts';
import { useSession } from '../session.tsx';
import { Empty, ErrorNotice, Loading, formatInstant, useApi } from '../ui.tsx';

/**
 * The public project page.
 *
 * This route did not exist. Every card in the gallery linked to
 * `/e/:slug/projects/:slug`, and the router had no matching entry, so all
 * twelve project links in the seeded event landed on the 404 page. The
 * gallery was a dead end: an evaluator could browse projects and then not be
 * able to open one.
 *
 * It also carries the community vote, because a vote is cast against a project
 * and the project page is where a visitor has just read enough to decide. The
 * server decides everything else: whether voting is open, whether this account
 * may vote, whether they already did, and whether totals are visible at all.
 * Nothing here infers those.
 */
export function ProjectPage({ eventRef }: { eventRef: string }) {
  const { projectSlug } = useParams<{ projectSlug: string }>();
  const session = useSession();

  const eventPath = `/api/events/${encodeURIComponent(eventRef)}`;
  const path = projectSlug === undefined ? null : `${eventPath}/gallery/${encodeURIComponent(projectSlug)}`;
  const { data: project, error, loading } = useApi<GalleryProjectDetail>(path);

  /*
   * The vote surface needs two things the project payload does not carry: the
   * event's voting window, and whether *this* account has already voted. Both
   * come from /votes/mine, which is the endpoint designed to answer exactly that
   * and which refuses to leak a tally when the event hides it.
   */
  const canVoteAtAll = session.user !== null;
  const { data: voteState, reload: reloadVotes } = useApi<{
    canVote: boolean;
    reason: string | null;
    totalsVisible: boolean;
    votes: { submissionId: string; createdAt: string }[];
  }>(canVoteAtAll ? `${eventPath}/votes/mine` : null);

  const [busy, setBusy] = useState(false);
  const [voteError, setVoteError] = useState<unknown>(null);

  const alreadyVoted =
    project !== null && (voteState?.votes ?? []).some((vote) => vote.submissionId === project.id);

  if (loading) return <Loading label="Loading project" />;

  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="page">
        <h1>Project not available</h1>
        <Empty title="This project is not public">
          It may be hidden from the gallery, withdrawn by the team, or the link may be wrong. A hidden project is
          reported as missing rather than forbidden, so this page cannot be used to confirm that a private project exists.
        </Empty>
        <p style={{ marginTop: 16 }}>
          <Link className="button" to={`/e/${encodeURIComponent(eventRef)}/gallery`}>
            Back to the gallery
          </Link>
        </p>
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
  if (project === null) return <Loading />;

  const castVote = async (): Promise<void> => {
    if (project === null) return;
    setBusy(true);
    setVoteError(null);
    try {
      await api.post(`/api/events/${encodeURIComponent(eventRef)}/votes`, { submissionId: project.id });
      reloadVotes();
    } catch (cause) {
      setVoteError(cause);
    } finally {
      setBusy(false);
    }
  };

  const retractVote = async (): Promise<void> => {
    if (project === null) return;
    setBusy(true);
    setVoteError(null);
    try {
      await api.del(`/api/events/${encodeURIComponent(eventRef)}/votes/${encodeURIComponent(project.id)}`);
      reloadVotes();
    } catch (cause) {
      setVoteError(cause);
    } finally {
      setBusy(false);
    }
  };

  const links: { label: string; href: string | null }[] = [
    { label: 'Live demo', href: project.demoUrl },
    { label: 'Source code', href: project.repositoryUrl },
    { label: 'Video', href: project.videoUrl },
    { label: 'Documentation', href: project.documentationUrl },
  ];
  const presentLinks = links.filter((link) => link.href !== null);

  return (
    <div className="page">
      <p className="small muted" style={{ marginBottom: 12 }}>
        <Link to={`/e/${encodeURIComponent(eventRef)}/gallery`}>← All projects</Link>
      </p>

      <article className="card card--pad">
        <div className="row row--wrap" style={{ gap: 6, marginBottom: 10 }}>
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
          <span className="badge">Submitted {formatInstant(project.submittedAt)}</span>
        </div>

        <h1>{project.projectName}</h1>
        <p className="muted" style={{ marginTop: 8, fontSize: '1.05rem' }}>
          {project.shortDescription}
        </p>

        {project.technologies.length > 0 ? (
          <div className="row row--wrap" style={{ gap: 5, marginTop: 14 }}>
            {project.technologies.map((tech) => (
              <span key={tech} className="badge tiny">
                {tech}
              </span>
            ))}
          </div>
        ) : null}

        {presentLinks.length > 0 ? (
          <div className="row row--wrap" style={{ gap: 8, marginTop: 18 }}>
            {presentLinks.map((link) => (
              <a
                key={link.label}
                className={`button button--sm ${link.label === 'Live demo' ? 'button--primary' : ''}`}
                href={link.href as string}
                rel="noreferrer noopener"
                target="_blank"
              >
                {link.label}
              </a>
            ))}
          </div>
        ) : null}
      </article>

      {/* ------------------------------------------------------- vote --- */}
      <section className="card card--pad" style={{ marginTop: 16 }}>
        <div className="row row--between row--wrap">
          <div>
            <h2 style={{ fontSize: '1.1rem' }}>Community vote</h2>
            <p className="small muted" style={{ marginTop: 4 }}>
              {session.user === null
                ? 'Sign in to vote for a project.'
                : voteState?.canVote === true
                  ? 'One vote per account, per project. You can change it while voting is open.'
                  : (voteState?.reason ?? 'Voting is not available for this event.')}
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {project.votes.hidden === true ? (
              <span className="badge">Totals hidden</span>
            ) : (
              <span className="badge badge--info" aria-live="polite">
                {project.votes.count} {project.votes.count === 1 ? 'vote' : 'votes'}
              </span>
            )}            {session.user === null ? (
              <Link className="button button--sm button--primary" to="/signin">
                Sign in to vote
              </Link>
            ) : alreadyVoted ? (
              <button type="button" className="button button--sm" disabled={busy} onClick={() => void retractVote()}>
                {busy ? 'Withdrawing…' : 'Withdraw my vote'}
              </button>
            ) : (
              <button
                type="button"
                className="button button--sm button--primary"
                disabled={busy || voteState?.canVote !== true}
                onClick={() => void castVote()}
              >
                {busy ? 'Voting…' : 'Vote for this project'}
              </button>
            )}
          </div>
        </div>
        <ErrorNotice error={voteError} />
      </section>

      {/* ----------------------------------------------------- content --- */}
      {project.fullDescription.trim() !== '' ? (
        <section className="card card--pad" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: '1.1rem' }}>About this project</h2>
          <p style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{project.fullDescription}</p>
        </section>
      ) : null}

      {project.problem.trim() !== '' || project.solution.trim() !== '' ? (
        <div className="row row--wrap" style={{ marginTop: 16, alignItems: 'stretch' }}>
          {project.problem.trim() !== '' ? (
            <section className="card card--pad" style={{ flex: '1 1 280px' }}>
              <h2 style={{ fontSize: '1.1rem' }}>The problem</h2>
              <p className="small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                {project.problem}
              </p>
            </section>
          ) : null}
          {project.solution.trim() !== '' ? (
            <section className="card card--pad" style={{ flex: '1 1 280px' }}>
              <h2 style={{ fontSize: '1.1rem' }}>The solution</h2>
              <p className="small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                {project.solution}
              </p>
            </section>
          ) : null}
        </div>
      ) : null}

      {project.screenshots.length > 0 ? (
        <section className="card card--pad" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: '1.1rem' }}>Screenshots</h2>
          <div className="row row--wrap" style={{ marginTop: 12, gap: 12, alignItems: 'flex-start' }}>
            {project.screenshots.map((shot) => (
              <a key={shot.id} href={shot.url} target="_blank" rel="noreferrer noopener">
                <img
                  src={shot.url}
                  alt={`Screenshot of ${project.projectName}`}
                  loading="lazy"
                  style={{
                    width: 260,
                    maxWidth: '100%',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                    display: 'block',
                  }}
                />
              </a>
            ))}
          </div>
        </section>
      ) : null}

      {project.members.length > 0 ? (
        <section className="card card--pad" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: '1.1rem' }}>{project.team?.name ?? 'The team'}</h2>
          {project.team?.description ? (
            <p className="small muted" style={{ marginTop: 6 }}>
              {project.team.description}
            </p>
          ) : null}
          <ul className="row row--wrap" style={{ gap: 6, margin: '12px 0 0', padding: 0, listStyle: 'none' }}>
            {project.members.map((member) => (
              <li key={member.username} className="badge">
                {member.displayName}
                {member.role !== 'MEMBER' ? ` · ${member.role.toLowerCase()}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

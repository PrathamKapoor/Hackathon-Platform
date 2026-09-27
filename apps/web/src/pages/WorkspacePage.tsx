import { Link } from 'react-router-dom';
import type { EventSummary, Page } from '../api.ts';
import { useSession } from '../session.tsx';
import { Empty, ErrorNotice, Loading, stateLabel, useApi } from '../ui.tsx';

type RegistrationForm = {
  fields: { id: string; key: string; label: string; helpText: string; type: string; required: number; options: string[] }[];
};

type Team = { id: string; name: string; slug: string; eventId: string; memberCount: number };

type SubmissionSummary = { id: string; projectName: string; state: string; updatedAt: string; currentVersion: number };

/**
 * The participant workspace.
 *
 * One page rather than four, because a participant's job is usually one of a
 * handful of concrete things and the fastest interface is the one that shows
 * them all at once with the next action obvious.
 */
export function WorkspacePage() {
  const session = useSession();
  const eventId = session.user?.eventIds[0];
  const hasEvent = eventId !== undefined;

  const { loading: eventsLoading } = useApi<Page<EventSummary>>('/api/events');
  const { data: form, error: formError } = useApi<RegistrationForm>(
    hasEvent ? `/api/events/${eventId}/registration/form` : null,
  );
  const { data: registration } = useApi<{ state: string; eventId: string }>(
    hasEvent ? `/api/events/${eventId}/registration/me` : null,
  );
  const { data: team } = useApi<{ team: Team | null }>(hasEvent ? `/api/events/${eventId}/teams/mine` : null);
  const { data: submissions } = useApi<{ data: SubmissionSummary[] }>(
    hasEvent ? `/api/events/${eventId}/submissions` : null,
  );

  return (
    <div className="page page--wide">
      <h1>Your workspace</h1>
      <p className="muted small" style={{ marginTop: 4, marginBottom: 24 }}>
        {session.user?.displayName} · {session.user?.roles.map(stateLabel).join(', ')}
      </p>

      {!hasEvent ? (
        <Empty title="You are not registered for an event yet">
          {eventsLoading ? 'Loading events…' : 'Register below and your teams, submissions and judging queue appear here.'}
        </Empty>
      ) : null}

      <div className="row row--wrap" style={{ alignItems: 'stretch' }}>
        <Panel title="Registration">
          {formError !== null ? <ErrorNotice error={formError} /> : null}
          {form === null ? <Loading /> : null}
          {registration !== null ? (
            <div className={`notice ${registration.state === 'APPROVED' ? 'notice--ok' : ''}`}>
              <div className="strong">{stateLabel(registration.state)}</div>
            </div>
          ) : null}
          {form !== null && form.fields.length === 0 ? <p className="small muted">This event has no application form.</p> : null}
          {form !== null && form.fields.length > 0 ? (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {form.fields.map((field) => (
                <li key={field.id}>
                  {field.label}
                  {field.required === 1 ? <span className="dim"> (required)</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>

        <Panel title="Team">
          {team === null ? <Loading /> : null}
          {team !== null && team.team === null ? (
            <p className="small muted">You are not on a team yet. Teams are created from the event page.</p>
          ) : null}
          {team?.team !== null && team?.team !== undefined ? (
            <div>
              <div className="strong">{team.team.name}</div>
              <div className="small muted">
                {String(team.team.memberCount)} member{team.team.memberCount === 1 ? '' : 's'}
              </div>
            </div>
          ) : null}
        </Panel>

        <Panel title="Submissions">
          {submissions === null ? <Loading /> : null}
          {submissions !== null && submissions.data.length === 0 ? (
            <p className="small muted">Nothing submitted yet.</p>
          ) : null}
          {submissions !== null && submissions.data.length > 0 ? (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {submissions.data.map((submission) => (
                <li key={submission.id}>
                  <span className="strong">{submission.projectName}</span>{' '}
                  <span className="badge tiny">{stateLabel(submission.state)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      </div>

      <div className="row row--wrap" style={{ marginTop: 24, gap: 10 }}>
        <Link to="/events" className="button">
          Browse events
        </Link>
        {session.isJudge ? (
          <Link to="/judge" className="button button--primary">
            Go to your judging queue
          </Link>
        ) : null}
        {session.user?.roles.some((role) => role === 'ORGANIZER' || role === 'ADMIN') ? (
          <Link to="/organize" className="button button--primary">
            Organizer console
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card card--pad" style={{ flex: '1 1 280px' }}>
      <h3>{title}</h3>
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

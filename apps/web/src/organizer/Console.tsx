import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { Empty, ErrorNotice, Loading } from '../ui.tsx';
import { PanelBoundary } from '../PanelBoundary.tsx';
import { OverviewPanel } from './panels/OverviewPanel.tsx';
import { RegistrationsPanel } from './panels/RegistrationsPanel.tsx';
import { TeamsPanel } from './panels/TeamsPanel.tsx';
import { PanelPanel } from './panels/PanelPanel.tsx';
import { AssignmentsPanel } from './panels/AssignmentsPanel.tsx';
import { RubricPanel } from './panels/RubricPanel.tsx';
import { ResultsPanel } from './panels/ResultsPanel.tsx';
import { DiagnosticsPanel } from './panels/DiagnosticsPanel.tsx';
import { CommunityPanel } from './panels/CommunityPanel.tsx';
import { IntegrationsPanel } from './panels/IntegrationsPanel.tsx';
import { AuditPanel } from './panels/AuditPanel.tsx';
import { AdminPanel } from './panels/AdminPanel.tsx';
import { useEventId } from './useEventId.ts';

/**
 * The organizer console.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SHELL AND NOT A PAGE
 * ---------------------------------------------------------------------------
 * It was a single page with two tabs: judging coverage, and a four-button
 * compute/snapshot/publish/verify strip. Everything else the backend could
 * already do — accept registrations, manage the panel, declare and override
 * conflicts, preview and commit assignments, edit the rubric, read diagnostics,
 * compare normalization methods, issue certificates, read the audit ledger —
 * had no UI at all. The types for most of it were already written in api.ts,
 * transcribed from the server and then never used, which is the clearest sign
 * the surface was designed and never built.
 *
 * So this is a sectioned console, ordered by the order an organizer actually
 * works in:
 *
 *   Overview      what state is the event in, and what is outstanding
 *   Registrations the applicant queue
 *   Teams         who is in which team
 *   Panel         judges, workload, conflicts
 *   Assignments   the engine's plan, dry-run first, commit second
 *   Rubric        the questions, and the guarantee they cannot change mid-flight
 *   Results       compute, snapshot, publish, verify, and the method choice
 *   Diagnostics   panel health and review flags
 *   Community     voting activity and comment moderation
 *   Integrations  webhooks, certificates, import and export
 *   Audit         the append-only ledger
 *   Admin         platform operator view, ADMIN only
 *
 * The role gate is a courtesy, not a control. Every request on every panel is
 * refused by the server for anyone else, which is what
 * `adversarial.test.ts` and `insight-endpoints.test.ts` assert.
 */

type SectionId =
  | 'overview' | 'registrations' | 'teams' | 'panel' | 'assignments' | 'rubric'
  | 'results' | 'diagnostics' | 'community' | 'integrations' | 'audit' | 'admin';

type Section = { id: SectionId; label: string; adminOnly?: boolean };

const SECTIONS: readonly Section[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'registrations', label: 'Registrations' },
  { id: 'teams', label: 'Teams' },
  { id: 'panel', label: 'Panel' },
  { id: 'assignments', label: 'Assignments' },
  { id: 'rubric', label: 'Rubric' },
  { id: 'results', label: 'Results' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'community', label: 'Community' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'audit', label: 'Audit' },
  // ADMIN only: event creation and role grants have no other home.
  { id: 'admin', label: 'Platform', adminOnly: true },
];

export function OrganizerPage() {
  const session = useSession();
  const [section, setSection] = useState<SectionId>('overview');
  const { eventId, events, eventsLoading, eventRef, setEventRef } = useEventId();

  if (session.loading) return <Loading />;

  if (session.user === null) {
    return (
      <div className="page">
        <h1>Organizer console</h1>
        <Empty title="Sign in first">
          The organizer console is for event organizers. <Link to="/signin">Sign in</Link>.
        </Empty>
      </div>
    );
  }

  const isAdmin = session.isAdmin;
  const canOrganizeSomewhere = isAdmin || events.length > 0;

  if (!canOrganizeSomewhere) {
    return (
      <div className="page">
        <h1>Organizer console</h1>
        <Empty title="You do not organize any event">
          {isAdmin
            ? 'You are a platform administrator. Use the Platform section to create an event, then grant yourself or someone else an event-scoped organizer role.'
            : 'Event roles are granted by an administrator through the API. Creating an event requires the platform administrator role, so the first event on an instance is always created by an operator.'}
        </Empty>
        {isAdmin ? (
          <button
            type="button"
            className="button button--primary"
            style={{ marginTop: 16 }}
            onClick={() => setSection('admin')}
          >
            Open the platform section
          </button>
        ) : null}
      </div>
    );
  }

  // Every section but Platform needs an event-scoped organizer role; Platform is
  // for the global admin and is the only one an admin-only account can use.
  const visible = SECTIONS.filter((item) => (item.adminOnly === true ? isAdmin : true));
  const active = visible.some((s) => s.id === section) ? section : 'overview';
  const canUseEvent = eventId !== undefined;

  return (
    <div className="page page--wide">
      <div className="row row--between row--wrap console__head">
        <div>
          <h1>Organizer console</h1>
          <p className="muted small" style={{ marginTop: 4 }}>
            Everything below is a real operation against this event. Nothing is a preview.
          </p>
        </div>
        {events.length > 0 ? (
          <div className="field" style={{ minWidth: 240 }}>
            <label className="label" htmlFor="console-event">
              Event
            </label>
            <select
              id="console-event"
              className="select"
              value={eventRef}
              onChange={(changeEvent) => setEventRef(changeEvent.target.value)}
            >
              {events.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <nav className="console__nav" aria-label="Console sections">
        {visible.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`console__tab ${active === item.id ? 'console__tab--active' : ''}`}
            aria-current={active === item.id ? 'page' : undefined}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {eventsLoading ? <Loading label="Loading your events" /> : null}

      {!eventsLoading && !canUseEvent && active !== 'admin' ? (
        <Empty title="No event selected">
          Create an event from the Platform section, or ask an administrator for an event-scoped organizer role.
        </Empty>
      ) : null}

      {canUseEvent || active === 'admin' ? (
        <div className="stack">
          {/*
            Every panel is wrapped individually. A render error in one section
            used to unmount the whole application — React has no implicit
            boundary — so a single mistyped response shape made the entire
            console unreachable, including the sections that were fine. With a
            boundary per panel the blast radius is one section, and the operator
            can still navigate away and keep working.
          */}
          {active === 'overview' && eventId !== undefined ? <Bounded label="Overview" key="overview"><OverviewPanel eventId={eventId} /></Bounded> : null}
          {active === 'registrations' && eventId !== undefined ? <Bounded label="Registrations" key="registrations"><RegistrationsPanel eventId={eventId} /></Bounded> : null}
          {active === 'teams' && eventId !== undefined ? <Bounded label="Teams" key="teams"><TeamsPanel eventId={eventId} /></Bounded> : null}
          {active === 'panel' && eventId !== undefined ? <Bounded label="Panel" key="panel"><PanelPanel eventId={eventId} /></Bounded> : null}
          {active === 'assignments' && eventId !== undefined ? <Bounded label="Assignments" key="assignments"><AssignmentsPanel eventId={eventId} /></Bounded> : null}
          {active === 'rubric' && eventId !== undefined ? <Bounded label="Rubric" key="rubric"><RubricPanel eventId={eventId} /></Bounded> : null}
          {active === 'results' && eventId !== undefined ? <Bounded label="Results" key="results"><ResultsPanel eventId={eventId} /></Bounded> : null}
          {active === 'diagnostics' && eventId !== undefined ? <Bounded label="Diagnostics" key="diagnostics"><DiagnosticsPanel eventId={eventId} /></Bounded> : null}
          {active === 'community' && eventId !== undefined ? <Bounded label="Community" key="community"><CommunityPanel eventId={eventId} /></Bounded> : null}
          {active === 'integrations' && eventId !== undefined ? <Bounded label="Integrations" key="integrations"><IntegrationsPanel eventId={eventId} /></Bounded> : null}
          {active === 'audit' && eventId !== undefined ? <Bounded label="Audit" key="audit"><AuditPanel eventId={eventId} /></Bounded> : null}
          {active === 'admin' ? <Bounded label="Platform" key="admin"><AdminPanel /></Bounded> : null}
        </div>
      ) : null}
    </div>
  );
}

/** One boundary per panel, so a failure is contained to a section. */
function Bounded({ label, children }: { label: string; children: ReactNode }) {
  return <PanelBoundary label={label}>{children}</PanelBoundary>;
}

/** Shared shell so every panel reports errors the same way. */export function Panel({
  title,
  description,
  actions,
  children,
  error,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  error?: unknown;
}) {
  return (
    <section className="card card--pad">
      <div className="row row--between row--wrap" style={{ marginBottom: description === undefined ? 16 : 8 }}>
        <h2 style={{ fontSize: '1.15rem' }}>{title}</h2>
        {actions !== undefined ? <div className="row row--wrap" style={{ gap: 8 }}>{actions}</div> : null}
      </div>
      {description !== undefined ? <div className="small muted" style={{ marginBottom: 16 }}>{description}</div> : null}
      <ErrorNotice error={error} />
      {children}
    </section>
  );
}

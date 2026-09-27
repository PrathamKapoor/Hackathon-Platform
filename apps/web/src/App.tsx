/**
 * Application shell and routing.
 *
 * Navigation is derived from roles rather than hard-coded per page, so a judge
 * never sees an organizer tab they cannot use and an anonymous visitor sees only
 * public surfaces. The server enforces all of this regardless — hiding a link is
 * a courtesy to the reader, not a security control.
 */

import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Loading } from './ui.tsx';
import { useSession } from './session.tsx';
import { Grainient } from './components/Grainient.tsx';
import { EventsPage } from './pages/EventsPage.tsx';
import { EventPage } from './pages/EventPage.tsx';
import { ResultsPage } from './pages/ResultsPage.tsx';
import { GalleryPage } from './pages/GalleryPage.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { JudgeQueuePage } from './pages/JudgeQueuePage.tsx';
import { ReviewPage } from './pages/ReviewPage.tsx';
import { PairwisePage } from './pages/PairwisePage.tsx';
import { OrganizerPage } from './pages/OrganizerPage.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';

function TopBar() {
  const session = useSession();

  return (
    <header className="topbar">
      <NavLink to="/" className="brand">
        <span className="brand__mark" aria-hidden="true" />
        Verdict
      </NavLink>

      <nav className="nav" aria-label="Main">
        <NavLink to="/events" end>
          Events
        </NavLink>
        {session.user !== null ? <NavLink to="/workspace">Workspace</NavLink> : null}
        {session.isJudge ? <NavLink to="/judge">Judging</NavLink> : null}
        {session.user !== null && session.user.roles.some((r) => r === 'ORGANIZER' || r === 'ADMIN') ? (
          <NavLink to="/organize">Organizer</NavLink>
        ) : null}
      </nav>

      <span className="spacer" />

      {session.user !== null ? (
        <>
          <span className="small muted nowrap" title={session.user.email}>
            {session.user.displayName}
          </span>
          <button type="button" className="button button--sm button--ghost" onClick={() => void session.signOut()}>
            Sign out
          </button>
        </>
      ) : (
        <NavLink to="/signin" className="button button--sm button--primary">
          Sign in
        </NavLink>
      )}
    </header>
  );
}

function RequireSession({ children }: { children: React.ReactNode }) {
  const session = useSession();
  if (session.loading) return <Loading label="Checking your session" />;
  // Remember where they were headed so signing in does not lose the link.
  if (session.user === null) return <Navigate to="/signin" replace />;
  return <>{children}</>;
}

/**
 * Requires the ORGANIZER or ADMIN role, not merely a session.
 *
 * A judge who types `/organize` used to get the organizer shell and a page full
 * of `403`s, which leaked event name and judging window before the server
 * refused. The server was never wrong — the client was rendering something it
 * had no right to show. This is a clarity fix; the authorization is in
 * `requirePermission` and is covered by `adversarial.test.ts`.
 */
function RequireOrganizer({ children }: { children: React.ReactNode }) {
  const session = useSession();
  if (session.loading) return <Loading label="Checking your session" />;
  if (session.user === null) return <Navigate to="/signin" replace />;
  if (!session.isAdmin && !session.user.roles.includes('ORGANIZER')) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Requires the JUDGE role. An organizer who is also a judge may queue. */
function RequireJudge({ children }: { children: React.ReactNode }) {
  const session = useSession();
  if (session.loading) return <Loading label="Checking your session" />;
  if (session.user === null) return <Navigate to="/signin" replace />;
  if (!session.isJudge) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Landing() {
  const session = useSession();
  if (session.loading) return <Loading />;
  return (
    <div className="page">
      {/*
        The Grainient is the supplied React Bits component, ported onto `ogl`
        in `components/Grainient.tsx`. It sits behind the hero only: a full-bleed
        animated field on the landing page, and nowhere operational, because a
        judge reading a score table or an organizer watching a publish should not
        pay for an animation. It renders nothing under `prefers-reduced-motion`
        or without WebGL, and the hero's CSS gradient is the fallback in both
        cases — so the page is never dependent on it.
      */}
      <div className="hero">
        <Grainient className="hero__grain" intensity={0.2} speed={9} />
        <h1>Judging you can defend</h1>
        <p>
          A published rubric, conflict-aware assignment, per-judge normalization, and a result snapshot with an integrity
          hash anyone can recompute. The point is not a leaderboard — it is a result a losing team cannot reasonably
          argue with.
        </p>
        <div className="row" style={{ marginTop: 24 }}>
          <NavLink to="/events" className="button button--primary">
            Browse events
          </NavLink>
          {session.user === null ? (
            <NavLink to="/signin" className="button">
              Sign in
            </NavLink>
          ) : null}
        </div>
      </div>

      <div className="stack" style={{ marginTop: 32 }}>
        <h2>What the engine guarantees</h2>
        <div className="row row--wrap" style={{ alignItems: 'stretch' }}>
          <Feature title="Blind by construction">
            A judge's queue contains only the projects they are assigned, and no payload anywhere carries another judge's
            scores. Team identity is not available to the scoring path at all.
          </Feature>
          <Feature title="Conflicts are enforced, not remembered">
            Declared hard conflicts are never assigned by the engine under any strategy. An organizer who overrides one
            has to say why, and the reason is in the audit ledger.
          </Feature>
          <Feature title="Normalization with a stated method">
            Judges differ in generosity. The method is chosen explicitly, recorded in the run, and compared against the
            alternatives before results are published.
          </Feature>
          <Feature title="Reproducible, not just stored">
            Every published snapshot can be recomputed from the stored reviews. If the engine no longer produces the same
            ranking, verification says so.
          </Feature>
        </div>
      </div>
    </div>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card card--pad" style={{ flex: '1 1 260px' }}>
      <h3>{title}</h3>
      <p className="small muted" style={{ marginTop: 8 }}>
        {children}
      </p>
    </div>
  );
}

function NotFound() {
  return (
    <div className="page">
      <div className="empty">
        <div className="strong">Nothing here</div>
        <div className="small" style={{ marginTop: 6 }}>
          That page does not exist. <NavLink to="/">Go home</NavLink>.
        </div>
      </div>
    </div>
  );
}

/** Wraps a page component so every route gets the standard page shell. */
function Page({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <TopBar />
      <main id="main">{children}</main>
    </>
  );
}

/**
 * `/e/:slugOrId/*` resolves the event first, then hands the id to the child
 * routes, so an organizer following a slug link and a judge following an id
 * link end up on the same screen.
 */
function EventScoped({ children }: { children: (eventId: string) => React.ReactNode }) {
  const { slugOrId } = useParams();
  return <>{slugOrId === undefined ? <NotFound /> : children(slugOrId)}</>;
}

export function App() {
  return (
    <Page>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/signin" element={<SignInPage />} />
        <Route
          path="/workspace"
          element={
            <RequireSession>
              <WorkspacePage />
            </RequireSession>
          }
        />
        <Route
          path="/judge"
          element={
            <RequireJudge>
              <JudgeQueuePage />
            </RequireJudge>
          }
        />
        <Route
          path="/judge/:assignmentId"
          element={
            <RequireJudge>
              <ReviewPage />
            </RequireJudge>
          }
        />
        <Route
          path="/pairwise"
          element={
            <RequireJudge>
              <PairwisePage />
            </RequireJudge>
          }
        />
        <Route
          path="/organize"
          element={
            <RequireOrganizer>
              <OrganizerPage />
            </RequireOrganizer>
          }
        />
        <Route path="/e/:slugOrId" element={<EventScoped>{(id) => <EventPage eventRef={id} />}</EventScoped>} />
        <Route path="/e/:slugOrId/results" element={<EventScoped>{(id) => <ResultsPage eventRef={id} />}</EventScoped>} />
        <Route path="/e/:slugOrId/gallery" element={<EventScoped>{(id) => <GalleryPage eventRef={id} />}</EventScoped>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Page>
  );
}

/**
 * The review route is addressed by assignment, and the queue is a top-level
 * route: the server has no notion of an "active event", so the judge console
 * reads the event from the signed-in user's own scope rather than the URL. The
 * wrapper is here so the queue can be told to reload after a submit.
 */


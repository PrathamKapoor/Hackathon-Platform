import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api.ts';
import { Grainient } from '../components/Grainient.tsx';
import { useSession } from '../session.tsx';
import { ErrorNotice } from '../ui.tsx';

export function SignInPage() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Return the visitor to whatever they were trying to reach.
  const from = (location.state as { from?: string } | null)?.from ?? '/workspace';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await session.signIn(email, password);
      navigate(from, { replace: true });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 460 }}>
      {/*
        The same Grainient as the landing hero, quieter and lighter so the form
        stays the focus. Decoration only: it is `aria-hidden`, sits behind the
        content at `z-index: 0`, and disappears entirely under
        `prefers-reduced-motion` or without WebGL.
      */}
      <div className="signin__grain" aria-hidden="true">
        <Grainient className="hero__grain" intensity={0.14} speed={14} grain="fixed" light />
      </div>
      <h1>Sign in</h1>
      <p className="muted small" style={{ marginTop: 6, marginBottom: 20 }}>
        Sessions are cookie-based and expire. Eight wrong passwords lock an account for fifteen minutes.
      </p>

      <form className="card card--pad stack" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <ErrorNotice error={error} />

        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {error instanceof ApiError && error.isAuthFailure ? (
          <p className="tiny dim center">
            A wrong address and a wrong password give the same answer on purpose, so this cannot be used to find out who
            has an account.
          </p>
        ) : null}
      </form>

      <div className="notice" style={{ marginTop: 20 }}>
        <div className="strong small">Local demo</div>
        <p className="tiny muted" style={{ marginTop: 4 }}>
          On a freshly seeded instance every account shares the password <span className="mono">verdict-demo-2026</span>.
          Try <span className="mono">organizer@dogfood.dev</span> for the organizer console,{' '}
          <span className="mono">amara@dogfood.dev</span> for the judging queue, or{' '}
          <span className="mono">iris@dogfood.dev</span> for the participant view.
        </p>
      </div>
    </div>
  );
}

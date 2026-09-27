/**
 * Small shared UI pieces.
 *
 * Nothing here fetches. Keeping the presentational half separate from the
 * data half is what stops a component from growing an accidental second source
 * of truth about the session.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api.ts';

/** Human phrasing for an API error code, with the request id for support. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const message = error instanceof Error ? error.message : String(error);
  const requestId = error instanceof ApiError ? error.requestId : '';
  return (
    <div className="notice notice--error" role="alert">
      <div className="strong">{message}</div>
      {error instanceof ApiError && error.details.length > 0 ? (
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {error.details.map((detail) => (
            <li key={`${detail.field}:${detail.issue}`}>
              <span className="mono">{detail.field}</span> — {detail.issue}
            </li>
          ))}
        </ul>
      ) : null}
      {requestId !== '' ? <div className="tiny dim" style={{ marginTop: 6 }}>reference {requestId}</div> : null}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="row" style={{ padding: '32px 0', justifyContent: 'center' }} role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted small">{label}…</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="strong">{title}</div>
      {children !== undefined ? <div className="small" style={{ marginTop: 6 }}>{children}</div> : null}
    </div>
  );
}

/**
 * Fetch on mount, with cancellation.
 *
 * The AbortController matters here: navigating away from a judging queue while
 * a request is in flight should not leave a late response to set state on an
 * unmounted component, and `node:test` and the React dev overlay both complain
 * loudly when it does.
 */
export function useApi<T>(path: string | null): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<T>(path, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [path, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

/** Formats an instant for display, in the viewer's locale. */
export function formatInstant(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** Turns an engine state name into something readable in a badge. */
export function stateLabel(state: string): string {
  return state
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function validationBadge(validation: string): { tone: string; label: string } {
  switch (validation) {
    case 'OK':
      return { tone: 'badge--ok', label: 'Fully judged' };
    case 'LOW_COVERAGE':
      return { tone: 'badge--warn', label: 'Low coverage' };
    case 'NO_SCORES':
      return { tone: 'badge--bad', label: 'No scores' };
    case 'SINGLE_REVIEW':
      return { tone: 'badge--warn', label: 'Single review' };
    default:
      return { tone: '', label: stateLabel(validation) };
  }
}

/** A short, readable form of a SHA-256 for display next to a longer form. */
export function shortHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

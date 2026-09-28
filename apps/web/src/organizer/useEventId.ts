import { useMemo, useState } from 'react';
import { type EventSummary } from '../api.ts';
import { useApi } from '../ui.tsx';
import { useSession } from '../session.tsx';

/**
 * Which event the console is operating on.
 *
 * An organizer can hold several event-scoped roles, and the API deliberately
 * has no notion of "the active event" — the server must never have to guess
 * which one a request meant. The choice therefore has to live in the client,
 * and it has to be visible: the header shows which event every action below
 * applies to, because "I clicked publish" is much less alarming when you can
 * see it was not on the live event.
 *
 * The selection is kept in the URL hash so a reload does not silently move an
 * organizer back to the first of three events, and so a console link can be
 * shared.
 */
export function useEventId(): {
  eventId: string | undefined;
  eventRef: string;
  setEventRef: (value: string) => void;
  events: Pick<EventSummary, 'id' | 'name' | 'slug' | 'state'>[];
  eventsLoading: boolean;
} {
  const session = useSession();
  const [eventRef, setEventRefState] = useState(() => readHash(session.user?.eventIds[0] ?? ''));

  const { data, loading } = useApi<{ data: EventSummary[] }>('/api/events?perPage=200');

  const events = useMemo(() => {
    const all = data?.data ?? [];
    // Only events this account can actually organize. The server already hides
    // other people's events, but an admin sees all of them, and a console
    // section that 403s on every request is worse than not offering it.
    const manageable = all.filter(
      (row) => session.isAdmin || session.canOrganize(row.id),
    );
    return manageable.map((row) => ({ id: row.id, name: row.name, slug: row.slug, state: row.state }));
  }, [data, session]);

  const known = events.some((row) => row.id === eventRef);
  const effective = known || events.length === 0 ? eventRef : (events[0]?.id ?? '');

  const setEventRef = (value: string): void => {
    setEventRefState(value);
    try {
      window.location.hash = `event=${encodeURIComponent(value)}`;
    } catch {
      // A hash write is a convenience. If it fails, the in-memory selection
      // still holds, which is all correctness depends on.
    }
  };

  return {
    eventId: effective === '' ? undefined : effective,
    eventRef: effective,
    setEventRef,
    events,
    eventsLoading: loading,
  };
}

function readHash(fallback: string): string {
  try {
    const match = /event=([^&]+)/.exec(window.location.hash);
    return match?.[1] === undefined ? fallback : decodeURIComponent(match[1]);
  } catch {
    return fallback;
  }
}

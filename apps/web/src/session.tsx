/**
 * Session state.
 *
 * One call to /api/auth/session on mount decides what the whole application
 * renders. It answers 200 with `authenticated: false` rather than 401 when
 * signed out, precisely so the client can branch without treating a normal
 * state as an error.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type PublicUser, type SessionInfo } from './api.ts';

export type Session = {
  user: PublicUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** True when the user organizes or administers the event. */
  canOrganize: (eventId: string) => boolean;
  isAdmin: boolean;
  isJudge: boolean;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const info = await api.get<SessionInfo>('/api/auth/session');
      setUser(info.authenticated ? info.user : null);
    } catch {
      // A failed probe means we cannot claim to be signed in. Treating it as
      // signed-out is the safe direction: it shows the sign-in screen rather
      // than a shell full of failed requests.
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await api.postAnonymous('/api/auth/login', { email, password });
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  }, []);

  const value = useMemo<Session>(
    () => ({
      user,
      loading,
      refresh,
      signIn,
      signOut,
      canOrganize: (eventId: string) =>
        user !== null && (user.roles.includes('ADMIN') || (user.roles.includes('ORGANIZER') && user.eventIds.includes(eventId))),
      isAdmin: user?.roles.includes('ADMIN') ?? false,
      isJudge: user?.roles.includes('JUDGE') ?? false,
    }),
    [user, loading, refresh, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession must be used inside a SessionProvider');
  return session;
}

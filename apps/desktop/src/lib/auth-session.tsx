import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api-client';
import {
  clearStoredSession,
  loginWithAtrisAccount,
  logoutAtrisAccount,
  readStoredSession,
  refreshSession,
  signedOutSession,
  type SessionSnapshot,
} from '@/lib/auth-client';
import { hasPremiumAccess } from '@/lib/auth-policy';
import { registerUnauthorizedHandler } from '@/lib/token-provider';

export type AuthShellState = 'checking' | 'signed-out' | 'offline' | 'premium-required' | 'workspace';

interface AuthSessionContextValue {
  session: SessionSnapshot;
  shellState: AuthShellState;
  isCheckingSession: boolean;
  isLoggingIn: boolean;
  isLoggingOut: boolean;
  error: string | null;
  login: (email: string, password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => Promise<void>;
  clearError: () => void;
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 503) return 'AtrisAgent service is unavailable. Check the local gateway and try again.';
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionSnapshot>(signedOutSession);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkSession = useCallback(async (showOfflineState = true) => {
    setIsCheckingSession(true);
    setError(null);
    try {
      const stored = await readStoredSession();
      if (!stored.token) {
        setSession(signedOutSession());
        return;
      }
      try {
        const refreshed = await refreshSession(stored.token, stored.remembered);
        setSession(refreshed);
      } catch (refreshError) {
        if (refreshError instanceof ApiError && refreshError.status === 401) {
          setSession(signedOutSession());
          setError('Your AtrisHub session expired. Sign in again to continue.');
        } else if (showOfflineState) {
          setSession({ ...stored, status: 'offline' });
          setError(errorMessage(refreshError, 'The local gateway is offline.'));
        } else {
          throw refreshError;
        }
      }
    } catch (checkError) {
      setSession(signedOutSession());
      setError(errorMessage(checkError, 'Unable to restore your AtrisAgent session.'));
    } finally {
      setIsCheckingSession(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const unregister = registerUnauthorizedHandler(() => {
      if (!active) return;
      void clearStoredSession()
        .then(() => {
          if (!active) return;
          setSession(signedOutSession());
          setError('Your AtrisHub session expired. Sign in again to continue.');
        })
        .catch(() => {
          if (active) setError('Your session expired, but its local token could not be cleared. Retry logout before signing in again.');
        });
    });
    void checkSession();
    return () => {
      active = false;
      unregister();
    };
  }, [checkSession]);

  const login = useCallback(async (email: string, password: string, remember: boolean) => {
    setIsLoggingIn(true);
    setError(null);
    try {
      const next = await loginWithAtrisAccount(email, password, remember);
      setSession(next);
    } catch (loginError) {
      setSession(signedOutSession());
      setError(errorMessage(loginError, 'Login failed. Check your credentials and try again.'));
      throw loginError;
    } finally {
      setIsLoggingIn(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setIsLoggingOut(true);
    setError(null);
    try {
      const remoteError = await logoutAtrisAccount();
      setSession(signedOutSession());
      if (remoteError) setError('Signed out on this device. The local gateway could not be reached.');
    } catch (logoutError) {
      setError(errorMessage(logoutError, 'The remembered session token could not be cleared. You are still signed in; retry logout.'));
      return;
    } finally {
      setIsLoggingOut(false);
    }
  }, []);

  const shellState = useMemo<AuthShellState>(() => {
    if (isCheckingSession) return 'checking';
    if (session.status === 'offline') return 'offline';
    if (session.status !== 'authenticated' || !session.user) return 'signed-out';
    return hasPremiumAccess(session) ? 'workspace' : 'premium-required';
  }, [isCheckingSession, session]);

  const value = useMemo<AuthSessionContextValue>(() => ({
    session,
    shellState,
    isCheckingSession,
    isLoggingIn,
    isLoggingOut,
    error,
    login,
    logout,
    retry: () => checkSession(),
    clearError: () => setError(null),
  }), [checkSession, error, isCheckingSession, isLoggingIn, isLoggingOut, login, logout, session, shellState]);

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): AuthSessionContextValue {
  const context = useContext(AuthSessionContext);
  if (!context) throw new Error('useAuthSession must be used inside AuthSessionProvider.');
  return context;
}

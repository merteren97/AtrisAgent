import { apiRequest, ApiError } from '@/lib/api-client';
import { clearSecureToken, isTauriRuntime, readSecureToken, storeSecureToken } from '@/lib/secure-storage';
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/token-provider';

export const AUTH_TOKEN_KEY = 'session:atris-token';
const USER_KEY = 'atris_agent_user';
const MEMBERSHIP_KEY = 'atris_membership';
const ENTITLEMENT_KEY = 'atris_agent_entitlement';
const EPHEMERAL_TOKEN_KEY = 'atris-agent-ephemeral-token';

export interface SessionUser {
  id: string;
  email: string;
  username?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface AtrisMembership {
  status: string;
  plan: string;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface ProductEntitlement {
  product: string;
  status: string;
  plan?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface SessionSnapshot {
  status: 'authenticated' | 'signed-out' | 'offline';
  token: string | null;
  user: SessionUser | null;
  membership: AtrisMembership;
  entitlement: ProductEntitlement;
  remembered: boolean;
}

interface AuthResponse {
  token: string;
  user: SessionUser;
  membership?: AtrisMembership;
  entitlement?: ProductEntitlement;
}

interface MeResponse {
  user: SessionUser;
  membership?: AtrisMembership;
  entitlement?: ProductEntitlement;
}

export const signedOutSession = (): SessionSnapshot => ({
  status: 'signed-out',
  token: null,
  user: null,
  membership: { status: 'unknown', plan: 'Free' },
  entitlement: { product: 'AtrisAgent', status: 'unknown' },
  remembered: false,
});

function safeParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function membershipFromEntitlement(entitlement?: ProductEntitlement): AtrisMembership {
  return entitlement
    ? { status: entitlement.status, plan: entitlement.plan || 'Free', startsAt: entitlement.startsAt, endsAt: entitlement.endsAt }
    : { status: 'unknown', plan: 'Free' };
}

function createSession(response: AuthResponse | MeResponse, token: string, remembered: boolean): SessionSnapshot {
  const entitlement = response.entitlement || { product: 'AtrisAgent', status: 'unknown', plan: 'Free' };
  return {
    status: 'authenticated',
    token,
    user: response.user,
    membership: response.membership || membershipFromEntitlement(response.entitlement),
    entitlement,
    remembered,
  };
}

function removeMetadata(storage: Storage): void {
  storage.removeItem(USER_KEY);
  storage.removeItem(MEMBERSHIP_KEY);
  storage.removeItem(ENTITLEMENT_KEY);
}

export async function readStoredSession(): Promise<SessionSnapshot> {
  if (typeof window === 'undefined') return signedOutSession();
  const secureToken = await readSecureToken().catch(() => null);
  const ephemeralToken = window.sessionStorage.getItem(EPHEMERAL_TOKEN_KEY);
  const token = secureToken || ephemeralToken;
  // In browser preview the DPAPI fallback is sessionStorage, so metadata
  // placement distinguishes the remember checkbox. Native DPAPI storage is
  // durable and therefore always represents a remembered session.
  const remembered = Boolean(secureToken) && (isTauriRuntime() || Boolean(window.localStorage.getItem(USER_KEY)));
  const user = safeParse<SessionUser>(
    (remembered ? window.localStorage.getItem(USER_KEY) : null) || window.sessionStorage.getItem(USER_KEY),
  );
  const entitlement = safeParse<ProductEntitlement>(
    (remembered ? window.localStorage.getItem(ENTITLEMENT_KEY) : null) || window.sessionStorage.getItem(ENTITLEMENT_KEY),
  ) || { product: 'AtrisAgent', status: 'unknown' };
  const membership = safeParse<AtrisMembership>(
    (remembered ? window.localStorage.getItem(MEMBERSHIP_KEY) : null) || window.sessionStorage.getItem(MEMBERSHIP_KEY),
  ) || membershipFromEntitlement(entitlement);
  if (!token) return signedOutSession();
  setAuthToken(token);
  return { status: 'authenticated', token, user, membership, entitlement, remembered };
}

export async function persistSession(session: SessionSnapshot, remember: boolean): Promise<void> {
  if (typeof window === 'undefined') return;
  // Never leave a stale bearer usable while secure persistence is in flight.
  clearAuthToken();
  const primary = remember ? window.localStorage : window.sessionStorage;
  const secondary = remember ? window.sessionStorage : window.localStorage;
  removeMetadata(secondary);
  if (!session.token || !session.user) {
    await clearSecureToken();
    window.sessionStorage.removeItem(EPHEMERAL_TOKEN_KEY);
    clearAuthToken();
    removeMetadata(primary);
    return;
  }
  if (remember) {
    await storeSecureToken(session.token);
    if (isTauriRuntime()) window.sessionStorage.removeItem(EPHEMERAL_TOKEN_KEY);
  } else {
    await clearSecureToken();
    window.sessionStorage.setItem(EPHEMERAL_TOKEN_KEY, session.token);
  }
  primary.setItem(USER_KEY, JSON.stringify(session.user));
  primary.setItem(MEMBERSHIP_KEY, JSON.stringify(session.membership));
  primary.setItem(ENTITLEMENT_KEY, JSON.stringify(session.entitlement));
  setAuthToken(session.token);
}

export async function clearStoredSession(): Promise<void> {
  if (typeof window !== 'undefined') {
    removeMetadata(window.localStorage);
    removeMetadata(window.sessionStorage);
    window.sessionStorage.removeItem(EPHEMERAL_TOKEN_KEY);
  }
  await clearSecureToken();
  clearAuthToken();
}

export async function loginWithAtrisAccount(email: string, password: string, remember: boolean): Promise<SessionSnapshot> {
  const response = await apiRequest<AuthResponse>('/auth/login', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify({ email, password, remember }),
  });
  if (!response?.token || !response.user) throw new Error('Login response did not include a valid account session.');
  const session = createSession(response, response.token, remember);
  await persistSession(session, remember);
  return session;
}

export async function refreshSession(token: string, remembered: boolean): Promise<SessionSnapshot> {
  setAuthToken(token);
  try {
    const response = await apiRequest<MeResponse>('/auth/me', { method: 'GET', suppressUnauthorized: true });
    const session = createSession(response, token, remembered);
    await persistSession(session, remembered);
    return session;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) await clearStoredSession();
    throw error;
  }
}

export async function logoutAtrisAccount(): Promise<unknown | null> {
  let remoteError: unknown | null = null;
  try {
    if (getAuthToken() && typeof window !== 'undefined') {
      await apiRequest('/auth/logout', { method: 'POST', suppressUnauthorized: true });
    }
  } catch (error) {
    remoteError = error;
  }
  await clearStoredSession();
  return remoteError;
}

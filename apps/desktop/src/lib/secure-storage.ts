import { invoke } from '@tauri-apps/api/core';

const SESSION_TOKEN_FALLBACK_KEY = 'atris-agent-ephemeral-token';

function isBrowserStorageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

/**
 * The native command stores the token in `%LOCALAPPDATA%/AtrisAgent/auth`
 * using Windows DPAPI.  The browser fallback is deliberately session-only so
 * a Vite preview can be used without ever putting a bearer token in
 * localStorage.
 */
export async function storeSecureToken(token: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke('store_local_secret', { secretRef: 'session:atris-token', value: token });
    return;
  }
  if (isBrowserStorageAvailable()) window.sessionStorage.setItem(SESSION_TOKEN_FALLBACK_KEY, token);
}

export async function readSecureToken(): Promise<string | null> {
  if (isTauriRuntime()) {
    const token = await invoke<string | null>('read_local_secret', { secretRef: 'session:atris-token' });
    return token || null;
  }
  return isBrowserStorageAvailable() ? window.sessionStorage.getItem(SESSION_TOKEN_FALLBACK_KEY) : null;
}

export async function clearSecureToken(): Promise<void> {
  if (isTauriRuntime()) {
    await invoke('delete_local_secret', { secretRef: 'session:atris-token' });
  }
  if (isBrowserStorageAvailable()) window.sessionStorage.removeItem(SESSION_TOKEN_FALLBACK_KEY);
}

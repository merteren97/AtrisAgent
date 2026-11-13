import { invoke } from '@tauri-apps/api/core';
export interface HubAccount { username: string; name?: string | null; persistent?: boolean }

// Native sessions use Keychain/Keystore. Browser previews remain memory-only.
let accessToken: string | undefined;
export function hubToken(): string | undefined { return accessToken; }
const native = () => '__TAURI_INTERNALS__' in window;

function accountFrom(data: unknown): HubAccount {
  if (!data || typeof data !== 'object' || !('user' in data) || !data.user || typeof data.user !== 'object' || !('username' in data.user) || typeof data.user.username !== 'string') throw new Error('AtrisHub returned an invalid response.');
  return { username: data.user.username, name: 'name' in data.user && typeof data.user.name === 'string' ? data.user.name : undefined };
}
export async function restoreHubSession(): Promise<HubAccount | null> {
  if (!native()) return null;
  const token = await invoke<string | null>('load_mobile_token');
  if (!token) return null;
  const response = await fetch('https://atrishub.com/api/auth/me', { credentials: 'omit', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) { if ([401, 403].includes(response.status)) await invoke('delete_mobile_token'); return null; }
  const account = accountFrom(await response.json());
  accessToken = token;
  return { ...account, persistent: true };
}

export async function loginHub(email: string, password: string): Promise<HubAccount> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch('https://atrishub.com/api/auth/login', {
      method: 'POST', credentials: 'omit', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });
  } catch {
    throw new Error('Could not reach AtrisHub. Check your internet connection.');
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    if (response.status === 401) throw new Error('Email or password is incorrect.');
    if (response.status === 403) throw new Error('Verify your email before signing in.');
    throw new Error('Could not sign in. Please try again.');
  }
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('token' in data) || typeof data.token !== 'string' || !data.token) throw new Error('AtrisHub returned an invalid response.');
  const account = accountFrom(data);
  accessToken = data.token;
  let persistent = false;
  if (native()) { try { await invoke('save_mobile_token', { token: accessToken }); persistent = true; } catch { /* Session remains usable in memory; show this in account settings. */ } }
  return { ...account, persistent };
}

export async function clearHubSession(): Promise<void> { if (native()) await invoke('delete_mobile_token'); accessToken = undefined; }

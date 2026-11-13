export interface HubAccount { username: string; name?: string | null }

// Keep the access token in memory until native secure session storage is added.
// Do not persist credentials or put tokens into a URL.
let accessToken: string | undefined;

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
  if (!data || typeof data !== 'object' || !('token' in data) || typeof data.token !== 'string' || !data.token || !('user' in data) || !data.user || typeof data.user !== 'object' || !('username' in data.user) || typeof data.user.username !== 'string') throw new Error('AtrisHub returned an invalid response.');
  accessToken = data.token;
  return { username: data.user.username, name: 'name' in data.user && typeof data.user.name === 'string' ? data.user.name : undefined };
}

export function clearHubSession(): void { accessToken = undefined; }

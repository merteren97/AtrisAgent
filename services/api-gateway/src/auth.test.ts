import assert from 'node:assert/strict';
import express from 'express';
import { AtrisAuthService, hasPremiumEntitlement, installAuthRoutes } from './auth';

type Session = {
  user: { id: string; email: string };
  membership: { status: string; plan: string };
  entitlement: { product: string; status: string; plan: string };
};

const premiumToken = 'premium-token-for-tests';
const freeToken = 'free-token-for-tests';
const invalidToken = 'invalid-token-for-tests';

const premiumSession: Session = {
  user: { id: 'premium-user', email: 'premium@example.test' },
  membership: { status: 'active', plan: 'Premium' },
  entitlement: { product: 'AtrisAgent', status: 'active', plan: 'Premium' },
};
const freeSession: Session = {
  user: { id: 'free-user', email: 'free@example.test' },
  membership: { status: 'active', plan: 'Free' },
  entitlement: { product: 'AtrisAgent', status: 'inactive', plan: 'Free' },
};

interface HubState {
  outage: boolean;
  meFailure: 'none' | 'not-found' | 'server-error' | 'malformed';
  loginStatus: number;
  loginBody: unknown;
  calls: Array<{ path: string; method: string; authorization: string | null }>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createHubFetch(state: HubState) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers || {});
    const authorization = headers.get('authorization');
    state.calls.push({ path: url.pathname, method: init?.method || 'GET', authorization });
    if (state.outage) throw new Error('simulated Hub outage');

    if (url.pathname === '/api/auth/login') return jsonResponse(state.loginBody, state.loginStatus);
    if (url.pathname === '/api/auth/logout') return jsonResponse({ message: 'Hub logout complete' });
    if (url.pathname === '/api/auth/me') {
      if (state.meFailure === 'not-found') return jsonResponse({ error: 'User not found' }, 404);
      if (state.meFailure === 'server-error') return jsonResponse({ error: 'Hub failure' }, 500);
      if (state.meFailure === 'malformed') return jsonResponse({ ok: true }, 200);
      const token = authorization?.replace(/^Bearer\s+/i, '');
      const session = token === premiumToken || token === 'premium-token-isolated'
        ? premiumSession
        : token === freeToken || token === 'free-token-isolated'
          ? freeSession
          : undefined;
      if (!session) return jsonResponse({ error: 'Invalid or expired token' }, 401);
      // The Hub must not make a token part of the /me response. This field
      // verifies that the gateway strips an accidental secret from upstream.
      return jsonResponse({ ...session, token: 'should-never-leak-from-me' });
    }
    return jsonResponse({ error: 'Not found' }, 404);
  };
}

async function runTests() {
  const state: HubState = {
    outage: false,
    meFailure: 'none',
    loginStatus: 200,
    loginBody: { ...premiumSession, token: premiumToken },
    calls: [],
  };
  let now = 0;
  const service = new AtrisAuthService({
    baseUrl: 'https://hub.example.test',
    fetchImpl: createHubFetch(state),
    cacheTtlMs: 50,
    staleCacheTtlMs: 60,
    now: () => now,
  });

  const api = express();
  api.use(express.json());
  installAuthRoutes(api, service);
  api.get('/api/protected', (_req, res) => res.json({ ok: true }));
  api.post('/api/mutation', (_req, res) => res.json({ ok: true }));
  api.get('/api/events/stream', (_req, res) => res.status(200).json({ stream: true }));

  const server = await new Promise<ReturnType<typeof api.listen>>((resolve) => {
    const instance = api.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = (pathname: string, init: RequestInit = {}) => fetch(`${baseUrl}${pathname}`, init);
  const withBearer = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });
  const readJson = async (response: Response): Promise<Record<string, any>> => response.json() as Promise<Record<string, any>>;
  const logs: string[] = [];
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));

  try {
    assert.equal(hasPremiumEntitlement({
      user: { id: 'whitespace-premium-user' },
      membership: { status: ' ACTIVE ', plan: ' Premium ' },
    }), true, 'Premium entitlement comparison trims case and whitespace like the desktop policy');

    let response = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'premium@example.test', password: 'correct-password' }),
    });
    let body = await readJson(response);
    assert.equal(response.status, 200, 'login proxy forwards successful Hub status');
    assert.equal(body.token, premiumToken, 'login proxy returns the Hub token needed by the desktop session');

    state.loginStatus = 401;
    state.loginBody = { error: 'Invalid credentials', token: 'failed-login-token-must-not-leak' };
    response = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'premium@example.test', password: 'wrong-password' }),
    });
    body = await readJson(response);
    assert.equal(response.status, 401, 'login proxy forwards Hub authentication failures');
    assert.equal(body.token, undefined, 'failed login responses never expose an upstream token');

    response = await request('/api/auth/me?token=premium-token-for-tests');
    body = await readJson(response);
    assert.equal(response.status, 401, 'me ignores bearer tokens supplied in the query string');
    assert.equal(body.code, 'AUTH_TOKEN_MISSING', 'missing bearer token has the stable JSON error contract');

    response = await request('/api/auth/me', withBearer(invalidToken));
    body = await readJson(response);
    assert.equal(response.status, 401, 'invalid/expired bearer tokens return 401');
    assert.equal(body.code, 'AUTH_INVALID', 'invalid token has the stable JSON error contract');

    response = await request('/api/auth/me', withBearer(freeToken));
    body = await readJson(response);
    assert.equal(response.status, 200, 'me accepts a valid non-premium session without applying the business gate');
    assert.equal(body.user.id, freeSession.user.id, 'me returns the authoritative Hub identity');
    assert.equal(body.token, undefined, 'me never returns a token from an accidental upstream field');

    response = await request('/api/protected', withBearer(freeToken));
    body = await readJson(response);
    assert.equal(response.status, 403, 'verified non-premium users are denied business routes');
    assert.equal(body.code, 'PREMIUM_REQUIRED', 'non-premium denial has the stable JSON error contract');

    response = await request('/api/protected', withBearer(premiumToken));
    assert.equal(response.status, 200, 'verified Premium users can access business routes');

    response = await request('/api/events/stream');
    body = await readJson(response);
    assert.equal(response.status, 401, 'SSE/event HTTP routes reject missing bearer tokens');
    assert.equal(body.code, 'AUTH_TOKEN_MISSING', 'SSE/event auth failure uses the normal JSON contract');
    response = await request('/api/events/stream', withBearer(premiumToken));
    assert.equal(response.status, 200, 'SSE/event HTTP routes accept a verified Premium bearer token');

    const cacheSizeBeforeIsolation = service.cacheSize;
    response = await request('/api/protected', withBearer('premium-token-isolated'));
    assert.equal(response.status, 200, 'a second Premium token validates independently');
    response = await request('/api/protected', withBearer('free-token-isolated'));
    assert.equal(response.status, 403, 'a Free token cannot reuse a Premium token cache entry');
    assert.equal(service.cacheSize, cacheSizeBeforeIsolation + 2, 'session cache entries are isolated by token hash');

    state.outage = true;
    response = await request('/api/mutation', { method: 'POST', ...withBearer(premiumToken) });
    body = await readJson(response);
    assert.equal(response.status, 503, 'mutations fail closed when AtrisHub is unavailable');
    assert.equal(body.code, 'AUTH_UPSTREAM_UNAVAILABLE', 'mutation outage uses a stable upstream error contract');
    state.outage = false;

    now = 100;
    state.meFailure = 'not-found';
    response = await request('/api/auth/me', withBearer(premiumToken));
    body = await readJson(response);
    assert.equal(response.status, 401, 'a deleted Hub user is treated as an invalid local session');
    assert.equal(body.code, 'AUTH_INVALID', 'Hub user-not-found responses use the invalid-session contract');
    state.meFailure = 'none';

    now = 200;
    response = await request('/api/protected', withBearer(premiumToken));
    assert.equal(response.status, 200, 'a valid Hub response re-primes the Premium cache after rejection');

    now = 260;
    state.meFailure = 'server-error';
    response = await request('/api/protected', withBearer(premiumToken));
    body = await readJson(response);
    assert.equal(response.status, 503, 'GET does not use stale auth metadata for a Hub HTTP 5xx response');
    assert.equal(body.code, 'AUTH_UPSTREAM_UNAVAILABLE', 'Hub HTTP 5xx responses remain fail-closed');

    now = 261;
    state.meFailure = 'malformed';
    response = await request('/api/protected', withBearer(premiumToken));
    body = await readJson(response);
    assert.equal(response.status, 503, 'GET does not use stale auth metadata for malformed Hub responses');
    assert.equal(body.code, 'AUTH_UPSTREAM_UNAVAILABLE', 'malformed Hub responses use the upstream error contract');

    now = 300;
    state.meFailure = 'none';
    state.outage = true;
    response = await request('/api/protected', withBearer(premiumToken));
    body = await readJson(response);
    assert.equal(response.status, 503, 'Premium GET routes fail closed when only stale Hub metadata is available');
    assert.equal(body.code, 'AUTH_UPSTREAM_UNAVAILABLE', 'stale Premium authorization uses the upstream error contract');
    const staleWebSocketAuthorization = await service.authorizeWebSocket(premiumToken);
    assert.deepEqual(staleWebSocketAuthorization, { allowed: false, status: 503 }, 'WebSocket Premium authorization fails closed for stale Hub metadata');
    now = 311;
    response = await request('/api/protected', withBearer(premiumToken));
    body = await readJson(response);
    assert.equal(response.status, 503, 'GET stale fallback expires and then fails closed');
    assert.equal(body.code, 'AUTH_UPSTREAM_UNAVAILABLE', 'expired stale cache uses a stable upstream error contract');
    state.outage = false;

    response = await request('/api/auth/logout', { method: 'POST' });
    body = await readJson(response);
    assert.equal(response.status, 200, 'logout without a token remains locally successful');
    assert.equal(body.localOnly, true, 'logout without a token reports local-only best-effort semantics');

    response = await request('/api/auth/logout', { method: 'POST', ...withBearer(premiumToken) });
    body = await readJson(response);
    assert.equal(response.status, 200, 'logout forwards a bearer token to AtrisHub');
    assert.equal(body.forwarded, true, 'successful logout reports that Hub forwarding completed');

    state.outage = true;
    response = await request('/api/auth/logout', { method: 'POST', ...withBearer(premiumToken) });
    body = await readJson(response);
    assert.equal(response.status, 200, 'logout stays locally successful during a Hub outage');
    assert.equal(body.localOnly, true, 'logout outage response tells the desktop to clear its local token');
    assert.equal(JSON.stringify(body).includes(premiumToken), false, 'logout responses never expose bearer tokens');

    assert.equal(logs.some((entry) => entry.includes(premiumToken)), false, 'auth failures and proxy operations never log bearer tokens');
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  console.log('API Gateway auth tests passed.');
}

runTests().catch((error) => {
  console.error('API Gateway auth test execution error:', error);
  process.exit(1);
});

import assert from 'node:assert/strict';
import { apiRequest, checkApiHealth, configureApiRuntime, getApiOrigin } from './api-client';
import { apiBaseUrl, normalizeApiOrigin } from './api-base';
import { hasPremiumAccess } from './auth-policy';
import { clearAuthToken, getAuthToken, setAuthToken } from './token-provider';

const cases = [
  ['http://127.0.0.1:3001', 'http://127.0.0.1:3001'],
  ['http://127.0.0.1:3001/', 'http://127.0.0.1:3001'],
  ['http://127.0.0.1:3001/api', 'http://127.0.0.1:3001'],
  ['http://127.0.0.1:3001/api/', 'http://127.0.0.1:3001'],
  ['http://127.0.0.1:3001/api/api', 'http://127.0.0.1:3001'],
] as const;

for (const [configured, expectedOrigin] of cases) {
  assert.equal(normalizeApiOrigin(configured), expectedOrigin);
  assert.equal(apiBaseUrl(configured), `${expectedOrigin}/api`);
}

assert.equal(normalizeApiOrigin(undefined), 'http://127.0.0.1:3001');
assert.equal(apiBaseUrl(undefined), 'http://127.0.0.1:3001/api');
assert.equal(hasPremiumAccess({
  membership: { status: 'ACTIVE', plan: 'premium' },
}), true);
assert.equal(hasPremiumAccess({
  membership: { status: 'active', plan: 'Free' },
}), false);
setAuthToken('temporary-token');
assert.equal(getAuthToken(), 'temporary-token');
configureApiRuntime({ origin: 'http://127.0.0.1:43127', runtimeToken: 'runtime-secret' });
assert.equal(getApiOrigin(), 'http://127.0.0.1:43127');
const originalFetch = globalThis.fetch;
let healthRequestUrl: RequestInfo | URL | undefined;
let healthRequestInit: RequestInit | undefined;
let apiRequestInit: RequestInit | undefined;
globalThis.fetch = async (input, init) => {
  if (String(input).endsWith('/health')) {
    healthRequestUrl = input;
    healthRequestInit = init;
  } else {
    apiRequestInit = init;
  }
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
try {
  await apiRequest('/runtime-contract');
  const apiHeaders = new Headers(apiRequestInit?.headers);
  assert.equal(apiHeaders.get('Authorization'), 'Bearer temporary-token');
  assert.equal(apiHeaders.get('X-Atris-Runtime-Token'), 'runtime-secret');
  const health = await checkApiHealth();
  assert.equal(health.status, 'ok');
  assert.equal(healthRequestUrl, 'http://127.0.0.1:43127/health');
  const healthHeaders = new Headers(healthRequestInit?.headers);
  assert.equal(healthHeaders.get('Authorization'), null);
  assert.equal(healthHeaders.get('X-Atris-Runtime-Token'), 'runtime-secret');
} finally {
  globalThis.fetch = originalFetch;
  clearAuthToken();
  configureApiRuntime({ origin: 'http://127.0.0.1:3001', runtimeToken: null });
}
assert.equal(getAuthToken(), null);
console.log('desktop auth/API base contract passed');

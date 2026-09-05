import assert from 'node:assert/strict';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });

const { useAccountStore } = await import('./account-store');

const account = {
  id: 'profile-1',
  provider: 'google',
  runtimeType: 'antigravity',
  profileName: 'Antigravity',
  authStatus: 'connected',
  supportedModels: [],
} as any;
const liveModel = {
  catalogId: 'antigravity:profile-1:gemini-live',
  runtimeId: 'antigravity',
  accountProfileId: 'profile-1',
  providerId: 'google',
  runtimeModelId: 'gemini-live',
  displayName: 'Gemini Live',
  supportedRoles: ['orchestrator'],
  supportedReasoning: ['medium'],
  availability: 'available',
  source: 'discovered',
  inputModalities: ['text'],
} as any;

const originalFetch = globalThis.fetch;
let modelRequests: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/api/accounts')) return new Response(JSON.stringify([account]), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/api/runtimes')) return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/api/models')) {
    modelRequests.push(url);
    const live = url.includes('refresh=true');
    return new Response(JSON.stringify(live ? [liveModel] : []), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Unexpected request: ${url}`);
}) as typeof fetch;

try {
  useAccountStore.setState({
    accounts: [],
    runtimes: [],
    discoveredModels: [],
    loading: false,
    modelCatalogLoading: false,
    modelCatalogReady: false,
    modelCatalogError: null,
    serviceOnline: false,
    error: null,
  });

  await useAccountStore.getState().fetchAccounts({ refreshModels: true });
  assert.equal(modelRequests.some((url) => url.includes('/api/models?refresh=true')), true, 'startup hydration performs live model discovery');
  assert.deepEqual(useAccountStore.getState().discoveredModels.map((model) => model.runtimeModelId), ['gemini-live'], 'live models reach the desktop store');
  assert.equal(useAccountStore.getState().modelCatalogReady, true, 'startup hydration marks the catalog ready');

  await useAccountStore.getState().fetchAccounts();
  assert.deepEqual(useAccountStore.getState().discoveredModels.map((model) => model.runtimeModelId), ['gemini-live'], 'a later cache read cannot overwrite the live catalog');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('account model hydration tests passed');

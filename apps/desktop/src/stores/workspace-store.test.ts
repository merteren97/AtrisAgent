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

const { useWorkspaceStore } = await import('./workspace-store');

useWorkspaceStore.setState({ lastMissionByWorkspace: {} });
useWorkspaceStore.getState().rememberMission('workspace-1', 'mission-1');
useWorkspaceStore.getState().rememberMission('workspace-2', 'mission-2');
useWorkspaceStore.getState().forgetMission('workspace-1', 'mission-1');

assert.equal(useWorkspaceStore.getState().lastMissionByWorkspace['workspace-1'], undefined, 'deleted conversation is forgotten by workspace navigation');
assert.equal(useWorkspaceStore.getState().lastMissionByWorkspace['workspace-2'], 'mission-2', 'other workspace navigation state is preserved');

useWorkspaceStore.getState().forgetMission('workspace-2', 'different-mission');
assert.equal(useWorkspaceStore.getState().lastMissionByWorkspace['workspace-2'], 'mission-2', 'unrelated conversation deletion does not clear the remembered selection');

const originalFetch = globalThis.fetch;
useWorkspaceStore.setState({ workspaces: [{ id: 'workspace-2', name: 'Project', path: 'C:/Project' }], activeWorkspaceId: 'workspace-2', error: null });
let deletionBody = '';
globalThis.fetch = async (_input, init) => {
  deletionBody = String(init?.body || '');
  return new Response(JSON.stringify({ error: 'Active conversations remain.' }), { status: 409, headers: { 'content-type': 'application/json' } });
};
await assert.rejects(() => useWorkspaceStore.getState().removeWorkspace('workspace-2', true), /Active conversations remain/, 'workspace deletion failures are visible to the confirmation dialog');
assert.deepEqual(JSON.parse(deletionBody), { removeMemory: true }, 'workspace and memory deletion use one authoritative backend operation');
assert.equal(useWorkspaceStore.getState().workspaces.length, 1, 'failed workspace deletion preserves local navigation state');
globalThis.fetch = originalFetch;

console.log('workspace navigation cleanup tests passed');

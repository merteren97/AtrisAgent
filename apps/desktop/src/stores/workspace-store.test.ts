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

console.log('workspace navigation cleanup tests passed');

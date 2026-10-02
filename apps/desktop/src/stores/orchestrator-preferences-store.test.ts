import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrchestratorPreferences } from './orchestrator-preferences-store';

// Same in-memory localStorage pattern used by the existing desktop store tests.
// Install it before dynamic imports so Zustand exercises real persistence.
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

const legacyPreferences = {
  selectedModel: 'codex:legacy:gpt-model', reasoningLevel: 'high',
  teamTemplate: 'legacy-team', agentProfileIds: { builder: 'legacy-builder' },
  trustMode: 'Review Driven', automationSettings: { fileWrite: false, gitCommit: null, packageInstall: true },
};
storage.set('atris-settings-storage', JSON.stringify({ version: 14, state: legacyPreferences }));
const { useSettingsStore } = await import('./settings-store');
const { useMissionStore } = await import('./mission-store');
const { useWorkspaceStore } = await import('./workspace-store');
const { useOrchestratorPreferencesStore: store, useOrchestratorPreferences, normalizeOrchestratorPreferences } = await import('./orchestrator-preferences-store');
const initial = structuredClone(store.getState().defaults);
const legacyState = useSettingsStore.getState();
const storageKey = 'atris-orchestrator-preferences';

beforeEach(() => {
  store.setState({ defaults: structuredClone(initial), projects: {}, conversations: {}, drafts: {} });
  useWorkspaceStore.setState({ activeWorkspaceId: 'project-a' });
  useMissionStore.setState({ activeMissionId: null });
  useSettingsStore.setState(legacyState);
});

function preferences(patch: Partial<OrchestratorPreferences> = {}): OrchestratorPreferences {
  return { ...structuredClone(initial), ...patch };
}

function capturePreferences() {
  let captured: ReturnType<typeof useOrchestratorPreferences> | undefined;
  // SSR reads Zustand's creation-time snapshot. Temporarily seed that snapshot
  // with the test fixture; selectors, current state and hook actions stay real.
  const restores = [store, useWorkspaceStore, useMissionStore].map(target => {
    const snapshot = target.getInitialState();
    const original = { ...snapshot };
    Object.assign(snapshot, target.getState());
    return () => { Object.assign(snapshot, original); };
  });
  function Probe() { captured = useOrchestratorPreferences(); return null; }
  try { renderToStaticMarkup(createElement(Probe)); }
  finally { restores.forEach(restore => restore()); }
  assert.ok(captured, 'The actual preference hook rendered');
  return captured;
}

async function hydrate(state: unknown) {
  storage.set(storageKey, JSON.stringify({ version: 1, state }));
  let hydrationError: unknown;
  const previous = store.persist.getOptions().onRehydrateStorage;
  store.persist.setOptions({ onRehydrateStorage: () => (_state, error) => { hydrationError = error; } });
  try { await store.persist.rehydrate(); }
  finally { store.persist.setOptions({ onRehydrateStorage: previous }); }
  assert.equal(hydrationError, undefined, 'Invalid persisted preferences must normalize without aborting hydration');
}

test('first-run defaults inherit existing legacy settings without changing them', () => {
  assert.deepEqual(initial, { ...legacyPreferences, modelScope: 'coordinator', workMode: 'auto', teamLaunch: 'automatic' });
  store.getState().saveDefaults(preferences({ selectedModel: '', workMode: 'plan' }));
  capturePreferences().updatePreferences({ trustMode: 'Autonomous' });
  assert.deepEqual(useSettingsStore.getState(), legacyState, 'Orchestrator changes cannot mutate settings used by existing providers');
});

test('new drafts inherit current application defaults until project defaults exist', () => {
  store.getState().saveDefaults(preferences({ workMode: 'research', teamLaunch: 'confirm' }));
  let hook = capturePreferences();
  assert.equal(hook.scopeKey, 'draft:project-a');
  assert.equal(hook.preferences.workMode, 'research');
  assert.equal(hook.customized, false);
  store.getState().saveDefaults(preferences({ workMode: 'execute' }), 'project-a');
  hook = capturePreferences();
  assert.equal(hook.preferences.workMode, 'execute');
  assert.equal(hook.customized, false, 'Inheritance is not a conversation override');
  useWorkspaceStore.setState({ activeWorkspaceId: 'project-b' });
  assert.equal(capturePreferences().preferences.workMode, 'research', 'Project defaults do not leak across workspaces');
});

test('a project override survives application changes and reset resumes live inheritance', () => {
  store.getState().saveDefaults(preferences({ workMode: 'plan' }), 'project-a');
  store.getState().saveDefaults(preferences({ workMode: 'research' }));
  assert.equal(capturePreferences().preferences.workMode, 'plan');
  store.getState().resetProject('project-a');
  assert.equal(capturePreferences().preferences.workMode, 'research');
  store.getState().saveDefaults(preferences({ workMode: 'execute' }));
  assert.equal(capturePreferences().preferences.workMode, 'execute');
});

test('customized conversations preserve their full snapshot across both default changes', () => {
  useMissionStore.setState({ activeMissionId: 'mission-a' });
  store.getState().saveDefaults(preferences({ workMode: 'plan', teamLaunch: 'confirm' }), 'project-a');
  capturePreferences().updatePreferences({ selectedModel: 'antigravity:account:worker-model' });
  const saved = structuredClone(capturePreferences().preferences);
  store.getState().saveDefaults(preferences({ workMode: 'execute', teamLaunch: 'automatic' }));
  store.getState().saveDefaults(preferences({ workMode: 'research' }), 'project-a');
  assert.deepEqual(capturePreferences().preferences, saved);
  assert.equal(capturePreferences().customized, true);
  useMissionStore.setState({ activeMissionId: 'mission-b' });
  assert.equal(capturePreferences().preferences.workMode, 'research');
  useMissionStore.setState({ activeMissionId: 'mission-a' });
  store.getState().resetConversation('conversation:mission-a');
  assert.equal(capturePreferences().preferences.workMode, 'research');
  assert.equal(capturePreferences().customized, false);
});

test('an updater captured before default or conversation changes merges the latest store state', () => {
  const staleHook = capturePreferences();
  store.getState().saveDefaults(preferences({ workMode: 'research' }), 'project-a');
  staleHook.updatePreferences({ teamLaunch: 'confirm' });
  staleHook.updatePreferences({ trustMode: 'Autonomous' });
  assert.equal(capturePreferences().preferences.workMode, 'research');
  assert.equal(capturePreferences().preferences.teamLaunch, 'confirm');
  assert.equal(capturePreferences().preferences.trustMode, 'Autonomous');
  assert.equal(store.getState().projects['project-a'].teamLaunch, 'automatic');
});

test('drafts and preference actions stay bound to their original scope after navigation', () => {
  const first = capturePreferences();
  first.setDraft('Keep project A draft');
  useWorkspaceStore.setState({ activeWorkspaceId: 'project-b' });
  const second = capturePreferences();
  assert.equal(second.draft, '');
  second.setDraft('Keep project B draft');
  first.updatePreferences({ workMode: 'plan' });
  assert.equal(second.preferences.workMode, initial.workMode);
  assert.equal(store.getState().conversations['draft:project-b'], undefined);
  first.setDraft('Updated project A draft');
  assert.equal(store.getState().drafts['draft:project-a'], 'Updated project A draft');
  assert.equal(store.getState().drafts['draft:project-b'], 'Keep project B draft');
  useMissionStore.setState({ activeMissionId: 'mission-b' });
  assert.equal(capturePreferences().draft, '');
  capturePreferences().setDraft('Conversation draft');
  store.getState().setDraft('draft:project-a', '');
  assert.deepEqual(store.getState().drafts, { 'draft:project-b': 'Keep project B draft', 'conversation:mission-b': 'Conversation draft' });
});

test('preferences, conversation overrides and independent drafts survive real persistence', async () => {
  store.getState().saveDefaults(preferences({ workMode: 'research' }));
  store.getState().saveDefaults(preferences({ teamLaunch: 'confirm' }), 'project-a');
  store.getState().setConversation('conversation:mission-a', preferences({ modelScope: 'all' }));
  store.getState().setDraft('conversation:mission-a', 'Unsaved work');
  const persisted = JSON.parse(storage.get(storageKey)!);
  assert.equal(persisted.version, 1);
  assert.equal('setConversation' in persisted.state, false);
  store.setState({ defaults: initial, projects: {}, conversations: {}, drafts: {} });
  await hydrate(persisted.state);
  assert.equal(store.getState().defaults.workMode, 'research');
  assert.equal(store.getState().projects['project-a'].teamLaunch, 'confirm');
  assert.equal(store.getState().conversations['conversation:mission-a'].modelScope, 'all');
  assert.equal(store.getState().drafts['conversation:mission-a'], 'Unsaved work');
});

test('invalid enums and profile IDs normalize while valid choices remain intact', async () => {
  await hydrate({ defaults: {
    selectedModel: 42, modelScope: 'workers', trustMode: 'unsafe', workMode: 'destroy', teamLaunch: 'later',
    reasoningLevel: 'HIGH', teamTemplate: ' Core Dev Team ',
    agentProfileIds: { builder: ' profile-a ', qa: '', reviewer: 42, unknown: 'leak' },
  }, drafts: { good: 'Keep me', bad: 42 } });
  assert.deepEqual(store.getState().defaults, {
    ...initial, reasoningLevel: 'high', teamTemplate: 'default-core-dev-team', agentProfileIds: { builder: 'profile-a' },
  });
  assert.deepEqual(store.getState().drafts, { good: 'Keep me' });
});

test('malformed persisted team template IDs fall back without crashing hydration', async () => {
  await hydrate({ defaults: { teamTemplate: 42 }, drafts: { good: 'Retain this draft' } });
  assert.equal(store.getState().defaults.teamTemplate, initial.teamTemplate);
  assert.equal(store.getState().drafts.good, 'Retain this draft');
});

test('persisted action permissions accept only boolean or null values and known keys', async () => {
  await hydrate({ defaults: { automationSettings: { fileWrite: 'yes', gitCommit: 1, packageInstall: false, arbitrary: true } } });
  assert.deepEqual(store.getState().defaults.automationSettings, { fileWrite: false, gitCommit: null, packageInstall: false });
});

test('unknown persisted reasoning values fall back to the inherited canonical value', () => {
  assert.equal(normalizeOrchestratorPreferences({ reasoningLevel: 'turbo' }, initial).reasoningLevel, initial.reasoningLevel);
});

test('malformed persisted containers cannot fabricate conversation overrides', async () => {
  await hydrate({ projects: [], conversations: { 'conversation:valid': { workMode: 'plan' }, 'conversation:invalid': [] } });
  assert.deepEqual(store.getState().projects, {});
  assert.equal(store.getState().conversations['conversation:valid'].workMode, 'plan');
  assert.equal(store.getState().conversations['conversation:invalid'], undefined);
});

test('malformed persisted draft containers cannot become indexed character drafts', async () => {
  await hydrate({ drafts: 'oops' });
  assert.deepEqual(store.getState().drafts, {});
});

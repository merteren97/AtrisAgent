import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

// Same lightweight standalone assertion style as the existing desktop tests.
const storage = new Map<string, string>();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: globalThis.localStorage } });
const { planningChatDisplayText: display, planningChatKey, usePlanningChatStore } = await import('@/stores/planning-chat-store');
if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
else Reflect.deleteProperty(globalThis, 'window');

const updateBlock = '```atris-plan-update\n{"path":"plan.md","content":"' + 'secret payload '.repeat(10000);
assert.equal(display('A short explanation.\n' + updateBlock), 'A short explanation.');
assert.equal(display('A\n```atris-plan-up'), 'A');
assert.equal(display('A\n```atris-plan-update\n{}\n```\nB\n```atris-plan-update\n{}\n```'), 'A\nB');
assert.equal(display('```json\n{"normal":"code"}\n```'), '```json\n{"normal":"code"}\n```');
assert.equal(display('Planı birlikte netleştirelim. Ne yapmak istiyorsunuz?'), 'Planı birlikte netleştirelim. Ne yapmak istiyorsunuz?');

const first = planningChatKey('workspace', 'plan');
const other = planningChatKey('other-workspace', 'plan');
assert.notEqual(planningChatKey('a/b', 'c'), planningChatKey('a', 'b/c'));
const store = usePlanningChatStore.getState();
store.update(first, { draft: '  Planı incele  ', catalogId: 'catalog', reasoning: 'high' });
store.update(other, { draft: 'Keep another plan draft', catalogId: 'other-model' });
const send = store.prepare(first, '  Planı incele  ', 'catalog', 'high');
assert.equal(store.prepare(first, 'Planı incele', 'catalog', 'high').id, send.id, 'ambiguous retries must reuse identity');
assert.notEqual(store.prepare(first, send.text, 'catalog', 'low').id, send.id);
assert.notEqual(store.prepare(first, send.text, 'another-model', 'high').id, send.id);
assert.notEqual(store.prepare(other, send.text, 'catalog', 'high').id, send.id);
await usePlanningChatStore.persist.rehydrate();
assert.equal(usePlanningChatStore.getState().prepare(first, send.text, 'catalog', 'high').id, send.id, 'retry ID persists across hydration');
store.update(first, { draft: 'A newer thought while the request is pending' });
store.acknowledge(first, send);
assert.equal(usePlanningChatStore.getState().plans[first].draft, 'A newer thought while the request is pending');
assert.equal(usePlanningChatStore.getState().plans[other].draft, 'Keep another plan draft');
store.update(first, { draft: send.text });
const next = store.prepare(first, send.text, 'catalog', 'high');
assert.notEqual(next.id, send.id, 'acknowledged text may be sent as a new turn');
store.acknowledge(first, next);
assert.equal(usePlanningChatStore.getState().plans[first].draft, '');
store.update(first, { draft: 'Keep my unsent request' });
store.setEditContext(first, 'Section A\n\n');
store.setEditContext(first, 'Section B\n\n');
store.setEditContext(first, 'Section B\n\n');
assert.equal(usePlanningChatStore.getState().plans[first].draft, 'Section B\n\nKeep my unsent request', 'switching AI targets replaces only generated context and never duplicates or erases user typing');
store.update(first, { draft: 'User rewrote the entire instruction' });
store.setEditContext(first, 'Section C\n\n');
assert.equal(usePlanningChatStore.getState().plans[first].draft, 'Section C\n\nUser rewrote the entire instruction', 'user-edited context is preserved as user text');
assert.equal(usePlanningChatStore.getState().plans[other].draft, 'Keep another plan draft');

const codexKey = planningChatKey('workspace', 'plan', 'codex-chat');
const openCodeKey = planningChatKey('workspace', 'plan', 'opencode-chat');
assert.notEqual(codexKey, openCodeKey, 'tabs in the same plan keep separate composer state');
assert.equal(planningChatKey('workspace', 'plan', 'default'), first, 'legacy conversation drafts retain their original key');
store.update(codexKey, { draft: 'Codex @github draft', catalogId: 'codex-model' });
store.update(openCodeKey, { draft: 'OpenCode independent draft', catalogId: 'opencode-model' });
store.select(first, 'opencode-chat');
const file = new File(['review notes'], 'brief.md', { type: 'text/markdown' });
store.updateFiles(codexKey, () => [file]); store.stageFile(codexKey, file, 'assets/brief.md');
const attached = store.prepare(codexKey, 'Review this', 'codex-model', 'high', ['assets/brief.md']);
assert.equal(store.prepare(codexKey, 'Review this', 'codex-model', 'high', ['assets/brief.md']).id, attached.id);
assert.notEqual(store.prepare(codexKey, 'Review this', 'codex-model', 'high', []).id, attached.id, 'attachment changes cannot reuse a differently bound request');
assert.equal(usePlanningChatStore.getState().files[codexKey][0], file);
assert.equal(usePlanningChatStore.getState().files[openCodeKey], undefined);
const persisted = JSON.parse(storage.get('atris-planning-chat-v1')!).state;
assert.equal(persisted.files, undefined, 'File objects stay outside persisted navigation');
assert.equal(persisted.staged, undefined);
await usePlanningChatStore.persist.rehydrate();
assert.equal(usePlanningChatStore.getState().activeByPlan[first], 'opencode-chat');
assert.equal(usePlanningChatStore.getState().plans[openCodeKey].draft, 'OpenCode independent draft');
const creation = store.prepareCreation('plan:codex-model');
assert.equal(store.prepareCreation('plan:codex-model'), creation);
store.acknowledgeCreation('plan:codex-model', creation);
assert.notEqual(store.prepareCreation('plan:codex-model'), creation, 'a deliberate new tab gets its own identity after acknowledgement');

const { PlanningChat } = await import('./planning-chat');
const html = renderToStaticMarkup(<PlanningChat workspaceId="workspace" planId="plan" onDocumentChange={() => {}} onClose={() => {}} onExpand={() => {}} />);
assert.match(html, /aria-label="Planning assistant"/);
assert.match(html, /aria-label="Close assistant"/);
assert.match(html, /Loading your chats/);
const { PlanningCliSetup } = await import('./planning-cli-setup');
const setup = renderToStaticMarkup(<PlanningCliSetup onCreate={async () => {}} />);
for (const name of ['Codex', 'OpenCode', 'Antigravity', 'Claude Code']) assert.match(setup, new RegExp(name));
assert.match(setup, /Open Accounts/);
const { ManualComposer } = await import('@/components/manual/manual-composer');
const { CodexPermissions } = await import('@/components/manual/codex-permissions');
const agent = { id: 'planning-view', name: 'Codex', runtimeType: 'codex' as const, catalogId: 'model', model: 'Codex', accountProfileId: 'account', codexPermissionMode: 'read-only' as const };
const props = { agent, agents: [agent], live: true, native: true, pending: false, draft: 'Review @github', files: [], onDraft: () => {}, onAddFiles: () => {}, onRemoveFile: () => {}, onSend: () => {}, onApply: async () => true };
const composer = renderToStaticMarkup(<ManualComposer {...props} surface="planning" permissionControl={<CodexPermissions agent={agent} live={false} disabled={false} onApply={async () => true} />} />);
assert.match(composer, /aria-label="Planning message composer"/);
assert.match(composer, /aria-label="Attach files or images"/);
assert.match(composer, /Choose CLI and model/);
assert.match(composer, /Codex permissions for Codex/);
assert.match(composer, /<mark[^>]*>@github<\/mark>/, 'planning paints mentions through the real shared MentionTextarea');
assert.doesNotMatch(composer, /Open memory and references/);
const openCodeComposer = renderToStaticMarkup(<ManualComposer {...props} surface="planning" agent={{ ...agent, runtimeType: 'opencode', name: 'OpenCode' }} autoApprove={{ available: true, enabled: false }} onAutoApprove={async () => {}} />);
assert.match(openCodeComposer, /Enable OpenCode auto-approve/);
assert.doesNotMatch(openCodeComposer, /Codex permissions/);
const manual = renderToStaticMarkup(<ManualComposer {...props} onMemory={() => {}} />);
assert.match(manual, /Manual message composer/);
assert.match(manual, /Open memory and references/, 'Manual retains its existing memory action');
console.log('Planning chat assertions passed: per-tab state/attachments, durable request identity, shared Manual composer/mentions/CLI controls and provider parity.');

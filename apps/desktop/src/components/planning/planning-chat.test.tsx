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

const { PlanningChat } = await import('./planning-chat');
const html = renderToStaticMarkup(<PlanningChat workspaceId="workspace" planId="plan" onDocumentChange={() => {}} onClose={() => {}} onExpand={() => {}} />);
assert.match(html, /aria-label="Planning assistant"/);
assert.match(html, /aria-label="Message planning assistant"/);
assert.match(html, /Open Accounts/);
assert.match(html, /aria-label="Close assistant"/);
assert.doesNotMatch(html, /Attach files/);
console.log('Planning chat assertions passed (payload suppression, durable retry identity, draft isolation, SSR accessibility).');

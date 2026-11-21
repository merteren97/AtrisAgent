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

const { AssistantTurnProcess } = await import('@/components/manual/manual-chat-content');
const processHtml = renderToStaticMarkup(
  <AssistantTurnProcess
    thinking={'\n  Inspecting architecture first.\nSecond line of reasoning.'}
    thinkingTokens={1500}
    tools={[
      {
        id: 'sub-1',
        name: 'invoke_subagent',
        summary: 'Research subagent',
        status: 'running',
        subagent: { role: 'Codebase Researcher', typeName: 'research', model: 'gemini-2.5-pro' },
      },
      {
        id: 'tool-1',
        name: 'read_file',
        summary: 'Read planning-chat.tsx',
        status: 'completed',
      },
      {
        id: 'tool-2',
        name: 'run_command',
        summary: 'Run command npm test',
        status: 'failed',
      },
      {
        id: 'art-1',
        name: 'write_file',
        summary: 'Created plan',
        status: 'completed',
        artifact: {
          path: 'plan.md',
          title: 'Implementation Plan',
          summary: 'Step-by-step rollout plan',
          content: '# Plan\n\nDetails here.',
        },
      },
    ]}
  />
);
assert.match(processHtml, /Thought · 1\.5k tokens/);
assert.match(processHtml, /Inspecting architecture first\./);
assert.match(processHtml, /Second line of reasoning\./);
assert.match(processHtml, /Codebase Researcher/);
assert.match(processHtml, /research · gemini-2\.5-pro/);
assert.match(processHtml, /aria-label="Running"/);
assert.match(processHtml, /Read planning-chat\.tsx/);
assert.match(processHtml, /Run command npm test/);
assert.match(processHtml, /Implementation Plan/);
assert.match(processHtml, /Step-by-step rollout plan/);
assert.match(processHtml, /View document/);

const manyToolsHtml = renderToStaticMarkup(
  <AssistantTurnProcess
    tools={[
      { id: 't1', name: 'read_file', summary: 'Read a.ts', status: 'completed' },
      { id: 't2', name: 'read_file', summary: 'Read b.ts', status: 'completed' },
      { id: 't3', name: 'edit_file', summary: 'Edit c.ts', status: 'completed' },
    ]}
  />
);
assert.match(manyToolsHtml, /3 tool calls/);
assert.match(manyToolsHtml, /Read a\.ts/);
assert.match(manyToolsHtml, /Edit c\.ts/);

const { ManualQuestionCard, buildAntigravityQuestionKeystrokes, saveQuestionDraft, getSavedQuestionDraft, clearSavedQuestionDraft } = await import('@/components/manual/manual-question');
const { findMatchingArtifact } = await import('@/components/manual/manual-chat-content');
const questionRequest = {
  id: 'q-req-1',
  questions: [
    {
      header: '',
      question: 'Which framework should we use?',
      options: [
        { label: 'React', description: 'Component UI' },
        { label: 'Vue' },
      ],
      multiple: false,
      custom: true,
    },
    {
      header: 'Targets',
      question: 'Select target platforms',
      options: [
        { label: 'Windows' },
        { label: 'macOS' },
        { label: 'Linux' },
      ],
      multiple: true,
      custom: true,
    },
  ],
};
const questionNoCodeHtml = renderToStaticMarkup(<ManualQuestionCard draftScope="test" request={questionRequest} onReply={async () => {}} />);
assert.match(questionNoCodeHtml, /Question 1\/2/);
assert.match(questionNoCodeHtml, /Which framework should we use\?/);
assert.match(questionNoCodeHtml, /Targets/);
assert.match(questionNoCodeHtml, /Multiple choice · Select all that apply/);
assert.match(questionNoCodeHtml, /placeholder="Write-in… \(or type your own answer\)"/);
assert.match(questionNoCodeHtml, /aria-label="Custom answer for Which framework should we use\?"/);
assert.match(questionNoCodeHtml, /Submit answers/);
assert.doesNotMatch(questionNoCodeHtml, /Answer in Code/);

const questionWithCodeHtml = renderToStaticMarkup(<ManualQuestionCard draftScope="test" request={questionRequest} onReply={async () => {}} onOpenCode={() => {}} />);
assert.match(questionWithCodeHtml, /Answer in Code/);

// Question draft answers survive unmounting and remounting when switching chats/tabs
saveQuestionDraft(questionRequest, [['React'], ['Windows', 'Custom target']], 'test');
assert.deepEqual(getSavedQuestionDraft(questionRequest, 'test'), [['React'], ['Windows', 'Custom target']]);
assert.deepEqual(getSavedQuestionDraft(questionRequest, 'separate-conversation'), [[], []]);
assert.deepEqual(getSavedQuestionDraft({ ...questionRequest, id: 'new-question' }, 'test'), [[], []]);
const remountedQuestionHtml = renderToStaticMarkup(<ManualQuestionCard draftScope="test" request={questionRequest} onReply={async () => {}} />);
assert.match(remountedQuestionHtml, /value="Custom target"/);
assert.doesNotMatch(remountedQuestionHtml, /disabled=""[^>]*>Submit answers/);
clearSavedQuestionDraft(questionRequest, 'test');
assert.deepEqual(getSavedQuestionDraft(questionRequest, 'test'), [[], []]);

// Artifact file link resolution matches exact path and basename
const matchedArtifact = findMatchingArtifact(
  [
    {
      id: 'art-walkthrough',
      name: 'write_file',
      summary: 'Write walkthrough.md',
      status: 'completed',
      artifact: {
        path: 'C:\\Users\\merte\\.gemini\\antigravity-cli\\brain\\7fd73736\\walkthrough.md',
        title: 'walkthrough.md',
        content: '# Walkthrough',
      },
    },
  ],
  'file:///C:/Users/merte/.gemini/antigravity-cli/brain/7fd73736/walkthrough.md',
);
assert.equal(matchedArtifact?.title, 'walkthrough.md');

assert.deepEqual(
  buildAntigravityQuestionKeystrokes(
    {
      id: 'q-single-opt',
      questions: [{ header: '', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }],
    },
    [['C']]
  ),
  ['\u001b[B\u001b[B\r']
);

assert.deepEqual(
  buildAntigravityQuestionKeystrokes(
    {
      id: 'q-single-custom',
      questions: [{ header: '', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
    },
    [['Custom\nline two']]
  ),
  ['\u001b[B\u001b[B\r', 'Custom line two\r']
);

assert.deepEqual(
  buildAntigravityQuestionKeystrokes(
    {
      id: 'q-multi',
      questions: [
        {
          header: '',
          question: 'Pick many',
          options: [{ label: 'First' }, { label: 'Second' }, { label: 'Third' }],
          multiple: true,
        },
      ],
    },
    [['Third', 'First', 'Extra\nnote']]
  ),
  [' ', '\u001b[B\u001b[B ', '\u001b[B\r', 'Extra note\r', '\r']
);

console.log('Planning chat assertions passed: per-tab state/attachments, durable request identity, shared Manual composer/mentions/CLI controls and provider parity.');

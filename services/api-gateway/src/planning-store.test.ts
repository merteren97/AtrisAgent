import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { MAX_PLANNING_CHAT_REQUEST_BYTES, PlanningStore, type PlanningMessage } from './planning-store';
import type { PlanningConversation } from './planning-conversations';

function fixture(t: TestContext, maxAssetBytes?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-planning-store-'));
  for (const name of ['one', 'two', 'outside']) fs.mkdirSync(path.join(root, name));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resolve = (id: string) => ['one', 'two'].includes(id) ? { id, path: path.join(root, id) } : undefined;
  const store = new PlanningStore(resolve, { maxAssetBytes });
  store.create('one', { id: 'plan-one', title: 'Portable research' });
  const planRoot = path.join(root, 'one', '.atris-plans', 'portable-research--plan-one');
  return { root, store, resolve, planRoot };
}
const status = (expected: number, code?: string) => (error: any) => error.statusCode === expected && (code === undefined || error.code === code);

test('conversation registry is versioned, scoped, atomic, restart durable and rejects duplicate or corrupt metadata', t => {
  const { store, resolve, planRoot } = fixture(t);
  const filename = path.join(planRoot, 'chat', 'conversations.json');
  assert.deepEqual(store.readConversations('one', 'plan-one'), []);
  const now = new Date().toISOString();
  const conversation: PlanningConversation = { id: randomUUID(), title: 'Independent', workspaceId: 'one', planId: 'plan-one', runtimeType: 'codex',
    catalogId: 'verified', model: 'model', accountProfileId: 'account', createdAt: now, updatedAt: now, closedAt: null,
    codexPermissionMode: 'read-only', openCodeAutoApprove: false };
  store.writeConversations('one', 'plan-one', [conversation]);
  assert.deepEqual(new PlanningStore(resolve).readConversations('one', 'plan-one'), [conversation]);
  const original = fs.readFileSync(filename, 'utf8');
  assert.equal(JSON.parse(original).schemaVersion, 1);
  for (const entries of [[conversation, conversation], [{ ...conversation, id: 'not-a-uuid' }], [{ ...conversation, planId: 'elsewhere' }], [{ ...conversation, workspaceId: 'two' }]]) {
    assert.throws(() => store.writeConversations('one', 'plan-one', entries), status(409));
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
  }
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => { if (String(destination) === filename) throw new Error('injected registry publish failure'); rename(source, destination); };
  try { assert.throws(() => store.writeConversations('one', 'plan-one', [{ ...conversation, title: 'Unpublished' }]), /publish failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  assert(!fs.readdirSync(path.dirname(filename)).some(name => name.includes('.tmp-')));
  fs.writeFileSync(filename, '{corrupt');
  assert.throws(() => store.readConversations('one', 'plan-one'), status(409));
  assert.equal(fs.readFileSync(filename, 'utf8'), '{corrupt');
});

test('portable plans persist, remain workspace scoped, and metadata edits preserve folder identity', (t) => {
  const { store, resolve, planRoot } = fixture(t);
  assert.equal(store.list('one').length, 1);
  assert.deepEqual(store.list('two'), []);
  assert.throws(() => store.get('two', 'plan-one'), status(404));
  assert.throws(() => store.list('missing'), status(404, 'WORKSPACE_NOT_FOUND'));
  assert.throws(() => store.create('one', { id: 'plan-one', title: 'Duplicate' }), status(409));
  const changed = store.update('one', 'plan-one', { title: 'Renamed', pinned: true, archivedAt: new Date().toISOString(), status: 'ready' });
  assert.equal(changed.title, 'Renamed');
  assert.equal(changed.pinned, true);
  assert.equal(new PlanningStore(resolve).get('one', 'plan-one').status, 'ready');
  assert(fs.existsSync(path.join(planRoot, 'plan.md')));
  const second = resolve('two')!.path;
  fs.mkdirSync(path.join(second, '.atris-plans'));
  fs.cpSync(planRoot, path.join(second, '.atris-plans', 'copied--plan-one'), { recursive: true });
  assert.equal(store.get('two', 'plan-one').workspaceId, 'two');
  assert.equal(store.readDocument('two', 'plan-one', 'plan.md').content, store.readDocument('one', 'plan-one', 'plan.md').content);
});

test('CAS rejects stale and missing revisions, keeps external writes, and retains bounded recovery history', (t) => {
  const { store, planRoot } = fixture(t);
  const original = store.readDocument('one', 'plan-one', 'plan.md');
  let current = store.writeDocument('one', 'plan-one', { path: 'plan.md', content: '# Saved', expectedRevision: original.revision });
  assert.throws(() => store.writeDocument('one', 'plan-one', { path: 'plan.md', content: 'stale', expectedRevision: original.revision }), status(409, 'REVISION_CONFLICT'));
  assert.throws(() => store.writeDocument('one', 'plan-one', { path: 'plan.md', content: 'blind', expectedRevision: undefined as any }), status(400));
  fs.writeFileSync(path.join(planRoot, 'plan.md'), '# External edit');
  assert.throws(() => store.writeDocument('one', 'plan-one', { path: 'plan.md', content: 'lost update', expectedRevision: current.revision }), status(409, 'REVISION_CONFLICT'));
  assert.equal(store.readDocument('one', 'plan-one', 'plan.md').content, '# External edit');
  current = store.readDocument('one', 'plan-one', 'plan.md');
  for (let i = 0; i < 25; i++) current = store.writeDocument('one', 'plan-one', { path: 'plan.md', content: `version ${i}`, expectedRevision: current.revision });
  const history = fs.readdirSync(path.join(planRoot, '.history'));
  assert.equal(history.length, 20);
  assert(history.some((name) => fs.readFileSync(path.join(planRoot, '.history', name), 'utf8') === 'version 23'));
  const note = store.writeDocument('one', 'plan-one', { path: 'research/nested/note.md', content: 'new note', expectedRevision: null });
  assert.equal(note.content, 'new note');
  assert.throws(() => store.writeDocument('one', 'plan-one', { path: note.path, content: 'overwrite', expectedRevision: null }), status(409));
  assert(store.listFiles('one', 'plan-one').some((entry) => entry.path === note.path));
});

test('traversal, hidden paths, alternate streams and unsafe platform filenames are rejected', (t) => {
  const { store } = fixture(t);
  for (const relative of ['../plan.md', '/plan.md', 'research/../plan.md', 'research/.secret.md', 'research/x:secret.md', 'research/CON.md', 'research/note.md.', 'research\\note.md', 'chat/messages.jsonl', 'runs/x/plan.md', '.history/x.md']) {
    assert.throws(() => store.readDocument('one', 'plan-one', relative), status(400), relative);
    assert.throws(() => store.writeDocument('one', 'plan-one', { path: relative, content: 'unsafe', expectedRevision: null }), status(400), relative);
  }
  assert.throws(() => store.readDocument('one', '../escape', 'plan.md'), status(400));
});

test('an interrupted atomic document publish retains the previous document and recovery copy', (t) => {
  const { store, planRoot } = fixture(t);
  const original = store.readDocument('one', 'plan-one', 'plan.md');
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (String(destination) === path.join(planRoot, 'plan.md')) throw Object.assign(new Error('injected publish failure'), { code: 'EIO' });
    rename(source, destination);
  };
  try {
    assert.throws(() => store.writeDocument('one', 'plan-one', { path: 'plan.md', content: 'Interrupted replacement', expectedRevision: original.revision }), /injected publish failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(store.readDocument('one', 'plan-one', 'plan.md').content, original.content);
  const history = path.join(planRoot, '.history');
  assert(fs.readdirSync(history).some((name) => fs.readFileSync(path.join(history, name), 'utf8') === original.content));
  assert(!fs.readdirSync(planRoot).some((name) => name.includes('.tmp-')));
});

test('junctions in roots, document directories and recovery directories cannot escape containment', (t) => {
  const { root, store, planRoot } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.writeFileSync(path.join(outside, 'sentinel.md'), 'outside-owned');
  const link = (target: string, filename: string) => fs.symlinkSync(target, filename, process.platform === 'win32' ? 'junction' : 'dir');
  const research = path.join(planRoot, 'research');
  fs.rmdirSync(research);
  link(outside, research);
  assert.throws(() => store.readDocument('one', 'plan-one', 'research/sentinel.md'), status(409));
  assert.throws(() => store.writeDocument('one', 'plan-one', { path: 'research/sentinel.md', content: 'oops', expectedRevision: null }), status(409));
  assert.throws(() => store.listFiles('one', 'plan-one'), status(409));
  fs.rmSync(research, { recursive: true });
  fs.mkdirSync(research);
  const history = path.join(planRoot, '.history');
  fs.rmdirSync(history);
  link(outside, history);
  const document = store.readDocument('one', 'plan-one', 'plan.md');
  assert.throws(() => store.writeDocument('one', 'plan-one', { path: 'plan.md', content: 'new', expectedRevision: document.revision }), status(409));
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.md'), 'utf8'), 'outside-owned');
  const plans = path.dirname(planRoot);
  fs.renameSync(plans, `${plans}-saved`);
  link(outside, plans);
  assert.throws(() => store.list('one'), status(409));
});

test('hard-linked document files are not read or replaced', (t) => {
  const { root, store, planRoot } = fixture(t);
  const sentinel = path.join(root, 'outside', 'sentinel.md');
  fs.writeFileSync(sentinel, 'preserve me');
  fs.linkSync(sentinel, path.join(planRoot, 'research', 'linked.md'));
  assert.throws(() => store.readDocument('one', 'plan-one', 'research/linked.md'), status(409));
  assert.throws(() => store.resolveFile('one', 'plan-one', 'research/linked.md'), status(409));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve me');
});

test('streamed imports validate bytes and size, avoid overwrite, and clean rejected uploads', async (t) => {
  const { store, planRoot } = fixture(t, 100);
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('png-body')]);
  const upload = (filename = 'diagram.png', data = bytes, mimeType = 'image/png') => store.importAsset('one', 'plan-one', { filename, mimeType, stream: Readable.from([data.subarray(0, 4), data.subarray(4)]) });
  const first = await upload();
  const second = await upload();
  assert.equal(first.path, 'assets/diagram.png');
  assert.notEqual(second.path, first.path);
  assert.deepEqual(fs.readFileSync(store.resolveFile('one', 'plan-one', first.path).absolutePath), bytes);
  await assert.rejects(upload('fake.png', Buffer.from('<html>'), 'image/png'), /MIME/);
  await assert.rejects(upload('page.html', Buffer.from('<html>'), 'text/html'), /Unsupported/);
  await assert.rejects(upload('big.png', Buffer.alloc(101)), status(413));
  await assert.rejects(upload('../escape.png'), /safe filename/);
  await assert.rejects(upload('invalid.txt', Buffer.from([255]), 'text/plain'), /UTF-8/);
  assert.equal(fs.readdirSync(path.join(planRoot, 'assets')).length, 2);
});

test('portable chat append is idempotent, conflicts are explicit, and state is per-plan', (t) => {
  const { store, resolve, planRoot } = fixture(t);
  store.create('one', { id: 'another-plan', title: 'Another' });
  const message: PlanningMessage = { id: 'message-1', role: 'user', text: 'Research this', createdAt: new Date().toISOString(), turnId: 'turn-1', planningChat: { version: 1, kind: 'start', turnId: 'turn-1' } };
  store.appendMessage('one', 'plan-one', message);
  store.appendMessage('one', 'plan-one', message);
  assert.equal(new PlanningStore(resolve).readMessages('one', 'plan-one').length, 1);
  assert.deepEqual(new PlanningStore(resolve).readMessages('one', 'plan-one')[0].planningChat, message.planningChat);
  assert.equal(store.workspace('one').path, resolve('one')!.path);
  assert.deepEqual(store.readMessages('one', 'another-plan'), []);
  assert.throws(() => store.appendMessage('one', 'plan-one', { ...message, text: 'different' }), status(409, 'MESSAGE_CONFLICT'));
  store.writeChatState('one', 'plan-one', { sessionId: 'native-session', activeTurn: 'turn-1' });
  assert.deepEqual(store.readChatState('one', 'plan-one'), { sessionId: 'native-session', activeTurn: 'turn-1' });
  assert.equal(store.readChatState('one', 'another-plan'), null);
  fs.appendFileSync(path.join(planRoot, 'chat', 'messages.jsonl'), '{partial');
  assert.throws(() => store.appendMessage('one', 'plan-one', { ...message, id: 'message-2' }), status(409, 'INVALID_PLANNING_DATA'));
  assert(fs.readFileSync(path.join(planRoot, 'chat', 'messages.jsonl'), 'utf8').endsWith('{partial'));
});

test('private task inputs preserve full large UTF-8 prompts, publish exclusively, and stay out of files/media/snapshots', (t) => {
  const { store, resolve, planRoot } = fixture(t);
  const id = randomUUID();
  const prompt = 'Read-only task instructions\n' + 'Full user context ü🧭\n'.repeat(8_000) + 'END OF REQUEST';
  const filename = store.prepareChatPrompt('one', 'plan-one', id, prompt);
  assert.equal(filename, fs.realpathSync(path.join(planRoot, 'chat', 'requests', `${id}.md`)));
  assert(path.isAbsolute(filename));
  assert.equal(fs.readFileSync(filename, 'utf8'), prompt);
  assert.throws(() => store.prepareChatPrompt('one', 'plan-one', id, 'overwrite'), status(409, 'CHAT_REQUEST_EXISTS'));
  assert.throws(() => new PlanningStore(resolve).prepareChatPrompt('one', 'plan-one', id.toUpperCase(), 'overwrite'), status(409));
  assert.equal(fs.readFileSync(filename, 'utf8'), prompt);
  assert.throws(() => store.prepareChatPrompt('two', 'plan-one', randomUUID(), prompt), status(404));
  for (const value of ['../escape', 'not-a-uuid', `${id}.md`, `../${id}`, 'CON', '']) {
    assert.throws(() => store.prepareChatPrompt('one', 'plan-one', value, prompt), status(400));
  }
  assert.throws(() => store.prepareChatPrompt('one', 'plan-one', randomUUID(), 'ü'.repeat(MAX_PLANNING_CHAT_REQUEST_BYTES)), status(413));
  assert.throws(() => store.prepareChatPrompt('one', 'plan-one', randomUUID(), 'bad\0input'), /UTF-8/);
  assert.throws(() => store.prepareChatPrompt('one', 'plan-one', randomUUID(), '\ud800'), /UTF-8/);
  const files = store.listFiles('one', 'plan-one');
  assert.deepEqual(files.map(file => file.path), ['plan.md']);
  const relative = `chat/requests/${id}.md`;
  assert.throws(() => store.readDocument('one', 'plan-one', relative), status(400));
  assert.throws(() => store.resolveFile('one', 'plan-one', relative), status(400));
  assert.throws(() => store.createExecution('one', 'plan-one', { id: 'private-selection', target: 'manual', paths: [relative] }), status(400));
  const execution = store.createExecution('one', 'plan-one', { id: 'public-snapshot', target: 'manual', paths: files.map(file => file.path) });
  assert.deepEqual(execution.files.map(file => file.path), ['plan.md']);
  assert(!fs.existsSync(path.join(execution.snapshotPath, 'chat')));
  store.releaseChatPrompt('one', 'plan-one', id);
  assert.equal(fs.readFileSync(filename, 'utf8'), prompt, 'Current input survives release/restart for recovery');
});

test('task input retention keeps recent 20 and never deletes another active input, even through a second store', (t) => {
  const { store, resolve } = fixture(t);
  const active = randomUUID();
  const activeFile = store.prepareChatPrompt('one', 'plan-one', active, 'Still spawning after stop');
  fs.utimesSync(activeFile, new Date(0), new Date(0));
  const requests = path.dirname(activeFile);
  const second = new PlanningStore(resolve);
  let latest = '';
  for (let i = 0; i < 25; i++) {
    const id = randomUUID();
    latest = second.prepareChatPrompt('one', 'plan-one', id, `Input ${i}`);
    fs.utimesSync(latest, new Date(1_000 + i * 1_000), new Date(1_000 + i * 1_000));
    second.releaseChatPrompt('one', 'plan-one', id);
  }
  assert(fs.existsSync(activeFile), 'An old pinned request is never pruned');
  assert.equal(fs.readdirSync(requests).length, 21);
  assert.equal(fs.readFileSync(latest, 'utf8'), 'Input 24');
  store.releaseChatPrompt('one', 'plan-one', active);
  assert.equal(fs.readdirSync(requests).length, 20);
  assert(!fs.existsSync(activeFile));
  assert.equal(fs.readFileSync(latest, 'utf8'), 'Input 24');
});

test('failed and racing task-file publications leave no partial input and never overwrite a competing request', (t) => {
  const { store, planRoot } = fixture(t);
  const id = randomUUID();
  const filename = path.join(planRoot, 'chat', 'requests', `${id}.md`);
  const link = fs.linkSync;
  fs.linkSync = () => { throw new Error('injected task publish failure'); };
  try { assert.throws(() => store.prepareChatPrompt('one', 'plan-one', id, 'Full input'), /injected task publish failure/); }
  finally { fs.linkSync = link; }
  assert(!fs.existsSync(filename));
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), []);
  fs.linkSync = (source, destination) => {
    fs.writeFileSync(destination, 'Competing input', { flag: 'wx' });
    link(source, destination);
  };
  try { assert.throws(() => store.prepareChatPrompt('one', 'plan-one', id, 'Must not overwrite'), status(409, 'CHAT_REQUEST_EXISTS')); }
  finally { fs.linkSync = link; }
  assert.equal(fs.readFileSync(filename, 'utf8'), 'Competing input');
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), [`${id}.md`]);
});

test('chat request containment rejects junctions and hard links without touching outside files', (t) => {
  const { root, store, planRoot } = fixture(t);
  const outside = path.join(root, 'outside');
  const requests = path.join(planRoot, 'chat', 'requests');
  fs.symlinkSync(outside, requests, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.prepareChatPrompt('one', 'plan-one', randomUUID(), 'Must stay inside'), status(409));
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmSync(requests, { recursive: true });
  fs.mkdirSync(requests);
  const sentinel = path.join(outside, 'sentinel.md');
  fs.writeFileSync(sentinel, 'Outside-owned');
  const id = randomUUID();
  fs.linkSync(sentinel, path.join(requests, `${id}.md`));
  assert.throws(() => store.prepareChatPrompt('one', 'plan-one', id, 'Must not overwrite'), status(409));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Outside-owned');
});

test('execution snapshots stay fixed after edits and retries/restarts link one durable target', async (t) => {
  const { store, resolve } = fixture(t);
  store.writeDocument('one', 'plan-one', { path: 'research/note.md', content: 'Selected research', expectedRevision: null });
  const asset = await store.importAsset('one', 'plan-one', { filename: 'context.txt', mimeType: 'text/plain', stream: Readable.from(['Selected asset']) });
  const input = { id: 'operation-1', target: 'manual' as const, paths: ['research/note.md', asset.path] };
  const execution = store.createExecution('one', 'plan-one', input);
  const original = fs.readFileSync(path.join(execution.snapshotPath, 'plan.md'), 'utf8');
  const document = store.readDocument('one', 'plan-one', 'plan.md');
  store.writeDocument('one', 'plan-one', { path: 'plan.md', content: 'Later plan', expectedRevision: document.revision });
  const restarted = new PlanningStore(resolve);
  assert.deepEqual(restarted.createExecution('one', 'plan-one', input), execution);
  assert.equal(fs.readFileSync(path.join(execution.snapshotPath, 'plan.md'), 'utf8'), original);
  assert.equal(execution.files.length, 3);
  assert.throws(() => restarted.createExecution('one', 'plan-one', { ...input, target: 'orchestrator' }), status(409, 'EXECUTION_CONFLICT'));
  assert.throws(() => restarted.createExecution('one', 'plan-one', { ...input, paths: [] }), status(409));
  const linked = restarted.recordExecutionTarget('one', 'plan-one', input.id, 'conversation-1');
  assert.equal(linked.status, 'linked');
  assert.equal(restarted.recordExecutionTarget('one', 'plan-one', input.id, 'conversation-1').targetId, 'conversation-1');
  assert.throws(() => restarted.recordExecutionTarget('one', 'plan-one', input.id, 'conversation-2'), status(409));
  const copied = path.join(execution.snapshotPath, 'plan.md');
  fs.chmodSync(copied, 0o600);
  fs.writeFileSync(copied, 'tampered snapshot');
  assert.throws(() => restarted.getExecution('one', 'plan-one', input.id), status(409, 'EXECUTION_CHANGED'));
});

test('invalid externally edited metadata is preserved rather than silently reset', (t) => {
  const { store, planRoot } = fixture(t);
  fs.writeFileSync(path.join(planRoot, 'plan.json'), '{partial');
  assert.throws(() => store.list('one'), status(409, 'INVALID_PLANNING_DATA'));
  assert.equal(fs.readFileSync(path.join(planRoot, 'plan.json'), 'utf8'), '{partial');
});

test('incomplete execution staging is never mistaken for a committed operation', (t) => {
  const { store, planRoot } = fixture(t);
  const pending = path.join(planRoot, 'runs', '.prepare-operation-crash');
  fs.mkdirSync(pending);
  fs.writeFileSync(path.join(pending, 'plan.md'), 'incomplete');
  assert.throws(() => store.getExecution('one', 'plan-one', 'operation-crash'), status(404, 'EXECUTION_NOT_FOUND'));
  const retry = store.createExecution('one', 'plan-one', { id: 'operation-crash', target: 'manual' });
  assert.equal(retry.status, 'prepared');
  assert.equal(retry.files[0].sha256, store.readDocument('one', 'plan-one', 'plan.md').revision);
});

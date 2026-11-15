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
  const jpegBytes = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 0, 1, 1, 1]);
  const mislabeled = await upload('hero.png', jpegBytes, 'image/png');
  assert.equal(mislabeled.mimeType, 'image/jpeg');
  const resolved = store.resolveFile('one', 'plan-one', mislabeled.path);
  assert.equal(resolved.mimeType, 'image/jpeg');
  assert.equal(fs.readdirSync(path.join(planRoot, 'assets')).length, 3);
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

test('new plans avoid fixed headings and start with an empty editable board', (t) => {
  const { store, planRoot } = fixture(t);
  assert.equal(store.readDocument('one', 'plan-one', 'plan.md').content, '# Portable research\n\n');
  const board = store.readBoard('one', 'plan-one');
  assert(board);
  assert.deepEqual(board!.board.sections, []);
  assert(fs.existsSync(path.join(planRoot, 'board', 'board.json')));
});

test('board writes per-section Markdown, enforces revision and validates the tree', (t) => {
  const { store, planRoot } = fixture(t);
  const empty = store.readBoard('one', 'plan-one')!;
  const sections = [{
    id: 'character', title: 'Character', kind: 'gallery', status: 'review', summary: 'Shape language', cover: 'assets/cover.png',
    body: 'Main direction',
    children: [{ id: 'silhouette', title: 'Silhouette', kind: 'comparison', body: 'Readable at gameplay size.' }],
    items: [{ id: 'v1-v2', title: 'V1 vs V2', body: 'Reduce belt noise.', status: 'done',
      media: [{ path: 'assets/v1.png', alt: 'Version 1', label: 'Before' }, { path: 'assets/v2.png', alt: 'Version 2', label: 'After' }],
      compare: { mode: 'slider', before: 'assets/v1.png', after: 'assets/v2.png' }, prompt: 'Keep the silhouette', source: 'https://example.com/reference' }],
  }];
  const saved = store.writeBoard('one', 'plan-one', { expectedRevision: empty.revision, board: { schemaVersion: 1, planId: 'plan-one', updatedAt: '', sections } });
  const manifest = JSON.parse(fs.readFileSync(path.join(planRoot, 'board', 'board.json'), 'utf8'));
  assert.equal(saved.board.sections[0].body, 'Main direction');
  assert.equal(saved.board.sections[0].children![0].body, 'Readable at gameplay size.');
  assert.equal(saved.board.sections[0].items![0].body, 'Reduce belt noise.');
  assert.equal(fs.readFileSync(path.join(planRoot, manifest.sections[0].bodyPath), 'utf8'), 'Main direction');
  assert.equal(fs.readFileSync(path.join(planRoot, manifest.sections[0].items[0].bodyPath), 'utf8'), 'Reduce belt noise.');
  assert.notEqual(saved.revision, empty.revision);
  const restarted = new PlanningStore((id) => id === 'one' ? { id, path: path.dirname(path.dirname(planRoot)) } : undefined);
  assert.deepEqual(restarted.readBoard('one', 'plan-one')!.board, saved.board);
  assert.throws(() => store.writeBoard('one', 'plan-one', { expectedRevision: empty.revision, board: saved.board }), status(409, 'REVISION_CONFLICT'));
  const deep = { id: 'one', title: 'One', kind: 'section', children: [{ id: 'two', title: 'Two', kind: 'section', children: [{ id: 'three', title: 'Three', kind: 'section', children: [{ id: 'four', title: 'Four', kind: 'section', children: [{ id: 'five', title: 'Five', kind: 'section' }] }] }] }] };
  for (const invalid of [
    { ...saved.board, sections: [{ id: 'x', title: 'X', kind: 'section' }, { id: 'x', title: 'Duplicate', kind: 'section' }] },
    { ...saved.board, sections: [deep] },
    { ...saved.board, sections: [{ id: 'x', title: 'X', kind: 'section', cover: 'research/x.png' }] },
    { ...saved.board, sections: [{ id: 'x', title: 'X', kind: 'section', items: [{ id: 'i', title: 'I', media: [{ path: '../x.png' }] }] }] },
    { ...saved.board, sections: [{ id: 'x', title: 'X', kind: 'section', items: [{ id: 'i', title: 'I', compare: { mode: 'overlay', before: 'assets/a.png', after: 'assets/b.png' } }] }] },
    { ...saved.board, sections: [{ id: 'x', title: 'X', kind: 'section', items: [{ id: 'i', title: 'I', source: 'javascript:alert(1)' }] }] },
    { ...saved.board, planId: 'other-plan' },
  ]) assert.throws(() => store.writeBoard('one', 'plan-one', { expectedRevision: saved.revision, board: invalid }), status(400));
  assert.equal(store.readBoard('one', 'plan-one')!.revision, saved.revision);
  assert.equal(fs.readFileSync(path.join(planRoot, manifest.sections[0].bodyPath), 'utf8'), 'Main direction');
});

test('interrupted board publication preserves the entire previous revision', (t) => {
  const { store, planRoot } = fixture(t);
  const empty = store.readBoard('one', 'plan-one')!;
  const saved = store.writeBoard('one', 'plan-one', { expectedRevision: empty.revision, board: { ...empty.board, sections: [{ id: 'a', title: 'A', kind: 'section', body: 'old', items: [{ id: 'b', title: 'B', body: 'old item' }] }] } });
  const changed = structuredClone(saved.board);
  changed.sections[0].body = 'new';
  changed.sections[0].items![0].body = 'new item';
  const destination = path.join(planRoot, 'board', 'board.json');
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (String(target) === destination) throw new Error('injected manifest failure'); rename(source, target); };
  try { assert.throws(() => store.writeBoard('one', 'plan-one', { expectedRevision: saved.revision, board: changed }), /injected manifest failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(store.readBoard('one', 'plan-one'), saved);
});

test('overview and constrained appearance survive reload, snapshots and rejected updates', (t) => {
  const { store, planRoot } = fixture(t);
  const original = store.readBoard('one', 'plan-one')!;
  const appearance = { font: 'editorial', accent: 'sage', density: 'compact' };
  const saved = store.writeBoard('one', 'plan-one', { expectedRevision: original.revision, board: { ...original.board,
    summary: 'A concise project overview.', cover: 'assets/cover.png', appearance,
    sections: [{ id: 'direction', title: 'Direction', kind: 'note', body: 'Keep the content simple.' }],
  } });
  assert.deepEqual(saved.board.appearance, appearance);
  const restarted = new PlanningStore(id => id === 'one' ? { id, path: path.dirname(path.dirname(planRoot)) } : undefined);
  assert.deepEqual(restarted.readBoard('one', 'plan-one'), saved);
  const snapshot = store.createExecution('one', 'plan-one', { id: 'appearance-snapshot', target: 'manual' });
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot.snapshotPath, 'board', 'board.json'), 'utf8'));
  assert.deepEqual(manifest.appearance, appearance);
  assert.equal(manifest.summary, saved.board.summary);
  for (const patch of [
    { appearance: { ...appearance, font: 'url(https://external/font)' } },
    { appearance: { ...appearance, accent: 'custom-css' } },
    { appearance: { ...appearance, density: 'unknown' } }, { appearance: [] },
    { cover: '../private.png' },
  ]) assert.throws(() => store.writeBoard('one', 'plan-one', { expectedRevision: saved.revision, board: { ...saved.board, ...patch } }), status(400));
  assert.throws(() => store.writeBoard('one', 'plan-one', { expectedRevision: saved.revision, board: { ...saved.board, summary: 'x'.repeat(4001) } }), status(413));
  assert.deepEqual(store.readBoard('one', 'plan-one'), saved, 'invalid appearance must not partially replace content');
});

test('legacy board bodies remain readable and manifest paths stay confined to their node', (t) => {
  const { store, planRoot } = fixture(t);
  const manifestPath = path.join(planRoot, 'board', 'board.json');
  const legacyPath = path.join(planRoot, 'board', 'content', 'legacy.md');
  fs.writeFileSync(legacyPath, 'legacy content');
  const manifest = { schemaVersion: 1, planId: 'plan-one', updatedAt: new Date().toISOString(), sections: [{ id: 'legacy', title: 'Legacy', kind: 'section', bodyPath: 'board/content/legacy.md' }] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const board = store.readBoard('one', 'plan-one')!;
  assert.equal(board.board.sections[0].body, 'legacy content');
  const saved = store.writeBoard('one', 'plan-one', { expectedRevision: board.revision, board: board.board });
  assert.equal(saved.board.sections[0].body, 'legacy content');
  manifest.sections[0].bodyPath = 'board/content/../plan.md';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => store.readBoard('one', 'plan-one'), status(409, 'INVALID_PLANNING_DATA'));
});

test('execution snapshots freeze board content and retain idempotent retries', (t) => {
  const { store } = fixture(t);
  const empty = store.readBoard('one', 'plan-one')!;
  const saved = store.writeBoard('one', 'plan-one', { expectedRevision: empty.revision, board: { ...empty.board, sections: [{ id: 'feature', title: 'Feature', kind: 'section', body: 'original board body', items: [{ id: 'detail', title: 'Detail', body: 'original item' }] }] } });
  const snapshot = store.createExecution('one', 'plan-one', { id: 'board-snapshot', target: 'manual' });
  assert.equal(snapshot.boardRevision, saved.revision);
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot.snapshotPath, 'board', 'board.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(snapshot.snapshotPath, manifest.sections[0].bodyPath), 'utf8'), 'original board body');
  assert.equal(fs.readFileSync(path.join(snapshot.snapshotPath, manifest.sections[0].items[0].bodyPath), 'utf8'), 'original item');
  const edited = structuredClone(saved.board); edited.sections[0].body = 'later edit';
  store.writeBoard('one', 'plan-one', { expectedRevision: saved.revision, board: edited });
  const retry = store.createExecution('one', 'plan-one', { id: 'board-snapshot', target: 'manual' });
  assert.equal(retry.boardRevision, saved.revision);
  assert.equal(fs.readFileSync(path.join(retry.snapshotPath, manifest.sections[0].bodyPath), 'utf8'), 'original board body');
  const snapshotBody = path.join(retry.snapshotPath, manifest.sections[0].bodyPath);
  fs.chmodSync(snapshotBody, 0o600);
  fs.writeFileSync(snapshotBody, 'tampered');
  assert.throws(() => store.getExecution('one', 'plan-one', 'board-snapshot'), status(409, 'EXECUTION_CHANGED'));
});

test('Markdown outline derivation is read-only and explicit conversion preserves headings', (t) => {
  const { store, planRoot } = fixture(t);
  const document = store.readDocument('one', 'plan-one', 'plan.md');
  store.writeDocument('one', 'plan-one', { path: 'plan.md', content: [
    '# Product plan', '', 'Intro line.', '', '## Problem', '', 'Users lose context.', '', '### Evidence', '', 'Five interviews.', '', '```md', '## not a heading', '```', '', '## Scope', '', 'Ship a board.', '',
  ].join('\n'), expectedRevision: document.revision });
  assert.equal(store.readBoard('one', 'plan-one')!.board.sections.length, 0);
  const outline = store.deriveOutline('one', 'plan-one');
  assert.deepEqual(outline.sections.map(({ id, title, level, body }) => ({ id, title, level, body })), [
    { id: 'problem', title: 'Problem', level: 2, body: 'Users lose context.' },
    { id: 'evidence', title: 'Evidence', level: 3, body: 'Five interviews.\n\n```md\n## not a heading\n```' },
    { id: 'scope', title: 'Scope', level: 2, body: 'Ship a board.' },
  ]);
  assert.equal(store.readBoard('one', 'plan-one')!.board.sections.length, 0);
  const converted = store.convertBoard('one', 'plan-one');
  assert.deepEqual(converted.board.sections.map((section) => ({ id: section.id, body: section.body, children: section.children?.map((child) => ({ id: child.id, body: child.body })) })), [
    { id: 'problem', body: 'Users lose context.', children: [{ id: 'evidence', body: 'Five interviews.\n\n```md\n## not a heading\n```' }] },
    { id: 'scope', body: 'Ship a board.', children: undefined },
  ]);
  const manifest = JSON.parse(fs.readFileSync(path.join(planRoot, 'board', 'board.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(planRoot, manifest.sections[0].children[0].bodyPath), 'utf8'), 'Five interviews.\n\n```md\n## not a heading\n```');
  assert.throws(() => store.convertBoard('one', 'plan-one'), status(409, 'PLANNING_EXISTS'));
});

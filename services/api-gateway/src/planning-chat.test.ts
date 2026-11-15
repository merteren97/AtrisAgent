import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { AccountProfile, CapabilitySnapshot, ModelDescriptor, RuntimeType } from '@atris-agent-code/domain';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import type { SpawnAgentOptions } from '@atris-agent-code/runtime-host';
import {
  PlanningChatController, extractPlanningUpdates, installPlanningChatRoutes,
  type PlanningChatAdapter, type PlanningChatOptions, type PlanningChatRecord, type PlanningChatState, type PlanningChatStorage,
} from './planning-chat';
import { PlanningStore } from './planning-store';
import type { PlanningConversation } from './planning-conversations';
import { isLocalDataRequest } from './local-data-access';
import { installManualConversations } from './manual-conversations';

class Storage implements PlanningChatStorage {
  conversations = new Map<string, PlanningConversation[]>();
  readConversations(w: string, p: string) { this.get(w, p); return structuredClone(this.conversations.get(JSON.stringify([w, p])) || []); }
  writeConversations(w: string, p: string, entries: PlanningConversation[]) { this.get(w, p); this.conversations.set(JSON.stringify([w, p]), structuredClone(entries)); }
  journals = new Map<string, PlanningChatRecord[]>();
  documents = new Map<string, { content: string; revision: string }>();
  writes = 0;
  key(w: string, p: string) { return `${w}:${p}`; }
  workspace(w: string) { if (!['w', 'other-workspace'].includes(w)) throw Object.assign(new Error('Workspace not found'), { status: 404 }); return { path: process.cwd() }; }
  get(w: string, p: string) {
    this.workspace(w);
    if (!['p', 'other-plan'].includes(p)) throw Object.assign(new Error('Plan not found'), { status: 404 });
    return { documents: [{ path: 'plan.md' }, { path: 'research/context.md' }] };
  }
  listFiles() { return [{ path: 'plan.md' }, { path: 'research/context.md' }]; }
  readDocument(w: string, p: string, path: string) {
    const result = this.documents.get(`${this.key(w, p)}:${path}`);
    if (!result) throw Object.assign(new Error('Document not found'), { status: 404 });
    return { ...result };
  }
  writeDocument(w: string, p: string, input: { path: string; content: string; expectedRevision: string | null }) {
    const key = `${this.key(w, p)}:${input.path}`;
    if ((this.documents.get(key)?.revision ?? null) !== input.expectedRevision) throw Object.assign(new Error('Revision conflict'), { statusCode: 409, code: 'REVISION_CONFLICT' });
    this.writes += 1;
    const result = { content: input.content, revision: `revision-${this.writes}` };
    this.documents.set(key, result);
    return result;
  }
  readMessages(w: string, p: string) { return structuredClone(this.journals.get(this.key(w, p)) || []); }
  appendMessage(w: string, p: string, record: PlanningChatRecord) {
    const key = this.key(w, p);
    this.journals.set(key, [...(this.journals.get(key) || []), structuredClone(record)]);
  }
  seed() {
    for (const w of ['w', 'other-workspace']) for (const p of ['p', 'other-plan']) {
      this.documents.set(`${this.key(w, p)}:plan.md`, { content: `# Plan for ${w}/${p}`, revision: 'initial' });
      this.documents.set(`${this.key(w, p)}:research/context.md`, { content: `Research for ${w}/${p}`, revision: 'initial-research' });
    }
    return this;
  }
}

const capabilities = (): CapabilitySnapshot => ({ structuredEventStreaming: true, sessionResume: false, modelSelection: true,
  reasoningControl: true, toolCallEvents: true, interactiveApproval: false, usageInfo: false, cancellation: true,
  worktreeAwareness: true, headlessAuth: false, nativeSubAgent: false });

class Adapter implements PlanningChatAdapter {
  options?: SpawnAgentOptions;
  profile?: AccountProfile;
  cancelled: string[] = [];
  shutdowns = 0;
  caps = capabilities();
  spawnWait?: Promise<void>;
  cancelWait?: Promise<void>;
  shutdownWait?: Promise<void>;
  onSpawn?: (adapter: Adapter) => void;
  constructor(readonly bus: LocalEventBus) {}
  configureProfile(profile: AccountProfile) { this.profile = profile; }
  async probeCapabilities() { return this.caps; }
  async spawnAgent(options: SpawnAgentOptions) {
    this.options = options;
    this.emit('agent_started', { role: options.role, model: options.model });
    this.onSpawn?.(this);
    await this.spawnWait;
    return { id: options.sessionId!, agentInstanceId: options.sessionId!, runtimeSessionId: `native-${options.sessionId}`, startedAt: new Date().toISOString(), endedAt: null };
  }
  async cancel(sessionId: string) { this.cancelled.push(sessionId); await this.cancelWait; }
  async shutdown() { this.shutdowns += 1; await this.shutdownWait; }
  emit(type: string, data: Record<string, unknown> = {}) {
    assert(this.options);
    this.bus.emit({ id: `event-${Math.random()}`, type, missionId: this.options.missionId, taskId: this.options.taskId,
      agentInstanceId: this.options.sessionId!, timestamp: new Date().toISOString(), ...data } as AgentEvent);
  }
}

function fixture(runtime: RuntimeType = 'codex', store = new Storage().seed()) {
  const profile: AccountProfile = { id: 'account', provider: 'openai', runtimeType: runtime, profileName: 'Test account',
    authStatus: 'connected', configDir: '/fixture-config', supportedModels: [], usageScope: null, createdAt: '', updatedAt: '', profileMode: 'shared_cli' };
  const model: ModelDescriptor = { catalogId: 'catalog-route', runtimeId: runtime, accountProfileId: 'account', providerId: 'openai',
    runtimeModelId: 'provider-model', displayName: 'Test model', supportedRoles: ['researcher'], supportedReasoning: ['low', 'high'],
    inputModalities: ['text'], availability: 'available', source: 'discovered' };
  const adapters: Adapter[] = [];
  let configure: ((adapter: Adapter) => void) | undefined;
  const options: PlanningChatOptions = {
    store,
    runtimeHost: {
      getModelCatalogService: () => ({ resolveModelDescriptor: async (id: string) => id === model.catalogId || id === model.runtimeModelId ? { ...model } : undefined }) as any,
      getAccountProfileManager: () => ({ getProfileById: async (id: string) => id === profile.id ? { ...profile } : undefined }) as any,
    },
    createAdapter: (_runtime, bus) => { const adapter = new Adapter(bus); configure?.(adapter); adapters.push(adapter); return adapter; },
  };
  return { store, options, model, profile, adapters, configure: (callback: (adapter: Adapter) => void) => { configure = callback; }, controller: new PlanningChatController(options) };
}
const input = (id = 'client-1') => ({ id, text: 'Help me plan this feature.', catalogId: 'catalog-route', reasoning: 'high' });
const delay = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let count = 0; count < 100; count += 1) { if (predicate()) return; await delay(2); }
  assert.fail('Timed out waiting for fixture lifecycle');
}
const update = (path: string, content: string) => `\n\`\`\`atris-plan-update\n${JSON.stringify({ path, content })}\n\`\`\``;

// A provider can deliver thousands of events in one pipe read. Never perform a
// full-history rewrite/fsync for every token on the shared HTTP event loop.
{
  const f = fixture();
  try {
    await f.controller.send('w', 'p', input());
    await until(() => Boolean(f.adapters[0]?.options));
    const before = f.store.readMessages('w', 'p').length;
    for (let index = 0; index < 2_000; index += 1) {
      f.adapters[0].emit('text_delta', { content: index % 2 ? 'y' : 'x' });
      f.adapters[0].emit('tool_call_started', { toolName: `Read-${index}` });
    }
    assert(f.store.readMessages('w', 'p').length - before <= 2,
      'Burst streaming must coalesce persistence instead of blocking unrelated API requests with per-event writes');
    const state = f.controller.get('w', 'p');
    assert.equal(state.messages.at(-1)?.content, 'xy'.repeat(1_000));
    assert.equal(state.activity, 'Reading with Read-1999');
    f.adapters[0].emit('task_completed', { result: 'Codex turn completed' });
    assert.equal(f.controller.get('w', 'p').status, 'complete');
    assert.equal(f.controller.get('w', 'p').messages.at(-1)?.content, 'xy'.repeat(1_000));
  } finally { await f.controller.close(); }
}

// Real disk journal + real manual routes on the same HTTP server, under an
// ongoing provider event flood. No external CLI, account or user data is used.
{
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-planning-concurrency-')));
  const store = new PlanningStore(id => id === 'w' ? { id, path: temporary } : undefined);
  store.create('w', { id: 'p', title: 'Concurrency regression' });
  let journalWrites = 0;
  const append = store.appendMessage.bind(store);
  store.appendMessage = (...args) => { journalWrites += 1; return append(...args); };
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT); CREATE TABLE missions (id TEXT PRIMARY KEY, workspace_id TEXT);');
  sqlite.prepare('INSERT INTO workspaces VALUES (?, ?)').run('w', temporary);
  const f = fixture();
  const app = express(); app.use(express.json());
  const controller = installPlanningChatRoutes(app, { ...f.options, store });
  const manual = installManualConversations(app, sqlite, f.options.runtimeHost as any, temporary);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let streaming: ReturnType<typeof setInterval> | undefined;
  let emitted = 0;
  const request = (route: string, method = 'GET', body?: unknown) => fetch(`${origin}/api${route}`, {
    method, signal: AbortSignal.timeout(3_000), headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    await controller.send('w', 'p', input());
    await until(() => Boolean(f.adapters[0]?.options));
    streaming = setInterval(() => {
      if (emitted >= 10_000) return;
      for (let index = 0; index < 100; index += 1) {
        f.adapters[0].emit('text_delta', { content: emitted % 2 ? 'y' : 'x' });
        f.adapters[0].emit('tool_call_completed', { toolName: 'Read' });
        emitted += 1;
      }
    }, 5);
    await until(() => emitted > 0);
    for (let index = 0; index < 3; index += 1) {
      const id = randomUUID(); const agentId = randomUUID();
      assert.equal((await request('/manual/conversations', 'POST', { id, workspaceId: 'w' })).status, 200);
      assert.equal((await request(`/manual/conversations/${id}/agents`, 'POST', { id: agentId, catalogId: 'catalog-route' })).status, 200);
      const listed = await request('/manual/conversations?workspaceId=w');
      assert.equal(listed.status, 200);
      assert((await listed.json()).some((item: any) => item.id === id && item.agents.some((agent: any) => agent.id === agentId)));
      assert.equal((await request(`/manual/agents/${agentId}/messages`)).status, 200);
      assert.equal((await request(`/manual/agents/${agentId}`, 'DELETE')).status, 204);
      assert.equal((await request(`/manual/conversations/${id}`, 'DELETE')).status, 204);
    }
    await delay(180); // Exercise scheduled persistence without a chat poll/finish.
    assert(store.readMessages('w', 'p').some(record => record.planningChat?.kind === 'delta'));
    clearInterval(streaming); streaming = undefined;
    assert(emitted >= 100);
    assert(journalWrites < emitted / 10, 'Disk writes must scale with flush windows, not provider event count');
    f.adapters[0].emit('task_completed', { result: 'Codex turn completed' });
    const final = controller.get('w', 'p');
    assert.equal(final.status, 'complete');
    assert.equal(final.messages.at(-1)?.content, 'xy'.repeat(emitted / 2));
    assert.equal(new PlanningChatController({ ...f.options, store }).get('w', 'p').messages.at(-1)?.content, 'xy'.repeat(emitted / 2));
    console.log(`Planning/manual concurrency: ${emitted} text + ${emitted} activity events, ${journalWrites} journal writes; manual create/list/read/delete passed.`);
  } finally {
    if (streaming) clearInterval(streaming);
    await controller.close(); await manual.codexSessions.closeAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    sqlite.close(); fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Real HTTP acceptance, private adapter hooks during spawn, polling and explicit JSON writes.
{
  const f = fixture();
  f.configure(adapter => { adapter.onSpawn = a => a.emit('text_delta', { content: 'What is your primary goal?' }); });
  const app = express(); app.use(express.json());
  const controller = installPlanningChatRoutes(app, f.options);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/planning/w/plans/p/chat`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const response = await post('/messages', input());
    assert.equal(response.status, 202);
    const accepted = await response.json() as PlanningChatState;
    assert.equal(accepted.status, 'running');
    assert.equal(accepted.messages.filter(message => message.role === 'user').length, 1);
    await until(() => Boolean(f.adapters[0]?.options));
    const adapter = f.adapters[0];
    const options = adapter.options!;
    assert.equal(options.role, 'researcher'); assert.equal(options.accessMode, 'workspace-write');
    assert.equal(options.enableCoordinationMcp, false); assert.equal(options.providerSessionId, undefined);
    assert.equal(options.model, 'provider-model'); assert.equal(options.reasoningLevel, 'high'); assert.equal(options.profileId, 'account');
    assert.match(options.sessionId!, /^planning-/); assert.match(options.missionId, /^planning-only-/); assert.match(options.taskId, /^planning-turn-/);
    assert.equal(options.env?.CODEX_HOME, '/fixture-config');
    assert.match(options.prompt, /Plan for w\/p/); assert.match(options.prompt, /Research for w\/p/);
    const streaming = await (await fetch(base)).json() as PlanningChatState;
    assert.equal(streaming.status, 'running');
    assert.equal(streaming.messages.at(-1)?.content, 'What is your primary goal?');
    assert.equal(streaming.messages.at(-1)?.partial, true);
    const duplicate = await post('/messages', input());
    assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).turnId, accepted.turnId);
    assert.equal(f.adapters.length, 1);
    assert.equal((await post('/messages', input('another-client'))).status, 409);
    assert.equal((await post('/messages', { ...input(), text: 'Different input' })).status, 409);
    assert.equal((await post('/stop', { turnId: 'stale-turn' })).status, 409);
    adapter.emit('tool_call_started', { toolName: 'Read' });
    assert.equal((await (await fetch(base)).json()).activity, 'Reading with Read');
    adapter.emit('task_completed', { result: 'Here is the plan.' + update('plan.md', '# Agreed plan') + update('research/new.md', '# Sources') });
    const complete = await (await fetch(base)).json() as PlanningChatState;
    assert.equal(complete.status, 'complete'); assert(complete.revision > streaming.revision);
    assert.equal(f.store.readDocument('w', 'p', 'plan.md').content, '# Agreed plan');
    assert.equal(f.store.readDocument('w', 'p', 'research/new.md').content, '# Sources');
    assert.deepEqual(complete.proposals.map(proposal => proposal.status), ['applied', 'applied']);
    assert.equal((await post(`/updates/${complete.proposals[0].id}/apply`, {})).status, 200, 'An applied proposal retry is idempotent');
    await post('/messages', input());
    assert.equal(f.adapters.length, 1, 'Completed client ID retry never creates a second turn');
    adapter.emit('task_completed', { result: update('plan.md', 'late overwrite') });
    assert.equal(f.store.readDocument('w', 'p', 'plan.md').content, '# Agreed plan');
  } finally {
    await controller.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

// Cancellation fences completion even while spawn itself is unresolved; a new turn can run independently.
{
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.configure(adapter => { adapter.spawnWait = wait; });
  const first = await f.controller.send('w', 'p', input());
  await until(() => Boolean(f.adapters[0]?.options));
  const old = f.adapters[0];
  assert.equal(f.controller.stop('w', 'p', first.turnId!).status, 'cancelled');
  old.emit('task_completed', { result: update('plan.md', 'Must not write') });
  assert.equal(f.store.writes, 0);
  f.configure(() => undefined);
  const second = await f.controller.send('w', 'p', input('client-2'));
  await until(() => Boolean(f.adapters[1]?.options));
  assert.notEqual(second.turnId, first.turnId);
  release(); await delay();
  assert(old.cancelled.length >= 2, 'Late spawn is cancelled again after resolving');
  assert.equal(old.bus.listenerCount(), 0);
  old.emit('text_delta', { content: 'late text' });
  old.emit('task_completed', { result: update('plan.md', 'Must not write either') });
  assert.equal(f.controller.get('w', 'p').turnId, second.turnId);
  f.adapters[1].emit('task_completed', { result: 'Which users should we prioritize?' });
  assert.equal(f.controller.get('w', 'p').status, 'complete');
  assert.equal(f.store.writes, 0, 'Conversational Markdown is never an implicit document replacement');
  await f.controller.close();
}

// Duplicate concurrent POST acceptance is serialized, and stop before launch incurs no provider work.
{
  const f = fixture();
  const [first, retry] = await Promise.all([f.controller.send('w', 'p', input()), f.controller.send('w', 'p', input())]);
  assert.equal(first.turnId, retry.turnId);
  assert.equal(f.controller.get('w', 'p').messages.filter(message => message.role === 'user').length, 1);
  f.controller.stop('w', 'p', first.turnId!);
  await delay(5);
  assert.equal(f.adapters.length, 0);
  await f.controller.close();
  await assert.rejects(f.controller.send('w', 'p', input('shutdown')), /shutting down/);
}

// Shutdown drains removed turns, late spawn, deferred cancellation and deferred shutdown.
for (const end of ['stop', 'complete', 'close'] as const) {
  const f = fixture();
  const spawn = deferred(); const cancel = deferred(); const shutdown = deferred();
  f.configure(adapter => { adapter.spawnWait = spawn.promise; adapter.cancelWait = cancel.promise; adapter.shutdownWait = shutdown.promise; });
  await f.controller.send('w', 'p', input());
  await until(() => Boolean(f.adapters[0]?.options));
  const adapter = f.adapters[0];
  if (end === 'stop') f.controller.stop('w', 'p');
  if (end === 'complete') adapter.emit('task_completed', { result: 'Finished before spawn resolved.' });
  let closed = false;
  const closing = f.controller.close().then(() => { closed = true; });
  assert.equal(f.controller.close(), f.controller.close(), 'Concurrent shutdown callers share the same drain');
  await delay(); assert.equal(closed, false);
  if (end === 'complete') {
    // Even when cleanup finishes first, an outstanding spawn still holds close open.
    cancel.resolve(); shutdown.resolve();
    await until(() => adapter.shutdowns === 1);
    await delay(); assert.equal(closed, false, 'Removed completed turn still owns an in-flight spawn');
    spawn.resolve();
  } else {
    spawn.resolve();
    await until(() => adapter.cancelled.length >= 2);
    await delay(); assert.equal(closed, false, 'Cancellation must settle before close');
    cancel.resolve();
    await until(() => adapter.shutdowns >= 2);
    await delay(); assert.equal(closed, false, 'Adapter shutdown must settle before close');
    shutdown.resolve();
  }
  await closing;
  assert.equal(adapter.shutdowns, 2, 'Late-spawn cleanup is drained as well as the initial cleanup');
  const journal = f.store.readMessages('w', 'p');
  f.store.appendMessage = () => { assert.fail('Late write after sqlite-equivalent shutdown'); };
  adapter.emit('text_delta', { content: 'late' });
  adapter.emit('task_completed', { result: update('plan.md', 'late overwrite') });
  await delay();
  assert.deepEqual(f.store.readMessages('w', 'p'), journal);
  assert.equal(f.store.writes, 0);
  assert.equal(adapter.bus.listenerCount(), 0);
  assert.throws(() => f.controller.get('w', 'p'), /shutting down/);
}

// Pending/queued account validation is included in close and cannot touch storage afterward.
{
  const f = fixture(); const validation = deferred();
  let validating = false;
  f.options.runtimeHost.getModelCatalogService = () => ({ resolveModelDescriptor: async () => {
    validating = true; await validation.promise; return f.model;
  } }) as any;
  const first = f.controller.send('w', 'p', input());
  const queued = f.controller.send('w', 'p', input('queued'));
  const rejected = Promise.all([assert.rejects(first, /shutting down/), assert.rejects(queued, /shutting down/)]);
  await until(() => validating);
  let closed = false;
  const closing = f.controller.close().then(() => { closed = true; });
  await delay(); assert.equal(closed, false);
  validation.resolve();
  await rejected; await closing;
  assert.equal(f.store.readMessages('w', 'p').length, 0);
  assert.equal(f.adapters.length, 0);
}

// CAS conflicts preserve both the user edit and durable proposal; explicit Apply is itself CAS-protected.
{
  const f = fixture();
  await f.controller.send('w', 'p', input());
  await until(() => Boolean(f.adapters[0]?.options));
  f.store.writeDocument('w', 'p', { path: 'plan.md', content: '# User edit', expectedRevision: 'initial' });
  f.adapters[0].emit('task_completed', { result: 'Proposed refinement.' + update('plan.md', '# AI proposal') });
  let state = f.controller.get('w', 'p');
  assert.equal(state.status, 'complete'); assert.equal(state.proposals[0].status, 'conflict');
  assert.equal(state.proposals[0].baseRevision, 'initial');
  assert.match(state.messages.at(-1)!.content, /current document is preserved/);
  assert.equal(f.store.readDocument('w', 'p', 'plan.md').content, '# User edit');
  const restarted = new PlanningChatController(f.options);
  const proposalId = state.proposals[0].id;
  assert.throws(() => restarted.apply('w', 'p', proposalId, undefined), /expectedRevision/);
  assert.throws(() => restarted.apply('w', 'p', proposalId, 'initial'), (error: any) => error.status === 409 && error.state.proposals[0].content === '# AI proposal');
  assert.throws(() => restarted.apply('w', 'other-plan', proposalId, 'initial'), /not found/);
  const revision = f.store.readDocument('w', 'p', 'plan.md').revision;
  state = restarted.apply('w', 'p', proposalId, revision);
  assert.equal(state.proposals[0].status, 'applied');
  assert.equal(f.store.readDocument('w', 'p', 'plan.md').content, '# AI proposal');
  assert.equal(f.store.writes, 2);
  restarted.apply('w', 'p', proposalId, revision);
  assert.equal(f.store.writes, 2);
  await f.controller.close(); await restarted.close();
}

// Crash recovery uses only durable journal data, including partial answer and client ID.
{
  const f = fixture();
  const running = await f.controller.send('w', 'p', input());
  await until(() => Boolean(f.adapters[0]?.options));
  f.adapters[0].emit('text_delta', { content: 'Partial answer before restart' });
  await until(() => f.store.readMessages('w', 'p').some(record => record.text === 'Partial answer before restart'));
  const diskCopy = new Storage().seed();
  diskCopy.journals = structuredClone(f.store.journals);
  const restartedFixture = fixture('codex', diskCopy);
  const recovered = restartedFixture.controller.get('w', 'p');
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.turnId, running.turnId);
  assert.match(recovered.error!, /restarted/); assert.match(recovered.messages.at(-1)!.content, /before restart/);
  assert.equal((await restartedFixture.controller.send('w', 'p', input())).status, 'interrupted');
  assert.equal(restartedFixture.adapters.length, 0, 'An idempotent retry after restart cannot silently replay a paid provider turn');
  const resumed = await restartedFixture.controller.send('w', 'p', input('after-restart'));
  assert.equal(resumed.status, 'running');
  await until(() => Boolean(restartedFixture.adapters[0]?.options));
  assert.match(restartedFixture.adapters[0].options!.prompt, /Partial answer before restart/);
  await f.controller.close(); await restartedFixture.controller.close();
}

// Scheduled flush failures fence the turn rather than escaping a timer callback
// and terminating the shared gateway. Stop also drains the last buffered text.
{
  const f = fixture();
  const append = f.store.appendMessage.bind(f.store);
  let failed = false;
  f.store.appendMessage = (w, p, record) => {
    if (!failed && record.planningChat?.kind === 'delta') { failed = true; throw new Error('Disk write failed'); }
    append(w, p, record);
  };
  try {
    await f.controller.send('w', 'p', input());
    await until(() => Boolean(f.adapters[0]?.options));
    f.adapters[0].emit('text_delta', { content: 'Buffered answer' });
    await until(() => failed);
    const state = f.controller.get('w', 'p');
    assert.equal(state.status, 'failed'); assert.match(state.error!, /Disk write failed/);
    assert(f.adapters[0].cancelled.length);
    await f.controller.send('w', 'p', input('after-disk-failure'));
    await until(() => Boolean(f.adapters[1]?.options));
    f.adapters[1].emit('text_delta', { content: 'Keep on stop' });
    f.controller.stop('w', 'p');
    const reopened = new PlanningChatController(f.options);
    assert.equal(reopened.get('w', 'p').status, 'cancelled');
    assert.equal(reopened.get('w', 'p').messages.at(-1)?.content, 'Keep on stop');
    await reopened.close();
  } finally { await f.controller.close(); }
}

// Concurrent plan/workspace turns have disjoint sessions, prompts, private event buses and document writes.
{
  const f = fixture();
  await Promise.all([f.controller.send('w', 'p', input()), f.controller.send('w', 'other-plan', input()), f.controller.send('other-workspace', 'p', input())]);
  await until(() => f.adapters.filter(adapter => adapter.options).length === 3);
  assert.equal(new Set(f.adapters.map(adapter => adapter.options!.sessionId)).size, 3);
  assert.equal(new Set(f.adapters.map(adapter => adapter.bus)).size, 3);
  const second = f.adapters.find(adapter => adapter.options!.prompt.includes('Plan for w/other-plan'))!;
  second.emit('task_completed', { result: update('plan.md', '# Only second plan') });
  assert.equal(f.controller.get('w', 'other-plan').status, 'complete');
  assert.equal(f.controller.get('w', 'p').status, 'running');
  assert.equal(f.controller.get('other-workspace', 'p').status, 'running');
  assert.equal(f.store.readDocument('w', 'p', 'plan.md').revision, 'initial');
  assert.equal(f.store.readDocument('other-workspace', 'p', 'plan.md').revision, 'initial');
  await f.controller.close();
}

// Verified catalog/account/reasoning selection and actual provider capability failures are truthful.
{
  for (const roles of [['RESEARCHER'], ['Builder', 'Researcher'], ['researcher']]) {
    const f = fixture(); f.profile.allowedRoles = roles;
    await f.controller.send('w', 'p', input());
    await until(() => Boolean(f.adapters[0]?.options));
    assert.equal(f.adapters[0].options!.role, 'researcher');
    await f.controller.close();
  }
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.model.source = 'cached'; },
    (f: ReturnType<typeof fixture>) => { f.model.availability = 'unavailable'; },
    (f: ReturnType<typeof fixture>) => { f.profile.authStatus = 'login_required'; },
    (f: ReturnType<typeof fixture>) => { f.profile.runtimeType = 'opencode'; },
    (f: ReturnType<typeof fixture>) => { f.model.supportedReasoning = ['low']; },
    (f: ReturnType<typeof fixture>) => { f.profile.allowedRoles = ['builder']; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.controller.send('w', 'p', input()));
    assert.equal(f.store.readMessages('w', 'p').length, 0); assert.equal(f.adapters.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.controller.send('w', 'p', { ...input(), catalogId: 'provider-model' }), /verified/);
  await assert.rejects(f.controller.send('w', 'p', { ...input(), catalogId: 'unknown' }), /verified/);
  await assert.rejects(f.controller.send('w', 'p', { ...input(), text: '' }), /message/);
  for (const runtime of ['codex', 'claude_code', 'opencode', 'antigravity'] as const) {
    const provider = fixture(runtime);
    provider.configure(adapter => { adapter.caps.structuredEventStreaming = false; });
    await provider.controller.send('w', 'p', input());
    await until(() => provider.controller.get('w', 'p').status === 'failed');
    assert.match(provider.controller.get('w', 'p').error!, /stream and cancel/);
    assert.equal(provider.adapters[0].options, undefined, 'Capability rejection precedes provider launch');
    await provider.controller.close();
    const supported = fixture(runtime);
    await supported.controller.send('w', 'p', input());
    await until(() => Boolean(supported.adapters[0]?.options));
    supported.adapters[0].emit('task_completed', { result: 'What are the requirements?' });
    assert.equal(supported.controller.get('w', 'p').status, 'complete');
    await supported.controller.close();
  }
}

// Exercise the adapters' real output semantics: cumulative snapshots and OpenCode's completion marker.
{
  const f = fixture('opencode');
  await f.controller.send('w', 'p', input());
  await until(() => Boolean(f.adapters[0]?.options));
  const adapter = f.adapters[0];
  const answer = 'What would success look like?' + update('research/exploration.md', '# Findings');
  adapter.emit('text_delta', { content: answer.slice(0, 10) });
  adapter.emit('text_delta', { content: answer.slice(0, 20) });
  adapter.emit('text_delta', { content: answer });
  adapter.emit('task_completed', { result: 'OpenCode session completed' });
  const state = f.controller.get('w', 'p');
  assert.equal(state.status, 'complete');
  assert.equal(state.messages.find(message => message.role === 'assistant')!.content, answer);
  assert.equal(f.store.readDocument('w', 'p', 'research/exploration.md').content, '# Findings');
  await f.controller.close();
  const empty = fixture('opencode');
  await empty.controller.send('w', 'p', input()); await until(() => Boolean(empty.adapters[0]?.options));
  empty.adapters[0].emit('task_completed', { result: 'OpenCode session completed' });
  assert.equal(empty.controller.get('w', 'p').status, 'failed', 'Lifecycle markers are not fabricated assistant answers');
  await empty.controller.close();
  const agy = fixture('antigravity');
  agy.configure(adapter => { adapter.caps.reasoningControl = false; });
  await agy.controller.send('w', 'p', input()); await until(() => Boolean(agy.adapters[0]?.options));
  assert.equal(agy.adapters[0].options!.reasoningLevel, 'high', 'Verified Antigravity model routes can encode reasoning without --effort');
  await agy.controller.close();
}

// Bound portable prompts despite a large plan, research note and conversation history.
{
  const f = fixture();
  let fullPrompt = '';
  f.options.store.prepareChatPrompt = (_w, _p, _turn, prompt) => { fullPrompt = prompt; return path.join(process.cwd(), 'fixture-task.md'); };
  f.store.documents.set('w:p:plan.md', { content: '# Large plan\n' + 'p'.repeat(200_000), revision: 'large-plan' });
  f.store.documents.set('w:p:research/context.md', { content: '# Large research\n' + 'r'.repeat(200_000), revision: 'large-research' });
  for (let index = 0; index < 30; index += 1) {
    f.store.appendMessage('w', 'p', { id: `history-${index}`, role: 'user', text: `history-${index} ` + 'h'.repeat(16_000),
      createdAt: new Date().toISOString(), planningChat: { version: 1, kind: 'start', turnId: `old-${index}`, clientMessageId: `old-client-${index}`, catalogId: 'catalog-route', sessionId: 'old' } });
    f.store.appendMessage('w', 'p', { id: `done-${index}`, role: 'system', text: '', createdAt: new Date().toISOString(),
      planningChat: { version: 1, kind: 'state', turnId: `old-${index}`, status: 'complete' } });
  }
  await f.controller.send('w', 'p', input()); await until(() => Boolean(f.adapters[0]?.options));
  const prompt = f.adapters[0].options!.prompt;
  assert(prompt.length < 2_000); assert(fullPrompt.length < 80_000); assert.match(fullPrompt, /"truncated":true/);
  assert(!fullPrompt.includes('history-0 '), 'Old history is omitted from the task input');
  assert(fullPrompt.includes('history-29 '));
  await f.controller.close();
}

// Injected stores must opt into task files for large inputs; never silently truncate argv.
{
  const f = fixture();
  await assert.rejects(f.controller.send('w', 'p', { ...input(), text: 'u'.repeat(16_000) }), /file-backed planning prompt storage/);
  assert.equal(f.store.readMessages('w', 'p').length, 0);
  assert.equal(f.adapters.length, 0);
  await f.controller.close();
}

// Activity extends the inactivity deadline, but a separate ceiling still bounds a turn.
{
  const f = fixture('antigravity'); f.options.timeoutMs = 100; f.options.maxDurationMs = 2_000;
  try {
    await f.controller.send('w', 'p', input()); await until(() => Boolean(f.adapters[0]?.options));
    for (let index = 0; index < 5; index++) {
      await delay(35); f.adapters[0].emit('text_delta', { content: 'x' });
      assert.equal(f.controller.get('w', 'p').status, 'running');
    }
    await delay(120);
    const stopped = f.controller.get('w', 'p');
    assert.equal(stopped.status, 'failed'); assert.match(stopped.error!, /Last activity: Writing response/);
    assert.equal(stopped.messages.at(-1)?.content, 'xxxxx');
  } finally { await f.controller.close(); }
  const bounded = fixture(); bounded.options.timeoutMs = 1_000; bounded.options.maxDurationMs = 40;
  try {
    await bounded.controller.send('w', 'p', input());
    await until(() => bounded.controller.get('w', 'p').status === 'failed');
    assert.match(bounded.controller.get('w', 'p').error!, /maximum duration/);
  } finally { await bounded.controller.close(); }
}

// AI board output uses the real store's validator, durable proposals and revision fence.
{
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ai-board-')));
  const store = new PlanningStore(id => id === 'w' ? { id, path: temporary } : undefined);
  store.create('w', { id: 'p', title: 'Dynamic workspace' });
  const f = fixture('antigravity');
  const controller = new PlanningChatController({ ...f.options, store });
  const board = { schemaVersion: 1, planId: 'p', updatedAt: '', summary: 'A focused project page.', appearance: { font: 'editorial', accent: 'sage', density: 'comfortable' }, sections: [{ id: 'discovery', title: 'Discovery', kind: 'research', body: 'Project-specific context', items: [{ id: 'validate', title: 'Validate first-run flow', status: 'idea', body: 'Acceptance: one useful result.' }] }] };
  try {
    await controller.send('w', 'p', input()); await until(() => Boolean(f.adapters[0]?.options));
    const filename = JSON.parse(f.adapters[0].options!.prompt.split('\n')[0].split('JSON quoted): ')[1]);
    const task = fs.readFileSync(filename, 'utf8');
    assert.match(task, /create\/update its board automatically/); assert.match(task, /"path":"board.json"/);
    assert.match(task, /appearance/); assert.match(task, /preserving unrelated content/);
    f.adapters[0].emit('task_completed', { result: update('plan.md', '# Dynamic plan\n\n## Discovery\nValidate first-run flow.') + update('board.json', JSON.stringify(board)) });
    let state = controller.get('w', 'p');
    assert.equal(state.status, 'complete'); assert(state.proposals.every(item => item.status === 'applied'));
    assert.equal(store.readBoard('w', 'p')!.board.sections[0].items![0].title, 'Validate first-run flow');
    const first = store.readBoard('w', 'p')!;
    assert.deepEqual(first.board.appearance, board.appearance, 'AI appearance updates use the same persisted board protocol');
    assert.equal(first.board.summary, board.summary);
    await controller.send('w', 'p', input('board-conflict')); await until(() => Boolean(f.adapters[1]?.options));
    store.writeBoard('w', 'p', { board: { ...first.board, sections: [...first.board.sections, { id: 'manual', title: 'My own note', kind: 'note', body: 'Keep this.' }] }, expectedRevision: first.revision });
    f.adapters[1].emit('task_completed', { result: update('board.json', JSON.stringify({ ...board, sections: [{ ...board.sections[0], title: 'Revised discovery' }] })) });
    state = controller.get('w', 'p');
    const proposal = state.proposals.find(item => item.turnId === state.turnId)!;
    assert.equal(proposal.status, 'conflict'); assert.equal(store.readBoard('w', 'p')!.board.sections[1].title, 'My own note');
    controller.apply('w', 'p', proposal.id, store.readBoard('w', 'p')!.revision);
    assert.equal(store.readBoard('w', 'p')!.board.sections[0].title, 'Revised discovery');
    const document = store.readDocument('w', 'p', 'plan.md');
    const preserved = store.readBoard('w', 'p')!;
    await controller.send('w', 'p', input('invalid-board')); await until(() => Boolean(f.adapters[2]?.options));
    f.adapters[2].emit('task_completed', { result: update('plan.md', '# Must not be written') + update('board.json', JSON.stringify({ ...board, planId: 'another-plan' })) });
    assert.equal(controller.get('w', 'p').status, 'failed');
    assert.deepEqual(store.readDocument('w', 'p', 'plan.md'), document); assert.deepEqual(store.readBoard('w', 'p'), preserved);
    const restarted = new PlanningChatController({ ...f.options, store: new PlanningStore(id => id === 'w' ? { id, path: temporary } : undefined) });
    assert(restarted.get('w', 'p').proposals.some(item => item.id === proposal.id && item.status === 'applied'));
    await restarted.close();
  } finally { await controller.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
}

// Native approvals/questions are visibly rejected by cancelling the turn; no hidden waiting or auto-approval.
{
  for (const type of ['approval_requested', 'question_asked']) {
    const f = fixture();
    await f.controller.send('w', 'p', input());
    await until(() => Boolean(f.adapters[0]?.options));
    f.adapters[0].emit(type, { approvalId: 'approval', approvalType: 'tool', question: 'May I write?', requestId: 'question', questions: [] });
    const state = f.controller.get('w', 'p');
    assert.equal(state.status, 'failed'); assert.match(state.error!, /native/i);
    assert.match(state.messages.at(-1)!.content, /provider/i);
    assert(f.adapters[0].cancelled.length > 0);
    f.adapters[0].emit('task_completed', { result: update('plan.md', 'late') });
    assert.equal(f.store.writes, 0); await f.controller.close();
  }
  const f = fixture(); f.options.timeoutMs = 10;
  await f.controller.send('w', 'p', input());
  await until(() => f.controller.get('w', 'p').status === 'failed');
  assert.match(f.controller.get('w', 'p').error!, /timed out/);
  assert(f.adapters[0].cancelled.length > 0); await f.controller.close();
}

// Validate all structured blocks before writing any document; ordinary Markdown is inert.
{
  assert.deepEqual(extractPlanningUpdates('# Proposed plan\nA normal conversational answer.'), []);
  assert.deepEqual(extractPlanningUpdates('```json\n{"path":"plan.md","content":"inert"}\n```'), []);
  for (const output of [update('../outside.md', 'bad'), update('research/../../outside.md', 'bad'),
    update('plan.json', 'bad'), update('research/con.md', 'bad'), update('plan.md', 'first') + update('plan.md', 'second'),
    update('research/Note.md', 'first') + update('research/note.md', 'second'),
    '```atris-plan-update\nnot json\n```', '```atris-plan-update\n{"path":"plan.md"}',
    '```atris-plan-update\n{"path":"plan.md","content":23}\n```']) assert.throws(() => extractPlanningUpdates(output));
  const f = fixture();
  await f.controller.send('w', 'p', input()); await until(() => Boolean(f.adapters[0]?.options));
  f.adapters[0].emit('task_completed', { result: update('plan.md', 'valid first') + update('../outside.md', 'invalid second') });
  assert.equal(f.controller.get('w', 'p').status, 'failed'); assert.equal(f.store.writes, 0);
  await f.controller.close();
}

// Contract smoke test with the integrating agent's real file store, still using only a fake provider.
{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-planning-chat-'));
  const resolveWorkspace = (id: string) => id === 'w' ? { id, path: temporary } : undefined;
  const store: PlanningChatStorage = new PlanningStore(resolveWorkspace);
  (store as PlanningStore).create('w', { id: 'p', title: 'Portable planning' });
  const f = fixture();
  const controller = new PlanningChatController({ ...f.options, store });
  try {
    const initial = store.readDocument('w', 'p', 'plan.md');
    const accepted = await controller.send('w', 'p', input());
    await until(() => Boolean(f.adapters[0]?.options));
    const wrapper = f.adapters[0].options!.prompt;
    const filename = JSON.parse(wrapper.split('\n')[0].split('JSON quoted): ')[1]);
    assert.match(fs.readFileSync(filename, 'utf8'), /sourcePath/);
    assert(wrapper.length < 2_000);
    f.adapters[0].emit('text_delta', { content: 'Persist this partial response.' });
    await controller.close();
    const reopenedStore: PlanningChatStorage = new PlanningStore(resolveWorkspace);
    const reopened = new PlanningChatController({ ...f.options, store: reopenedStore });
    assert.equal(reopened.get('w', 'p').status, 'interrupted');
    assert.equal(reopened.get('w', 'p').turnId, accepted.turnId);
    assert.equal(reopened.get('w', 'p').messages.at(-1)!.content, 'Persist this partial response.');
    assert.equal((await reopened.send('w', 'p', input())).turnId, accepted.turnId);
    await reopened.send('w', 'p', input('persisted-retry'));
    await until(() => Boolean(f.adapters[1]?.options));
    reopenedStore.writeDocument('w', 'p', { path: 'plan.md', content: '# External editor', expectedRevision: initial.revision });
    f.adapters[1].emit('task_completed', { result: update('plan.md', '# Preserved proposal') });
    const state = reopened.get('w', 'p');
    assert.equal(state.status, 'complete'); assert.equal(state.proposals[0].status, 'conflict');
    reopened.apply('w', 'p', state.proposals[0].id, reopenedStore.readDocument('w', 'p', 'plan.md').revision);
    assert.equal(reopenedStore.readDocument('w', 'p', 'plan.md').content, '# Preserved proposal');
    assert(reopenedStore.readMessages('w', 'p').some(record => record.planningChat?.kind === 'start'));
    await reopened.close();
  } finally {
    await controller.close(); fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// All providers receive short argv while the real store preserves the entire bounded task.
for (const runtime of ['codex', 'claude_code', 'opencode', 'antigravity'] as const) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-chat-task-file-'));
  const store = new PlanningStore(id => id === 'w' ? { id, path: temporary } : undefined);
  const plan = '# Large plan\n' + 'p'.repeat(23_000);
  store.create('w', { id: 'p', title: 'Task file', content: plan });
  const research = '# Research\n' + 'r'.repeat(7_000);
  store.writeDocument('w', 'p', { path: 'research/context.md', content: research, expectedRevision: null });
  store.appendMessage('w', 'p', { id: 'history', role: 'user', text: 'h'.repeat(8_000), createdAt: new Date().toISOString(),
    planningChat: { version: 1, kind: 'start', turnId: 'prior', clientMessageId: 'prior', catalogId: 'catalog-route' } });
  store.appendMessage('w', 'p', { id: 'history-end', role: 'system', text: '', createdAt: new Date().toISOString(),
    planningChat: { version: 1, kind: 'state', turnId: 'prior', status: 'complete' } });
  const f = fixture(runtime);
  const controller = new PlanningChatController({ ...f.options, store });
  const spawn = deferred(); const cancel = deferred();
  f.configure(adapter => { adapter.spawnWait = spawn.promise; adapter.cancelWait = cancel.promise; });
  try {
    const text = 'User request: ' + 'ü🧭\\\"'.repeat(2_000) + ' FULL REQUEST END';
    const accepted = await controller.send('w', 'p', { ...input(), text });
    await until(() => Boolean(f.adapters[0]?.options));
    const wrapper = f.adapters[0].options!.prompt;
    assert(wrapper.length < 2_000, `${runtime}: argv stays bounded`);
    assert.match(wrapper, /planning/); assert.match(wrapper, /The service owns plan writes/);
    const filename = JSON.parse(wrapper.split('\n')[0].split('JSON quoted): ')[1]);
    assert(path.isAbsolute(filename)); assert.equal(fs.realpathSync(filename), filename);
    assert.equal(path.basename(filename), `${accepted.turnId}.md`);
    const task = fs.readFileSync(filename, 'utf8');
    assert(task.length > 45_000);
    const documents = task.split('Current documents (JSON lines):\n')[1].split('\n\nRecent conversation')[0].split('\n').map(line => JSON.parse(line));
    assert.equal(documents.find(document => document.path === 'plan.md').content, plan);
    assert.equal(documents.find(document => document.path === 'research/context.md').content, research);
    assert.equal(JSON.parse(task.split('Current user message (JSON string):\n')[1]), text, 'Full original user request lives on disk, without truncation');
    assert(task.includes('h'.repeat(8_000)), 'Full bounded history lives on disk');
    const files = store.listFiles('w', 'p');
    assert(!files.some(file => file.path.startsWith('chat/')));
    assert.throws(() => store.resolveFile('w', 'p', `chat/requests/${accepted.turnId}.md`));
    const execution = store.createExecution('w', 'p', { id: 'snapshot', target: 'manual', paths: files.map(file => file.path) });
    assert(!fs.existsSync(path.join(execution.snapshotPath, 'chat')));
    let released = false;
    const release = store.releaseChatPrompt.bind(store);
    store.releaseChatPrompt = (...args) => { released = true; release(...args); };
    controller.stop('w', 'p');
    const closing = controller.close();
    await delay(); assert.equal(released, false);
    spawn.resolve(); cancel.resolve();
    await closing;
    assert.equal(released, true, 'Task file is unpinned only after late spawn/cancel settle');
    assert.equal(fs.readFileSync(filename, 'utf8'), task, 'Current input retained for recovery after close');
  } finally {
    spawn.resolve(); cancel.resolve();
    await controller.close(); fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// The exact tab HTTP contract and entitlement allowlist: only reads bypass Hub auth.
{
  const f = fixture(); const app = express(); app.use(express.json());
  const controller = installPlanningChatRoutes(app, f.options);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const root = '/api/planning/w/plans/p/chat/conversations';
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${root}`;
  const id = '40000000-0000-4000-8000-000000000001';
  const call = (suffix = '', method = 'GET', body?: unknown) => fetch(base + suffix, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.deepEqual(await (await call()).json(), []);
    const created = await call('', 'POST', { id, catalogId: 'catalog-route', reasoning: 'high' });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).creationFingerprint, undefined, 'Internal idempotency metadata is not public config');
    assert.equal((await call(`/${id}`, 'PATCH', { title: 'Renamed tab' })).status, 200);
    assert.equal((await (await call(`/${id}`)).json()).conversation.title, 'Renamed tab');
    assert.equal((await call(`/${id}/messages`, 'POST', input())).status, 202);
    assert.equal((await call(`/${id}`, 'PATCH', { closed: true })).status, 409);
    assert.equal((await call(`/${id}/approvals/stale/reply`, 'POST', { decision: 'deny', turnId: 'old' })).status, 409);
    assert.equal((await call(`/${id}/stop`, 'POST', {})).status, 200);
    assert.equal((await call(`/${id}/updates/missing/apply`, 'POST', { expectedRevision: null })).status, 404);
    assert.equal((await call(`/${id}`, 'PATCH', { closed: true })).status, 200);
    assert.equal((await call(`/${id}`, 'PATCH', { closed: false })).status, 200);
    for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
      for (const suffix of ['', `/${id}`, `/${id}/messages`, `/${id}/stop`, `/${id}/approvals/x/reply`]) {
        const allowed = isLocalDataRequest({ method, originalUrl: root + suffix, headers: { 'x-atris-runtime-token': 'local-fixture' } } as any, 'local-fixture');
        assert.equal(allowed, ['GET', 'HEAD'].includes(method) && ['', `/${id}`].includes(suffix));
      }
    }
  } finally { await controller.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

// Same-plan conversations share documents, never histories, locks, proposals, or native sessions.
{
  const f = fixture();
  const a = '10000000-0000-4000-8000-000000000001';
  const b = '10000000-0000-4000-8000-000000000002';
  const create = (id: string) => ({ id, title: 'Independent', catalogId: 'catalog-route', reasoning: 'high' });
  try {
    assert.deepEqual(await f.controller.listConversations('w', 'p'), []);
    const [first, duplicate] = await Promise.all([f.controller.createConversation('w', 'p', create(a)), f.controller.createConversation('w', 'p', create(a))]);
    assert.deepEqual(first, duplicate);
    await assert.rejects(f.controller.createConversation('w', 'p', { ...create(a), title: 'Different' }), /different create/);
    await f.controller.createConversation('w', 'p', create(b));
    assert.throws(() => f.controller.conversation('w', 'other-plan', a), /not found/);
    assert.throws(() => f.controller.conversation('w', 'p', '../../unsafe'), /Invalid/);
    const one = f.controller.conversation('w', 'p', a); const two = f.controller.conversation('w', 'p', b);
    const [turnOne, turnTwo] = await Promise.all([one.send('w', 'p', { ...input(), text: 'Secret first topic' }), two.send('w', 'p', { ...input(), text: 'Unrelated second topic' })]);
    assert.notEqual(turnOne.turnId, turnTwo.turnId);
    await until(() => f.adapters.length === 2 && f.adapters.every(adapter => Boolean(adapter.options)));
    assert(!f.adapters[0].options!.prompt.includes('Unrelated second topic'));
    assert(!f.adapters[1].options!.prompt.includes('Secret first topic'));
    await assert.rejects(f.controller.updateConversation('w', 'p', a, { closed: true }), /Stop the active/);
    await f.controller.updateConversation('w', 'p', a, { codexPermissionMode: 'full-access', fullAccessConfirmed: true });
    assert.equal(one.get('w', 'p').conversation?.codexPermissionMode, 'full-access', 'Preference saves for next turn');
    assert.equal(f.adapters[0].options!.planningControls?.codexPermissionMode, 'read-only');
    f.adapters[0].emit('task_completed', { result: 'First answer' + update('plan.md', '# First proposal') });
    f.adapters[1].emit('task_completed', { result: 'Second answer' + update('plan.md', '# Second proposal') });
    assert.equal(one.get('w', 'p').proposals[0].status, 'applied');
    assert.equal(two.get('w', 'p').proposals[0].status, 'conflict');
    assert.throws(() => one.apply('w', 'p', two.get('w', 'p').proposals[0].id, null), /not found/);
    assert(!two.get('w', 'p').messages.some(message => message.content.includes('Secret first topic')));
    assert.equal(f.controller.get('w', 'p').messages.length, 0, 'Legacy endpoint does not expose new tab histories');
    await f.controller.updateConversation('w', 'p', a, { closed: true });
    assert(one.get('w', 'p').conversation?.closedAt);
    await assert.rejects(one.send('w', 'p', input('closed')), /Reopen/);
    await f.controller.updateConversation('w', 'p', a, { closed: false, title: 'Reopened' });
    assert.equal(one.get('w', 'p').conversation?.closedAt, null);
    await assert.rejects(f.controller.updateConversation('w', 'p', a, { codexPermissionMode: 'full-access' }), /Confirm Full Access/);
    assert.equal((await f.controller.updateConversation('w', 'p', a, { codexPermissionMode: 'ask-for-approval' })).codexPermissionMode, 'ask-for-approval');
    await assert.rejects(f.controller.updateConversation('w', 'p', a, { openCodeAutoApprove: true }), /OpenCode/);
    await f.controller.updateConversation('w', 'p', a, { codexPermissionMode: 'full-access', fullAccessConfirmed: true });
    await one.send('w', 'p', input('full-access'));
    await until(() => Boolean(f.adapters[2]?.options));
    assert.equal(f.adapters[2].options!.planningControls?.codexPermissionMode, 'full-access');
    one.stop('w', 'p'); assert.equal(two.get('w', 'p').status, 'complete');
    f.model.runtimeModelId = 'updated-same-account-model';
    assert.equal((await f.controller.updateConversation('w', 'p', a, { catalogId: 'catalog-route' })).model, 'updated-same-account-model');
    f.profile.runtimeType = 'opencode'; f.model.runtimeId = 'opencode';
    await assert.rejects(f.controller.updateConversation('w', 'p', a, { catalogId: 'catalog-route' }), /independent session/);
    await assert.rejects(one.send('w', 'p', input('provider-change')), /independent session/);
  } finally { await f.controller.close(); }
}

// Real native approval replies: off waits visibly, deny stays native, retries deliver once, stale turns never route to a replacement.
for (const autoApprove of [false, true]) {
  const f = fixture('opencode'); const id = '20000000-0000-4000-8000-000000000001';
  const replies: Array<[string, string]> = [];
  const delivery = deferred();
  f.configure(adapter => {
    (adapter as PlanningChatAdapter).respondToApproval = async (id, decision) => { replies.push([id, decision]); await delivery.promise; };
  });
  try {
    await f.controller.createConversation('w', 'p', { id, catalogId: 'catalog-route', reasoning: 'high' });
    await f.controller.updateConversation('w', 'p', id, { openCodeAutoApprove: autoApprove });
    const engine = f.controller.conversation('w', 'p', id);
    const turn = await engine.send('w', 'p', input());
    await until(() => Boolean(f.adapters[0]?.options));
    f.adapters[0].emit('approval_requested', { approvalId: 'native-permission', toolName: 'read', description: 'Read local directory' });
    if (autoApprove) {
      await until(() => replies.length === 1); assert.deepEqual(replies[0], ['native-permission', 'approved']);
      delivery.resolve(); await delay();
    } else {
      assert.equal(replies.length, 0);
      assert.equal(engine.get('w', 'p').approvals?.[0].id, 'native-permission');
      await assert.rejects(engine.replyApproval('w', 'p', 'native-permission', { decision: 'allow', turnId: 'stale' }), /stale/);
      const first = engine.replyApproval('w', 'p', 'native-permission', { decision: 'deny', turnId: turn.turnId });
      const retry = engine.replyApproval('w', 'p', 'native-permission', { decision: 'deny', turnId: turn.turnId });
      await until(() => replies.length === 1);
      await assert.rejects(engine.replyApproval('w', 'p', 'native-permission', { decision: 'allow', turnId: turn.turnId }), /different decision/);
      delivery.resolve(); await Promise.all([first, retry]);
      assert.deepEqual(replies, [['native-permission', 'rejected']]);
    }
    engine.stop('w', 'p');
    await engine.send('w', 'p', input('replacement'));
    await assert.rejects(engine.replyApproval('w', 'p', 'native-permission', { decision: 'deny', turnId: turn.turnId }), /stale/);
    assert.equal(replies.length, 1);
  } finally { delivery.resolve(); await f.controller.close(); }
}

// Changing the OpenCode approval preference handles real pending requests and disabling it fences future requests.
{
  const f = fixture('opencode'); const id = '50000000-0000-4000-8000-000000000001';
  const replies: Array<[string, string]> = [];
  f.configure(adapter => { (adapter as PlanningChatAdapter).respondToApproval = async (id, decision) => { replies.push([id, decision]); }; });
  try {
    await f.controller.createConversation('w', 'p', { id, catalogId: 'catalog-route', reasoning: 'high' });
    const engine = f.controller.conversation('w', 'p', id);
    const turn = await engine.send('w', 'p', input()); await until(() => Boolean(f.adapters[0]?.options));
    f.adapters[0].emit('approval_requested', { approvalId: 'pending-before-enable', description: 'Read' });
    assert.equal(engine.get('w', 'p').approvals?.length, 1);
    await f.controller.updateConversation('w', 'p', id, { openCodeAutoApprove: true });
    await until(() => replies.length === 1);
    assert.deepEqual(replies[0], ['pending-before-enable', 'approved']);
    await f.controller.updateConversation('w', 'p', id, { openCodeAutoApprove: false });
    f.adapters[0].emit('approval_requested', { approvalId: 'pending-after-disable', description: 'Read' });
    await delay(); assert.equal(replies.length, 1);
    assert(engine.get('w', 'p').approvals?.some(approval => approval.id === 'pending-after-disable'));
    await engine.replyApproval('w', 'p', 'pending-after-disable', { decision: 'deny', turnId: turn.turnId });
    assert.deepEqual(replies[1], ['pending-after-disable', 'rejected']);
  } finally { await f.controller.close(); }
}

// Approval replies already in flight stay bound to their originating turn during stop/replacement.
{
  const f = fixture('opencode'); const gate = deferred(); const delivered: string[] = [];
  f.configure(adapter => { (adapter as PlanningChatAdapter).respondToApproval = async id => { delivered.push(adapter.options!.sessionId! + ':' + id); await gate.promise; }; });
  try {
    const turn = await f.controller.send('w', 'p', input());
    await until(() => Boolean(f.adapters[0]?.options));
    f.adapters[0].emit('approval_requested', { approvalId: 'racing', toolName: 'read', description: 'Read' });
    const replying = f.controller.replyApproval('w', 'p', 'racing', { turnId: turn.turnId, decision: 'allow' });
    const result = assert.rejects(replying, /ended while replying/);
    await until(() => delivered.length === 1);
    f.controller.stop('w', 'p');
    await f.controller.send('w', 'p', input('replacement'));
    gate.resolve(); await result;
    assert.equal(delivered.length, 1);
    assert(delivered[0].startsWith('planning-' + turn.turnId));
    assert.deepEqual(f.controller.get('w', 'p').approvals, []);
  } finally { gate.resolve(); await f.controller.close(); }
}
{
  const f = fixture('opencode');
  try {
    await f.controller.send('w', 'p', input()); await until(() => Boolean(f.adapters[0]?.options));
    f.adapters[0].emit('approval_requested', { approvalId: 'unsupported', description: 'Read' });
    assert.equal(f.controller.get('w', 'p').status, 'failed');
    assert.match(f.controller.get('w', 'p').error!, /cannot reply to native approvals/);
  } finally { await f.controller.close(); }
}

// Portable registry, legacy migration, attachment validation/fingerprints and restart recovery use real disk paths.
{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-conversations-'));
  const store = new PlanningStore(id => id === 'w' ? { id, path: temporary } : undefined);
  store.create('w', { id: 'p', title: 'Threads' });
  const f = fixture(); const controller = new PlanningChatController({ ...f.options, store });
  const id = '30000000-0000-4000-8000-000000000001';
  try {
    assert.deepEqual(await controller.listConversations('w', 'p'), []);
    await controller.send('w', 'p', input());
    controller.stop('w', 'p');
    const legacy = (await controller.listConversations('w', 'p'))[0];
    assert.equal(legacy.id, 'default'); assert.equal(legacy.catalogId, 'catalog-route'); assert.equal(legacy.accountProfileId, 'account');
    await controller.createConversation('w', 'p', { id, catalogId: 'catalog-route', reasoning: 'high' });
    const engine = controller.conversation('w', 'p', id);
    const { Readable } = await import('node:stream');
    const asset = await store.importAsset('w', 'p', { filename: 'reference.txt', mimeType: 'text/plain', stream: Readable.from('Local reference') });
    for (const attachmentPaths of [['plan.md'], ['assets/../plan.md'], Array(11).fill(asset.path), ['assets/missing.txt']]) {
      await assert.rejects(engine.send('w', 'p', { ...input('bad-asset'), attachmentPaths }));
    }
    const oversized = Buffer.alloc(26 * 1024 * 1024); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized);
    const largeAsset = await store.importAsset('w', 'p', { filename: 'oversized.png', mimeType: 'image/png', stream: Readable.from(oversized) });
    await assert.rejects(engine.send('w', 'p', { ...input('oversized'), attachmentPaths: [largeAsset.path] }), /25 MiB/);
    const sent = await engine.send('w', 'p', { ...input(), attachmentPaths: [asset.path] });
    await until(() => Boolean(f.adapters[0]?.options));
    const wrapper = f.adapters[0].options!.prompt;
    const filename = JSON.parse(wrapper.split('\n')[0].split('JSON quoted): ')[1]);
    assert(fs.readFileSync(filename, 'utf8').includes(JSON.stringify(store.resolveFile('w', 'p', asset.path).absolutePath)));
    assert.deepEqual(sent.messages[0].attachmentPaths, [asset.path]);
    await assert.rejects(engine.send('w', 'p', input()), /different input/);
    const registryFile = path.join(temporary, '.atris-plans', fs.readdirSync(path.join(temporary, '.atris-plans'))[0], 'chat', 'conversations.json');
    assert.equal(JSON.parse(fs.readFileSync(registryFile, 'utf8')).schemaVersion, 1);
    assert(store.readMessages('w', 'p').every(record => typeof record.planningChat?.conversationId === 'string'));
    await controller.close();
    const reopened = new PlanningChatController({ ...f.options, store: new PlanningStore(key => key === 'w' ? { id: key, path: temporary } : undefined) });
    try {
      assert.equal((await reopened.listConversations('w', 'p')).length, 2);
      const restored = reopened.conversation('w', 'p', id).get('w', 'p');
      assert.equal(restored.status, 'interrupted'); assert.equal(restored.turnId, sent.turnId);
      assert.deepEqual(restored.messages[0].attachmentPaths, [asset.path]);
      assert.equal(reopened.get('w', 'p').messages.length, 1);
    } finally { await reopened.close(); }
    assert.throws(() => store.writeConversations('w', 'p', [...store.readConversations('w', 'p'), { ...legacy, workspaceId: 'other-workspace' }]), /Invalid/);
  } finally { await controller.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
}

console.log('Planning chat: HTTP lifecycle, restart, CAS proposals, cancellation, model validation, independent conversations, archive/reopen, controls, native approval replies and portable attachments passed. No provider processes launched.');

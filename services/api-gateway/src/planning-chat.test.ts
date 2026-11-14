import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { AccountProfile, CapabilitySnapshot, ModelDescriptor, RuntimeType } from '@atris-agent-code/domain';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import type { SpawnAgentOptions } from '@atris-agent-code/runtime-host';
import {
  PlanningChatController, extractPlanningUpdates, installPlanningChatRoutes,
  type PlanningChatAdapter, type PlanningChatOptions, type PlanningChatRecord, type PlanningChatState, type PlanningChatStorage,
} from './planning-chat';
import { PlanningStore } from './planning-store';

class Storage implements PlanningChatStorage {
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
    assert.equal(options.role, 'researcher'); assert.equal(options.accessMode, 'read-only');
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
    assert.match(wrapper, /read-only/); assert.match(wrapper, /Never use shell tools to write/);
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

console.log('Planning chat: async HTTP lifecycle, durable restart, CAS proposals, cancellation fences, idempotency, model validation, native interaction rejection and plan/session isolation passed. No provider processes launched.');

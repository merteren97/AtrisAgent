import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import express, { type Request } from 'express';
import type { RuntimeHost } from '@atris-agent-code/runtime-host';
import { ManualConversationStore } from './manual-conversations';
import { PlanningStore } from './planning-store';
import { isLocalDataRequest } from './local-data-access';
import { findPlanningHandoffSource, installPlanningHandoffRoutes, type PlanningHandoffInput, type PlanningOrchestratorStart } from './planning-handoff';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-planning-handoff-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const dbPath = path.join(root, 'gateway.sqlite');
  let sqlite = new Database(dbPath);
  sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL)');
  sqlite.prepare('INSERT INTO workspaces VALUES (?, ?)').run('workspace', project);
  sqlite.prepare('INSERT INTO workspaces VALUES (?, ?)').run('other', root);
  const resolve = (id: string) => sqlite.prepare('SELECT id, path FROM workspaces WHERE id = ?').get(id) as { id: string; path: string } | undefined;
  let store = new PlanningStore(resolve);
  store.create('workspace', { id: 'plan', title: 'Build feature', content: '# Frozen plan\n\nImplement the feature and validate it.' });
  store.writeDocument('workspace', 'plan', { path: 'research/findings.md', content: '# Research\n\nActual frozen evidence.', expectedRevision: null });
  await store.importAsset('workspace', 'plan', { filename: 'reference.txt', mimeType: 'text/plain', stream: Readable.from(['asset bytes']) });
  const planRoot = path.dirname(store.resolveFile('workspace', 'plan', 'plan.md').absolutePath);
  const descriptor = { catalogId: 'codex:model', runtimeId: 'codex', runtimeModelId: 'model-1', accountProfileId: 'account',
    availability: 'available', source: 'discovered', supportedReasoning: ['low', 'high'], defaultReasoning: 'high' };
  const profile = { id: 'account', runtimeType: 'codex', authStatus: 'connected', configDir: root, profileMode: 'shared_cli' };
  let modelCalls = 0;
  let forbidModelLookup = false;
  const runtimeHost = {
    getModelCatalogService: () => ({ resolveModelDescriptor: async (id: string) => {
      modelCalls++;
      assert(!forbidModelLookup, 'A durable replay must not resolve a new live model');
      return id === descriptor.catalogId ? descriptor : undefined;
    } }),
    getAccountProfileManager: () => ({ getProfileById: async () => profile }),
    getAdapter: () => assert.fail('Handoff must not discover/launch a native runtime'),
    startMission: () => assert.fail('Only the injected callback may queue a mission'),
  } as unknown as RuntimeHost;
  let manualStore = new ManualConversationStore(sqlite, root);
  const calls: PlanningOrchestratorStart[] = [];
  let start: (input: PlanningOrchestratorStart) => Promise<{ missionId: string; [key: string]: unknown }> = async () => ({ missionId: 'mission-one', accepted: true });
  let fenced = false;
  const servers: ReturnType<express.Application['listen']>[] = [];
  async function listen(auth = false) {
    const app = express();
    app.use(express.json());
    if (auth) app.use((req, res, next) => {
      if (isLocalDataRequest(req, 'runtime-secret') || req.header('x-test-entitlement') === 'premium') next();
      else res.status(403).json({ code: 'PREMIUM_REQUIRED' });
    });
    installPlanningHandoffRoutes(app, { store, manualStore, sqlite, runtimeHost,
      startOrchestrator: async input => { calls.push(structuredClone(input)); return start(input); }, fenced: () => fenced });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (body: unknown, workspaceId = 'workspace', headers: Record<string, string> = {}) => {
      const response = await fetch(`${origin}/api/workspaces/${workspaceId}/plans/plan/handoff`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
  }
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    sqlite.close();
    // Windows snapshots deliberately have the readonly attribute.
    const writable = (folder: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const filename = path.join(folder, entry.name);
        if (entry.isDirectory()) writable(filename); else fs.chmodSync(filename, 0o600);
      }
    };
    writable(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, project, planRoot, descriptor, profile, calls, listen,
    get sqlite() { return sqlite; }, get store() { return store; }, get manualStore() { return manualStore; },
    get modelCalls() { return modelCalls; },
    setStart(value: typeof start) { start = value; },
    fence(value: boolean) { fenced = value; },
    freezeModelLookup() { forbidModelLookup = true; },
    async restart() {
      sqlite.close(); sqlite = new Database(dbPath); sqlite.pragma('foreign_keys = ON');
      store = new PlanningStore(resolve); manualStore = new ManualConversationStore(sqlite, root);
      return listen();
    },
  };
}
const manual = (extra: Partial<PlanningHandoffInput> = {}): PlanningHandoffInput => ({ id: randomUUID(), target: 'manual', catalogId: 'codex:model', ...extra });
const orchestrator = (extra: Partial<PlanningHandoffInput> = {}): PlanningHandoffInput => ({ id: randomUUID(), target: 'orchestrator', ...extra });

test('Manual prepares real durable records, immutable Markdown/assets and source backlink; restart replay uses the frozen model/prompt', async t => {
  const f = await fixture(t);
  const post = await f.listen();
  const input = manual();
  const first = await post(input);
  assert.equal(first.status, 201);
  const result = first.body;
  assert.equal(result.status, 'ready');
  assert.equal(result.execution.status, 'linked');
  assert.equal(result.execution.targetId, result.conversation.id);
  assert.equal(result.agent.conversationId, result.conversation.id);
  assert.match(result.agent.id, /^[a-f0-9-]{36}$/);
  assert.equal(result.agent.cwd, fs.realpathSync(f.project));
  assert.equal(result.agent.model, 'model-1');
  assert.equal(result.agent.reasoning, 'high');
  assert.equal(result.agent.providerSessionId.length, 36);
  assert.equal(f.manualStore.agent(result.agent.id).id, result.agent.id);
  assert.deepEqual(findPlanningHandoffSource(f.sqlite, 'manual', result.conversation.id), result.source);
  assert.equal(findPlanningHandoffSource(f.sqlite, 'orchestrator', 'missing'), null);
  assert.equal(result.execution.files.length, 3);
  for (const relative of ['plan.md', 'research/findings.md', 'assets/reference.txt']) {
    const absolute = path.join(result.execution.snapshotPath, relative);
    assert(path.isAbsolute(absolute));
    assert(result.prompt.includes(JSON.stringify(absolute)));
    assert.equal(fs.statSync(absolute).isFile(), true);
  }
  assert(result.prompt.includes('# Frozen plan'));
  assert(result.prompt.includes('Actual frozen evidence.'));
  assert(result.prompt.includes(result.source.href));
  assert.equal(fs.readFileSync(path.join(result.execution.snapshotPath, 'assets/reference.txt'), 'utf8'), 'asset bytes');
  const live = f.store.readDocument('workspace', 'plan', 'plan.md');
  f.store.writeDocument('workspace', 'plan', { path: 'plan.md', content: '# Live changed', expectedRevision: live.revision });
  f.store.writeDocument('workspace', 'plan', { path: 'research/new.md', content: 'Added after handoff', expectedRevision: null });
  f.descriptor.defaultReasoning = 'low'; f.descriptor.runtimeModelId = 'new-model'; f.profile.authStatus = 'disabled';
  f.freezeModelLookup();
  const replay = await (await f.restart())(input);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.deepEqual({ ...replay.body, duplicate: false }, result);
  assert.equal(f.manualStore.list('workspace').length, 1);
  assert.equal(f.modelCalls, 1);
  assert.equal(f.calls.length, 0);
});

test('handoff includes the frozen board revision, manifest and body context', async t => {
  const f = await fixture(t);
  const initial = f.store.readBoard('workspace', 'plan')!;
  const board = f.store.writeBoard('workspace', 'plan', { expectedRevision: initial.revision, board: { ...initial.board, sections: [{ id: 'design', title: 'Design', kind: 'section', body: 'Board-only implementation detail.' }] } });
  const result = await (await f.listen())(manual());
  assert.equal(result.status, 201);
  assert.equal(result.body.execution.boardRevision, board.revision);
  assert(result.body.prompt.includes(`Board revision: ${board.revision}`));
  assert(result.body.prompt.includes('Board-only implementation detail.'));
  assert(result.body.execution.files.some((file: { path: string }) => file.path === 'board/board.json'));
  assert.equal(fs.readFileSync(path.join(result.body.execution.snapshotPath, 'board', 'content', 'design.md'), 'utf8'), 'Board-only implementation detail.');
});

test('operation ID rejects different model, reasoning, target or options and accepts reordered option keys', async t => {
  const f = await fixture(t);
  const post = await f.listen();
  const input = manual({ options: { nested: { b: 2, a: 1 }, workMode: 'build' } });
  assert.equal((await post(input)).status, 201);
  for (const changed of [
    { ...input, catalogId: 'different:model' }, { ...input, reasoning: 'low' },
    { ...input, target: 'orchestrator' }, { ...input, options: { workMode: 'research' } },
  ]) {
    const response = await post(changed);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'HANDOFF_CONFLICT');
  }
  assert.equal((await post({ ...input, options: { workMode: 'build', nested: { a: 1, b: 2 } } })).status, 200);
  assert.equal(f.manualStore.list('workspace').length, 1);
  assert.equal(f.modelCalls, 1);
  assert.equal((await post(input, 'other')).status, 404, 'A plan cannot be used from another workspace');
});

test('Orchestrator receives unchanged policy/team/route options and a stable immutable request/idempotency key', async t => {
  const f = await fixture(t);
  const post = await f.listen();
  const options = { trustMode: 'supervised', automationOverrides: { deployment: 'confirm' }, teamTemplate: 'custom-team',
    routeScope: 'subagents', orchestratorModelCatalogId: 'supervisor:model', fallbackCatalogIds: ['fallback:model'],
    teamLaunch: 'confirm', executionMode: 'balanced', agentProfileIds: ['profile'], custom: { keep: true } };
  const input = orchestrator({ catalogId: 'worker:model', reasoning: 'high', options });
  const responses = await Promise.all([post(input), post(input)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 202]);
  assert.equal(f.calls.length, 1);
  const response = responses.find(r => r.status === 202)!.body;
  assert.deepEqual(f.calls[0].options, { ...options, modelCatalogId: 'worker:model', reasoningLevel: 'high' });
  assert.equal(f.calls[0].request, response.prompt);
  assert.equal(f.calls[0].workspaceId, 'workspace');
  assert.match(f.calls[0].idempotencyKey, /^planning-handoff:[a-f0-9]{64}$/);
  assert.equal(response.status, 'queued');
  assert.equal(response.missionId, 'mission-one');
  assert.deepEqual(response.orchestrator, { missionId: 'mission-one', accepted: true });
  assert.deepEqual(findPlanningHandoffSource(f.sqlite, 'orchestrator', response.missionId), response.source);
  assert.equal(f.manualStore.list('workspace').length, 0);
  assert.equal(f.modelCalls, 0);
});

test('failed callback preserves prepared operation; restart retry recovers an already-created target by idempotency key', async t => {
  const f = await fixture(t);
  const post = await f.listen();
  const input = orchestrator({ options: { teamTemplate: 'retained-team' } });
  const missions = new Map<string, string>();
  let failOnce = true;
  f.setStart(async request => {
    if (!missions.has(request.idempotencyKey)) missions.set(request.idempotencyKey, randomUUID());
    if (failOnce) { failOnce = false; throw new Error('Connection lost after durable acceptance'); }
    return { missionId: missions.get(request.idempotencyKey)! };
  });
  assert.equal((await post(input)).status, 500);
  const execution = f.store.getExecution('workspace', 'plan', input.id);
  assert.equal(execution.status, 'prepared');
  const receipt = f.sqlite.prepare('SELECT prepared, result FROM planning_handoff_receipts').get() as any;
  assert.equal(receipt.result, null);
  assert(JSON.parse(receipt.prepared).prompt.includes('# Frozen plan'));
  fs.writeFileSync(path.join(f.planRoot, 'plan.md'), 'Live contents changed after failure');
  f.store.writeDocument('workspace', 'plan', { path: 'research/new.md', content: 'Later research', expectedRevision: null });
  const retry = await (await f.restart())(input);
  assert.equal(retry.status, 202);
  assert.equal(retry.body.execution.status, 'linked');
  assert.equal(missions.size, 1);
  assert.deepEqual(f.calls[1], f.calls[0]);
  assert.equal(retry.body.prompt, JSON.parse(receipt.prepared).prompt);
  assert(!retry.body.prompt.includes('Live contents changed'));
});

test('durable successful callback receipt repairs a failed snapshot link without invoking the callback again', async t => {
  const f = await fixture(t);
  const post = await f.listen();
  const input = orchestrator();
  f.store.recordExecutionTarget = () => { throw new Error('Injected link write failure'); };
  assert.equal((await post(input)).status, 500);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getExecution('workspace', 'plan', input.id).status, 'prepared');
  assert(findPlanningHandoffSource(f.sqlite, 'orchestrator', 'mission-one'));
  const retry = await (await f.restart())(input);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.execution.targetId, 'mission-one');
  assert.equal(f.calls.length, 1);
});

test('a changed snapshot is rejected before callback retry and the prepared receipt is preserved', async t => {
  const f = await fixture(t);
  const post = await f.listen();
  const input = orchestrator();
  f.setStart(async () => { throw new Error('Injected pre-acceptance failure'); });
  assert.equal((await post(input)).status, 500);
  const snapshot = f.store.getExecution('workspace', 'plan', input.id);
  const before = f.sqlite.prepare('SELECT prepared FROM planning_handoff_receipts').get();
  const filename = path.join(snapshot.snapshotPath, 'plan.md');
  fs.chmodSync(filename, 0o600);
  fs.writeFileSync(filename, 'Unexpected snapshot modification');
  const retry = await post(input);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, 'EXECUTION_CHANGED');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.sqlite.prepare('SELECT prepared FROM planning_handoff_receipts').get(), before);
});

test('Manual restart reconciles deterministic records even when the target result receipt was lost', async t => {
  const f = await fixture(t);
  const post = await f.listen();
  const input = manual();
  f.store.recordExecutionTarget = () => { throw new Error('Injected link failure'); };
  assert.equal((await post(input)).status, 500);
  const original = f.manualStore.list('workspace')[0];
  assert.equal(original.agents.length, 1);
  f.sqlite.prepare('UPDATE planning_handoff_receipts SET result = NULL, target_id = NULL').run();
  f.freezeModelLookup();
  const retry = await (await f.restart())(input);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.conversation.id, original.id);
  assert.deepEqual(retry.body.agent, original.agents[0]);
  assert.equal(f.manualStore.list('workspace').length, 1);
});

test('validation, connected supported runtime and deletion fencing precede all target effects', async t => {
  const f = await fixture(t);
  const post = await f.listen();
  for (const invalid of [manual({ id: '../escape' }), manual({ id: [randomUUID()] as any }), { id: randomUUID(), target: 'unknown' }, manual({ catalogId: undefined }),
    orchestrator({ options: [] as any }), orchestrator({ options: { large: 'x'.repeat(32_001) } }),
    orchestrator({ catalogId: 'a', options: { modelCatalogId: 'b' } }), manual({ reasoning: 'unsupported' })]) {
    assert([400, 413].includes((await post(invalid)).status));
  }
  f.profile.authStatus = 'disabled';
  assert.equal((await post(manual())).status, 400);
  f.profile.authStatus = 'connected'; f.descriptor.source = 'cached';
  assert.equal((await post(manual())).status, 400);
  f.descriptor.source = 'discovered'; f.profile.runtimeType = 'unsupported';
  assert.equal((await post(manual())).status, 422);
  f.fence(true);
  assert.equal((await post(orchestrator())).body.code, 'DELETION_IN_PROGRESS');
  assert.equal(f.calls.length, 0);
  assert.equal(f.manualStore.list('workspace').length, 0);
});

test('bounded prompt contains actual Unicode Markdown and absolute manifest access to every snapshotted asset', async t => {
  const f = await fixture(t);
  const live = f.store.readDocument('workspace', 'plan', 'plan.md');
  f.store.writeDocument('workspace', 'plan', { path: 'plan.md', content: '# Unicode snapshot\n' + '🛠️ Plan içeriği '.repeat(20_000), expectedRevision: live.revision });
  for (let i = 0; i < 80; i++) f.store.writeDocument('workspace', 'plan', { path: `research/note-${i}.md`, content: '# Frozen note\n' + 'é'.repeat(9_000), expectedRevision: null });
  const response = await (await f.listen())(orchestrator());
  assert.equal(response.status, 202);
  assert(Buffer.byteLength(response.body.prompt) <= 96_000);
  assert(response.body.prompt.includes('# Unicode snapshot'));
  assert(response.body.prompt.includes('# Frozen note'));
  assert(response.body.prompt.includes('Preview truncated'));
  assert(response.body.prompt.includes(JSON.stringify(path.join(response.body.execution.snapshotPath, 'request.json'))));
  assert.equal(response.body.execution.files.length, 83);
  assert.equal(Object.keys(f.calls[0].options).length, 0, 'Assets are file references, not embedded/base64 mission JSON');
});

test('handoff is execution traffic: valid runtime token alone cannot use the local-data entitlement bypass', async t => {
  const f = await fixture(t);
  const request = { method: 'POST', originalUrl: '/api/workspaces/workspace/plans/plan/handoff', headers: { 'x-atris-runtime-token': 'runtime-secret' } } as unknown as Request;
  assert.equal(isLocalDataRequest(request, 'runtime-secret'), false);
  const post = await f.listen(true);
  assert.equal((await post(orchestrator(), 'workspace', { 'x-atris-runtime-token': 'runtime-secret' })).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await post(orchestrator(), 'workspace', { 'x-test-entitlement': 'premium' })).status, 202);
});

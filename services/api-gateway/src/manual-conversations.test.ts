import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { RuntimeHost } from '@atris-agent-code/runtime-host';
import { ManualConversationStore, installManualConversations, parseManualTranscript } from './manual-conversations';

const sqlite = new Database(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT); CREATE TABLE missions (id TEXT PRIMARY KEY, workspace_id TEXT);');
sqlite.prepare('INSERT INTO workspaces VALUES (?, ?)').run('project-a', process.cwd());
sqlite.prepare('INSERT INTO workspaces VALUES (?, ?)').run('project-b', process.cwd());
sqlite.prepare('INSERT INTO missions VALUES (?, ?)').run('existing-mission', 'project-a');
const store = new ManualConversationStore(sqlite);
const conversationId = randomUUID();
const conversation = store.create('project-a', 'Independent work', conversationId);
assert.equal(store.create('project-a', 'Retry', conversationId).id, conversation.id);
assert.equal(store.list('project-a').length, 1, 'Retrying conversation creation is idempotent');
assert.throws(() => store.create('project-b', 'Conflict', conversationId), /identity conflict/);
assert.equal(new ManualConversationStore(sqlite).list('project-a')[0].title, 'Independent work', 'Reload retains authoritative metadata');
assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM missions').get() as {n: number}).n, 1, 'Existing missions remain unchanged');

const providerId = randomUUID();
const record = (uuid: string, content: unknown, sessionId = providerId, extra = {}) => JSON.stringify({ uuid, sessionId, type: 'assistant', message: { content }, ...extra });
const transcript = [
  record('a', [{ type: 'text', text: 'First answer' }]),
  record('foreign', [{ type: 'text', text: 'Another agent' }], randomUUID()),
  record('sidechain', [{ type: 'text', text: 'Child context' }], providerId, { isSidechain: true }),
  record('a', [{ type: 'text', text: 'Updated answer' }]),
  record('tool', [{ type: 'tool_use', name: 'Bash', input: { command: 'private payload' } }]),
  record('hidden', [{ type: 'thinking', thinking: 'private reasoning' }]),
  '{"incomplete":',
].join('\n');
const messages = parseManualTranscript(transcript, providerId);
assert.equal(messages.length, 2);
assert.equal(messages[0].text, 'Updated answer');
assert.equal(messages[1].toolName, 'Bash');
assert.ok(!JSON.stringify(messages).includes('private'));
assert.deepEqual(parseManualTranscript(transcript, randomUUID()), [], 'No cross-session attribution');

const profile = { id: 'account', runtimeType: 'claude_code', authStatus: 'connected', configDir: process.cwd(), profileMode: 'shared_cli' };
const model = { catalogId: 'claude:model', runtimeModelId: 'test-model', accountProfileId: 'account', availability: 'available', supportedReasoning: [] as string[], defaultReasoning: undefined as string | undefined };
const runtime = {
  getModelCatalogService: () => ({ resolveModelDescriptor: async (id: string) => id === model.catalogId ? model : undefined }),
  getAccountProfileManager: () => ({ getProfileById: async () => profile }),
  getAdapter: () => ({ discoverInstallation: async () => ({ installed: true, path: process.execPath }) }),
} as unknown as RuntimeHost;
const app = express(); app.use(express.json());
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-manual-api-'));
installManualConversations(app, sqlite, runtime, temporary);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/manual`;
const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
try {
  const id = randomUUID();
  const input = { id, name: 'Agent one', catalogId: model.catalogId };
  const first = await post(`/conversations/${conversationId}/agents`, input);
  assert.equal(first.status, 200);
  const agent = await first.json();
  const again = await post(`/conversations/${conversationId}/agents`, input);
  assert.equal((await again.json()).providerSessionId, agent.providerSessionId, 'POST retry preserves provider identity');
  const second = await post(`/conversations/${conversationId}/agents`, {...input, id: randomUUID(), name: 'Agent two'});
  assert.notEqual((await second.json()).providerSessionId, agent.providerSessionId, 'Independent agents never share a provider session');
  const launch = await post(`/agents/${id}/launch`, {});
  assert.equal(launch.status, 200);
  const launchRequest = await launch.json();
  assert.deepEqual(launchRequest.args.slice(0,4), ['--model', 'test-model', '--session-id', agent.providerSessionId]);
  assert.ok(JSON.parse(fs.readFileSync(launchRequest.args[5], 'utf8')).hooks.SessionStart, 'Claude lifecycle bridge stays scoped to this launch');
  assert.ok(!launchRequest.args.some((arg: string) => arg.includes('skip-permissions')), 'Provider approvals stay enabled');
  assert.deepEqual(launchRequest.env, {}, 'Shared CLI authentication is inherited, never copied');
  const patchModel = (catalogId: string, expectedCatalogId = agent.catalogId) => fetch(`${base}/agents/${id}/model`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({catalogId,expectedCatalogId})});
  assert.equal((await patchModel('missing')).status,400);
  model.catalogId = 'claude:new'; model.runtimeModelId = 'new-model';
  assert.equal((await patchModel(model.catalogId,'stale')).status,409,'Stale edits fail without overwriting the session');
  model.availability = 'unknown';
  assert.equal((await patchModel(model.catalogId)).status,400,'Unknown models are not runnable');
  model.availability = 'available';
  const changed = await patchModel(model.catalogId);
  assert.equal(changed.status,200);
  assert.equal((await changed.json()).providerSessionId,agent.providerSessionId,'Same-CLI model updates preserve exact session identity');
  const changedLaunch = await (await post(`/agents/${id}/launch`,{})).json();
  assert.equal(changedLaunch.args[1],'new-model','The changed model reaches real launch arguments');
  model.supportedReasoning = ['low','high'];
  const reasoningUpdate = await fetch(`${base}/agents/${id}/model`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({catalogId:model.catalogId,expectedCatalogId:model.catalogId,reasoning:'high'})});
  assert.equal(reasoningUpdate.status,200);
  assert.equal((await reasoningUpdate.json()).reasoning,'high');
  assert.deepEqual((await (await post(`/agents/${id}/launch`,{})).json()).args.slice(-2),['--effort','high']);
  assert.equal((await fetch(`${base}/agents/${id}/model`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({catalogId:model.catalogId,expectedCatalogId:model.catalogId,reasoning:'unsafe'})})).status,400);
  model.supportedReasoning = [];
  model.accountProfileId = 'other';
  assert.equal((await patchModel(model.catalogId,model.catalogId)).status,409,'Account changes require independent sessions');
  model.accountProfileId = 'account';
  model.catalogId = 'claude:model'; model.runtimeModelId = 'test-model';
  profile.runtimeType = 'antigravity';
  model.runtimeModelId = 'antigravity-active-route';
  const agy = await post(`/conversations/${conversationId}/agents`, {...input, id: randomUUID(), name: 'Antigravity'});
  assert.equal(agy.status, 200, 'Verified Antigravity models can create independent manual agents');
  const agyAgent = await agy.json();
  const agyLaunch = await (await post(`/agents/${agyAgent.id}/launch`, {})).json();
  assert.equal(agyLaunch.args[0], '--log-file', 'Active route uses a dedicated session log without invalid model or global continue flags');
  assert.equal(agyLaunch.args.length,2);
  assert.deepEqual(agyLaunch.env, {}, 'Antigravity credentials stay in the native keyring');
  model.runtimeModelId = 'gemini-test';
  const routed = await (await post(`/conversations/${conversationId}/agents`, {...input, id: randomUUID()})).json();
  const routedLaunch = await (await post(`/agents/${routed.id}/launch`, {})).json();
  assert.deepEqual(routedLaunch.args.slice(0,2), ['--model', 'gemini-test'], 'Concrete models are routed explicitly');
  assert.equal(routedLaunch.args[2],'--log-file');
  const group = store.create('project-b', 'Batch startup', randomUUID());
  const batch = Array.from({length:8}, (_, index) => ({...input, id:randomUUID(), name:`Agent ${index+1}`}));
  const batchResponse = await post(`/conversations/${group.id}/agents`, {agents:batch});
  assert.equal(batchResponse.status, 200);
  const batchAgents = await batchResponse.json();
  assert.equal(batchAgents.length, 8, 'A count of eight creates eight real persisted agents');
  assert.equal(new Set(batchAgents.map((a: any) => a.providerSessionId)).size, 8, 'Batch sessions have independent provider identities');
  const retryBatch = await (await post(`/conversations/${group.id}/agents`, {agents:batch})).json();
  assert.deepEqual(retryBatch, batchAgents, 'A retried batch preserves every identity');
  const invalidBatch = [{...input,id:randomUUID()}, {...input,id:randomUUID(),catalogId:'missing'}];
  assert.equal((await post(`/conversations/${group.id}/agents`, {agents:invalidBatch})).status,400);
  assert.equal(store.list('project-b').find(c=>c.id===group.id)!.agents.length,8,'Invalid batch cannot partially persist');
  const fill = Array.from({length:22},()=>({...input,id:randomUUID()}));
  assert.equal((await post(`/conversations/${group.id}/agents`,{agents:fill})).status,200);
  assert.equal((await post(`/conversations/${group.id}/agents`,{...input,id:randomUUID()})).status,409,'Server enforces 30-agent maximum');
  assert.equal((await post(`/conversations/${group.id}/agents`,{agents:batch})).status,200,'Idempotent retries remain allowed at capacity');
  assert.equal((await fetch(`${base}/agents/${batchAgents[0].id}`, {method:'DELETE'})).status,204);
  assert.throws(() => store.agent(batchAgents[0].id), 'Explicitly closed agent is removed, not archived');
  assert.equal(store.list('project-b').find(c=>c.id===group.id)!.agents.length,29);
  assert.equal((await fetch(`${base}/agents/${batchAgents[0].id}`, {method:'DELETE'})).status,204,'Repeated agent deletion is idempotent');
  assert.equal(store.agent(batchAgents[1].id).id,batchAgents[1].id,'Other independent agents remain intact');
  model.availability = 'unknown';
  assert.equal((await post(`/conversations/${conversationId}/agents`, {...input, id: randomUUID()})).status, 400);
  profile.authStatus = 'reauth_required';
  assert.equal((await post(`/agents/${id}/launch`, {})).status, 400);
  assert.equal((await post('/agents/missing/launch', {})).status, 404);
  assert.equal((await fetch(`${base}/conversations/${group.id}`,{method:'DELETE'})).status,204);
  assert.equal(store.list('project-b').some(c => c.id===group.id),false);
  assert.throws(() => store.agent(batchAgents[0].id));
  assert.equal(store.agent(agent.id).id,agent.id,'Deleting one conversation preserves other sessions');
  assert.equal((await fetch(`${base}/conversations/${group.id}`,{method:'DELETE'})).status,204,'Delete retry is idempotent');
  console.log('Manual conversation persistence, isolation, idempotency, transcript and route tests passed.');
} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); sqlite.close(); fs.rmSync(temporary, {recursive:true, force:true}); }

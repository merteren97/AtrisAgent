import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { RuntimeHost, runCommand } from '@atris-agent-code/runtime-host';
import { ManualConversationStore, installManualConversations, parseManualTranscript } from './manual-conversations';
import { manualContentTitle } from './manual-titles';
import { verifyManualCodexCompatibility } from './manual-codex-compatibility';
import { manualCoordination } from './manual-coordination';
import { parseAntigravityModelsOutput, resolveAntigravityCliRoute } from '../../runtime-host/src/antigravity-model-catalog';

// Keep compatibility coverage in the existing manual route test entry point.
{
  const help = '--profile <NAME> Layer <name>.config.toml\n--remote <ADDR>\n--remote-auth-token-env <ENV>\n--cd <DIR>';
  const outputs = {'--help':help, 'app-server --help':'--stdio Use stdio transport'};
  const calls: string[] = [];
  let failure: string | undefined;
  let exitCode = 0;
  const command: typeof runCommand = async (executable, args, options) => {
    assert.equal(executable, 'codex.exe');
    assert.equal(options?.timeoutMs, 5000);
    const key = args!.join(' '); calls.push(key);
    assert.notEqual(key, '--version', 'Version output must never be required for launch compatibility');
    if (key === failure) throw new Error('Fixture timeout');
    return {stdout:outputs[key as keyof typeof outputs], stderr:'', exitCode};
  };
  const verify = () => verifyManualCodexCompatibility('codex.exe', command, 'win32');
  for (const banner of ['codex-cli 0.167.0', 'codex-cli 0.168.0', 'codex-cli 1.0.0', 'codex-cli 99.0.0-nightly+dev', 'Custom Codex build', '']) {
    outputs['--help'] = `${banner}\n${help}`; calls.length = 0;
    await verify();
    assert.deepEqual(calls, ['--help', 'app-server --help'], 'Required features, not a version/banner allowlist, govern launch');
  }
  outputs['--help'] = help;
  calls.length = 0;
  await assert.rejects(verifyManualCodexCompatibility('codex.cmd', command, 'win32'), /native Codex executable/);
  assert.deepEqual(calls, [], 'Windows shims are rejected before execution');
  for (const missing of ['--profile', '.config.toml', '--remote', '--remote-auth-token-env', '--cd']) {
    outputs['--help'] = help.replace(missing, 'missing'); calls.length = 0;
    await assert.rejects(verify(), /layered CLI profiles|remote terminal options/);
    assert.deepEqual(calls, ['--help']);
  }
  outputs['--help'] = help;
  outputs['app-server --help'] = '--listen <URL>';
  await assert.rejects(verify(), /app-server --stdio/);
  outputs['app-server --help'] = '--stdio Use stdio transport';
  for (const key of Object.keys(outputs)) {
    failure = key;
    await assert.rejects(verify(), /Could not verify Codex CLI/);
  }
  failure = undefined; exitCode = 1;
  await assert.rejects(verify(), /Could not verify Codex CLI --help/);
  console.log('Codex compatibility: version-independent launch, future/development banners, native executable, required capabilities and failed probes passed.');
}

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
const asked = parseManualTranscript(record('ask', [{type:'tool_use',id:'toolu_1',name:'AskUserQuestion',input:{questions:[{header:'Deploy',question:'Proceed?',options:[{label:'Yes',description:'Continue'}]}]}}]), providerId);
assert.equal(asked[0].question?.questions[0].question, 'Proceed?');
assert.ok(!JSON.stringify(asked).includes('private'));
assert.deepEqual(parseManualTranscript(transcript, randomUUID()), [], 'No cross-session attribution');
assert.equal(manualContentTitle('Merhaba!'), undefined);
assert.equal(manualContentTitle('/help'), undefined);
assert.equal(manualContentTitle('```ts\nconst sample = 1;\n```\n## **Ödeme ekranını düzenle**'), 'Ödeme ekranını düzenle');
assert.equal(manualContentTitle('Hello\nReview the [checkout](https://example.test) flow'), 'Review the checkout flow');
assert.equal(manualContentTitle('Fix `user_service.ts` and **checkout**'), 'Fix user_service.ts and checkout', 'File identifiers retain their underscores');
assert.ok(Array.from(manualContentTitle('Uzun başlık için Türkçe içerik ve emoji 🚀 '.repeat(8))!).length <= 64);

const profile = { id: 'account', runtimeType: 'claude_code', authStatus: 'connected', configDir: process.cwd(), profileMode: 'shared_cli' };
const model = { catalogId: 'claude:model', runtimeModelId: 'test-model', accountProfileId: 'account', availability: 'available', supportedReasoning: [] as string[], defaultReasoning: undefined as string | undefined };
let codexExecutable = process.execPath;
const agyFamilies = parseAntigravityModelsOutput('gemini-test  Gemini Test\nclaude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)\nclaude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)\ngemini-3.8-flash-low  Gemini 3.8 Flash (Low)\ngemini-3.8-flash-high  Gemini 3.8 Flash (High)');
const runtime = {
  getModelCatalogService: () => ({ resolveModelDescriptor: async (id: string) => id === model.catalogId ? model : undefined }),
  getAccountProfileManager: () => ({ getProfileById: async () => profile }),
  getAdapter: (type: string) => ({ discoverInstallation: async () => ({ installed: true, path: type === 'codex' ? codexExecutable : process.execPath }),
    resolveModelCliRoute: async (modelId: string, reasoning?: string) => resolveAntigravityCliRoute(agyFamilies, modelId, reasoning) }),
} as unknown as RuntimeHost;
const app = express(); app.use(express.json());
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-manual-api-'));
const installedStore = installManualConversations(app, sqlite, runtime, temporary);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/manual`;
const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
try {
  const automaticId = randomUUID();
  const automatic = await (await post('/conversations', {id:automaticId,workspaceId:'project-a'})).json();
  assert.equal(automatic.title, 'New conversation', 'No title is required at creation');
  const rename = (id: string, title: unknown) => fetch(`${base}/conversations/${id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})});
  assert.equal((await rename(automaticId, '   ')).status, 400, 'Blank names are rejected');
  assert.equal((await rename(automaticId, 'a'.repeat(201))).status, 400, 'Oversized names are rejected');
  assert.equal((await rename(randomUUID(), 'Missing')).status, 404, 'Missing conversations cannot be renamed');
  const previousConfig = profile.configDir;
  profile.configDir = path.join(temporary,'provider'); profile.profileMode = 'isolated';
  fs.mkdirSync(path.join(profile.configDir,'projects','fixture'),{recursive:true});
  const automaticInputs = Array.from({length:3}, () => ({id:randomUUID(),catalogId:model.catalogId}));
  const automaticAgents = await (await post(`/conversations/${automaticId}/agents`, {agents:automaticInputs})).json();
  assert.deepEqual(automaticAgents.map((a:any)=>a.name), ['Claude Code 1','Claude Code 2','Claude Code 3'], 'Unnamed terminals have distinct automatic placeholders');
  const userRow = (agent:any, text:string, id='task') => record(id,text,agent.providerSessionId,{type:'user'});
  const fileFor = (agent:any) => path.join(profile.configDir,'projects','fixture',`${agent.providerSessionId}.jsonl`);
  fs.writeFileSync(fileFor(automaticAgents[0]), userRow(automaticAgents[0],'Merhaba','greeting'));
  const greeting = await (await fetch(`${base}/agents/${automaticAgents[0].id}/messages`)).json();
  assert.equal(greeting.naming.agentName, undefined, 'Greetings wait for a real task');
  const topic = 'Ödeme ekranındaki hataları düzelt';
  fs.appendFileSync(fileFor(automaticAgents[0]), '\n'+userRow(automaticAgents[0],topic));
  const named = await (await fetch(`${base}/agents/${automaticAgents[0].id}/messages`)).json();
  assert.equal(named.naming.agentName, topic);
  assert.equal(named.naming.conversationTitle, topic, 'The first actual task names the conversation');
  fs.writeFileSync(fileFor(automaticAgents[1]), userRow(automaticAgents[1],'Test kapsamını incele'));
  const background = await (await fetch(`${base}/agents/${automaticAgents[1].id}/activity`)).json();
  assert.equal(background.naming.agentName,'Test kapsamını incele','Background Code activity names an unselected terminal from its own transcript');
  assert.equal(background.naming.conversationTitle,topic,'Other terminals do not replace the conversation topic');
  fs.writeFileSync(fileFor(automaticAgents[2]), userRow(automaticAgents[2],topic));
  const duplicate = await (await fetch(`${base}/agents/${automaticAgents[2].id}/activity`)).json();
  assert.equal(duplicate.naming.agentName,`${topic} (2)`,'Identical tasks still have distinct terminal titles');
  const reloaded = new ManualConversationStore(sqlite,temporary);
  assert.equal(reloaded.list('project-a').find(c=>c.id===automaticId)!.title,topic,'Content titles survive store reload');
  assert.equal(reloaded.agent(automaticAgents[1].id).name,'Test kapsamını incele');
  assert.equal(reloaded.agent(automaticAgents[0].id).providerSessionId,automaticAgents[0].providerSessionId,'Renaming does not recreate provider sessions');
  const renamedResponse = await rename(automaticId, '  My own title  ');
  assert.equal(renamedResponse.status, 200);
  assert.equal((await renamedResponse.json()).title, 'My own title');
  assert.equal(reloaded.list('project-a').find(c=>c.id===automaticId)!.title, 'My own title', 'User title persists on reload');
  assert.equal(sqlite.prepare('SELECT 1 FROM manual_automatic_titles WHERE conversation_id = ?').get(automaticId), undefined, 'User rename disables automatic title replacement');
  assert.equal(reloaded.syncTitles(automaticAgents[0].id,[{id:'future',role:'user',text:'A new task title'}]).conversationTitle, undefined);
  assert.equal(reloaded.list('project-a').find(c=>c.id===automaticId)!.title, 'My own title');
  const stable = reloaded.syncTitles(automaticAgents[0].id,[{id:'later',role:'user',text:'Completely different task'}]);
  assert.equal(stable.agentName,topic,'A later/truncated transcript does not make established titles jump');
  const replay = await (await post(`/conversations/${automaticId}/agents`,{agents:automaticInputs})).json();
  assert.equal(replay[0].name,topic,'Creation retry retains the generated name');
  assert.equal((await (await post('/conversations',{id:automaticId,workspaceId:'project-a'})).json()).title,'My own title');
  assert.equal((await fetch(`${base}/conversations/${automaticId}`,{method:'DELETE'})).status,204);
  assert.equal(sqlite.prepare('SELECT 1 FROM manual_automatic_titles WHERE conversation_id = ?').get(automaticId),undefined,'Naming state is deleted with its conversation');
  profile.configDir = previousConfig; profile.profileMode = 'shared_cli';
  const id = randomUUID();
  const input = { id, name: 'Agent one', catalogId: model.catalogId };
  const first = await post(`/conversations/${conversationId}/agents`, input);
  assert.equal(first.status, 200);
  const agent = await first.json();
  const codex = {...agent,id:randomUUID(),runtimeType:'codex'};
  store.save(codex);
  const permissions = (id:string, mode:unknown, expectedMode:unknown, fullAccessConfirmed = false) => fetch(`${base}/agents/${id}/permissions`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode,expectedMode,fullAccessConfirmed})});
  assert.equal((await permissions(agent.id,'read-only',null)).status,400,'Other providers cannot use Codex permission controls');
  assert.equal((await permissions(codex.id,'unknown',null)).status,400);
  assert.equal((await permissions(codex.id,'full-access',null)).status,400,'Full Access requires explicit confirmation');
  let previousMode: string | null = null;
  for (const mode of ['ask-for-approval','approve-for-me','full-access','read-only']) {
    const response = await permissions(codex.id,mode,previousMode,mode === 'full-access');
    assert.equal(response.status,200);
    assert.equal((await response.json()).codexPermissionMode,mode);
    assert.equal(new ManualConversationStore(sqlite).agent(codex.id).codexPermissionMode,mode,'Permission preference survives reload');
    previousMode = mode;
  }
  assert.equal((await permissions(codex.id,'approve-for-me',null)).status,409,'Stale preference cannot overwrite a newer choice');
  assert.equal(store.agent(agent.id).codexPermissionMode,undefined,'Permission choice is isolated to this agent');
  assert.equal((await fetch(`${base}/agents/${agent.id}/permissions/live`)).status,400);
  assert.equal((await (await fetch(`${base}/agents/${codex.id}/permissions/live`)).json()).available,false,'Legacy terminals are not claimed to have live control');
  assert.equal((await post(`/agents/${codex.id}/permissions/live`,{mode:'ask-for-approval',expectedMode:null})).status,409,'Live requests retain preference CAS');
  assert.equal((await post(`/agents/${codex.id}/permissions/live`,{mode:'ask-for-approval',expectedMode:'read-only'})).status,409,'No runtime does not silently start a new conversation');
  const originalGet=installedStore.codexSessions.get.bind(installedStore.codexSessions);
  let applied=0;
  installedStore.codexSessions.get = ((id:string) => id===codex.id ? {apply:async()=>{applied++;return {available:true,mode:'ask-for-approval',threadId:'exact-thread'};}} : originalGet(id)) as typeof installedStore.codexSessions.get;
  assert.equal((await post(`/agents/${codex.id}/permissions/live`,{mode:'ask-for-approval',expectedMode:'read-only'})).status,200);
  assert.equal(applied,1); assert.equal(store.agent(codex.id).codexPermissionMode,'read-only','Live apply does not overwrite the next-open preference');
  installedStore.codexSessions.get=originalGet;
  const launchCodex = {...codex, id:randomUUID(), sharedProfile:false, configDir:path.join(temporary, 'codex-launch-home'), reasoning:'low', codexPermissionMode:'read-only' as const};
  store.save(launchCodex);
  const originalCreate = installedStore.codexSessions.create;
  const fixtureRuntimeId = randomUUID();
  let managedStarts = 0;
  installedStore.codexSessions.create = async (id, options) => {
    managedStarts++;
    assert.equal(id, launchCodex.id);
    assert.equal(options.executable, codexExecutable);
    assert.equal(options.cwd, launchCodex.cwd);
    assert.deepEqual(options.env, {CODEX_HOME:launchCodex.configDir});
    assert.equal(options.model, launchCodex.model);
    assert.equal(options.reasoning, 'low');
    assert.equal(options.mode, 'read-only', 'Managed launch retains the saved permission policy');
    return {url:'ws://127.0.0.1:12345', token:'fixture-token', runtimeId:fixtureRuntimeId};
  };
  const assertNoCodexPreparation = () => {
    assert.equal(managedStarts, 0, 'Compatibility refusal cannot start a managed server');
    assert.equal(fs.existsSync(launchCodex.configDir), false, 'Compatibility refusal cannot create a profile directory');
    assert.equal(fs.existsSync(path.join(temporary, 'manual-sessions', launchCodex.id)), false, 'Compatibility refusal cannot write a hook helper');
  };
  try {
    // Node is a real executable without the required Codex CLI features; no fake
    // compatibility helper bypasses the HTTP launch route in this regression.
    const refused = await post(`/agents/${launchCodex.id}/launch`, {});
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /layered CLI profiles/);
    assertNoCodexPreparation();
    if (process.platform === 'win32') {
      codexExecutable = path.join(temporary, 'codex.cmd');
      const shim = await post(`/agents/${launchCodex.id}/launch`, {});
      assert.equal(shim.status, 400);
      assert.match((await shim.json()).error, /native Codex executable/);
      assertNoCodexPreparation();
    }
    if (process.env.ATRIS_TEST_CODEX_EXECUTABLE) {
      codexExecutable = process.env.ATRIS_TEST_CODEX_EXECUTABLE;
      const accepted = await post(`/agents/${launchCodex.id}/launch`, {});
      const request = await accepted.json();
      assert.equal(accepted.status, 200, JSON.stringify(request));
      assert.equal(managedStarts, 1);
      assert.equal(request.executable, codexExecutable);
      assert.equal(request.cwd, launchCodex.cwd);
      assert.equal(request.codexRuntimeId, fixtureRuntimeId);
      assert.deepEqual(request.env, {CODEX_HOME:launchCodex.configDir, ATRIS_CODEX_REMOTE_TOKEN:'fixture-token'});
      assert.deepEqual(request.args.slice(-6), ['--remote', 'ws://127.0.0.1:12345', '--remote-auth-token-env', 'ATRIS_CODEX_REMOTE_TOKEN', '--cd', launchCodex.cwd]);
      assert.ok(request.args.includes('--profile'));
      assert.ok(!request.args.includes('--sandbox') && !request.args.includes('--ask-for-approval'), 'Remote TUI policy is supplied by the owning server');
      assert.ok(fs.existsSync(path.join(launchCodex.configDir, `atris-manual-${launchCodex.id}.config.toml`)));
      assert.ok(!fs.existsSync(path.join(launchCodex.configDir, 'config.toml')), 'No shared configuration is written');
      console.log('Installed Codex passed the actual HTTP launch route with managed permissions (server creation stubbed).');
    }
  } finally {
    installedStore.codexSessions.create = originalCreate;
    codexExecutable = process.execPath;
    store.removeAgent(launchCodex.id);
  }
  store.removeAgent(codex.id);
  store.syncTitles(agent.id,[{id:'custom',role:'user',text:'A new task title'}]);
  assert.equal(store.agent(agent.id).name,'Agent one','Existing explicit agent names are preserved');
  assert.equal(store.list('project-a').find(c=>c.id===conversationId)!.title,'Independent work','Existing explicit conversation titles are preserved');
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
  manualCoordination.configure({endpoint:'http://127.0.0.1:4321',script:'bridge.mjs'});
  const coordinatedResponse = await post(`/agents/${agyAgent.id}/launch`, {});
  const coordinated = await coordinatedResponse.json();
  assert.equal(coordinatedResponse.status,200);
  assert.equal(coordinated.cwd,agyAgent.cwd,'Coordination must not replace the project working directory');
  assert.equal(coordinated.args[0],'--log-file','The dedicated transcript log remains in use');
  const addDir = coordinated.args.indexOf('--add-dir');
  assert(addDir >= 0,'Antigravity receives the separate MCP workspace');
  assert.equal(coordinated.env.ATRIS_MANUAL_COORDINATION,'1');
  const config = fs.readFileSync(path.join(coordinated.args[addDir+1],'.agents','mcp_config.json'),'utf8');
  assert(!config.includes(coordinated.env.ATRIS_CONTROL_PLANE_TOKEN),'Agent grant remains outside the config file');
  manualCoordination.configure(undefined);
  model.runtimeModelId = 'gemini-test';
  const routed = await (await post(`/conversations/${conversationId}/agents`, {...input, id: randomUUID()})).json();
  const routedLaunch = await (await post(`/agents/${routed.id}/launch`, {})).json();
  assert.deepEqual(routedLaunch.args.slice(0,2), ['--model', 'gemini-test'], 'Concrete models are routed explicitly');
  assert.equal(routedLaunch.args[2],'--log-file');
  for (const [family, reasoning, route] of [['claude-opus-4-6','high','claude-opus-4-6-thinking'], ['claude-sonnet-4-6','high','claude-sonnet-4-6'], ['gemini-3.8-flash','low','gemini-3.8-flash-low']]) {
    model.runtimeModelId = family; model.supportedReasoning = [reasoning]; model.defaultReasoning = reasoning;
    const changed = await fetch(`${base}/agents/${routed.id}/model`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({catalogId:model.catalogId,expectedCatalogId:model.catalogId,reasoning})});
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).providerSessionId, routed.providerSessionId);
    const launched = await post(`/agents/${routed.id}/launch`, {});
    const request = await launched.json();
    assert.equal(launched.status, 200, JSON.stringify(request));
    assert.deepEqual(request.args.slice(0,2), ['--model', route]);
    assert.equal(request.args.includes('--effort'), false, 'Thinking and effort variants are exact routes, not adjustable CLI effort');
    assert.equal(request.args[2], '--log-file', 'Dedicated transcript ownership survives model changes');
  }
  model.defaultReasoning = undefined;
  profile.runtimeType = 'opencode';
  model.catalogId = 'opencode:first'; model.runtimeModelId = 'provider/first'; model.supportedReasoning = ['low','high'];
  const openAgentResponse = await post(`/conversations/${conversationId}/agents`, {...input,id:randomUUID(),catalogId:model.catalogId});
  assert.equal(openAgentResponse.status,200);
  const openAgent = await openAgentResponse.json();
  const openLaunchResponse = await post(`/agents/${openAgent.id}/launch`, {});
  const openLaunch = await openLaunchResponse.json();
  assert.equal(openLaunchResponse.status,200,JSON.stringify(openLaunch));
  assert.equal(openLaunch.args[1], 'provider/first');
  const openPatch = (live: boolean) => fetch(`${base}/agents/${openAgent.id}/model`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({catalogId:model.catalogId,expectedCatalogId:openAgent.catalogId,reasoning:'high',live})});
  model.catalogId = 'opencode:next'; model.runtimeModelId = 'provider/next';
  assert.equal((await openPatch(true)).status,409,'A running older plugin cannot silently claim live model support');
  const openPlugin = await import(openLaunch.env.ATRIS_MANUAL_OPENCODE_PLUGIN);
  const observer = await openPlugin.AtrisManualSession({client:{}});
  assert.equal((await openPatch(true)).status,409,'The server plugin alone cannot advertise a working TUI bridge');
  fs.writeFileSync(path.join(path.dirname(fileURLToPath(openLaunch.env.ATRIS_MANUAL_OPENCODE_PLUGIN)), 'opencode-auto-mode.json'), JSON.stringify({version:4,enabled:false,at:Date.now()}));
  await observer.event({event:{type:'session.created',properties:{info:{id:'ses_manual'}}}});
  const liveChange = await openPatch(true);
  assert.equal(liveChange.status,200,'A live OpenCode route is accepted without a terminal restart');
  assert.equal((await liveChange.json()).providerSessionId,openAgent.providerSessionId,'The live switch preserves the provider session');
  const nextPrompt = {message:{model:{providerID:'provider',modelID:'first'}},parts:[]};
  await observer['chat.message']({sessionID:'ses_manual'},nextPrompt);
  assert.deepEqual(nextPrompt.message.model,{providerID:'provider',modelID:'next',variant:'high'},'The live API update controls the next OpenCode turn');
  profile.runtimeType = 'antigravity';
  model.catalogId = 'claude:model'; model.runtimeModelId = 'gemini-test'; model.supportedReasoning = [];
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from './attachments';
import { registerSupervisorTurnRunner } from '@atris-agent-code/event-bus';
import { eq } from 'drizzle-orm';
import { conversationTurns, missionEvents } from '@atris-agent-code/database';
import { OrchestratorV2 } from '@atris-agent-code/orchestration-core';
import { RuntimeHost } from '@atris-agent-code/runtime-host';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-attachments-'));
const sqlite = new Database(path.join(root, 'storage.sqlite'));
sqlite.exec("PRAGMA foreign_keys=ON; CREATE TABLE workspaces(id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES ('one'), ('two')");
try {
  const store = new AttachmentStore(sqlite, root);
  const upload = (data: Buffer, mimeType = 'text/plain', name = 'notes.txt') => store.upload({ workspaceId: 'one', name, mimeType, dataBase64: data.toString('base64') });
  const bytes = Buffer.from('durable local file ✓');
  const ref = upload(bytes);
  const restored = new AttachmentStore(sqlite, root).read(ref.id, 'one');
  assert.deepEqual(fs.readFileSync(restored.providerPath), bytes);
  assert.equal(restored.dataBase64, bytes.toString('base64'));
  assert.equal(restored.byteSize, bytes.length);
  assert.throws(() => store.read(ref.id, 'two'), /not found/);
  assert.throws(() => upload(bytes, 'text/plain', '../escape.txt'), /safe filename/);
  assert.throws(() => upload(bytes, 'text/plain', 'C:\\escape.txt'), /safe filename/);
  assert.throws(() => upload(bytes, 'image/png', 'fake.png'), /MIME/);
  assert.throws(() => upload(bytes, 'text/html'), /Unsupported/);
  assert.throws(() => store.upload({ workspaceId: 'one', name: 'bad', mimeType: 'text/plain', dataBase64: '!!!!' }), /base64/);
  assert.throws(() => upload(Buffer.from([0xff]), 'text/plain'), /UTF-8/);
  assert.throws(() => upload(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), 'application/octet-stream'), /10 MiB/);
  assert.throws(() => store.resolve([ref.id, ref.id], 'one'), /unique/);
  assert.throws(() => store.resolve(Array.from({ length: 11 }, (_, i) => String(i)), 'one'), /10/);
  const large = Array.from({ length: 3 }, () => upload(Buffer.alloc(9 * 1024 * 1024, 1), 'application/octet-stream'));
  assert.throws(() => store.resolve(large.map((item) => item.id), 'one'), /25 MiB/);
  fs.writeFileSync(restored.providerPath, 'changed');
   assert.throws(() => store.resolve([ref.id], 'one'), /changed/);
   const missing = store.read(upload(bytes).id, 'one');
   fs.unlinkSync(missing.providerPath);
   assert.throws(() => store.resolve([missing.id], 'one'), (error: any) => error.statusCode === 409 && error.code === 'ATTACHMENT_CHANGED');
  // Actual junction attack: the store must reject a replaced root, not follow it.
  const attackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-attachment-outside-'));
  const savedRoot = `${store.root}-saved`;
  fs.renameSync(store.root, savedRoot);
  try {
    fs.symlinkSync(attackRoot, store.root, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => store.resolve([large[0].id], 'one'), /Unsafe/);
    const outsideFile = path.join(attackRoot, `${large[0].id}.bin`);
    fs.writeFileSync(outsideFile, 'outside-owned');
    assert.throws(() => store.cleanupWorkspace('one'), /Unsafe/);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside-owned', 'cleanup must not follow a replaced attachment root');
    assert(sqlite.prepare('SELECT id FROM gateway_attachments WHERE id=?').get(large[0].id), 'unsafe cleanup retains metadata');
  } finally {
    fs.rmSync(store.root, { recursive: true, force: true });
    fs.renameSync(savedRoot, store.root);
    fs.rmSync(attackRoot, { recursive: true, force: true });
  }
  // A junction at an attachment filename is also never traversed or unlinked.
  const junctionFile = store.read(large[0].id, 'one').providerPath;
  const savedFile = `${junctionFile}-saved`;
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-attachment-file-junction-'));
  const outsideSentinel = path.join(outsideDir, 'keep.txt');
  fs.writeFileSync(outsideSentinel, 'outside-owned');
  fs.renameSync(junctionFile, savedFile);
  try {
    fs.symlinkSync(outsideDir, junctionFile, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => store.cleanupWorkspace('one'), /unsafe/);
    assert.equal(fs.readFileSync(outsideSentinel, 'utf8'), 'outside-owned');
    assert(sqlite.prepare('SELECT id FROM gateway_attachments WHERE id=?').get(large[0].id));
  } finally {
    fs.rmSync(junctionFile, { recursive: true, force: true });
    fs.renameSync(savedFile, junctionFile);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
  const isolated = store.upload({ workspaceId: 'two', name: 'keep.txt', mimeType: 'text/plain', dataBase64: bytes.toString('base64') });
  const isolatedPath = store.read(isolated.id, 'two').providerPath;
  const untrackedPath = path.join(store.root, 'untracked.txt');
  fs.writeFileSync(untrackedPath, 'not an attachment record');
  const retry = store.read(upload(bytes).id, 'one');
  const removedBeforeFailure: string[] = [];
  let failedPath = '';
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (filename) => {
    if (removedBeforeFailure.length === 1) {
      failedPath = String(filename);
      throw Object.assign(new Error('injected unlink failure'), { code: 'EACCES' });
    }
    unlink(filename);
    removedBeforeFailure.push(String(filename));
  };
  try { assert.throws(() => store.cleanupWorkspace('one'), /injected unlink failure/); }
  finally { fs.unlinkSync = unlink; }
  assert(removedBeforeFailure.length > 0, 'failure exercises partial physical cleanup');
  assert(sqlite.prepare('SELECT id FROM gateway_attachments WHERE id=?').get(ref.id), 'even already-unlinked records survive incomplete cleanup');
  assert(sqlite.prepare('SELECT id FROM gateway_attachments WHERE id=?').get(retry.id), 'failed unlink retains retry ownership');
  assert.equal(fs.existsSync(failedPath), true, 'failed unlink leaves physical bytes for retry');
  store.cleanupWorkspace('one');
  store.cleanupWorkspace('one');
  assert.equal(fs.existsSync(retry.providerPath), false, 'retry physically deletes the remaining file');
  assert.equal(fs.existsSync(failedPath), false, 'retry removes the previously blocked file');
  assert.equal(fs.existsSync(restored.providerPath), false, 'workspace files are physically deleted');
  assert.equal(sqlite.prepare("SELECT id FROM gateway_attachments WHERE workspace_id='one'").get(), undefined, 'metadata is removed only after complete cleanup');
  assert.deepEqual(fs.readFileSync(isolatedPath), bytes, 'other workspace files remain intact');
  assert.equal(fs.readFileSync(untrackedPath, 'utf8'), 'not an attachment record', 'cleanup only unlinks enumerated app-owned attachment paths');
  assert(sqlite.prepare('SELECT id FROM gateway_attachments WHERE id=?').get(isolated.id), 'other workspace metadata remains intact');
  console.log('Attachment durable storage, byte/MIME/size/workspace/path safeguards passed.');
} finally { sqlite.close(); }

// Real authenticated gateway + durable start/queue/replan integration. No provider processes.
const hub = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.authorization !== 'Bearer attachment-test') return void res.writeHead(401).end('{}');
  res.end(JSON.stringify(req.url === '/api/auth/me'
    ? { user: { id: 'attachment-user' }, entitlement: { product: 'AtrisAgent', status: 'active', plan: 'Premium' } }
    : { access: { appId: 'agent', mode: 'PREMIUM', allowed: true } }));
});
await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
process.env.ATRIS_AUTH_API_URL = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
process.env.ATRIS_RUNTIME_TOKEN = 'attachment-runtime';
process.env.ATRIS_AGENT_DATA_DIR = path.join(root, 'gateway');
process.env.NODE_ENV = 'test';
const gateway = await import('./index');
await gateway.startupRecovery;
// Observe real dispatch records/events without starting connected CLI providers.
(gateway.runtimeHost as any).handleTaskCreated = async () => undefined;
await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}/api`;
const call = (url: string, body?: unknown, key?: string) => fetch(`${base}${url}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer attachment-test', 'X-Atris-Runtime-Token': 'attachment-runtime',
    'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
let supervisorPrompt = '';
registerSupervisorTurnRunner(async ({ prompt }) => {
  supervisorPrompt = prompt;
  return JSON.stringify({ action: 'execute', response: 'Proposed implementation', delegations: [
    { id: 'build', role: 'builder', objective: 'Build from the attached reference', requiredCapabilities: ['implementation'] },
  ] });
});
try {
  const workspace = await gateway.workspaceManager.createWorkspace({ name: 'Attachment fixture', path: root });
  const other = await gateway.workspaceManager.createWorkspace({ name: 'Other scope', path: root });
  const content = Buffer.alloc(3 * 1024 * 1024, 65);
  const posted = await call('/attachments', { workspaceId: workspace.id, name: 'reference.txt', mimeType: 'text/plain', dataBase64: content.toString('base64') });
  assert.equal(posted.status, 201, 'attachment route accepts files beyond the ordinary 2 MiB body limit');
  const ref = await posted.json() as any;
  assert.equal(ref.byteSize, content.length);
  assert.equal((await (await call(`/attachments/${ref.id}?workspaceId=${workspace.id}`)).json() as any).dataBase64, content.toString('base64'));
  assert.equal((await call(`/attachments/${ref.id}?workspaceId=${other.id}`)).status, 404);
  assert.equal((await fetch(`${base}/attachments/${ref.id}?workspaceId=${workspace.id}`)).status, 401);
   const start = { workspaceId: workspace.id, request: 'Build from this file', attachmentIds: [ref.id], workMode: 'plan', teamLaunch: 'automatic', targetRole: 'builder', trustMode: 'autonomous' };
  const response = await call('/missions/start', start, 'attachment-start');
  assert.equal(response.status, 202);
  const accepted = await response.json() as any;
  for (let i = 0; i < 100 && (await gateway.workspaceManager.getMission(accepted.missionId))?.status !== 'completed'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await gateway.workspaceManager.getMission(accepted.missionId))?.status, 'completed');
  const tasks = await gateway.workspaceManager.listTasks(accepted.missionId);
   assert(tasks.length > 0 && tasks.every((task) => task.status === 'planned' && !task.assignedAgentId));
   assert.equal((await call(`/tasks/${tasks[0].id}/merge`, {})).status, 409, 'strict plan forbids direct workspace apply');
   assert.deepEqual(await (await call(`/missions/${accepted.missionId}/questions`)).json(), { questions: [] }, 'question module is registered in the real gateway');
   assert.equal((await fetch(`${base}/missions/${accepted.missionId}/questions`)).status, 401, 'question routes remain behind gateway auth');
  const providerPath = gateway.attachmentStore.resolve([ref.id], workspace.id)[0].providerPath;
  assert(supervisorPrompt.includes(providerPath) && supervisorPrompt.includes('Native vision support is not assumed'));
  assert(tasks.every((task) => task.description.includes(providerPath)));
  assert.equal((await call('/missions/start', start, 'attachment-start')).status, 200);
  assert.equal((await call('/missions/start', { ...start, workMode: 'execute' }, 'attachment-start')).status, 400);
   const before = (await gateway.db.select().from(conversationTurns).all()).length;
  assert.equal((await call(`/missions/${accepted.missionId}/messages`, { content: 'Invalid', delivery: 'queue', options: { workMode: 'invalid' } })).status, 400);
  assert.equal((await call(`/missions/${accepted.missionId}/messages`, { content: 'Wrong scope', delivery: 'queue', options: { attachmentIds: [ref.id, 'missing'] } })).status, 404);
   assert.equal((await gateway.db.select().from(conversationTurns).all()).length, before);
  for (const delivery of ['queue', 'stop_and_replan']) {
    const request = { content: `Build again ${delivery}`, delivery, options: { attachmentIds: [ref.id], workMode: 'plan', teamLaunch: 'confirm', trustMode: 'autonomous' } };
    const queued = await call(`/missions/${accepted.missionId}/messages`, request, `attachment-${delivery}`);
    assert.equal(queued.status, 202);
    const turn = await queued.json() as any;
     assert.equal(turn.attachments[0].id, ref.id);
     assert.equal(turn.options.attachments[0].providerPath, undefined, 'public turn options expose attachment metadata, not internal paths');
    for (let i = 0; i < 100; i++) {
       const row = await gateway.db.select().from(conversationTurns).where(eq(conversationTurns.id, turn.id)).get();
      if (row?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
     assert.equal((await gateway.db.select().from(conversationTurns).where(eq(conversationTurns.id, turn.id)).get())?.status, 'completed');
    assert.equal((await call(`/missions/${accepted.missionId}/messages`, request, `attachment-${delivery}`)).status, 200);
    assert.equal((await call(`/missions/${accepted.missionId}/messages`, { ...request, options: { ...request.options, teamLaunch: 'automatic' } }, `attachment-${delivery}`)).status, 409);
  }
  assert((await gateway.workspaceManager.listTasks(accepted.missionId)).every((task) => !task.assignedAgentId));
   const events = await gateway.db.select().from(missionEvents).where(eq(missionEvents.missionId, accepted.missionId)).all();
  assert(events.filter((event) => event.type === 'user_message').every((event) => (event.payload.attachments as any[])?.[0]?.id === ref.id));
  assert.equal((await call(`/missions/${accepted.missionId}/approvals`)).status, 200);
  const recovered = new OrchestratorV2({ workspacePath: root }, gateway.eventBus, gateway.db, gateway.workspaceManager);
  await assert.rejects(recovered.handleApprovalDecision(accepted.missionId, 'plan', true), /Plan work mode/, 'restart recovers the strict preview policy from durable plan metadata');
  const current = (await gateway.workspaceManager.getMission(accepted.missionId))!;
  const currentTasks = (await gateway.workspaceManager.listTasks(accepted.missionId)).filter((task) => task.planId === current.planId);
  await gateway.workspaceManager.updateMission(accepted.missionId, { status: 'failed', activeRunId: null });
  await gateway.workspaceManager.updateTask(currentTasks[0].id, { status: 'blocked' });
  assert.equal((await call(`/missions/${accepted.missionId}/retry`, {})).status, 400, 'strict plan cannot dispatch via mission retry');

  const heldMission = await gateway.workspaceManager.createMission({ workspaceId: workspace.id, title: 'Held research', status: 'draft', executionMode: 'autonomous', automationPolicy: { profile: 'auto', strategy: 'standard', overrides: {} } });
  const heldStart = await call(`/missions/${heldMission.id}/start`, { request: 'Implement from this file', workMode: 'research', teamLaunch: 'confirm', targetRole: 'builder', attachmentIds: [ref.id] }, 'held-research');
  assert.equal(heldStart.status, 200);
  const held = await heldStart.json() as any;
  assert.equal((await gateway.workspaceManager.getMission(heldMission.id))?.status, 'waiting_for_approval');
   assert(held.tasks.length > 0 && held.tasks.every((task: any) => task.assignedRole === 'researcher' && !task.assignedAgentId));
   assert.equal((await call(`/tasks/${held.tasks[0].id}/merge`, {})).status, 409, 'research forbids direct workspace apply');
  const approvals = await (await call(`/missions/${heldMission.id}/approvals`)).json() as any[];
  const planApproval = approvals.find((approval) => approval.type === 'plan' && approval.status === 'pending');
   assert(planApproval, 'confirm produces an actual plan approval under Auto trust');
   assert.equal(planApproval.runId, (await gateway.workspaceManager.getMission(heldMission.id))!.activeRunId);
   const heldPlanId = (await gateway.workspaceManager.getMission(heldMission.id))!.planId;
   await gateway.workspaceManager.updateMission(heldMission.id, { planId: 'replacement-plan' });
   const staleDecision = await call(`/approvals/${planApproval.id}/decide`, { decision: 'approved' });
   assert.equal(staleDecision.status, 409, 'an old approval cannot launch a replacement plan');
   assert.equal((await staleDecision.json() as any).code, 'STALE_PLAN_APPROVAL');
   assert((await gateway.workspaceManager.listTasks(heldMission.id)).every((task) => !task.assignedAgentId));
   await gateway.workspaceManager.updateMission(heldMission.id, { planId: heldPlanId });
   assert.equal((await call(`/approvals/${planApproval.id}/decide`, { decision: 'approved' })).status, 200);
   assert.equal((await call(`/approvals/${planApproval.id}/decide`, { decision: 'approved' })).status, 409, 'duplicate approval cannot dispatch twice');
  const launched = await gateway.workspaceManager.listTasks(heldMission.id);
  assert(launched.every((task) => task.assignedRole === 'researcher' && task.status === 'running' && task.description.includes(providerPath)));
  assert.equal((await call(`/missions/${heldMission.id}/start`, { request: 'Implement from this file', workMode: 'research', teamLaunch: 'confirm', targetRole: 'builder', attachmentIds: [ref.id] }, 'held-research')).status, 200);
  const raw = (gateway.db as any).$client as Database.Database;
  const heldRun = (await gateway.workspaceManager.getMission(heldMission.id))!.activeRunId;
  raw.prepare("UPDATE mission_runs SET status='failed', completed_at=? WHERE id=?").run(new Date().toISOString(), heldRun);
  await gateway.workspaceManager.updateMission(heldMission.id, { status: 'failed', activeRunId: null });
  await gateway.workspaceManager.updateTask(launched[0].id, { status: 'rejected' });
  assert.equal((await call(`/missions/${heldMission.id}/retry`, {})).status, 200);
   const retryTurn = (await gateway.db.select().from(conversationTurns).where(eq(conversationTurns.missionId, heldMission.id)).all()).find((turn) => turn.options?.retryTaskIds !== undefined)!;
   assert.equal(retryTurn.options?.workMode, 'research');
   assert.equal(retryTurn.options?.teamLaunch, 'confirm');
   assert.equal((retryTurn.options?.attachments as any[])[0].id, ref.id);
   assert.equal((await gateway.workspaceManager.getTask(launched[0].id))?.description.includes(providerPath), true);
   // Exercise the actual RuntimeHost prompt builder with the durable worker record.
   // The adapter captures the provider boundary; no external CLI/model is invoked.
   let workerPrompt = '';
   const workerHost = new RuntimeHost(undefined, { watchdogInterval: 0, workspaceManager: {
     getTask: async () => gateway.workspaceManager.getTask(launched[0].id),
     getMission: async () => ({ workspaceId: workspace.id, automationPolicy: null }),
     getWorkspace: async () => ({ path: root }),
     listTasks: async () => [], resolveRoleExecutionPolicy: async () => undefined,
     claimTaskAttempt: async () => ({ id: 'attachment-attempt', attemptNumber: 1 }),
     markTaskAttemptRunning: async () => true, updateTask: async () => undefined,
     finishTaskAttempt: async () => true,
     expireOrphanedTaskAttempts: async () => [],
   } as any });
   workerHost.registerAdapter({ id: 'codex', runtimeType: 'codex', name: 'Attachment capture',
     setEventBus() {}, configureProfile() {}, probeCapabilities: async () => ({}),
     spawnAgent: async (input: any) => { workerPrompt = input.prompt; return { id: 'attachment-provider', agentInstanceId: input.sessionId }; },
     shutdown: async () => undefined, cancel: async () => undefined,
   } as any);
   (workerHost as any).profileManager.getProfiles = async () => [{ id: 'attachment-profile', provider: 'openai', runtimeType: 'codex', profileName: 'Fixture',
     authStatus: 'connected', configDir: '', supportedModels: ['fixture'], allowedRoles: ['researcher'], schedulerAuto: true }];
   (workerHost as any).catalogService.getCachedCatalog = () => [{ catalogId: 'attachment-model', runtimeId: 'codex', accountProfileId: 'attachment-profile',
     providerId: 'openai', runtimeModelId: 'fixture', displayName: 'Fixture', supportedRoles: ['researcher'], supportedReasoning: [],
     inputModalities: ['text'], availability: 'available', source: 'discovered' }];
   try {
     await workerHost.handleTaskCreated({ id: 'attachment-worker-event', type: 'task_created', missionId: heldMission.id, taskId: launched[0].id,
       agentInstanceId: 'attachment-worker', assignedRole: 'researcher', title: launched[0].title, timestamp: new Date().toISOString() });
     assert(workerPrompt.includes(providerPath) && workerPrompt.includes(ref.sha256) && workerPrompt.includes(ref.mimeType), 'the provider worker prompt carries real attachment path and record fields');
     assert.deepEqual(fs.readFileSync(providerPath), content, 'provider path identifies the original local bytes');
     assert(workerPrompt.includes('Native vision support is not assumed'), 'text-path delivery does not claim native multimodal transport');
   } finally { await workerHost.stopAll(); }
   console.log('Held research team approval, restart preview fence, direct-start idempotency and attachment-preserving retry passed.');
   // Actual DELETE handler: failed unlink must preserve rows and the mutation fence.
   const deleting = await gateway.workspaceManager.createWorkspace({ name: 'Attachment deletion', path: root });
   const deletionRef = gateway.attachmentStore.upload({ workspaceId: deleting.id, name: 'delete.txt', mimeType: 'text/plain', dataBase64: 'ZGVsZXRl' });
   const deletionPath = gateway.attachmentStore.read(deletionRef.id, deleting.id).providerPath;
   const deleteWorkspace = () => fetch(`${base}/workspaces/${deleting.id}`, { method: 'DELETE', headers: {
     Authorization: 'Bearer attachment-test', 'X-Atris-Runtime-Token': 'attachment-runtime',
   } });
   const unlink = fs.unlinkSync;
   let failedDeletion: any;
   fs.unlinkSync = (filename) => {
     if (String(filename) === deletionPath) throw Object.assign(new Error('injected route unlink failure'), { code: 'EACCES' });
     unlink(filename);
   };
   try {
     const response = await deleteWorkspace();
     assert.equal(response.status, 503);
     failedDeletion = await response.json();
   } finally { fs.unlinkSync = unlink; }
   assert.equal(failedDeletion.status, 'retryable');
   assert.equal(failedDeletion.phase, 'relational');
   assert(raw.prepare('SELECT id FROM workspaces WHERE id=?').get(deleting.id), 'relational cascade waits for physical cleanup');
   assert(raw.prepare('SELECT id FROM gateway_attachments WHERE id=?').get(deletionRef.id), 'failed DELETE retains attachment ownership');
   assert.equal((await call('/attachments', { workspaceId: deleting.id, name: 'blocked.txt', mimeType: 'text/plain', dataBase64: 'ZGVsZXRl' })).status, 409, 'retryable deletion fences uploads');
   assert.equal((await call(`/attachments/${deletionRef.id}?workspaceId=${deleting.id}`)).status, 409, 'retryable deletion fences reads');
   const retriedDeletion = await deleteWorkspace();
   assert.equal(retriedDeletion.status, 200);
   assert.equal((await retriedDeletion.json() as any).operationId, failedDeletion.operationId, 'retry resumes the same durable operation');
   assert.equal(fs.existsSync(deletionPath), false, 'successful route retry removes physical bytes');
   assert.equal(raw.prepare('SELECT id FROM gateway_attachments WHERE id=?').get(deletionRef.id), undefined);
   assert.equal(raw.prepare('SELECT id FROM workspaces WHERE id=?').get(deleting.id), undefined);
   assert.deepEqual(fs.readFileSync(providerPath), content, 'route deletion is workspace-isolated');
   assert.equal((await deleteWorkspace()).status, 200, 'completed deletion is idempotent');
   console.log('Attachment workspace cleanup, unlink failure retention and real DELETE retry fence passed.');
  console.log('Authenticated attachment/start/queue/replan/idempotency/autonomous-plan integration passed.');
} finally {
  registerSupervisorTurnRunner(null);
   await gateway.runtimeHost.stopAll();
   gateway.orchestratorInteractions.dispose();
  await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
  await new Promise<void>((resolve) => hub.close(() => resolve()));
  const raw = (gateway.db as any).$client as Database.Database;
  raw.close();
  fs.rmSync(root, { recursive: true, force: true });
}

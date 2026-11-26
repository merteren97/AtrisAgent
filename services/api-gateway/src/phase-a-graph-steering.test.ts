import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

async function main() {
  const hubServer = http.createServer((req, res) => {
    const pathname = req.url ? new URL(req.url, 'http://127.0.0.1').pathname : '';
    if (pathname === '/api/auth/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        user: { id: 'graph-test-user', email: 'graph@example.test' },
        membership: { status: 'active', plan: 'Premium' },
        entitlement: { product: 'AtrisAgent', status: 'active', plan: 'Premium' },
      }));
      return;
    }
    if (pathname === '/api/apps/agent/access') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access: {
          appId: 'agent',
          allowed: true,
          mode: 'PREMIUM',
        },
      }));
      return;
    }
    if (pathname === '/api/apps/agent/activity') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => hubServer.listen(0, '127.0.0.1', () => resolve()));
  const hubAddress = hubServer.address() as AddressInfo;

  const dataDir = path.join(os.tmpdir(), `atris-phase-a-graph-test-${process.pid}`);
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.ATRIS_AUTH_API_URL = `http://127.0.0.1:${hubAddress.port}`;
  process.env.NODE_ENV = 'test';
  process.env.ATRIS_RUNTIME_TOKEN = 'phase-a-runtime-secret';
  process.env.ATRIS_AGENT_DATA_DIR = dataDir;
  delete process.env.ATRIS_PARENT_PID;
  delete process.env.ATRIS_RUNTIME_MODE;

  const gateway = await import('./index');
  await gateway.startupRecovery;
  const { server, eventBus, workspaceManager, runtimeHost, orchestrator, db } = gateway;
  const schema = await import('@atris-agent-code/database');

  let closedByTest = false;
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closedByTest = true;
  }
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: 'Bearer phase-a-token',
    'X-Atris-Runtime-Token': 'phase-a-runtime-secret',
    'Content-Type': 'application/json',
  };

  try {
    const now = new Date().toISOString();
    const workspace = await workspaceManager.createWorkspace({ name: 'GraphWS', path: dataDir });
    const mission = await workspaceManager.createMission({
      workspaceId: workspace.id,
      title: 'Graph Mission',
      description: 'Test atomic graph and steering',
      teamTemplateId: 'default-core-dev-team',
    });
    await workspaceManager.updateMission(mission.id, { status: 'running', planId: 'plan-graph-1' });

    const task1 = await workspaceManager.createTask({
      missionId: mission.id,
      planId: 'plan-graph-1',
      title: 'Research API',
      description: 'Inspect routes',
      assignedRole: 'researcher',
      requiredCapabilities: ['research'],
      dependsOn: [],
    });
    const task2 = await workspaceManager.createTask({
      missionId: mission.id,
      planId: 'plan-graph-1',
      title: 'Build Graph',
      description: 'Implement graph endpoint',
      assignedRole: 'builder',
      requiredCapabilities: ['TypeScript'],
      dependsOn: [task1.id],
    });
    const task3 = await workspaceManager.createTask({
      missionId: mission.id,
      planId: 'plan-graph-1',
      title: 'Verify Graph (legacy depends_on only)',
      description: 'Legacy depends_on fallback check',
      assignedRole: 'qa',
      requiredCapabilities: ['testing'],
      dependsOn: [task2.id],
    });
    db.insert(schema.taskDependencies).values({
      id: 'dep-1',
      taskId: task2.id,
      dependsOnTaskId: task1.id,
    }).run();

    const agent1Id = 'agent-graph-1';
    db.insert(schema.agentInstances).values({
      id: agent1Id,
      missionId: mission.id,
      role: 'researcher',
      modelProfileId: 'codex:default:gpt-5.4',
      accountProfileId: 'acc-1',
      runtimeAdapterId: 'codex',
      status: 'running',
      taskId: task1.id,
      displayName: 'API Researcher',
      specialty: 'Backend routes',
      createdAt: now,
    }).run();
    const agent1 = { id: agent1Id };

    db.insert(schema.taskAttempts).values({
      id: 'attempt-graph-1',
      taskId: task1.id,
      missionId: mission.id,
      agentInstanceId: agent1.id,
      attemptNumber: 1,
      status: 'running',
      routeAdapterId: 'codex',
      routeProvider: 'openai',
      routeModelCatalogId: 'codex:default:gpt-5.4',
      claimedAt: now,
      startedAt: now,
    }).run();

    // Emit mission events so sequence > 0
    eventBus.emit({ id: 'evt-1', type: 'mission_started', missionId: mission.id, timestamp: now } as any);
    eventBus.emit({ id: 'evt-2', type: 'task_assigned', missionId: mission.id, taskId: task1.id, agentInstanceId: agent1.id, timestamp: now } as any);
    eventBus.emit({ id: 'evt-3', type: 'agent_spawned', missionId: mission.id, agentInstanceId: agent1.id, role: 'researcher', timestamp: now } as any);

    // 1. Test POST /api/missions/:id/agents/:agentId/messages (non-throwing fallback when adapter has no live session)
    const agentMsgRes = await fetch(`${baseUrl}/api/missions/${mission.id}/agents/${agent1.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'Check /graph route too' }),
    });
    const agentMsgText = await agentMsgRes.text();
    assert.equal(agentMsgRes.status, 202, `expected 202, got ${agentMsgRes.status}: ${agentMsgText}`);
    const agentMsgBody = JSON.parse(agentMsgText) as any;
    assert.equal(agentMsgBody.deliveredLive, false);
    assert.equal(agentMsgBody.effectiveDelivery, 'queued_directive');
    assert.ok(agentMsgBody.reason);
    assert.equal(agentMsgBody.directive.targetAgentId, agent1.id);
    assert.equal(agentMsgBody.directive.status, 'pending');

    // Test live delivery when runtimeHost.sendInput and liveSteer=true are available
    let liveReceived: any = null;
    const origGetAdapterCapsForLive = (runtimeHost as any).getAdapterCapabilities;
    (runtimeHost as any).getAdapterCapabilities = () => ({ liveSteer: true });
    (runtimeHost as any).sendInput = async (targetAgentId: string, input: any) => {
      liveReceived = { targetAgentId, input };
    };
    const liveMsgRes = await fetch(`${baseUrl}/api/missions/${mission.id}/agents/${agent1.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'Live steer payload' }),
    });
    assert.equal(liveMsgRes.status, 200);
    const liveMsgBody = await liveMsgRes.json() as any;
    assert.equal(liveMsgBody.deliveredLive, true);
    assert.equal(liveMsgBody.effectiveDelivery, 'live_steer');
    assert.equal(liveMsgBody.directive.status, 'applied');
    assert.equal(liveReceived?.targetAgentId, agent1.id);
    assert.equal(liveReceived?.input?.content, 'Live steer payload');
    delete (runtimeHost as any).sendInput;
    if (origGetAdapterCapsForLive) (runtimeHost as any).getAdapterCapabilities = origGetAdapterCapsForLive;
    else delete (runtimeHost as any).getAdapterCapabilities;

    // Test liveSteer: false capability gate blocks sendInput and queues directive
    let sendInputCalledWhenUnsupported = false;
    const origGetAdapterCapabilities = (runtimeHost as any).getAdapterCapabilities;
    (runtimeHost as any).sendInput = async () => { sendInputCalledWhenUnsupported = true; };
    (runtimeHost as any).getAdapterCapabilities = () => ({ liveSteer: false });
    const unsupportedRes = await fetch(`${baseUrl}/api/missions/${mission.id}/agents/${agent1.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'Should queue when liveSteer=false' }),
    });
    assert.equal(unsupportedRes.status, 202);
    const unsupportedBody = await unsupportedRes.json() as any;
    assert.equal(unsupportedBody.deliveredLive, false);
    assert.equal(unsupportedBody.effectiveDelivery, 'queued_directive');
    assert.equal(sendInputCalledWhenUnsupported, false, 'sendInput must not be called when getAdapterCapabilities().liveSteer === false');
    delete (runtimeHost as any).sendInput;
    if (origGetAdapterCapabilities) (runtimeHost as any).getAdapterCapabilities = origGetAdapterCapabilities;
    else delete (runtimeHost as any).getAdapterCapabilities;

    // Test invalid attachmentIds returns 400 without leaving a dangling turn_directives row
    const beforeDirectiveCount = (db.select().from(schema.turnDirectives).all() as any[]).length;
    const badAttachRes = await fetch(`${baseUrl}/api/missions/${mission.id}/agents/${agent1.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'With bad attachment', attachmentIds: ['non-existent-attachment'] }),
    });
    assert.ok([400, 404].includes(badAttachRes.status), `expected 400 or 404, got ${badAttachRes.status}`);
    const afterDirectiveCount = (db.select().from(schema.turnDirectives).all() as any[]).length;
    assert.equal(afterDirectiveCount, beforeDirectiveCount, 'invalid attachmentIds must not persist a dangling turn_directives row');

    // 2. Test explicit steer -> queue downgrade in POST /api/missions/:id/messages
    const downgradeRes = await fetch(`${baseUrl}/api/missions/${mission.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: 'Switch model and continue',
        delivery: 'steer',
        options: { modelCatalogId: 'codex:default:gpt-5.4' },
      }),
    });
    assert.equal(downgradeRes.status, 202);
    const downgradeBody = await downgradeRes.json() as any;
    assert.equal(downgradeBody.requestedDelivery, 'steer');
    assert.equal(downgradeBody.effectiveDelivery, 'queue');
    assert.ok(downgradeBody.deliveryDowngradeReason);

    // 3. Test GET /api/missions/:id/graph
    const graphRes = await fetch(`${baseUrl}/api/missions/${mission.id}/graph`, { headers });
    assert.equal(graphRes.status, 200);
    const graph = await graphRes.json() as any;
    assert.ok(graph.sequence >= 3, 'graph sequence reflects mission_events watermark');
    assert.equal(graph.mission.id, mission.id);
    assert.equal(graph.activePlanId, 'plan-graph-1');
    assert.equal(graph.plans.length, 1);
    assert.equal(graph.tasks.length, 3);
    assert.deepEqual(graph.dependencies.map((d: any) => ({ taskId: d.taskId, dependsOnTaskId: d.dependsOnTaskId })), [
      { taskId: task2.id, dependsOnTaskId: task1.id },
      { taskId: task3.id, dependsOnTaskId: task2.id },
    ]);
    assert.equal(graph.attempts.length, 1);
    assert.equal(graph.attempts[0].routeModelCatalogId, 'codex:default:gpt-5.4');
    assert.equal(graph.agents.length, 1);
    assert.equal(graph.agents[0].displayName, 'API Researcher');
    assert.equal(graph.agents[0].sandboxTier, 'inspect');
    assert.equal(graph.directives.length, 3);
    assert.equal(graph.turns.length, 1);

    // 4. Test stream_gap SSE signal when sinceSequence is older than earliest available DB sequence
    const { and, eq, lte } = await import('drizzle-orm');
    db.delete(schema.missionEvents)
      .where(and(eq(schema.missionEvents.missionId, mission.id), lte(schema.missionEvents.sequence, 2)))
      .run();
    const sseChunk = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        `${baseUrl}/api/events/stream?missionId=${mission.id}&sinceSequence=1`,
        {
          headers: {
            Authorization: 'Bearer phase-a-token',
            'X-Atris-Runtime-Token': 'phase-a-runtime-secret',
          },
        },
        (res) => {
          let buf = '';
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            if (buf.includes('event: stream_gap')) {
              req.destroy();
              resolve(buf);
            }
          });
          res.on('error', () => {
            if (buf.includes('event: stream_gap')) resolve(buf);
          });
        },
      );
      req.on('error', (err) => {
        if ((err as any)?.code === 'ECONNRESET') return;
        reject(err);
      });
      setTimeout(() => {
        req.destroy();
        reject(new Error('Timed out waiting for stream_gap SSE event'));
      }, 3_000).unref();
    });
    assert.ok(sseChunk.includes('event: stream_gap') && sseChunk.includes('"reason":"history_pruned"'), 'SSE emits stream_gap when sinceSequence precedes earliest DB sequence');

    // 5. Test non-blocking startup recovery with per-mission timeout
    const abortController = new AbortController();
    const originalReconcile = orchestrator.reconcileMissionPlan.bind(orchestrator);
    let reconciledCalled = false;
    (orchestrator as any).reconcileMissionPlan = async () => {
      reconciledCalled = true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    };
    const syncCtx = gateway.recoverGatewayStartupSync();
    assert.ok(syncCtx.recoveredAt);
    const startMs = Date.now();
    const asyncPromise = gateway.recoverGatewayStartupAsync(syncCtx, {
      signal: abortController.signal,
      perMissionTimeoutMs: 50,
    });
    await asyncPromise;
    assert.ok(Date.now() - startMs < 2000, 'per-mission timeout prevents hanging mission from blocking recovery');
    assert.ok(reconciledCalled);
    (orchestrator as any).reconcileMissionPlan = originalReconcile;

    console.log('[PASS] Phase A graph, agent directive, explicit delivery downgrade, and non-blocking startup recovery verified');
  } finally {
    orchestrator.dispose();
    if (closedByTest) await new Promise<void>((resolve) => server.close(() => resolve()));
    hubServer.close();
    await gateway.runtimeHost.stopAll();
    try { (db as any).$client?.close?.(); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Phase A graph steering test failed';
  console.error('Phase A graph steering test failed:', message.replace(/[\r\n]+/g, ' '));
  process.exit(1);
});

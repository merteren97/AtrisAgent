import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { isRoleAllowedByProfile } from '@atris-agent-code/domain';

async function main() {
  // 1. Zero-config local CLI readiness: empty/omitted allowedRoles allows all roles
  assert.equal(isRoleAllowedByProfile({ allowedRoles: [] }, 'builder'), true, 'empty allowedRoles allows builder');
  assert.equal(isRoleAllowedByProfile({ allowedRoles: [] }, 'reviewer'), true, 'empty allowedRoles allows reviewer');
  assert.equal(isRoleAllowedByProfile({ allowedRoles: undefined }, 'researcher'), true, 'omitted allowedRoles allows researcher');
  assert.equal(isRoleAllowedByProfile({ allowedRoles: ['researcher'] }, 'builder'), false, 'explicit allowedRoles restricts non-matching role');

  const hubServer = http.createServer((req, res) => {
    const pathname = req.url ? new URL(req.url, 'http://127.0.0.1').pathname : '';
    if (pathname === '/api/auth/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        user: { id: 'phase-b-user', email: 'phaseb@example.test' },
        membership: { status: 'active', plan: 'Premium' },
        entitlement: { product: 'AtrisAgent', status: 'active', plan: 'Premium' },
      }));
      return;
    }
    if (pathname === '/api/apps/agent/access') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access: { appId: 'agent', allowed: true, mode: 'PREMIUM' } }));
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

  const dataDir = path.join(os.tmpdir(), `atris-phase-b-routing-test-${process.pid}`);
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.ATRIS_AUTH_API_URL = `http://127.0.0.1:${hubAddress.port}`;
  process.env.NODE_ENV = 'test';
  process.env.ATRIS_RUNTIME_TOKEN = 'phase-b-runtime-secret';
  process.env.ATRIS_AGENT_DATA_DIR = dataDir;
  delete process.env.ATRIS_PARENT_PID;
  delete process.env.ATRIS_RUNTIME_MODE;

  const gateway = await import('./index');
  await gateway.startupRecovery;
  const { server, workspaceManager } = gateway;

  let closedByTest = false;
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closedByTest = true;
  }
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: 'Bearer phase-b-token',
    'X-Atris-Runtime-Token': 'phase-b-runtime-secret',
    'Content-Type': 'application/json',
  };

  try {
    // 2. GET /api/orchestrator/routing-defaults initially returns {}
    const initialDefaultsRes = await fetch(`${baseUrl}/api/orchestrator/routing-defaults`, { headers });
    assert.equal(initialDefaultsRes.status, 200);
    assert.deepEqual(await initialDefaultsRes.json(), {});

    // 3. PUT /api/orchestrator/routing-defaults validates reasoningLevel
    const invalidPutRes = await fetch(`${baseUrl}/api/orchestrator/routing-defaults`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ worker: { modelCatalogId: 'codex:default:gpt-5.4', reasoningLevel: 'ultra-bogus' } }),
    });
    assert.equal(invalidPutRes.status, 400);

    // 4. PUT /api/orchestrator/routing-defaults persists and GET returns it
    const validDefaults = {
      worker: { modelCatalogId: 'codex:default:gpt-5.4', reasoningLevel: 'medium', fallbackCatalogIds: ['codex:default:gpt-5.3-codex'] },
      review: { modelCatalogId: 'claude_code:default:claude-sonnet-4-6', reasoningLevel: 'high' },
    };
    const putRes = await fetch(`${baseUrl}/api/orchestrator/routing-defaults`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(validDefaults),
    });
    assert.equal(putRes.status, 200);
    const savedDefaults = await putRes.json();
    assert.equal(savedDefaults.worker?.modelCatalogId, 'codex:default:gpt-5.4');
    assert.equal(savedDefaults.review?.modelCatalogId, 'claude_code:default:claude-sonnet-4-6');

    const getDefaultsRes = await fetch(`${baseUrl}/api/orchestrator/routing-defaults`, { headers });
    assert.equal(getDefaultsRes.status, 200);
    assert.deepEqual(await getDefaultsRes.json(), savedDefaults);

    // 5. GET /api/runtimes includes adapterCapabilities while keeping array shape
    const runtimesRes = await fetch(`${baseUrl}/api/runtimes`, { headers });
    assert.equal(runtimesRes.status, 200);
    const runtimes = await runtimesRes.json();
    assert(Array.isArray(runtimes) && runtimes.length > 0, 'GET /api/runtimes returns an array');
    assert(runtimes.every((rt: any) => rt.adapterCapabilities && typeof rt.adapterCapabilities.liveSteer === 'boolean'),
      'GET /api/runtimes includes adapterCapabilities per runtime');

    // 6. GET /api/missions/:id/graph includes runtimeCapabilities & routingDefaults
    const workspace = await workspaceManager.createWorkspace({ name: 'PhaseBWS', path: dataDir });
    const mission = await workspaceManager.createMission({
      workspaceId: workspace.id,
      title: 'Phase B Graph Mission',
      description: 'Test routing defaults and per-node route override',
      teamTemplateId: 'default-core-dev-team',
    });
    await workspaceManager.updateMission(mission.id, { status: 'running', planId: 'plan-b-1' });
    const plannedTask = await workspaceManager.createTask({
      missionId: mission.id,
      planId: 'plan-b-1',
      title: 'Implement Endpoint',
      description: 'Implement route',
      assignedRole: 'builder',
      status: 'planned',
      requiredCapabilities: ['TypeScript'],
      dependsOn: [],
    });
    const completedTask = await workspaceManager.createTask({
      missionId: mission.id,
      planId: 'plan-b-1',
      title: 'Completed Research',
      description: 'Already done',
      assignedRole: 'researcher',
      requiredCapabilities: ['research'],
      dependsOn: [],
    });
    await workspaceManager.updateTask(completedTask.id, { status: 'done' });

    const graphRes = await fetch(`${baseUrl}/api/missions/${mission.id}/graph`, { headers });
    assert.equal(graphRes.status, 200);
    const graph = await graphRes.json();
    assert(graph.runtimeCapabilities && typeof graph.runtimeCapabilities.codex?.liveSteer === 'boolean',
      'GET /graph returns runtimeCapabilities');
    assert.equal(graph.routingDefaults?.worker?.modelCatalogId, 'codex:default:gpt-5.4',
      'GET /graph returns persisted routingDefaults');

    // 7. PATCH /api/missions/:id/tasks/:taskId/route validation + persistence + event
    const missingModelRes = await fetch(`${baseUrl}/api/missions/${mission.id}/tasks/${plannedTask.id}/route`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ reasoningLevel: 'high' }),
    });
    assert.equal(missingModelRes.status, 400);

    const completedTaskRes = await fetch(`${baseUrl}/api/missions/${mission.id}/tasks/${completedTask.id}/route`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ modelCatalogId: 'codex:default:gpt-5.4' }),
    });
    assert.equal(completedTaskRes.status, 409, 'cannot override route on completed task');

    const patchRes = await fetch(`${baseUrl}/api/missions/${mission.id}/tasks/${plannedTask.id}/route`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        modelCatalogId: 'claude_code:default:claude-opus-4-6',
        reasoningLevel: 'high',
        accountProfileId: 'acc-claude',
        fallbackCatalogIds: ['codex:default:gpt-5.4'],
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.equal(patchBody.routePreference?.modelCatalogId, 'claude_code:default:claude-opus-4-6');
    assert.equal(patchBody.routePreference?.reasoningLevel, 'high');
    assert.equal(patchBody.routePreference?.selectionMode, 'fixed');
    assert.equal(patchBody.task?.routePreference?.modelCatalogId, 'claude_code:default:claude-opus-4-6');

    const updatedGraphRes = await fetch(`${baseUrl}/api/missions/${mission.id}/graph`, { headers });
    const updatedGraph = await updatedGraphRes.json();
    const updatedNode = updatedGraph.tasks.find((t: any) => t.id === plannedTask.id);
    assert.equal(updatedNode?.routePreference?.modelCatalogId, 'claude_code:default:claude-opus-4-6',
      'updated routePreference persisted in /graph');

    const eventsRes = await fetch(`${baseUrl}/api/missions/${mission.id}/events`, { headers });
    assert.equal(eventsRes.status, 200);
    const emittedEvents = await eventsRes.json() as Array<{ type: string; changedTaskIds?: string[] }>;
    assert(emittedEvents.some((e) => e.type === 'plan_revised' && e.changedTaskIds?.includes(plannedTask.id)),
      'PATCH /route emits plan_revised mission event for UI sync');

    console.log('[PASS] Phase B routing defaults, runtimeCapabilities, per-node route override, and zero-config role check verified');
  } finally {
    if (closedByTest) await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // SQLite handle remains open in-process on Windows until exit.
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

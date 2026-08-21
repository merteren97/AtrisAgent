import http from 'http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';

async function runTests() {
  console.log('--- Starting API Gateway REST, SSE & WebSocket Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const hubServer = http.createServer((req, res) => {
    if (req.url === '/api/auth/me' && req.headers.authorization === 'Bearer integration-premium-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        user: { id: 'integration-user', email: 'integration@example.test' },
        membership: { status: 'active', plan: 'Premium' },
        entitlement: { product: 'AtrisAgent', status: 'active', plan: 'Premium' },
      }));
      return;
    }
    if (req.url === '/api/auth/me' && req.headers.authorization === 'Bearer integration-free-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        user: { id: 'integration-free-user', email: 'free@example.test' },
        membership: { status: 'active', plan: 'Free' },
        entitlement: { product: 'AtrisAgent', status: 'inactive', plan: 'Free' },
      }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
  });
  await new Promise<void>((resolve) => hubServer.listen(0, '127.0.0.1', () => resolve()));
  const hubAddress = hubServer.address() as AddressInfo;
  process.env.ATRIS_AUTH_API_URL = `http://127.0.0.1:${hubAddress.port}`;
  process.env.NODE_ENV = 'test';
  process.env.ATRIS_RUNTIME_TOKEN = 'gateway-runtime-secret';
  process.env.ATRIS_AGENT_DATA_DIR = path.join(os.tmpdir(), `atris-gateway-test-${process.pid}`);
  delete process.env.ATRIS_PARENT_PID;
  delete process.env.ATRIS_RUNTIME_MODE;

  const gateway = await import('./index');
  const { app, server, eventBus } = gateway;
  const authorizedFetch = (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', 'Bearer integration-premium-token');
    headers.set('X-Atris-Runtime-Token', 'gateway-runtime-secret');
    return fetch(input, { ...init, headers });
  };

  let shouldCloseServer = false;
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    shouldCloseServer = true;
  }

  const address = server.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/events`;

  try {
    // 1. GET /health
    {
      const res = await fetch(`${baseUrl}/health`, { headers: { 'X-Atris-Runtime-Token': 'gateway-runtime-secret' } });
      const body = await res.json();
      assert(res.status === 200 && body.status === 'ok' && typeof body.timestamp === 'string', 'GET /health returns 200 OK with status and timestamp');
    }

    // 2. POST & GET /api/workspaces
    let createdWorkspaceId = '';
    {
      const createRes = await authorizedFetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Gateway Workspace', path: process.cwd(), gitInitialized: true }),
      });
      const createBody = await createRes.json();
      assert(createRes.status === 201 && typeof createBody.id === 'string', 'POST /api/workspaces creates workspace with ID');
      createdWorkspaceId = createBody.id;

      const listRes = await authorizedFetch(`${baseUrl}/api/workspaces`);
      const listBody = await listRes.json();
      assert(listRes.status === 200 && Array.isArray(listBody) && listBody.some((w: any) => w.id === createdWorkspaceId), 'GET /api/workspaces returns array containing created workspace');
    }

    // 3. POST & GET /api/missions
    let createdMissionId = '';
    {
      const createRes = await authorizedFetch(`${baseUrl}/api/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: createdWorkspaceId,
          title: 'Test Mission Title',
          description: 'Testing mission creation',
          executionMode: 'balanced',
        }),
      });
      const createBody = await createRes.json();
      assert(createRes.status === 201 && typeof createBody.id === 'string', 'POST /api/missions creates mission');
      createdMissionId = createBody.id;

      const listRes = await authorizedFetch(`${baseUrl}/api/missions?workspaceId=${createdWorkspaceId}`);
      const listBody = await listRes.json();
      assert(listRes.status === 200 && Array.isArray(listBody) && listBody.some((m: any) => m.id === createdMissionId), 'GET /api/missions returns missions for workspace');
    }

    // 4. GET & POST /api/accounts
    let createdAccountId = '';
    {
      const createRes = await authorizedFetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'anthropic',
          runtimeType: 'claude_code',
          profileName: 'Gateway Claude Profile',
          configDir: '/tmp/claude',
          supportedModels: ['claude-3-7-sonnet'],
        }),
      });
      const createBody = await createRes.json();
      assert(createRes.status === 201 && typeof createBody.id === 'string', 'POST /api/accounts creates account profile');
      createdAccountId = createBody.id;

      const listRes = await authorizedFetch(`${baseUrl}/api/accounts`);
      const listBody = await listRes.json();
      assert(listRes.status === 200 && Array.isArray(listBody) && listBody.some((a: any) => a.id === createdAccountId), 'GET /api/accounts returns list of account profiles');
    }

    // 5. POST /api/runtimes/discover
    {
      const res = await authorizedFetch(`${baseUrl}/api/runtimes/discover`, { method: 'POST' });
      const body = await res.json();
      const validRuntimeStatuses = Array.isArray(body)
        && body.length > 0
        && body.every((item: any) =>
          typeof item.runtimeType === 'string'
          && typeof item.name === 'string'
          && typeof item.installation?.installed === 'boolean'
        );
      assert(res.status === 200 && validRuntimeStatuses, 'POST /api/runtimes/discover returns normalized runtime installation statuses');
    }

    // 6. Team template CRUD and role policy persistence
    let teamTemplateId = '';
    {
      const customTemplateName = `Custom Security Team ${Date.now()}`;
      const listRes = await authorizedFetch(`${baseUrl}/api/team-templates`);
      const listBody = await listRes.json();
      assert(listRes.status === 200 && Array.isArray(listBody) && listBody.length > 0, 'GET /api/team-templates returns team templates including defaults');
      teamTemplateId = listBody[0]?.id || '';

      const createRes = await authorizedFetch(`${baseUrl}/api/team-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: customTemplateName,
          description: 'Specialized security team',
          roles: [{ role: 'reviewer', accessLevel: 'read', defaultCapabilities: ['security-audit'] }],
        }),
      });
      const createBody = await createRes.json();
      assert(createRes.status === 201 && typeof createBody.id === 'string', 'POST /api/team-templates creates custom team template');

      const policyRes = await authorizedFetch(`${baseUrl}/api/execution-policies/team_template/${encodeURIComponent(teamTemplateId)}/builder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectionMode: 'prefer',
          accountProfileId: createdAccountId,
          reasoningLevel: 'high',
          fallbackCatalogIds: ['claude_code:test:fallback'],
        }),
      });
      const policyBody = await policyRes.json();
      assert(policyRes.status === 200 && policyBody.success === true && Array.isArray(policyBody.policies), 'PUT execution policy persists a role-scoped route');

      const policyListRes = await authorizedFetch(`${baseUrl}/api/execution-policies/team_template/${encodeURIComponent(teamTemplateId)}`);
      const policyList = await policyListRes.json();
      const builderPolicy = Array.isArray(policyList) ? policyList.find((policy: any) => policy.role === 'builder') : undefined;
      assert(
        policyListRes.status === 200
        && builderPolicy?.selectionMode === 'prefer'
        && builderPolicy?.accountProfileId === createdAccountId
        && builderPolicy?.reasoningLevel === 'high'
        && builderPolicy?.fallbackCatalogIds?.[0] === 'claude_code:test:fallback',
        'GET execution policies restores account, reasoning and ordered fallback fields',
      );
    }

    // 7. SSE (/api/events/stream) Event Stream Verification
    {
      const sseReceived = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => resolve(false), 3000);
         const req = http.get(`${baseUrl}/api/events/stream`, { headers: { Authorization: 'Bearer integration-premium-token', 'X-Atris-Runtime-Token': 'gateway-runtime-secret' } }, (res) => {
          assert(res.statusCode === 200 && res.headers['content-type'] === 'text/event-stream', 'GET /api/events/stream responds with 200 text/event-stream header');
          res.on('data', (chunk: Buffer) => {
            const str = chunk.toString('utf-8');
            if (str.includes('sse_test_event')) {
              clearTimeout(timeout);
              req.destroy();
              resolve(true);
            }
          });
        });
        req.on('error', (err) => { clearTimeout(timeout); reject(err); });
        setTimeout(() => {
          eventBus.emit({
            id: crypto.randomUUID(),
            type: 'agent_started',
            missionId: createdMissionId,
            agentInstanceId: 'sse_test_event',
            role: 'builder',
            model: 'claude-3-7-sonnet',
            timestamp: new Date().toISOString(),
          });
        }, 100);
      });
      assert(sseReceived === true, 'SSE stream endpoint broadcasts eventBus events to connected clients');
    }

    // 8. WebSocket (/ws/events) Event Stream Verification
    {
      const rejectedWebSocket = (options: { headers?: Record<string, string>; query?: string }, expectedStatus: number) => new Promise<boolean>((resolve) => {
        let settled = false;
        const ws = new WebSocket(`${wsUrl}${options.query || ''}`, { headers: options.headers });
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        ws.on('unexpected-response', (_request, response) => {
          finish(response.statusCode === expectedStatus);
          response.resume();
        });
        ws.on('error', () => finish(false));
        setTimeout(() => {
          ws.close();
          finish(false);
        }, 1500);
      });
      assert(await rejectedWebSocket({}, 401), 'WebSocket upgrade rejects a missing Authorization header');
      assert(await rejectedWebSocket({ query: '?token=integration-premium-token' }, 401), 'WebSocket upgrade does not accept bearer tokens in the query string');
      assert(await rejectedWebSocket({ headers: { Authorization: 'Bearer integration-invalid-token', 'X-Atris-Runtime-Token': 'gateway-runtime-secret' } }, 401), 'WebSocket upgrade rejects an invalid bearer token');
      assert(await rejectedWebSocket({ headers: { Authorization: 'Bearer integration-free-token', 'X-Atris-Runtime-Token': 'gateway-runtime-secret' } }, 403), 'WebSocket upgrade rejects a verified non-premium account');
      assert(await rejectedWebSocket({ query: '?runtimeToken=gateway-runtime-secret', headers: { Authorization: 'Bearer integration-premium-token', 'X-Atris-Runtime-Token': 'gateway-runtime-secret' } }, 401), 'WebSocket upgrade rejects runtime tokens in the query string');
      assert(await rejectedWebSocket({ headers: { Authorization: 'Bearer integration-premium-token', 'X-Atris-Runtime-Token': 'wrong-runtime-secret' } }, 401), 'WebSocket upgrade rejects a wrong runtime token');

      const wsReceived = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => resolve(false), 3000);
        const ws = new WebSocket(wsUrl, { headers: { Authorization: 'Bearer integration-premium-token', 'X-Atris-Runtime-Token': 'gateway-runtime-secret' } });
        ws.on('open', () => {
          eventBus.emit({
            id: crypto.randomUUID(),
            type: 'text_delta',
            missionId: createdMissionId,
            agentInstanceId: 'ws-test-agent',
            content: 'ws_test_event_result',
            timestamp: new Date().toISOString(),
          });
        });
        ws.on('message', (data: Buffer) => {
          if (data.toString('utf-8').includes('ws_test_event_result')) {
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          }
        });
        ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
      });
      assert(wsReceived === true, 'WebSocket stream broadcasts eventBus events to connected clients');
    }

    // 9. Conversation and workspace deletion
    {
      const cancelRes = await authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}/cancel`, { method: 'POST' });
      const cancelBody = await cancelRes.json();
      assert(cancelRes.status === 200 && cancelBody.status === 'cancelled', 'POST /api/missions/:id/cancel makes a conversation deletable');

      const deleteMissionRes = await authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}`, { method: 'DELETE' });
      assert(deleteMissionRes.status === 200, 'DELETE /api/missions/:id removes a terminal conversation');

      const deletedMissionRes = await authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}`);
      assert(deletedMissionRes.status === 404, 'Deleted conversation is no longer available');

      const childMissionRes = await authorizedFetch(`${baseUrl}/api/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: createdWorkspaceId,
          title: 'Workspace cascade conversation',
          description: 'Verifies workspace deletion removes its conversations and events.',
        }),
      });
      const childMission = await childMissionRes.json();
      const childMissionId = childMission.id as string;
      eventBus.emit({
        id: crypto.randomUUID(),
        type: 'agent_started',
        missionId: childMissionId,
        agentInstanceId: 'workspace-cascade-agent',
        role: 'builder',
        model: 'test-model',
        timestamp: new Date().toISOString(),
      });

      const deleteWorkspaceRes = await authorizedFetch(`${baseUrl}/api/workspaces/${createdWorkspaceId}`, { method: 'DELETE' });
      assert(deleteWorkspaceRes.status === 200, 'DELETE /api/workspaces/:id removes a workspace with its conversations');

      const deletedWorkspaceRes = await authorizedFetch(`${baseUrl}/api/workspaces/${createdWorkspaceId}`);
      assert(deletedWorkspaceRes.status === 404, 'Deleted workspace is no longer available');
      const cascadedMissionsRes = await authorizedFetch(`${baseUrl}/api/missions?workspaceId=${createdWorkspaceId}`);
      const cascadedMissions = await cascadedMissionsRes.json();
      assert(cascadedMissionsRes.status === 200 && Array.isArray(cascadedMissions) && !cascadedMissions.some((mission: any) => mission.id === childMissionId), 'Workspace deletion cascades its conversation records');
      const cascadedEventsRes = await authorizedFetch(`${baseUrl}/api/missions/${childMissionId}/events`);
      const cascadedEvents = await cascadedEventsRes.json();
      assert(cascadedEventsRes.status === 200 && Array.isArray(cascadedEvents) && cascadedEvents.length === 0, 'Workspace deletion cascades mission events');
    }
  } finally {
    if (shouldCloseServer && server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (hubServer.listening) {
      await new Promise<void>((resolve) => hubServer.close(() => resolve()));
    }
  }

  console.log(`\nAPI Gateway Test Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('API Gateway test execution error:', err);
  process.exit(1);
});

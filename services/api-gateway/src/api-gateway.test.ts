import http from 'http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';

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
  await gateway.startupRecovery;
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
  let createdTeamTemplateId = '';

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

    // 2b. Agent profile catalog CRUD and scoped binding behavior
    {
      const unauthenticated = await fetch(`${baseUrl}/api/agent-profiles`);
      assert(unauthenticated.status === 401, 'agent profile catalog requires authenticated Premium access');

      const createRes = await authorizedFetch(`${baseUrl}/api/agent-profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Gateway Builder Profile',
          role: 'builder',
          instructions: 'Build safely and report verification.',
          capabilities: ['coding', 'verification'],
        }),
      });
      const created = await createRes.json();
      assert(createRes.status === 201 && typeof created.id === 'string' && created.role === 'builder'
        && created.instructions === 'Build safely and report verification.'
        && created.secret === undefined && created.configDir === undefined,
      'POST /api/agent-profiles creates a safe fixed-role catalog record');

      const profileId = created.id as string;
      const listRes = await authorizedFetch(`${baseUrl}/api/agent-profiles`);
      const listed = await listRes.json();
      assert(listRes.status === 200 && listed.some((profile: any) => profile.id === profileId),
        'GET /api/agent-profiles returns the created profile');

      const patchRes = await authorizedFetch(`${baseUrl}/api/agent-profiles/${encodeURIComponent(profileId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Gateway integration profile' }),
      });
      const patched = await patchRes.json();
      assert(patchRes.status === 200 && patched.id === profileId && patched.role === 'builder'
        && patched.description === 'Gateway integration profile',
      'PATCH /api/agent-profiles updates mutable fields while preserving fixed role');

      const wrongRoleBinding = await authorizedFetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspaceId)}/agent-profile-bindings/reviewer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, isDefault: true }),
      });
      const wrongRoleBody = await wrongRoleBinding.json();
      assert(wrongRoleBinding.status === 400 && wrongRoleBody.code === 'AGENT_PROFILE_ROLE_MISMATCH',
        'scoped binding rejects a profile assigned to the wrong fixed role');

      const bindRes = await authorizedFetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspaceId)}/agent-profile-bindings/builder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, isDefault: true }),
      });
      const binding = await bindRes.json();
      const bindingsRes = await authorizedFetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspaceId)}/agent-profile-bindings`);
      const bindings = await bindingsRes.json();
      assert(bindRes.status === 200 && binding.profileId === profileId && binding.role === 'builder'
        && bindingsRes.status === 200 && bindings.some((item: any) => item.profileId === profileId && item.isDefault === true),
      'workspace-scoped profile binding persists and serializes safely');

      const archiveRes = await authorizedFetch(`${baseUrl}/api/agent-profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
      const archived = await archiveRes.json();
      const hiddenRes = await authorizedFetch(`${baseUrl}/api/agent-profiles/${encodeURIComponent(profileId)}`);
      assert(archiveRes.status === 200 && archived.archivedAt && hiddenRes.status === 404,
        'DELETE /api/agent-profiles soft-archives and hides the profile by default');
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

      await gateway.configureMissionRouting(createdMissionId, {
        modelCatalogId: 'catalog-shared-model',
        reasoningLevel: 'high',
        routeScope: 'mission',
      });
      const durableRoles = ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'] as const;
      const durablePolicies = await Promise.all(durableRoles.map((role) => gateway.workspaceManager.resolveRoleExecutionPolicy(createdMissionId, role)));
      assert(durablePolicies.every((policy) => policy?.modelCatalogId === 'catalog-shared-model'
        && policy.selectionMode === 'fixed' && policy.source === 'mission'),
      'mission-wide exact model routing is durably persisted for every agent role');
      gateway.runtimeHost.clearMissionRoutingPreference(createdMissionId, false);
      const restartPolicy = await gateway.workspaceManager.resolveRoleExecutionPolicy(createdMissionId, 'builder');
      assert(restartPolicy?.modelCatalogId === 'catalog-shared-model' && restartPolicy.selectionMode === 'fixed',
        'persisted mission-wide Builder routing survives loss of the runtime in-memory preference');
    }

    // Public mission starts must acknowledge durable acceptance without waiting
    // for provider startup, and a retry with the same client id must not create
    // a second mission or conversation turn.
    {
      const clientMessageId = `public-start-${crypto.randomUUID()}`;
      const requestStartedAt = performance.now();
      const acceptedRes = await authorizedFetch(`${baseUrl}/api/missions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMessageId },
        body: JSON.stringify({
          workspaceId: createdWorkspaceId,
          request: 'Public durable mission-start contract test',
          clientMessageId,
        }),
      });
      const accepted = await acceptedRes.json();
      const requestDurationMs = performance.now() - requestStartedAt;
      assert(acceptedRes.status === 202 && accepted.accepted === true && typeof accepted.missionId === 'string'
        && typeof accepted.turnId === 'string' && requestDurationMs < 2_000,
      'public mission start returns durable acceptance without waiting for provider startup');

      const duplicateRes = await authorizedFetch(`${baseUrl}/api/missions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clientMessageId },
        body: JSON.stringify({
          workspaceId: createdWorkspaceId,
          request: 'Public durable mission-start contract test',
          clientMessageId,
        }),
      });
      const duplicate = await duplicateRes.json();
      assert(duplicateRes.status === 200 && duplicate.duplicate === true && duplicate.missionId === accepted.missionId
        && duplicate.turnId === accepted.turnId,
      'public mission start idempotency returns the original mission and turn');

      await new Promise((resolve) => setTimeout(resolve, 25));
      const acceptedEventsRes = await authorizedFetch(`${baseUrl}/api/missions/${accepted.missionId}/events`);
      const acceptedEvents = await acceptedEventsRes.json();
      assert(acceptedEvents.some((event: any) => event.type === 'turn_queued' && event.turnId === accepted.turnId),
        'public mission start persists a turn_queued event before provider execution');
      const acceptedUserMessages = acceptedEvents.filter((event: any) => event.type === 'user_message');
      assert(acceptedUserMessages.length === 1 && acceptedUserMessages[0].clientMessageId === clientMessageId,
        'public mission start preserves client message identity for optimistic timeline reconciliation');
    }

    // Start and continuation turns must have one durable, turn-correlated user message.
    let durableMissionId = '';
    {
      const createRes = await authorizedFetch(`${baseUrl}/api/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: createdWorkspaceId, title: 'Durable conversation turn test' }),
      });
      const mission = await createRes.json();
      durableMissionId = mission.id;

      const firstStart = await authorizedFetch(`${baseUrl}/api/missions/${durableMissionId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 'Please clarify this request' }),
      });
      assert(firstStart.status === 200, 'starting a conversation turn succeeds');
      const firstEventsResponse = await authorizedFetch(`${baseUrl}/api/missions/${durableMissionId}/events`);
      const firstEvents = await firstEventsResponse.json();
      const firstMessages = firstEvents.filter((event: any) => event.type === 'user_message' && event.content === 'Please clarify this request');
      assert(firstMessages.length === 1 && typeof firstMessages[0]?.turnId === 'string',
        'initial start persists exactly one user_message with turnId');

      const continuation = await authorizedFetch(`${baseUrl}/api/missions/${durableMissionId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 'Please clarify this follow-up' }),
      });
      assert(continuation.status === 200, 'starting a continuation turn succeeds');
      const continuationEventsResponse = await authorizedFetch(`${baseUrl}/api/missions/${durableMissionId}/events`);
      const continuationEvents = await continuationEventsResponse.json();
      const continuationMessages = continuationEvents.filter((event: any) => event.type === 'user_message');
      const followUpMessages = continuationMessages.filter((event: any) => event.content === 'Please clarify this follow-up');
      assert(followUpMessages.length === 1 && typeof followUpMessages[0]?.turnId === 'string'
        && new Set(continuationMessages.map((event: any) => event.turnId)).size === continuationMessages.length,
      'continuation persists one new turn-correlated user_message without duplicating history');
    }

    // Direct start is fenced atomically while a research turn is active, and an
    // implementation follow-up sent as steer is durably queued as a new turn.
    {
      const createRes = await authorizedFetch(`${baseUrl}/api/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: createdWorkspaceId, title: 'Active research turn fence test' }),
      });
      const mission = await createRes.json();
      const missionId = mission.id as string;
      const db = (gateway.workspaceManager as any).db;
      const { conversationTurns, missionRuns, tasks } = await import('@atris-agent-code/database');
      const now = new Date().toISOString();
      const activeTurnId = `research-turn-${Date.now()}`;
      const activeRunId = `research-run-${Date.now()}`;
      const activePlanId = `research-plan-${Date.now()}`;
      db.insert(conversationTurns).values({
        id: activeTurnId, missionId, content: 'Research the options', delivery: 'queue', options: {}, status: 'running', createdAt: now, startedAt: now,
      }).run();
      db.insert(missionRuns).values({
        id: activeRunId, missionId, turnId: activeTurnId, status: 'running', planId: activePlanId, startedAt: now, heartbeatAt: now,
      }).run();
      db.insert(tasks).values({
        id: `research-task-${Date.now()}`, missionId, planId: activePlanId, title: 'Research', description: 'Research only', status: 'running',
        priority: 'medium', assignedRole: 'researcher', requiredCapabilities: ['research'], dependsOn: [], createdAt: now, updatedAt: now,
      }).run();
      await gateway.workspaceManager.updateMission(missionId, { status: 'running', activeRunId, planId: activePlanId });

      const turnsBefore = db.select().from(conversationTurns).all().filter((row: any) => row.missionId === missionId).length;
      const runsBefore = db.select().from(missionRuns).all().filter((row: any) => row.missionId === missionId).length;
      const rejectedStart = await authorizedFetch(`${baseUrl}/api/missions/${missionId}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: 'Build this now' }),
      });
      const rejectedBody = await rejectedStart.json();
      const turnsAfter = db.select().from(conversationTurns).all().filter((row: any) => row.missionId === missionId).length;
      const runsAfter = db.select().from(missionRuns).all().filter((row: any) => row.missionId === missionId).length;
      assert(rejectedStart.status === 409 && rejectedBody.code === 'TURN_ALREADY_RUNNING' && turnsAfter === turnsBefore && runsAfter === runsBefore,
        'direct start atomically rejects an active run before creating a turn or run');

      const followUp = await authorizedFetch(`${baseUrl}/api/missions/${missionId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Implement the researched approach and update the tests.', delivery: 'steer', options: { targetRole: 'builder' } }),
      });
      const followUpBody = await followUp.json();
      assert(followUp.status === 202 && followUpBody.delivery === 'queue' && followUpBody.status === 'queued'
        && followUpBody.requiresNewTurn === true && followUpBody.disposition === 'queued_new_turn',
      'implementation intent during active research is durably queued for a new same-conversation turn instead of consumed by steer');

      const routingFollowUp = await authorizedFetch(`${baseUrl}/api/missions/${missionId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Keep every agent on this exact model.',
          delivery: 'steer',
          options: { modelCatalogId: 'catalog-shared-model', routeScope: 'mission', reasoningLevel: 'high' },
        }),
      });
      const routingFollowUpBody = await routingFollowUp.json();
      assert(routingFollowUp.status === 202 && routingFollowUpBody.delivery === 'queue'
        && routingFollowUpBody.requiresNewTurn === true && routingFollowUpBody.disposition === 'queued_new_turn',
      'mission routing changes requested as steer are queued as a durable new turn instead of being silently ignored');

      const planningCreateRes = await authorizedFetch(`${baseUrl}/api/missions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: createdWorkspaceId, title: 'Planning window steer test' }),
      });
      const planningMission = await planningCreateRes.json();
      const planningMissionId = planningMission.id as string;
      const planningTurnId = `planning-turn-${Date.now()}`;
      const planningRunId = `planning-run-${Date.now()}`;
      db.insert(conversationTurns).values({
        id: planningTurnId, missionId: planningMissionId, content: 'Research the options', delivery: 'queue', options: {}, status: 'starting', createdAt: now, startedAt: now,
      }).run();
      db.insert(missionRuns).values({
        id: planningRunId, missionId: planningMissionId, turnId: planningTurnId, status: 'starting', planId: null, startedAt: now, heartbeatAt: now,
      }).run();
      await gateway.workspaceManager.updateMission(planningMissionId, { status: 'planning', activeRunId: planningRunId, planId: null });

      const planningFollowUp = await authorizedFetch(`${baseUrl}/api/missions/${planningMissionId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Implement the selected approach.', delivery: 'steer', options: { targetRole: 'builder' } }),
      });
      const planningFollowUpBody = await planningFollowUp.json();
      assert(planningFollowUp.status === 202 && planningFollowUpBody.delivery === 'queue' && planningFollowUpBody.status === 'queued'
        && planningFollowUpBody.requiresNewTurn === true && planningFollowUpBody.disposition === 'queued_new_turn',
      'implementation steer during the starting plan-null window is conservatively queued');
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
          maxParallelAgents: 2,
          workerPools: [{ role: 'reviewer', minInstances: 0, maxInstances: 1, maxParallel: 1 }],
        }),
      });
      const createBody = await createRes.json();
      createdTeamTemplateId = typeof createBody.id === 'string' ? createBody.id : '';
      assert(createRes.status === 201 && typeof createBody.id === 'string' && createBody.maxParallelAgents === 2
        && createBody.workerPools?.find((pool: any) => pool.role === 'reviewer')?.maxParallel === 1,
      'POST /api/team-templates persists normalized global and role worker limits');

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

      const mission = await gateway.workspaceManager.createMission({ id: `route-mission-${Date.now()}`, workspaceId: createdWorkspaceId, title: 'Route read model' });
      const task = await gateway.workspaceManager.createTask({ id: `${mission.id}-task`, missionId: mission.id, title: 'Inspect route', assignedRole: 'researcher' });
      await gateway.workspaceManager.claimTaskAttempt({ taskId: task.id, missionId: mission.id, agentInstanceId: 'route-agent',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), route: { adapterId: 'codex', provider: 'openai', accountProfileId: 'account-public-id',
          modelCatalogId: 'catalog-route', runtimeModelId: 'gpt-route', reasoningLevel: 'high', source: 'mission', selectionMode: 'fixed' } });
      const missionRes = await authorizedFetch(`${baseUrl}/api/missions/${encodeURIComponent(mission.id)}`);
      const missionBody = await missionRes.json();
      const exposedRoute = missionBody.tasks?.find((item: any) => item.id === task.id)?.effectiveRoute;
      assert(missionRes.status === 200 && exposedRoute?.adapterId === 'codex' && exposedRoute?.provider === 'openai'
        && exposedRoute?.accountProfileId === 'account-public-id' && exposedRoute?.modelCatalogId === 'catalog-route'
        && exposedRoute?.runtimeModelId === 'gpt-route' && exposedRoute?.reasoningLevel === 'high'
        && exposedRoute?.source === 'mission' && exposedRoute?.selectionMode === 'fixed' && exposedRoute.providerSessionId === undefined,
      'GET /api/missions/:id exposes the latest effective task route without provider session data');
    }

    // 7. SSE (/api/events/stream) Event Stream Verification
    {
      const firstEventId = crypto.randomUUID();
      const secondEventId = crypto.randomUUID();
      const otherMissionResponse = await authorizedFetch(`${baseUrl}/api/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: createdWorkspaceId, title: 'SSE filter control mission' }),
      });
      const otherMission = await otherMissionResponse.json();
      eventBus.emit({ id: firstEventId, type: 'agent_progressed', missionId: createdMissionId,
        agentInstanceId: 'sequence-agent', progress: 'first', timestamp: new Date().toISOString() });
      eventBus.emit({ id: secondEventId, type: 'agent_progressed', missionId: createdMissionId,
        agentInstanceId: 'sequence-agent', progress: 'second', timestamp: new Date().toISOString() });
      const thirdEventId = crypto.randomUUID();
      eventBus.emit({ id: thirdEventId, type: 'agent_progressed', missionId: createdMissionId,
        agentInstanceId: 'sequence-agent', progress: 'third', timestamp: new Date().toISOString() });
      eventBus.emit({ id: crypto.randomUUID(), type: 'agent_progressed', missionId: otherMission.id,
        agentInstanceId: 'other-agent', progress: 'filtered', timestamp: new Date().toISOString() });
      const eventsRes = await authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}/events`);
      const persistedEvents = await eventsRes.json();
      const first = persistedEvents.find((event: any) => event.id === firstEventId);
      const second = persistedEvents.find((event: any) => event.id === secondEventId);
      assert(first?.sequence < second?.sequence && second?.schemaVersion === 1, 'mission events receive monotonic sequence and schema version');
      const afterRes = await authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}/events?afterSequence=${first.sequence}`);
      const afterEvents = await afterRes.json();
      assert(afterEvents.some((event: any) => event.id === secondEventId) && !afterEvents.some((event: any) => event.id === firstEventId), 'mission event replay honors afterSequence');
      const pageRes = await authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}/events?afterSequence=${first.sequence}&limit=1`);
      const pageEvents = await pageRes.json();
      const nextCursor = pageRes.headers.get('X-Next-Cursor');
      assert(pageEvents.length === 1 && pageEvents[0]?.id === secondEventId && Boolean(nextCursor), 'mission event endpoint returns bounded cursor pages');
      const nextPageRes = await authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}/events?cursor=${encodeURIComponent(nextCursor || '')}&limit=1`);
      const nextPage = await nextPageRes.json();
      assert(nextPage.length === 1 && nextPage[0]?.id === thirdEventId, 'mission event cursor resumes from the previous page without duplicates');

      const paginationMissionResponse = await authorizedFetch(`${baseUrl}/api/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: createdWorkspaceId, title: 'Cursor pagination CORS mission' }),
      });
      const paginationMission = await paginationMissionResponse.json();
      for (let index = 0; index < 501; index += 1) {
        eventBus.emit({ id: crypto.randomUUID(), type: 'agent_progressed', missionId: paginationMission.id,
          agentInstanceId: 'pagination-agent', progress: `page-${index}`, timestamp: new Date().toISOString() });
      }
      const originHeaders = { Origin: 'http://127.0.0.1:1420' };
      const boundedPageResponse = await authorizedFetch(`${baseUrl}/api/missions/${paginationMission.id}/events?limit=500`, { headers: originHeaders });
      const boundedPage = await boundedPageResponse.json();
      const boundedCursor = boundedPageResponse.headers.get('X-Next-Cursor');
      const exposedHeaders = boundedPageResponse.headers.get('Access-Control-Expose-Headers') || '';
      assert(boundedPageResponse.status === 200 && boundedPage.length === 500
        && boundedPageResponse.headers.get('Access-Control-Allow-Origin') === originHeaders.Origin
        && boundedPageResponse.headers.get('X-Has-More') === 'true'
        && Boolean(boundedCursor) && /(^|,\s*)x-next-cursor(,|$)/i.test(exposedHeaders)
        && /(^|,\s*)x-has-more(,|$)/i.test(exposedHeaders),
      'Origin responses expose cursor headers for bounded mission event pages');
      const finalPageResponse = await authorizedFetch(`${baseUrl}/api/missions/${paginationMission.id}/events?cursor=${encodeURIComponent(boundedCursor || '')}&limit=500`, { headers: originHeaders });
      const finalPage = await finalPageResponse.json();
      assert(finalPageResponse.status === 200 && finalPage.length === 1 && finalPageResponse.headers.get('X-Has-More') === 'false'
        && !finalPageResponse.headers.get('X-Next-Cursor'),
      'Mission event cursor retrieves the remainder after a 500-row page');

      const replayReceived = await new Promise<boolean>((resolve) => {
        const request = http.get(`${baseUrl}/api/events/stream?missionId=${createdMissionId}&afterSequence=${first.sequence}`,
          { headers: { Authorization: 'Bearer integration-premium-token', 'X-Atris-Runtime-Token': 'gateway-runtime-secret' } }, (response) => {
            response.on('data', (chunk: Buffer) => {
              const text = chunk.toString();
              if (text.includes(secondEventId)) {
                request.destroy();
                resolve(!text.includes('filtered'));
              }
            });
          });
        setTimeout(() => { request.destroy(); resolve(false); }, 2000);
      });
      assert(replayReceived, 'SSE replays persisted mission events and filters other missions');

      const verifyBoundedReplay = async (eventCount: number, payloadSize: number, emitDuringReplay: boolean) => {
        const missionResponse = await authorizedFetch(`${baseUrl}/api/missions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: createdWorkspaceId, title: `SSE replay ${eventCount} ${payloadSize}` }),
        });
        const mission = await missionResponse.json();
        const expected: number[] = [];
        for (let index = 0; index < eventCount; index++) {
          const event: any = {
            id: crypto.randomUUID(),
            type: 'agent_progressed',
            missionId: mission.id,
            agentInstanceId: 'replay-agent',
            progress: payloadSize ? `${index}:${'x'.repeat(payloadSize)}` : String(index),
            timestamp: new Date().toISOString(),
          };
          eventBus.emit(event);
          expected.push(index + 1);
        }

        const received = await new Promise<number[]>((resolve, reject) => {
          const sequences: number[] = [];
          let buffer = '';
          let emittedLive = false;
          const timeout = setTimeout(() => {
            request.destroy();
            reject(new Error(`Timed out after receiving ${sequences.length}/${eventCount + Number(emitDuringReplay)} replay events`));
          }, 15_000);
          const request = http.get(`${baseUrl}/api/events/stream?missionId=${mission.id}&afterSequence=0`,
            { headers: { Authorization: 'Bearer integration-premium-token', 'X-Atris-Runtime-Token': 'gateway-runtime-secret' } }, (response) => {
              response.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf8');
                let boundary = buffer.indexOf('\n\n');
                while (boundary >= 0) {
                  const frame = buffer.slice(0, boundary);
                  buffer = buffer.slice(boundary + 2);
                  const data = frame.split('\n').find((line) => line.startsWith('data: '));
                  if (data) sequences.push(Number(JSON.parse(data.slice(6)).sequence));
                  boundary = buffer.indexOf('\n\n');
                }
                if (emitDuringReplay && !emittedLive && sequences.length > 0) {
                  emittedLive = true;
                  const event: any = {
                    id: crypto.randomUUID(), type: 'agent_progressed', missionId: mission.id,
                    agentInstanceId: 'live-during-replay', progress: 'live', timestamp: new Date().toISOString(),
                  };
                  eventBus.emit(event);
                }
                if (sequences.length === eventCount + Number(emitDuringReplay)) {
                  clearTimeout(timeout);
                  request.destroy();
                  resolve(sequences);
                }
              });
            });
          request.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ECONNRESET') reject(error);
          });
        });
        return { expected: expected.slice(0, eventCount), received };
      };

      const smallReplay = await verifyBoundedReplay(2_101, 0, true);
      assert(smallReplay.received.slice(0, 2_101).every((sequence, index) => sequence === smallReplay.expected[index])
        && new Set(smallReplay.received).size === 2_102
        && smallReplay.received[2_101] === smallReplay.expected[2_100]! + 1,
      'SSE streams more than 2000 replay events through high-water exactly once in order, then drains concurrent live events');

      const largeReplay = await verifyBoundedReplay(9, 950_000, false);
      assert(largeReplay.received.length === largeReplay.expected.length
        && largeReplay.received.every((sequence, index) => sequence === largeReplay.expected[index]),
      'SSE streams bounded replay payloads larger than the 8 MiB live queue exactly once in order');

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

    // Durable queued messages and idempotency
    {
      await gateway.workspaceManager.updateMission(createdMissionId, { status: 'running' });
      const key = `queue-${Date.now()}`;
      const requestMessage = () => authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ content: 'Run this after the active turn', delivery: 'queue', options: { targetRole: 'builder' } }),
      });
      const firstResponse = await requestMessage();
      const firstTurn = await firstResponse.json();
      const duplicateResponse = await requestMessage();
      const duplicateTurn = await duplicateResponse.json();
      assert(firstResponse.status === 202 && duplicateResponse.status === 200 && firstTurn.id === duplicateTurn.id,
        'queued message is durable and Idempotency-Key returns the existing turn');
      assert(firstTurn.commandId === duplicateTurn.commandId && !('mission_id' in duplicateTurn) && duplicateTurn.missionId === createdMissionId,
        'initial and idempotent message responses share one normalized DTO');
      const conflictingResponse = await authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ content: 'Different content must not reuse the key', delivery: 'queue' }),
      });
      assert(conflictingResponse.status === 409, 'Idempotency-Key reuse with different content is rejected');
      const queueResponse = await authorizedFetch(`${baseUrl}/api/mission-commands?workspaceId=${encodeURIComponent(createdWorkspaceId)}`);
      const queueBody = await queueResponse.json();
      assert(queueResponse.status === 200 && queueBody.items.some((item: any) => item.id === firstTurn.commandId && item.preview.includes('Run this after')),
        'workspace command queue exposes the durable pending follow-up');
      const { conversationTurns: cursorConversationTurns, missionCommands: cursorMissionCommands } = await import('@atris-agent-code/database');
      const queueDb = (gateway.workspaceManager as any).db;
      const cursorSeed = Date.now();
      const cursorRows = [
        { suffix: 'a', priority: 90, content: 'Cursor page A' },
        { suffix: 'b', priority: 80, content: 'Cursor page B' },
      ];
      for (const row of cursorRows) {
        const turnId = `cursor-turn-${cursorSeed}-${row.suffix}`;
        const commandId = `cursor-command-${cursorSeed}-${row.suffix}`;
        const createdAt = new Date(cursorSeed + (row.suffix === 'a' ? 1 : 2)).toISOString();
        queueDb.insert(cursorConversationTurns).values({
          id: turnId, missionId: createdMissionId, content: row.content, delivery: 'queue',
          options: {}, status: 'queued', createdAt,
        }).run();
        queueDb.insert(cursorMissionCommands).values({
          id: commandId, missionId: createdMissionId, turnId, type: 'queue', status: 'pending',
          priority: row.priority, createdAt,
        }).run();
      }
      const firstQueuePageResponse = await authorizedFetch(`${baseUrl}/api/mission-commands?workspaceId=${encodeURIComponent(createdWorkspaceId)}&limit=1`);
      const firstQueuePage = await firstQueuePageResponse.json();
      const queueCursor = firstQueuePageResponse.headers.get('X-Next-Cursor');
      const secondQueuePageResponse = await authorizedFetch(`${baseUrl}/api/mission-commands?workspaceId=${encodeURIComponent(createdWorkspaceId)}&limit=1&cursor=${encodeURIComponent(queueCursor || '')}`);
      const secondQueuePage = await secondQueuePageResponse.json();
      assert(firstQueuePageResponse.status === 200 && firstQueuePage.items.length === 1 && Boolean(queueCursor),
        'mission command queue returns a bounded page and deterministic next cursor');
      assert(secondQueuePageResponse.status === 200 && secondQueuePage.items.length === 1
        && secondQueuePage.items[0].id !== firstQueuePage.items[0].id,
      'mission command cursor resumes after the previous item without duplicates');
      const eventsResponse = await authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}/events`);
      const events = await eventsResponse.json();
      assert(Array.isArray(events) && !events.some((event: any) => event.type === 'user_message' && event.turnId === firstTurn.id),
        'queued follow-up is not exposed as active conversation context before execution starts');

      const { approvals } = await import('@atris-agent-code/database');
      const approvalId = `approval-race-${Date.now()}`;
      (gateway.workspaceManager as any).db.insert(approvals).values({
        id: approvalId,
        missionId: createdMissionId,
        type: 'plan',
        description: 'Concurrent decision test',
        status: 'pending',
        createdAt: new Date().toISOString(),
      }).run();
      const decide = () => authorizedFetch(`${baseUrl}/api/approvals/${approvalId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'rejected' }),
      });
      const decisions = await Promise.all([decide(), decide()]);
      assert(decisions.map((response) => response.status).sort().join(',') === '200,409',
        'concurrent approval decisions atomically claim one execution');

      const reconcileApprovalId = `reconcile-approval-${Date.now()}`;
      (gateway.workspaceManager as any).db.insert(approvals).values({
        id: reconcileApprovalId,
        missionId: createdMissionId,
        type: 'tool_call',
        description: 'Interrupted external approval test',
        status: 'pending',
        createdAt: new Date().toISOString(),
      }).run();
      const interruptedDecision = await authorizedFetch(`${baseUrl}/api/approvals/${reconcileApprovalId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      });
      const interruptedApproval = (gateway.workspaceManager as any).db.select().from(approvals)
        .where(eq(approvals.id, reconcileApprovalId)).all()[0];
      assert(interruptedDecision.status === 400 && interruptedApproval.status === 'reconcile_required',
        'failed external approval execution remains explicitly unresolved');
      const reconciled = await authorizedFetch(`${baseUrl}/api/approvals/${reconcileApprovalId}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'not_applied' }),
      });
      const reconciledApproval = (gateway.workspaceManager as any).db.select().from(approvals)
        .where(eq(approvals.id, reconcileApprovalId)).all()[0];
      assert(reconciled.status === 200 && reconciledApproval.status === 'pending',
        'manual not-applied reconciliation safely returns an approval to pending');

      // stop_and_replan must fence the old run without cancelling the newly queued command.
      const stopMissionResponse = await authorizedFetch(`${baseUrl}/api/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: createdWorkspaceId, title: 'Stop and replan fence test' }),
      });
      const stopMission = await stopMissionResponse.json();
      const stopMissionId = stopMission.id as string;
      const stopDb = (gateway.workspaceManager as any).db;
      const { conversationTurns, missionCommands, missionRuns } = await import('@atris-agent-code/database');
      const activeTurnId = `active-turn-${Date.now()}`;
      const activeRunId = `active-run-${Date.now()}`;
      const activeCommandId = `active-command-${Date.now()}`;
      const stopNow = new Date().toISOString();
      stopDb.insert(conversationTurns).values({
        id: activeTurnId,
        missionId: stopMissionId,
        content: 'Old active request',
        delivery: 'queue',
        options: {},
        status: 'running',
        createdAt: stopNow,
        startedAt: stopNow,
      }).run();
      stopDb.insert(missionCommands).values({
        id: activeCommandId,
        missionId: stopMissionId,
        turnId: activeTurnId,
        type: 'queue',
        status: 'processing',
        priority: 0,
        createdAt: stopNow,
      }).run();
      stopDb.insert(missionRuns).values({
        id: activeRunId,
        missionId: stopMissionId,
        turnId: activeTurnId,
        commandId: activeCommandId,
        status: 'running',
        planId: 'old-plan',
        startedAt: stopNow,
        heartbeatAt: stopNow,
      }).run();
      await gateway.workspaceManager.updateMission(stopMissionId, { status: 'running', activeRunId });

      const stopResponse = await authorizedFetch(`${baseUrl}/api/missions/${stopMissionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Replan this conversation', delivery: 'stop_and_replan' }),
      });
      const stopTurn = await stopResponse.json();
      assert(stopResponse.status === 202 && stopTurn.status !== 'cancelled',
        'stop_and_replan leaves the newly queued turn claimable');

      let replannedCommand: any;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        replannedCommand = (stopDb.select().from(missionCommands).where(eq(missionCommands.id, stopTurn.commandId)).all() as any[])[0];
        if (replannedCommand?.status === 'completed' || replannedCommand?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const stoppedRun = (stopDb.select().from(missionRuns).where(eq(missionRuns.id, activeRunId)).all() as any[])[0];
      const stoppedTurn = (stopDb.select().from(conversationTurns).where(eq(conversationTurns.id, activeTurnId)).all() as any[])[0];
      const stopEventsResponse = await authorizedFetch(`${baseUrl}/api/missions/${stopMissionId}/events`);
      const stopEvents = await stopEventsResponse.json();
      const replannedMessages = stopEvents.filter((event: any) => event.type === 'user_message' && event.turnId === stopTurn.id);
      assert(replannedCommand?.status === 'completed' && stoppedRun?.status === 'cancelled' && stoppedTurn?.status === 'cancelled',
        'stop_and_replan cancels only the prior run before processing the replacement command');
      assert(replannedMessages.length === 1 && stopEvents.some((event: any) => event.type === 'turn_cancelled' && event.turnId === activeTurnId),
        'replacement history is emitted after the stopped turn is fenced');
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
      const protectedMissionRes = await authorizedFetch(`${baseUrl}/api/missions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: createdWorkspaceId, title: 'Active conversation cannot be deleted' }),
      });
      const protectedMission = await protectedMissionRes.json();
      const protectedDeleteRes = await authorizedFetch(`${baseUrl}/api/missions/${protectedMission.id}`, { method: 'DELETE' });
      assert(protectedDeleteRes.status === 200, 'DELETE /api/missions/:id fences, stops, and removes a nonterminal conversation');
      const preservedMissionRes = await authorizedFetch(`${baseUrl}/api/missions/${protectedMission.id}`);
      assert(preservedMissionRes.status === 404, 'Conversation is removed only after its cleanup operation completes');
      const repeatedMissionDelete = await authorizedFetch(`${baseUrl}/api/missions/${protectedMission.id}`, { method: 'DELETE' });
      assert(repeatedMissionDelete.status === 200, 'Repeated conversation DELETE returns the completed durable operation');

      eventBus.emit({
        id: 'runtime-telemetry:usage-attempt-1', type: 'runtime_telemetry', missionId: createdMissionId,
        taskId: 'usage-task', agentInstanceId: 'usage-agent-1', adapterId: 'claude_code', attemptId: 'usage-attempt-1',
        outcome: 'completed', usageAvailable: true, usageSource: 'provider_reported', inputTokens: 100, outputTokens: 25,
        cost: 0.1, currency: 'USD', queueWaitMs: 10, durationMs: 100, retryCount: 0, workerUtilization: 0.5,
        timestamp: new Date().toISOString(),
      });
      eventBus.emit({
        id: 'runtime-telemetry:usage-attempt-2', type: 'runtime_telemetry', missionId: createdMissionId,
        taskId: 'usage-task', agentInstanceId: 'usage-agent-2', adapterId: 'opencode', attemptId: 'usage-attempt-2',
        outcome: 'failed', usageAvailable: true, usageSource: 'provider_reported', inputTokens: 40, outputTokens: 10,
        cost: 0.2, currency: 'EUR', queueWaitMs: 20, durationMs: 200, retryCount: 1, workerUtilization: 1,
        timestamp: new Date().toISOString(),
      });
      const usageRes = await authorizedFetch(`${baseUrl}/api/missions/${createdMissionId}/usage`);
      const usage = await usageRes.json();
      assert(usage.totalCost === null && usage.currency === null && usage.costsByCurrency.USD === 0.1 && usage.costsByCurrency.EUR === 0.2, 'usage metrics never add mixed currencies');
      assert(usage.completedCount === 1 && usage.failedCount === 1 && usage.successRate === 0.5 && usage.retryCount === 1, 'usage metrics cover attempt lifecycle and true retry count');
      assert(usage.usageAvailable === true && usage.usageSource === 'provider_reported', 'usage metrics expose provider provenance and availability');

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

      await gateway.workspaceManager.updateMission(childMissionId, { status: 'running' });
      const activeWorkspaceDeleteRes = await authorizedFetch(`${baseUrl}/api/workspaces/${createdWorkspaceId}`, { method: 'DELETE' });
      assert(activeWorkspaceDeleteRes.status === 200, 'DELETE /api/workspaces/:id fences active conversations and completes external cleanup first');
      assert((await gateway.workspaceManager.getWorkspace(createdWorkspaceId)) === null, 'workspace row is removed after cleanup completes');

      const deleteWorkspaceRes = await authorizedFetch(`${baseUrl}/api/workspaces/${createdWorkspaceId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeMemory: false }),
      });
      assert(deleteWorkspaceRes.status === 200, 'Repeated workspace DELETE returns the completed durable operation');
      const deleteWorkspaceBody = await deleteWorkspaceRes.json();
      assert(deleteWorkspaceBody.removeMemory === false, 'workspace deletion preserves memory by default');

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
    if (createdTeamTemplateId && server.listening) {
      await authorizedFetch(`${baseUrl}/api/team-templates/${encodeURIComponent(createdTeamTemplateId)}`, { method: 'DELETE' }).catch(() => undefined);
    }
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

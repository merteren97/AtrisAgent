import { LocalEventBus } from '@atris-agent-code/event-bus';
import { CoordinationMCP } from '@atris-agent-code/coordination-mcp';
import { ControlPlaneGrantRegistry } from './control-plane-grants';
import { dispatchControlPlaneTool, type ControlPlaneServices } from './control-plane-router';

async function runTests() {
  console.log('--- Starting Native CLI Control Plane Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed += 1;
    } else {
      console.error(`[FAIL] ${message}`);
      failed += 1;
    }
  }

  const missionId = 'control-plane-mission';
  const parentAgentId = 'orchestrator-agent';
  const parentTaskId = 'orchestrator-task';
  const tasks = new Map<string, any>([
    [parentTaskId, {
      id: parentTaskId,
      missionId,
      planId: 'plan-1',
      title: 'Coordinate implementation',
      description: 'Coordinate the mission and delegate specialists.',
      status: 'running',
      priority: 'high',
      assignedAgentId: parentAgentId,
      assignedRole: 'orchestrator',
      requiredCapabilities: [],
      dependsOn: [],
      worktreeId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    }],
  ]);

  const workspaceManager: any = {
    async getMission(id: string) {
      return id === missionId ? { id, title: 'Control plane test', status: 'running', executionMode: 'balanced' } : null;
    },
    async listTasks(id: string) {
      return id === missionId ? [...tasks.values()] : [];
    },
    async getTask(id: string) {
      return tasks.get(id) || null;
    },
    async createTask(input: Record<string, any>) {
      const id = String(input.id || crypto.randomUUID());
      const now = new Date().toISOString();
      const task = {
        id,
        missionId: input.missionId,
        planId: input.planId || 'dynamic-plan',
        title: input.title,
        description: input.description || '',
        status: input.status || 'planned',
        priority: input.priority || 'medium',
        assignedAgentId: input.assignedAgentId || null,
        assignedRole: input.assignedRole || null,
        requiredCapabilities: input.requiredCapabilities || [],
        dependsOn: input.dependsOn || [],
        worktreeId: input.worktreeId || null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      tasks.set(id, task);
      return task;
    },
    async updateTask(id: string, patch: Record<string, any>) {
      const current = tasks.get(id);
      if (!current) throw new Error(`Task ${id} not found`);
      const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
      tasks.set(id, updated);
      return updated;
    },
  };

  const eventBus = new LocalEventBus();
  const coordination = new CoordinationMCP({ workspaceManager, eventBus, workspacePath: process.cwd() });
  const grants = new ControlPlaneGrantRegistry();
  const services: ControlPlaneServices = { coordination, eventBus, workspaceManager, grants };

  eventBus.emit({
    id: crypto.randomUUID(),
    type: 'agent_started',
    missionId,
    agentInstanceId: parentAgentId,
    role: 'orchestrator',
    model: 'test-orchestrator',
    taskId: parentTaskId,
    timestamp: new Date().toISOString(),
  });

  const issued = grants.issue({ agentInstanceId: parentAgentId, missionId, taskId: parentTaskId, role: 'orchestrator' });
  const parentGrant = grants.authorize(`Bearer ${issued.token}`);
  assert(Boolean(parentGrant && parentGrant.agentInstanceId === parentAgentId), 'Session grant resolves to its server-bound agent identity');
  assert(grants.authorize('Bearer definitely-not-valid') === null, 'Unknown bearer token is rejected');

  const spawn = await dispatchControlPlaneTool(services, parentGrant!, 'agent_spawn', {
    role: 'researcher',
    instruction: 'Inspect authentication boundaries and report evidence only.',
    specialty: 'Auth Scout',
    spawnReason: 'Authentication uncertainty requires a bounded read-only specialist.',
    modelCatalogId: 'test:preferred-research-model',
  }) as any;
  assert(typeof spawn.agentInstanceId === 'string' && tasks.has(spawn.taskId), 'Orchestrator can schedule a bounded child agent through the control plane');
  const spawnedTask = tasks.get(spawn.taskId);
  assert(spawnedTask?.assignedAgentId === spawn.agentInstanceId && spawnedTask?.assignedRole === 'researcher', 'Spawned child task is bound to the generated Atris agent identity');

  await dispatchControlPlaneTool(services, parentGrant!, 'agent_send_message', {
    fromAgentId: 'spoofed-agent',
    toAgentId: spawn.agentInstanceId,
    content: 'Use only repository evidence and report uncertainties.',
    kind: 'message',
  });
  const inbox = coordination.readAgentMessages(spawn.agentInstanceId, false, false);
  assert(inbox.length === 1 && inbox[0].fromAgentId === parentAgentId, 'Model-supplied sender identity cannot override the server-bound grant identity');

  const researcherToken = grants.issue({
    agentInstanceId: spawn.agentInstanceId,
    missionId,
    taskId: spawn.taskId,
    role: 'researcher',
  });
  const researcherGrant = grants.authorize(`Bearer ${researcherToken.token}`)!;
  let escalationBlocked = false;
  try {
    await dispatchControlPlaneTool(services, researcherGrant, 'agent_spawn', {
      role: 'builder',
      instruction: 'Modify production source files.',
    });
  } catch (error: any) {
    escalationBlocked = /not allowed/.test(error?.message || '');
  }
  assert(escalationBlocked, 'Read-only Researcher cannot self-escalate into a Builder child');

  let contextEventSeen = false;
  const unsubscribe = eventBus.on('agent_context_attached', (event) => {
    if (event.agentInstanceId === parentAgentId && event.label === 'Architecture decision') contextEventSeen = true;
  });
  await dispatchControlPlaneTool(services, parentGrant!, 'agent_attach_context', {
    label: 'Architecture decision',
    sourceType: 'decision',
    sourceId: 'decision-42',
    tokenEstimate: 800,
  });
  unsubscribe();
  assert(contextEventSeen, 'Context attachment is emitted into the durable mission event stream');

  tasks.set(spawn.taskId, { ...tasks.get(spawn.taskId), status: 'done' });
  const awaited = await dispatchControlPlaneTool(services, parentGrant!, 'agent_await', {
    agentId: spawn.agentInstanceId,
    timeoutMs: 100,
  }) as any;
  assert(awaited.completed === true && awaited.states?.[0]?.status === 'completed', 'agent_await resolves completed child state from task truth even if runtime registry lags');

  grants.revokeAgent(parentAgentId);
  assert(grants.authorize(`Bearer ${issued.token}`) === null, 'Agent grant is revoked when its runtime session ends');

  console.log(`\nControl Plane Test Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error('Control plane test execution error:', error);
  process.exit(1);
});

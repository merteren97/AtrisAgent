import { LocalEventBus } from '@atris-agent-code/event-bus';
import type { MissionSelect, TaskSelect } from '@atris-agent-code/database';
import type { MemoryNode, OrchestratorDelegation } from '@atris-agent-code/domain';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import { OrchestratorV2 } from './orchestrator-v2';
import { allocateWorkerBatch, DEFAULT_CORE_WORKER_POOL } from './worker-pool';
import { rankMemoryNodes } from './memory-retrieval';

class FakeWorkspaceManager {
  mission: MissionSelect;
  tasks = new Map<string, TaskSelect>();
  doneUpdateCount = 0;
  throwOnSecondDoneUpdate = false;

  constructor(missionId: string, planId: string) {
    const now = new Date().toISOString();
    this.mission = {
      id: missionId,
      workspaceId: 'workspace-1',
      title: 'Phase 1 test',
      description: '',
      status: 'running',
      teamTemplateId: 'default-core-dev-team',
      planId,
      executionMode: 'balanced',
      automationPolicy: null,
      activeRunId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
  }

  async getMission(id: string): Promise<MissionSelect | null> {
    return id === this.mission.id ? this.mission : null;
  }

  async updateMission(id: string, updates: Partial<MissionSelect>): Promise<MissionSelect> {
    if (id !== this.mission.id) throw new Error('mission missing');
    this.mission = { ...this.mission, ...updates, updatedAt: new Date().toISOString() };
    return this.mission;
  }

  async getWorkspace(id: string): Promise<any | null> {
    if (id !== this.mission.workspaceId) return null;
    return {
      id,
      name: 'Test Workspace',
      path: 'test',
      gitInitialized: false,
    };
  }

  async listTasks(missionId: string): Promise<TaskSelect[]> {
    return [...this.tasks.values()].filter((task) => task.missionId === missionId);
  }

  async getTask(id: string): Promise<TaskSelect | null> {
    return this.tasks.get(id) || null;
  }

  async updateTask(id: string, updates: Partial<TaskSelect>): Promise<TaskSelect> {
    const current = this.tasks.get(id);
    if (!current) throw new Error(`task ${id} missing`);
    if (updates.status === 'done') {
      this.doneUpdateCount += 1;
      if (this.throwOnSecondDoneUpdate && this.doneUpdateCount === 2) {
        throw new Error('simulated persistence failure after terminal event fence');
      }
    }
    const updated = { ...current, ...updates, updatedAt: new Date().toISOString() } as TaskSelect;
    this.tasks.set(id, updated);
    return updated;
  }

  async createTask(input: any): Promise<TaskSelect> {
    const created = task({
      id: input.id,
      missionId: input.missionId,
      planId: input.planId,
      role: input.assignedRole,
      status: input.status || 'planned',
      title: input.title,
      dependsOn: input.dependsOn,
    });
    const normalized = { ...created, description: input.description || created.description, priority: input.priority || created.priority,
      requiredCapabilities: input.requiredCapabilities || created.requiredCapabilities } as TaskSelect;
    this.tasks.set(normalized.id, normalized);
    return normalized;
  }
}

function task(params: {
  id: string;
  missionId: string;
  planId: string;
  role: TaskSelect['assignedRole'];
  status: TaskSelect['status'];
  title?: string;
  dependsOn?: string[];
  assignedAgentId?: string | null;
}): TaskSelect {
  const now = new Date().toISOString();
  return {
    id: params.id,
    missionId: params.missionId,
    planId: params.planId,
    title: params.title || params.id,
    description: params.id,
    status: params.status,
    priority: 'medium',
    assignedAgentId: params.assignedAgentId ?? null,
    assignedRole: params.role,
    requiredCapabilities: [],
    dependsOn: params.dependsOn || [],
    worktreeId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: params.status === 'done' ? now : null,
  };
}

class CompletionFenceDb {
  completions: any[] = [];

  select(selection?: unknown) {
    return {
      from: () => {
        const rows = selection ? [] : this.completions;
        return {
          where: async () => rows,
          then: (resolve: (value: any[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
        };
      },
    };
  }

  insert() {
    return {
      values: (value: any) => ({
        onConflictDoNothing: async () => {
          if (!this.completions.some((row) => row.missionId === value.missionId && row.planId === value.planId)) this.completions.push({ ...value, completedAt: null });
        },
      }),
    };
  }

  update() {
    return {
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          const row = this.completions[0];
          if (row) Object.assign(row, values);
        },
      }),
    };
  }
}

function memoryNode(params: Partial<MemoryNode> & Pick<MemoryNode, 'id' | 'title' | 'summary'>): MemoryNode {
  return {
    id: params.id,
    projectId: params.projectId || 'project-1',
    type: params.type || 'research_finding',
    title: params.title,
    summary: params.summary,
    body: params.body || null,
    status: params.status || 'active',
    confidence: params.confidence ?? 0.9,
    importance: params.importance ?? 0.7,
    pinned: params.pinned ?? false,
    tags: params.tags || [],
    provenance: params.provenance || [{ sourceType: 'research', createdBy: 'memory_curator' }],
    createdAt: params.createdAt || '2026-08-01T00:00:00.000Z',
    updatedAt: params.updatedAt || '2026-08-12T00:00:00.000Z',
    lastVerifiedAt: params.lastVerifiedAt || null,
  };
}

async function runTests() {
  let passed = 0;
  let failed = 0;
  const assert = (condition: boolean, message: string) => {
    if (condition) {
      passed += 1;
      console.log(`[PASS] ${message}`);
    } else {
      failed += 1;
      console.error(`[FAIL] ${message}`);
    }
  };

  console.log('--- Orchestrator v2 Phase 1 Tests ---');

  // Regression: a terminal event is already visible, but the legacy subscriber
  // rejects after fencing the attempt. V2 reconciliation must still dispatch Task 2.
  {
    const missionId = 'mission-recovery';
    const planId = 'plan-recovery';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('research', task({
      id: 'research', missionId, planId, role: 'researcher', status: 'running', assignedAgentId: 'agent-r1',
    }));
    manager.tasks.set('builder', task({
      id: 'builder', missionId, planId, role: 'builder', status: 'planned', dependsOn: ['research'],
    }));
    const eventBus = new LocalEventBus();
    const spawnedTaskIds: string[] = [];
    eventBus.on('task_created', (event) => { spawnedTaskIds.push(event.taskId); });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );
    manager.throwOnSecondDoneUpdate = true;

    let rejected = false;
    try {
      await orchestrator.handleTaskCompleted({
        id: crypto.randomUUID(),
        type: 'task_completed',
        missionId,
        taskId: 'research',
        agentInstanceId: 'agent-r1',
        result: 'research finished',
        timestamp: new Date().toISOString(),
      });
    } catch {
      rejected = true;
    }

    assert(rejected, 'legacy transition failure remains observable instead of being swallowed');
    assert(manager.tasks.get('research')?.status === 'done', 'completion is durably recorded before legacy transition work');
    assert(manager.tasks.get('builder')?.status === 'running', 'reconciliation dispatches Task 2 after the fenced transition rejects');
    assert(spawnedTaskIds.filter((id) => id === 'builder').length === 1, 'recovery dispatches the Builder exactly once');

    await Promise.all([
      orchestrator.reconcileMissionPlan(missionId, planId),
      orchestrator.reconcileMissionPlan(missionId, planId),
    ]);
    assert(spawnedTaskIds.filter((id) => id === 'builder').length === 1, 'repeated reconciliation is idempotent');
  }

  // A worker can report completion after the user has cancelled the mission.
  // The terminal mission state must win over every late runtime signal.
  {
    const missionId = 'mission-cancelled-late-completion';
    const planId = 'plan-cancelled-late-completion';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission = { ...manager.mission, status: 'cancelled', completedAt: new Date().toISOString() };
    manager.tasks.set('research', task({
      id: 'research', missionId, planId, role: 'researcher', status: 'running', assignedAgentId: 'agent-late',
    }));
    const eventBus = new LocalEventBus();
    let completedEvents = 0;
    eventBus.on('mission_completed', () => { completedEvents += 1; });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.handleTaskCompleted({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: 'research',
      agentInstanceId: 'agent-late',
      result: 'late result',
      timestamp: new Date().toISOString(),
    });

    assert(manager.mission.status === 'cancelled', 'late worker completion cannot revive a cancelled mission');
    assert(manager.tasks.get('research')?.status === 'running', 'late worker completion cannot mutate a cancelled mission task');
    assert(completedEvents === 0, 'late worker completion emits no mission_completed event');
  }

  // Restart recovery finishes a synthesized completion exactly once instead of
  // allowing the next queued turn to overtake its terminal event.
  {
    const missionId = 'mission-synthesis-restart';
    const planId = 'plan-synthesis-restart';
    const manager = new FakeWorkspaceManager(missionId, planId);
    const completion = {
      missionId, planId, status: 'event_pending', summary: 'durable synthesized result',
      tasksCompleted: 1, totalTasks: 1, createdAt: new Date().toISOString(), completedAt: null,
    };
    const fakeDb = {
      select(selection?: unknown) {
        return {
          from: () => {
            const rows = selection ? [] : [completion];
            return {
              where: async () => rows,
              then: (resolve: (value: any[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
            };
          },
        };
      },
      update() {
        return { set: (values: Record<string, unknown>) => ({ where: async () => Object.assign(completion, values) }) };
      },
    };
    const eventBus = new LocalEventBus();
    let completed = 0;
    eventBus.on('mission_completed', (event) => {
      if (event.missionId === missionId && event.summary === completion.summary) completed += 1;
    });
    const first = new OrchestratorV2({ workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus, fakeDb as any, manager as unknown as WorkspaceManager);
    await first.recoverPendingCompletions();
    const restarted = new OrchestratorV2({ workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus, fakeDb as any, manager as unknown as WorkspaceManager);
    await restarted.recoverPendingCompletions();
    assert(completed === 1, 'restart recovery emits one missing terminal completion');
    assert(completion.status === 'completed', 'restart recovery durably closes the completion fence');
  }

  // Direct conversational turns use the same durable completion fence before
  // their terminal event, and their user message is emitted once with turnId.
  {
    const missionId = 'mission-conversational-fence';
    const manager = new FakeWorkspaceManager(missionId, 'old-plan');
    manager.mission = { ...manager.mission, planId: null };
    const db = new CompletionFenceDb();
    const eventBus = new LocalEventBus();
    const turnId = 'turn-conversational-fence';
    let completionRowAtEvent: any;
    const userMessages: any[] = [];
    eventBus.on('user_message', (event) => { userMessages.push(event); });
    eventBus.on('mission_completed', () => { completionRowAtEvent = db.completions[0] && { ...db.completions[0] }; });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      db as any,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.startMission(missionId, 'Answer directly without workers', { turnId });
    assert(userMessages.length === 1 && userMessages[0]?.turnId === turnId,
      'conversational turn emits one user_message with turnId');
    assert(completionRowAtEvent?.missionId === missionId && completionRowAtEvent?.planId === `turn-${turnId}`
      && completionRowAtEvent?.status === 'event_pending',
    'conversational mission_completed is fenced by a matching pending completion row');
    assert(db.completions[0]?.status === 'completed', 'conversational completion fence closes after event emission');
  }

  // Plan-only turns must also persist the matching completion row before the
  // user-facing mission_completed event, without starting workers.
  {
    const missionId = 'mission-plan-only-fence';
    const manager = new FakeWorkspaceManager(missionId, 'old-plan');
    manager.mission = { ...manager.mission, planId: null };
    const db = new CompletionFenceDb();
    const eventBus = new LocalEventBus();
    const turnId = 'turn-plan-only-fence';
    let completionRowAtEvent: any;
    let taskCreated = 0;
    const userMessages: any[] = [];
    eventBus.on('user_message', (event) => { userMessages.push(event); });
    eventBus.on('task_created', () => { taskCreated += 1; });
    eventBus.on('mission_completed', () => { completionRowAtEvent = db.completions[0] && { ...db.completions[0] }; });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      db as any,
      manager as unknown as WorkspaceManager,
    );

    const result = await orchestrator.startMission(missionId, 'Create a plan only', { turnId });
    assert(userMessages.length === 1 && userMessages[0]?.turnId === turnId,
      'plan-only turn emits one user_message with turnId');
    assert(taskCreated === 0 && completionRowAtEvent?.missionId === missionId && completionRowAtEvent?.planId === result.planId
      && completionRowAtEvent?.status === 'event_pending',
    'plan-only mission_completed is fenced by its matching completion row without dispatching workers');
    assert(db.completions[0]?.status === 'completed', 'plan-only completion fence closes after event emission');
  }

  // Recovery: if read-only workers are already durably done but the final
  // completion event was lost during a restart, reconciliation must synthesize
  // once and return the conversation to the user instead of leaving it Running.
  {
    const missionId = 'mission-readonly-recovery';
    const planId = 'plan-readonly-recovery';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('research-a', task({
      id: 'research-a', missionId, planId, role: 'researcher', status: 'done', assignedAgentId: 'agent-ra',
    }));
    manager.tasks.set('research-b', task({
      id: 'research-b', missionId, planId, role: 'researcher', status: 'done', assignedAgentId: 'agent-rb',
    }));
    const eventBus = new LocalEventBus();
    let missionCompletedCount = 0;
    eventBus.on('mission_completed', () => { missionCompletedCount += 1; });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.reconcileMissionPlan(missionId, planId);
    assert(manager.mission.status === 'completed', 'read-only terminal plan is recovered to Completed when its final event was lost');
    assert(missionCompletedCount === 1, 'read-only recovery emits exactly one mission_completed event');

    await orchestrator.reconcileMissionPlan(missionId, planId);
    assert(missionCompletedCount === 1, 'repeated reconciliation does not synthesize the same read-only plan twice');
  }

  // The synthesis intent must exist before a potentially slow supervisor call,
  // otherwise a process crash during synthesis leaves no recovery record.
  {
    const missionId = 'mission-synthesis-intent';
    const planId = 'plan-synthesis-intent';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('research', task({
      id: 'research', missionId, planId, role: 'researcher', status: 'done', assignedAgentId: 'agent-intent',
    }));
    const db = new CompletionFenceDb();
    const eventBus = new LocalEventBus();
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      db as any,
      manager as unknown as WorkspaceManager,
    );
    let intentWasPersisted = false;
    (orchestrator as any).synthesizePlanResult = async () => {
      intentWasPersisted = db.completions[0]?.status === 'synthesis_pending';
      return 'synthesized after durable intent';
    };
    await orchestrator.reconcileMissionPlan(missionId, planId);
    assert(intentWasPersisted, 'synthesis intent is persisted before supervisor synthesis starts');
  }

  // Recovery: a dependency cycle/missing transition with no active worker must
  // fail explicitly rather than remain Running forever with zero dispatchable work.
  {
    const missionId = 'mission-deadlock';
    const planId = 'plan-deadlock';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('research-a', task({
      id: 'research-a', missionId, planId, role: 'researcher', status: 'planned', dependsOn: ['research-b'],
    }));
    manager.tasks.set('research-b', task({
      id: 'research-b', missionId, planId, role: 'researcher', status: 'planned', dependsOn: ['research-a'],
    }));
    const eventBus = new LocalEventBus();
    let missionFailedReason = '';
    let spawned = 0;
    eventBus.on('mission_failed', (event) => { missionFailedReason = event.reason; });
    eventBus.on('task_created', () => { spawned += 1; });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.reconcileMissionPlan(missionId, planId);
    assert(manager.mission.status === 'failed', 'scheduler deadlock moves the mission out of Running');
    assert(missionFailedReason.includes('no active or dispatchable tasks'), 'deadlock failure explains that the plan cannot make progress');
    assert(spawned === 0, 'deadlock recovery does not invent or duplicate worker dispatches');
  }

  // Candidate mode recovery must surface the candidate-selection approval rather
  // than logging that QA is blocked and silently leaving the mission Running.
  {
    const missionId = 'mission-candidate-approval';
    const planId = 'plan-candidate-approval';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission.executionMode = 'candidate';
    manager.tasks.set('builder-a', task({
      id: 'builder-a', missionId, planId, role: 'builder', status: 'done', title: 'Implement fix (Candidate A)',
    }));
    manager.tasks.set('builder-b', task({
      id: 'builder-b', missionId, planId, role: 'builder', status: 'done', title: 'Implement fix (Candidate B)',
    }));
    manager.tasks.set('qa', task({
      id: 'qa', missionId, planId, role: 'qa', status: 'planned', dependsOn: ['builder-a', 'builder-b'],
    }));
    const eventBus = new LocalEventBus();
    let candidateApprovals = 0;
    let qaSpawned = 0;
    eventBus.on('approval_requested', (event) => {
      if (event.approvalType === 'candidate_selection') candidateApprovals += 1;
    });
    eventBus.on('task_created', (event) => {
      if (event.taskId === 'qa') qaSpawned += 1;
    });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.reconcileMissionPlan(missionId, planId);
    assert(manager.mission.status === 'waiting_for_approval', 'candidate recovery enters waiting_for_approval before QA');
    assert(candidateApprovals === 1, 'candidate recovery emits the candidate-selection approval request');
    assert(qaSpawned === 0 && manager.tasks.get('qa')?.status === 'planned', 'QA remains gated until a candidate is selected');
  }

  // Dynamic pool: independent researcher work fills role capacity in parallel,
  // while dependent Builder work waits for its research dependencies.
  {
    const delegations: OrchestratorDelegation[] = [
      { id: 'r1', role: 'researcher', objective: 'Inspect current implementation', requiredCapabilities: ['codebase-analysis'] },
      { id: 'r2', role: 'researcher', objective: 'Research Antigravity quota sources', requiredCapabilities: ['research'] },
      { id: 'r3', role: 'researcher', objective: 'Research Codex quota sources', requiredCapabilities: ['research'] },
      { id: 'b1', role: 'builder', objective: 'Implement chosen design', requiredCapabilities: ['implementation'], dependsOnDelegationIds: ['r1', 'r2', 'r3'] },
    ];
    const allocation = allocateWorkerBatch({ delegations, policy: DEFAULT_CORE_WORKER_POOL });
    assert(allocation.dispatchable.length === 3, 'three independent Researchers are allocated in parallel');
    assert(allocation.dispatchable.every((item) => item.role === 'researcher'), 'parallel batch contains only dependency-free Researchers');
    assert(allocation.deferred.some((item) => item.delegation.id === 'b1' && item.reason === 'dependency'), 'Builder waits for research join dependencies');
  }

  // Memory retrieval: project-local, related and current evidence should outrank
  // an unrelated finding even when both are high-confidence.
  {
    const nodes = [
      memoryNode({
        id: 'antigravity',
        title: 'Antigravity quota detection',
        summary: 'Usage detection can use statusline telemetry and CLI account state.',
        tags: ['antigravity', 'quota', 'usage'],
      }),
      memoryNode({
        id: 'unrelated',
        title: 'Window chrome polish',
        summary: 'Titlebar spacing and maximize controls were adjusted.',
        confidence: 1,
        importance: 1,
      }),
    ];
    const distances = new Map<string, number>([['antigravity', 1], ['unrelated', 5]]);
    const hits = rankMemoryNodes({
      nodes,
      query: { projectId: 'project-1', text: 'Antigravity quota usage', limit: 5 },
      graphDistances: distances,
      now: new Date('2026-08-13T00:00:00.000Z'),
    });
    assert(hits[0]?.node.id === 'antigravity', 'memory ranking prioritizes lexical + graph relevance over unrelated confidence');
  }

  console.log(`--- Orchestrator v2 Phase 1 Tests Complete: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

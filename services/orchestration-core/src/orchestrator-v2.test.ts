import { LocalEventBus, registerSupervisorTurnRunner } from '@atris-agent-code/event-bus';
import { artifacts, missionRuns, type MissionSelect, type TaskSelect } from '@atris-agent-code/database';
import type { EffectiveWorkerPoolPolicy, MemoryNode, OrchestratorDelegation } from '@atris-agent-code/domain';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import { OrchestratorV2 } from './orchestrator-v2';
import { allocateWorkerBatch, DEFAULT_CORE_WORKER_POOL } from './worker-pool';
import { rankMemoryNodes } from './memory-retrieval';

class FakeWorkspaceManager {
  mission: MissionSelect;
  tasks = new Map<string, TaskSelect>();
  attempts = new Map<string, Array<any>>();
  doneUpdateCount = 0;
  throwOnSecondDoneUpdate = false;
  workerPoolPolicy: EffectiveWorkerPoolPolicy = DEFAULT_CORE_WORKER_POOL;

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

  async listTaskAttempts(taskId: string): Promise<any[]> {
    return this.attempts.get(taskId) || [];
  }

  async resolveMissionWorkerPoolPolicy(): Promise<EffectiveWorkerPoolPolicy> {
    return this.workerPoolPolicy;
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
  agentProfileId?: string | null;
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
    agentProfileId: params.agentProfileId ?? null,
    assignedRole: params.role,
    requiredCapabilities: [],
    dependsOn: params.dependsOn || [],
    worktreeId: null,
    targetDescriptor: null,
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

class ResearchBundleLookupDb {
  artifactRows: Array<{ content: string | null; createdAt: string }> = [];
  runRows: Array<{ planId: string | null; status: string }> = [];

  select() {
    return {
      from: (table: unknown) => ({
        where: async () => table === artifacts ? this.artifactRows : table === missionRuns ? this.runRows : [],
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

  // Recovery and direct legacy publication must fail closed when the durable
  // mission has been deleted. A stale completion row must not create an orphan
  // mission_completed or mission_failed event.
  {
    const deletedMissionId = 'mission-deleted-before-recovery';
    const completion = {
      missionId: deletedMissionId,
      planId: 'plan-deleted-before-recovery',
      status: 'event_pending',
      summary: 'stale completion row',
      tasksCompleted: 1,
      totalTasks: 1,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    const db = new CompletionFenceDb();
    db.completions.push(completion);
    const manager = new FakeWorkspaceManager('mission-still-live', 'plan-still-live');
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      db as any,
      manager as unknown as WorkspaceManager,
    );

    orchestrator.emitMissionCompleted({
      missionId: deletedMissionId,
      summary: 'orphan publication attempt',
      tasksCompleted: 1,
      totalTasks: 1,
    });
    await orchestrator.recoverPendingCompletions();

    assert(completion.status === 'event_pending'
      && !events.some((event) => event.type === 'mission_completed' || event.type === 'mission_failed'),
    'Deleted missions suppress both direct and recovered orphan terminal events');
  }

  // A durable task profile is forwarded to every orchestrator-owned task/agent
  // lifecycle event without changing the fixed-role assignment boundary.
  {
    const missionId = 'mission-profile-event-forwarding';
    const planId = 'plan-profile-event-forwarding';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('profiled-task', task({
      id: 'profiled-task',
      missionId,
      planId,
      role: 'researcher',
      status: 'planned',
      agentProfileId: 'profile-researcher-primary',
    }));
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.assignTask('profiled-task');
    const lifecycleEvents = events.filter((event) =>
      (event.type === 'task_assigned' || event.type === 'agent_spawned' || event.type === 'task_created')
      && event.taskId === 'profiled-task');
    assert(lifecycleEvents.length === 3
      && lifecycleEvents.every((event) => (
        event.type === 'task_assigned' || event.type === 'agent_spawned' || event.type === 'task_created'
      ) && event.agentProfileId === 'profile-researcher-primary'),
    'Durable agentProfileId is forwarded through task_assigned, agent_spawned, and task_created');
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

    const result = await orchestrator.startMission(missionId, 'Plan only: research', { turnId });
    assert(userMessages.length === 1 && userMessages[0]?.turnId === turnId,
      'plan-only turn emits one user_message with turnId');
    assert(taskCreated === 0 && completionRowAtEvent?.missionId === missionId && completionRowAtEvent?.planId === result.planId
      && completionRowAtEvent?.status === 'event_pending',
    'plan-only mission_completed is fenced by its matching completion row without dispatching workers');
    assert(db.completions[0]?.status === 'completed', 'plan-only completion fence closes after event emission');
  }

  // Execute plans must expose each quality boundary in order. The legacy
  // aggregate review event is not allowed to duplicate the explicit Reviewer
  // completion or misattribute the final QA transition.
  {
    const missionId = 'mission-quality-lifecycle';
    const turnId = 'turn-quality-lifecycle';
    const runId = 'run-quality-lifecycle';
    const logSafeMarker = 'TRACE_SECRET_4f8c2d';
    const manager = new FakeWorkspaceManager(missionId, 'old-plan');
    manager.mission = { ...manager.mission, planId: null };
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    const traces: string[] = [];
    eventBus.on('*', (event) => { events.push(event); });
    registerSupervisorTurnRunner(async () => JSON.stringify({
      action: 'execute',
      response: 'Build the requested change.',
      delegations: [{
        id: 'builder-lane',
        role: 'builder',
        objective: `Implement the lifecycle path without logging ${logSafeMarker}`,
        requiredCapabilities: ['implementation'],
      }],
    }));

    const originalInfo = console.info;
    console.info = (...args: any[]) => { traces.push(args.map(String).join(' ')); };
    try {
      const orchestrator = new OrchestratorV2(
        { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
        eventBus,
        undefined,
        manager as unknown as WorkspaceManager,
      );
      const result = await orchestrator.startMission(
        missionId,
        `Implement the lifecycle path with token=${logSafeMarker}`,
        { turnId, runId },
      );
      const builder = result.tasks.find((task) => task.assignedRole === 'builder');
      const researcher = result.tasks.find((task) => task.assignedRole === 'researcher');
      const reviewer = result.tasks.find((task) => task.assignedRole === 'reviewer');
      const qa = result.tasks.find((task) => task.assignedRole === 'qa');
      const taskCreatedIds = () => events
        .filter((event): event is Extract<AgentEvent, { type: 'task_created' }> => event.type === 'task_created')
        .map((event) => event.taskId);
      const eventIndex = (type: AgentEvent['type'], taskId: string) => events.findIndex(
        (event) => event.type === type && 'taskId' in event && event.taskId === taskId,
      );

      assert(Boolean(researcher && builder && reviewer && qa), 'execute plan contains Researcher, Builder, Reviewer, and QA stages');
      assert(taskCreatedIds().length === 1 && taskCreatedIds()[0] === researcher?.id,
        'only the dependency-free Researcher is initially visible through task_created');

      const researcherAgentId = (await manager.getTask(researcher!.id))?.assignedAgentId || undefined;
      await orchestrator.handleTaskCompleted({
        id: crypto.randomUUID(), type: 'task_completed', missionId, taskId: researcher!.id,
        agentInstanceId: researcherAgentId, result: 'Inspected the implementation constraints.', timestamp: new Date().toISOString(),
      });
      assert(taskCreatedIds().length === 2 && taskCreatedIds()[1] === builder?.id,
        'Builder dispatch waits for the Researcher result');

      const builderAgentId = (await manager.getTask(builder!.id))?.assignedAgentId || undefined;
      await orchestrator.handleTaskCompleted({
        id: crypto.randomUUID(),
        type: 'task_completed',
        missionId,
        taskId: builder!.id,
        agentInstanceId: builderAgentId,
        result: 'Builder completed the implementation.',
        timestamp: new Date().toISOString(),
      });

      const reviewerAfterBuilder = await manager.getTask(reviewer!.id);
      assert(reviewerAfterBuilder?.status === 'running', 'Reviewer dispatch follows Builder completion');
       assert(taskCreatedIds().length === 3 && taskCreatedIds()[2] === reviewer!.id,
        'Reviewer dispatch is visible through the existing task_created event flow');
      const reviewerCreatedEvent = events.find(
        (event): event is Extract<AgentEvent, { type: 'task_created' }> => event.type === 'task_created' && event.taskId === reviewer!.id,
      );
      assert(reviewerCreatedEvent?.turnId === turnId && reviewerCreatedEvent?.runId === runId,
        'Reviewer task_created carries the active turn/run correlation');
      assert(!events.some((event) => event.type === 'review_completed'), 'Reviewer completion is not emitted before Reviewer runs');
      assert(!events.some((event) => event.type === 'verification_started'), 'QA verification does not start before Reviewer completion');

      const reviewerAgentId = reviewerAfterBuilder?.assignedAgentId || undefined;
      await orchestrator.handleTaskCompleted({
        id: crypto.randomUUID(),
        type: 'task_completed',
        missionId,
        taskId: reviewer!.id,
        agentInstanceId: reviewerAgentId,
        result: 'All tests passed; no test failures or errors were found. Approved.',
        timestamp: new Date().toISOString(),
      });

      const reviewEvents = events.filter(
        (event): event is Extract<AgentEvent, { type: 'review_completed' }> => event.type === 'review_completed',
      );
      const verificationStartedEvents = events.filter(
        (event): event is Extract<AgentEvent, { type: 'verification_started' }> => event.type === 'verification_started',
      );
      const qaAfterReview = await manager.getTask(qa!.id);
      assert(reviewEvents.length === 1
        && reviewEvents[0]?.taskId === reviewer!.id
        && reviewEvents[0]?.reviewerAgentId === reviewerAgentId
        && reviewEvents[0]?.turnId === turnId
        && reviewEvents[0]?.runId === runId
        && reviewEvents[0]?.approved === true,
      'Reviewer completion emits one correlated review_completed event');
      assert(qaAfterReview?.status === 'running', 'QA dispatch follows Reviewer completion');
       assert(taskCreatedIds().length === 4 && taskCreatedIds()[3] === qa!.id,
        'QA dispatch is visible through the existing task_created event flow');
      assert(verificationStartedEvents.length === 1
        && verificationStartedEvents[0]?.taskId === qa!.id
        && verificationStartedEvents[0]?.reviewerAgentId === qaAfterReview?.assignedAgentId,
      'QA dispatch emits one correlated verification_started event');
      assert(verificationStartedEvents[0]?.turnId === turnId && verificationStartedEvents[0]?.runId === runId,
        'verification_started carries the active turn/run correlation');
      assert(eventIndex('review_completed', reviewer!.id) < eventIndex('verification_started', qa!.id),
        'review_completed precedes verification_started');

      const qaAgentId = qaAfterReview?.assignedAgentId || undefined;
      await orchestrator.handleTaskCompleted({
        id: crypto.randomUUID(),
        type: 'task_completed',
        missionId,
        taskId: qa!.id,
        agentInstanceId: qaAgentId,
        result: 'QA checks passed.',
        timestamp: new Date().toISOString(),
      });

      const verificationCompletedEvents = events.filter(
        (event): event is Extract<AgentEvent, { type: 'verification_completed' }> => event.type === 'verification_completed',
      );
      const missionCompletedEvents = events.filter(
        (event): event is Extract<AgentEvent, { type: 'mission_completed' }> => event.type === 'mission_completed',
      );
      assert(verificationCompletedEvents.length === 1
        && verificationCompletedEvents[0]?.taskId === qa!.id
        && verificationCompletedEvents[0]?.reviewerAgentId === qaAgentId
        && verificationCompletedEvents[0]?.turnId === turnId
        && verificationCompletedEvents[0]?.runId === runId
        && verificationCompletedEvents[0]?.passed === true,
      'QA completion emits one correlated verification_completed event');
      assert(missionCompletedEvents.length === 0 && manager.mission.status === 'waiting_for_approval',
        'QA completion does not prematurely complete the mission before apply approval');

      const traceText = traces.join('\n');
      assert(traceText.includes('plan-normalized')
        && traceText.includes('"role":"builder"')
        && traceText.includes('"role":"reviewer"')
        && traceText.includes('"role":"qa"')
        && traceText.includes('"dependsOnIndices":[0]')
        && traceText.includes('"dependsOnIndices":[1]'),
      'normalized-plan trace records quality roles and dependency indices');
      assert(traceText.includes(`"missionId":"${missionId}"`)
        && traceText.includes(`"turnId":"${turnId}"`)
        && traceText.includes(`"planId":"${result.planId}"`)
        && traceText.includes(`"taskId":"${reviewer!.id}"`)
        && traceText.includes(`"taskId":"${qa!.id}"`)
        && traceText.includes(`"agentInstanceId":"${reviewerAgentId}"`)
        && traceText.includes(`"agentInstanceId":"${qaAgentId}"`),
      'quality traces carry mission, turn, plan, task, and agent correlations');
      assert(!traceText.includes(logSafeMarker), 'OrchestratorV2 traces omit task/request text and remain log-safe');
    } finally {
      console.info = originalInfo;
      registerSupervisorTurnRunner(null);
    }
  }

  // Quality workers must provide an explicit positive recommendation. Reviewer
  // findings, revision requests, and ambiguous output block the lane before QA
  // can be dispatched and remain ineligible for apply.
  {
    const missionId = 'mission-review-quality-negative';
    const planId = 'plan-review-quality-negative';
    const turnId = 'turn-review-quality-negative';
    const runId = 'run-review-quality-negative';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission = { ...manager.mission, activeRunId: runId };
    manager.tasks.set('builder', task({
      id: 'builder', missionId, planId, role: 'builder', status: 'done', assignedAgentId: 'agent-builder',
    }));
    manager.tasks.set('reviewer', task({
      id: 'reviewer', missionId, planId, role: 'reviewer', status: 'running', assignedAgentId: 'agent-reviewer',
    }));
    manager.tasks.set('qa', task({
      id: 'qa', missionId, planId, role: 'qa', status: 'planned', dependsOn: ['reviewer'],
    }));
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    let applyCalls = 0;
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2(
      {
        workspacePath: 'test',
        workspaceManager: manager as unknown as WorkspaceManager,
        applyTaskChanges: async () => {
          applyCalls += 1;
          return { success: true };
        },
      },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );
    const longSecretResult = `Revision requested: blocking finding remains. Authorization: Bearer secret-quality-token ${'x'.repeat(5_000)}`;

    await orchestrator.handleTaskCompleted({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: 'reviewer',
      agentInstanceId: 'agent-reviewer',
      turnId,
      runId,
      result: longSecretResult,
      timestamp: new Date().toISOString(),
    });

    const reviewEvent = events.find(
      (event): event is Extract<AgentEvent, { type: 'review_completed' }> => event.type === 'review_completed',
    );
    const applyErrors: unknown[] = [];
    try {
      await orchestrator.handleApprovalDecision(missionId, 'apply', true);
    } catch (error) {
      applyErrors.push(error);
    }
    assert(reviewEvent?.approved === false
      && reviewEvent.turnId === turnId
      && reviewEvent.runId === runId
      && reviewEvent.findings.length <= 4_000
      && !reviewEvent.findings.includes('secret-quality-token'),
    'Reviewer rejection emits a bounded, redacted, correlated review_completed verdict');
    assert(manager.tasks.get('reviewer')?.status === 'rejected' && manager.mission.status === 'failed',
      'Reviewer rejection persists a rejected task and fails the mission consistently with mission_failed');
    assert(manager.tasks.get('qa')?.status === 'cancelled'
      && !events.some((event) => event.type === 'verification_started')
      && !events.some((event) => event.type === 'mission_completed'),
    'Reviewer rejection cancels the pending QA lane and cannot complete the mission');
    assert(applyErrors.length === 1 && applyCalls === 0 && manager.mission.status === 'failed',
      'Reviewer rejection remains ineligible for apply');
  }

  // Structured quality results are preferred over prose, but malformed or
  // contradictory envelopes fail closed.
  {
    const missionId = 'mission-structured-quality';
    const planId = 'plan-structured-quality';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('reviewer', task({
      id: 'reviewer', missionId, planId, role: 'reviewer', status: 'running', assignedAgentId: 'agent-reviewer',
    }));
    manager.tasks.set('qa', task({ id: 'qa', missionId, planId, role: 'qa', status: 'planned', dependsOn: ['reviewer'] }));
    const events: AgentEvent[] = [];
    const eventBus = new LocalEventBus();
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus, undefined, manager as unknown as WorkspaceManager,
    );
    await orchestrator.handleTaskCompleted({
      id: crypto.randomUUID(), type: 'task_completed', missionId, taskId: 'reviewer', agentInstanceId: 'agent-reviewer',
      result: `[legacy_compatibility_fallback] Waiting for build process to complete.\n${JSON.stringify({ type: 'quality_result', version: 1, role: 'reviewer', verdict: 'pass', summary: 'Production build passed with zero errors.', findings: ['No blocking findings.'], evidence: ['409 Conflict response was observed during an unrelated probe.', 'src/error-boundary.tsx', 'diff inspected'] })}`,
      timestamp: new Date().toISOString(),
    });
    assert(manager.tasks.get('reviewer')?.status === 'done'
      && events.some((event) => event.type === 'review_completed' && event.approved),
    'Valid structured Reviewer envelope passes and remains adapter-compatible as text');

    const contradictoryManager = new FakeWorkspaceManager('mission-contradictory-envelope', 'plan-contradictory-envelope');
    contradictoryManager.tasks.set('reviewer', task({ id: 'reviewer', missionId: 'mission-contradictory-envelope', planId: 'plan-contradictory-envelope', role: 'reviewer', status: 'running', assignedAgentId: 'agent-contradictory' }));
    const contradictoryOrchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: contradictoryManager as unknown as WorkspaceManager },
      new LocalEventBus(), undefined, contradictoryManager as unknown as WorkspaceManager,
    );
    await contradictoryOrchestrator.handleTaskCompleted({
      id: crypto.randomUUID(), type: 'task_completed', missionId: 'mission-contradictory-envelope', taskId: 'reviewer', agentInstanceId: 'agent-contradictory',
      result: JSON.stringify({ type: 'quality_result', version: 1, role: 'reviewer', verdict: 'pass', summary: 'Build passed.', findings: ['Tests failed with a blocking error.'], evidence: ['src/error-boundary.tsx'] }),
      timestamp: new Date().toISOString(),
    });
    assert(contradictoryManager.tasks.get('reviewer')?.status === 'rejected' && contradictoryManager.mission.status === 'failed',
      'Structured pass with contradictory judgment findings remains fail-closed');

    const invalidManager = new FakeWorkspaceManager('mission-invalid-envelope', 'plan-invalid-envelope');
    invalidManager.tasks.set('qa', task({ id: 'qa', missionId: 'mission-invalid-envelope', planId: 'plan-invalid-envelope', role: 'qa', status: 'running', assignedAgentId: 'agent-invalid' }));
    const invalidOrchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: invalidManager as unknown as WorkspaceManager },
      new LocalEventBus(), undefined, invalidManager as unknown as WorkspaceManager,
    );
    await invalidOrchestrator.handleTaskCompleted({
      id: crypto.randomUUID(), type: 'task_completed', missionId: 'mission-invalid-envelope', taskId: 'qa',
      agentInstanceId: 'agent-invalid',
      result: '{"type":"quality_result","version":1,"role":"qa","verdict":"pass"}', timestamp: new Date().toISOString(),
    });
    assert(invalidManager.tasks.get('qa')?.status === 'rejected' && invalidManager.mission.status === 'failed',
      'Malformed structured quality envelope fails closed');
  }

  // A Reviewer that omits the required recommendation is also ambiguous and
  // must not unlock QA.
  {
    const missionId = 'mission-review-quality-ambiguous';
    const planId = 'plan-review-quality-ambiguous';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('builder', task({
      id: 'builder', missionId, planId, role: 'builder', status: 'done', assignedAgentId: 'agent-builder',
    }));
    manager.tasks.set('reviewer', task({
      id: 'reviewer', missionId, planId, role: 'reviewer', status: 'running', assignedAgentId: 'agent-reviewer',
    }));
    manager.tasks.set('qa', task({
      id: 'qa', missionId, planId, role: 'qa', status: 'planned', dependsOn: ['reviewer'],
    }));
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    eventBus.on('*', (event) => { events.push(event); });
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
      taskId: 'reviewer',
      agentInstanceId: 'agent-reviewer',
      result: 'Review complete. No explicit pass or approval recommendation was provided.',
      timestamp: new Date().toISOString(),
    });

    const reviewEvent = events.find(
      (event): event is Extract<AgentEvent, { type: 'review_completed' }> => event.type === 'review_completed',
    );
    assert(reviewEvent?.approved === false
      && reviewEvent.findings.includes('No explicit pass')
      && manager.tasks.get('reviewer')?.status === 'rejected'
      && manager.mission.status === 'failed',
    'Ambiguous Reviewer output is emitted as a non-approval and fails the mission consistently with mission_failed');
    assert(manager.tasks.get('qa')?.status === 'cancelled'
      && !events.some((event) => event.type === 'verification_started'),
    'Ambiguous Reviewer output cancels the pending QA lane');
  }

  // Explicitly failed QA checks are a failed gate, not an apply approval.
  {
    const missionId = 'mission-qa-quality-negative';
    const planId = 'plan-qa-quality-negative';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission = { ...manager.mission, activeRunId: 'run-qa-quality-negative' };
    manager.tasks.set('builder', task({
      id: 'builder', missionId, planId, role: 'builder', status: 'done', assignedAgentId: 'agent-builder',
    }));
    manager.tasks.set('reviewer', task({
      id: 'reviewer', missionId, planId, role: 'reviewer', status: 'done', assignedAgentId: 'agent-reviewer',
    }));
    manager.tasks.set('qa', task({
      id: 'qa', missionId, planId, role: 'qa', status: 'running', assignedAgentId: 'agent-qa',
    }));
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    let applyCalls = 0;
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2(
      {
        workspacePath: 'test',
        workspaceManager: manager as unknown as WorkspaceManager,
        applyTaskChanges: async () => {
          applyCalls += 1;
          return { success: true };
        },
      },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.handleTaskCompleted({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: 'qa',
      agentInstanceId: 'agent-qa',
      runId: 'run-qa-quality-negative',
      result: 'QA checks failed: the test command failed with a blocking error.',
      timestamp: new Date().toISOString(),
    });

    const verificationEvent = events.find(
      (event): event is Extract<AgentEvent, { type: 'verification_completed' }> => event.type === 'verification_completed',
    );
    assert(verificationEvent?.passed === false
      && verificationEvent.findingCount > 0
      && manager.tasks.get('qa')?.status === 'rejected'
      && manager.mission.status === 'failed',
    'Failed QA checks emit a failed verification_completed verdict and fail the mission consistently with mission_failed');
    assert(!events.some((event) => event.type === 'mission_completed') && applyCalls === 0,
      'Failed QA checks cannot reach mission completion or apply');
  }

  // Empty or non-committal quality output is a failed gate, not an implicit
  // approval. Exercise the empty QA path separately because it owns the apply gate.
  {
    const missionId = 'mission-qa-quality-ambiguous';
    const planId = 'plan-qa-quality-ambiguous';
    const turnId = 'turn-qa-quality-ambiguous';
    const runId = 'run-qa-quality-ambiguous';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission = { ...manager.mission, activeRunId: runId };
    manager.tasks.set('builder', task({
      id: 'builder', missionId, planId, role: 'builder', status: 'done', assignedAgentId: 'agent-builder',
    }));
    manager.tasks.set('reviewer', task({
      id: 'reviewer', missionId, planId, role: 'reviewer', status: 'done', assignedAgentId: 'agent-reviewer',
    }));
    manager.tasks.set('qa', task({
      id: 'qa', missionId, planId, role: 'qa', status: 'running', assignedAgentId: 'agent-qa',
    }));
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    let applyCalls = 0;
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2(
      {
        workspacePath: 'test',
        workspaceManager: manager as unknown as WorkspaceManager,
        applyTaskChanges: async () => {
          applyCalls += 1;
          return { success: true };
        },
      },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.handleTaskCompleted({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: 'qa',
      agentInstanceId: 'agent-qa',
      turnId,
      runId,
      result: '',
      timestamp: new Date().toISOString(),
    });

    const verificationEvent = events.find(
      (event): event is Extract<AgentEvent, { type: 'verification_completed' }> => event.type === 'verification_completed',
    );
    assert(verificationEvent?.passed === false
      && verificationEvent.findingCount === 0
      && verificationEvent.turnId === turnId
      && verificationEvent.runId === runId
      && verificationEvent.summary.includes('No explicit QA pass'),
    'Empty QA output emits an ambiguous, correlated verification_completed failure');
    assert(manager.tasks.get('qa')?.status === 'rejected' && manager.mission.status === 'failed',
      'Ambiguous QA output persists a rejected task and fails the mission consistently with mission_failed');
    assert(!events.some((event) => event.type === 'mission_completed') && applyCalls === 0,
      'Ambiguous QA output cannot reach mission completion or apply');
  }

  // A failed quality gate fences every sibling lane so already-running workers
  // cannot finish into a blocked mission or dispatch more downstream work.
  {
    const missionId = 'mission-quality-sibling-fence';
    const planId = 'plan-quality-sibling-fence';
    const runId = 'run-quality-sibling-fence';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission = { ...manager.mission, activeRunId: runId };
    manager.tasks.set('builder', task({
      id: 'builder', missionId, planId, role: 'builder', status: 'running', assignedAgentId: 'agent-builder',
    }));
    manager.tasks.set('reviewer', task({
      id: 'reviewer', missionId, planId, role: 'reviewer', status: 'running', assignedAgentId: 'agent-reviewer',
    }));
    manager.tasks.set('qa', task({
      id: 'qa', missionId, planId, role: 'qa', status: 'running', assignedAgentId: 'agent-qa',
    }));
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    eventBus.on('*', (event) => { events.push(event); });
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
      taskId: 'reviewer',
      agentInstanceId: 'agent-reviewer',
      runId,
      result: 'Review failed: blocking issue remains.',
      timestamp: new Date().toISOString(),
    });

    assert(manager.mission.status === 'failed'
      && manager.tasks.get('reviewer')?.status === 'rejected'
      && manager.tasks.get('builder')?.status === 'cancelled'
      && manager.tasks.get('qa')?.status === 'cancelled',
    'Failed quality gates fail the mission, cancel running sibling lanes, and preserve the rejected gate');
    assert(events.some((event) => event.type === 'mission_failed')
      && !events.some((event) => event.type === 'task_created' || event.type === 'mission_completed'),
      'Quality failure emits no downstream dispatch or completion event');
  }

  // Applying an approved plan must re-check the mission after each external
  // apply call so cancellation cannot be followed by a completed event.
  {
    const missionId = 'mission-apply-cancellation-fence';
    const planId = 'plan-apply-cancellation-fence';
    const runId = 'run-apply-cancellation-fence';
    const turnId = 'turn-apply-cancellation-fence';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission = { ...manager.mission, status: 'waiting_for_approval', activeRunId: runId };
    manager.tasks.set('builder', task({
      id: 'builder', missionId, planId, role: 'builder', status: 'done', assignedAgentId: 'agent-builder',
    }));
    manager.tasks.set('reviewer', task({
      id: 'reviewer', missionId, planId, role: 'reviewer', status: 'done', assignedAgentId: 'agent-reviewer',
    }));
    manager.tasks.set('qa', task({
      id: 'qa', missionId, planId, role: 'qa', status: 'done', assignedAgentId: 'agent-qa',
    }));
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    eventBus.on('*', (event) => { events.push(event); });
    let applyCalls = 0;
    let operationContext: { operationId?: string; idempotencyKey?: string } | undefined;
    const orchestrator = new OrchestratorV2(
      {
        workspacePath: 'test',
        workspaceManager: manager as unknown as WorkspaceManager,
        applyTaskChanges: async (_taskId, operation) => {
          applyCalls += 1;
          operationContext = operation;
          manager.mission = { ...manager.mission, status: 'cancelled' };
          return { success: true };
        },
      },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );
    (orchestrator as any).lifecycleByMission.set(missionId, { turnId, runId });

    let rejected = false;
    try {
      await orchestrator.handleApprovalDecision(missionId, 'apply', true, {
        operationId: 'approval-apply-cancellation-fence',
        idempotencyKey: 'approval:approval-apply-cancellation-fence:1',
      });
    } catch {
      rejected = true;
    }

    assert(rejected && applyCalls === 1 && manager.mission.status === 'cancelled',
      'Cancellation during apply rejects the stale apply operation');
    assert(operationContext?.operationId === 'approval-apply-cancellation-fence'
      && operationContext.idempotencyKey === 'approval:approval-apply-cancellation-fence:1:task:builder',
    'Approval idempotency context reaches the deterministic apply callback');
    assert(!events.some((event) => event.type === 'changes_applied' || event.type === 'mission_completed'),
      'Cancellation during apply emits no stale apply or completion event');
  }

  // Apply completion waits for base-workspace evidence. Restarting from the
  // durable verifying state retries verification without applying twice.
  {
    const missionId = 'mission-post-apply-verification';
    const planId = 'plan-post-apply-verification';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission = { ...manager.mission, status: 'waiting_for_approval' };
    manager.tasks.set('builder', task({ id: 'builder', missionId, planId, role: 'builder', status: 'done' }));
    manager.tasks.set('reviewer', task({ id: 'reviewer', missionId, planId, role: 'reviewer', status: 'done' }));
    manager.tasks.set('qa', task({ id: 'qa', missionId, planId, role: 'qa', status: 'done' }));
    const events: AgentEvent[] = [];
    const eventBus = new LocalEventBus();
    eventBus.on('*', (event) => { events.push(event); });
    let applyCalls = 0;
    let verificationCalls = 0;
    const orchestrator = new OrchestratorV2({
      workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager,
      applyTaskChanges: async () => { applyCalls += 1; return { success: true }; },
      postApplyVerification: async () => {
        verificationCalls += 1;
        return verificationCalls === 1
          ? { passed: false, summary: 'Base tests failed', evidence: ['test: failed'] }
          : { passed: true, summary: 'Base tests passed', evidence: ['test: passed'] };
      },
    }, eventBus, undefined, manager as unknown as WorkspaceManager);
    let failed = false;
    try { await orchestrator.handleApprovalDecision(missionId, 'apply', true); } catch { failed = true; }
    assert(failed && applyCalls === 1 && manager.mission.status === 'blocked'
      && !events.some((event) => event.type === 'mission_completed'),
    'Failed post-apply verification becomes explicitly retryable after one apply');

    await Promise.all([
      orchestrator.retryPostApplyVerification(missionId),
      orchestrator.retryPostApplyVerification(missionId),
    ]);
    assert(applyCalls === 1 && verificationCalls === 2 && manager.mission.status === 'completed',
      'Concurrent startup/manual retries are idempotent and never repeat destructive apply');
    const completion = events.find((event): event is Extract<AgentEvent, { type: 'mission_completed' }> => event.type === 'mission_completed');
    assert(completion?.summary.includes('Base tests passed') === true,
      'Final synthesis includes post-apply verification evidence');
  }

  {
    const missionId = 'mission-post-apply-hook-pending';
    const planId = 'plan-post-apply-hook-pending';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission = { ...manager.mission, status: 'waiting_for_approval' };
    manager.tasks.set('builder', task({ id: 'builder', missionId, planId, role: 'builder', status: 'done' }));
    manager.tasks.set('reviewer', task({ id: 'reviewer', missionId, planId, role: 'reviewer', status: 'done' }));
    manager.tasks.set('qa', task({ id: 'qa', missionId, planId, role: 'qa', status: 'done' }));
    const events: AgentEvent[] = [];
    const eventBus = new LocalEventBus();
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2({
      workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager,
      applyTaskChanges: async () => ({ success: true }),
    }, eventBus, undefined, manager as unknown as WorkspaceManager);
    await orchestrator.handleApprovalDecision(missionId, 'apply', true);
    assert(manager.mission.status === 'verifying'
      && events.some((event) => event.type === 'verification_started' && event.taskId === `post-apply:${planId}`)
      && !events.some((event) => event.type === 'mission_completed'),
    'Missing runtime verification hook leaves a durable explicit gate and blocks synthesis');
  }

  // A task terminal state and the current lifecycle run both fence late worker
  // completions before any task mutation or legacy transition can occur.
  {
    const missionId = 'mission-late-task-status-completions';
    const planId = 'plan-late-task-status-completions';
    const currentRunId = 'run-current-late-fence';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission = { ...manager.mission, activeRunId: currentRunId };
    const terminalStatuses: Array<TaskSelect['status']> = ['cancelled', 'rejected', 'superseded', 'done'];
    for (const status of terminalStatuses) {
      manager.tasks.set(`task-${status}`, task({
        id: `task-${status}`,
        missionId,
        planId,
        role: 'builder',
        status,
        assignedAgentId: `agent-${status}`,
      }));
    }
    manager.tasks.set('stale-run', task({
      id: 'stale-run', missionId, planId, role: 'builder', status: 'running', assignedAgentId: 'agent-stale',
    }));
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );
    (orchestrator as any).lifecycleByMission.set(missionId, { turnId: 'turn-current-late-fence', runId: currentRunId });

    for (const status of terminalStatuses) {
      await orchestrator.handleTaskCompleted({
        id: crypto.randomUUID(),
        type: 'task_completed',
        missionId,
        taskId: `task-${status}`,
        agentInstanceId: `agent-${status}`,
        runId: currentRunId,
        result: 'late completion',
        timestamp: new Date().toISOString(),
      });
    }
    await orchestrator.handleTaskCompleted({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: 'stale-run',
      agentInstanceId: 'agent-stale',
      runId: 'run-old-late-fence',
      result: 'stale completion',
      timestamp: new Date().toISOString(),
    });

    assert(terminalStatuses.every((status) => manager.tasks.get(`task-${status}`)?.status === status)
      && manager.tasks.get('stale-run')?.status === 'running',
    'Late cancelled/rejected/superseded/done and stale-run completions preserve task state');
    assert(manager.mission.status === 'running'
      && !events.some((event) => event.type === 'task_created' || event.type === 'mission_completed'),
    'Late task completions are fenced before legacy handling or downstream dispatch');
  }

  // Missing runId terminal events must not inherit the in-memory lifecycle when
  // the durable task is assigned to another agent. A matching assignment is
  // sufficient to process the active attempt, while the source event remains
  // unpromoted until the orchestrator has checked that correlation.
  {
    const missionId = 'mission-runless-terminal-correlation';
    const planId = 'plan-runless-terminal-correlation';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.mission = { ...manager.mission, activeRunId: 'run-current-correlation' };
    manager.tasks.set('task', task({
      id: 'task', missionId, planId, role: 'researcher', status: 'running', assignedAgentId: 'agent-correct',
    }));
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );
    (orchestrator as any).lifecycleByMission.set(missionId, {
      turnId: 'turn-stale-correlation',
      runId: 'run-stale-correlation',
    });

    orchestrator.emitEvent({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: 'task',
      agentInstanceId: 'agent-wrong',
      result: 'uncorrelated completion',
      timestamp: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sourceEvent = events.find((event) => event.type === 'task_completed');
    assert(sourceEvent?.runId === undefined && manager.tasks.get('task')?.status === 'running'
      && !events.some((event) => event.type === 'mission_completed'),
    'Runless terminal events are not promoted or applied without durable task/agent correlation');

    await orchestrator.handleTaskCompleted({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: 'task',
      agentInstanceId: 'agent-correct',
      result: 'correlated completion',
      timestamp: new Date().toISOString(),
    });
    assert(manager.tasks.get('task')?.status === 'done' && manager.mission.status === 'completed',
      'Durable task/agent correlation allows a runless terminal event to complete the active attempt');
  }

  // The same correlation fence applies to task_failed events before the base
  // retry/rejection logic can mutate a mission.
  {
    const missionId = 'mission-runless-failure-correlation';
    const planId = 'plan-runless-failure-correlation';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('task', task({
      id: 'task', missionId, planId, role: 'builder', status: 'running', assignedAgentId: 'agent-correct',
    }));
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2(
      {
        workspacePath: 'test',
        maxTaskRetries: 0,
        workspaceManager: manager as unknown as WorkspaceManager,
      },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.handleTaskFailed({
      id: crypto.randomUUID(),
      type: 'task_failed',
      missionId,
      taskId: 'task',
      agentInstanceId: 'agent-wrong',
      error: 'wrong runtime session',
      timestamp: new Date().toISOString(),
    });
    assert(manager.tasks.get('task')?.status === 'running' && manager.mission.status === 'running'
      && !events.some((event) => event.type === 'mission_failed'),
    'Runless task_failed events from another agent are ignored before retry state changes');

    await orchestrator.handleTaskFailed({
      id: crypto.randomUUID(),
      type: 'task_failed',
      missionId,
      taskId: 'task',
      agentInstanceId: 'agent-correct',
      error: 'active runtime failed',
      timestamp: new Date().toISOString(),
    });
    assert(manager.tasks.get('task')?.status === 'rejected' && manager.mission.status === 'failed'
      && events.some((event) => event.type === 'mission_failed'),
    'Durably correlated runless task_failed events retain the existing rejection/retry semantics');
  }

  // A watchdog persists an expired attempt before its runless failure event is
  // delivered. The latest expired attempt is recoverable, while a duplicate
  // reconciliation is fenced once the task/mission become terminal.
  {
    const missionId = 'mission-expired-attempt-recovery';
    const planId = 'plan-expired-attempt-recovery';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('task', task({
      id: 'task', missionId, planId, role: 'builder', status: 'running', assignedAgentId: 'agent-expired',
    }));
    manager.attempts.set('task', [{
      id: 'attempt-expired', taskId: 'task', missionId, agentInstanceId: 'agent-expired',
      attemptNumber: 4, status: 'expired', completedAt: new Date().toISOString(), error: 'lease expired',
    }]);
    const eventBus = new LocalEventBus();
    const events: AgentEvent[] = [];
    eventBus.on('*', (event) => { events.push(event); });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', maxTaskRetries: 3, workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.reconcileMissionPlan(missionId, planId);
    assert(manager.tasks.get('task')?.status === 'rejected' && manager.mission.status === 'failed'
      && events.filter((event) => event.type === 'mission_failed').length === 1,
    'Reconciliation recovers only the latest expired attempt into the bounded failure path');
    await orchestrator.reconcileMissionPlan(missionId, planId);
    assert(events.filter((event) => event.type === 'mission_failed').length === 1,
      'Repeated reconciliation does not retry a terminal expired attempt');
  }

  // First expiry consumes no retry yet. A restart after the second expired
  // attempt must not grant a fresh budget, and historical plans stay fenced.
  {
    const missionId = 'expiry-retry-budget';
    const planId = 'current-expiry-plan';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('research', task({ id: 'research', missionId, planId, role: 'researcher', status: 'running', assignedAgentId: 'first-agent' }));
    manager.attempts.set('research', [{ id: 'first-attempt', taskId: 'research', missionId, agentInstanceId: 'first-agent', attemptNumber: 1, status: 'expired' }]);
    const bus = new LocalEventBus();
    let dispatches = 0;
    bus.on('task_created', () => { dispatches += 1; });
    const config = { workspacePath: 'test', maxTaskRetries: 1, workspaceManager: manager as unknown as WorkspaceManager };
    const first = new OrchestratorV2(config, bus, undefined, manager as unknown as WorkspaceManager);
    await first.reconcileMissionPlan(missionId, planId);
    const retryAgent = manager.tasks.get('research')?.assignedAgentId;
    assert(dispatches === 1 && Boolean(retryAgent) && retryAgent !== 'first-agent', 'first expired attempt schedules exactly one allowed retry with a fresh agent');
    await first.reconcileMissionPlan(missionId, planId);
    assert(dispatches === 1, 'expired previous attempt cannot reschedule a newer active assignment');
    first.unsubscribeFromEvents();
    manager.tasks.set('old', task({ id: 'old', missionId, planId: 'historical-plan', role: 'researcher', status: 'running', assignedAgentId: 'old-agent' }));
    manager.attempts.set('old', [{ id: 'old-attempt', taskId: 'old', missionId, agentInstanceId: 'old-agent', attemptNumber: 9, status: 'expired' }]);
    const restarted = new OrchestratorV2(config, bus, undefined, manager as unknown as WorkspaceManager);
    await restarted.reconcileMissionPlan(missionId, 'historical-plan');
    assert(manager.mission.status === 'running' && manager.tasks.get('old')?.status === 'running', 'explicit historical plan reconciliation cannot fail the current run');
    manager.attempts.set('research', [{ id: 'second-attempt', taskId: 'research', missionId, agentInstanceId: retryAgent!, attemptNumber: 2, status: 'expired' }]);
    await restarted.reconcileMissionPlan(missionId, planId);
    assert(manager.mission.status === 'failed' && dispatches === 1, 'durable second expiry exhausts max-one retry across an orchestrator restart');
    restarted.unsubscribeFromEvents();
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

  // Prior-plan reuse requires every Researcher result plus a successfully
  // completed run. Incremental same-plan artifacts remain available internally.
  {
    const missionId = 'mission-research-bundle-completeness';
    const planId = 'plan-research-bundle-completeness';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.tasks.set('research-a', task({
      id: 'research-a', missionId, planId, role: 'researcher', status: 'done', assignedAgentId: 'agent-ra',
    }));
    manager.tasks.set('research-b', task({
      id: 'research-b', missionId, planId, role: 'researcher', status: 'running', assignedAgentId: 'agent-rb',
    }));
    const db = new ResearchBundleLookupDb();
    const bundle = {
      version: 1,
      missionId,
      planId,
      complete: false,
      sourceTaskIds: ['research-a'],
      sources: [{ taskId: 'research-a', result: 'First finding', uncertain: false }],
      findings: ['First finding'],
      evidence: [{ taskId: 'research-a' }],
      conflicts: [],
      uncertainties: [],
      truncated: false,
    };
    db.artifactRows = [{ content: JSON.stringify(bundle), createdAt: new Date().toISOString() }];
    db.runRows = [{ planId, status: 'completed' }];
    class TestOrchestrator extends OrchestratorV2 {
      latestResearchBundle(mission: string): Promise<any> {
        return this.getLatestResearchBundle(mission);
      }
    }
    const orchestrator = new TestOrchestrator(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      new LocalEventBus(),
      db as any,
      manager as unknown as WorkspaceManager,
    );

    assert(await orchestrator.latestResearchBundle(missionId) === null,
      'multi-Researcher partial artifacts are not reusable by a later plan');

    manager.tasks.set('research-b', task({
      id: 'research-b', missionId, planId, role: 'researcher', status: 'rejected', assignedAgentId: 'agent-rb',
    }));
    db.artifactRows[0].content = JSON.stringify({
      ...bundle, complete: true, sourceTaskIds: ['research-a', 'research-b'],
      sources: [...bundle.sources, { taskId: 'research-b', result: 'Failed finding', uncertain: false }],
    });
    assert(await orchestrator.latestResearchBundle(missionId) === null,
      'a failed required Researcher prevents bundle reuse even if an artifact claims completeness');

    manager.tasks.set('research-b', task({
      id: 'research-b', missionId, planId, role: 'researcher', status: 'done', assignedAgentId: 'agent-rb',
    }));
    db.runRows = [{ planId, status: 'cancelled' }];
    assert(await orchestrator.latestResearchBundle(missionId) === null,
      'a cancelled plan bundle is not reusable');

    db.runRows = [{ planId, status: 'failed' }];
    assert(await orchestrator.latestResearchBundle(missionId) === null,
      'a failed plan bundle is not reusable');

    db.runRows = [{ planId, status: 'completed' }];
    assert((await orchestrator.latestResearchBundle(missionId))?.planId === planId,
      'a complete successful multi-Researcher bundle is reusable');
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

  // Reconciliation uses the global worker pool instead of assigning every ready
  // task in one burst.
  {
    const missionId = 'mission-global-worker-capacity';
    const planId = 'plan-global-worker-capacity';
    const manager = new FakeWorkspaceManager(missionId, planId);
    manager.workerPoolPolicy = { ...DEFAULT_CORE_WORKER_POOL, maxParallelAgents: 2 };
    const roles: Array<TaskSelect['assignedRole']> = ['researcher', 'researcher', 'builder', 'builder', 'qa'];
    for (const [index, role] of roles.entries()) {
      manager.tasks.set(`task-${index}`, task({
        id: `task-${index}`,
        missionId,
        planId,
        role,
        status: 'planned',
      }));
    }
    const eventBus = new LocalEventBus();
    const spawned: string[] = [];
    eventBus.on('task_created', (event) => { spawned.push(event.taskId); });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'test', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    await orchestrator.reconcileMissionPlan(missionId, planId);
    const running = [...manager.tasks.values()].filter((item) => item.status === 'running');
    assert(running.length === 2 && manager.tasks.get('task-2')?.status === 'planned',
      'Restart reconciliation respects the persisted mission global capacity');
    assert(spawned.length === 2 && !spawned.includes('task-2'),
      'Capacity-deferred tasks remain undispatched for a later reconciliation');
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
    const roleLimited = allocateWorkerBatch({ delegations: delegations.slice(0, 3), policy: {
      ...DEFAULT_CORE_WORKER_POOL,
      pools: DEFAULT_CORE_WORKER_POOL.pools.map((pool) => pool.role === 'researcher' ? { ...pool, maxInstances: 1, maxParallel: 1 } : pool),
    } });
    assert(roleLimited.dispatchable.length === 1 && roleLimited.deferred.filter((item) => item.reason === 'role_capacity').length === 2,
      'Role pool limits constrain independent workers below the global ceiling');
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

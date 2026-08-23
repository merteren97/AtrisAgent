import { LocalEventBus, registerSupervisorTurnRunner } from '@atris-agent-code/event-bus';
import type { MissionSelect, TaskSelect } from '@atris-agent-code/database';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import { OrchestratorV2 } from './orchestrator-v2';

class FakeWorkspaceManager {
  mission: MissionSelect;
  tasks = new Map<string, TaskSelect>();

  constructor(params: { missionId: string; description: string; status?: MissionSelect['status']; planId?: string | null }) {
    const now = new Date().toISOString();
    this.mission = {
      id: params.missionId,
      workspaceId: 'workspace-1',
      title: params.description,
      description: params.description,
      status: params.status || 'running',
      teamTemplateId: 'default-core-dev-team',
      planId: params.planId || null,
      executionMode: 'balanced',
      automationPolicy: null,
      activeRunId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: params.status === 'completed' ? now : null,
    };
  }

  async getWorkspace() {
    return {
      id: 'workspace-1',
      name: 'AtrisTracker',
      path: 'C:/Projects/AtrisTracker',
      gitInitialized: true,
      lastOpenedAt: null,
      lastTeamTemplateId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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

  async listTasks(missionId: string): Promise<TaskSelect[]> {
    return [...this.tasks.values()].filter((task) => task.missionId === missionId);
  }

  async getTask(id: string): Promise<TaskSelect | null> {
    return this.tasks.get(id) || null;
  }

  async createTask(input: any): Promise<TaskSelect> {
    const now = new Date().toISOString();
    const task: TaskSelect = {
      id: input.id || crypto.randomUUID(),
      missionId: input.missionId,
      planId: input.planId || '',
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
    this.tasks.set(task.id, task);
    return task;
  }

  async updateTask(id: string, updates: Partial<TaskSelect>): Promise<TaskSelect> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`task ${id} missing`);
    const updated = { ...task, ...updates, updatedAt: new Date().toISOString() } as TaskSelect;
    this.tasks.set(id, updated);
    return updated;
  }
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

  console.log('--- Orchestrator v2 Phase 2 Tests ---');

  // A normal follow-up can be answered directly. No plan or worker is created.
  {
    const missionId = 'conversation-direct';
    const manager = new FakeWorkspaceManager({
      missionId,
      description: 'Antigravity ve Codex usage sistemini analiz et.',
      status: 'completed',
      planId: 'old-plan',
    });
    const eventBus = new LocalEventBus();
    const createdTaskIds: string[] = [];
    const completedSummaries: string[] = [];
    let receivedPrompt = '';
    eventBus.on('task_created', (event) => { createdTaskIds.push(event.taskId); });
    eventBus.on('mission_completed', (event) => { completedSummaries.push(event.summary); });
    registerSupervisorTurnRunner(async (request) => {
      receivedPrompt = request.prompt;
      return JSON.stringify({
        action: 'respond',
        response: 'Önceki analiz bağlamını koruyorum; mevcut bulgular üzerinden devam edebiliriz.',
        delegations: [],
      });
    });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'C:/Projects/AtrisTracker', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    const result = await orchestrator.startMission(missionId, 'devam edelim');
    assert(result.tasks.length === 0, 'chat-first supervisor response creates no execution tasks');
    assert(createdTaskIds.length === 0, 'direct response spawns no worker');
    assert(manager.mission.status === 'completed', 'direct response leaves conversation ready for the next turn');
    assert(completedSummaries.at(-1)?.includes('Önceki analiz') === true, 'Orchestrator response is returned through the canonical mission timeline');
    assert(receivedPrompt.includes('Antigravity ve Codex usage sistemini analiz et.'), 'supervisor receives previous conversation context for a short follow-up');
    assert(receivedPrompt.includes('devam edelim'), 'supervisor receives the current short follow-up');
  }

  // Independent research topics are dispatched concurrently and synthesized by
  // the Orchestrator instead of passing through mutating Reviewer/QA apply gates.
  {
    const missionId = 'conversation-research';
    const manager = new FakeWorkspaceManager({ missionId, description: 'Research quota systems.' });
    const eventBus = new LocalEventBus();
    const createdTaskIds: string[] = [];
    const completedSummaries: string[] = [];
    eventBus.on('task_created', (event) => { createdTaskIds.push(event.taskId); });
    eventBus.on('mission_completed', (event) => { completedSummaries.push(event.summary); });
    registerSupervisorTurnRunner(async (request) => {
      if (request.prompt.includes('returning control to the user')) return 'Üç araştırma kolu tamamlandı ve ortak bulgular birleştirildi.';
      return JSON.stringify({
        action: 'delegate',
        response: 'Üç bağımsız araştırma koluna ayırıyorum.',
        delegations: [
          { id: 'r1', role: 'researcher', objective: 'Inspect current AtrisTracker implementation.', requiredCapabilities: ['codebase-analysis'], dependsOnDelegationIds: [], preferredParallelGroup: 'research' },
          { id: 'r2', role: 'researcher', objective: 'Research Antigravity usage sources.', requiredCapabilities: ['research'], dependsOnDelegationIds: [], preferredParallelGroup: 'research' },
          { id: 'r3', role: 'researcher', objective: 'Research Codex usage sources.', requiredCapabilities: ['research'], dependsOnDelegationIds: [], preferredParallelGroup: 'research' },
        ],
      });
    });
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'C:/Projects/AtrisTracker', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    const result = await orchestrator.startMission(missionId, 'Bu üç alanı paralel araştır.');
    assert(result.tasks.length === 3, 'delegate decision creates three focused Researcher tasks');
    assert(createdTaskIds.length === 3, 'three dependency-free Researchers are dispatched immediately in parallel');
    assert(result.tasks.every((task) => task.assignedRole === 'researcher'), 'read-only delegation does not inject Builder/Reviewer/QA tasks');

    for (const task of result.tasks) {
      await orchestrator.handleTaskCompleted({
        id: crypto.randomUUID(),
        type: 'task_completed',
        missionId,
        taskId: task.id,
        agentInstanceId: manager.tasks.get(task.id)?.assignedAgentId || undefined,
        result: `Result for ${task.title}`,
        timestamp: new Date().toISOString(),
      });
    }
    assert(manager.mission.status === 'completed', 'read-only delegation returns conversation to completed/ready state');
    assert(completedSummaries.at(-1)?.includes('Üç araştırma kolu') === true, 'persistent Orchestrator synthesizes worker findings for the user');
  }

  // Source changes can split into independent Builder lanes. Each lane gets its
  // own Reviewer and QA dependency path so QA never sees multiple worktrees.
  {
    const missionId = 'conversation-execute';
    const manager = new FakeWorkspaceManager({ missionId, description: 'Implement two independent fixes.' });
    const eventBus = new LocalEventBus();
    const initiallyCreated: string[] = [];
    eventBus.on('task_created', (event) => { initiallyCreated.push(event.taskId); });
    registerSupervisorTurnRunner(async () => JSON.stringify({
      action: 'execute',
      response: 'İki bağımsız implementasyon kolu oluşturuyorum.',
      delegations: [
        { id: 'b1', role: 'builder', objective: 'Fix quota cache.', requiredCapabilities: ['implementation'], dependsOnDelegationIds: [] },
        { id: 'b2', role: 'builder', objective: 'Fix credential resolver.', requiredCapabilities: ['implementation'], dependsOnDelegationIds: [] },
      ],
    }));
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'C:/Projects/AtrisTracker', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    const result = await orchestrator.startMission(missionId, 'İki bağımsız sorunu düzelt.', { turnId: 'turn-execute', runId: 'run-execute' });
    const builders = result.tasks.filter((task) => task.assignedRole === 'builder');
    const reviewers = result.tasks.filter((task) => task.assignedRole === 'reviewer');
    const qa = result.tasks.filter((task) => task.assignedRole === 'qa');
    assert(builders.length === 2, 'execute decision preserves two independent Builder lanes');
    assert(reviewers.length === 2 && qa.length === 2, 'each Builder lane receives a dedicated Reviewer and QA task');
    assert(initiallyCreated.length === 2 && initiallyCreated.every((id) => builders.some((task) => task.id === id)), 'only dependency-free Builder lanes start initially');
    for (const reviewer of reviewers) {
      assert((reviewer.dependsOn as string[]).length === 1 && builders.some((builder) => builder.id === (reviewer.dependsOn as string[])[0]), 'each Reviewer depends on exactly one Builder worktree');
    }
    for (const qaTask of qa) {
      assert((qaTask.dependsOn as string[]).length === 1 && reviewers.some((reviewer) => reviewer.id === (qaTask.dependsOn as string[])[0]), 'each QA task depends on its lane Reviewer');
    }
    const steer = await orchestrator.steerActiveTurn({ missionId, targetTurnId: 'turn-execute', content: 'Also verify cache invalidation before applying.' });
    const steeredReviewer = await manager.getTask(reviewers[0].id);
    assert(steer.boundary === 'future_tasks' && Boolean(steeredReviewer?.description.includes('verify cache invalidation')), 'Steer applies guidance to undispatched work at the next safe boundary');
    let staleSteerRejected = false;
    try { await orchestrator.steerActiveTurn({ missionId, targetTurnId: 'older-turn', content: 'stale' }); } catch { staleSteerRejected = true; }
    assert(staleSteerRejected, 'Steer rejects stale target-turn correlation');
  }

  // Explicit plan requests produce a graph but do not start execution.
  {
    const missionId = 'conversation-plan-only';
    const manager = new FakeWorkspaceManager({ missionId, description: 'Plan a refactor.' });
    const eventBus = new LocalEventBus();
    let taskCreatedCount = 0;
    eventBus.on('task_created', () => { taskCreatedCount += 1; });
    registerSupervisorTurnRunner(async () => JSON.stringify({
      action: 'plan_only',
      response: 'Plan hazır; execution başlatılmadı.',
      delegations: [{ id: 'b1', role: 'builder', objective: 'Refactor the scanner.', requiredCapabilities: ['implementation'] }],
    }));
    const orchestrator = new OrchestratorV2(
      { workspacePath: 'C:/Projects/AtrisTracker', workspaceManager: manager as unknown as WorkspaceManager },
      eventBus,
      undefined,
      manager as unknown as WorkspaceManager,
    );

    const result = await orchestrator.startMission(missionId, 'Bunun için sadece plan oluştur.', { command: 'plan' });
    assert(result.tasks.length === 3, 'plan-only Builder lane includes planned Builder + Reviewer + QA graph');
    assert(taskCreatedCount === 0, 'plan-only turn starts no runtime worker');
    assert(result.tasks.every((task) => task.status === 'planned'), 'plan-only tasks remain planned for inspection');
    assert(manager.mission.status === 'completed', 'plan-only conversation remains available for a follow-up execute request');
  }

  registerSupervisorTurnRunner(null);
  console.log(`--- Orchestrator v2 Phase 2 Tests Complete: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

runTests().catch((error) => {
  registerSupervisorTurnRunner(null);
  console.error(error);
  process.exitCode = 1;
});

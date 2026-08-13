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
}

function task(params: {
  id: string;
  missionId: string;
  planId: string;
  role: TaskSelect['assignedRole'];
  status: TaskSelect['status'];
  dependsOn?: string[];
  assignedAgentId?: string | null;
}): TaskSelect {
  const now = new Date().toISOString();
  return {
    id: params.id,
    missionId: params.missionId,
    planId: params.planId,
    title: params.id,
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

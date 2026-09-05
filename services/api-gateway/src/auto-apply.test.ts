import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import { Orchestrator } from '@atris-agent-code/orchestration-core';
import { WorktreeManager } from '@atris-agent-code/workspace-manager';
import { MergeCoordinator } from '@atris-agent-code/merge-coordinator';
import { ApplyVerificationOperationStore, executeApplyVerificationOperation } from './apply-verification-operation';

// Production Orchestrator (V3) -> automatic QA completion -> durable operation
// -> real new-sibling publisher. No provider or user database is involved.
async function verifyAutoApply(scenario: 'success' | 'collision' | 'verification-failure' | 'approval-required') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auto-apply-')));
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE apply_verification_operations (
    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, plan_id TEXT NOT NULL, run_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE, apply_phase TEXT NOT NULL, verification_phase TEXT NOT NULL,
    builder_task_ids TEXT NOT NULL, applied_task_ids TEXT NOT NULL, verification_passed INTEGER,
    summary TEXT, evidence TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
    UNIQUE(mission_id, plan_id));`);
  const worktreeManager = new WorktreeManager();
  const staging = await worktreeManager.createEmptyManagedStaging(path.join(root, '.atris-worktrees', 'builder'), root);
  const target = path.join(root, 'AtrisTask');
  fs.writeFileSync(path.join(staging, 'app.txt'), 'reviewed builder output\n');
  if (scenario === 'collision') {
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'existing.txt'), 'user owned');
  }
  const mission: any = { id: 'mission', planId: 'plan', workspaceId: 'workspace', status: 'running',
    activeRunId: 'run', executionMode: 'autonomous', automationPolicy: { profile: scenario === 'approval-required' ? 'ask' : 'auto' } };
  const tasks: any[] = ['builder', 'reviewer', 'qa'].map((role) => ({
    id: role, missionId: mission.id, planId: mission.planId, assignedRole: role, assignedAgentId: `agent-${role}`,
    title: role, description: role, status: role === 'qa' ? 'running' : 'done', dependsOn: [],
    worktreeId: role === 'builder' ? staging : null,
  }));
  const worktree: any = { isolationKind: 'new-sibling', canonicalContainer: root, targetName: 'AtrisTask',
    targetPath: target, appliedOperationKey: null, status: 'active' };
  const manager: any = {
    async getMission() { return { ...mission }; },
    async getWorkspace() { return { id: 'workspace', path: root }; },
    async getTask(id: string) { return { ...tasks.find((task) => task.id === id) }; },
    async listTasks() { return tasks.map((task) => ({ ...task })); },
    async listTaskAttempts() { return []; },
    async updateTask(id: string, patch: any) { return Object.assign(tasks.find((task) => task.id === id), patch); },
    async updateMission(_id: string, patch: any) { return Object.assign(mission, patch); },
    getWorktreeManager() { return worktreeManager; },
    async getWorktreeForTask() { return worktree; },
    async markNewSiblingApplied(_id: string, key: string, targetPath: string) {
      Object.assign(worktree, { appliedOperationKey: key, targetPath, status: 'merged' });
    },
  };
  const bus = new LocalEventBus();
  const events: any[] = [];
  bus.on('*', (event) => { events.push(event); });
  const merge = new MergeCoordinator(manager);
  const store = new ApplyVerificationOperationStore(sqlite);
  let applyCalls = 0;
  let verifyCalls = 0;
  const execute = (context: any) => executeApplyVerificationOperation(store, context,
    async (taskId, operation) => {
      applyCalls++;
      assert(operation.idempotencyKey.endsWith(':task:builder'));
      return merge.applyWorktree(taskId, undefined, operation);
    },
    async () => {
      verifyCalls++;
      assert(!events.some((event) => event.type === 'mission_completed'), 'no success before target verification');
      assert.equal(fs.readFileSync(path.join(target, 'app.txt'), 'utf8'), 'reviewed builder output\n');
      return { passed: scenario !== 'verification-failure', summary: 'Target verification', evidence: ['target/app.txt checked'] };
    });
  const orchestrator = new Orchestrator({ workspacePath: root, workspaceManager: manager,
    applyTaskChanges: async () => { throw new Error('Automatic apply bypassed durable coordinator'); },
    executeApplyVerificationOperation: execute,
  }, bus, undefined, manager);
  orchestrator.unsubscribeFromEvents();
  const event: any = { id: 'qa-completed', type: 'task_completed', missionId: mission.id, taskId: 'qa',
    agentInstanceId: 'agent-qa', runId: 'run', turnId: 'turn', result: 'QA passed. All checks passed.', timestamp: new Date().toISOString() };
  try {
    await orchestrator.handleTaskCompleted(event);
    await orchestrator.handleTaskCompleted(event);
    assert.equal(fs.readFileSync(path.join(staging, 'app.txt'), 'utf8'), 'reviewed builder output\n', 'staging is preserved');
    if (scenario === 'approval-required') {
      assert.equal(mission.status, 'waiting_for_approval');
      assert.equal(applyCalls, 0);
      assert.equal(fs.existsSync(target), false);
      assert(events.some((event) => event.type === 'approval_requested' && event.approvalType === 'apply'));
      return;
    }
    assert.equal(applyCalls, 1, 'duplicate QA event never reapplies');
    if (scenario === 'success') {
      assert.equal(mission.status, 'completed');
      assert.equal(store.get('mission', 'plan')?.verification_phase, 'completed');
      assert.equal(worktree.appliedOperationKey, 'apply-verify:mission:plan:task:builder');
      assert.equal(events.filter((event) => event.type === 'mission_completed').length, 1);
      assert.equal(events.filter((event) => event.type === 'changes_applied').length, 1);
      await execute({ missionId: 'mission', planId: 'plan', builderTaskIds: ['builder'] });
      assert.equal(applyCalls, 1, 'durable replay does not copy files again');
      assert.equal(verifyCalls, 1);
    } else {
      assert.equal(mission.status, 'blocked');
      assert(!events.some((event) => event.type === 'mission_completed'));
      const failure = events.find((event) => event.type === 'mission_failed');
      assert.equal(failure?.runId, 'run', 'blocked apply ends the correct conversation run');
      assert.equal(failure?.turnId, 'turn');
      if (scenario === 'collision') {
        assert.equal(verifyCalls, 0);
        assert.equal(fs.readFileSync(path.join(target, 'existing.txt'), 'utf8'), 'user owned');
        assert.equal(fs.existsSync(path.join(target, 'app.txt')), false);
        assert.equal(store.get('mission', 'plan')?.apply_phase, 'blocked');
      } else {
        assert.equal(store.get('mission', 'plan')?.apply_phase, 'applied');
        assert.equal(store.get('mission', 'plan')?.verification_phase, 'blocked');
      }
    }
  } finally {
    orchestrator.unsubscribeFromEvents();
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const scenario of ['success', 'collision', 'verification-failure', 'approval-required'] as const) await verifyAutoApply(scenario);
console.log('Automatic QA-to-sibling apply integration passed');

import { LocalEventBus } from '@atris-agent-code/event-bus';
import { Orchestrator } from './orchestrator';
import { MissionController } from './controllers/mission-controller';
import type { TaskCreated, TaskFailed, MissionFailed, PlanGenerated } from '@atris-agent-code/event-schema';

async function runTests() {
  console.log('--- Starting Orchestrator Integration Tests ---');
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

  // Test 1: Mission Start & Plan Generation & Task 1 Dispatch
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({
      workspacePath: 'test-workspace',
      eventBus,
      maxTaskRetries: 3,
    });
    const controller = new MissionController(orchestrator);

    let planGeneratedEvent: PlanGenerated | null = null;
    const taskCreatedEvents: TaskCreated[] = [];

    eventBus.on('plan_generated', (e: PlanGenerated) => {
      planGeneratedEvent = e;
    });

    eventBus.on('task_created', (e: TaskCreated) => {
      taskCreatedEvents.push(e);
    });

    const missionId = 'mission-1';
    const request = 'Build a new authentication feature';
    const result = await controller.startMission(missionId, request);

    assert(result.missionId === missionId, 'startMission returns correct missionId');
    assert(result.tasks.length === 3, 'startMission creates 3-step task plan');
    assert(planGeneratedEvent !== null, 'plan_generated event was emitted');
    assert(taskCreatedEvents.length === 1, 'First task_created event was emitted');
    assert(taskCreatedEvents[0].taskId === result.tasks[0].id, 'Dispatched task is Task 1');
  }

  // Test 2: Sequential Task Completion & Apply Approval Gate
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({
      workspacePath: 'test-workspace',
      eventBus,
    });

    let missionCompletedCount = 0;
    const approvalTypes: string[] = [];
    const completedTaskIds: string[] = [];

    eventBus.on('mission_completed', () => {
      missionCompletedCount += 1;
    });
    eventBus.on('approval_requested', (event: any) => {
      if (typeof event.approvalType === 'string') approvalTypes.push(event.approvalType);
    });
    eventBus.on('task_created', (e: TaskCreated) => {
      completedTaskIds.push(e.taskId);
    });

    const missionId = 'mission-2';
    const result = await orchestrator.startMission(missionId, 'Fix bug in login page');

    assert(completedTaskIds.length === 1, 'Task 1 created');
    const [t1, t2, t3] = result.tasks;

    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: t1.id,
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 50));
    assert(completedTaskIds.length === 2, 'Task 2 created after Task 1 completion');
    assert(completedTaskIds[1] === t2.id, 'Task 2 matches second task in plan');

    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: t2.id,
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 50));
    assert(completedTaskIds.length === 3, 'Task 3 created after Task 2 completion');
    assert(completedTaskIds[2] === t3.id, 'Task 3 matches third task in plan');

    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: t3.id,
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 50));
    assert(missionCompletedCount === 0, 'Mission does not complete before deterministic apply is approved/configured');
    assert(approvalTypes.includes('apply'), 'Completed review gate requests explicit apply approval when deterministic apply is unavailable');
  }

  // Test 3: Task Retry & Mission Failure on Max Retries
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({
      workspacePath: 'test-workspace',
      eventBus,
      maxTaskRetries: 2,
    });

    let missionFailedEvent: MissionFailed | null = null;
    let taskCreatedCount = 0;

    eventBus.on('mission_failed', (e: MissionFailed) => {
      missionFailedEvent = e;
    });

    eventBus.on('task_created', () => {
      taskCreatedCount++;
    });

    const missionId = 'mission-3';
    const result = await orchestrator.startMission(missionId, 'Failing mission test');
    const t1 = result.tasks[0];

    assert(taskCreatedCount === 1, 'Task 1 initially created');

    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_failed',
      missionId,
      taskId: t1.id,
      error: 'Network error 1',
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 50));
    assert(taskCreatedCount === 2, 'Task 1 re-triggered on 1st retry');

    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_failed',
      missionId,
      taskId: t1.id,
      error: 'Network error 2',
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 50));
    assert(taskCreatedCount === 3, 'Task 1 re-triggered on 2nd retry');

    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_failed',
      missionId,
      taskId: t1.id,
      error: 'Fatal crash',
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 50));
    assert(missionFailedEvent !== null, 'mission_failed event emitted after retries exhausted');
    const mfEvent = missionFailedEvent as MissionFailed | null;
    assert(mfEvent?.failedTaskId === t1.id, 'mission_failed correctly identifies failed taskId');
  }

  // Test 4: Structured Plan Generation & Repair Mechanism
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({ workspacePath: 'test-workspace', eventBus });

    const invalidRawPlan = {
      planId: 'custom-plan-1',
      assumptions: [],
      questions: null,
      tasks: [
        { title: '', role: 'invalid_role', priority: 'unknown', dependsOnIndices: [5] },
      ],
    };

    const repaired = orchestrator.generateStructuredPlan('Add payment gateway', JSON.stringify(invalidRawPlan));
    assert(repaired.assumptions.length > 0, 'Repairs empty assumptions with default fallback');
    assert(repaired.tasks.length === 1, 'Repairs task array');
    assert(repaired.tasks[0].role === 'researcher', 'Repairs invalid role to valid default');
    assert(repaired.tasks[0].dependsOnIndices?.length === 0, 'Filters out out-of-bounds dependency indices');
  }

  // Test 5: Revision Loop & Attempt Limit (Max 3)
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({
      workspacePath: 'test-workspace',
      eventBus,
      maxTaskRetries: 3,
    });

    let missionFailedEvent: MissionFailed | null = null;
    eventBus.on('mission_failed', (e: MissionFailed) => {
      missionFailedEvent = e;
    });

    const missionId = 'mission-rev-1';
    const result = await orchestrator.startMission(missionId, 'Refactor DB layer');
    const builderTask = result.tasks[1];

    await orchestrator.requestRevision(builderTask.id, 'Fix typo in SQL query');
    const state1 = await orchestrator.getMissionState(missionId);
    assert(state1.mission?.status === 'running' || state1.mission?.status === 'revising', 'Mission status transitions to revising/running on revision');

    await orchestrator.requestRevision(builderTask.id, 'Add missing index');
    await orchestrator.requestRevision(builderTask.id, 'Exceeded attempts');

    assert(missionFailedEvent !== null, 'Mission fails when max revision attempts are reached');
  }

  // Test 6: Candidate Mode Isolated Worktrees
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({
      workspacePath: 'test-workspace',
      executionMode: 'candidate',
      eventBus,
    });

    const missionId = 'mission-candidate-1';
    const result = await orchestrator.startMission(missionId, 'Implement search algorithm');

    const candidateTasks = result.tasks.filter(t => t.title.includes('Candidate'));
    assert(candidateTasks.length === 2, 'Candidate mode creates Candidate A and Candidate B builder tasks');
    assert(candidateTasks[0].worktreeId?.includes('candidate-a') === true, 'Candidate A assigned candidate-a worktree');
    assert(candidateTasks[1].worktreeId?.includes('candidate-b') === true, 'Candidate B assigned candidate-b worktree');
  }

  console.log(`\nTest Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});

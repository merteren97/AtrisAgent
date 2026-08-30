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

  // Test 7: Logical subagent identity exists before runtime startup
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({ workspacePath: 'test-workspace', eventBus });
    const assignedEvents: any[] = [];
    const spawnedEvents: any[] = [];
    const createdEvents: TaskCreated[] = [];

    eventBus.on('task_assigned', (event: any) => {
      assignedEvents.push(event);
    });
    eventBus.on('agent_spawned', (event: any) => {
      spawnedEvents.push(event);
    });
    eventBus.on('task_created', (event: TaskCreated) => {
      createdEvents.push(event);
    });

    const missionId = 'mission-correlated-agent';
    const result = await orchestrator.startMission(missionId, 'Investigate a routing issue');
    const state = await orchestrator.getMissionState(missionId);
    const firstTask = state.tasks.find((task) => task.id === result.tasks[0].id);

    assert(assignedEvents.length === 1, 'First task emits task_assigned before runtime startup');
    assert(spawnedEvents.length === 1, 'First task emits agent_spawned before runtime startup');
    assert(createdEvents.length === 1, 'First task still emits task_created for RuntimeHost dispatch');
    assert(Boolean(assignedEvents[0]?.agentInstanceId), 'task_assigned has a preallocated agentInstanceId');
    assert(assignedEvents[0]?.agentInstanceId === spawnedEvents[0]?.agentInstanceId, 'agent_spawned uses the same correlated agentInstanceId');
    assert(assignedEvents[0]?.agentInstanceId === createdEvents[0]?.agentInstanceId, 'RuntimeHost task_created uses the same correlated agentInstanceId');
    assert(firstTask?.assignedAgentId === assignedEvents[0]?.agentInstanceId, 'Task state persists the correlated subagent id immediately');
  }

  // Test 8: A follow-up turn keeps the conversation but isolates the active plan
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({ workspacePath: 'test-workspace', eventBus });
    const userTurns: any[] = [];
    const planRevisions: any[] = [];

    eventBus.on('user_message', (event: any) => {
      userTurns.push(event);
    });
    eventBus.on('plan_revised', (event: any) => {
      planRevisions.push(event);
    });

    const missionId = 'mission-persistent-conversation';
    const first = await orchestrator.startMission(missionId, 'Analyze the repository');
    const second = await orchestrator.startMission(missionId, 'Now implement the recommended change');
    const state = await orchestrator.getMissionState(missionId);

    assert(first.missionId === second.missionId, 'Follow-up turn reuses the same mission/conversation id');
    assert(first.planId !== second.planId, 'Follow-up turn creates a fresh plan id');
    assert(state.mission?.planId === second.planId, 'Mission points at the newest turn plan');
    assert(state.tasks.length === second.tasks.length, 'Mission state exposes only tasks from the active turn plan');
    assert(state.tasks.every((task) => task.planId === second.planId), 'Historical turn tasks cannot leak into active plan scheduling');
    assert(userTurns.length === 1 && userTurns[0]?.content.includes('Now implement'), 'Follow-up user message is emitted as a persisted conversation event');
    assert(planRevisions.length === 1 && planRevisions[0]?.previousPlanId === first.planId, 'Plan revision links the previous and current conversation turns');
  }

  // Test 9: Forward dependency indices survive normalization and task creation
  // so a later Researcher root, rather than the dependent Builder, starts first.
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({ workspacePath: 'test-workspace', eventBus });
    const taskCreatedEvents: TaskCreated[] = [];
    eventBus.on('task_created', (event: TaskCreated) => { taskCreatedEvents.push(event); });

    const result = await orchestrator.startMission('mission-forward-dependency', 'Respect task ordering', {
      rawModelPlanOutput: JSON.stringify({
        planId: 'plan-forward-dependency',
        assumptions: ['Forward dependency regression test'],
        questions: [],
        tasks: [
          {
            title: 'Build after research',
            description: 'Implement only after the research task completes.',
            role: 'builder',
            priority: 'high',
            requiredCapabilities: ['write_to_file'],
            dependsOnIndices: [1],
          },
          {
            title: 'Research first',
            description: 'Inspect the implementation constraints.',
            role: 'researcher',
            priority: 'high',
            requiredCapabilities: ['read_file'],
            dependsOnIndices: [],
          },
        ],
      }),
    });
    const [builderTask, researchTask] = result.tasks;
    const state = await orchestrator.getMissionState('mission-forward-dependency');

    assert(result.structuredPlan.tasks[0].dependsOnIndices?.[0] === 1, 'Preserves a valid forward dependency index');
    assert((builderTask.dependsOn as string[])[0] === researchTask.id, 'Persists the forward dependency on the later task ID');
    assert(taskCreatedEvents.length === 1 && taskCreatedEvents[0].taskId === researchTask.id, 'Dispatches only the dependency-free Researcher root');
    assert(state.mission?.status === 'running' && state.tasks.find((task) => task.id === builderTask.id)?.status === 'planned', 'Forward-dependent Builder remains planned');
  }

  // Test 10: A cyclic plan has no roots and must fail without dispatching a
  // Builder through the legacy fallback path.
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({ workspacePath: 'test-workspace', eventBus });
    const taskCreatedEvents: TaskCreated[] = [];
    let missionFailedEvent: MissionFailed | null = null;
    eventBus.on('task_created', (event: TaskCreated) => { taskCreatedEvents.push(event); });
    eventBus.on('mission_failed', (event: MissionFailed) => { missionFailedEvent = event; });

    const result = await orchestrator.startMission('mission-cyclic-plan', 'Reject cyclic execution graphs', {
      rawModelPlanOutput: JSON.stringify({
        planId: 'plan-cyclic-plan',
        assumptions: ['Cycle regression test'],
        questions: [],
        tasks: [
          {
            title: 'Builder in cycle',
            description: 'Must never start without its dependency.',
            role: 'builder',
            priority: 'critical',
            requiredCapabilities: ['write_to_file'],
            dependsOnIndices: [1],
          },
          {
            title: 'Researcher in cycle',
            description: 'Depends on the Builder task in this malformed graph.',
            role: 'researcher',
            priority: 'high',
            requiredCapabilities: ['read_file'],
            dependsOnIndices: [0],
          },
        ],
      }),
    });
    const state = await orchestrator.getMissionState('mission-cyclic-plan');
    const failedEvent = missionFailedEvent as MissionFailed | null;

    assert(state.mission?.status === 'failed', 'No-root cycle moves the mission to failed');
    assert(failedEvent !== null && failedEvent.failedTaskId === result.tasks[0].id && failedEvent.reason.includes('no dependency-free root tasks'), 'No-root cycle emits a correlated diagnostic failure');
    assert(taskCreatedEvents.length === 0, 'No-root cycle dispatches no task and cannot start its Builder');
    assert(result.tasks.every((task) => task.status === 'planned'), 'No-root cycle leaves all tasks undispatched');
  }

  // Test 11: A cycle behind an independent root is reconciled after the root
  // completes instead of leaving the mission running indefinitely.
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({ workspacePath: 'test-workspace', eventBus });
    const taskCreatedEvents: TaskCreated[] = [];
    let missionFailedEvent: MissionFailed | null = null;
    eventBus.on('task_created', (event: TaskCreated) => { taskCreatedEvents.push(event); });
    eventBus.on('mission_failed', (event: MissionFailed) => { missionFailedEvent = event; });

    const result = await orchestrator.startMission('mission-cycle-after-root', 'Reconcile a blocked graph', {
      rawModelPlanOutput: JSON.stringify({
        planId: 'plan-cycle-after-root',
        assumptions: ['Cycle reconciliation regression test'],
        questions: [],
        tasks: [
          {
            title: 'Independent root',
            description: 'This task can start independently.',
            role: 'researcher',
            priority: 'medium',
            requiredCapabilities: ['read_file'],
            dependsOnIndices: [],
          },
          {
            title: 'Builder in blocked cycle',
            description: 'Must not start after only the independent root completes.',
            role: 'builder',
            priority: 'high',
            requiredCapabilities: ['write_to_file'],
            dependsOnIndices: [2],
          },
          {
            title: 'Researcher in blocked cycle',
            description: 'Forms a cycle with the Builder task.',
            role: 'researcher',
            priority: 'high',
            requiredCapabilities: ['read_file'],
            dependsOnIndices: [1],
          },
        ],
      }),
    });
    const rootTask = result.tasks[0];
    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId: 'mission-cycle-after-root',
      taskId: rootTask.id,
      timestamp: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const state = await orchestrator.getMissionState('mission-cycle-after-root');
    const postRootFailure = missionFailedEvent as MissionFailed | null;

    assert(state.mission?.status === 'failed', 'Post-root cycle reconciliation moves the mission to failed');
    assert(postRootFailure !== null && postRootFailure.reason.includes('Dependency graph is blocked'), 'Post-root cycle emits an explicit blocked-graph failure');
    assert(taskCreatedEvents.length === 1 && taskCreatedEvents[0].taskId === rootTask.id, 'Post-root cycle never dispatches the cyclic Builder');
  }

  // Test 12: Late terminal events cannot mutate terminal tasks or revive a
  // still-running mission through the completion/retry paths.
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({ workspacePath: 'test-workspace', eventBus });
    const taskCreatedEvents: TaskCreated[] = [];
    eventBus.on('task_created', (event: TaskCreated) => { taskCreatedEvents.push(event); });

    const missionId = 'mission-late-terminal-events';
    const result = await orchestrator.startMission(missionId, 'Ignore late terminal events');
    const [completedTask, mutableTask] = result.tasks;
    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: completedTask.id,
      timestamp: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const taskMap = (orchestrator as any).inMemoryTasks as Map<string, any>;
    const terminalCases: Array<{
      taskId: string;
      status: 'done' | 'superseded' | 'cancelled';
    }> = [
      { taskId: completedTask.id, status: 'done' },
      { taskId: mutableTask.id, status: 'superseded' },
      { taskId: mutableTask.id, status: 'cancelled' },
    ];

    for (const terminalCase of terminalCases) {
      const current = taskMap.get(terminalCase.taskId);
      taskMap.set(terminalCase.taskId, { ...current, status: terminalCase.status });
      for (const eventType of ['task_completed', 'task_failed'] as const) {
        const agentInstanceId = taskMap.get(terminalCase.taskId)?.assignedAgentId || undefined;
        eventBus.emit(eventType === 'task_completed'
          ? {
              id: crypto.randomUUID(),
              type: 'task_completed',
              missionId,
              taskId: terminalCase.taskId,
              agentInstanceId,
              timestamp: new Date().toISOString(),
            }
          : {
              id: crypto.randomUUID(),
              type: 'task_failed',
              missionId,
              taskId: terminalCase.taskId,
              agentInstanceId,
              error: 'late runtime signal',
              timestamp: new Date().toISOString(),
            });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const state = await orchestrator.getMissionState(missionId);
      assert(state.tasks.find((task) => task.id === terminalCase.taskId)?.status === terminalCase.status,
        `Late events preserve ${terminalCase.status} task state`);
    }

    const finalState = await orchestrator.getMissionState(missionId);
    assert(taskCreatedEvents.length === 2, 'Late terminal events do not retry or dispatch another task');
    assert(finalState.mission?.status === 'running', 'Late terminal events do not revive or alter the nonterminal mission');
  }

  // Test 13: RuntimeHost can persist rejection before reporting task_failed;
  // the first correlated failure fails the mission exactly once without retrying.
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({ workspacePath: 'test-workspace', eventBus });
    const taskCreatedEvents: TaskCreated[] = [];
    const missionFailedEvents: MissionFailed[] = [];
    eventBus.on('task_created', (event: TaskCreated) => { taskCreatedEvents.push(event); });
    eventBus.on('mission_failed', (event: MissionFailed) => { missionFailedEvents.push(event); });

    const missionId = 'mission-runtime-rejected-task';
    const result = await orchestrator.startMission(missionId, 'Reconcile a runtime rejection');
    const taskMap = (orchestrator as any).inMemoryTasks as Map<string, any>;
    const runningTask = taskMap.get(result.tasks[0].id);
    taskMap.set(runningTask.id, { ...runningTask, status: 'rejected' });

    const rejectedTaskFailed: TaskFailed = {
      id: crypto.randomUUID(),
      type: 'task_failed',
      missionId,
      taskId: runningTask.id,
      agentInstanceId: runningTask.assignedAgentId,
      error: 'Runtime startup failed',
      timestamp: new Date().toISOString(),
    };
    eventBus.emit(rejectedTaskFailed);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const failedState = await orchestrator.getMissionState(missionId);
    assert(failedState.mission?.status === 'failed', 'Rejected RuntimeHost task fails a nonterminal mission');
    assert(failedState.tasks.find((task) => task.id === runningTask.id)?.status === 'rejected', 'Rejected RuntimeHost task remains rejected');
    assert(missionFailedEvents.length === 1 && missionFailedEvents[0].failedTaskId === runningTask.id, 'Rejected RuntimeHost task emits one correlated mission_failed event');
    assert(taskCreatedEvents.length === 1, 'Rejected RuntimeHost task is not retried');

    eventBus.emit({ ...rejectedTaskFailed, id: crypto.randomUUID(), error: 'Duplicate runtime signal' });
    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: runningTask.id,
      agentInstanceId: runningTask.assignedAgentId,
      timestamp: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const finalState = await orchestrator.getMissionState(missionId);
    assert(missionFailedEvents.length === 1, 'Duplicate rejected failure does not emit mission_failed again');
    assert(finalState.mission?.status === 'failed' && finalState.tasks.find((task) => task.id === runningTask.id)?.status === 'rejected', 'Post-failure terminal signals cannot revive the mission or task');
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

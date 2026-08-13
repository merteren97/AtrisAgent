import { LocalEventBus } from '@atris-agent-code/event-bus';
import { Orchestrator } from './orchestrator';

async function waitForHandlers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

async function runTests() {
  console.log('--- Starting Orchestration Reliability Tests ---');
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

  // A runtime can report a turn failure and then report the process closing.
  // Both signals refer to one attempt and must consume only one retry. Runtime
  // attempts now use the Orchestrator-preallocated agentInstanceId, so the test
  // consumes the same correlated IDs that RuntimeHost receives in task_created.
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({
      workspacePath: 'test-workspace',
      eventBus,
      maxTaskRetries: 2,
    });

    const taskCreatedAgentIds: string[] = [];
    eventBus.on('task_created', (event) => {
      if (event.agentInstanceId) taskCreatedAgentIds.push(event.agentInstanceId);
    });

    const missionId = 'mission-duplicate-terminal';
    const result = await orchestrator.startMission(missionId, 'Fix duplicate terminal event handling');
    const task = result.tasks[0];
    const firstAttemptId = taskCreatedAgentIds[0];

    const duplicateFailure = {
      id: crypto.randomUUID(),
      type: 'task_failed' as const,
      missionId,
      taskId: task.id,
      agentInstanceId: firstAttemptId,
      error: 'runtime reported failure',
      timestamp: new Date().toISOString(),
    };

    eventBus.emit(duplicateFailure);
    eventBus.emit({ ...duplicateFailure, id: crypto.randomUUID(), error: 'process exited with code 1' });
    await waitForHandlers();

    assert(taskCreatedAgentIds.length === 2, 'Duplicate terminal signals from one runtime attempt schedule only one retry');

    const secondAttemptId = taskCreatedAgentIds[1];
    eventBus.emit({
      ...duplicateFailure,
      id: crypto.randomUUID(),
      agentInstanceId: secondAttemptId,
      error: 'second runtime attempt failed',
    });
    await waitForHandlers();

    assert(taskCreatedAgentIds.length === 3, 'A distinct runtime attempt can consume the next retry');
    orchestrator.unsubscribeFromEvents();
  }

  // Once a mission is terminal, late events from a process that was shutting down
  // must not move the state machine forward or launch dependent work.
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({
      workspacePath: 'test-workspace',
      eventBus,
      maxTaskRetries: 0,
    });

    const taskCreatedAgentIds: string[] = [];
    eventBus.on('task_created', (event) => {
      if (event.agentInstanceId) taskCreatedAgentIds.push(event.agentInstanceId);
    });

    const missionId = 'mission-stale-terminal';
    const result = await orchestrator.startMission(missionId, 'Protect terminal mission state');
    const firstTask = result.tasks[0];

    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_failed',
      missionId,
      taskId: firstTask.id,
      agentInstanceId: taskCreatedAgentIds[0],
      error: 'fatal runtime error',
      timestamp: new Date().toISOString(),
    });
    await waitForHandlers();

    const failedState = await orchestrator.getMissionState(missionId);
    assert(failedState.mission?.status === 'failed', 'Exhausted retry budget moves the mission to failed');

    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_completed',
      missionId,
      taskId: firstTask.id,
      agentInstanceId: taskCreatedAgentIds[0],
      result: 'late completion after failure',
      timestamp: new Date().toISOString(),
    });
    await waitForHandlers();

    const finalState = await orchestrator.getMissionState(missionId);
    assert(finalState.mission?.status === 'failed', 'Late completion cannot revive a failed mission');
    assert(taskCreatedAgentIds.length === 1, 'Late completion cannot schedule downstream work from a terminal mission');
    orchestrator.unsubscribeFromEvents();
  }

  console.log(`\nReliability Test Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error('Reliability test execution error:', error);
  process.exit(1);
});

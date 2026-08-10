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
  // Both signals refer to one attempt and must consume only one retry.
  {
    const eventBus = new LocalEventBus();
    const orchestrator = new Orchestrator({
      workspacePath: 'test-workspace',
      eventBus,
      maxTaskRetries: 2,
    });

    let taskCreatedCount = 0;
    eventBus.on('task_created', () => { taskCreatedCount += 1; });

    const missionId = 'mission-duplicate-terminal';
    const result = await orchestrator.startMission(missionId, 'Fix duplicate terminal event handling');
    const task = result.tasks[0];

    const duplicateFailure = {
      id: crypto.randomUUID(),
      type: 'task_failed' as const,
      missionId,
      taskId: task.id,
      agentInstanceId: 'runtime-attempt-1',
      error: 'runtime reported failure',
      timestamp: new Date().toISOString(),
    };

    eventBus.emit(duplicateFailure);
    eventBus.emit({ ...duplicateFailure, id: crypto.randomUUID(), error: 'process exited with code 1' });
    await waitForHandlers();

    assert(taskCreatedCount === 2, 'Duplicate terminal signals from one runtime attempt schedule only one retry');

    eventBus.emit({
      ...duplicateFailure,
      id: crypto.randomUUID(),
      agentInstanceId: 'runtime-attempt-2',
      error: 'second runtime attempt failed',
    });
    await waitForHandlers();

    assert(taskCreatedCount === 3, 'A distinct runtime attempt can consume the next retry');
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

    let taskCreatedCount = 0;
    eventBus.on('task_created', () => { taskCreatedCount += 1; });

    const missionId = 'mission-stale-terminal';
    const result = await orchestrator.startMission(missionId, 'Protect terminal mission state');
    const firstTask = result.tasks[0];

    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'task_failed',
      missionId,
      taskId: firstTask.id,
      agentInstanceId: 'failed-attempt',
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
      agentInstanceId: 'late-runtime-event',
      result: 'late completion after failure',
      timestamp: new Date().toISOString(),
    });
    await waitForHandlers();

    const finalState = await orchestrator.getMissionState(missionId);
    assert(finalState.mission?.status === 'failed', 'Late completion cannot revive a failed mission');
    assert(taskCreatedCount === 1, 'Late completion cannot schedule downstream work from a terminal mission');
    orchestrator.unsubscribeFromEvents();
  }

  console.log(`\nReliability Test Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error('Reliability test execution error:', error);
  process.exit(1);
});

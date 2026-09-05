import assert from 'node:assert/strict';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import { RuntimeHost } from '@atris-agent-code/runtime-host';
import { OrchestratorV2 } from '@atris-agent-code/orchestration-core';

// Exercise the actual watchdog and orchestrator together. The shared durable
// repository double preserves CAS attempt semantics; no provider is launched.
async function verifyTimeoutHandoff() {
  const bus = new LocalEventBus();
  const mission: any = { id: 'timeout-mission', workspaceId: 'workspace', planId: 'plan', status: 'running', activeRunId: null };
  const task: any = { id: 'research', missionId: mission.id, planId: 'plan', status: 'running', assignedRole: 'researcher', assignedAgentId: 'agent', dependsOn: [] };
  const builder: any = { id: 'builder', missionId: mission.id, planId: 'plan', status: 'planned', assignedRole: 'builder', dependsOn: [task.id] };
  const attempt: any = { id: 'attempt', taskId: task.id, missionId: mission.id, agentInstanceId: 'agent', attemptNumber: 1, status: 'running', runtimeSessionId: 'session' };
  const manager: any = {
    async getMission() { return { ...mission }; },
    async getTask(id: string) { return { ...(id === task.id ? task : builder) }; },
    async listTasks() { return [{ ...task }, { ...builder }]; },
    async listTaskAttempts(id: string) { return id === task.id ? [{ ...attempt }] : []; },
    async updateTask(id: string, patch: any) { return Object.assign(id === task.id ? task : builder, patch); },
    async updateMission(_id: string, patch: any) { return Object.assign(mission, patch); },
    async finishTaskAttempt(_id: string, status: string, options: any) {
      if (!['running', 'claimed'].includes(attempt.status)) return false;
      Object.assign(attempt, options, { status });
      return true;
    },
    async expireStaleTaskAttempts() { return []; },
    async heartbeatTaskAttempt() { return true; },
  };
  const orchestrator = new OrchestratorV2({ workspacePath: '.', maxTaskRetries: 0, workspaceManager: manager }, bus, undefined, manager);
  orchestrator.unsubscribeFromEvents();
  const handoffs: Promise<void>[] = [];
  const failures: any[] = [];
  const terminal: any[] = [];
  const telemetry: any[] = [];
  bus.on('task_failed', (event) => { failures.push(event); handoffs.push(orchestrator.handleTaskFailed(event)); });
  bus.on('mission_failed', (event) => { terminal.push(event); });
  bus.on('runtime_telemetry', (event) => { telemetry.push(event); });
  const host = new RuntimeHost(bus, { workspaceManager: manager, sessionIdleGrace: 100, sessionTimeout: 100, maxProbeFailures: 1, watchdogInterval: 0 });
  let cancellations = 0;
  host.registerAdapter({
    id: 'antigravity', setEventBus() {}, isSessionAlive() { return true; },
    async probeSessionResponsiveness() { return null; },
    async cancel() { cancellations += 1; }, async shutdown() {},
  } as any);
  (host as any).activeSessions.set('session', {
    adapterId: 'antigravity', missionId: mission.id, taskId: task.id, attemptId: attempt.id,
    session: { id: 'session', agentInstanceId: 'agent' }, role: 'researcher',
    queuedAt: 0, startedAt: 0, retryCount: 1, lastProtocolResponseAt: 0, probeFailures: 0,
  });
  try {
    await host.runSessionWatchdog(new Date(101));
    await Promise.all(handoffs);
    assert.equal(attempt.status, 'expired');
    assert.equal(task.status, 'rejected', 'expired watchdog failure reaches the task state machine');
    assert.equal(mission.status, 'failed', 'mission does not remain running after exhausted timeout');
    assert.equal(builder.status, 'planned', 'failed research never releases dependent Builder');
    assert.equal(terminal.length, 1);
    assert.equal(cancellations, 1);
    assert.equal(failures[0].attemptId, attempt.id, 'watchdog failure preserves durable attempt identity');
    assert.equal(telemetry.filter((event) => event.attemptId === attempt.id && event.outcome === 'failed').length, 1, 'watchdog publishes one failed attempt telemetry record');
    await orchestrator.handleTaskFailed(failures[0]);
    await host.runSessionWatchdog(new Date(102));
    assert.equal(terminal.length, 1, 'duplicate timeout cannot finalize twice');
  } finally {
    await host.stopAll();
    orchestrator.unsubscribeFromEvents();
  }
}

await verifyTimeoutHandoff();
console.log('Watchdog to orchestration terminal handoff regression passed');

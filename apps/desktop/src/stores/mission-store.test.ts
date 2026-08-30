import assert from 'node:assert/strict';
import type { TimelineItem } from './mission-store';
import { reconcileApprovalTimeline, restoreMissionTimeline, useMissionStore, type Mission } from './mission-store';
import { projectMissionProcesses } from '@/lib/process-projection';
import type { AgentInstance } from '@/stores/agent-store';

function item(overrides: Partial<TimelineItem>): TimelineItem {
  return {
    id: crypto.randomUUID(),
    type: 'event',
    content: '',
    timestamp: '12:00',
    ...overrides,
  };
}

const request = item({
  id: 'approval-request-event',
  eventType: 'approval_requested',
  content: 'Allow the plan to run.',
  metadata: {
    approvalId: 'approval-1',
    approvalType: 'plan',
    description: 'Allow the plan to run.',
  },
});
const response = item({
  id: 'approval-response-event',
  eventType: 'approval_responded',
  content: 'Approval approved by user.',
  metadata: {
    approvalId: 'approval-1',
    approved: true,
    decidedBy: 'user',
    timestamp: '2026-08-21T12:01:00.000Z',
  },
});

const reconciled = reconcileApprovalTimeline([request, response]);
assert.equal(reconciled.length, 2, 'approval history keeps request and response events');
assert.equal(reconciled[0]?.metadata?.approvalStatus, 'approved', 'request is resolved by matching approval ID');
assert.equal(reconciled[0]?.metadata?.approvalResponseId, 'approval-response-event', 'request links to its response event');
assert.equal(reconciled[1]?.metadata?.approvalStatus, 'approved', 'response remains resolved');
assert.equal(reconciled[1]?.metadata?.approvalType, 'plan', 'response inherits request metadata');

const responseFirst = reconcileApprovalTimeline([response, request]);
assert.equal(responseFirst[1]?.metadata?.approvalStatus, 'approved', 'event order does not affect reconciliation');

const mission: Mission = { id: 'mission-1', workspaceId: 'workspace-1', title: 'Fix hydration', description: 'Fix hydration carefully', status: 'running', createdAt: '2026-08-21T12:00:00.000Z' };
const persistedMessage = { id: 'persisted-user', type: 'user_message', content: 'Persisted request', timestamp: '2026-08-21T12:00:00.000Z' };
const persistedTimeline = restoreMissionTimeline(mission, [persistedMessage]);
assert.equal(persistedTimeline.filter((entry) => entry.type === 'user_message').length, 1, 'persisted user message is not duplicated by mission description');
assert.equal(persistedTimeline[0]?.id, 'persisted-user');
const legacyTimeline = restoreMissionTimeline(mission, []);
assert.equal(legacyTimeline[0]?.content, mission.description, 'legacy missions without a persisted message synthesize the description');

const processAgent: AgentInstance = { id: 'builder-1', missionId: mission.id, role: 'builder', model: 'gpt-test', status: 'running', parentAgentId: null, taskId: 'task-1' };
const processes = projectMissionProcesses(mission, [processAgent], [{ id: 'task-1', missionId: mission.id, title: 'Implement UI', description: '', status: 'running' }], [
  item({ id: 'mission-event', eventType: 'mission_started', content: 'Mission started' }),
  item({ id: 'tool-event', eventType: 'tool_call_started', content: 'Tool started', metadata: { agentInstanceId: processAgent.id } }),
  item({ id: 'output-event', eventType: 'agent_progressed', content: 'Working', metadata: { agentInstanceId: processAgent.id } }),
]);
assert.equal(processes[0]?.name, 'Orchestrator', 'logical orchestrator is always present');
assert.equal(processes[0]?.stream[0]?.id, 'mission-event', 'unattributed mission events belong to orchestrator');
assert.equal(processes[1]?.task, 'Implement UI', 'agent task is projected from mission tasks');
assert.deepEqual(processes[1]?.stream.map((entry) => entry.category), ['tool', 'output']);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
useMissionStore.setState({
  missions: [mission],
  activeMissionId: mission.id,
  hydratedMissionId: mission.id,
  timeline: [persistedMessage as TimelineItem],
  activeTasks: [{ id: 'task-1', missionId: mission.id, title: 'Task', description: '', status: 'running' }],
  queuedTurns: [{ id: 'turn-1', missionId: mission.id } as any],
  commandQueue: [{ id: 'command-1', missionId: mission.id } as any],
});
assert.equal(await useMissionStore.getState().deleteMission(mission.id), true, 'terminal conversation deletion succeeds');
assert.equal(useMissionStore.getState().missions.length, 0, 'deleted conversation is removed from the sidebar state');
assert.equal(useMissionStore.getState().queuedTurns.length, 0, 'deleted conversation queued turns are removed');
assert.equal(useMissionStore.getState().commandQueue.length, 0, 'deleted conversation durable commands are removed');
assert.equal(useMissionStore.getState().activeMissionId, null, 'deleting the active conversation returns to a blank chat');
assert.equal(useMissionStore.getState().timeline.length, 0, 'deleting the active conversation clears its timeline');

useMissionStore.setState({ missions: [mission], activeMissionId: mission.id, error: null });
globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Stop or finish this conversation before deleting it.' }), { status: 409, headers: { 'content-type': 'application/json' } });
assert.equal(await useMissionStore.getState().deleteMission(mission.id), false, 'rejected conversation deletion remains retryable');
assert.equal(useMissionStore.getState().missions.length, 1, 'failed deletion preserves the conversation');
assert.equal(useMissionStore.getState().error, 'Stop or finish this conversation before deleting it.', 'failed deletion exposes the server reason');
globalThis.fetch = originalFetch;

console.log('mission approval lifecycle tests passed');

import assert from 'node:assert/strict';
import { flushPendingTextDeltas, handleIncomingEvent } from './event-listener';
import { useAgentStore } from '@/stores/agent-store';
import { useMissionStore } from '@/stores/mission-store';

const missionId = 'mission-live-agent-listener';
useAgentStore.getState().clearMissionAgents(missionId);
useMissionStore.setState({
  activeMissionId: missionId,
  missions: [{ id: missionId, status: 'running' } as any],
  activeTasks: [1, 2, 3].map((index) => ({ id: `research-task-${index}`, status: 'planned' }) as any),
  timeline: [],
});

let snapshotRefreshCount = 0;
let releaseSnapshot!: () => void;
const snapshotPending = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
useMissionStore.setState({
  fetchMissionState: async (requestedMissionId) => {
    assert.equal(requestedMissionId, missionId);
    snapshotRefreshCount += 1;
    await snapshotPending;
  },
});
handleIncomingEvent({
  id: 'plan-generated-live',
  type: 'plan_generated',
  missionId,
  planId: 'plan-live',
  taskCount: 3,
  timestamp: '2026-09-05T11:01:59Z',
});
assert.equal(snapshotRefreshCount, 1, 'plan_generated requests one mission snapshot refresh');
handleIncomingEvent({
  id: 'plan-generated-live-duplicate',
  type: 'plan_generated',
  missionId,
  planId: 'plan-live',
  taskCount: 3,
  timestamp: '2026-09-05T11:01:59Z',
});
assert.equal(snapshotRefreshCount, 1, 'duplicate plan_generated does not refresh repeatedly');

for (const [index, agentInstanceId] of ['researcher-live-1', 'researcher-live-2', 'researcher-live-3'].entries()) {
  handleIncomingEvent({
    id: `task-assigned-live-${index + 1}`,
    type: 'task_assigned',
    missionId,
    taskId: `research-task-${index + 1}`,
    agentInstanceId,
    role: 'researcher',
    timestamp: `2026-09-05T11:02:0${index}Z`,
  });
}

let missionAgents = useAgentStore.getState().getAgentsByMission(missionId);
assert.equal(missionAgents.length, 3, 'all three live researcher assignments are visible before any completion');
assert.deepEqual(missionAgents.map((agent) => agent.status), ['idle', 'idle', 'idle']);

for (const [index, agentInstanceId] of ['researcher-live-1', 'researcher-live-2', 'researcher-live-3'].entries()) {
  handleIncomingEvent({
    id: `agent-spawned-live-${index + 1}`,
    type: 'agent_spawned',
    missionId,
    taskId: `research-task-${index + 1}`,
    agentInstanceId,
    role: 'researcher',
    model: 'test-runtime',
    timestamp: `2026-09-05T11:02:0${index}Z`,
  });
}
assert.equal(useAgentStore.getState().getAgentsByMission(missionId).length, 3, 'normal agent_spawned events remain idempotent after assignment projection');

for (const [index, agentInstanceId] of ['researcher-live-1', 'researcher-live-2', 'researcher-live-3'].entries()) {
  handleIncomingEvent({
    id: `agent-started-live-${index + 1}`,
    type: 'agent_started',
    missionId,
    taskId: `research-task-${index + 1}`,
    agentInstanceId,
    role: 'researcher',
    model: 'test-runtime',
    timestamp: `2026-09-05T11:02:1${index}Z`,
  });
}

missionAgents = useAgentStore.getState().getAgentsByMission(missionId);
assert.deepEqual(missionAgents.map((agent) => agent.status), ['running', 'running', 'running'], 'later agent_started upgrades each assignment projection');

handleIncomingEvent({
  id: 'task-created-live',
  type: 'task_created',
  missionId,
  taskId: 'research-task-1',
  agentInstanceId: 'researcher-live-1',
  assignedRole: 'researcher',
  timestamp: '2026-09-05T11:02:02Z',
});
assert.equal(useAgentStore.getState().getAgentsByMission(missionId).every((agent) => agent.status === 'running'), true, 'duplicate task creation does not regress running researchers');
assert.equal(useMissionStore.getState().activeTasks.find((task) => task.id === 'research-task-1')?.status, 'ready');
releaseSnapshot();
await snapshotPending;

console.log('event listener live-agent projection regression tests passed');
handleIncomingEvent({ id: 'qa-live-finding', type: 'verification_completed', missionId, passed: false, summary: 'Lint failed.', timestamp: '2026-09-05T11:03:00Z' });
assert.equal(useMissionStore.getState().timeline.find((item) => item.id === 'qa-live-finding')?.agentRole, 'qa', 'live QA verification is not mislabeled as Reviewer');

handleIncomingEvent({ id: 'stream-fragment-1', type: 'text_delta', missionId, turnId: 'turn-live', sequence: 10, agentInstanceId: 'orchestrator-live', agentRole: 'orchestrator', content: 'first ', timestamp: '2026-09-05T11:03:01Z' });
handleIncomingEvent({ id: 'stream-fragment-2', type: 'text_delta', missionId, turnId: 'turn-live', sequence: 11, agentInstanceId: 'orchestrator-live', agentRole: 'orchestrator', content: 'second', timestamp: '2026-09-05T11:03:02Z' });
assert.equal(useMissionStore.getState().timeline.some((item) => item.id === 'stream-fragment-1'), false, 'text deltas wait for a frame-sized batch');
flushPendingTextDeltas(missionId);
const streamed = useMissionStore.getState().timeline.find((item) => item.eventType === 'text_delta');
assert.equal(streamed?.content, 'first second', 'batched text deltas preserve stream order and content');
assert.equal(streamed?.metadata?.content, undefined, 'batched timeline metadata does not duplicate stream content');
assert.equal(streamed?.id, 'stream-fragment-1', 'batched timeline keeps the first durable event identity');
assert.deepEqual(streamed?.metadata?.streamEventIds, ['stream-fragment-1', 'stream-fragment-2']);
assert.equal(streamed?.metadata?.streamEndSequence, 11, 'batched timeline retains the latest durable sequence');

handleIncomingEvent({ id: 'interleaved-a-1', type: 'text_delta', missionId, turnId: 'turn-interleaved', sequence: 12, agentInstanceId: 'agent-a', agentRole: 'builder', content: 'A1', timestamp: '2026-09-05T11:03:03Z' });
handleIncomingEvent({ id: 'interleaved-b-1', type: 'text_delta', missionId, turnId: 'turn-interleaved', sequence: 13, agentInstanceId: 'agent-b', agentRole: 'reviewer', content: 'B1', timestamp: '2026-09-05T11:03:04Z' });
handleIncomingEvent({ id: 'interleaved-a-2', type: 'text_delta', missionId, turnId: 'turn-interleaved', sequence: 14, agentInstanceId: 'agent-a', agentRole: 'builder', content: 'A2', timestamp: '2026-09-05T11:03:05Z' });
flushPendingTextDeltas(missionId);
assert.deepEqual(
  useMissionStore.getState().timeline.slice(-3).map((item) => item.content),
  ['A1', 'B1', 'A2'],
  'interleaved agent streams retain event order while adjacent fragments batch',
);

handleIncomingEvent({
  id: 'tool-with-nested-content',
  type: 'tool_call_started',
  missionId,
  agentInstanceId: 'agent-a',
  toolName: 'write',
  toolCallId: undefined,
  args: { content: 'nested tool content must remain visible' },
  timestamp: '2026-09-05T11:03:06Z',
});
const toolItem = useMissionStore.getState().timeline.find((item) => item.id === 'tool-with-nested-content');
assert.equal('toolCallId' in (toolItem?.metadata || {}), false, 'missing tool IDs are not stringified');
assert.equal((toolItem?.metadata?.args as Record<string, unknown>)?.content, 'nested tool content must remain visible');

useMissionStore.setState({ timeline: [] });
const addTimelineItem = useMissionStore.getState().addTimelineItem;
addTimelineItem({ id: 'sequence-first', type: 'event', eventType: 'text_delta', content: 'first', timestamp: '11:04', metadata: { missionId, agentInstanceId: 'same-agent', streamKey: 'same-stream', sequence: 30 } });
addTimelineItem({ id: 'sequence-gap', type: 'event', eventType: 'text_delta', content: 'second turn', timestamp: '11:05', metadata: { missionId, agentInstanceId: 'same-agent', streamKey: 'same-stream', sequence: 32 } });
assert.deepEqual(useMissionStore.getState().timeline.map((item) => item.content), ['first', 'second turn'], 'sequence gaps prevent cross-turn stream merging');

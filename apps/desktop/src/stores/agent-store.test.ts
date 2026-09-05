import assert from 'node:assert/strict';
import { useAgentStore } from './agent-store';

const missionId = 'mission-agent-diagnostics';
useAgentStore.getState().hydrateMissionFromEvents(missionId, [
  { type: 'agent_spawned', missionId, agentInstanceId: 'agent-1', role: 'builder', timestamp: '2026-08-30T10:00:00.000Z' },
  { type: 'agent_started', missionId, agentInstanceId: 'agent-1', role: 'builder', timestamp: '2026-08-30T10:00:01.000Z' },
  { type: 'agent_error', missionId, agentInstanceId: 'agent-1', error: 'Transient provider diagnostic', timestamp: '2026-08-30T10:00:02.000Z' },
]);

let agent = useAgentStore.getState().agents.find((item) => item.id === 'agent-1');
assert.equal(agent?.status, 'running', 'agent_error remains a nonterminal diagnostic during hydration');
assert.equal(agent?.statusMessage, 'Transient provider diagnostic');
assert.equal(agent?.completedAt, undefined, 'diagnostics do not invent a completion timestamp');

useAgentStore.getState().hydrateMissionFromEvents(missionId, [
  { type: 'agent_spawned', missionId, agentInstanceId: 'agent-1', role: 'builder', timestamp: '2026-08-30T10:00:00.000Z' },
  { type: 'agent_started', missionId, agentInstanceId: 'agent-1', role: 'builder', timestamp: '2026-08-30T10:00:01.000Z' },
  { type: 'task_failed', missionId, agentInstanceId: 'agent-1', error: 'Attempt failed', timestamp: '2026-08-30T10:00:03.000Z' },
]);
agent = useAgentStore.getState().agents.find((item) => item.id === 'agent-1');
assert.equal(agent?.status, 'failed', 'task_failed remains terminal');

console.log('agent hydration diagnostic tests passed');

const completedEvents = [
  { type: 'agent_spawned', missionId, agentInstanceId: 'researcher-completed', role: 'researcher', taskId: 'research', timestamp: '2026-09-05T10:00:00Z' },
  { type: 'agent_started', missionId, agentInstanceId: 'researcher-completed', timestamp: '2026-09-05T10:00:01Z' },
  { type: 'task_completed', missionId, agentInstanceId: 'researcher-completed', taskId: 'research', timestamp: '2026-09-05T10:01:00Z' },
];
useAgentStore.getState().hydrateMissionFromEvents(missionId, [...completedEvents,
  { type: 'agent_progressed', missionId, agentInstanceId: 'researcher-completed', progress: 'agent_response: DONE', timestamp: '2026-09-05T10:01:01Z' },
  { type: 'agent_started', missionId, agentInstanceId: 'researcher-completed', timestamp: '2026-09-05T10:01:02Z' },
]);
assert.equal(useAgentStore.getState().agents.find((item) => item.id === 'researcher-completed')?.status, 'completed', 'hydration uses task completion and fences late runtime progress/start');
const completed = useAgentStore.getState().agents.find((item) => item.id === 'researcher-completed')!;
useAgentStore.getState().patchAgent(completed.id, { status: 'running', progress: 0 });
useAgentStore.getState().upsertAgent({ ...completed, status: 'idle' });
useAgentStore.getState().updateAgentStatus(completed.id, 'running');
assert.equal(useAgentStore.getState().agents.find((item) => item.id === completed.id)?.status, 'completed', 'live event mutations cannot revive a terminal attempt');
useAgentStore.getState().upsertAgent({ ...completed, id: 'new-attempt', status: 'running' });
assert.equal(useAgentStore.getState().agents.find((item) => item.id === 'new-attempt')?.status, 'running', 'a new attempt identity may run normally');
console.log('agent terminal projection regression tests passed');

const replayMissionId = 'mission-agent-late-replay';
useAgentStore.getState().hydrateMissionFromEvents(replayMissionId, [
  { type: 'task_assigned', missionId: replayMissionId, agentInstanceId: 'builder-late', role: 'builder', taskId: 'build', timestamp: '2026-09-05T11:00:00Z' },
  { type: 'agent_spawned', missionId: replayMissionId, agentInstanceId: 'builder-late', role: 'builder', taskId: 'build', timestamp: '2026-09-05T11:00:01Z' },
  { type: 'task_created', missionId: replayMissionId, agentInstanceId: 'reviewer-late', assignedRole: 'reviewer', taskId: 'review', timestamp: '2026-09-05T11:00:02Z' },
  { type: 'task_assigned', missionId: replayMissionId, agentInstanceId: 'qa-late', role: 'qa', taskId: 'qa', timestamp: '2026-09-05T11:00:03Z' },
]);
const replayRoles = useAgentStore.getState().getAgentsByMission(replayMissionId).map((agent) => agent.role).sort();
assert.deepEqual(replayRoles, ['builder', 'qa', 'reviewer'], 'hydration retains later fixed-role agents across replay pages and assignment-only records');
console.log('agent late-role replay regression tests passed');

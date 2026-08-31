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

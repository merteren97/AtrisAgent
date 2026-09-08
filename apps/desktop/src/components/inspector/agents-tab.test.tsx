import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentsTab } from './agents-tab';
import { useAgentStore } from '@/stores/agent-store';
import { useMissionStore, type Mission } from '@/stores/mission-store';

// Server rendering reads the initial snapshot rather than the client snapshot.
function renderPanel(): string {
  Object.assign(useAgentStore.getInitialState(), useAgentStore.getState());
  Object.assign(useMissionStore.getInitialState(), useMissionStore.getState());
  return renderToStaticMarkup(<AgentsTab />);
}
const mission: Mission = { id: 'panel-test', workspaceId: 'workspace-test', title: 'Research the workflow', status: 'planning', createdAt: '2026-09-07' };
useMissionStore.setState({ missions: [mission], activeMissionId: mission.id, activeTasks: [], timeline: [], missionStateLoading: false, missionStateError: null });
useAgentStore.setState({ agents: [], selectedAgentId: null });
assert.match(renderPanel(), /Preparing the team/, 'planning has an explicit preparation state');

useMissionStore.setState({ missionStateError: 'Connection interrupted' });
const errorMarkup = renderPanel();
assert.match(errorMarkup, /Team could not be loaded/, 'load failure is not an empty team');
assert.match(errorMarkup, /Refresh team/, 'failed loading offers recovery');

useMissionStore.setState({ missionStateError: null, missions: [{ ...mission, status: 'running' }], transportStatus: 'connected', activeTasks: [
  { id: 'research-task', missionId: mission.id, title: 'Inspect the lifecycle', description: '', status: 'running', assignedRole: 'researcher' },
  { id: 'builder-task', missionId: mission.id, title: 'Implement the solution', description: '', status: 'pending', assignedRole: 'builder' },
] });
useAgentStore.setState({ selectedAgentId: 'researcher', agents: [
  { id: 'orchestrator', missionId: mission.id, role: 'orchestrator', model: 'Model', status: 'running' },
  { id: 'researcher', missionId: mission.id, role: 'researcher', displayName: 'Lifecycle researcher', model: 'Model', status: 'running', taskId: 'research-task', parentAgentId: 'orchestrator' },
] });
const liveMarkup = renderPanel();
assert.match(liveMarkup, /Lifecycle researcher/, 'running researchers are visible before completion');
assert(liveMarkup.indexOf('aria-label="Agent team"') < liveMarkup.indexOf('Current work'), 'team navigation is visible before selected-agent details');
assert.match(liveMarkup, /Planned work/, 'unassigned tasks remain visible as planned work');
assert.match(liveMarkup, /Awaiting assignment/, 'planned work is not presented as an active agent');
assert.match(liveMarkup, /aria-pressed="true"/, 'selected agent has an accessible selection state');

useMissionStore.setState({ transportStatus: 'error' });
assert.match(renderPanel(), /Showing last reported activity/, 'disconnected transport does not claim live updates');
console.log('agent panel rendering regressions passed');

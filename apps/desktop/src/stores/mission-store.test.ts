import assert from 'node:assert/strict';
import type { TimelineItem } from './mission-store';
import {
  buildMissionRequestBody,
  fetchMissionEvents,
  missionStartDisposition,
  normalizeAgentProfileIds,
  normalizeMissionStatus,
  projectMissionStatusFromEvent,
  reconcileApprovalTimeline,
  restoreMissionTimeline,
  statusFromStartResponse,
  useMissionStore,
  type Mission,
} from './mission-store';
import { projectMissionProcesses } from '@/lib/process-projection';
import { ApiRequestTimeoutError } from '@/lib/api-client';
import { useAgentStore, type AgentInstance } from '@/stores/agent-store';

assert.equal(missionStartDisposition(202, { accepted: true }), 'accepted', '202 mission starts are treated as accepted');
assert.equal(statusFromStartResponse({ accepted: true, status: 'draft' }, 202, 'draft'), 'starting', 'an accepted draft is presented as starting');
assert.equal(statusFromStartResponse({ accepted: true, status: 'planning' }, 202, 'draft'), 'planning', 'an explicit planning status is preserved after acceptance');
assert.equal(normalizeMissionStatus('initializing'), 'starting', 'provider initialization status maps to starting');
assert.equal(projectMissionStatusFromEvent('draft', 'turn_queued'), 'starting', 'queued events advance a draft mission');
assert.equal(projectMissionStatusFromEvent('running', 'turn_queued'), undefined, 'queued follow-up events do not regress a running mission');
assert.equal(projectMissionStatusFromEvent('completed', 'agent_progressed', { status: 'running' }), 'completed', 'late explicit running metadata does not revive a completed mission');
assert.deepEqual(
  normalizeAgentProfileIds({ builder: ' builder-ui ', researcher: 'research-default', admin: 'ignored', qa: '  ' }),
  { builder: 'builder-ui', researcher: 'research-default' },
  'named profile selections are trimmed to known fixed roles',
);
const namedProfileBody = buildMissionRequestBody('Use the selected specialists', 'workspace-1', {
  agentProfileIds: { builder: ' builder-ui ', reviewer: 'review-profile' },
});
assert.deepEqual(namedProfileBody.agentProfileIds, { builder: 'builder-ui', reviewer: 'review-profile' }, 'mission requests carry named profile selections');
assert.equal(buildMissionRequestBody('Use defaults', 'workspace-1', {}).agentProfileIds, undefined, 'legacy mission requests omit empty profile selections');

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
await useMissionStore.getState().deleteMission(mission.id);
assert.equal(useMissionStore.getState().missions.length, 0, 'deleted conversation is removed from the sidebar state');
assert.equal(useMissionStore.getState().queuedTurns.length, 0, 'deleted conversation queued turns are removed');
assert.equal(useMissionStore.getState().commandQueue.length, 0, 'deleted conversation durable commands are removed');
assert.equal(useMissionStore.getState().activeMissionId, null, 'deleting the active conversation returns to a blank chat');
assert.equal(useMissionStore.getState().timeline.length, 0, 'deleting the active conversation clears its timeline');

useMissionStore.setState({ missions: [mission], activeMissionId: mission.id, error: null });
globalThis.fetch = async () => new Response(JSON.stringify({
  operationId: 'delete-op-1',
  phase: 'runtime',
  status: 'running',
  progress: { completedCount: 1, totalCount: 7 },
}), { status: 202, headers: { 'content-type': 'application/json' } });
const pendingDelete = await useMissionStore.getState().deleteMission(mission.id);
assert.equal(pendingDelete.status, 'pending', '202 conversation deletion remains pending');
assert.equal(useMissionStore.getState().missions.length, 1, 'pending deletion keeps the conversation visible');
assert.equal(useMissionStore.getState().missions[0]?.deletionState?.status, 'pending', 'pending deletion is visible in mission state');
assert.equal(useMissionStore.getState().missions[0]?.deletionState?.operationId, 'delete-op-1', 'pending deletion keeps the durable operation ID');

globalThis.fetch = async () => new Response(JSON.stringify({
  operationId: 'delete-op-1',
  phase: 'runtime',
  status: 'retryable',
  retryable: true,
  error: 'Runtime cleanup is unavailable.',
}), { status: 503, headers: { 'content-type': 'application/json' } });
const retryableDelete = await useMissionStore.getState().deleteMission(mission.id);
assert.equal(retryableDelete.status, 'retryable', '503 conversation deletion is retryable');
assert.equal(useMissionStore.getState().missions[0]?.deletionState?.status, 'retryable', 'retryable deletion remains visible for recovery');
assert.equal(useMissionStore.getState().error, 'Runtime cleanup is unavailable.', 'retryable deletion exposes the server error');

globalThis.fetch = async () => new Response(JSON.stringify({ success: true, operationId: 'delete-op-1', status: 'completed' }), { status: 200, headers: { 'content-type': 'application/json' } });
const completedDelete = await useMissionStore.getState().deleteMission(mission.id);
assert.equal(completedDelete.status, 'completed', '200 conversation deletion confirms completion');
assert.equal(useMissionStore.getState().missions.length, 0, 'conversation is removed only after completed deletion');

useMissionStore.setState({ missions: [mission], activeMissionId: null, error: null });
globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Conversation not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
const missingDelete = await useMissionStore.getState().deleteMission(mission.id);
assert.equal(missingDelete.status, 'not_found', '404 conversation deletion is an already-complete absence');
assert.equal(useMissionStore.getState().missions.length, 0, '404 reconciliation removes the stale local conversation');

useMissionStore.setState({ missions: [mission], activeMissionId: mission.id, error: null });
globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Stop or finish this conversation before deleting it.' }), { status: 409, headers: { 'content-type': 'application/json' } });
await assert.rejects(() => useMissionStore.getState().deleteMission(mission.id), /Stop or finish this conversation before deleting it/, 'rejected conversation deletion remains retryable');
assert.equal(useMissionStore.getState().missions.length, 1, 'failed deletion preserves the conversation');
assert.equal(useMissionStore.getState().error, 'Stop or finish this conversation before deleting it.', 'failed deletion exposes the server reason');

globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Runtime did not acknowledge cancellation.' }), { status: 503, headers: { 'content-type': 'application/json' } });
await assert.rejects(() => useMissionStore.getState().stopMission(mission.id), /Runtime did not acknowledge cancellation/, 'stop failures are throwable for dialog callers');
await assert.rejects(() => useMissionStore.getState().retryMission(mission.id), /Runtime did not acknowledge cancellation/, 'retry failures are throwable for action callers');
globalThis.fetch = originalFetch;

globalThis.fetch = async () => { throw new ApiRequestTimeoutError(30_000); };
await useMissionStore.getState().startMission('Timed mission start', 'workspace-timeout');
const timeoutState = useMissionStore.getState();
assert.equal(timeoutState.loading, false, 'a mission start timeout stops the loading state');
assert.equal(timeoutState.error, null, 'a mission start timeout is not presented as a definitive failure');
assert.equal(timeoutState.pendingMissionStart?.reason, 'deadline', 'a mission start timeout records an uncertain pending request');
assert(!timeoutState.timeline.some((entry) => entry.eventType === 'mission_failed'), 'a mission start timeout does not synthesize a failure event');
globalThis.fetch = originalFetch;

console.log('mission approval lifecycle tests passed');

// Cursor replay must hydrate history beyond the first 500 events. This mocks
// the browser-visible header contract used by the desktop client.
const pageOne = Array.from({ length: 500 }, (_, index) => ({ id: `event-${index}`, type: 'agent_progressed', missionId: 'paged-mission', agentInstanceId: 'builder-1', progress: String(index), timestamp: new Date(0).toISOString() }));
const pageTwo = [
  { id: 'late-builder', type: 'agent_started', missionId: 'paged-mission', agentInstanceId: 'builder-late', role: 'builder', timestamp: '2026-09-05T12:00:00Z' },
  { id: 'late-reviewer', type: 'agent_spawned', missionId: 'paged-mission', agentInstanceId: 'reviewer-late', role: 'reviewer', timestamp: '2026-09-05T12:00:01Z' },
  { id: 'late-check', type: 'check_completed', missionId: 'paged-mission', taskId: 'review', checkName: 'Reviewer checks', passed: true, summary: 'passed', timestamp: '2026-09-05T12:00:02Z' },
];
let fetchCalls: string[] = [];
globalThis.fetch = (async (input) => {
  const url = String(input);
  fetchCalls.push(url);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (url.includes('cursor=')) return new Response(JSON.stringify(pageTwo), { status: 200, headers });
  headers.set('X-Next-Cursor', 'cursor-page-2');
  headers.set('X-Has-More', 'true');
  return new Response(JSON.stringify(pageOne), { status: 200, headers });
}) as typeof fetch;
const pagedEvents = await fetchMissionEvents('paged-mission');
assert.equal(pagedEvents.length, 503, 'cursor replay includes events beyond the first page');
assert(fetchCalls.some((url) => url.includes('cursor=cursor-page-2')), 'cursor replay requests the next page');

let capCalls = 0;
globalThis.fetch = (async () => {
  capCalls += 1;
  const headers = new Headers({ 'content-type': 'application/json', 'X-Has-More': 'true', 'X-Next-Cursor': `cursor-${capCalls}` });
  return new Response(JSON.stringify(pageOne), { status: 200, headers });
}) as typeof fetch;
await assert.rejects(() => fetchMissionEvents('capped-mission'), /100 pages/, 'pagination cap reports incomplete history');
assert.equal(capCalls, 100, 'pagination cap is bounded');

globalThis.fetch = (async () => new Response(JSON.stringify(pageOne), {
  status: 200,
  headers: new Headers({ 'content-type': 'application/json', 'X-Has-More': 'true' }),
})) as typeof fetch;
await assert.rejects(() => fetchMissionEvents('missing-cursor-mission'), /cursor was not exposed/, 'has-more without a cursor fails explicitly');
globalThis.fetch = originalFetch;
console.log('mission event pagination regression tests passed');

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};
const missionAResponse = deferred<Response>();
const missionBResponse = deferred<Response>();
globalThis.fetch = (async (input) => {
  const url = String(input);
  if (url.endsWith('/missions/race-a')) return missionAResponse.promise;
  if (url.endsWith('/missions/race-b')) return missionBResponse.promise;
  const missionId = url.includes('race-a') ? 'race-a' : 'race-b';
  const events = missionId === 'race-b'
    ? [{ id: 'race-b-agent', type: 'agent_spawned', missionId, agentInstanceId: 'race-b-agent', role: 'reviewer', displayName: 'Reviewer Agent', timestamp: '2026-09-05T12:01:00Z' }]
    : [{ id: 'race-a-agent', type: 'agent_spawned', missionId, agentInstanceId: 'race-a-agent', role: 'builder', displayName: 'Builder Agent', timestamp: '2026-09-05T12:00:00Z' }];
  return new Response(JSON.stringify(events), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });
}) as typeof fetch;
useAgentStore.getState().clearMissionAgents('race-a');
useAgentStore.getState().clearMissionAgents('race-b');
useMissionStore.setState({
  activeMissionId: 'race-a',
  missions: [
    { id: 'race-a', workspaceId: 'workspace-race', title: 'A', status: 'running', createdAt: '2026-09-05T12:00:00Z' },
    { id: 'race-b', workspaceId: 'workspace-race', title: 'B', status: 'running', createdAt: '2026-09-05T12:00:00Z' },
  ],
  timeline: [],
  activeTasks: [],
  hydratedMissionId: null,
});
const staleA = useMissionStore.getState().fetchMissionState('race-a');
useMissionStore.setState({ activeMissionId: 'race-b' });
const currentB = useMissionStore.getState().fetchMissionState('race-b');
missionBResponse.resolve(new Response(JSON.stringify({ mission: { id: 'race-b', workspaceId: 'workspace-race', title: 'B', status: 'completed', createdAt: '2026-09-05T12:00:00Z' }, tasks: [] }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }));
await currentB;
missionAResponse.resolve(new Response(JSON.stringify({ mission: { id: 'race-a', workspaceId: 'workspace-race', title: 'A', status: 'completed', createdAt: '2026-09-05T12:00:00Z' }, tasks: [] }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }));
await staleA;
assert.equal(useMissionStore.getState().activeMissionId, 'race-b', 'late inactive mission response does not reclaim the active conversation');
assert.deepEqual(useAgentStore.getState().getAgentsByMission('race-b').map((agent) => agent.role), ['reviewer'], 'current mission agents survive an overlapping stale hydration response');
assert.equal(useAgentStore.getState().getAgentsByMission('race-a').length, 0, 'stale inactive mission response does not hydrate agents');
globalThis.fetch = originalFetch;
console.log('mission hydration race regression tests passed');

// A background mission fetch must not invalidate the active request, and
// live SSE events arriving during that request must survive its snapshot.
const liveSnapshot = deferred<Response>();
globalThis.fetch = (async (input) => {
  const url = String(input);
  if (url.endsWith('/missions/live-race')) return liveSnapshot.promise;
  if (url.endsWith('/missions/background-race')) return new Response(JSON.stringify({ mission: { id: 'background-race' }, tasks: [] }));
  return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
useMissionStore.setState({ activeMissionId: 'live-race', timeline: [], activeTasks: [], hydratedMissionId: null });
const loadingLive = useMissionStore.getState().fetchMissionState('live-race');
await useMissionStore.getState().fetchMissionState('background-race');
const liveStarted = { id: 'live-start', type: 'agent_started', missionId: 'live-race', agentInstanceId: 'live-builder', role: 'builder', sequence: 502, timestamp: '2026-09-05T12:02:00Z' };
const liveCompleted = { id: 'live-complete', type: 'task_completed', missionId: 'live-race', agentInstanceId: 'live-builder', sequence: 503, timestamp: '2026-09-05T12:03:00Z' };
useMissionStore.setState({ timeline: [liveStarted, liveCompleted].map((event) => ({ id: event.id, type: 'event', content: event.type, timestamp: event.timestamp, eventType: event.type, metadata: event })) });
useAgentStore.getState().upsertAgent({ id: 'live-builder', missionId: 'live-race', role: 'builder', model: 'test', status: 'completed' });
liveSnapshot.resolve(new Response(JSON.stringify({ mission: { id: 'live-race', workspaceId: 'workspace-race', title: 'Live', status: 'running', createdAt: '2026-09-05T12:00:00Z' }, tasks: [] }), { headers: { 'content-type': 'application/json' } }));
await loadingLive;
assert.equal(useMissionStore.getState().hydratedMissionId, 'live-race', 'background fetch does not invalidate active hydration');
assert.equal(useMissionStore.getState().missionStateLoading, false, 'active loading state settles after background fetch');
assert.equal(useAgentStore.getState().getAgentsByMission('live-race').find((agent) => agent.id === 'live-builder')?.status, 'completed', 'live agent startup/completion survives an older server snapshot');
globalThis.fetch = originalFetch;
console.log('live event hydration merge regression tests passed');

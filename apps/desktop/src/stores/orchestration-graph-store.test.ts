import assert from 'node:assert/strict';
import {
  VERIFICATION_GATE_ID,
  buildSchematicGraphStructure,
  resetOrchestrationGraphThrottle,
  selectActivePlanTasks,
  useOrchestrationGraphStore,
  type MissionGraphSnapshot,
} from './orchestration-graph-store';

function makeSnapshot(missionId: string, sequence = 10): MissionGraphSnapshot {
  return {
    sequence,
    mission: {
      id: missionId,
      workspaceId: 'ws-1',
      title: 'Test Mission',
      description: 'Verify graph store',
      status: 'running',
      planId: 'plan-1',
      activeRunId: 'run-1',
      createdAt: '2026-11-26T18:00:00Z',
      updatedAt: '2026-11-26T18:00:00Z',
      completedAt: null,
    },
    activePlanId: 'plan-1',
    plans: [{ id: 'plan-1', isActive: true, taskCount: 1 }],
    runs: [],
    turns: [],
    tasks: [
      {
        id: 'task-1',
        missionId,
        planId: 'plan-1',
        title: 'Build schema',
        description: 'Create schema',
        status: 'ready',
        priority: 1,
        assignedAgentId: null,
        assignedRole: 'builder',
        agentProfileId: null,
        specialty: null,
        routePreference: null,
        requiredCapabilities: [],
        dependsOn: [],
        worktreeId: null,
        targetDescriptor: null,
        createdAt: '2026-11-26T18:00:00Z',
        updatedAt: '2026-11-26T18:00:00Z',
        completedAt: null,
      },
    ],
    dependencies: [],
    attempts: [],
    agents: [],
    approvals: [],
    questions: [],
    directives: [],
  };
}

const missionId = 'mission-graph-test';
resetOrchestrationGraphThrottle();
useOrchestrationGraphStore.setState({
  snapshotsByMission: { [missionId]: makeSnapshot(missionId, 10) },
  loadingByMission: {},
  errorByMission: {},
  selectedNodeId: null,
  selectedAgentId: null,
  canvasMode: 'dag',
  layoutPreset: 'split',
});

// 1. Sequence deduplication ignores stale events
useOrchestrationGraphStore.getState().applyMissionEvent(missionId, {
  type: 'task_completed',
  sequence: 10,
  taskId: 'task-1',
  timestamp: '2026-11-26T18:01:00Z',
});
assert.equal(
  useOrchestrationGraphStore.getState().snapshotsByMission[missionId]?.tasks[0]?.status,
  'ready',
  'event with sequence <= snapshot.sequence is ignored',
);

// 2. Newer events update task and agent state in place
useOrchestrationGraphStore.getState().applyMissionEvent(missionId, {
  type: 'agent_started',
  sequence: 11,
  missionId,
  taskId: 'task-1',
  agentInstanceId: 'agent-1',
  role: 'builder',
  displayName: 'Builder Alpha',
  model: 'gpt-5',
  timestamp: '2026-11-26T18:01:05Z',
});

let snap = useOrchestrationGraphStore.getState().snapshotsByMission[missionId]!;
assert.equal(snap.sequence, 11);
assert.equal(snap.tasks[0]?.status, 'running');
assert.equal(snap.tasks[0]?.assignedAgentId, 'agent-1');
assert.equal(snap.agents.length, 1);
assert.equal(snap.agents[0]?.displayName, 'Builder Alpha');

// 3. Progress and approval updates work in place
useOrchestrationGraphStore.getState().applyMissionEvent(missionId, {
  type: 'agent_progressed',
  sequence: 12,
  missionId,
  agentInstanceId: 'agent-1',
  progress: 'Editing files',
  percentage: 55,
  timestamp: '2026-11-26T18:01:10Z',
});
snap = useOrchestrationGraphStore.getState().snapshotsByMission[missionId]!;
assert.equal(snap.agents[0]?.statusMessage, 'Editing files');
assert.equal(snap.agents[0]?.progress, 55);

// 4. Selection, canvasMode, layoutPreset actions
useOrchestrationGraphStore.getState().selectNode('task-1', 'agent-1');
assert.equal(useOrchestrationGraphStore.getState().selectedNodeId, 'task-1');
assert.equal(useOrchestrationGraphStore.getState().selectedAgentId, 'agent-1');

useOrchestrationGraphStore.getState().setCanvasMode('swimlane');
assert.equal(useOrchestrationGraphStore.getState().canvasMode, 'swimlane');

useOrchestrationGraphStore.getState().setLayoutPreset('canvas');
assert.equal(useOrchestrationGraphStore.getState().layoutPreset, 'canvas');

// 5. Throttled hydration on stream_gap and updateTaskRoute PATCH + refresh
let fetchCalls: Array<{ url: string; method: string }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method || 'GET';
  fetchCalls.push({ url, method });
  if (method === 'PATCH') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(makeSnapshot(missionId, 15)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

try {
  await useOrchestrationGraphStore.getState().updateTaskRoute(missionId, 'task-1', {
    modelCatalogId: 'openai/gpt-5',
    reasoningLevel: 'high',
    accountProfileId: 'acc-1',
  });
  assert.equal(fetchCalls.length, 2, 'updateTaskRoute sends PATCH then refreshes graph');
  assert.equal(fetchCalls[0]?.method, 'PATCH');
  assert.ok(fetchCalls[0]?.url.includes(`/missions/${missionId}/tasks/task-1/route`));
  assert.equal(fetchCalls[1]?.method, 'GET');
  assert.ok(fetchCalls[1]?.url.includes(`/missions/${missionId}/graph`));

  fetchCalls = [];
  useOrchestrationGraphStore.getState().applyMissionEvent(missionId, {
    type: 'stream_gap',
    missionId,
  });
  // Wait a microtask for async fetch to register
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetchCalls.length, 1, 'stream_gap triggers graph hydration');

  // 6. Stale-hydration sequence guard: older sequence does not overwrite newer snapshot
  useOrchestrationGraphStore.setState({
    snapshotsByMission: { [missionId]: makeSnapshot(missionId, 20) },
  });
  await useOrchestrationGraphStore.getState().hydrateMissionGraph(missionId);
  assert.equal(
    useOrchestrationGraphStore.getState().snapshotsByMission[missionId]?.sequence,
    20,
    'stale hydration with sequence 15 does not overwrite sequence 20',
  );
} finally {
  resetOrchestrationGraphThrottle();
  globalThis.fetch = originalFetch;
}

// 7. Active-plan filtering excludes superseded plan tasks
const multiPlanSnapshot = makeSnapshot(missionId, 30);
multiPlanSnapshot.activePlanId = 'plan-2';
multiPlanSnapshot.tasks = [
  { ...multiPlanSnapshot.tasks[0]!, id: 'old-task', planId: 'plan-1', assignedRole: 'builder' },
  { ...multiPlanSnapshot.tasks[0]!, id: 'builder-2', planId: 'plan-2', assignedRole: 'builder' },
  { ...multiPlanSnapshot.tasks[0]!, id: 'reviewer-2', planId: 'plan-2', assignedRole: 'reviewer' },
  { ...multiPlanSnapshot.tasks[0]!, id: 'qa-2', planId: 'plan-2', assignedRole: 'qa' },
];
multiPlanSnapshot.dependencies = [
  { id: 'd1', taskId: 'reviewer-2', dependsOnTaskId: 'builder-2' },
  { id: 'd2', taskId: 'qa-2', dependsOnTaskId: 'reviewer-2' },
];
const activeOnly = selectActivePlanTasks(multiPlanSnapshot);
assert.deepEqual(
  activeOnly.map((t) => t.id),
  ['builder-2', 'reviewer-2', 'qa-2'],
  'selectActivePlanTasks filters out superseded plan-1 tasks',
);

// 8. VerificationGate connects to terminal leaf (qa-2), never bypassing reviewer/qa
const structure = buildSchematicGraphStructure(multiPlanSnapshot);
assert.equal(structure.hasGate, true);
assert.equal(
  structure.rawEdges.some((e) => e.source === 'builder-2' && e.target === VERIFICATION_GATE_ID),
  false,
  'builder with downstream reviewer does not bypass to verification gate',
);
assert.equal(
  structure.rawEdges.some((e) => e.source === 'qa-2' && e.target === VERIFICATION_GATE_ID),
  true,
  'terminal QA node connects to verification gate',
);

console.log('orchestration-graph-store tests passed');

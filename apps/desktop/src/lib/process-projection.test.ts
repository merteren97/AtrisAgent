import assert from 'node:assert/strict';
import { projectMissionProcesses } from './process-projection';
import type { Mission, TaskItem, TimelineItem } from '@/stores/mission-store';
import type { AgentInstance } from '@/stores/agent-store';

const mission = {
  id: 'mission-1',
  title: 'Build the product',
  status: 'running',
} as Mission;
const task = { id: 'research-task', title: 'Research architecture' } as TaskItem;
const researcher = {
  id: 'agent-research',
  missionId: mission.id,
  role: 'researcher',
  status: 'running',
  model: 'Gemini',
  taskId: task.id,
} as AgentInstance;
const timeline: TimelineItem[] = [
  {
    id: 'process-start',
    type: 'event',
    eventType: 'process_started',
    content: 'Orchestrator started.',
    timestamp: '12:00',
    metadata: { processId: 'orchestrator-turn-1', role: 'orchestrator' },
  },
  {
    id: 'process-output',
    type: 'event',
    eventType: 'process_output_delta',
    content: 'Planning tasks',
    timestamp: '12:01',
    metadata: { processId: 'orchestrator-turn-1', role: 'orchestrator' },
  },
  {
    id: 'process-output-continued',
    type: 'event',
    eventType: 'process_output_delta',
    content: ' in parallel',
    timestamp: '12:01',
    metadata: { processId: 'orchestrator-turn-1', role: 'orchestrator' },
  },
  {
    id: 'research-output',
    type: 'event',
    eventType: 'text_delta',
    content: 'Found evidence',
    timestamp: '12:02',
    metadata: { agentInstanceId: researcher.id },
  },
];

const processes = projectMissionProcesses(mission, [researcher], [task], timeline);
const orchestrator = processes.find((process) => process.id === 'orchestrator');
const worker = processes.find((process) => process.id === researcher.id);

assert.deepEqual(orchestrator?.stream.map((item) => item.id), ['process-start', 'process-output'], 'logical Orchestrator groups its private runtime sessions');
assert.deepEqual(worker?.stream.map((item) => item.id), ['research-output'], 'worker stream remains isolated by agent identity');
assert.equal(orchestrator?.stream[1]?.category, 'output', 'process output is categorized for the read-only console');
assert.equal(orchestrator?.stream[1]?.content, 'Planning tasks in parallel', 'adjacent output deltas are coalesced into one readable block');
assert.equal(orchestrator?.stream.length, 2, 'coalescing removes token-level telemetry rows');
assert.equal(worker?.task, task.title, 'process catalog resolves the assigned task title');

console.log('process projection tests passed');

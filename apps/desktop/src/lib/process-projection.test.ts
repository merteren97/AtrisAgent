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
  {
    id: 'research-task-completed',
    type: 'event',
    eventType: 'task_completed',
    content: 'Task completed: research-task',
    timestamp: '12:03',
    metadata: { agentInstanceId: researcher.id, taskId: task.id },
  },
  {
    id: 'research-agent-completed',
    type: 'event',
    eventType: 'agent_completed',
    content: 'Research report is ready.',
    timestamp: '12:03',
    metadata: { agentInstanceId: researcher.id, taskId: task.id },
  },
  {
    id: 'research-telemetry',
    type: 'event',
    eventType: 'runtime_telemetry',
    content: 'Runtime telemetry recorded.',
    timestamp: '12:03',
    metadata: { agentInstanceId: researcher.id, taskId: task.id, outcome: 'completed' },
  },
  {
    id: 'failed-telemetry',
    type: 'event',
    eventType: 'runtime_telemetry',
    content: 'Runtime exited unsuccessfully.',
    timestamp: '12:04',
    metadata: { agentInstanceId: researcher.id, taskId: task.id, outcome: 'failed' },
  },
];

const processes = projectMissionProcesses(mission, [researcher], [task], timeline);
const orchestrator = processes.find((process) => process.id === 'orchestrator');
const worker = processes.find((process) => process.id === researcher.id);

assert.deepEqual(orchestrator?.stream.map((item) => item.id), ['process-start', 'process-output'], 'logical Orchestrator groups its private runtime sessions');
assert.deepEqual(worker?.stream.map((item) => item.id), ['research-output', 'research-task-completed', 'failed-telemetry'], 'worker stream coalesces successful terminal bookkeeping without hiding failed telemetry');
assert.equal(orchestrator?.stream[1]?.category, 'output', 'process output is categorized for the read-only console');
assert.equal(orchestrator?.stream[1]?.content, 'Planning tasks in parallel', 'adjacent output deltas are coalesced into one readable block');
assert.equal(orchestrator?.stream.length, 2, 'coalescing removes token-level telemetry rows');
assert.equal(worker?.task, task.title, 'process catalog resolves the assigned task title');
assert.equal(worker?.stream[1]?.label, 'completed', 'task, agent and telemetry completion rows become one lifecycle result');
assert.equal(worker?.stream[1]?.content, 'Research report is ready.', 'the useful agent summary wins over duplicate terminal bookkeeping');
assert.equal(worker?.stream[2]?.category, 'error', 'failed runtime telemetry remains a visible error row');

console.log('process projection tests passed');

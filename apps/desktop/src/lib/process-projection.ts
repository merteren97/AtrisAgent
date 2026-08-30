import type { AgentInstance } from '@/stores/agent-store';
import type { Mission, TaskItem, TimelineItem } from '@/stores/mission-store';

export type ProcessCategory = 'lifecycle' | 'tool' | 'output' | 'error';

export interface MissionProcess {
  id: string;
  name: string;
  role: string;
  status: string;
  model: string;
  task: string;
  parent: string;
  stream: ProcessStreamItem[];
}

export interface ProcessStreamItem {
  id: string;
  timestamp: string;
  category: ProcessCategory;
  label: string;
  content: string;
}

const TOOL_EVENTS = new Set(['agent_tool_call', 'tool_call_started', 'tool_call_completed', 'process_tool_started', 'process_tool_completed']);
const OUTPUT_EVENTS = new Set(['text_delta', 'agent_thought', 'agent_progressed', 'process_output_delta']);
const ERROR_EVENTS = new Set(['agent_error', 'task_failed', 'process_failed']);

function metadataString(item: TimelineItem, key: string): string | undefined {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function streamItem(item: TimelineItem): ProcessStreamItem {
  const eventType = item.eventType || item.type;
  const sourceTimestamp = metadataString(item, 'timestamp');
  const date = sourceTimestamp ? new Date(sourceTimestamp) : null;
  const timestamp = date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : item.timestamp;
  const result = metadataString(item, 'result');
  return {
    id: item.id,
    timestamp,
    category: ERROR_EVENTS.has(eventType)
      ? 'error'
      : TOOL_EVENTS.has(eventType)
        ? 'tool'
        : OUTPUT_EVENTS.has(eventType) || item.type === 'orchestrator_message'
          ? 'output'
          : 'lifecycle',
    label: eventType.replaceAll('_', ' '),
    content: result && eventType.endsWith('_completed') ? `${item.content} ${result}` : item.content,
  };
}

function appendStreamItem(stream: ProcessStreamItem[], item: ProcessStreamItem): void {
  const previous = stream[stream.length - 1];
  if (previous && previous.category === 'output' && item.category === 'output' && previous.label === item.label) {
    previous.content += item.content;
    return;
  }
  stream.push(item);
}

export function projectMissionProcesses(
  mission: Mission,
  agents: AgentInstance[],
  tasks: TaskItem[],
  timeline: TimelineItem[],
): MissionProcess[] {
  const missionAgents = agents.filter((agent) => agent.missionId === mission.id);
  const orchestratorAgent = missionAgents.find((agent) => agent.role.toLowerCase() === 'orchestrator' && !agent.parentAgentId);
  const names = new Map(missionAgents.map((agent) => [agent.id, agent.displayName || agent.role]));
  const taskNames = new Map(tasks.map((task) => [task.id, task.title]));
  const agentIds = new Set(missionAgents.filter((agent) => agent !== orchestratorAgent).map((agent) => agent.id));
  const streams = new Map<string, ProcessStreamItem[]>();
  const orchestratorStart = [...timeline].reverse().find((item) => (
    item.eventType === 'process_started' && metadataString(item, 'role') === 'orchestrator'
  ));

  for (const item of timeline) {
    const explicitProcessId = metadataString(item, 'processId');
    const eventAgentId = metadataString(item, 'agentInstanceId');
    const processRole = metadataString(item, 'role');
    const processId = explicitProcessId && processRole !== 'orchestrator'
      ? explicitProcessId
      : eventAgentId && agentIds.has(eventAgentId)
        ? eventAgentId
        : 'orchestrator';
    const current = streams.get(processId) || [];
    appendStreamItem(current, streamItem(item));
    streams.set(processId, current);
  }

  const orchestrator: MissionProcess = {
    id: 'orchestrator',
    name: 'Orchestrator',
    role: 'orchestrator',
    status: orchestratorAgent?.status || mission.status,
    model: orchestratorAgent?.model || (orchestratorStart && metadataString(orchestratorStart, 'model')) || 'Not reported',
    task: mission.title,
    parent: 'Mission',
    stream: streams.get('orchestrator') || [],
  };

  return [orchestrator, ...missionAgents
    .filter((agent) => agent !== orchestratorAgent)
    .map((agent): MissionProcess => ({
      id: agent.id,
      name: agent.displayName || `${agent.role.charAt(0).toUpperCase()}${agent.role.slice(1)} Agent`,
      role: agent.role,
      status: agent.status,
      model: agent.model || 'Not reported',
      task: (agent.taskId && taskNames.get(agent.taskId)) || agent.statusMessage || 'No task reported',
      parent: (agent.parentAgentId && names.get(agent.parentAgentId)) || 'Orchestrator',
      stream: streams.get(agent.id) || [],
    }))];
}

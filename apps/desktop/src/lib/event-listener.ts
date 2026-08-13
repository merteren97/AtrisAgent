import { useMissionStore, type TimelineItem } from '@/stores/mission-store';
import { useAgentStore } from '@/stores/agent-store';
import { getApiOrigin, runtimeHeaders } from '@/lib/api-client';
import { getAuthToken, notifyUnauthorized } from '@/lib/token-provider';
import { consumeSseFrames } from '@/lib/sse-parser';

let reconnectTimer: number | null = null;
let streamAbortController: AbortController | null = null;
let transportActive = false;
let needsReconcile = false;

function timestampLabel(value?: string): string {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime())
    ? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function append(eventData: any, content: string, options: Partial<TimelineItem> = {}): void {
  const store = useMissionStore.getState();
  if (store.activeMissionId && eventData.missionId && store.activeMissionId !== eventData.missionId) return;
  store.addTimelineItem({
    id: eventData.id || crypto.randomUUID(),
    type: options.type || 'event',
    content,
    timestamp: timestampLabel(eventData.timestamp),
    eventType: options.eventType || eventData.type,
    agentRole: options.agentRole,
    metadata: { ...eventData, ...options.metadata },
  });
}

function shortAgent(agentId?: string): string {
  return agentId ? agentId.slice(0, 8) : 'agent';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function handleIncomingEvent(eventData: any): void {
  if (!eventData?.type) return;
  const missions = useMissionStore.getState();
  const agents = useAgentStore.getState();

  switch (eventData.type) {
    case 'user_message': {
      const content = String(eventData.content || '').trim();
      if (!content) break;
      // Continuation is optimistic in the composer, while the backend also
      // persists/broadcasts the canonical user turn. Avoid a temporary duplicate;
      // the next hydration replaces the optimistic card with this persisted event.
      const alreadyVisible = missions.timeline.some((item) => item.type === 'user_message' && item.content.trim() === content);
      if (!alreadyVisible) append(eventData, content, { type: 'user_message' });
      break;
    }

    case 'mission_started':
      append(eventData, `Mission started: ${eventData.title || eventData.missionId}`, { agentRole: 'orchestrator' });
      if (eventData.missionId) missions.updateMissionStatus(eventData.missionId, 'running');
      break;

    case 'plan_generated':
      append(eventData, eventData.summary || `Generated ${eventData.taskCount || 0} executable tasks.`, {
        agentRole: 'orchestrator', metadata: { taskCount: eventData.taskCount, planId: eventData.planId },
      });
      break;

    case 'plan_revised':
      append(eventData, `Plan revised: ${eventData.reason || 'Execution evidence changed the plan.'}`, {
        agentRole: 'orchestrator', metadata: { planId: eventData.planId, previousPlanId: eventData.previousPlanId, changedTaskIds: eventData.changedTaskIds },
      });
      break;

    case 'task_created': {
      const role = optionalString(eventData.assignedRole) || 'orchestrator';
      append(eventData, `Task ready: ${eventData.title || eventData.taskId}`, { agentRole: role });
      if (eventData.taskId) missions.patchTask(eventData.taskId, {
        status: 'ready',
        assignedRole: optionalString(eventData.assignedRole),
        ...(optionalString(eventData.agentInstanceId) ? { assignedAgentId: optionalString(eventData.agentInstanceId) } : {}),
      });
      break;
    }

    case 'task_assigned': {
      const assignedAgentId = optionalString(eventData.agentInstanceId);
      append(eventData, `Task assigned to ${eventData.role}: ${eventData.taskId}`, { agentRole: eventData.role });
      if (eventData.taskId) missions.patchTask(eventData.taskId, {
        status: 'ready',
        assignedRole: optionalString(eventData.role),
        ...(assignedAgentId ? { assignedAgentId } : {}),
      });
      break;
    }

    case 'task_claimed': {
      const task = missions.activeTasks.find((item) => item.id === eventData.taskId);
      const assignedAgentId = optionalString(eventData.agentInstanceId);
      append(eventData, `Execution context prepared for ${eventData.taskId}.`, { agentRole: task?.assignedRole || 'agent' });
      if (eventData.taskId) missions.patchTask(eventData.taskId, {
        status: 'claimed',
        ...(assignedAgentId ? { assignedAgentId } : {}),
        ...(optionalString(eventData.worktreePath) ? { worktreeId: optionalString(eventData.worktreePath) } : {}),
      });
      break;
    }

    case 'task_split':
      append(eventData, `Task split into ${eventData.childTaskIds?.length || 0} focused tasks: ${eventData.reason || ''}`, { agentRole: 'orchestrator' });
      break;

    case 'task_merged':
      append(eventData, `Tasks merged into ${eventData.mergedTaskId}: ${eventData.reason || ''}`, { agentRole: 'orchestrator' });
      break;

    case 'agent_spawned':
      append(eventData, `${eventData.displayName || eventData.role || 'Agent'} spawned${eventData.parentAgentId ? ` by ${shortAgent(eventData.parentAgentId)}` : ''}: ${eventData.spawnReason || 'Specialized work required.'}`, {
        agentRole: eventData.role,
      });
      agents.upsertAgent({
        id: eventData.agentInstanceId,
        missionId: eventData.missionId || '',
        role: eventData.role || 'builder',
        model: eventData.model || 'Scheduler selected',
        status: 'idle',
        parentAgentId: eventData.parentAgentId ?? null,
        displayName: eventData.displayName,
        specialty: eventData.specialty,
        taskId: eventData.taskId ?? null,
        spawnReason: eventData.spawnReason,
        workspaceMode: eventData.workspaceMode,
        progress: 0,
        unreadMessages: 0,
        createdAt: eventData.timestamp,
        lastActivityAt: eventData.timestamp,
      });
      break;

    case 'agent_started': {
      append(eventData, `${eventData.displayName || eventData.role || 'Agent'} started with ${eventData.model || 'runtime-selected model'}.`, { agentRole: eventData.role });
      agents.upsertAgent({
        id: eventData.agentInstanceId,
        missionId: eventData.missionId || '',
        role: eventData.role || 'builder',
        model: eventData.model || 'Runtime selected',
        status: 'running',
        parentAgentId: eventData.parentAgentId,
        displayName: eventData.displayName,
        specialty: eventData.specialty,
        taskId: eventData.taskId,
        spawnReason: eventData.spawnReason,
        workspaceMode: eventData.workspaceMode,
        startedAt: eventData.timestamp,
        lastActivityAt: eventData.timestamp,
      });
      if (eventData.taskId) missions.patchTask(eventData.taskId, {
        status: 'running',
        assignedRole: optionalString(eventData.role),
        assignedAgentId: optionalString(eventData.agentInstanceId),
      });
      break;
    }

    case 'agent_progressed': {
      append(eventData, eventData.progress || 'Agent progress updated.', { agentRole: eventData.role || 'agent' });
      const activeAgent = agents.agents.find((agent) => agent.id === eventData.agentInstanceId);
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, {
        status: 'running',
        statusMessage: eventData.progress,
        progress: typeof eventData.percentage === 'number' ? eventData.percentage : undefined,
        lastActivityAt: eventData.timestamp,
      });
      const taskId = optionalString(eventData.taskId) || optionalString(activeAgent?.taskId);
      if (taskId) missions.patchTask(taskId, { status: 'running' });
      break;
    }

    case 'agent_waiting':
      append(eventData, `Agent waiting: ${eventData.reason || 'Waiting for another agent or dependency.'}`, { agentRole: eventData.role || 'agent' });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, {
        status: 'waiting', statusMessage: eventData.reason, lastActivityAt: eventData.timestamp,
      });
      break;

    case 'agent_resumed':
      append(eventData, `Agent resumed${eventData.reason ? `: ${eventData.reason}` : '.'}`, { agentRole: eventData.role || 'agent' });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, {
        status: 'running', statusMessage: eventData.reason || 'Resumed', lastActivityAt: eventData.timestamp,
      });
      break;

    case 'agent_completed':
      append(eventData, eventData.summary || 'Agent completed its execution.', { agentRole: eventData.role || 'agent' });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, {
        status: 'completed', progress: 100, statusMessage: eventData.summary || 'Completed', completedAt: eventData.timestamp, lastActivityAt: eventData.timestamp,
      });
      break;

    case 'agent_message_sent': {
      const from = agents.agents.find((agent) => agent.id === eventData.fromAgentId);
      const to = agents.agents.find((agent) => agent.id === eventData.toAgentId);
      append(eventData, `${from?.displayName || from?.role || shortAgent(eventData.fromAgentId)} → ${to?.displayName || to?.role || shortAgent(eventData.toAgentId)}: ${eventData.content}`, {
        agentRole: from?.role || 'agent', metadata: { kind: eventData.kind },
      });
      if (to) agents.patchAgent(to.id, {
        unreadMessages: (to.unreadMessages || 0) + 1,
        lastActivityAt: eventData.timestamp,
      });
      break;
    }

    case 'agent_message_read': {
      const target = agents.agents.find((agent) => agent.id === eventData.agentInstanceId);
      if (target) agents.patchAgent(target.id, {
        unreadMessages: Math.max(0, (target.unreadMessages || 0) - 1,
        ),
        lastActivityAt: eventData.timestamp,
      });
      break;
    }

    case 'agent_context_attached':
      append(eventData, `Context attached: ${eventData.label || eventData.sourceType}`, { agentRole: eventData.role || 'agent' });
      break;

    case 'agent_context_compacted':
      append(eventData, `Context compacted${eventData.beforeTokens && eventData.afterTokens ? `: ${eventData.beforeTokens} → ${eventData.afterTokens} tokens` : '.'}`, { agentRole: eventData.role || 'agent' });
      break;

    case 'agent_thought':
      append(eventData, eventData.thought || 'Agent is reasoning.', { agentRole: eventData.agentRole || 'agent' });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, { lastActivityAt: eventData.timestamp });
      break;

    case 'text_delta': {
      const sourceAgent = agents.agents.find((agent) => agent.id === eventData.agentInstanceId);
      append(eventData, eventData.content || '', { type: 'orchestrator_message', agentRole: sourceAgent?.role || eventData.agentRole || 'agent' });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, { lastActivityAt: eventData.timestamp });
      break;
    }

    case 'agent_tool_call':
    case 'tool_call_started':
      append(eventData, `Tool started: ${eventData.toolName || 'tool'}`, {
        agentRole: eventData.agentRole || 'agent', metadata: { toolName: eventData.toolName, args: eventData.args },
      });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, {
        statusMessage: `Using ${eventData.toolName || 'tool'}`, lastActivityAt: eventData.timestamp,
      });
      break;

    case 'tool_call_completed':
      append(eventData, `${eventData.toolName || 'Tool'} ${eventData.success ? 'completed' : 'failed'}.`, {
        agentRole: eventData.agentRole || 'agent', metadata: { result: eventData.result, success: eventData.success },
      });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, {
        statusMessage: `${eventData.toolName || 'Tool'} ${eventData.success ? 'completed' : 'failed'}`,
        lastActivityAt: eventData.timestamp,
      });
      break;

    case 'file_changed':
      append(eventData, `${eventData.changeType || 'Modified'} ${eventData.path}`, { agentRole: eventData.agentRole || 'builder' });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, {
        statusMessage: `${eventData.changeType || 'Modified'} ${eventData.path}`, lastActivityAt: eventData.timestamp,
      });
      break;

    case 'approval_requested':
      append(eventData, eventData.description || 'Approval required.', { agentRole: 'orchestrator' });
      if (eventData.missionId) missions.updateMissionStatus(eventData.missionId, 'waiting_for_approval');
      break;

    case 'verification_started':
      append(eventData, 'Verification started.', { agentRole: 'reviewer' });
      if (eventData.missionId) missions.updateMissionStatus(eventData.missionId, 'verifying');
      break;

    case 'verification_finding':
      append(eventData, `${String(eventData.severity || 'finding').toUpperCase()}: ${eventData.title || eventData.description}`, { agentRole: 'reviewer' });
      break;

    case 'verification_completed':
      append(eventData, `${eventData.passed ? 'Verification passed' : 'Verification found issues'} — ${eventData.summary || `${eventData.findingCount || 0} findings`}`, { agentRole: 'reviewer' });
      break;

    case 'review_completed':
      append(eventData, eventData.approved ? 'Review approved.' : `Review requested changes: ${eventData.findings || ''}`, { agentRole: 'reviewer' });
      break;

    case 'revision_requested':
      append(eventData, `Revision sent back to the Builder: ${eventData.reason}`, { agentRole: 'reviewer' });
      if (eventData.taskId) missions.patchTask(eventData.taskId, { status: 'revision_requested' });
      if (eventData.missionId) missions.updateMissionStatus(eventData.missionId, 'revising');
      break;

    case 'check_completed':
      append(eventData, `${eventData.checkName || 'Check'}: ${eventData.passed ? 'passed' : 'failed'} — ${eventData.summary || ''}`, { agentRole: 'qa' });
      break;

    case 'changes_applied':
      append(eventData, `Changes applied. ${eventData.filesChanged || 0} files changed.`, { agentRole: 'orchestrator' });
      break;

    case 'task_completed':
      append(eventData, `Task completed: ${eventData.taskId}`, { agentRole: eventData.agentRole || 'builder' });
      if (eventData.taskId) missions.patchTask(eventData.taskId, { status: 'done' });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, { status: 'completed', progress: 100, lastActivityAt: eventData.timestamp });
      void missions.fetchMissionState(eventData.missionId);
      break;

    case 'task_failed':
      append(eventData, `Execution failed: ${eventData.error || 'Unknown runtime error'}`, { agentRole: eventData.agentRole || 'builder' });
      if (eventData.taskId) missions.patchTask(eventData.taskId, { status: 'rejected' });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, {
        status: 'failed', statusMessage: eventData.error || 'Execution failed', completedAt: eventData.timestamp, lastActivityAt: eventData.timestamp,
      });
      void missions.fetchMissionState(eventData.missionId);
      break;

    case 'agent_error':
      // stderr/runtime diagnostics can be emitted before a terminal task_failed.
      // Surface the evidence without turning a still-running task into a false failure.
      append(eventData, `Runtime diagnostic: ${eventData.error || 'Unknown runtime diagnostic'}`, { agentRole: eventData.agentRole || 'agent' });
      if (eventData.agentInstanceId) agents.patchAgent(eventData.agentInstanceId, {
        statusMessage: eventData.error || 'Runtime diagnostic', lastActivityAt: eventData.timestamp,
      });
      break;

    case 'mission_completed':
      append(eventData, eventData.summary || 'Mission completed.', { type: 'orchestrator_message', agentRole: 'orchestrator' });
      if (eventData.missionId) missions.updateMissionStatus(eventData.missionId, 'completed');
      break;

    case 'mission_failed':
      append(eventData, `Mission failed: ${eventData.reason || 'Unknown error'}`, { agentRole: 'orchestrator' });
      if (eventData.missionId) missions.updateMissionStatus(eventData.missionId, 'failed');
      break;

    default:
      append(eventData, `Event: ${eventData.type}`);
  }
}

function markTransportGap(): void {
  needsReconcile = true;
}

function reconcileAfterGap(): void {
  if (!needsReconcile) return;
  needsReconcile = false;
  const missionId = useMissionStore.getState().activeMissionId;
  if (missionId) void useMissionStore.getState().fetchMissionState(missionId);
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (transportActive) void connectSse();
  }, 2_000);
}

function handleSseFrame(frame: string): void {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return;
  try {
    handleIncomingEvent(JSON.parse(data));
  } catch (error) {
    console.error('[EventListener] Invalid SSE event:', error);
  }
}

async function connectSse(): Promise<void> {
  const token = getAuthToken();
  if (!transportActive || !token) return;
  streamAbortController?.abort();
  const controller = new AbortController();
  streamAbortController = controller;
  try {
    const headers = runtimeHeaders({
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
      'Cache-Control': 'no-cache',
    });
    const response = await fetch(`${getApiOrigin()}/api/events/stream`, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 401) {
      notifyUnauthorized();
      return;
    }
    if (!response.ok || !response.body) throw new Error(`SSE connection failed with ${response.status}`);
    reconcileAfterGap();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (transportActive && !controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      const parsed = consumeSseFrames(buffer, decoder.decode(value, { stream: true }));
      buffer = parsed.remainder;
      parsed.frames.forEach(handleSseFrame);
    }
    if (buffer.trim()) handleSseFrame(buffer.replace(/\r/g, ''));
    if (transportActive && !controller.signal.aborted) {
      markTransportGap();
      scheduleReconnect();
    }
  } catch (error) {
    if (!transportActive || controller.signal.aborted) return;
    console.warn('[EventListener] Authenticated SSE connection failed:', error);
    markTransportGap();
    scheduleReconnect();
  } finally {
    if (streamAbortController === controller) streamAbortController = null;
  }
}

/** Force the active listener onto the latest runtime origin/token after recovery. */
export function reconnectEventListener(): void {
  if (!transportActive) return;
  markTransportGap();
  streamAbortController?.abort();
  streamAbortController = null;
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  void connectSse();
}

/** Uses fetch streaming so the bearer header never appears in a URL. */
export function initEventListener(): () => void {
  transportActive = true;
  streamAbortController?.abort();
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  void connectSse();
  return () => {
    transportActive = false;
    streamAbortController?.abort();
    streamAbortController = null;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    needsReconcile = false;
  };
}

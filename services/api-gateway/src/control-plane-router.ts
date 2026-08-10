import type { Express, Request, Response } from 'express';
import type { AgentMessage, AgentRole } from '@atris-agent-code/domain';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import type { CoordinationMCP } from '@atris-agent-code/coordination-mcp';
import { ControlPlaneGrantRegistry, type ControlPlaneGrant } from './control-plane-grants';

const VALID_ROLES = new Set<AgentRole>(['orchestrator', 'builder', 'reviewer', 'researcher', 'qa']);
const MESSAGE_KINDS = new Set<NonNullable<AgentMessage['kind']>>(['message', 'handoff', 'review_request', 'summary']);
const TERMINAL_TASK_STATES = new Set(['done', 'rejected', 'failed', 'cancelled']);
const FAILURE_TASK_STATES = new Set(['rejected', 'failed', 'cancelled']);

const SPAWN_POLICY: Record<AgentRole, AgentRole[]> = {
  orchestrator: ['builder', 'reviewer', 'researcher', 'qa'],
  builder: ['reviewer', 'researcher', 'qa'],
  reviewer: ['researcher', 'qa'],
  researcher: ['researcher'],
  qa: ['researcher'],
};

export interface ControlPlaneServices {
  coordination: CoordinationMCP;
  eventBus: LocalEventBus;
  workspaceManager: WorkspaceManager;
  grants: ControlPlaneGrantRegistry;
}

interface AgentView {
  id: string;
  missionId: string;
  role?: string | null;
  status: string;
  taskId?: string | null;
  parentAgentId?: string | null;
  displayName?: string;
  model?: string;
}

function normalizeRole(value: unknown): AgentRole {
  const role = String(value || '').toLowerCase() as AgentRole;
  if (!VALID_ROLES.has(role)) throw new Error(`Unsupported agent role '${String(value || '')}'.`);
  return role;
}

function callerRole(grant: ControlPlaneGrant): AgentRole {
  return normalizeRole(grant.role);
}

function cleanString(value: unknown, maxLength = 8_000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, maxLength);
}

async function listMissionAgents(
  services: Pick<ControlPlaneServices, 'coordination' | 'workspaceManager'>,
  missionId: string,
): Promise<AgentView[]> {
  const registered = services.coordination.listAgents(missionId) as AgentView[];
  const tasks = await services.workspaceManager.listTasks(missionId);
  const byId = new Map<string, AgentView>();

  for (const agent of registered) byId.set(agent.id, { ...agent });
  for (const task of tasks) {
    if (!task.assignedAgentId) continue;
    const existing = byId.get(task.assignedAgentId);
    const taskStatus = String(task.status || 'idle');
    const inferredStatus = FAILURE_TASK_STATES.has(taskStatus)
      ? 'failed'
      : taskStatus === 'done'
        ? 'completed'
        : taskStatus === 'running'
          ? 'running'
          : existing?.status || 'idle';
    byId.set(task.assignedAgentId, {
      id: task.assignedAgentId,
      missionId,
      role: existing?.role || task.assignedRole,
      status: inferredStatus === 'running' && existing?.status === 'waiting' ? 'waiting' : inferredStatus,
      taskId: task.id,
      parentAgentId: existing?.parentAgentId,
      displayName: existing?.displayName || task.title,
      model: existing?.model,
    });
  }

  return [...byId.values()];
}

async function requireMissionAgent(
  services: Pick<ControlPlaneServices, 'coordination' | 'workspaceManager'>,
  missionId: string,
  agentId: string,
): Promise<AgentView> {
  const agent = (await listMissionAgents(services, missionId)).find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error(`Agent ${agentId} is not part of mission ${missionId}.`);
  return agent;
}

function assertSpawnAllowed(grant: ControlPlaneGrant, requestedRole: AgentRole): void {
  const allowed = SPAWN_POLICY[callerRole(grant)];
  if (!allowed.includes(requestedRole)) {
    throw new Error(`${grant.role} agents are not allowed to spawn a ${requestedRole} agent.`);
  }
}

async function effectiveAgentState(
  services: Pick<ControlPlaneServices, 'coordination' | 'workspaceManager'>,
  missionId: string,
  agentId: string,
): Promise<AgentView> {
  return requireMissionAgent(services, missionId, agentId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnForCaller(
  services: ControlPlaneServices,
  grant: ControlPlaneGrant,
  args: Record<string, any>,
  forcedRole?: AgentRole,
  forcedInstruction?: string,
  forcedReason?: string,
) {
  const role = forcedRole || normalizeRole(args.role || 'researcher');
  assertSpawnAllowed(grant, role);

  const instruction = forcedInstruction || cleanString(args.instruction, 20_000);
  if (!instruction) throw new Error('agent_spawn requires a non-empty instruction.');

  const spawnReason = forcedReason || cleanString(args.spawnReason, 2_000) || `Delegated by ${grant.role} agent ${grant.agentInstanceId}.`;
  const isOrchestrator = callerRole(grant) === 'orchestrator';

  return services.coordination.spawnAgent({
    missionId: grant.missionId,
    parentAgentId: grant.agentInstanceId,
    role,
    instruction,
    displayName: cleanString(args.displayName, 120),
    specialty: cleanString(args.specialty, 160),
    spawnReason,
    capabilities: Array.isArray(args.capabilities) ? args.capabilities.map(String).slice(0, 24) : undefined,
    priority: ['low', 'medium', 'high', 'critical'].includes(String(args.priority)) ? args.priority : undefined,
    modelCatalogId: isOrchestrator ? cleanString(args.modelCatalogId, 512) : undefined,
    accountProfileId: isOrchestrator ? cleanString(args.accountProfileId, 512) : undefined,
    reasoningLevel: cleanString(args.reasoningLevel, 32),
    fallbackCatalogIds: isOrchestrator && Array.isArray(args.fallbackCatalogIds)
      ? args.fallbackCatalogIds.map(String).filter(Boolean).slice(0, 8)
      : undefined,
    routeSelectionMode: isOrchestrator && ['auto', 'prefer', 'fixed'].includes(String(args.routeSelectionMode))
      ? args.routeSelectionMode
      : undefined,
  });
}

export async function dispatchControlPlaneTool(
  services: ControlPlaneServices,
  grant: ControlPlaneGrant,
  tool: string,
  args: Record<string, any> = {},
): Promise<unknown> {
  switch (tool) {
    case 'agent_get_context': {
      const [mission, activity, agents] = await Promise.all([
        services.coordination.getWorkspaceContext(undefined, grant.missionId, grant.taskId),
        services.coordination.getAgentActivity(grant.agentInstanceId, grant.missionId),
        listMissionAgents(services, grant.missionId),
      ]);
      return {
        identity: {
          agentInstanceId: grant.agentInstanceId,
          missionId: grant.missionId,
          taskId: grant.taskId,
          role: grant.role,
          grantExpiresAt: grant.expiresAt,
        },
        mission,
        activity,
        team: agents,
        unreadMessages: services.coordination.readAgentMessages(grant.agentInstanceId, true, false).length,
      };
    }

    case 'agent_list':
      return { missionId: grant.missionId, agents: await listMissionAgents(services, grant.missionId) };

    case 'agent_spawn':
      return spawnForCaller(services, grant, args);

    case 'agent_send_message': {
      const toAgentId = cleanString(args.toAgentId, 256);
      const content = cleanString(args.content, 20_000);
      if (!toAgentId || !content) throw new Error('agent_send_message requires toAgentId and content.');
      await requireMissionAgent(services, grant.missionId, toAgentId);
      const kind = MESSAGE_KINDS.has(args.kind) ? args.kind : 'message';
      return services.coordination.sendAgentMessage({
        missionId: grant.missionId,
        fromAgentId: grant.agentInstanceId,
        toAgentId,
        content,
        kind,
        replyToMessageId: cleanString(args.replyToMessageId, 256),
      });
    }

    case 'agent_read_messages': {
      const unreadOnly = args.unreadOnly !== false;
      const markRead = args.markRead !== false;
      return {
        agentInstanceId: grant.agentInstanceId,
        messages: services.coordination.readAgentMessages(grant.agentInstanceId, unreadOnly, markRead),
      };
    }

    case 'agent_await': {
      const rawIds = Array.isArray(args.agentIds) ? args.agentIds : args.agentId ? [args.agentId] : [];
      const agentIds = [...new Set(rawIds.map(String).filter(Boolean))].slice(0, 8);
      if (agentIds.length === 0) throw new Error('agent_await requires at least one agentId.');
      for (const agentId of agentIds) await requireMissionAgent(services, grant.missionId, agentId);

      const timeoutMs = Math.min(20_000, Math.max(50, Number(args.timeoutMs) || 5_000));
      const waitFor = args.waitFor === 'any' ? 'any' : 'all';
      const startedAt = Date.now();
      let states: AgentView[] = [];

      while (Date.now() - startedAt < timeoutMs) {
        states = await Promise.all(agentIds.map((agentId) => effectiveAgentState(services, grant.missionId, agentId)));
        const terminal = states.map((state) => ['completed', 'failed'].includes(state.status));
        if ((waitFor === 'all' && terminal.every(Boolean)) || (waitFor === 'any' && terminal.some(Boolean))) {
          return { completed: true, timedOut: false, states };
        }
        await sleep(250);
      }
      states = await Promise.all(agentIds.map((agentId) => effectiveAgentState(services, grant.missionId, agentId)));
      return { completed: false, timedOut: true, states };
    }

    case 'agent_request_review': {
      const existingReviewerId = cleanString(args.reviewerAgentId, 256);
      const requestText = cleanString(args.request, 20_000)
        || `Review the work produced by agent ${grant.agentInstanceId} for task ${grant.taskId}. Return concrete findings and an approve/revision recommendation.`;
      if (existingReviewerId) {
        const reviewer = await requireMissionAgent(services, grant.missionId, existingReviewerId);
        if (String(reviewer.role).toLowerCase() !== 'reviewer') throw new Error('reviewerAgentId must reference a Reviewer agent.');
        return services.coordination.sendAgentMessage({
          missionId: grant.missionId,
          fromAgentId: grant.agentInstanceId,
          toAgentId: existingReviewerId,
          content: requestText,
          kind: 'review_request',
        });
      }
      return spawnForCaller(
        services,
        grant,
        { ...args, specialty: args.specialty || 'Independent Reviewer' },
        'reviewer',
        requestText,
        cleanString(args.spawnReason, 2_000) || `Independent review requested by ${grant.role} agent ${grant.agentInstanceId}.`,
      );
    }

    case 'agent_handoff': {
      const toAgentId = cleanString(args.toAgentId, 256);
      const summary = cleanString(args.summary, 20_000);
      if (!toAgentId || !summary) throw new Error('agent_handoff requires toAgentId and summary.');
      await requireMissionAgent(services, grant.missionId, toAgentId);
      const message = await services.coordination.sendAgentMessage({
        missionId: grant.missionId,
        fromAgentId: grant.agentInstanceId,
        toAgentId,
        content: summary,
        kind: 'handoff',
      });
      services.eventBus.emit({
        id: crypto.randomUUID(),
        type: 'agent_waiting',
        missionId: grant.missionId,
        agentInstanceId: grant.agentInstanceId,
        reason: cleanString(args.reason, 1_000) || `Handed off work to ${toAgentId}.`,
        waitingForAgentId: toAgentId,
        timestamp: new Date().toISOString(),
      });
      return { status: 'waiting', message };
    }

    case 'agent_report_progress': {
      const progress = cleanString(args.progress, 8_000);
      if (!progress) throw new Error('agent_report_progress requires progress text.');
      const percentage = typeof args.percentage === 'number' ? Math.max(0, Math.min(100, args.percentage)) : undefined;
      await services.coordination.reportProgress(grant.taskId, progress, percentage, args.details);
      return { status: 'reported', taskId: grant.taskId, percentage };
    }

    case 'agent_attach_context': {
      const label = cleanString(args.label, 256);
      const sourceType = cleanString(args.sourceType, 128);
      if (!label || !sourceType) throw new Error('agent_attach_context requires label and sourceType.');
      services.eventBus.emit({
        id: crypto.randomUUID(),
        type: 'agent_context_attached',
        missionId: grant.missionId,
        agentInstanceId: grant.agentInstanceId,
        label,
        sourceType,
        sourceId: cleanString(args.sourceId, 512),
        tokenEstimate: typeof args.tokenEstimate === 'number' ? Math.max(0, Math.min(2_000_000, Math.round(args.tokenEstimate))) : undefined,
        timestamp: new Date().toISOString(),
      });
      return { status: 'attached', label, sourceType };
    }

    case 'workspace_get_rules':
      return services.coordination.getWorkspaceRules();

    default:
      throw new Error(`Unknown Atris control-plane tool: ${tool}`);
  }
}

export function installControlPlaneRoutes(app: Express, services: ControlPlaneServices): void {
  app.post('/api/internal/control-plane/call', async (req: Request, res: Response) => {
    let grant: ControlPlaneGrant | null = null;
    try {
      grant = services.grants.authorize(req.headers.authorization);
    } catch (error: any) {
      return void res.status(429).json({ ok: false, error: error?.message || 'Control-plane rate limit exceeded.' });
    }
    if (!grant) return void res.status(401).json({ ok: false, error: 'Invalid or expired Atris control-plane grant.' });

    try {
      const tool = String(req.body?.tool || '');
      const args = req.body?.arguments && typeof req.body.arguments === 'object' ? req.body.arguments : {};
      const result = await dispatchControlPlaneTool(services, grant, tool, args);
      res.json({ ok: true, result });
    } catch (error: any) {
      const message = error?.message || 'Atris control-plane call failed.';
      const forbidden = /not allowed|another mission|not part of mission|must reference/i.test(message);
      res.status(forbidden ? 403 : 400).json({ ok: false, error: message });
    }
  });
}

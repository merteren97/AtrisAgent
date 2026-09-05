import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import type { Orchestrator } from '@atris-agent-code/orchestration-core';
import type { AtrisDatabase } from '@atris-agent-code/database';

import { CoordinationMCP } from './coordination.js';

export interface CoordinationMCPServerOptions {
  workspaceManager?: WorkspaceManager;
  orchestrator?: Orchestrator;
  eventBus?: LocalEventBus;
  db?: AtrisDatabase;
  workspacePath?: string;
  missionId?: string;
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export class CoordinationMCPServer {
  private server: Server;
  private workspaceManager?: WorkspaceManager;
  private orchestrator?: Orchestrator;
  private eventBus?: LocalEventBus;
  private db?: AtrisDatabase;
  private workspacePath: string;
  private activeMissionId?: string;
  private coordination: CoordinationMCP;

  constructor(options: CoordinationMCPServerOptions = {}) {
    this.workspaceManager = options.workspaceManager;
    this.orchestrator = options.orchestrator;
    this.eventBus = options.eventBus;
    this.db = options.db;
    this.workspacePath = options.workspacePath || process.cwd();
    this.activeMissionId = options.missionId;
    this.coordination = new CoordinationMCP({
      workspaceManager: this.workspaceManager,
      orchestrator: this.orchestrator,
      eventBus: this.eventBus,
      db: this.db,
      workspacePath: this.workspacePath,
    });

    this.server = new Server(
      { name: 'coordination-mcp', version: '0.2.0' },
      { capabilities: { tools: {}, resources: {} } },
    );

    this.setupToolHandlers();
    this.setupResourceHandlers();
  }

  getCoordination(): CoordinationMCP { return this.coordination; }

  private setupResourceHandlers(): void {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const activeMission = this.activeMissionId || 'default';
      return {
        resources: [
          {
            uri: `atris://mission/${activeMission}/plan`,
            name: 'Active Mission Plan',
            description: 'Structured execution plan and steps for the mission',
            mimeType: 'application/json',
          },
          {
            uri: `atris://mission/${activeMission}/tasks`,
            name: 'Active Mission Tasks',
            description: 'List of all tasks and their states for the mission',
            mimeType: 'application/json',
          },
          {
            uri: `atris://mission/${activeMission}/agents`,
            name: 'Mission Agent Tree',
            description: 'Durable agent instances, lineage, runtime status, and active child agents',
            mimeType: 'application/json',
          },
          {
            uri: 'atris://workspace/current/rules',
            name: 'Workspace Security & Policy Rules',
            description: 'Trust mode, restricted paths, agent limits, and command allowlists',
            mimeType: 'application/json',
          },
          {
            uri: 'atris://task/current/review-pack',
            name: 'Task Review Pack',
            description: 'Latest generated task review pack and diff',
            mimeType: 'application/json',
          },
        ],
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      if (uri.includes('/plan')) {
        const missionId = uri.split('/mission/')[1]?.split('/')[0] || this.activeMissionId || 'default';
        const planData = await this.coordination.getActivePlan(missionId);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(planData, null, 2) }] };
      }
      if (uri.includes('/tasks')) {
        const missionId = uri.split('/mission/')[1]?.split('/')[0] || this.activeMissionId || 'default';
        const planData = await this.coordination.getActivePlan(missionId);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify((planData as any).tasks || [], null, 2) }] };
      }
      if (uri.includes('/agents')) {
        const missionId = uri.split('/mission/')[1]?.split('/')[0] || this.activeMissionId;
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(this.coordination.listAgents(missionId), null, 2) }] };
      }
      if (uri.includes('/rules')) {
        const rulesData = await this.coordination.getWorkspaceRules();
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(rulesData, null, 2) }] };
      }
      if (uri.includes('/review-pack')) {
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ status: 'no_active_review_pack', message: 'No active review pack generated yet for requested resource.' }, null, 2),
          }],
        };
      }
      throw new Error(`Unsupported resource URI: ${uri}`);
    });
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'mission_get_context',
          description: 'Returns active mission context, task state, execution mode, live agent tree, and coordination limits.',
          inputSchema: { type: 'object', properties: { missionId: { type: 'string' }, taskId: { type: 'string' }, workspacePath: { type: 'string' } } },
        },
        {
          name: 'agent_spawn',
          description: 'Creates and schedules a durable child agent with explicit lineage, reason, permissions, and optional model route overrides.',
          inputSchema: {
            type: 'object',
            properties: {
              missionId: { type: 'string', description: 'Mission that owns the child agent.' },
              parentAgentId: { type: 'string', description: 'Agent creating this child. Omit for a root agent.' },
              role: { type: 'string', enum: ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'] },
              instruction: { type: 'string', description: 'Concrete work instruction for the child agent.' },
              displayName: { type: 'string', description: 'Human-readable specialist name.' },
              specialty: { type: 'string', description: 'Short specialty such as Auth Research or React UI.' },
              profileId: { type: 'string', description: 'Optional named agent profile; the fixed role remains authoritative.' },
              agentProfileId: { type: 'string', description: 'Canonical named agent profile; the fixed role remains authoritative.' },
              spawnReason: { type: 'string', description: 'Why a separate agent is necessary. Required for audit history.' },
              taskId: { type: 'string', description: 'Optional existing task to take over.' },
              capabilities: { type: 'array', items: { type: 'string' } },
              priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
              modelCatalogId: { type: 'string', description: 'Optional exact live model catalog route.' },
              accountProfileId: { type: 'string', description: 'Optional connected account profile.' },
              reasoningLevel: { type: 'string' },
              fallbackCatalogIds: { type: 'array', items: { type: 'string' } },
              routeSelectionMode: { type: 'string', enum: ['auto', 'prefer', 'fixed'] },
              workspaceMode: { type: 'string', enum: ['shared', 'isolated_worktree', 'read_only'] },
            },
            required: ['missionId', 'role', 'instruction', 'spawnReason'],
          },
        },
        {
          name: 'agent_list',
          description: 'Lists durable agents and their parent/child lineage for a mission.',
          inputSchema: { type: 'object', properties: { missionId: { type: 'string' } } },
        },
        {
          name: 'agent_send_message',
          description: 'Sends a provider-independent message, handoff, review request, or summary between agents.',
          inputSchema: {
            type: 'object',
            properties: {
              missionId: { type: 'string' },
              fromAgentId: { type: 'string' },
              toAgentId: { type: 'string' },
              content: { type: 'string' },
              kind: { type: 'string', enum: ['message', 'handoff', 'review_request', 'summary'] },
              replyToMessageId: { type: 'string' },
            },
            required: ['missionId', 'fromAgentId', 'toAgentId', 'content'],
          },
        },
        {
          name: 'agent_read_messages',
          description: 'Reads the target agent mailbox without depending on native CLI agent-to-agent support.',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              unreadOnly: { type: 'boolean' },
              markRead: { type: 'boolean' },
            },
            required: ['agentId'],
          },
        },
        {
          name: 'agent_get_activity',
          description: 'Returns runtime state, children, tasks, progress, and unread message count for an agent.',
          inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, missionId: { type: 'string' } } },
        },
        {
          name: 'task_claim',
          description: 'Claim a planned or ready task by an agent.',
          inputSchema: {
            type: 'object',
            properties: { taskId: { type: 'string' }, agentId: { type: 'string' }, role: { type: 'string' } },
            required: ['taskId', 'agentId'],
          },
        },
        {
          name: 'task_report_progress',
          description: 'Reports task execution progress and optional percentage.',
          inputSchema: {
            type: 'object',
            properties: { taskId: { type: 'string' }, progressText: { type: 'string' }, percentage: { type: 'number' }, details: { type: 'object' } },
            required: ['taskId', 'progressText'],
          },
        },
        {
          name: 'task_submit_result',
          description: 'Submits task result, review pack, artifacts, and completion status.',
          inputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string' }, resultSummary: { type: 'string' }, reviewPack: { type: 'object' },
              artifacts: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['done', 'failed'] },
            },
            required: ['taskId', 'resultSummary'],
          },
        },
        {
          name: 'approval_request',
          description: 'Requests human or orchestrator approval for sensitive actions.',
          inputSchema: {
            type: 'object',
            properties: {
              missionId: { type: 'string' }, taskId: { type: 'string' },
              type: { type: 'string', enum: ['command_execution', 'file_edit', 'dependency_install', 'plan_step', 'destructive_action', 'candidate_selection'] },
              description: { type: 'string' },
            },
            required: ['missionId', 'type', 'description'],
          },
        },
        {
          name: 'artifact_publish',
          description: 'Publishes a durable mission/task artifact.',
          inputSchema: {
            type: 'object',
            properties: {
              missionId: { type: 'string' }, taskId: { type: 'string' }, name: { type: 'string' },
              type: { type: 'string', enum: ['diff', 'test_report', 'log', 'review_pack', 'build_output'] },
              content: { type: 'string' }, path: { type: 'string' },
            },
            required: ['missionId', 'name', 'type'],
          },
        },
        {
          name: 'get_changed_files',
          description: 'Returns changed files for a task from its Atris-managed isolated worktree.',
          inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
        },
        {
          name: 'resource_reserve',
          description: 'Reserves a resource lease to prevent multi-agent conflicts.',
          inputSchema: {
            type: 'object',
            properties: {
              resourceType: { type: 'string' }, agentId: { type: 'string' }, resourceId: { type: 'string' },
              ttlSeconds: { type: 'number' }, metadata: { type: 'object' },
            },
            required: ['resourceType', 'agentId'],
          },
        },
        {
          name: 'resource_release',
          description: 'Releases a previously reserved resource lease.',
          inputSchema: { type: 'object', properties: { leaseId: { type: 'string' } }, required: ['leaseId'] },
        },
        {
          name: 'workspace_get_rules',
          description: 'Returns policy rules, restricted paths, command allowlist, and sub-agent safety limits.',
          inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } } },
        },
        // Compatibility aliases for existing prompts/integrations.
        {
          name: 'read_workspace_state',
          description: 'Compatibility alias for mission_get_context.',
          inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' }, missionId: { type: 'string' } } },
        },
        {
          name: 'send_message_to_agent',
          description: 'Compatibility alias for agent_send_message.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string' }, targetAgentId: { type: 'string' }, targetRole: { type: 'string' },
              fromAgentId: { type: 'string' }, fromRole: { type: 'string' }, missionId: { type: 'string' },
            },
            required: ['message'],
          },
        },
        {
          name: 'get_mission_plan',
          description: 'Compatibility alias for reading the active mission plan.',
          inputSchema: { type: 'object', properties: { missionId: { type: 'string' } } },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const safeArgs = (args || {}) as Record<string, any>;

      try {
        switch (name) {
          case 'mission_get_context':
          case 'read_workspace_state':
            return textResult(await this.coordination.getWorkspaceContext(safeArgs.workspacePath, safeArgs.missionId, safeArgs.taskId));

          case 'agent_spawn':
            return textResult(await this.coordination.spawnAgent({
              missionId: safeArgs.missionId,
              parentAgentId: safeArgs.parentAgentId,
              role: safeArgs.role,
              instruction: safeArgs.instruction,
              displayName: safeArgs.displayName,
              specialty: safeArgs.specialty,
              profileId: safeArgs.agentProfileId || safeArgs.profileId,
              agentProfileId: safeArgs.agentProfileId || safeArgs.profileId,
              spawnReason: safeArgs.spawnReason,
              taskId: safeArgs.taskId,
              capabilities: safeArgs.capabilities,
              priority: safeArgs.priority,
              modelCatalogId: safeArgs.modelCatalogId,
              accountProfileId: safeArgs.accountProfileId,
              reasoningLevel: safeArgs.reasoningLevel,
              fallbackCatalogIds: safeArgs.fallbackCatalogIds,
              routeSelectionMode: safeArgs.routeSelectionMode,
              workspaceMode: safeArgs.workspaceMode,
            }));

          case 'agent_list':
            return textResult(this.coordination.listAgents(safeArgs.missionId));

          case 'agent_send_message':
            return textResult(await this.coordination.sendAgentMessage({
              missionId: safeArgs.missionId,
              fromAgentId: safeArgs.fromAgentId,
              toAgentId: safeArgs.toAgentId,
              content: safeArgs.content,
              kind: safeArgs.kind,
              replyToMessageId: safeArgs.replyToMessageId,
            }));

          case 'agent_read_messages':
            return textResult(this.coordination.readAgentMessages(
              safeArgs.agentId,
              safeArgs.unreadOnly !== false,
              safeArgs.markRead !== false,
            ));

          case 'agent_get_activity':
            return textResult(await this.coordination.getAgentActivity(safeArgs.agentId, safeArgs.missionId));

          case 'task_claim':
            return textResult(await this.coordination.claimTask(safeArgs.taskId, safeArgs.agentId, safeArgs.role));

          case 'task_report_progress':
            await this.coordination.reportProgress(safeArgs.taskId, safeArgs.progressText, safeArgs.percentage, safeArgs.details);
            return textResult({ status: 'reported' });

          case 'task_submit_result':
            await this.coordination.submitResult(safeArgs.taskId, safeArgs.resultSummary, safeArgs.reviewPack, safeArgs.artifacts, safeArgs.status || 'done');
            return textResult({ status: 'submitted' });

          case 'approval_request': {
            const approvalId = await this.coordination.requestApproval(safeArgs.missionId, safeArgs.type, safeArgs.description, safeArgs.taskId);
            return textResult({ approvalId, status: 'pending' });
          }

          case 'artifact_publish':
            return textResult(await this.coordination.publishArtifact(safeArgs.missionId, safeArgs.name, safeArgs.type, safeArgs.content, safeArgs.path, safeArgs.taskId));

          case 'get_changed_files':
            return textResult(await this.coordination.getChangedFiles(safeArgs.taskId));

          case 'resource_reserve':
          case 'reserve_resource': {
            const leaseId = await this.coordination.reserveResource(safeArgs.resourceType, safeArgs.agentId, safeArgs.resourceId, safeArgs.ttlSeconds, safeArgs.metadata);
            return textResult({ status: 'reserved', leaseId });
          }

          case 'resource_release':
          case 'release_resource':
            await this.coordination.releaseResource(safeArgs.leaseId);
            return textResult({ status: 'released' });

          case 'workspace_get_rules':
            return textResult(await this.coordination.getWorkspaceRules(safeArgs.workspaceId));

          case 'send_message_to_agent':
            return await this.handleSendMessageToAgent(safeArgs);

          case 'get_mission_plan':
            return textResult(await this.coordination.getActivePlan(safeArgs.missionId || this.activeMissionId || 'default'));

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (err: any) {
        return textResult({ error: err?.message || String(err) });
      }
    });
  }

  private async handleSendMessageToAgent(args: Record<string, any>) {
    const effectiveMissionId = args.missionId || this.activeMissionId || 'global-mission';
    const agents = this.coordination.listAgents(effectiveMissionId);
    const targetAgentId = args.targetAgentId
      || agents.find((agent) => String(agent.role).toLowerCase() === String(args.targetRole || '').toLowerCase())?.id;
    const fromAgentId = args.fromAgentId
      || agents.find((agent) => String(agent.role).toLowerCase() === String(args.fromRole || '').toLowerCase())?.id
      || 'coordination-mcp';
    if (!targetAgentId) throw new Error('Legacy send_message_to_agent could not resolve a target agent. Pass targetAgentId explicitly.');
    const message = await this.coordination.sendAgentMessage({
      missionId: effectiveMissionId,
      fromAgentId,
      toAgentId: targetAgentId,
      content: args.message,
      kind: 'message',
    });
    return textResult({ status: 'sent', message });
  }

  async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import {
  isAgentRole,
  roleToSandboxTier,
  type CanonicalReasoning,
  type OrchestratorRoutingDefaults,
  type RuntimeAdapterCapabilities,
  type TaskRoutePreference,
  type TierRouteDefault,
} from '@atris-agent-code/domain';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import type { RuntimeHost } from '@atris-agent-code/runtime-host';
import type { AttachmentStore } from './attachments';

const ROUTING_DEFAULTS_SETTING_KEY = 'orchestrator_routing_defaults';
const VALID_REASONING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] || '' : value;
}

export function normalizeFallbackCatalogIds(value: unknown, primaryCatalogId?: string): string[] {
  const values: unknown[] = Array.isArray(value) ? value : [];
  return Array.from(new Set(
    values
      .map((item: unknown) => String(item).trim())
      .filter((item: string) => item.length > 0 && item !== primaryCatalogId),
  ));
}

export function normalizeTierRouteDefault(raw: unknown, tierLabel: string): TierRouteDefault | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error(`${tierLabel} tier default must be an object.`), { statusCode: 400 });
  }
  const record = raw as Record<string, unknown>;
  const modelCatalogId = typeof record.modelCatalogId === 'string' && record.modelCatalogId.trim()
    ? record.modelCatalogId.trim()
    : undefined;
  let reasoningLevel: CanonicalReasoning | undefined;
  if (record.reasoningLevel !== undefined && record.reasoningLevel !== null && record.reasoningLevel !== '') {
    const candidate = String(record.reasoningLevel).trim();
    if (!VALID_REASONING.has(candidate)) {
      throw Object.assign(new Error(`Invalid reasoningLevel "${candidate}" for ${tierLabel} tier.`), { statusCode: 400 });
    }
    reasoningLevel = candidate as CanonicalReasoning;
  }
  const fallbackCatalogIds = normalizeFallbackCatalogIds(record.fallbackCatalogIds, modelCatalogId);
  if (!modelCatalogId && !reasoningLevel && fallbackCatalogIds.length === 0) return undefined;
  return {
    ...(modelCatalogId ? { modelCatalogId } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(fallbackCatalogIds.length ? { fallbackCatalogIds } : {}),
  };
}

export function getOrchestratorRoutingDefaults(sqliteDb: Database.Database): OrchestratorRoutingDefaults {
  const row = sqliteDb.prepare('SELECT value_json FROM orchestrator_settings WHERE key = ?')
    .get(ROUTING_DEFAULTS_SETTING_KEY) as { value_json: string } | undefined;
  if (!row?.value_json) return {};
  try {
    const parsed = JSON.parse(row.value_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as OrchestratorRoutingDefaults;
  } catch {
    return {};
  }
}

export function saveOrchestratorRoutingDefaults(
  sqliteDb: Database.Database,
  rawBody: unknown,
): OrchestratorRoutingDefaults {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw Object.assign(new Error('Routing defaults payload must be an object.'), { statusCode: 400 });
  }
  const body = rawBody as Record<string, unknown>;
  const worker = normalizeTierRouteDefault(body.worker, 'worker');
  const review = normalizeTierRouteDefault(body.review, 'review');
  const next: OrchestratorRoutingDefaults = {
    ...(worker ? { worker } : {}),
    ...(review ? { review } : {}),
  };
  sqliteDb.prepare(`INSERT INTO orchestrator_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .run(ROUTING_DEFAULTS_SETTING_KEY, JSON.stringify(next), new Date().toISOString());
  return next;
}

export interface OrchestratorGraphRoutesDeps {
  sqlite: Database.Database;
  workspaceManager: WorkspaceManager;
  runtimeHost: RuntimeHost;
  eventBus: LocalEventBus;
  attachmentStore: AttachmentStore;
  isDeletionFenced: (targetType: 'workspace' | 'mission', targetId: string) => boolean;
  turnDto: (turn: any, command?: any) => Record<string, unknown>;
  safeGetRuntimeCapabilities: () => Record<string, RuntimeAdapterCapabilities>;
}

export function installOrchestratorGraphRoutes(
  app: Express,
  deps: OrchestratorGraphRoutesDeps,
): void {
  const {
    sqlite,
    workspaceManager,
    runtimeHost,
    eventBus,
    attachmentStore,
    isDeletionFenced,
    turnDto,
    safeGetRuntimeCapabilities,
  } = deps;

  app.post('/api/missions/:id/agents/:agentId/messages', async (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.id);
      const agentId = routeParam(req.params.agentId);
      if (isDeletionFenced('mission', missionId)) {
        return void res.status(409).json({ code: 'DELETION_IN_PROGRESS', error: 'Conversation deletion is in progress.' });
      }
      const mission = await workspaceManager.getMission(missionId);
      if (!mission) return void res.status(404).json({ error: 'Mission not found' });
      const agent = sqlite.prepare('SELECT * FROM agent_instances WHERE id = ? AND mission_id = ?').get(agentId, missionId) as any;
      if (!agent) return void res.status(404).json({ error: 'Agent instance not found' });

      const attachmentIds = Array.isArray(req.body?.attachmentIds)
        ? req.body.attachmentIds.filter((item: unknown): item is string => typeof item === 'string' && Boolean(item.trim()))
        : [];
      const content = (typeof req.body?.content === 'string' ? req.body.content.trim() : '')
        || (attachmentIds.length > 0 ? 'Inspect the attached files.' : '');
      if (!content) return void res.status(400).json({ error: 'content is required' });

      let attachments: ReturnType<typeof attachmentStore.resolve> | undefined;
      if (attachmentIds.length > 0) {
        try {
          attachments = attachmentStore.resolve(attachmentIds, mission.workspaceId);
        } catch (err: any) {
          return void res.status(err?.statusCode || 400).json({ code: err?.code || 'INVALID_ATTACHMENTS', error: err?.message || 'Invalid attachmentIds.' });
        }
      }

      const delivery = req.body?.delivery === 'steer' ? 'steer' : 'agent_message';
      const turnId = typeof req.body?.turnId === 'string' && req.body.turnId.trim() ? req.body.turnId.trim() : null;
      const directiveId = crypto.randomUUID();
      const now = new Date().toISOString();
      sqlite.prepare(`INSERT INTO turn_directives
        (id, mission_id, turn_id, target_agent_id, delivery, content, attachment_ids_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(directiveId, missionId, turnId, agentId, delivery, content, JSON.stringify(attachmentIds), now);

      let deliveredLive = false;
      let effectiveDelivery: 'live_steer' | 'queued_directive' = 'queued_directive';
      let reason: string | undefined;

      const hostWithSend = runtimeHost as unknown as {
        sendInput?: (targetAgentId: string, input: { content: string; attachments?: unknown[] }) => Promise<void>;
        getAdapterCapabilities?: (adapterId: string) => { liveSteer?: boolean } | undefined;
      };
      const adapter = agent.runtime_adapter_id ? runtimeHost.getAdapter(String(agent.runtime_adapter_id)) : undefined;
      const capabilities = (agent.runtime_adapter_id ? hostWithSend.getAdapterCapabilities?.(String(agent.runtime_adapter_id)) : undefined)
        ?? (adapter as unknown as { getAdapterCapabilities?: () => { liveSteer?: boolean } } | undefined)?.getAdapterCapabilities?.();

      if (agent.status !== 'running') {
        reason = `Agent is currently '${agent.status || 'idle'}'; persisted as pending directive.`;
      } else if (capabilities && capabilities.liveSteer === false) {
        reason = `Runtime adapter '${agent.runtime_adapter_id}' does not support live mid-turn steering; persisted as pending directive.`;
      } else if (typeof hostWithSend.sendInput === 'function') {
        try {
          await hostWithSend.sendInput(agentId, { content, attachments });
          deliveredLive = true;
          effectiveDelivery = 'live_steer';
        } catch (err: any) {
          reason = err?.message || 'Live sendInput failed; persisted as pending directive.';
        }
      } else if (adapter && typeof adapter.sendInput === 'function') {
        try {
          await adapter.sendInput(agent.session_id || agent.id, { content, ...(attachments ? { attachments } : {}) } as any);
          deliveredLive = true;
          effectiveDelivery = 'live_steer';
        } catch (err: any) {
          reason = err?.message || 'Live adapter sendInput failed; persisted as pending directive.';
        }
      } else {
        reason = 'No active live input transport for this agent; persisted as pending directive.';
      }

      if (deliveredLive) {
        const appliedAt = new Date().toISOString();
        sqlite.prepare("UPDATE turn_directives SET status = 'applied', applied_at = ? WHERE id = ?").run(appliedAt, directiveId);
      }

      const row = sqlite.prepare('SELECT * FROM turn_directives WHERE id = ?').get(directiveId) as any;
      const directive = {
        id: row.id,
        missionId: row.mission_id,
        turnId: row.turn_id || null,
        targetAgentId: row.target_agent_id || null,
        delivery: row.delivery,
        content: row.content,
        attachmentIds: JSON.parse(row.attachment_ids_json || '[]'),
        status: row.status,
        createdAt: row.created_at,
        appliedAt: row.applied_at || null,
      };

      res.status(deliveredLive ? 200 : 202).json({
        directive,
        deliveredLive,
        effectiveDelivery,
        ...(reason ? { reason } : {}),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to send agent directive' });
    }
  });

  app.get('/api/missions/:id/graph', (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.id);
      const snapshot = sqlite.transaction(() => {
        const missionRow = sqlite.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as any;
        if (!missionRow) return null;
        const sequence = Number((sqlite.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM mission_events WHERE mission_id = ?')
          .get(missionId) as { sequence: number }).sequence);
        const runs = (sqlite.prepare('SELECT * FROM mission_runs WHERE mission_id = ? ORDER BY started_at ASC').all(missionId) as any[])
          .map((row) => ({
            id: row.id,
            missionId: row.mission_id,
            turnId: row.turn_id || null,
            commandId: row.command_id || null,
            status: row.status,
            planId: row.plan_id || null,
            startedAt: row.started_at,
            completedAt: row.completed_at || null,
            error: row.error || null,
            heartbeatAt: row.heartbeat_at || null,
          }));
        const turns = (sqlite.prepare('SELECT * FROM conversation_turns WHERE mission_id = ? ORDER BY created_at ASC').all(missionId) as any[])
          .map((row) => turnDto(row));
        const taskRows = sqlite.prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY created_at ASC').all(missionId) as any[];
        const taskWorktreeByTaskId = new Map<string, string>();
        const tasks = taskRows.map((row) => {
          if (row.worktree_id) taskWorktreeByTaskId.set(row.id, row.worktree_id);
          return {
            id: row.id,
            missionId: row.mission_id,
            planId: row.plan_id,
            title: row.title,
            description: row.description,
            status: row.status,
            priority: row.priority,
            assignedAgentId: row.assigned_agent_id || null,
            assignedRole: row.assigned_role || null,
            agentProfileId: row.agent_profile_id || null,
            specialty: row.specialty || null,
            routePreference: row.route_preference ? JSON.parse(row.route_preference) : null,
            requiredCapabilities: row.required_capabilities ? JSON.parse(row.required_capabilities) : [],
            dependsOn: row.depends_on ? JSON.parse(row.depends_on) : [],
            worktreeId: row.worktree_id || null,
            targetDescriptor: row.target_descriptor ? JSON.parse(row.target_descriptor) : null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            completedAt: row.completed_at || null,
          };
        });
        const planCounts = new Map<string, number>();
        for (const t of tasks) {
          if (t.planId) planCounts.set(t.planId, (planCounts.get(t.planId) || 0) + 1);
        }
        if (missionRow.plan_id && !planCounts.has(missionRow.plan_id)) planCounts.set(missionRow.plan_id, 0);
        const plans = [...planCounts.entries()].map(([id, taskCount]) => ({
          id,
          isActive: id === (missionRow.plan_id || null),
          taskCount,
        }));
        const dependencyRows = (sqlite.prepare(`SELECT td.id, td.task_id, td.depends_on_task_id
          FROM task_dependencies td JOIN tasks t ON t.id = td.task_id WHERE t.mission_id = ?`).all(missionId) as any[])
          .map((row) => ({
            id: row.id,
            taskId: row.task_id,
            dependsOnTaskId: row.depends_on_task_id,
          }));
        const seenDependencyEdges = new Set(dependencyRows.map((edge) => `${edge.taskId}:${edge.dependsOnTaskId}`));
        const dependencies = [...dependencyRows];
        for (const task of tasks) {
          if (!Array.isArray(task.dependsOn)) continue;
          for (const depId of task.dependsOn) {
            if (typeof depId !== 'string' || !depId) continue;
            const edgeKey = `${task.id}:${depId}`;
            if (seenDependencyEdges.has(edgeKey)) continue;
            seenDependencyEdges.add(edgeKey);
            dependencies.push({
              id: `legacy:${edgeKey}`,
              taskId: task.id,
              dependsOnTaskId: depId,
            });
          }
        }
        const attempts = (sqlite.prepare('SELECT * FROM task_attempts WHERE mission_id = ? ORDER BY started_at ASC, attempt_number ASC').all(missionId) as any[])
          .map((row) => ({
            id: row.id,
            taskId: row.task_id,
            missionId: row.mission_id,
            agentInstanceId: row.agent_instance_id,
            agentProfileId: row.agent_profile_id || null,
            attemptNumber: row.attempt_number,
            status: row.status,
            worktreePath: row.worktree_path || null,
            runtimeSessionId: row.runtime_session_id || null,
            providerSessionId: row.provider_session_id || null,
            heartbeatAt: row.heartbeat_at || null,
            leaseExpiresAt: row.lease_expires_at || null,
            retryable: Boolean(row.retryable),
            claimedAt: row.claimed_at || null,
            startedAt: row.started_at,
            completedAt: row.completed_at || null,
            error: row.error || null,
            resultSummary: row.result_summary || null,
            routeAdapterId: row.route_adapter_id || null,
            routeProvider: row.route_provider || null,
            routeAccountProfileId: row.route_account_profile_id || null,
            routeModelCatalogId: row.route_model_catalog_id || null,
            routeRuntimeModelId: row.route_runtime_model_id || null,
            routeReasoningLevel: row.route_reasoning_level || null,
            routeSource: row.route_source || null,
            routeSelectionMode: row.route_selection_mode || null,
          }));
        const agents = (sqlite.prepare('SELECT * FROM agent_instances WHERE mission_id = ? ORDER BY created_at ASC').all(missionId) as any[])
          .map((row) => ({
            id: row.id,
            missionId: row.mission_id,
            role: row.role,
            sandboxTier: isAgentRole(row.role) ? roleToSandboxTier(row.role) : 'inspect',
            profileId: row.profile_id || null,
            agentProfileId: row.agent_profile_id || null,
            modelProfileId: row.model_profile_id || '',
            accountProfileId: row.account_profile_id || '',
            runtimeAdapterId: row.runtime_adapter_id || '',
            sessionId: row.session_id || null,
            status: row.status || 'idle',
            taskId: row.task_id || null,
            parentAgentId: row.parent_agent_id || null,
            displayName: row.display_name || null,
            specialty: row.specialty || null,
            spawnReason: row.spawn_reason || null,
            statusMessage: row.status_message || null,
            progress: row.progress ?? null,
            workspaceMode: row.workspace_mode || null,
            worktreeId: row.task_id ? (taskWorktreeByTaskId.get(row.task_id) ?? null) : null,
            startedAt: row.started_at || null,
            completedAt: row.completed_at || null,
            createdAt: row.created_at,
          }));
        const approvals = (sqlite.prepare('SELECT * FROM approvals WHERE mission_id = ? ORDER BY created_at ASC').all(missionId) as any[])
          .map((row) => ({
            id: row.id,
            missionId: row.mission_id,
            taskId: row.task_id || null,
            runId: row.run_id || null,
            type: row.type,
            description: row.description,
            status: row.status,
            decidedBy: row.decided_by || null,
            requestedDecision: row.requested_decision || null,
            executionError: row.execution_error || null,
            createdAt: row.created_at,
            decidedAt: row.decided_at || null,
          }));
        const hasQuestionsTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestrator_questions'").all().length > 0;
        const questions = hasQuestionsTable
          ? (sqlite.prepare('SELECT payload FROM orchestrator_questions WHERE mission_id = ?').all(missionId) as Array<{ payload: string }>)
              .map((row) => JSON.parse(row.payload))
          : [];
        const directives = (sqlite.prepare('SELECT * FROM turn_directives WHERE mission_id = ? ORDER BY created_at ASC').all(missionId) as any[])
          .map((row) => ({
            id: row.id,
            missionId: row.mission_id,
            turnId: row.turn_id || null,
            targetAgentId: row.target_agent_id || null,
            delivery: row.delivery,
            content: row.content,
            attachmentIds: JSON.parse(row.attachment_ids_json || '[]'),
            status: row.status,
            createdAt: row.created_at,
            appliedAt: row.applied_at || null,
          }));
        const mission = {
          id: missionRow.id,
          workspaceId: missionRow.workspace_id,
          title: missionRow.title,
          description: missionRow.description,
          status: missionRow.status,
          teamTemplateId: missionRow.team_template_id,
          planId: missionRow.plan_id || null,
          activeRunId: missionRow.active_run_id || null,
          executionMode: missionRow.execution_mode,
          automationPolicy: missionRow.automation_policy ? JSON.parse(missionRow.automation_policy) : null,
          createdAt: missionRow.created_at,
          updatedAt: missionRow.updated_at,
          completedAt: missionRow.completed_at || null,
        };
        return {
          sequence,
          mission,
          activePlanId: mission.planId,
          plans,
          runs,
          turns,
          tasks,
          dependencies,
          attempts,
          agents,
          approvals,
          questions,
          directives,
        };
      })();
      if (!snapshot) return void res.status(404).json({ error: 'Mission not found' });
      res.json({
        ...snapshot,
        runtimeCapabilities: safeGetRuntimeCapabilities(),
        routingDefaults: getOrchestratorRoutingDefaults(sqlite),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to load mission graph' });
    }
  });

  app.get('/api/orchestrator/routing-defaults', (_req: Request, res: Response) => {
    try {
      res.json(getOrchestratorRoutingDefaults(sqlite));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to load orchestrator routing defaults' });
    }
  });

  app.put('/api/orchestrator/routing-defaults', (req: Request, res: Response) => {
    try {
      const saved = saveOrchestratorRoutingDefaults(sqlite, req.body);
      res.json(saved);
    } catch (error: any) {
      res.status(error?.statusCode || 500).json({ error: error?.message || 'Failed to save orchestrator routing defaults' });
    }
  });

  app.patch('/api/missions/:id/tasks/:taskId/route', async (req: Request, res: Response) => {
    try {
      const missionId = routeParam(req.params.id);
      const taskId = routeParam(req.params.taskId);
      if (isDeletionFenced('mission', missionId)) {
        return void res.status(409).json({ code: 'DELETION_IN_PROGRESS', error: 'Conversation deletion is in progress.' });
      }
      const mission = await workspaceManager.getMission(missionId);
      if (!mission) return void res.status(404).json({ error: 'Mission not found' });
      const task = await workspaceManager.getTask(taskId);
      if (!task || task.missionId !== missionId) return void res.status(404).json({ error: 'Task not found' });
      if (!['planned', 'ready', 'failed'].includes(task.status)) {
        return void res.status(409).json({ error: `Cannot override route for task in status "${task.status}".` });
      }
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return void res.status(400).json({ error: 'Route override payload must be an object.' });
      }
      const modelCatalogId = typeof body.modelCatalogId === 'string' ? body.modelCatalogId.trim() : '';
      if (!modelCatalogId) {
        return void res.status(400).json({ error: 'modelCatalogId is required.' });
      }
      let reasoningLevel: CanonicalReasoning | undefined;
      if (body.reasoningLevel !== undefined && body.reasoningLevel !== null && body.reasoningLevel !== '') {
        const candidate = String(body.reasoningLevel).trim();
        if (!VALID_REASONING.has(candidate)) {
          return void res.status(400).json({ error: `Invalid reasoningLevel "${candidate}".` });
        }
        reasoningLevel = candidate as CanonicalReasoning;
      }
      const explicitAccountProfileId = typeof body.accountProfileId === 'string' && body.accountProfileId.trim()
        ? body.accountProfileId.trim()
        : undefined;
      const fallbackCatalogIds = normalizeFallbackCatalogIds(body.fallbackCatalogIds, modelCatalogId);

      const catalogService = typeof (runtimeHost as { getModelCatalogService?: () => unknown })?.getModelCatalogService === 'function'
        ? (runtimeHost as { getModelCatalogService: () => { resolveModelDescriptor?: (id: string) => Promise<any> } }).getModelCatalogService()
        : null;
      const descriptor = catalogService && typeof catalogService.resolveModelDescriptor === 'function'
        ? await catalogService.resolveModelDescriptor(modelCatalogId).catch(() => null)
        : null;

      if (descriptor) {
        if (task.assignedRole && Array.isArray(descriptor.supportedRoles) && descriptor.supportedRoles.length > 0
          && !descriptor.supportedRoles.includes(task.assignedRole)) {
          return void res.status(422).json({ error: `Model "${modelCatalogId}" does not support role "${task.assignedRole}".` });
        }
        if (reasoningLevel && Array.isArray(descriptor.supportedReasoning) && descriptor.supportedReasoning.length > 0
          && !descriptor.supportedReasoning.includes(reasoningLevel)) {
          return void res.status(422).json({ error: `Model "${modelCatalogId}" does not support reasoningLevel "${reasoningLevel}".` });
        }
      }

      const routePreference: TaskRoutePreference = {
        modelCatalogId,
        accountProfileId: explicitAccountProfileId || descriptor?.accountProfileId || '',
        reasoningLevel: reasoningLevel ?? descriptor?.defaultReasoning,
        fallbackCatalogIds,
        selectionMode: 'fixed',
        modelDisplayName: descriptor?.displayName || modelCatalogId,
        ...(descriptor?.routeLabel ? { routeLabel: descriptor.routeLabel } : {}),
        reason: 'Manual node route override',
      };

      const updatedTask = await workspaceManager.updateTask(taskId, { routePreference });
      eventBus.emit({
        id: crypto.randomUUID(),
        type: 'plan_revised',
        missionId,
        planId: updatedTask.planId,
        reason: 'task_route_updated',
        changedTaskIds: [taskId],
        timestamp: new Date().toISOString(),
      });
      res.json({ task: updatedTask, routePreference });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to update task route' });
    }
  });
}

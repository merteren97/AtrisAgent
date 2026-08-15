import { eq } from 'drizzle-orm';
import {
  missionEvents,
  type AtrisDatabase,
  type TaskSelect,
} from '@atris-agent-code/database';
import {
  getSupervisorTurnRunner,
  type LocalEventBus,
} from '@atris-agent-code/event-bus';
import type { TaskCompleted } from '@atris-agent-code/event-schema';
import type {
  OrchestratorDecision,
  OrchestratorTurnAction,
} from '@atris-agent-code/domain';
import { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import { Orchestrator as LegacyOrchestrator } from './orchestrator';
import type {
  OrchestratorConfig,
  StructuredPlan,
  StructuredTaskPlan,
} from './orchestrator';
import {
  buildSupervisorDecisionPrompt,
  decisionToTaskPlan,
  fallbackSupervisorDecision,
  parseSupervisorDecision,
  type SupervisorTurnContext,
} from './supervisor-turn';

const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_TASK_STATUSES = new Set(['done', 'superseded']);
const FAILED_TASK_STATUSES = new Set(['rejected']);
const ACTIVE_TASK_STATUSES = new Set(['claimed', 'running', 'review', 'revision_requested', 'verified', 'applied']);
const SCHEDULABLE_MISSION_STATUSES = new Set(['ready', 'running', 'revising']);
const MAX_CONTEXT_EVENTS = 24;
const MAX_CONTEXT_CHARS = 18_000;

interface StartMissionOptionsV2 {
  modelCatalogId?: string;
  reasoningLevel?: string;
  targetRole?: string;
  command?: string;
  rawModelPlanOutput?: string;
}

/**
 * Orchestrator v2 combines the Phase 1 scheduler-reconciliation safety net with
 * a Phase 2 persistent supervisor model.
 *
 * Conversation semantics:
 *   missionId   = durable conversation boundary
 *   turnId      = one user message / supervisor decision
 *   planId      = optional execution graph for that turn
 *
 * A new user message no longer implies a new Researcher -> Builder -> Reviewer
 * plan. The persistent supervisor first decides whether to answer, clarify,
 * delegate read-only work, execute changes, or create a plan without executing.
 */
export class OrchestratorV2 extends LegacyOrchestrator {
  private readonly v2WorkspaceManager?: WorkspaceManager;
  private readonly v2EventBus?: LocalEventBus;
  private readonly v2Db?: AtrisDatabase;
  private readonly v2WorkspacePath: string;
  private readonly missionQueues = new Map<string, Promise<void>>();
  private readonly planActions = new Map<string, OrchestratorTurnAction>();
  private readonly synthesizedPlans = new Set<string>();

  constructor(
    config: OrchestratorConfig,
    eventBus?: LocalEventBus,
    db?: AtrisDatabase,
    workspaceManager?: WorkspaceManager,
  ) {
    super(config, eventBus, db, workspaceManager);
    this.v2EventBus = eventBus ?? config.eventBus;
    this.v2Db = db ?? config.db;
    this.v2WorkspacePath = config.workspacePath;
    this.v2WorkspaceManager = workspaceManager
      ?? config.workspaceManager
      ?? (this.v2Db ? new WorkspaceManager(this.v2Db, this.v2EventBus) : undefined);
  }

  private trace(stage: string, details: Record<string, unknown>): void {
    console.info(`[OrchestratorV2][Scheduler] ${stage} ${JSON.stringify(details)}`);
  }

  private enqueueMission<T>(missionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.missionQueues.get(missionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tracked = next.then(() => undefined, () => undefined);
    this.missionQueues.set(missionId, tracked);
    return next.finally(() => {
      if (this.missionQueues.get(missionId) === tracked) this.missionQueues.delete(missionId);
    });
  }

  private async loadConversationContext(missionId: string): Promise<{
    conversationContext: string;
    workspaceContext: string;
    hasPriorConversation: boolean;
  }> {
    const manager = this.v2WorkspaceManager;
    const mission = manager ? await manager.getMission(missionId) : null;
    const tasks = manager ? await manager.listTasks(missionId) : [];
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    let rows: Array<{ type: string; payload: Record<string, unknown>; taskId: string | null; createdAt: string }> = [];

    if (this.v2Db) {
      rows = (await this.v2Db
        .select({
          type: missionEvents.type,
          payload: missionEvents.payload,
          taskId: missionEvents.taskId,
          createdAt: missionEvents.createdAt,
        })
        .from(missionEvents)
        .where(eq(missionEvents.missionId, missionId))) as typeof rows;
      rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    const lines: string[] = [];
    if (mission?.description) lines.push(`User (initial): ${mission.description}`);
    for (const row of rows.slice(-MAX_CONTEXT_EVENTS)) {
      const payload = row.payload || {};
      const task = row.taskId ? taskById.get(row.taskId) : undefined;
      const compact = (value: unknown, limit = 3_500) => String(value || '').trim().slice(0, limit);
      switch (row.type) {
        case 'user_message': {
          const content = compact(payload.content);
          if (content) lines.push(`User: ${content}`);
          break;
        }
        case 'task_completed': {
          const result = compact(payload.result);
          if (result) lines.push(`${task?.assignedRole || 'Worker'} (${task?.title || row.taskId || 'task'}): ${result}`);
          break;
        }
        case 'mission_completed': {
          const summary = compact(payload.summary);
          if (summary) lines.push(`Orchestrator: ${summary}`);
          break;
        }
        case 'text_delta': {
          const content = compact(payload.content);
          if (content) lines.push(`Orchestrator: ${content}`);
          break;
        }
        case 'mission_failed': {
          const reason = compact(payload.reason);
          if (reason) lines.push(`System failure: ${reason}`);
          break;
        }
        case 'plan_generated': {
          const summary = compact(payload.summary, 1_000);
          if (summary) lines.push(`Plan: ${summary}`);
          break;
        }
        default:
          break;
      }
    }

    let conversationContext = lines.join('\n\n');
    if (conversationContext.length > MAX_CONTEXT_CHARS) {
      conversationContext = conversationContext.slice(conversationContext.length - MAX_CONTEXT_CHARS);
    }

    let workspaceContext = `Workspace path: ${this.v2WorkspacePath}`;
    if (mission && manager) {
      const workspace = await manager.getWorkspace(mission.workspaceId);
      if (workspace) {
        workspaceContext = [
          `Workspace: ${workspace.name}`,
          `Path: ${workspace.path}`,
          `Git repository: ${workspace.gitInitialized ? 'yes' : 'managed/non-git workspace'}`,
        ].join('\n');
      }
    }

    return {
      conversationContext,
      workspaceContext,
      hasPriorConversation: rows.length > 0 || Boolean(mission?.completedAt),
    };
  }

  private ensureExecutableDecision(decision: OrchestratorDecision, userRequest: string): OrchestratorDecision {
    if (decision.action === 'delegate' && !(decision.delegations || []).length) {
      return {
        ...decision,
        delegations: [{
          id: 'research-1',
          role: 'researcher',
          objective: userRequest,
          requiredCapabilities: ['research', 'codebase-analysis'],
        }],
      };
    }
    if (decision.action === 'execute' && !(decision.delegations || []).some((item) => item.role === 'builder')) {
      return {
        ...decision,
        delegations: [
          ...(decision.delegations || []).filter((item) => item.role === 'researcher'),
          {
            id: 'builder-1',
            role: 'builder',
            objective: userRequest,
            requiredCapabilities: ['implementation', 'workspace-write'],
            dependsOnDelegationIds: (decision.delegations || [])
              .filter((item) => item.role === 'researcher')
              .map((item) => item.id),
          },
        ],
      };
    }
    return decision;
  }

  private async decideTurn(
    missionId: string,
    turnId: string,
    request: string,
    options?: StartMissionOptionsV2,
  ): Promise<{ decision: OrchestratorDecision; context: SupervisorTurnContext; hasPriorConversation: boolean }> {
    const loaded = await this.loadConversationContext(missionId);
    const context: SupervisorTurnContext = {
      turnId,
      userMessage: request,
      conversationContext: loaded.conversationContext,
      workspaceContext: loaded.workspaceContext,
      explicitCommand: options?.command,
      explicitTargetRole: options?.targetRole,
    };
    const runner = getSupervisorTurnRunner();
    if (runner) {
      try {
        const raw = await runner({
          missionId,
          turnId,
          workspacePath: loaded.workspaceContext.includes('Path:')
            ? loaded.workspaceContext.split('\n').find((line) => line.startsWith('Path:'))?.slice(5).trim() || this.v2WorkspacePath
            : this.v2WorkspacePath,
          prompt: buildSupervisorDecisionPrompt(context),
          modelCatalogId: options?.modelCatalogId,
          reasoningLevel: options?.reasoningLevel,
        });
        const parsed = parseSupervisorDecision(raw, turnId);
        if (parsed) {
          return {
            decision: this.ensureExecutableDecision(parsed, request),
            context,
            hasPriorConversation: loaded.hasPriorConversation,
          };
        }
        this.trace('supervisor-invalid-json', { missionId, turnId, raw: raw.slice(0, 600) });
      } catch (error) {
        this.trace('supervisor-runtime-fallback', {
          missionId,
          turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      decision: this.ensureExecutableDecision(fallbackSupervisorDecision(context), request),
      context,
      hasPriorConversation: loaded.hasPriorConversation,
    };
  }

  private emitContinuationUserMessage(missionId: string, request: string, planId: string, previousPlanId?: string | null): void {
    this.v2EventBus?.emit({
      id: crypto.randomUUID(),
      type: 'user_message',
      missionId,
      content: request,
      planId,
      previousPlanId: previousPlanId || null,
      timestamp: new Date().toISOString(),
    });
  }

  private async completeConversationalTurn(params: {
    missionId: string;
    turnId: string;
    request: string;
    response: string;
    previousPlanId?: string | null;
    hasPriorConversation: boolean;
  }): Promise<{
    missionId: string;
    planId: string;
    tasks: TaskSelect[];
    structuredPlan: StructuredPlan;
  }> {
    const manager = this.v2WorkspaceManager;
    const turnPlanId = `turn-${params.turnId}`;
    if (params.hasPriorConversation) {
      this.emitContinuationUserMessage(params.missionId, params.request, turnPlanId, params.previousPlanId);
    }
    if (manager) {
      await manager.updateMission(params.missionId, {
        planId: turnPlanId,
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
    }
    this.emitMissionCompleted({
      missionId: params.missionId,
      summary: params.response,
      tasksCompleted: 0,
      totalTasks: 0,
    });
    return {
      missionId: params.missionId,
      planId: turnPlanId,
      tasks: [],
      structuredPlan: { planId: turnPlanId, assumptions: [], questions: [], tasks: [] },
    };
  }

  private async createPlanOnlyTurn(params: {
    missionId: string;
    turnId: string;
    request: string;
    decision: OrchestratorDecision;
    previousPlanId?: string | null;
    hasPriorConversation: boolean;
  }): Promise<{
    missionId: string;
    planId: string;
    tasks: TaskSelect[];
    structuredPlan: StructuredPlan;
  }> {
    const manager = this.v2WorkspaceManager;
    if (!manager) {
      return super.startMission(params.missionId, params.request, {
        command: 'plan',
        rawModelPlanOutput: JSON.stringify({ tasks: decisionToTaskPlan(params.decision) }),
      });
    }

    const planId = crypto.randomUUID();
    const taskSpecs = decisionToTaskPlan(params.decision);
    const structuredPlan: StructuredPlan = {
      planId,
      assumptions: ['This is a plan-only turn. No worker is started until the user explicitly asks to execute.'],
      questions: params.decision.clarifyingQuestions || [],
      tasks: taskSpecs,
    };
    const createdTasks: TaskSelect[] = [];
    const idsByIndex = new Map<number, string>();

    for (let index = 0; index < taskSpecs.length; index += 1) {
      const spec = taskSpecs[index];
      const id = crypto.randomUUID();
      idsByIndex.set(index, id);
      const dependencies = (spec.dependsOnIndices || [])
        .map((dependencyIndex) => idsByIndex.get(dependencyIndex))
        .filter((dependencyId): dependencyId is string => Boolean(dependencyId));
      createdTasks.push(await manager.createTask({
        id,
        missionId: params.missionId,
        planId,
        title: spec.title,
        description: spec.description,
        status: 'planned',
        priority: spec.priority,
        assignedRole: spec.role,
        requiredCapabilities: spec.requiredCapabilities,
        dependsOn: dependencies,
      }));
    }

    if (params.hasPriorConversation) {
      this.emitContinuationUserMessage(params.missionId, params.request, planId, params.previousPlanId);
    }
    await manager.updateMission(params.missionId, {
      planId,
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    this.planActions.set(planId, 'plan_only');
    this.emitPlanGenerated({
      missionId: params.missionId,
      planId,
      taskCount: createdTasks.length,
      summary: `Prepared a ${createdTasks.length}-step plan without starting execution.`,
    });
    this.emitMissionCompleted({
      missionId: params.missionId,
      summary: params.decision.response || 'Plan hazır. Hiçbir worker başlatılmadı; aynı konuşmada uygulamamı istediğinde bu bağlamdan devam edeceğim.',
      tasksCompleted: 0,
      totalTasks: createdTasks.length,
    });

    return { missionId: params.missionId, planId, tasks: createdTasks, structuredPlan };
  }

  override async startMission(
    missionId: string,
    request: string,
    options?: StartMissionOptionsV2,
  ): Promise<{
    missionId: string;
    planId: string;
    tasks: TaskSelect[];
    structuredPlan: StructuredPlan;
  }> {
    const manager = this.v2WorkspaceManager;
    if (!manager) return super.startMission(missionId, request, options);

    const initialMission = await manager.getMission(missionId);
    if (!initialMission) return super.startMission(missionId, request, options);
    const initialPlanId = initialMission.planId || null;
    if (initialPlanId && SCHEDULABLE_MISSION_STATUSES.has(String(initialMission.status))) {
      await this.reconcileMissionPlan(missionId, initialPlanId);
    }

    const existingMission = (await manager.getMission(missionId)) || initialMission;
    const previousPlanId = existingMission.planId || initialPlanId;
    const existingTasks = await manager.listTasks(missionId);
    const activePlanTasks = previousPlanId
      ? existingTasks.filter((task) => task.planId === previousPlanId)
      : existingTasks;
    const activeExecution = activePlanTasks.some((task) =>
      task.status === 'ready' || ACTIVE_TASK_STATUSES.has(String(task.status))
    );
    if (activeExecution && !TERMINAL_MISSION_STATUSES.has(String(existingMission.status))) {
      throw new Error('The current conversation turn is still executing. Finish or stop it before starting another turn.');
    }

    const turnId = crypto.randomUUID();
    const { decision, hasPriorConversation } = await this.decideTurn(missionId, turnId, request, options);
    this.trace('turn-decision', {
      missionId,
      turnId,
      action: decision.action,
      delegationCount: decision.delegations?.length || 0,
    });

    if (decision.action === 'respond' || decision.action === 'clarify') {
      const response = decision.response
        || (decision.clarifyingQuestions || []).join('\n')
        || 'Bu turn için ek execution gerekmiyor.';
      return this.completeConversationalTurn({
        missionId,
        turnId,
        request,
        response,
        previousPlanId,
        hasPriorConversation,
      });
    }

    if (decision.action === 'plan_only') {
      return this.createPlanOnlyTurn({
        missionId,
        turnId,
        request,
        decision,
        previousPlanId,
        hasPriorConversation,
      });
    }

    const taskPlan = decisionToTaskPlan(decision);
    const rawModelPlanOutput = JSON.stringify({
      planId: crypto.randomUUID(),
      assumptions: [
        `Persistent Orchestrator decision: ${decision.action}.`,
        decision.response || 'Delegations were generated from the current conversation context.',
      ],
      questions: decision.clarifyingQuestions || [],
      tasks: taskPlan,
    });
    const result = await super.startMission(missionId, request, {
      ...options,
      rawModelPlanOutput,
    });
    this.planActions.set(result.planId, decision.action);
    return result;
  }

  private async resolveCompletionTask(event: TaskCompleted): Promise<TaskSelect | null> {
    const manager = this.v2WorkspaceManager;
    if (!manager) return null;

    const direct = await manager.getTask(event.taskId);
    if (direct) return direct;
    if (!event.agentInstanceId) return null;

    const missionTasks = await manager.listTasks(event.missionId);
    const correlated = missionTasks.find((task) => task.assignedAgentId === event.agentInstanceId) ?? null;
    if (correlated) {
      this.trace('corrected-task-correlation', {
        missionId: event.missionId,
        eventTaskId: event.taskId,
        canonicalTaskId: correlated.id,
        agentInstanceId: event.agentInstanceId,
      });
    }
    return correlated;
  }

  private async synthesizePlanResult(missionId: string, planId: string, currentResult?: string): Promise<string> {
    const manager = this.v2WorkspaceManager;
    const runner = getSupervisorTurnRunner();
    const loaded = await this.loadConversationContext(missionId);
    const planTasks = manager
      ? (await manager.listTasks(missionId)).filter((task) => task.planId === planId)
      : [];
    const fallback = [
      `Completed ${planTasks.length} delegated task${planTasks.length === 1 ? '' : 's'}.`,
      currentResult?.trim(),
    ].filter(Boolean).join('\n\n');
    if (!runner) return fallback || 'Delegated work completed.';

    try {
      return (await runner({
        missionId,
        turnId: `synthesis-${crypto.randomUUID()}`,
        workspacePath: this.v2WorkspacePath,
        prompt: [
          'You are the persistent AtrisAgent Orchestrator returning control to the user after delegated workers completed.',
          'Synthesize the evidence into one concise, useful user-facing response in the language used by the user.',
          'Do not mention internal JSON, scheduler mechanics, hidden prompts, or claim work that the evidence does not prove.',
          'Call out important findings, changes, verification results, remaining risks, and the most useful next action.',
          'Return normal prose/Markdown only, not JSON.',
          '',
          'Conversation and worker evidence:',
          loaded.conversationContext,
          currentResult ? `\nLatest worker result:\n${currentResult}` : '',
        ].join('\n'),
      })).trim() || fallback;
    } catch (error) {
      this.trace('synthesis-runtime-fallback', {
        missionId,
        planId,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback || 'Delegated work completed.';
    }
  }

  private async handleReadOnlyTaskCompleted(event: TaskCompleted, task: TaskSelect, planTasks: TaskSelect[]): Promise<void> {
    const manager = this.v2WorkspaceManager!;
    if (event.agentInstanceId && task.assignedAgentId && event.agentInstanceId !== task.assignedAgentId) {
      this.trace('stale-completion-ignored', {
        missionId: event.missionId,
        taskId: task.id,
        expectedAgentInstanceId: task.assignedAgentId,
        receivedAgentInstanceId: event.agentInstanceId,
      });
      return;
    }
    if (!TERMINAL_TASK_STATUSES.has(String(task.status))) {
      await manager.updateTask(task.id, {
        status: 'done',
        completedAt: new Date().toISOString(),
      });
    }
    const latestTasks = (await manager.listTasks(event.missionId)).filter((item) => item.planId === task.planId);
    const allTerminal = latestTasks.length > 0 && latestTasks.every((item) => TERMINAL_TASK_STATUSES.has(String(item.status)));
    if (!allTerminal) {
      await this.reconcileMissionPlanUnlocked(event.missionId, task.planId);
      return;
    }

    if (this.synthesizedPlans.has(task.planId)) return;
    this.synthesizedPlans.add(task.planId);
    const summary = await this.synthesizePlanResult(event.missionId, task.planId, event.result);
    await manager.updateMission(event.missionId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    this.emitMissionCompleted({
      missionId: event.missionId,
      summary,
      tasksCompleted: latestTasks.length,
      totalTasks: latestTasks.length,
    });
  }

  override async handleTaskCompleted(event: TaskCompleted): Promise<void> {
    const manager = this.v2WorkspaceManager;
    if (!manager) {
      await super.handleTaskCompleted(event);
      return;
    }

    await this.enqueueMission(event.missionId, async () => {
      const task = await this.resolveCompletionTask(event);
      if (!task) {
        this.trace('completion-task-missing', {
          missionId: event.missionId,
          taskId: event.taskId,
          agentInstanceId: event.agentInstanceId,
        });
        await super.handleTaskCompleted(event);
        return;
      }

      const planTasks = (await manager.listTasks(event.missionId)).filter((item) => item.planId === task.planId);
      const hasBuilder = planTasks.some((item) => item.assignedRole === 'builder');
      const action = this.planActions.get(task.planId) || (hasBuilder ? 'execute' : 'delegate');
      if (action === 'delegate' || !hasBuilder) {
        await this.handleReadOnlyTaskCompleted(event, task, planTasks);
        return;
      }

      if (event.agentInstanceId && task.assignedAgentId && event.agentInstanceId !== task.assignedAgentId) {
        this.trace('stale-completion-ignored', {
          missionId: event.missionId,
          taskId: task.id,
          expectedAgentInstanceId: task.assignedAgentId,
          receivedAgentInstanceId: event.agentInstanceId,
        });
        return;
      }

      const canonicalEvent: TaskCompleted = task.id === event.taskId ? event : { ...event, taskId: task.id };
      if (!TERMINAL_TASK_STATUSES.has(String(task.status))) {
        await manager.updateTask(task.id, {
          status: 'done',
          completedAt: new Date().toISOString(),
        });
      }

      let legacyError: unknown;
      try {
        await super.handleTaskCompleted(canonicalEvent);
      } catch (error) {
        legacyError = error;
        this.trace('legacy-completion-handler-rejected', {
          missionId: event.missionId,
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const latestTask = await manager.getTask(task.id);
      await this.reconcileMissionPlanUnlocked(event.missionId, latestTask?.planId || task.planId || null);

      const mission = await manager.getMission(event.missionId);
      if (mission?.status === 'completed' && !this.synthesizedPlans.has(task.planId)) {
        this.synthesizedPlans.add(task.planId);
        const summary = await this.synthesizePlanResult(event.missionId, task.planId, event.result);
        this.v2EventBus?.emit({
          id: crypto.randomUUID(),
          type: 'text_delta',
          missionId: event.missionId,
          agentInstanceId: `orchestrator-${task.planId}`,
          content: summary,
          timestamp: new Date().toISOString(),
        });
      }

      if (legacyError) throw legacyError;
    });
  }

  private async recoverNonProgressingPlan(
    missionId: string,
    planId: string | null,
    planTasks: TaskSelect[],
  ): Promise<boolean> {
    const manager = this.v2WorkspaceManager;
    if (!manager || !planId || planTasks.length === 0) return false;

    const activeTasks = planTasks.filter((task) => ACTIVE_TASK_STATUSES.has(String(task.status)));
    if (activeTasks.length > 0) return false;

    const failedTasks = planTasks.filter((task) => FAILED_TASK_STATUSES.has(String(task.status)));
    if (failedTasks.length > 0) {
      const failedTask = failedTasks[0];
      const reason = `Plan ${planId} cannot continue because task ${failedTask.id} is ${failedTask.status}.`;
      await manager.updateMission(missionId, { status: 'failed', completedAt: new Date().toISOString() });
      this.emitMissionFailed({ missionId, reason, failedTaskId: failedTask.id });
      this.trace('plan-failed-dependency', { missionId, planId, failedTaskId: failedTask.id });
      return true;
    }

    const allSuccessfulTerminal = planTasks.every((task) => TERMINAL_TASK_STATUSES.has(String(task.status)));
    if (allSuccessfulTerminal) {
      const hasBuilder = planTasks.some((task) => task.assignedRole === 'builder');
      const action = this.planActions.get(planId) || (hasBuilder ? 'execute' : 'delegate');
      if (action === 'delegate' || !hasBuilder) {
        if (this.synthesizedPlans.has(planId)) return true;
        this.synthesizedPlans.add(planId);
        const summary = await this.synthesizePlanResult(missionId, planId);
        await manager.updateMission(missionId, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        this.emitMissionCompleted({
          missionId,
          summary,
          tasksCompleted: planTasks.length,
          totalTasks: planTasks.length,
        });
        this.trace('read-only-plan-recovered', { missionId, planId, taskCount: planTasks.length });
        return true;
      }

      const builderTask = planTasks.find((task) => task.assignedRole === 'builder');
      const reason = 'All execution workers are terminal, but the mission did not complete its review/apply transition. AtrisAgent stopped automatic recovery to avoid applying Builder changes twice; inspect the completed work and retry from a new turn.';
      await manager.updateMission(missionId, { status: 'failed', completedAt: new Date().toISOString() });
      this.emitMissionFailed({ missionId, reason, failedTaskId: builderTask?.id });
      this.trace('execute-plan-terminal-transition-missing', { missionId, planId, builderTaskId: builderTask?.id });
      return true;
    }

    const pendingTasks = planTasks.filter((task) => task.status === 'planned' || task.status === 'ready' || task.status === 'blocked');
    if (pendingTasks.length === 0) return false;

    const byId = new Map(planTasks.map((task) => [task.id, task]));
    const blockers = pendingTasks.map((task) => {
      const dependencies = ((task.dependsOn as string[]) || []);
      const unresolved = dependencies.filter((dependencyId) => {
        const dependency = byId.get(dependencyId);
        return !dependency || !TERMINAL_TASK_STATUSES.has(String(dependency.status));
      });
      return {
        taskId: task.id,
        status: task.status,
        unresolved: unresolved.length > 0 ? unresolved : ['no-runnable-transition'],
      };
    });
    const reason = `Plan ${planId} has no active or dispatchable tasks. Dependency graph is blocked: ${blockers
      .map((item) => `${item.taskId} waits for ${item.unresolved.join(', ')}`)
      .join('; ')}.`;
    await manager.updateMission(missionId, { status: 'failed', completedAt: new Date().toISOString() });
    this.emitMissionFailed({ missionId, reason, failedTaskId: pendingTasks[0]?.id });
    this.trace('plan-deadlock-failed', { missionId, planId, blockers });
    return true;
  }

  async reconcileMissionPlan(missionId: string, planId?: string | null): Promise<void> {
    const manager = this.v2WorkspaceManager;
    if (!manager) return;
    await this.enqueueMission(missionId, () => this.reconcileMissionPlanUnlocked(missionId, planId));
  }

  private async reconcileMissionPlanUnlocked(missionId: string, requestedPlanId?: string | null): Promise<void> {
    const manager = this.v2WorkspaceManager;
    if (!manager) return;

    const mission = await manager.getMission(missionId);
    if (!mission) {
      this.trace('mission-missing', { missionId });
      return;
    }
    if (TERMINAL_MISSION_STATUSES.has(String(mission.status))) {
      this.trace('terminal-mission-skip', { missionId, status: mission.status });
      return;
    }
    if (!SCHEDULABLE_MISSION_STATUSES.has(String(mission.status))) {
      this.trace('mission-not-schedulable', { missionId, status: mission.status });
      return;
    }

    const planId = requestedPlanId || mission.planId || null;
    const missionTasks = await manager.listTasks(missionId);
    const planTasks = planId ? missionTasks.filter((task) => task.planId === planId) : missionTasks;
    if (planTasks.length === 0) {
      this.trace('plan-has-no-tasks', { missionId, planId });
      return;
    }

    const byId = new Map(planTasks.map((task) => [task.id, task]));
    const ready = planTasks.filter((task) => {
      if (task.status !== 'planned' && task.status !== 'ready') return false;
      const dependencies = (task.dependsOn as string[]) || [];
      return dependencies.every((dependencyId) => {
        const dependency = byId.get(dependencyId);
        return Boolean(dependency && TERMINAL_TASK_STATUSES.has(String(dependency.status)));
      });
    });

    const blocked = planTasks
      .filter((task) => task.status === 'planned' || task.status === 'ready')
      .filter((task) => !ready.some((candidate) => candidate.id === task.id))
      .map((task) => ({
        taskId: task.id,
        role: task.assignedRole,
        waitingFor: ((task.dependsOn as string[]) || []).filter((dependencyId) => {
          const dependency = byId.get(dependencyId);
          return !dependency || !TERMINAL_TASK_STATUSES.has(String(dependency.status));
        }),
      }));

    this.trace('plan-reconciled', {
      missionId,
      planId,
      missionStatus: mission.status,
      readyTaskIds: ready.map((task) => task.id),
      blocked,
    });

    if (ready.length === 0) {
      await this.recoverNonProgressingPlan(missionId, planId, planTasks);
      return;
    }

    const candidateBuilders = planTasks.filter(
      (task) => task.assignedRole === 'builder' && task.title.includes('(Candidate'),
    );
    const candidateResolved = candidateBuilders.length > 1
      && candidateBuilders.some((task) => task.status === 'superseded');
    const candidateSelectionPending = mission.executionMode === 'candidate'
      && candidateBuilders.length > 1
      && !candidateResolved;

    if (candidateSelectionPending && ready.some((task) => task.assignedRole === 'qa')) {
      await manager.updateMission(missionId, { status: 'waiting_for_approval' });
      await this.emitApprovalRequested({
        missionId,
        approvalType: 'candidate_selection',
        description: `Select one Builder candidate before QA: ${candidateBuilders.map((task) => `${task.id} — ${task.title}`).join('; ')}`,
      });
      this.trace('candidate-selection-requested', {
        missionId,
        planId,
        candidateTaskIds: candidateBuilders.map((task) => task.id),
      });
      return;
    }

    for (const task of ready) {
      const latest = await manager.getTask(task.id);
      if (!latest || (latest.status !== 'planned' && latest.status !== 'ready')) continue;
      if (latest.status === 'planned') {
        await manager.updateTask(latest.id, { status: 'ready' });
      }
      await this.assignTask(latest.id, latest.assignedRole ?? undefined);
      this.trace('task-dispatched', {
        missionId,
        planId,
        taskId: latest.id,
        role: latest.assignedRole,
      });
    }
  }
}

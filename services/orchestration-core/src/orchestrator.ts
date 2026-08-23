import type { LocalEventBus, Unsubscribe } from '@atris-agent-code/event-bus';
import type { AtrisDatabase, TaskSelect, MissionSelect, TaskAttemptInsert } from '@atris-agent-code/database';
import { approvals as approvalsTable, taskAttempts as taskAttemptsTable } from '@atris-agent-code/database';
import { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import type {
  AgentEvent,
  TaskCompleted,
  TaskFailed,
} from '@atris-agent-code/event-schema';
import type { ExecutionMode, AgentRole, MissionStatus } from '@atris-agent-code/domain';
import { PolicyEngine, resolveAutomationAction } from '@atris-agent-code/policy-engine';

export interface OrchestratorConfig {
  workspacePath: string;
  teamTemplateId?: string;
  executionMode?: ExecutionMode;
  missionId?: string;
  eventBus?: LocalEventBus;
  db?: AtrisDatabase;
  workspaceManager?: WorkspaceManager;
  maxTaskRetries?: number;
  applyTaskChanges?: (taskId: string) => Promise<{ success: boolean; output?: string; filesChanged?: number; checkpointId?: string }>;
}

export interface StructuredTaskPlan {
  title: string;
  description: string;
  role: AgentRole;
  priority: 'low' | 'medium' | 'high' | 'critical';
  requiredCapabilities: string[];
  dependsOnIndices?: number[];
  dependsOn?: string[];
}

export interface StructuredPlan {
  planId: string;
  assumptions: string[];
  questions: string[];
  tasks: StructuredTaskPlan[];
}

export const StructuredPlanJSONSchema = {
  type: 'object',
  properties: {
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          role: { type: 'string', enum: ['researcher', 'builder', 'reviewer', 'orchestrator', 'qa'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          requiredCapabilities: { type: 'array', items: { type: 'string' } },
          dependsOnIndices: { type: 'array', items: { type: 'number' } },
        },
        required: ['title', 'description', 'role', 'priority', 'requiredCapabilities'],
      },
    },
  },
  required: ['assumptions', 'questions', 'tasks'],
};

const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Generate default rule-based task template.
 */
function generateRuleBasedPlanTemplates(request: string): Array<{
  title: string;
  description: string;
  role: AgentRole;
  priority: 'low' | 'medium' | 'high' | 'critical';
  capabilities: string[];
}> {
  const reqLower = request.toLowerCase();

  if (reqLower.includes('fix') || reqLower.includes('bug') || reqLower.includes('error')) {
    return [
      {
        title: `Bug Investigation & Analysis: ${request}`,
        description: `Analyze codebase and root cause for "${request}"`,
        role: 'researcher',
        priority: 'high',
        capabilities: ['read_file', 'grep_search', 'log_inspection'],
      },
      {
        title: `Code Fix Implementation: ${request}`,
        description: `Apply root cause bug fix for "${request}"`,
        role: 'builder',
        priority: 'high',
        capabilities: ['replace_file_content', 'write_to_file', 'run_command'],
      },
      {
        title: `Verification & Quality Review: ${request}`,
        description: `Run tests and typecheck to verify fix for "${request}"`,
        role: 'reviewer',
        priority: 'high',
        capabilities: ['run_command', 'view_file'],
      },
    ];
  }

  return [
    {
      title: `Task 1: Research & Requirements - ${request}`,
      description: `Analyze specifications and codebase context for: ${request}`,
      role: 'researcher',
      priority: 'medium',
      capabilities: ['read_file', 'grep_search', 'list_dir'],
    },
    {
      title: `Task 2: Build & Implement - ${request}`,
      description: `Implement solution and features for: ${request}`,
      role: 'builder',
      priority: 'medium',
      capabilities: ['write_to_file', 'replace_file_content', 'run_command'],
    },
    {
      title: `Task 3: Code Review & Quality Assurance - ${request}`,
      description: `Review changes and verify type safety and tests for: ${request}`,
      role: 'reviewer',
      priority: 'medium',
      capabilities: ['run_command', 'view_file'],
    },
  ];
}

/**
 * Validate and repair raw plan JSON to guarantee a clean StructuredPlan DAG.
 */
export function validateAndRepairPlan(rawPlan: any, userRequest: string): StructuredPlan {
  const planId = typeof rawPlan?.planId === 'string' && rawPlan.planId ? rawPlan.planId : crypto.randomUUID();

  // 1. Validate & repair assumptions
  let assumptions: string[] = [];
  if (Array.isArray(rawPlan?.assumptions)) {
    assumptions = rawPlan.assumptions.filter((item: unknown) => typeof item === 'string' && (item as string).trim().length > 0);
  }
  if (assumptions.length === 0) {
    assumptions = [
      `Workspace aligns with standard project layout for: "${userRequest}"`,
      `Automated task execution and verification steps are active`,
    ];
  }

  // 2. Validate & repair questions
  let questions: string[] = [];
  if (Array.isArray(rawPlan?.questions)) {
    questions = rawPlan.questions.filter((item: unknown) => typeof item === 'string' && (item as string).trim().length > 0);
  }

  // 3. Validate & repair tasks DAG
  let tasks: StructuredTaskPlan[] = [];
  if (Array.isArray(rawPlan?.tasks) && rawPlan.tasks.length > 0) {
    tasks = rawPlan.tasks.map((task: any, index: number) => {
      const title = typeof task?.title === 'string' && task.title.trim() ? task.title.trim() : `Task ${index + 1}: ${userRequest}`;
      const description = typeof task?.description === 'string' && task.description.trim() ? task.description.trim() : title;

      const validRoles: AgentRole[] = ['researcher', 'builder', 'reviewer', 'orchestrator', 'qa'];
      const role: AgentRole = validRoles.includes(task?.role)
        ? task.role
        : index === 0
        ? 'researcher'
        : index === rawPlan.tasks.length - 1
        ? 'reviewer'
        : 'builder';

      const validPriorities = ['low', 'medium', 'high', 'critical'];
      const priority: 'low' | 'medium' | 'high' | 'critical' = validPriorities.includes(task?.priority) ? task.priority : 'medium';

      let requiredCapabilities: string[] = [];
      if (Array.isArray(task?.requiredCapabilities)) {
        requiredCapabilities = task.requiredCapabilities.filter((c: unknown) => typeof c === 'string');
      }
      if (requiredCapabilities.length === 0) {
        requiredCapabilities =
          role === 'researcher'
            ? ['read_file', 'grep_search']
            : role === 'reviewer'
            ? ['run_command', 'view_file']
            : ['write_to_file', 'replace_file_content', 'run_command'];
      }

      let dependsOnIndices: number[] = [];
      if (Array.isArray(task?.dependsOnIndices)) {
        dependsOnIndices = task.dependsOnIndices.filter((i: unknown) => typeof i === 'number' && i >= 0 && i < index);
      } else if (index > 0 && (!task?.dependsOn || task.dependsOn.length === 0)) {
        dependsOnIndices = [index - 1];
      }

      return {
        title,
        description,
        role,
        priority,
        requiredCapabilities,
        dependsOnIndices,
      };
    });
  }

  if (tasks.length === 0) {
    const templates = generateRuleBasedPlanTemplates(userRequest);
    tasks = templates.map((t, idx) => ({
      title: t.title,
      description: t.description,
      role: t.role,
      priority: t.priority,
      requiredCapabilities: t.capabilities,
      dependsOnIndices: idx > 0 ? [idx - 1] : [],
    }));
  }

  return {
    planId,
    assumptions,
    questions,
    tasks,
  };
}

export class Orchestrator {
  private config: OrchestratorConfig;
  private eventBus?: LocalEventBus;
  private db?: AtrisDatabase;
  private workspaceManager?: WorkspaceManager;
  private maxTaskRetries: number;
  private taskRetries: Map<string, number> = new Map();
  private taskAttempts: Map<string, number> = new Map();
  private inMemoryTasks: Map<string, TaskSelect> = new Map();
  private inMemoryMissions: Map<string, MissionSelect> = new Map();
  private handledRuntimeTerminalSessions = new Set<string>();
  private unsubscribeEvents?: Unsubscribe;
  private applyTaskChanges?: OrchestratorConfig['applyTaskChanges'];

  constructor(
    config: OrchestratorConfig,
    eventBus?: LocalEventBus,
    db?: AtrisDatabase,
    workspaceManager?: WorkspaceManager
  ) {
    this.config = {
      teamTemplateId: 'default-team',
      executionMode: 'balanced',
      ...config,
    };
    this.eventBus = eventBus ?? config.eventBus;
    this.db = db ?? config.db;
    this.workspaceManager = workspaceManager ?? config.workspaceManager;

    if (!this.workspaceManager && this.db) {
      this.workspaceManager = new WorkspaceManager(this.db, this.eventBus);
    }

    this.maxTaskRetries = config.maxTaskRetries ?? 3;
    this.applyTaskChanges = config.applyTaskChanges;

    if (this.eventBus) {
      this.subscribeToEvents();
    }
  }

  setEventBus(eventBus: LocalEventBus): void {
    this.unsubscribeFromEvents();
    this.eventBus = eventBus;
    if (this.db && !this.workspaceManager) {
      this.workspaceManager = new WorkspaceManager(this.db, this.eventBus);
    }
    this.subscribeToEvents();
  }

  setDatabase(db: AtrisDatabase): void {
    this.db = db;
    this.workspaceManager = new WorkspaceManager(this.db, this.eventBus);
  }

  setWorkspaceManager(wm: WorkspaceManager): void {
    this.workspaceManager = wm;
  }

  private subscribeToEvents(): void {
    if (!this.eventBus) return;

    const unSubCompleted = this.eventBus.on('task_completed', (event: TaskCompleted) => {
      this.handleTaskCompleted(event).catch((err) => {
        console.error('[Orchestrator] Failed to handle task_completed event:', err);
      });
    });

    const unSubFailed = this.eventBus.on('task_failed', (event: TaskFailed) => {
      this.handleTaskFailed(event).catch((err) => {
        console.error('[Orchestrator] Failed to handle task_failed event:', err);
      });
    });

    this.unsubscribeEvents = () => {
      unSubCompleted();
      unSubFailed();
    };
  }

  unsubscribeFromEvents(): void {
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = undefined;
    }
  }

  emitEvent(event: AgentEvent): void {
    this.eventBus?.emit(event);
  }

  emitTaskCreated(params: {
    missionId?: string;
    taskId: string;
    title: string;
    assignedRole?: string | null;
    agentInstanceId?: string;
  }): void {
    const missionId = params.missionId ?? this.config.missionId ?? '';
    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'task_created',
      missionId,
      taskId: params.taskId,
      title: params.title,
      assignedRole: params.assignedRole ?? null,
      agentInstanceId: params.agentInstanceId,
      timestamp: new Date().toISOString(),
    });
  }

  emitTaskAssigned(params: {
    missionId?: string;
    taskId: string;
    agentInstanceId?: string;
    role: string;
  }): void {
    const missionId = params.missionId ?? this.config.missionId ?? '';
    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'task_assigned',
      missionId,
      taskId: params.taskId,
      agentInstanceId: params.agentInstanceId ?? '',
      role: params.role,
      timestamp: new Date().toISOString(),
    });
  }

  emitPlanGenerated(params: {
    missionId?: string;
    planId: string;
    taskCount: number;
    summary: string;
  }): void {
    const missionId = params.missionId ?? this.config.missionId ?? '';
    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'plan_generated',
      missionId,
      planId: params.planId,
      taskCount: params.taskCount,
      summary: params.summary,
      timestamp: new Date().toISOString(),
    });
  }

  emitMissionStarted(params: {
    missionId?: string;
    workspaceId: string;
    title: string;
  }): void {
    const missionId = params.missionId ?? this.config.missionId ?? '';
    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'mission_started',
      missionId,
      workspaceId: params.workspaceId,
      title: params.title,
      timestamp: new Date().toISOString(),
    });
  }

  emitMissionCompleted(params: {
    missionId?: string;
    summary: string;
    tasksCompleted: number;
    totalTasks: number;
  }): void {
    const missionId = params.missionId ?? this.config.missionId ?? '';
    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'mission_completed',
      missionId,
      summary: params.summary,
      tasksCompleted: params.tasksCompleted,
      totalTasks: params.totalTasks,
      timestamp: new Date().toISOString(),
    });
  }

  emitMissionFailed(params: {
    missionId?: string;
    reason: string;
    failedTaskId?: string | null;
  }): void {
    const missionId = params.missionId ?? this.config.missionId ?? '';
    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'mission_failed',
      missionId,
      reason: params.reason,
      failedTaskId: params.failedTaskId ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  async emitApprovalRequested(params: {
    missionId?: string;
    taskId?: string;
    approvalType: string;
    description: string;
  }): Promise<string> {
    const missionId = params.missionId ?? this.config.missionId ?? '';
    const approvalId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    if (this.db) {
      await this.db.insert(approvalsTable).values({
        id: approvalId,
        missionId,
        taskId: params.taskId ?? null,
        runId: null,
        type: params.approvalType as any,
        description: params.description,
        status: 'pending',
        createdAt: timestamp,
      });
    }
    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'approval_requested',
      missionId,
      approvalId,
      approvalType: params.approvalType,
      description: params.description,
      timestamp,
    });
    return approvalId;
  }

  private resolveDirectiveRole(targetRole?: string, command?: string): AgentRole | undefined {
    const normalized = targetRole?.toLowerCase();
    if (normalized && ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'].includes(normalized)) {
      return normalized as AgentRole;
    }
    if (command === 'review') return 'reviewer';
    if (command === 'summarize') return 'orchestrator';
    if (command === 'agent') return 'builder';
    return undefined;
  }

  private tasksForPlan(tasks: TaskSelect[], planId?: string | null): TaskSelect[] {
    return planId ? tasks.filter((task) => task.planId === planId) : tasks;
  }

  /**
   * Generate structured plan and repair if invalid.
   */
  generateStructuredPlan(request: string, modelOutput?: string): StructuredPlan {
    let parsed: any = null;
    if (modelOutput) {
      try {
        parsed = JSON.parse(modelOutput);
      } catch {
        parsed = null;
      }
    }
    return validateAndRepairPlan(parsed, request);
  }

  /**
   * Primary entry point: Start a mission following Notion plan Section 20 state machine transitions:
   * Draft -> Planning -> AwaitingPlanApproval -> Running -> ...
   *
   * A mission is also the persistent chat/conversation boundary. When the same
   * mission is started again after a terminal turn, a new planId is created and
   * all execution decisions are scoped to that plan instead of reusing old tasks.
   */
  async startMission(
    missionId: string,
    request: string,
    options?: {
      modelCatalogId?: string;
      reasoningLevel?: string;
      targetRole?: string;
      command?: string;
      rawModelPlanOutput?: string;
    }
  ): Promise<{
    missionId: string;
    planId: string;
    tasks: TaskSelect[];
    structuredPlan: StructuredPlan;
  }> {
    const now = new Date().toISOString();
    let currentExecutionMode = this.config.executionMode ?? 'balanced';
    let currentAutomationPolicy: any = null;
    let previousPlanId: string | null = null;

    // 1. STATE: Draft/Terminal -> Planning
    if (this.workspaceManager) {
      const existingMission = await this.workspaceManager.getMission(missionId);
      if (!existingMission) {
        await this.workspaceManager.createMission({
          id: missionId,
          workspaceId: this.config.workspacePath || 'default-workspace',
          title: request,
          description: `Mission started for request: ${request}`,
          teamTemplateId: this.config.teamTemplateId ?? 'default-team',
          executionMode: currentExecutionMode,
          status: 'planning',
        });
      } else {
        previousPlanId = existingMission.planId ?? null;
        currentExecutionMode = (existingMission.executionMode as ExecutionMode) || currentExecutionMode;
        currentAutomationPolicy = existingMission.automationPolicy || null;
        await this.workspaceManager.updateMission(missionId, { status: 'planning', completedAt: null });
      }
    } else {
      const existingMission = this.inMemoryMissions.get(missionId);
      if (existingMission) {
        previousPlanId = existingMission.planId ?? null;
        currentExecutionMode = (existingMission.executionMode as ExecutionMode) || currentExecutionMode;
        this.inMemoryMissions.set(missionId, {
          ...existingMission,
          status: 'planning',
          completedAt: null,
          updatedAt: now,
        });
      } else {
        this.inMemoryMissions.set(missionId, {
          id: missionId,
          workspaceId: this.config.workspacePath || 'default-workspace',
          title: request,
          description: `Mission started for request: ${request}`,
          status: 'planning',
          teamTemplateId: this.config.teamTemplateId ?? 'default-team',
          planId: null,
          executionMode: currentExecutionMode,
          automationPolicy: null,
          activeRunId: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        });
      }
    }

    // 2. Generate Structured Plan & DAG with schema repair
    const directiveRole = this.resolveDirectiveRole(options?.targetRole, options?.command);
    const directTasks = directiveRole === 'builder'
      ? [
          {
            title: `Builder request: ${request}`,
            description: request,
            role: 'builder',
            priority: 'medium',
            requiredCapabilities: ['write_to_file', 'replace_file_content', 'run_command'],
            dependsOnIndices: [],
          },
          {
            title: `Review Builder result: ${request}`,
            description: 'Review the Builder worktree against the user request, repository rules, security constraints, and change scope. Request a revision from the same Builder when necessary.',
            role: 'reviewer',
            priority: 'high',
            requiredCapabilities: ['read_file', 'grep_search', 'view_file'],
            dependsOnIndices: [0],
          },
          {
            title: `Verify Builder result: ${request}`,
            description: 'Run the project-specific checks available in the workspace and report exact build, test, lint, or validation output.',
            role: 'qa',
            priority: 'high',
            requiredCapabilities: ['run_command', 'view_file'],
            dependsOnIndices: [1],
          },
        ]
      : directiveRole
        ? [{
            title: `${directiveRole.charAt(0).toUpperCase() + directiveRole.slice(1)} request: ${request}`,
            description: request,
            role: directiveRole,
            priority: options?.command === 'review' ? 'high' : 'medium',
            requiredCapabilities: directiveRole === 'qa'
              ? ['run_command', 'view_file']
              : ['read_file', 'grep_search', 'view_file'],
            dependsOnIndices: [],
          }]
        : [];
    const directivePlan = directiveRole && options?.command !== 'plan'
      ? JSON.stringify({
          assumptions: ['The user explicitly routed this request from the mission chat composer.'],
          questions: [],
          tasks: directTasks,
        })
      : options?.rawModelPlanOutput;
    const structuredPlan = this.generateStructuredPlan(request, directivePlan);
    const planId = structuredPlan.planId;

    if (this.workspaceManager) {
      await this.workspaceManager.updateMission(missionId, { planId });
    } else {
      const m = this.inMemoryMissions.get(missionId);
      if (m) this.inMemoryMissions.set(missionId, { ...m, planId });
    }

    if (previousPlanId) {
      this.emitEvent({
        id: crypto.randomUUID(),
        type: 'user_message',
        missionId,
        content: request,
        planId,
        previousPlanId,
        timestamp: new Date().toISOString(),
      });
    }

    const createdTasks: TaskSelect[] = [];
    const taskIndexToIds: Map<number, string[]> = new Map();

    // Build tasks (and candidate worktrees if candidate mode)
    for (let i = 0; i < structuredPlan.tasks.length; i++) {
      const taskSpec = structuredPlan.tasks[i];
      const isCandidate = currentExecutionMode === 'candidate' && taskSpec.role === 'builder';
      const tasksToCreateCount = isCandidate ? 2 : 1;

      // Resolve dependency task IDs from indices
      const dependsOnTaskIds: string[] = [];
      const depIndices = taskSpec.dependsOnIndices ?? (i > 0 ? [i - 1] : []);
      for (const depIdx of depIndices) {
        const parentIds = taskIndexToIds.get(depIdx) ?? [];
        dependsOnTaskIds.push(...parentIds);
      }

      const currentTaskIdsForIndex: string[] = [];

      for (let j = 0; j < tasksToCreateCount; j++) {
        const taskId = crypto.randomUUID();
        const candidateSuffix = isCandidate ? (j === 0 ? ' (Candidate A)' : ' (Candidate B)') : '';
        const title = taskSpec.title + candidateSuffix;
        const worktreeId = isCandidate ? (j === 0 ? `candidate-a-${taskId}` : `candidate-b-${taskId}`) : null;

        let taskRecord: TaskSelect;

        if (this.workspaceManager) {
          taskRecord = await this.workspaceManager.createTask({
            id: taskId,
            missionId,
            planId,
            title,
            description: taskSpec.description,
            status: 'planned',
            priority: taskSpec.priority,
            assignedRole: taskSpec.role,
            requiredCapabilities: taskSpec.requiredCapabilities,
            dependsOn: dependsOnTaskIds,
            worktreeId,
          });
        } else {
          taskRecord = {
            id: taskId,
            missionId,
            planId,
            title,
            description: taskSpec.description,
            status: 'planned',
            priority: taskSpec.priority,
            assignedAgentId: null,
            assignedRole: taskSpec.role,
            requiredCapabilities: taskSpec.requiredCapabilities,
            dependsOn: dependsOnTaskIds,
            worktreeId,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
          };
        }

        this.inMemoryTasks.set(taskId, taskRecord);
        createdTasks.push(taskRecord);
        currentTaskIdsForIndex.push(taskId);
      }

      taskIndexToIds.set(i, currentTaskIdsForIndex);
    }

    // STATE: Planning -> Ready (Plan Generated)
    if (this.workspaceManager) {
      await this.workspaceManager.updateMission(missionId, { status: 'ready' });
    } else {
      const cached = this.inMemoryMissions.get(missionId);
      if (cached) {
        this.inMemoryMissions.set(missionId, { ...cached, status: 'ready', updatedAt: new Date().toISOString() });
      }
    }

    // 3. Emit Plan Generated/Revised events
    this.emitPlanGenerated({
      missionId,
      planId,
      taskCount: createdTasks.length,
      summary: `Generated ${createdTasks.length}-step structured DAG plan for "${request}"`,
    });
    if (previousPlanId) {
      this.emitEvent({
        id: crypto.randomUUID(),
        type: 'plan_revised',
        missionId,
        planId,
        previousPlanId,
        reason: 'New user turn received in the existing conversation. A fresh execution plan was created without mixing prior-turn tasks.',
        changedTaskIds: createdTasks.map((task) => task.id),
        timestamp: new Date().toISOString(),
      });
    }

    // 4. Policy Engine check for Plan Approval
    const policyEngine = new PolicyEngine(currentExecutionMode as any);
    const planDecision = currentAutomationPolicy
      ? resolveAutomationAction(currentAutomationPolicy.profile, 'plan', currentAutomationPolicy.overrides)
      : null;
    if (planDecision === 'deny') throw new Error('Mission policy denies plan execution.');
    const autoApproved = planDecision ? planDecision === 'auto' || planDecision === 'review' : await policyEngine.requestApproval(
      'plan', `Approve execution plan with ${createdTasks.length} tasks for: ${request}`);

    if (!autoApproved) {
      // STATE: Planning -> AwaitingPlanApproval (waiting_for_approval)
      await this.emitApprovalRequested({
        missionId,
        approvalType: 'plan',
        description: `Plan with ${createdTasks.length} tasks: ${createdTasks.map((t) => t.title).join(', ')}`,
      });

      if (this.workspaceManager) {
        await this.workspaceManager.updateMission(missionId, { status: 'waiting_for_approval' as MissionStatus });
      } else {
        const cached = this.inMemoryMissions.get(missionId);
        if (cached) {
          this.inMemoryMissions.set(missionId, { ...cached, status: 'waiting_for_approval' as MissionStatus });
        }
      }

      return {
        missionId,
        planId,
        tasks: createdTasks,
        structuredPlan,
      };
    }

    // 5. STATE: Planning -> Running
    if (this.workspaceManager) {
      await this.workspaceManager.updateMission(missionId, { status: 'running' });
    } else {
      const cached = this.inMemoryMissions.get(missionId);
      if (cached) {
        this.inMemoryMissions.set(missionId, { ...cached, status: 'running', updatedAt: new Date().toISOString() });
      }
    }

    if (!previousPlanId) {
      this.emitMissionStarted({
        missionId,
        workspaceId: this.config.workspacePath || 'default-workspace',
        title: request,
      });
    }

    // Start first ready task(s)
    if (createdTasks.length > 0) {
      const firstTasks = createdTasks.filter(
        (t) => !t.dependsOn || (t.dependsOn as string[]).length === 0
      );
      const startTasks = firstTasks.length > 0 ? firstTasks : [createdTasks[0]];
      for (const taskToStart of startTasks) {
        await this.assignTask(taskToStart.id, taskToStart.assignedRole ?? 'researcher');
      }
    }

    return {
      missionId,
      planId,
      tasks: createdTasks,
      structuredPlan,
    };
  }

  /**
   * Assign task to agent role and emit task events. The agent instance id is
   * allocated before runtime startup so route/worktree/spawn failures are tied to
   * the correct attempt and the UI can show a real preparing subagent immediately.
   */
  async assignTask(taskId: string, agentRole?: AgentRole): Promise<TaskSelect> {
    let task: TaskSelect | null = this.inMemoryTasks.get(taskId) ?? null;

    if (this.workspaceManager) {
      const dbTask = await this.workspaceManager.getTask(taskId);
      if (dbTask) task = dbTask;
    }

    const roleToAssign = agentRole ?? task?.assignedRole ?? 'builder';
    const agentInstanceId = crypto.randomUUID();

    if (this.workspaceManager && task) {
      task = await this.workspaceManager.updateTask(taskId, {
        status: 'running',
        assignedRole: roleToAssign,
        assignedAgentId: agentInstanceId,
      });
      this.inMemoryTasks.set(taskId, task);
    } else if (task) {
      task = {
        ...task,
        status: 'running',
        assignedRole: roleToAssign,
        assignedAgentId: agentInstanceId,
        updatedAt: new Date().toISOString(),
      };
      this.inMemoryTasks.set(taskId, task);
    }

    const missionId = task?.missionId ?? this.config.missionId ?? '';
    const title = task?.title ?? `Task ${taskId}`;
    const displayRole = roleToAssign.charAt(0).toUpperCase() + roleToAssign.slice(1);

    this.emitTaskAssigned({
      missionId,
      taskId,
      role: roleToAssign,
      agentInstanceId,
    });

    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'agent_spawned',
      missionId,
      agentInstanceId,
      role: roleToAssign,
      displayName: `${displayRole} Agent`,
      spawnReason: `Orchestrator scheduled task: ${title}`,
      taskId,
      workspaceMode: roleToAssign === 'builder' ? 'isolated_worktree' : roleToAssign === 'orchestrator' ? 'shared' : 'read_only',
      timestamp: new Date().toISOString(),
    });

    this.emitTaskCreated({
      missionId,
      taskId,
      title,
      assignedRole: roleToAssign,
      agentInstanceId,
    });

    if (task) return task;

    const now = new Date().toISOString();
    const fallbackTask: TaskSelect = {
      id: taskId,
      missionId,
      planId: '',
      title,
      description: '',
      status: 'running',
      priority: 'medium',
      assignedAgentId: agentInstanceId,
      assignedRole: roleToAssign,
      requiredCapabilities: [],
      dependsOn: [],
      worktreeId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.inMemoryTasks.set(taskId, fallbackTask);
    return fallbackTask;
  }

  private async shouldIgnoreRuntimeTerminalEvent(event: TaskCompleted | TaskFailed): Promise<boolean> {
    const mission = this.workspaceManager
      ? await this.workspaceManager.getMission(event.missionId)
      : this.inMemoryMissions.get(event.missionId);
    if (mission && TERMINAL_MISSION_STATUSES.has(String(mission.status))) return true;

    const task = this.workspaceManager
      ? await this.workspaceManager.getTask(event.taskId)
      : this.inMemoryTasks.get(event.taskId);
    const agentInstanceId = event.agentInstanceId;
    if (!agentInstanceId) return false;

    if (this.handledRuntimeTerminalSessions.has(agentInstanceId)) return true;
    if (task?.assignedAgentId && task.assignedAgentId !== agentInstanceId) return true;

    // Fence this runtime attempt before the state transition awaits. Runtime
    // adapters may report both an explicit turn failure and a non-zero process
    // close for the same session, and those events must not schedule two retries.
    this.handledRuntimeTerminalSessions.add(agentInstanceId);
    return false;
  }

  /**
   * State Machine Handler: Run when a task completes.
   * Notion Section 20 State Transitions:
   * Running -> Reviewing -> Applying -> Verifying -> Completed
   */
  async handleTaskCompleted(event: TaskCompleted): Promise<void> {
    if (await this.shouldIgnoreRuntimeTerminalEvent(event)) return;

    const { taskId, missionId } = event;
    const now = new Date().toISOString();

    // 1. Mark task completed
    let completedTask: TaskSelect | null = null;
    if (this.workspaceManager) {
      completedTask = await this.workspaceManager.updateTask(taskId, {
        status: 'done',
        completedAt: now,
      });
    }

    const cachedTask = this.inMemoryTasks.get(taskId);
    if (cachedTask) {
      const updatedTask = {
        ...cachedTask,
        status: 'done' as const,
        completedAt: now,
        updatedAt: now,
      };
      this.inMemoryTasks.set(taskId, updatedTask);
      if (!completedTask) completedTask = updatedTask;
    }

    // 2. Fetch only tasks from the completed task's plan/turn. Historical tasks
    // stay persisted for the conversation but must never be scheduled or applied again.
    const activePlanId = completedTask?.planId || null;
    let allTasks: TaskSelect[] = [];
    if (this.workspaceManager) {
      allTasks = this.tasksForPlan(await this.workspaceManager.listTasks(missionId), activePlanId);
    } else {
      allTasks = this.tasksForPlan(
        Array.from(this.inMemoryTasks.values()).filter((t) => t.missionId === missionId),
        activePlanId,
      );
    }

    if (allTasks.length === 0) {
      this.emitMissionCompleted({
        missionId,
        summary: `Task ${taskId} completed successfully`,
        tasksCompleted: 1,
        totalTasks: 1,
      });
      return;
    }

    const completedTasksCount = allTasks.filter((t) => t.status === 'done').length;
    const terminalTasksCount = allTasks.filter((t) => t.status === 'done' || t.status === 'superseded').length;
    void completedTasksCount;

    // 3. All execution tasks are finished. Review and apply are separate, auditable stages.
    if (terminalTasksCount === allTasks.length) {
      const mission = this.workspaceManager
        ? await this.workspaceManager.getMission(missionId)
        : this.inMemoryMissions.get(missionId);
      if (mission && TERMINAL_MISSION_STATUSES.has(String(mission.status))) return;
      const executionMode = (mission?.executionMode || this.config.executionMode || 'balanced') as ExecutionMode;
      const automationPolicy = mission?.automationPolicy as any;
      const reviewerDone = allTasks.some((task) => task.assignedRole === 'reviewer' && task.status === 'done');
      const qaTasks = allTasks.filter((task) => task.assignedRole === 'qa');
      const qaDone = qaTasks.length === 0 || qaTasks.every((task) => task.status === 'done');

      if (this.workspaceManager) await this.workspaceManager.updateMission(missionId, { status: 'reviewing' });
      const cachedMission = this.inMemoryMissions.get(missionId);
      if (cachedMission) this.inMemoryMissions.set(missionId, { ...cachedMission, status: 'reviewing', updatedAt: now });

      this.emitEvent({
        id: crypto.randomUUID(),
        type: 'review_completed',
        missionId,
        taskId,
        reviewerAgentId: reviewerDone ? 'reviewer' : 'orchestrator',
        approved: reviewerDone && qaDone,
        findings: reviewerDone && qaDone
          ? 'Execution, review, and configured QA tasks completed. Changes are ready for the apply policy.'
          : 'Execution finished, but a dedicated Reviewer or required QA task did not complete.',
        timestamp: now,
      });

      if (!reviewerDone || !qaDone) {
        if (this.workspaceManager) await this.workspaceManager.updateMission(missionId, { status: 'blocked' });
        this.emitEvent({
          id: crypto.randomUUID(),
          type: 'mission_failed',
          missionId,
          reason: 'Quality gate is incomplete. A dedicated Reviewer and all configured QA tasks must complete before changes can be applied.',
          failedTaskId: taskId,
          timestamp: now,
        });
        return;
      }

      const policyEngine = new PolicyEngine(executionMode as any);
      const applyDecision = automationPolicy
        ? resolveAutomationAction(automationPolicy.profile, 'workspaceApply', automationPolicy.overrides)
        : null;
      if (applyDecision === 'deny') {
        if (this.workspaceManager) await this.workspaceManager.updateMission(missionId, { status: 'blocked' });
        return;
      }
      const applyApproved = applyDecision ? applyDecision === 'auto' : await policyEngine.requestApproval(
        'apply', `Apply ${allTasks.filter((task) => task.assignedRole === 'builder').length} Builder worktree result(s) to the workspace`);

      if (!applyApproved || !this.applyTaskChanges) {
        if (this.workspaceManager) await this.workspaceManager.updateMission(missionId, { status: 'waiting_for_approval' });
        await this.emitApprovalRequested({
          missionId,
          approvalType: 'apply',
          description: this.applyTaskChanges
            ? 'Review packs are ready. Approve applying the Builder worktree changes to the workspace.'
            : 'Review packs are ready, but no deterministic apply coordinator is configured.',
        });
        return;
      }

      if (this.workspaceManager) await this.workspaceManager.updateMission(missionId, { status: 'applying' });
      const builderTasks = allTasks.filter((task) => task.assignedRole === 'builder' && task.status === 'done');
      for (const builderTask of builderTasks) {
        const result = await this.applyTaskChanges(builderTask.id);
        if (!result.success) {
          if (this.workspaceManager) await this.workspaceManager.updateMission(missionId, { status: 'blocked' });
          this.emitMissionFailed({
            missionId,
            reason: result.output || `Applying task ${builderTask.id} failed.`,
            failedTaskId: builderTask.id,
          });
          return;
        }
        this.emitEvent({
          id: crypto.randomUUID(),
          type: 'changes_applied',
          missionId,
          taskId: builderTask.id,
          filesChanged: result.filesChanged || 0,
          checkpointId: result.checkpointId || '',
          timestamp: new Date().toISOString(),
        });
      }

      if (this.workspaceManager) {
        await this.workspaceManager.updateMission(missionId, { status: 'verifying' });
        await this.workspaceManager.updateMission(missionId, { status: 'completed', completedAt: new Date().toISOString() });
      }
      this.emitMissionCompleted({
        missionId,
        summary: `All ${allTasks.length} tasks completed, quality gates passed, and deterministic apply finished.`,
        tasksCompleted: terminalTasksCount,
        totalTasks: allTasks.length,
      });
      return;
    }

    // 4. Find next executable tasks whose dependencies are terminal.
    const nextTasks = allTasks.filter((t) => {
      if (t.status !== 'planned' && t.status !== 'ready') return false;
      const deps = (t.dependsOn as string[]) || [];
      return deps.every((depId) => {
        const depTask = allTasks.find((item) => item.id === depId);
        return depTask?.status === 'done' || depTask?.status === 'superseded';
      });
    });

    const currentMission = this.workspaceManager
      ? await this.workspaceManager.getMission(missionId)
      : this.inMemoryMissions.get(missionId);
    if (currentMission && TERMINAL_MISSION_STATUSES.has(String(currentMission.status))) return;
    const candidateBuilders = allTasks.filter((task) => task.assignedRole === 'builder' && task.title.includes('(Candidate'));
    const candidateResolved = candidateBuilders.length > 1 && candidateBuilders.some((task) => task.status === 'superseded');
    if (currentMission?.executionMode === 'candidate' && candidateBuilders.length > 1 && !candidateResolved && nextTasks.some((task) => task.assignedRole === 'qa')) {
      if (this.workspaceManager) await this.workspaceManager.updateMission(missionId, { status: 'waiting_for_approval' });
      await this.emitApprovalRequested({
        missionId,
        approvalType: 'candidate_selection',
        description: `Select one Builder candidate before QA: ${candidateBuilders.map((task) => `${task.id} — ${task.title}`).join('; ')}`,
      });
      return;
    }

    for (const task of nextTasks) {
      if (this.workspaceManager) {
        await this.workspaceManager.updateTask(task.id, { status: 'ready' });
      }
      const cached = this.inMemoryTasks.get(task.id);
      if (cached) {
        this.inMemoryTasks.set(task.id, { ...cached, status: 'ready', updatedAt: new Date().toISOString() });
      }

      await this.assignTask(task.id, task.assignedRole ?? undefined);
    }
  }

  /**
   * Handle task execution failure with retry limits.
   */
  async handleTaskFailed(event: TaskFailed): Promise<void> {
    if (await this.shouldIgnoreRuntimeTerminalEvent(event)) return;

    const { taskId, missionId, error } = event;
    const currentRetries = this.taskRetries.get(taskId) ?? 0;
    const now = new Date().toISOString();

    if (currentRetries < this.maxTaskRetries) {
      const newCount = currentRetries + 1;
      this.taskRetries.set(taskId, newCount);

      console.warn(`[Orchestrator] Task ${taskId} failed (${error}). Retrying (${newCount}/${this.maxTaskRetries})...`);

      await this.assignTask(taskId);
      return;
    }

    if (this.workspaceManager) {
      await this.workspaceManager.updateTask(taskId, { status: 'rejected' });
      await this.workspaceManager.updateMission(missionId, { status: 'failed' });
    }

    const cachedTask = this.inMemoryTasks.get(taskId);
    if (cachedTask) {
      this.inMemoryTasks.set(taskId, { ...cachedTask, status: 'rejected', updatedAt: now });
    }

    const cachedMission = this.inMemoryMissions.get(missionId);
    if (cachedMission) {
      this.inMemoryMissions.set(missionId, { ...cachedMission, status: 'failed', updatedAt: now });
    }

    this.emitMissionFailed({
      missionId,
      reason: `Task ${taskId} failed after ${this.maxTaskRetries} retries: ${error}`,
      failedTaskId: taskId,
    });
  }

  /**
   * Request task revision: Sends revision to the same Builder session/attempt (max 3 attempts).
   * Notion Section 20 Transition: Reviewing -> Revising -> Running
   */
  async requestRevision(taskId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    let task = this.inMemoryTasks.get(taskId) ?? null;

    if (this.workspaceManager) {
      const dbTask = await this.workspaceManager.getTask(taskId);
      if (dbTask) task = dbTask;
    }

    const missionId = task?.missionId ?? this.config.missionId ?? '';
    const currentAttempts = (this.taskAttempts.get(taskId) ?? 1) + 1;

    if (currentAttempts > this.maxTaskRetries) {
      console.warn(`[Orchestrator] Task ${taskId} exceeded max revision attempts (${this.maxTaskRetries}). Failing mission.`);

      if (this.workspaceManager) {
        await this.workspaceManager.updateTask(taskId, { status: 'rejected' });
        await this.workspaceManager.updateMission(missionId, { status: 'failed' });
      }

      if (task) {
        this.inMemoryTasks.set(taskId, { ...task, status: 'rejected', updatedAt: now });
      }

      this.emitMissionFailed({
        missionId,
        reason: `Task ${taskId} failed after ${this.maxTaskRetries} revision attempts: ${reason}`,
        failedTaskId: taskId,
      });
      return;
    }

    this.taskAttempts.set(taskId, currentAttempts);

    // Save TaskAttempt record if DB is available
    if (this.db) {
      try {
        const newAttempt: TaskAttemptInsert = {
          id: crypto.randomUUID(),
          taskId,
          missionId,
          agentInstanceId: task?.assignedAgentId ?? 'builder-session',
          attemptNumber: currentAttempts,
          status: 'running',
          worktreePath: task?.worktreeId ?? null,
          startedAt: now,
          error: reason,
        };
        await this.db.insert(taskAttemptsTable).values(newAttempt);
      } catch (err) {
        console.warn('[Orchestrator] Failed to insert taskAttempt record:', err);
      }
    }

    const updatedDescription = (task?.description ?? '') + `\n\n[Revision Attempt ${currentAttempts}]: ${reason}`;

    if (this.workspaceManager) {
      task = await this.workspaceManager.updateTask(taskId, {
        status: 'revision_requested',
        description: updatedDescription,
      });
      await this.workspaceManager.updateMission(missionId, { status: 'revising' });
    }

    if (task) {
      this.inMemoryTasks.set(taskId, {
        ...task,
        status: 'revision_requested',
        description: updatedDescription,
        updatedAt: now,
      });
    }

    const cachedMission = this.inMemoryMissions.get(missionId);
    if (cachedMission) {
      this.inMemoryMissions.set(missionId, { ...cachedMission, status: 'revising', updatedAt: now });
    }

    // Re-assign task to the same Builder role with a fresh correlated runtime attempt id.
    await this.assignTask(taskId, task?.assignedRole ?? 'builder');
  }

  async handleApprovalDecision(
    missionId: string,
    approvalType: string,
    approved: boolean,
    options?: { selectedCandidateId?: string; reason?: string },
  ): Promise<void> {
    if (!this.workspaceManager) {
      throw new Error('Approval decisions require a WorkspaceManager.');
    }

    const mission = await this.workspaceManager.getMission(missionId);
    if (mission && TERMINAL_MISSION_STATUSES.has(String(mission.status))) {
      throw new Error(`Mission '${missionId}' is already ${mission.status} and cannot resume an approval action.`);
    }

    if (!approved) {
      await this.workspaceManager.updateMission(missionId, { status: 'blocked' });
      return;
    }

    if (approvalType === 'candidate_selection') {
      if (!options?.selectedCandidateId) throw new Error('selectedCandidateId is required to approve a candidate selection.');
      await this.selectCandidate(missionId, options.selectedCandidateId, options.reason || 'Selected by the user after candidate review.');
      return;
    }

    if (approvalType === 'plan') {
      const tasks = this.tasksForPlan(await this.workspaceManager.listTasks(missionId), mission?.planId);
      await this.workspaceManager.updateMission(missionId, { status: 'running' });
      const ready = tasks.filter((task) => {
        if (task.status !== 'planned' && task.status !== 'ready') return false;
        const dependencies = (task.dependsOn as string[]) || [];
        return dependencies.length === 0;
      });
      for (const task of ready) {
        await this.assignTask(task.id, task.assignedRole ?? undefined);
      }
      return;
    }

    if (approvalType === 'apply') {
      if (!this.applyTaskChanges) {
        throw new Error('No deterministic apply coordinator is configured.');
      }
      const tasks = this.tasksForPlan(await this.workspaceManager.listTasks(missionId), mission?.planId);
      const incomplete = tasks.filter((task) => task.status !== 'done');
      if (incomplete.length > 0) {
        throw new Error('Changes cannot be applied while mission tasks are incomplete.');
      }
      const reviewerDone = tasks.some((task) => task.assignedRole === 'reviewer' && task.status === 'done');
      const qaTasks = tasks.filter((task) => task.assignedRole === 'qa');
      if (!reviewerDone || !qaTasks.every((task) => task.status === 'done')) {
        throw new Error('Reviewer and configured QA quality gates must pass before apply.');
      }

      await this.workspaceManager.updateMission(missionId, { status: 'applying' });
      for (const task of tasks.filter((item) => item.assignedRole === 'builder' && item.status === 'done')) {
        const result = await this.applyTaskChanges(task.id);
        if (!result.success) {
          await this.workspaceManager.updateMission(missionId, { status: 'blocked' });
          throw new Error(result.output || `Applying task ${task.id} failed.`);
        }
        this.emitEvent({
          id: crypto.randomUUID(),
          type: 'changes_applied',
          missionId,
          taskId: task.id,
          filesChanged: result.filesChanged || 0,
          checkpointId: result.checkpointId || '',
          timestamp: new Date().toISOString(),
        });
      }
      await this.workspaceManager.updateMission(missionId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      this.emitMissionCompleted({
        missionId,
        summary: `All ${tasks.length} tasks completed, quality gates passed, and approved changes were applied.`,
        tasksCompleted: tasks.length,
        totalTasks: tasks.length,
      });
      return;
    }

    throw new Error(`Approval type '${approvalType}' does not have a resumable action.`);
  }

  async selectCandidate(missionId: string, selectedTaskId: string, reason: string): Promise<void> {
    if (!this.workspaceManager) throw new Error('Candidate selection requires a WorkspaceManager.');
    const mission = await this.workspaceManager.getMission(missionId);
    if (!mission) throw new Error(`Mission '${missionId}' was not found.`);
    if (TERMINAL_MISSION_STATUSES.has(String(mission.status))) throw new Error(`Mission '${missionId}' is already ${mission.status}.`);
    if (mission.executionMode !== 'candidate') throw new Error('Candidate selection is only valid for missions in Candidate mode.');
    const tasks = this.tasksForPlan(await this.workspaceManager.listTasks(missionId), mission.planId);
    const candidates = tasks.filter((task) => task.assignedRole === 'builder' && task.title.includes('(Candidate'));
    if (candidates.length < 2) throw new Error('This mission does not contain multiple Builder candidates.');
    const selected = candidates.find((task) => task.id === selectedTaskId);
    if (!selected) throw new Error(`Builder candidate '${selectedTaskId}' was not found in this mission.`);
    if (selected.status !== 'done') throw new Error('Only a completed Builder candidate can be selected.');
    if (!selected.worktreeId) throw new Error('The selected candidate does not have an isolated worktree result.');

    for (const candidate of candidates) {
      await this.workspaceManager.updateTask(candidate.id, {
        status: candidate.id === selectedTaskId ? 'done' : 'superseded',
      });
    }
    await this.workspaceManager.updateMission(missionId, { status: 'running' });
    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'candidate_selected',
      missionId,
      taskId: selectedTaskId,
      selectedCandidateId: selectedTaskId,
      reason,
      timestamp: new Date().toISOString(),
    });

    const refreshed = this.tasksForPlan(await this.workspaceManager.listTasks(missionId), mission.planId);
    const nextTasks = refreshed.filter((task) => {
      if (task.status !== 'planned' && task.status !== 'ready') return false;
      return ((task.dependsOn as string[]) || []).every((dependencyId) => {
        const dependency = refreshed.find((item) => item.id === dependencyId);
        return dependency?.status === 'done' || dependency?.status === 'superseded';
      });
    });
    for (const task of nextTasks) await this.assignTask(task.id, task.assignedRole ?? undefined);
  }

  async retryTask(taskId: string): Promise<TaskSelect> {
    let task: TaskSelect | null = this.inMemoryTasks.get(taskId) ?? null;
    if (this.workspaceManager) task = await this.workspaceManager.getTask(taskId);
    const missionId = task?.missionId;
    if (missionId) {
      const mission = this.workspaceManager
        ? await this.workspaceManager.getMission(missionId)
        : this.inMemoryMissions.get(missionId);
      if (mission && task?.planId && mission.planId && task.planId !== mission.planId) {
        throw new Error(`Task '${taskId}' belongs to a previous conversation turn and cannot be retried as part of the active plan.`);
      }
      if (mission && (mission.status === 'completed' || mission.status === 'cancelled')) {
        throw new Error(`Mission '${missionId}' is ${mission.status}; its tasks cannot be retried.`);
      }
    }
    this.taskRetries.set(taskId, 0);
    this.taskAttempts.set(taskId, 1);
    return await this.assignTask(taskId);
  }

  async getMissionState(missionId: string): Promise<{
    mission: MissionSelect | null;
    tasks: TaskSelect[];
  }> {
    let mission: MissionSelect | null = this.inMemoryMissions.get(missionId) ?? null;
    let tasksList: TaskSelect[] = Array.from(this.inMemoryTasks.values()).filter((t) => t.missionId === missionId);

    if (this.workspaceManager) {
      const dbMission = await this.workspaceManager.getMission(missionId);
      if (dbMission) mission = dbMission;
      const dbTasks = await this.workspaceManager.listTasks(missionId);
      if (dbTasks.length > 0) tasksList = dbTasks;
    }

    return { mission, tasks: this.tasksForPlan(tasksList, mission?.planId) };
  }

  async applyOrReject(taskId: string, decision: 'apply' | 'reject'): Promise<void> {
    if (this.workspaceManager) {
      await this.workspaceManager.updateTask(taskId, {
        status: decision === 'apply' ? 'done' : 'rejected',
      });
    }
  }

  /**
   * Resume session and recover running tasks.
   */
  async resumeSession(): Promise<void> {
    if (!this.workspaceManager) {
      console.warn('[Orchestrator] No WorkspaceManager available for resumeSession.');
      return;
    }

    console.log('[Orchestrator] Attempting to resume session and recover tasks...');
    const allMissions = await this.workspaceManager.listMissions();
    const runningMissions = allMissions.filter((m) => m.status === 'running' || m.status === 'revising');

    for (const mission of runningMissions) {
      console.log(`[Orchestrator] Recovering mission: ${mission.id}`);
      const tasks = this.tasksForPlan(await this.workspaceManager.listTasks(mission.id), mission.planId);

      const activeTasks = tasks.filter((t) => t.status === 'running' || t.status === 'revision_requested');
      for (const task of activeTasks) {
        console.log(`[Orchestrator] Resuming active task: ${task.id}`);
        await this.assignTask(task.id, task.assignedRole ?? undefined);
      }
    }
  }

}

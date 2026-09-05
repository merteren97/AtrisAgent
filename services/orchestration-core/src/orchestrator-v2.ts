import { and, eq } from 'drizzle-orm';
import {
  conversationTurns,
  artifacts,
  missionCompletions,
  missionEvents,
  missionRuns,
  taskAttempts,
  type AtrisDatabase,
  type MissionSelect,
  type TaskSelect,
} from '@atris-agent-code/database';
import {
  getSupervisorTurnRunner,
  redactSensitiveValue,
  type LocalEventBus,
} from '@atris-agent-code/event-bus';
import type { AgentEvent, TaskCompleted, TaskFailed } from '@atris-agent-code/event-schema';
import type {
  AgentRole,
  OrchestratorDecision,
  OrchestratorTurnAction,
  QualityResultEnvelope,
  PostApplyVerificationResult,
} from '@atris-agent-code/domain';
import { parseQualityResultEnvelope } from '@atris-agent-code/domain';
import { resolveAutomationAction } from '@atris-agent-code/policy-engine';
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
  isPriorResearchImplementationFollowUp,
  normalizeSupervisorDecision,
  parseSupervisorDecision,
  type SupervisorTurnContext,
} from './supervisor-turn';
import { allocateWorkerBatch } from './worker-pool';

const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const NON_PROGRESSING_MISSION_STATUSES = new Set(['blocked', ...TERMINAL_MISSION_STATUSES]);
const TERMINAL_TASK_STATUSES = new Set(['done', 'superseded']);
const TASK_COMPLETION_FENCE_STATUSES = new Set(['cancelled', 'rejected', 'superseded', 'done']);
const FAILED_TASK_STATUSES = new Set(['rejected']);
const ACTIVE_TASK_STATUSES = new Set(['claimed', 'running', 'review', 'revision_requested', 'verified', 'applied']);
const RUNTIME_TERMINAL_EVENT_TYPES = new Set<AgentEvent['type']>(['task_completed', 'task_failed']);
const SCHEDULABLE_MISSION_STATUSES = new Set(['ready', 'running', 'revising', 'reviewing', 'verifying']);
const RECONCILABLE_MISSION_STATUSES = new Set([...SCHEDULABLE_MISSION_STATUSES, 'reviewing', 'verifying']);
const MAX_CONTEXT_EVENTS = 24;
const MAX_CONTEXT_CHARS = 18_000;
const MAX_QUALITY_SUMMARY_CHARS = 4_000;
const MAX_RESEARCH_SOURCE_CHARS = 6_000;
const MAX_RESEARCH_BUNDLE_CHARS = 16_000;
const RESEARCH_CONTEXT_START = '[ATRIS_RESEARCH_CONTEXT_START]';
const RESEARCH_CONTEXT_END = '[ATRIS_RESEARCH_CONTEXT_END]';

interface QualityVerdict {
  passed: boolean;
  summary: string;
  findingCount: number;
  reason: 'approved' | 'failed' | 'ambiguous';
}

interface QualityEmissionResult {
  verdict: QualityVerdict;
  emitted: boolean;
}

interface ResearchContextBundle {
  version: 1;
  missionId: string;
  planId: string;
  complete: boolean;
  sourceTaskIds: string[];
  sources: Array<{ taskId: string; attemptId?: string; result: string; uncertain: boolean }>;
  findings: string[];
  evidence: Array<{ taskId: string; attemptId?: string }>;
  conflicts: string[];
  uncertainties: string[];
  truncated: boolean;
}

type SchedulableWorkerRole = 'researcher' | 'builder' | 'reviewer' | 'qa';

function isSchedulableWorkerRole(role: TaskSelect['assignedRole']): role is SchedulableWorkerRole {
  return role === 'researcher' || role === 'builder' || role === 'reviewer' || role === 'qa';
}

function clearNegatedQualitySignals(text: string): string {
  return text
    // Remove ordinary negated failure lists before scanning individual words;
    // e.g. "no test failures or errors" is a passing report, not a failure.
    .replace(/\b(?:no|without|zero|none)\s+(?:(?:any|all|the|test|tests|check|checks|build|builds|lint|validation|validations|blocking|major|critical)\s+)*(?:failures?|errors?|issues?|defects?|problems?|concerns?|blockers?)(?:\s+(?:and|or)\s+(?:failures?|errors?|issues?|defects?|problems?|concerns?|blockers?))*/gi, ' ')
    .replace(/\b(?:no|without|zero)\s+(?:any\s+)?(?:blocking|major|critical)(?:\s*(?:[,/]\s*(?:and|or)?\s*|\b(?:and|or)\b\s*)(?:blocking|major|critical))*\s+(?:findings?|issues?|defects?|problems?|concerns?|blockers?)\b/gi, ' ')
    .replace(/\b(?:0|no|without|zero)\s+(?:failed|failing)\s+(?:checks?|tests?|builds?|lint(?:ing)?|validations?)\b/gi, ' ')
    .replace(/\b(?:0|no|without|zero)\s+(?:checks?|tests?|builds?|lint(?:ing)?|validations?)\s+(?:failed|failing)\b/gi, ' ')
    .replace(/\b(?:no|without|zero)\s+(?:revision|revisions|change|changes)\s+(?:is\s+|are\s+|was\s+|were\s+)?(?:requested|required|needed)\b/gi, ' ')
    .replace(/\b(?:no|without|zero)\s+(?:(?:test|tests|check|checks|build|builds|command|commands|lint|validation|validations)\s+)?(?:failures?|errors?)(?:\s+(?:or|and|[/,])\s+(?:failures?|errors?))?\b/gi, ' ')
    .replace(/\b(?:no|without|zero)\s+(?:blocking|blocked|blockers?|major|critical|failure|failures|error|errors|pending)\b/gi, ' ')
    .replace(/\b(?:0|none)\s+(?:blocking|major|critical)(?:\s*(?:[,/]\s*(?:and|or)?\s*|\b(?:and|or)\b\s*)(?:blocking|major|critical))*\s+(?:findings?|issues?|defects?|problems?|concerns?|blockers?)\b/gi, ' ')
    .replace(/\b(?:blocking|major|critical)\s+(?:findings?|issues?|defects?|problems?|concerns?|blockers?)\s*(?:[:=(]\s*)?(?:0|none)\b/gi, ' ')
    .replace(/\b(?:0|none)\s+(?:failed|failing|failure|failures|error|errors|pending)\b/gi, ' ')
    .replace(/\b(?:blocking|major|critical)\s*[:=-]\s*(?:none|no)\b/gi, ' ');
}

function hasQualityFailureSignal(text: string): boolean {
  const evaluableText = clearNegatedQualitySignals(text);
  return [
    /\b(?:revision|revisions|change|changes)\s+(?:is\s+|are\s+)?(?:requested|required|needed)\b/i,
    /\brequest(?:ed)?\s+(?:a\s+)?(?:revision|revisions|change|changes)\b/i,
    /\b(?:cannot|can't|can not|unable to|not enough evidence to|not able to)\s+(?:recommend\s+)?(?:approve|approval|pass|passing)\b/i,
    /\b(?:not|never)\s+(?:approve|approved|approval|pass|passed|passing)\b/i,
    /\b(?:approval|verdict|recommendation)\s*[:=-]?\s*(?:pending|unclear|unknown|none|not available)\b/i,
    /\b(?:no|without|zero)\s+pass(?:ed|es|ing)?\s+(?:was\s+)?(?:reported|provided|given|verdict|result|recommendation)\b/i,
    /\b(?:pass|approval|verdict)\s*[:=-]\s*(?:no|false|fail(?:ed)?|rejected|blocked|pending)\b/i,
    /\b(?:reject(?:ed|s|ion)?|denied|declined|unapproved)\b/i,
    /\b(?:fail(?:ed|s|ure|ures|ing)?)\b/i,
    /\berrors?\b/i,
    /\b(?:did not|didn't|does not|doesn't|not)\s+pass(?:ed|es|ing)?\b/i,
    /\b(?:no|none of the|zero)\s+(?:(?:checks?|tests?|builds?|lint(?:ing)?|validations?)\s+)?pass(?:ed|es|ing)?\b/i,
    /\b(?:blocked|blocking|blockers?)\b/i,
    /\b(?:major|critical)\s+(?:finding|findings|issue|issues|defect|defects|problem|problems|concern|concerns|severity)\b/i,
    /\b(?:finding|findings|issue|issues|defect|defects|problem|problems|concern|concerns)\s+(?:with\s+)?(?:major|critical)\b/i,
    /\bseverity\s*[:=-]?\s*(?:major|critical)\b/i,
    /\b(?:unclear|ambiguous|unknown|indeterminate|inconclusive|pending)\b/i,
    /\b(?:insufficient|not enough)\s+(?:evidence|information)\b/i,
    /\b(?:pass|passed|approve|approved)\s*[?/]\b/i,
    /\bpass\s*(?:\/|or)\s*fail\b/i,
  ].some((pattern) => pattern.test(evaluableText));
}

function inferQualityVerdict(
  role: TaskSelect['assignedRole'],
  rawResult: unknown,
): QualityVerdict | null {
  if (role !== 'reviewer' && role !== 'qa') return null;

  const envelope = parseQualityResultEnvelope(rawResult);
  if (envelope === 'invalid' || (envelope && envelope.role !== role)) {
    return { passed: false, summary: 'Invalid or mismatched structured quality result.', findingCount: 1, reason: 'ambiguous' };
  }
  if (envelope) {
    const detail = [envelope.summary, ...(envelope.findings || []), ...(envelope.evidence || [])].join('\n');
    // Evidence is supporting material and commonly contains path names such
    // as `error-boundary.tsx` or raw command output. Only the summary/findings
    // express the quality judgment; scanning evidence creates false failures
    // for an otherwise explicit structured pass.
    const judgment = [envelope.summary, ...(envelope.findings || [])].join('\n');
    const contradictory = envelope.verdict === 'pass' && hasQualityFailureSignal(judgment);
    const passed = envelope.verdict === 'pass' && !contradictory;
    return {
      passed,
      summary: String(redactSensitiveValue(detail)).slice(0, MAX_QUALITY_SUMMARY_CHARS),
      findingCount: passed ? 0 : Math.max(1, envelope.findings?.length || 0),
      reason: passed ? 'approved' : contradictory ? 'ambiguous' : 'failed',
    };
  }

  const rawText = typeof rawResult === 'string' ? rawResult.trim() : '';
  const safeResult = rawText ? String(redactSensitiveValue(rawText)).slice(0, MAX_QUALITY_SUMMARY_CHARS) : '';
  const hasFailure = hasQualityFailureSignal(rawText);
  const hasNegatedExplicitPass = /\b(?:no|without|zero)\s+explicit\s+(?:approve|approval|pass|verdict)\b/i.test(rawText);
  const hasExplicitPass = !hasNegatedExplicitPass && (
    /\b(?:approve|approved|approves|pass|passed|passes|passing)\b/i.test(rawText)
    || /\bapproval\s*(?:status\s*)?[:=-]\s*(?:yes|true|granted|approved)\b/i.test(rawText)
  );
  const passed = !hasFailure && hasExplicitPass;
  const reason: QualityVerdict['reason'] = passed ? 'approved' : hasFailure ? 'failed' : 'ambiguous';
  const summary = `[legacy_compatibility_fallback] ${safeResult || (role === 'reviewer'
    ? 'No explicit review approval or revision verdict was reported.'
    : 'No explicit QA pass or failure verdict was reported.')}`.slice(0, MAX_QUALITY_SUMMARY_CHARS);

  return {
    passed,
    summary,
    findingCount: passed || !rawText ? 0 : 1,
    reason,
  };
}

interface StartMissionOptionsV2 {
  modelCatalogId?: string;
  reasoningLevel?: string;
  targetRole?: string;
  command?: string;
  /** Trusted, pre-validated named profile selection keyed by fixed role. */
  agentProfileIds?: Partial<Record<AgentRole, string>>;
  rawModelPlanOutput?: string;
  turnId?: string;
  runId?: string;
  researchContextPlanId?: string;
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
   private readonly v2ApplyTaskChanges?: OrchestratorConfig['applyTaskChanges'];
   private readonly v2PostApplyVerification?: OrchestratorConfig['postApplyVerification'];
   private readonly v2ExecuteApplyVerificationOperation?: OrchestratorConfig['executeApplyVerificationOperation'];
  private readonly missionQueues = new Map<string, Promise<void>>();
  private readonly planActions = new Map<string, OrchestratorTurnAction>();
  private readonly synthesizedPlans = new Set<string>();
  private readonly deferredCompletionMissions = new Set<string>();
  private readonly deferredCompletions = new Map<string, { summary: string; tasksCompleted: number; totalTasks: number }>();
  private readonly lifecycleByMission = new Map<string, { turnId?: string; runId?: string }>();
  private readonly suppressedLegacyReviewEvents = new Set<string>();
  private readonly pendingSteers = new Map<string, string[]>();
  private readonly emittedUserMessageTurns = new Set<string>();
  private readonly cancelledRunIds = new Set<string>();

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
    this.v2ApplyTaskChanges = config.applyTaskChanges;
    this.v2PostApplyVerification = config.postApplyVerification;
    this.v2ExecuteApplyVerificationOperation = config.executeApplyVerificationOperation;
    this.v2WorkspaceManager = workspaceManager
      ?? config.workspaceManager
      ?? (this.v2Db ? new WorkspaceManager(this.v2Db, this.v2EventBus) : undefined);
  }

  private trace(stage: string, details: Record<string, unknown>): void {
    console.info(`[OrchestratorV2][Scheduler] ${stage} ${JSON.stringify(redactSensitiveValue(details))}`);
  }

  private taskTraceDetails(task: TaskSelect): Record<string, unknown> {
    return {
      taskId: task.id,
      role: task.assignedRole || null,
      status: task.status,
      dependsOnTaskIds: Array.isArray(task.dependsOn)
        ? task.dependsOn.filter((dependencyId): dependencyId is string => typeof dependencyId === 'string')
        : [],
      agentInstanceId: task.assignedAgentId || null,
      agentProfileId: task.agentProfileId || null,
    };
  }

  private planTraceDetails(tasks: StructuredTaskPlan[]): Array<Record<string, unknown>> {
    return tasks.map((task, index) => ({
      index,
      role: task.role,
      dependsOnIndices: [...(task.dependsOnIndices || [])],
    }));
  }

  private completionKey(missionId: string, planId: string): string {
    return `${missionId}:${planId}`;
  }

  override emitEvent(event: AgentEvent): void {
    if (event.type === 'review_completed' && this.suppressedLegacyReviewEvents.has(event.missionId)) {
      this.trace('legacy-review-event-suppressed', {
        missionId: event.missionId,
        turnId: event.turnId,
        taskId: event.taskId,
        reviewerAgentId: event.reviewerAgentId,
      });
      return;
    }
    const lifecycle = this.lifecycleByMission.get(event.missionId);
    if (lifecycle?.runId && this.cancelledRunIds.has(lifecycle.runId)) {
      this.trace('cancelled-run-event-ignored', { missionId: event.missionId, runId: lifecycle.runId, type: event.type });
      return;
    }
    if (event.type === 'user_message') {
      const turnId = event.turnId || lifecycle?.turnId;
      if (turnId && this.emittedUserMessageTurns.has(turnId)) return;
      if (turnId) {
        this.emittedUserMessageTurns.add(turnId);
        event = { ...event, turnId };
      }
    }
    if (lifecycle?.turnId && !event.turnId) event = { ...event, turnId: lifecycle.turnId };
    if (lifecycle?.runId && !event.runId && !RUNTIME_TERMINAL_EVENT_TYPES.has(event.type)) {
      event = { ...event, runId: lifecycle.runId };
    }
    super.emitEvent(event);
  }

  cancelRun(missionId: string, runId?: string): void {
    const id = runId || this.lifecycleByMission.get(missionId)?.runId;
    if (id) this.cancelledRunIds.add(id);
  }

  private async ensureRunIsCurrent(missionId: string, runId?: string): Promise<void> {
    if (!runId) return;
    if (this.cancelledRunIds.has(runId)) throw new Error('The orchestration run was cancelled.');
    const mission = this.v2WorkspaceManager ? await this.v2WorkspaceManager.getMission(missionId) : null;
    if (!mission || mission.status === 'cancelled' || (mission.activeRunId && mission.activeRunId !== runId)) {
      throw new Error('The supervisor decision belongs to a cancelled or stale run.');
    }
  }

  private async assertMissionActionCurrent(missionId: string, runId?: string): Promise<MissionSelect> {
    if (runId && this.cancelledRunIds.has(runId)) throw new Error('The orchestration run was cancelled.');
    const manager = this.v2WorkspaceManager;
    const mission = manager ? await manager.getMission(missionId) : null;
    if (!mission) throw new Error('The orchestration mission no longer exists.');
    if (mission.status === 'cancelled' || mission.status === 'failed' || mission.status === 'blocked') {
      throw new Error(`Mission '${missionId}' is ${mission.status} and cannot continue this action.`);
    }
    if (runId && mission.activeRunId && mission.activeRunId !== runId) {
      throw new Error('The orchestration action belongs to a stale run.');
    }
    return mission;
  }

  private isRunFenceError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /orchestration run was cancelled|cancelled or stale run|action belongs to a stale run|decision belongs to a cancelled or stale run/i.test(message);
  }

  /**
   * A runtime terminal event without runId is only actionable when its durable
   * task/agent assignment (and, when available, the latest durable attempt)
   * identifies the active attempt. The in-memory lifecycle is useful for
   * decorating derived events, but is not enough to promote an uncorrelated
   * terminal signal into the current run.
   */
  private async correlateRunlessTerminalEvent<T extends TaskCompleted | TaskFailed>(event: T): Promise<T | null> {
    if (!this.v2WorkspaceManager) return event;

    const manager = this.v2WorkspaceManager;
    const mission = await manager.getMission(event.missionId);
    if (!mission || TERMINAL_MISSION_STATUSES.has(String(mission.status)) || mission.status === 'blocked') return null;
    if (event.runId) return event;

    const task = await manager.getTask(event.taskId);
    if (!task || task.missionId !== event.missionId || !event.agentInstanceId) return null;

    const taskAgentMatches = task.assignedAgentId === event.agentInstanceId;
    const listTaskAttempts = (manager as WorkspaceManager & {
      listTaskAttempts?: (taskId: string) => Promise<Array<{
        taskId: string;
        missionId: string;
        agentInstanceId: string;
        attemptNumber: number;
        status: string;
      }>>;
    }).listTaskAttempts;
    let attemptAgentMatches = false;
    if (typeof listTaskAttempts === 'function') {
      let attempts: Array<{
        taskId: string;
        missionId: string;
        agentInstanceId: string;
        attemptNumber: number;
        status: string;
      }>;
      try {
        attempts = await listTaskAttempts.call(manager, task.id);
      } catch {
        return null;
      }
      if (attempts.length > 0) {
        const latestAttempt = [...attempts].sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
        const terminalAttemptStatus = event.type === 'task_completed' ? 'completed' : 'failed';
        const validAttemptStatus = new Set(['claimed', 'running', terminalAttemptStatus]);
        if (!latestAttempt
          || latestAttempt.taskId !== task.id
          || latestAttempt.missionId !== event.missionId
          || latestAttempt.agentInstanceId !== event.agentInstanceId
          || !validAttemptStatus.has(String(latestAttempt.status))) {
          return null;
        }
        attemptAgentMatches = true;
      }
    }

    if (!taskAgentMatches && !attemptAgentMatches) return null;
    if (!ACTIVE_TASK_STATUSES.has(String(task.status))) return null;

    // Only a durable mission activeRunId can identify the run to inherit. If
    // it is absent, preserve the missing runId and let task/agent correlation
    // alone authorize the state transition without inventing run identity.
    return mission.activeRunId ? { ...event, runId: mission.activeRunId } : event;
  }

  protected override async assertTaskCompletionCurrent(event: TaskCompleted): Promise<void> {
    await this.assertMissionActionCurrent(event.missionId, event.runId);
  }

  private async canPublishCompletion(missionId: string): Promise<boolean> {
    if (!this.v2WorkspaceManager) return true;
    const mission = await this.v2WorkspaceManager.getMission(missionId);
    if (!mission) return false;
    return !['failed', 'cancelled', 'blocked'].includes(String(mission.status));
  }

  private async preserveCancelledRunFence(missionId: string, runId: string | undefined): Promise<void> {
    if (!runId || !this.cancelledRunIds.has(runId) || !this.v2WorkspaceManager) return;
    const mission = await this.v2WorkspaceManager.getMission(missionId);
    if (mission && mission.status !== 'cancelled') {
      await this.v2WorkspaceManager.updateMission(missionId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      });
    }
  }

  private async ensureTurnUserMessage(missionId: string, turnId: string, content: string, previousPlanId?: string | null): Promise<void> {
    if (this.emittedUserMessageTurns.has(turnId)) return;
    if (this.v2Db) {
      const existing = await this.v2Db.select({ payload: missionEvents.payload }).from(missionEvents)
        .where(and(eq(missionEvents.missionId, missionId), eq(missionEvents.type, 'user_message')));
      if (existing.some((row) => typeof row.payload?.turnId === 'string' && row.payload.turnId === turnId)) {
        this.emittedUserMessageTurns.add(turnId);
        return;
      }
    }
    this.emitEvent({ id: crypto.randomUUID(), type: 'user_message', missionId, turnId, content,
      previousPlanId: previousPlanId || null, timestamp: new Date().toISOString() });
  }

  override async assignTask(taskId: string, agentRole?: AgentRole): Promise<TaskSelect> {
    const task = this.v2WorkspaceManager ? await this.v2WorkspaceManager.getTask(taskId) : null;
    const lifecycle = task ? this.lifecycleByMission.get(task.missionId) : undefined;
    try {
      if (lifecycle?.runId && this.cancelledRunIds.has(lifecycle.runId)) {
        throw new Error('The orchestration run was cancelled.');
      }
      const assignedTask = await super.assignTask(taskId, agentRole);
      const role = assignedTask.assignedRole || agentRole || 'builder';
      const assignedLifecycle = this.lifecycleByMission.get(assignedTask.missionId);
      const traceDetails = {
        missionId: assignedTask.missionId,
        turnId: assignedLifecycle?.turnId,
        runId: assignedLifecycle?.runId,
        planId: assignedTask.planId || undefined,
        ...this.taskTraceDetails(assignedTask),
      };

      if (role === 'reviewer') {
        if (this.v2WorkspaceManager) await this.v2WorkspaceManager.updateMission(assignedTask.missionId, { status: 'reviewing' });
        this.trace('review-dispatched', traceDetails);
      } else if (role === 'qa') {
        if (this.v2WorkspaceManager) await this.v2WorkspaceManager.updateMission(assignedTask.missionId, { status: 'verifying' });
        this.emitEvent({
          id: crypto.randomUUID(),
          type: 'verification_started',
          missionId: assignedTask.missionId,
          ...assignedLifecycle,
          taskId: assignedTask.id,
          reviewerAgentId: assignedTask.assignedAgentId || undefined,
          timestamp: new Date().toISOString(),
        });
        this.trace('qa-dispatched', traceDetails);
      } else {
        this.trace('task-dispatched', traceDetails);
      }

      return assignedTask;
    } catch (error) {
      if (task && !this.isRunFenceError(error)) {
        await this.transitionMissionDiagnostic({
          missionId: task.missionId,
          taskId,
          status: 'failed',
          reason: `Task dispatch failed before execution for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      throw error;
    }
  }

  override emitMissionCompleted(params: { missionId?: string; summary: string; tasksCompleted: number; totalTasks: number }): void {
    const missionId = params.missionId || '';
    if (this.deferredCompletionMissions.has(missionId)) {
      this.deferredCompletions.set(missionId, {
        summary: params.summary,
        tasksCompleted: params.tasksCompleted,
        totalTasks: params.totalTasks,
      });
      return;
    }
    // V2 completion events must come from completeDurably after a live mission
    // and durable completion row have been checked. Keep the legacy fallback
    // for manager-less orchestration, where no durable mission exists to fence.
    if (this.v2WorkspaceManager) {
      this.trace('completion-suppressed-without-durable-fence', { missionId });
      return;
    }
    const lifecycle = this.lifecycleByMission.get(missionId);
    this.v2EventBus?.emit({ id: crypto.randomUUID(), type: 'mission_completed', missionId, ...lifecycle,
      summary: params.summary, tasksCompleted: params.tasksCompleted, totalTasks: params.totalTasks, timestamp: new Date().toISOString() });
  }

  private emitDurableCompletion(params: { missionId: string; planId: string; summary: string;
    tasksCompleted: number; totalTasks: number }): void {
    const lifecycle = this.lifecycleByMission.get(params.missionId);
    this.v2EventBus?.emit({ id: `mission-completed:${params.missionId}:${params.planId}`, type: 'mission_completed',
      missionId: params.missionId, ...lifecycle, summary: params.summary, tasksCompleted: params.tasksCompleted,
      totalTasks: params.totalTasks, timestamp: new Date().toISOString() });
  }

  private async getCompletion(missionId: string, planId: string): Promise<any | null> {
    if (!this.v2Db) return null;
    const rows = await this.v2Db.select().from(missionCompletions).where(and(
      eq(missionCompletions.missionId, missionId),
      eq(missionCompletions.planId, planId),
    ));
    return rows[0] || null;
  }

  private async ensureSynthesisIntent(params: {
    missionId: string;
    planId: string;
    tasksCompleted: number;
    totalTasks: number;
  }): Promise<any | null> {
    if (!this.v2Db) return null;
    if (!(await this.canPublishCompletion(params.missionId))) {
      this.trace('completion-intent-suppressed-for-missing-or-terminal-mission', {
        missionId: params.missionId,
        planId: params.planId,
      });
      return null;
    }
    const existing = await this.getCompletion(params.missionId, params.planId);
    if (existing) return existing;
    const lifecycle = this.lifecycleByMission.get(params.missionId);
    await this.v2Db.insert(missionCompletions).values({
      missionId: params.missionId,
      planId: params.planId,
      status: 'synthesis_pending',
      summary: null,
      runId: lifecycle?.runId || null,
      turnId: lifecycle?.turnId || null,
      tasksCompleted: params.tasksCompleted,
      totalTasks: params.totalTasks,
      createdAt: new Date().toISOString(),
    }).onConflictDoNothing();
    return this.getCompletion(params.missionId, params.planId);
  }

  private async completeDurably(params: { missionId: string; planId: string; summary: string;
    tasksCompleted: number; totalTasks: number }): Promise<void> {
    if (!(await this.canPublishCompletion(params.missionId))) {
      this.trace('completion-suppressed-for-missing-or-terminal-mission', { missionId: params.missionId, planId: params.planId });
      return;
    }
    const existing = await this.getCompletion(params.missionId, params.planId);
    const lifecycle = this.lifecycleByMission.get(params.missionId);
    if (existing?.status === 'completed') {
      this.synthesizedPlans.add(this.completionKey(params.missionId, params.planId));
      return;
    }
    if (this.v2Db) {
      if (!existing) await this.v2Db.insert(missionCompletions).values({
        missionId: params.missionId, planId: params.planId, status: 'synthesis_pending', summary: null,
        runId: lifecycle?.runId || null, turnId: lifecycle?.turnId || null,
        tasksCompleted: params.tasksCompleted, totalTasks: params.totalTasks, createdAt: new Date().toISOString(),
      }).onConflictDoNothing();
      await this.v2Db.update(missionCompletions).set({
        status: 'event_pending',
        summary: params.summary,
        runId: existing?.runId || lifecycle?.runId || null,
        turnId: existing?.turnId || lifecycle?.turnId || null,
      })
        .where(and(
          eq(missionCompletions.missionId, params.missionId),
         eq(missionCompletions.planId, params.planId),
       ));
    }
    if (!(await this.canPublishCompletion(params.missionId))) {
      this.trace('completion-suppressed-before-event', { missionId: params.missionId, planId: params.planId });
      return;
    }
    this.emitDurableCompletion(params);
    if (this.v2Db) await this.v2Db.update(missionCompletions).set({ status: 'completed', completedAt: new Date().toISOString() })
      .where(and(
        eq(missionCompletions.missionId, params.missionId),
        eq(missionCompletions.planId, params.planId),
      ));
    this.synthesizedPlans.add(this.completionKey(params.missionId, params.planId));
  }

  private async completeWithSynthesis(params: { missionId: string; planId: string; tasksCompleted: number;
    totalTasks: number; latestResult?: string }, beforePublish?: () => Promise<void>): Promise<void> {
    if (!(await this.canPublishCompletion(params.missionId))) {
      this.trace('completion-suppressed-for-terminal-mission', { missionId: params.missionId, planId: params.planId });
      return;
    }
    const existing = await this.ensureSynthesisIntent(params);
    if (existing?.status === 'completed') {
      this.synthesizedPlans.add(this.completionKey(params.missionId, params.planId));
      return;
    }
    const summary = existing?.summary || await this.synthesizePlanResult(params.missionId, params.planId, params.latestResult);
    if (!(await this.canPublishCompletion(params.missionId))) {
      this.trace('completion-suppressed-after-synthesis', { missionId: params.missionId, planId: params.planId });
      return;
    }
    await beforePublish?.();
    await this.completeDurably({ missionId: params.missionId, planId: params.planId, summary,
      tasksCompleted: params.tasksCompleted, totalTasks: params.totalTasks });
  }

  async recoverPendingCompletions(): Promise<void> {
    if (!this.v2Db) return;
    const pending = await this.v2Db.select().from(missionCompletions);
    for (const completion of pending.filter((row) => row.status !== 'completed')) {
      try {
        const mission = this.v2WorkspaceManager ? await this.v2WorkspaceManager.getMission(completion.missionId) : null;
        if (!mission) {
          this.trace('completion-recovery-skipped-for-missing-mission', {
            missionId: completion.missionId,
            planId: completion.planId,
          });
          continue;
        }
        if (mission && ['failed', 'cancelled', 'blocked'].includes(String(mission.status))) {
          this.trace('completion-recovery-skipped-for-terminal-mission', {
            missionId: completion.missionId,
            planId: completion.planId,
            status: mission.status,
          });
          continue;
        }
        if (completion.runId || completion.turnId) {
          this.lifecycleByMission.set(completion.missionId, {
            runId: completion.runId || undefined,
            turnId: completion.turnId || undefined,
          });
        } else {
          const runs = await this.v2Db.select().from(missionRuns).where(and(
            eq(missionRuns.missionId, completion.missionId),
            eq(missionRuns.planId, completion.planId),
          ));
          const run = runs[0];
          if (run) this.lifecycleByMission.set(completion.missionId, { runId: run.id, turnId: run.turnId || undefined });
        }
        const summary = completion.summary || await this.synthesizePlanResult(completion.missionId, completion.planId);
        if (!completion.summary) await this.v2Db.update(missionCompletions).set({ status: 'event_pending', summary })
          .where(and(
            eq(missionCompletions.missionId, completion.missionId),
            eq(missionCompletions.planId, completion.planId),
          ));
        await this.completeDurably({ missionId: completion.missionId, planId: completion.planId, summary,
          tasksCompleted: completion.tasksCompleted, totalTasks: completion.totalTasks });
      } catch (error) {
        let missionStillExists = false;
        try {
          missionStillExists = Boolean(this.v2WorkspaceManager && await this.v2WorkspaceManager.getMission(completion.missionId));
        } catch {
          missionStillExists = false;
        }
        if (missionStillExists) {
          await this.transitionMissionDiagnostic({
            missionId: completion.missionId,
            status: 'failed',
            reason: `Completion reconciliation failed for plan ${completion.planId}: ${error instanceof Error ? error.message : String(error)}`,
          });
        } else {
          this.trace('completion-recovery-diagnostic-suppressed-for-missing-mission', {
            missionId: completion.missionId,
            planId: completion.planId,
          });
        }
        this.trace('completion-recovery-deferred', {
          missionId: completion.missionId,
          planId: completion.planId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  override emitMissionFailed(params: { missionId?: string; reason: string; failedTaskId?: string | null }): void {
    const missionId = params.missionId || '';
    const lifecycle = this.lifecycleByMission.get(missionId);
    this.v2EventBus?.emit({ id: crypto.randomUUID(), type: 'mission_failed', missionId, ...lifecycle,
      reason: params.reason, failedTaskId: params.failedTaskId ?? null, timestamp: new Date().toISOString() });
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

  async steerActiveTurn(params: { missionId: string; targetTurnId: string; content: string }): Promise<{ boundary: 'future_tasks' | 'synthesis' }> {
    return this.enqueueMission(params.missionId, async () => {
      const lifecycle = this.lifecycleByMission.get(params.missionId);
      if (!lifecycle?.turnId || lifecycle.turnId !== params.targetTurnId) throw new Error('The active turn changed before steering could be applied.');
      const manager = this.v2WorkspaceManager;
      if (!manager) throw new Error('Durable orchestration is unavailable.');
      const mission = await manager.getMission(params.missionId);
      if (!mission || TERMINAL_MISSION_STATUSES.has(String(mission.status))) throw new Error('The active turn has already finished.');
      const tasks = (await manager.listTasks(params.missionId)).filter((task) => task.planId === mission.planId);
      const future = tasks.filter((task) => task.status === 'planned' || task.status === 'ready');
      for (const task of future) {
        await manager.updateTask(task.id, { description: `${task.description}\n\nOrchestrator steering for the next safe boundary:\n${params.content}` });
      }
      const pending = this.pendingSteers.get(params.missionId) || [];
      pending.push(params.content);
      this.pendingSteers.set(params.missionId, pending);
      return { boundary: future.length > 0 ? 'future_tasks' : 'synthesis' };
    });
  }

  private async loadConversationContext(missionId: string): Promise<{
    conversationContext: string;
    workspaceContext: string;
    hasPriorConversation: boolean;
    priorResearchBundle: ResearchContextBundle | null;
  }> {
    const manager = this.v2WorkspaceManager;
    const mission = manager ? await manager.getMission(missionId) : null;
    const tasks = manager ? await manager.listTasks(missionId) : [];
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const completedTurnIds = new Set<string>();
    let rows: Array<{ type: string; payload: Record<string, unknown>; taskId: string | null; createdAt: string }> = [];

    if (this.v2Db) {
      const turns = await this.v2Db.select({ id: conversationTurns.id, status: conversationTurns.status })
        .from(conversationTurns).where(eq(conversationTurns.missionId, missionId));
      for (const turn of turns) if (turn.status === 'completed') completedTurnIds.add(turn.id);
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
    const eligibleRows = rows.filter((row) => {
      if (row.type !== 'user_message') return true;
      const eventTurnId = typeof row.payload?.turnId === 'string' ? row.payload.turnId : '';
      return !eventTurnId || completedTurnIds.has(eventTurnId);
    });
    for (const row of eligibleRows.slice(-MAX_CONTEXT_EVENTS)) {
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

    const priorResearchBundle = await this.getLatestResearchBundle(missionId);
    if (priorResearchBundle) {
      lines.push(`Durable prior research context (plan ${priorResearchBundle.planId}): ${JSON.stringify(priorResearchBundle)}`);
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
      hasPriorConversation: lines.length > 1 || completedTurnIds.size > 0 || Boolean(mission?.completedAt),
      priorResearchBundle,
    };
  }

  private async decideTurn(
    missionId: string,
    turnId: string,
    request: string,
    options?: StartMissionOptionsV2,
  ): Promise<{ decision: OrchestratorDecision; context: SupervisorTurnContext; hasPriorConversation: boolean; priorResearchBundle: ResearchContextBundle | null }> {
    const loaded = await this.loadConversationContext(missionId);
    const context: SupervisorTurnContext = {
      turnId,
      userMessage: request,
      conversationContext: loaded.conversationContext,
      workspaceContext: loaded.workspaceContext,
      explicitCommand: options?.command,
      explicitTargetRole: options?.targetRole,
    };
    const reusableResearchBundle = loaded.priorResearchBundle && isPriorResearchImplementationFollowUp(context)
      ? loaded.priorResearchBundle
      : null;
    // Validate configured identity outside the model fallback: a missing or
    // archived specialist must not silently become the baseline orchestrator.
    const supervisorProfiles = await this.resolveTaskProfileIds(missionId, ['orchestrator'], options?.agentProfileIds);
    const supervisorProfileId = supervisorProfiles.orchestrator || options?.agentProfileIds?.orchestrator || 'orchestrator';
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
          agentProfileId: supervisorProfileId,
        });
        const parsed = parseSupervisorDecision(raw, turnId);
        if (parsed) {
          return {
            decision: normalizeSupervisorDecision(parsed, context, { reusePriorResearch: Boolean(reusableResearchBundle) }),
            context,
            hasPriorConversation: loaded.hasPriorConversation,
            priorResearchBundle: reusableResearchBundle,
          };
        }
        this.trace('supervisor-invalid-json', { missionId, turnId, rawLength: raw.length });
      } catch (error) {
        if (error instanceof Error && error.message === 'Supervisor turn cancelled.') throw error;
        this.trace('supervisor-runtime-fallback', {
          missionId,
          turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      decision: normalizeSupervisorDecision(fallbackSupervisorDecision(context), context, { reusePriorResearch: Boolean(reusableResearchBundle) }),
      context,
      hasPriorConversation: loaded.hasPriorConversation,
      priorResearchBundle: reusableResearchBundle,
    };
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
    if (manager) {
      await manager.updateMission(params.missionId, {
        planId: turnPlanId,
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
    }
    await this.completeDurably({
      missionId: params.missionId,
      planId: turnPlanId,
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
    agentProfileIds?: Partial<Record<AgentRole, string>>;
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
    const lifecycle = this.lifecycleByMission.get(params.missionId);
    this.trace('plan-normalized', {
      missionId: params.missionId,
      turnId: params.turnId,
      runId: lifecycle?.runId,
      planId,
      action: 'plan_only',
      taskCount: taskSpecs.length,
      tasks: this.planTraceDetails(taskSpecs),
    });
    const createdTasks: TaskSelect[] = [];
    const idsByIndex = new Map<number, string>();
    const agentProfileIds = await this.resolveTaskProfileIds(params.missionId, taskSpecs.map((task) => task.role), params.agentProfileIds);

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
        agentProfileId: agentProfileIds[spec.role],
        requiredCapabilities: spec.requiredCapabilities,
        dependsOn: dependencies,
        targetDescriptor: spec.targetDescriptor,
      }));
    }

    this.trace('plan-materialized', {
      missionId: params.missionId,
      turnId: params.turnId,
      runId: lifecycle?.runId,
      planId,
      tasks: createdTasks.map((task) => this.taskTraceDetails(task)),
    });

    const mission = await manager.getMission(params.missionId);
    const builderTasks = createdTasks.filter((task) => task.assignedRole === 'builder');
    const automationPolicy = mission?.automationPolicy;
    // A missing policy is treated as approval-required for a plan-only Builder
    // lane. Older missions may not have a policy snapshot, and silently
    // executing their plan would bypass the user's current safety setting.
    const planDecision = automationPolicy
      ? resolveAutomationAction(automationPolicy.profile, 'plan', automationPolicy.overrides)
      : 'ask';
    const autoContinue = builderTasks.length === 0
      || (!params.decision.needsUserApproval && (planDecision === 'auto' || planDecision === 'review'));

    if (builderTasks.length > 0 && planDecision === 'deny') {
      const reason = 'Mission policy denies Builder execution for this plan.';
      await this.transitionMissionDiagnostic({
        missionId: params.missionId,
        taskId: builderTasks[0]?.id,
        status: 'failed',
        reason,
      });
      throw new Error(reason);
    }

    this.planActions.set(planId, autoContinue && builderTasks.length > 0 ? 'execute' : 'plan_only');
    this.emitPlanGenerated({
      missionId: params.missionId,
      planId,
      taskCount: createdTasks.length,
      summary: autoContinue && builderTasks.length > 0
        ? `Prepared and started a ${createdTasks.length}-step plan under the mission automation policy.`
        : `Prepared a ${createdTasks.length}-step plan without starting execution.`,
    });

    if (builderTasks.length > 0 && !autoContinue) {
      await manager.updateMission(params.missionId, {
        planId,
        status: 'waiting_for_approval',
        completedAt: null,
      });
      await this.emitApprovalRequested({
        missionId: params.missionId,
        approvalType: 'plan',
        description: `Plan with ${createdTasks.length} tasks is ready. Approve before Builder execution begins.`,
      });
      return { missionId: params.missionId, planId, tasks: createdTasks, structuredPlan };
    }

    if (builderTasks.length > 0 && autoContinue) {
      await manager.updateMission(params.missionId, {
        planId,
        status: 'running',
        completedAt: null,
      });
      await this.reconcileMissionPlan(params.missionId, planId);
      return { missionId: params.missionId, planId, tasks: createdTasks, structuredPlan };
    }

    await manager.updateMission(params.missionId, {
      planId,
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    await this.completeDurably({
      missionId: params.missionId,
      planId,
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
    const turnId = options?.turnId || crypto.randomUUID();
    // Validate a supplied run before replacing the mission's current
    // correlation. A stale request must not make later events inherit its IDs.
    await this.ensureRunIsCurrent(missionId, options?.runId);
    this.lifecycleByMission.set(missionId, { turnId, runId: options?.runId });
    await this.ensureTurnUserMessage(missionId, turnId, request, initialPlanId);
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

    let decision: OrchestratorDecision;
    let hasPriorConversation: boolean;
    let priorResearchBundle: ResearchContextBundle | null;
    try {
      ({ decision, hasPriorConversation, priorResearchBundle } = await this.decideTurn(missionId, turnId, request, options));
    } catch (error) {
      if (!this.isRunFenceError(error)) {
        await this.transitionMissionDiagnostic({
          missionId,
          status: 'failed',
          reason: `Supervisor pre-dispatch decision failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      throw error;
    }
    await this.ensureRunIsCurrent(missionId, options?.runId);
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
      await this.ensureRunIsCurrent(missionId, options?.runId);
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
      await this.ensureRunIsCurrent(missionId, options?.runId);
      try {
        return await this.createPlanOnlyTurn({
          missionId,
          turnId,
          request,
          decision,
          previousPlanId,
          hasPriorConversation,
          agentProfileIds: options?.agentProfileIds,
        });
      } catch (error) {
        if (!this.isRunFenceError(error)) {
          await this.transitionMissionDiagnostic({
            missionId,
            status: 'failed',
            reason: `Plan-only pre-dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        throw error;
      }
    }

    let taskPlan: StructuredTaskPlan[];
    try {
      taskPlan = decisionToTaskPlan(decision).map((task) => task.role === 'builder' && priorResearchBundle
        ? {
            ...task,
            description: `${task.description}\n\n${RESEARCH_CONTEXT_START}\nReuse this completed research from prior plan ${priorResearchBundle.planId}. Preserve provenance and verify conflicts/uncertainty:\n${JSON.stringify(priorResearchBundle)}\n${RESEARCH_CONTEXT_END}`,
          }
        : task);
    } catch (error) {
      await this.transitionMissionDiagnostic({
        missionId,
        status: 'failed',
        reason: `Execution plan could not be normalized before dispatch: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
    const normalizedPlanId = crypto.randomUUID();
    const lifecycle = this.lifecycleByMission.get(missionId);
    this.trace('plan-normalized', {
      missionId,
      turnId,
      runId: lifecycle?.runId,
      planId: normalizedPlanId,
      action: decision.action,
      taskCount: taskPlan.length,
      tasks: this.planTraceDetails(taskPlan),
    });
    const rawModelPlanOutput = JSON.stringify({
      planId: normalizedPlanId,
      assumptions: [
        `Persistent Orchestrator decision: ${decision.action}.`,
        decision.response || 'Delegations were generated from the current conversation context.',
        ...(priorResearchBundle ? [`Plan lineage: reuse completed research from prior plan ${priorResearchBundle.planId} in this same-conversation follow-up.`] : []),
      ],
      questions: decision.clarifyingQuestions || [],
      tasks: taskPlan,
    });
    let result;
    try {
      await this.ensureRunIsCurrent(missionId, options?.runId);
      result = await super.startMission(missionId, request, {
        ...options,
        rawModelPlanOutput,
        researchContextPlanId: priorResearchBundle?.planId,
      });
      await this.ensureRunIsCurrent(missionId, options?.runId);
    } catch (error) {
      await this.preserveCancelledRunFence(missionId, options?.runId);
      if (!this.isRunFenceError(error)) {
        await this.transitionMissionDiagnostic({
          missionId,
          status: 'failed',
          reason: `Execution pre-dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      throw error;
    }
    this.planActions.set(result.planId, decision.action);
    const materializedTasks = (await manager.listTasks(missionId)).filter((task) => task.planId === result.planId);
    this.trace('plan-materialized', {
      missionId,
      turnId,
      runId: lifecycle?.runId,
      planId: result.planId,
      action: decision.action,
      tasks: (materializedTasks.length > 0 ? materializedTasks : result.tasks).map((task) => this.taskTraceDetails(task)),
    });
    return result;
  }

  private async emitQualityTaskCompleted(
    event: TaskCompleted,
    task: TaskSelect,
    wasTerminal: boolean,
    verdict = inferQualityVerdict(task.assignedRole, event.result),
  ): Promise<QualityVerdict | null> {
    if (wasTerminal || !verdict) return null;

    const lifecycle = this.lifecycleByMission.get(event.missionId);
    const correlation = {
      turnId: event.turnId || lifecycle?.turnId,
      runId: event.runId || lifecycle?.runId,
    };
    const agentInstanceId = event.agentInstanceId || task.assignedAgentId || undefined;

    if (task.assignedRole === 'reviewer') {
      await this.assertMissionActionCurrent(event.missionId, correlation.runId);
      if (this.v2WorkspaceManager) await this.v2WorkspaceManager.updateMission(event.missionId, { status: 'reviewing' });
      await this.assertMissionActionCurrent(event.missionId, correlation.runId);
      this.emitEvent({
        id: crypto.randomUUID(),
        type: 'review_completed',
        missionId: event.missionId,
        ...correlation,
        taskId: task.id,
        reviewerAgentId: agentInstanceId || 'reviewer',
        approved: verdict.passed,
        findings: verdict.summary,
        timestamp: new Date().toISOString(),
      });
      this.trace('review-completed', {
        missionId: event.missionId,
        turnId: correlation.turnId,
        runId: correlation.runId,
        planId: task.planId,
        taskId: task.id,
        agentInstanceId: agentInstanceId || null,
        approved: verdict.passed,
        verdict: verdict.reason,
      });
      return verdict;
    }

    if (task.assignedRole === 'qa') {
      await this.assertMissionActionCurrent(event.missionId, correlation.runId);
      if (this.v2WorkspaceManager) await this.v2WorkspaceManager.updateMission(event.missionId, { status: 'verifying' });
      await this.assertMissionActionCurrent(event.missionId, correlation.runId);
      this.emitEvent({
        id: crypto.randomUUID(),
        type: 'verification_completed',
        missionId: event.missionId,
        ...correlation,
        taskId: task.id,
        reviewerAgentId: agentInstanceId,
        passed: verdict.passed,
        findingCount: verdict.findingCount,
        summary: verdict.summary,
        timestamp: new Date().toISOString(),
      });
      this.trace('qa-completed', {
        missionId: event.missionId,
        turnId: correlation.turnId,
        runId: correlation.runId,
        planId: task.planId,
        taskId: task.id,
        agentInstanceId: agentInstanceId || null,
        passed: verdict.passed,
        verdict: verdict.reason,
      });
      return verdict;
    }

    return null;
  }

  private async stopAfterQualityFailure(
    event: TaskCompleted,
    task: TaskSelect,
    verdict: QualityVerdict,
  ): Promise<void> {
    if (this.v2WorkspaceManager) {
      const now = new Date().toISOString();
      // mission_failed is a terminal event. Persist the same terminal semantic
      // so the durable mission cannot remain blocked while the UI observes it
      // as failed. Rejected gate tasks retain the existing retry/revision path.
      await this.v2WorkspaceManager.updateMission(event.missionId, { status: 'failed', completedAt: now });
      const planTasks = await this.v2WorkspaceManager.listTasks(event.missionId);
      const cancelledTaskIds: string[] = [];
      for (const planTask of planTasks.filter((candidate) => candidate.planId === task.planId)) {
        if (TASK_COMPLETION_FENCE_STATUSES.has(String(planTask.status))) continue;
        await this.v2WorkspaceManager.updateTask(planTask.id, { status: 'cancelled', completedAt: now });
        cancelledTaskIds.push(planTask.id);
      }
      this.trace('quality-gate-cancelled-siblings', {
        missionId: event.missionId,
        planId: task.planId,
        taskIds: cancelledTaskIds,
      });
    }
    this.emitMissionFailed({
      missionId: event.missionId,
      reason: `${task.assignedRole === 'reviewer' ? 'Reviewer' : 'QA'} quality gate failed: ${verdict.summary}`,
      failedTaskId: task.id,
    });
    this.trace('quality-gate-failed', {
      missionId: event.missionId,
      turnId: event.turnId || this.lifecycleByMission.get(event.missionId)?.turnId,
      runId: event.runId || this.lifecycleByMission.get(event.missionId)?.runId,
      planId: task.planId,
      taskId: task.id,
      role: task.assignedRole,
      verdict: verdict.reason,
    });
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
    const steering = this.pendingSteers.get(missionId) || [];
    this.pendingSteers.delete(missionId);
    const bundle = await this.getResearchBundle(missionId, planId);
    const activeTurnId = this.lifecycleByMission.get(missionId)?.turnId;
    const activeTurn = this.v2Db && activeTurnId
      ? (await this.v2Db.select({ content: conversationTurns.content }).from(conversationTurns)
        .where(eq(conversationTurns.id, activeTurnId)))[0]?.content
      : undefined;
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
          activeTurn ? `\nCurrent user turn (must be answered):\n${activeTurn}` : '',
          bundle ? `\nDurable research context bundle:\n${JSON.stringify(bundle)}` : '',
          steering.length ? `\nUser steering received during execution:\n${steering.join('\n')}` : '',
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
    if (TASK_COMPLETION_FENCE_STATUSES.has(String(task.status))) {
      this.trace('late-task-completion-ignored', {
        missionId: event.missionId,
        taskId: task.id,
        status: task.status,
        eventRunId: event.runId,
      });
      return;
    }
    const verdict = inferQualityVerdict(task.assignedRole, event.result);
    await this.assertTaskCompletionCurrent(event);
    await manager.updateTask(task.id, {
      status: verdict && !verdict.passed ? 'rejected' : 'done',
      completedAt: new Date().toISOString(),
    });
    if (task.assignedRole === 'researcher') {
      task.status = 'done';
      await this.refreshResearchBundle(event.missionId, task.planId, planTasks, { taskId: task.id, result: event.result || '' });
    }
    await this.assertTaskCompletionCurrent(event);
    const emittedVerdict = await this.emitQualityTaskCompleted(event, task, false, verdict);
    if (emittedVerdict && !emittedVerdict.passed) {
      await this.stopAfterQualityFailure(event, task, emittedVerdict);
      return;
    }
    const latestTasks = (await manager.listTasks(event.missionId)).filter((item) => item.planId === task.planId);
    const allTerminal = latestTasks.length > 0 && latestTasks.every((item) => TERMINAL_TASK_STATUSES.has(String(item.status)));
    if (!allTerminal) {
      await this.reconcileMissionPlanUnlocked(event.missionId, task.planId);
      return;
    }

    if (this.synthesizedPlans.has(this.completionKey(event.missionId, task.planId))) return;
    await this.assertTaskCompletionCurrent(event);
    await manager.updateMission(event.missionId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    await this.completeWithSynthesis({
      missionId: event.missionId,
      planId: task.planId,
      latestResult: event.result,
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
      const correlatedEvent = await this.correlateRunlessTerminalEvent(event);
      if (!correlatedEvent) {
        this.trace('uncorrelated-terminal-event-ignored', {
          missionId: event.missionId,
          taskId: event.taskId,
          type: event.type,
          agentInstanceId: event.agentInstanceId,
        });
        return;
      }
      event = correlatedEvent;
      const currentMission = await manager.getMission(event.missionId);
      if (!currentMission || TERMINAL_MISSION_STATUSES.has(String(currentMission.status))) {
        this.trace('terminal-mission-completion-ignored', { missionId: event.missionId, status: currentMission?.status || 'missing', taskId: event.taskId });
        return;
      }
      if (currentMission.status === 'blocked') {
        this.trace('blocked-mission-completion-ignored', { missionId: event.missionId, taskId: event.taskId });
        return;
      }
      const lifecycle = this.lifecycleByMission.get(event.missionId);
      const currentRunId = currentMission.activeRunId || lifecycle?.runId || undefined;
      if ((event.runId && this.cancelledRunIds.has(event.runId))
        || (currentRunId && this.cancelledRunIds.has(currentRunId))) {
        this.trace('cancelled-run-completion-ignored', {
          missionId: event.missionId,
          taskId: event.taskId,
          eventRunId: event.runId,
          currentRunId,
        });
        return;
      }
      if (event.runId && currentRunId && event.runId !== currentRunId) {
        this.trace('stale-run-completion-ignored', {
          missionId: event.missionId,
          taskId: event.taskId,
          eventRunId: event.runId,
          currentRunId,
        });
        return;
      }
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

      if (TASK_COMPLETION_FENCE_STATUSES.has(String(task.status))) {
        this.trace('late-task-completion-ignored', {
          missionId: event.missionId,
          taskId: task.id,
          status: task.status,
          eventRunId: event.runId,
          currentRunId,
        });
        return;
      }

      if (currentMission?.planId && task.planId !== currentMission.planId) {
        this.trace('stale-plan-completion-ignored', { missionId: event.missionId, taskId: task.id, taskPlanId: task.planId, activePlanId: currentMission.planId });
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
      const verdict = inferQualityVerdict(task.assignedRole, event.result);
      await this.assertTaskCompletionCurrent(event);
      await manager.updateTask(task.id, {
        status: verdict && !verdict.passed ? 'rejected' : 'done',
        completedAt: new Date().toISOString(),
      });
      if (task.assignedRole === 'researcher') {
        task.status = 'done';
        await this.refreshResearchBundle(event.missionId, task.planId, planTasks, { taskId: task.id, result: event.result || '' });
      }
      await this.assertTaskCompletionCurrent(event);
      const emittedVerdict = await this.emitQualityTaskCompleted(event, task, false, verdict);
      if (emittedVerdict && !emittedVerdict.passed) {
        await this.stopAfterQualityFailure(event, task, emittedVerdict);
        return;
      }

      let legacyError: unknown;
      const suppressLegacyReview = task.assignedRole === 'reviewer' || task.assignedRole === 'qa';
      this.deferredCompletionMissions.add(event.missionId);
      if (suppressLegacyReview) this.suppressedLegacyReviewEvents.add(event.missionId);
      try {
        await this.assertTaskCompletionCurrent(event);
        await super.handleTaskCompleted(canonicalEvent);
      } catch (error) {
        legacyError = error;
        this.trace('legacy-completion-handler-rejected', {
          missionId: event.missionId,
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.deferredCompletionMissions.delete(event.missionId);
        if (suppressLegacyReview) this.suppressedLegacyReviewEvents.delete(event.missionId);
      }

      const latestTask = await manager.getTask(task.id);
      if (!(await this.canPublishCompletion(event.missionId))) return;
      await this.reconcileMissionPlanUnlocked(event.missionId, latestTask?.planId || task.planId || null);

      const mission = await manager.getMission(event.missionId);
      if (mission?.status === 'completed' && !this.synthesizedPlans.has(this.completionKey(event.missionId, task.planId))) {
        const deferred = this.deferredCompletions.get(event.missionId);
        this.deferredCompletions.delete(event.missionId);
        await this.completeWithSynthesis({
          missionId: event.missionId,
          planId: task.planId,
          latestResult: event.result,
          tasksCompleted: deferred?.tasksCompleted ?? planTasks.length,
          totalTasks: deferred?.totalTasks ?? planTasks.length,
        });
      }

      if (legacyError) throw legacyError;
    });
  }

  override async handleTaskFailed(event: TaskFailed): Promise<void> {
    if (!this.v2WorkspaceManager) {
      await super.handleTaskFailed(event);
      return;
    }

    await this.enqueueMission(event.missionId, async () => {
      const correlatedEvent = await this.correlateRunlessTerminalEvent(event);
      if (!correlatedEvent) {
        this.trace('uncorrelated-terminal-event-ignored', {
          missionId: event.missionId,
          taskId: event.taskId,
          type: event.type,
          agentInstanceId: event.agentInstanceId,
        });
        return;
      }
      await super.handleTaskFailed(correlatedEvent);
    });
  }

  private researchArtifactId(planId: string): string {
    return `research-context:${planId}`;
  }

  private async getResearchBundle(missionId: string, planId: string): Promise<ResearchContextBundle | null> {
    if (!this.v2Db) return null;
    const row = (await this.v2Db.select({ content: artifacts.content }).from(artifacts)
      .where(eq(artifacts.id, this.researchArtifactId(planId))))[0];
    if (!row?.content) return null;
    try {
      return JSON.parse(row.content) as ResearchContextBundle;
    } catch {
      return null;
    }
  }

  protected async getLatestResearchBundle(missionId: string): Promise<ResearchContextBundle | null> {
    if (!this.v2Db || !this.v2WorkspaceManager) return null;
    const rows = await this.v2Db.select({ content: artifacts.content, createdAt: artifacts.createdAt }).from(artifacts)
      .where(and(eq(artifacts.missionId, missionId), eq(artifacts.type, 'research')));
    const missionTasks = await this.v2WorkspaceManager.listTasks(missionId);
    const runs = await this.v2Db.select({ planId: missionRuns.planId, status: missionRuns.status }).from(missionRuns)
      .where(eq(missionRuns.missionId, missionId));
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const row of rows) {
      if (!row.content) continue;
      try {
        const bundle = JSON.parse(row.content) as ResearchContextBundle;
        const researchers = missionTasks.filter((task) => task.planId === bundle.planId && task.assignedRole === 'researcher');
        const runCompleted = runs.some((run) => run.planId === bundle.planId && run.status === 'completed');
        const runFailed = runs.some((run) => run.planId === bundle.planId && (run.status === 'failed' || run.status === 'cancelled'));
        if (bundle.missionId === missionId && bundle.complete === true && bundle.sources?.length
          && researchers.length > 0 && researchers.every((task) => task.status === 'done' && bundle.sourceTaskIds.includes(task.id))
          && runCompleted && !runFailed) return bundle;
      } catch {
        // Ignore malformed or incomplete artifacts and continue to the next durable bundle.
      }
    }
    return null;
  }

  private async refreshResearchBundle(
    missionId: string,
    planId: string,
    planTasks: TaskSelect[],
    completed?: { taskId: string; result: string },
  ): Promise<ResearchContextBundle | null> {
    if (!this.v2Db) return null;
    const researchers = planTasks.filter((task) => task.assignedRole === 'researcher' && task.status === 'done');
    if (researchers.length === 0 && !completed) return null;
    const existing = await this.getResearchBundle(missionId, planId);
    const byTask = new Map((existing?.sources || []).map((source) => [source.taskId, source]));
    for (const task of researchers) {
      const attempts = await this.v2Db.select().from(taskAttempts).where(eq(taskAttempts.taskId, task.id));
      const attempt = attempts.filter((item) => item.status === 'completed' && item.resultSummary)
        .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
      const completionEvents = attempt?.resultSummary ? [] : await this.v2Db.select({ payload: missionEvents.payload })
        .from(missionEvents).where(and(eq(missionEvents.taskId, task.id), eq(missionEvents.type, 'task_completed')));
      const eventResult = completionEvents.map((item) => item.payload as Record<string, unknown>)
        .map((payload) => payload.result).filter((result): result is string => typeof result === 'string').at(-1);
      const raw = completed?.taskId === task.id ? completed.result : attempt?.resultSummary || eventResult;
      if (!raw) continue;
      const result = String(redactSensitiveValue(raw)).trim().slice(0, MAX_RESEARCH_SOURCE_CHARS);
      byTask.set(task.id, {
        taskId: task.id,
        ...(attempt?.id ? { attemptId: attempt.id } : {}),
        result,
        uncertain: /\b(?:uncertain|unknown|unclear|inconclusive|may|might|possibly|not verified)\b/i.test(result),
      });
    }
    if (completed && !byTask.has(completed.taskId)) {
      const result = String(redactSensitiveValue(completed.result)).trim().slice(0, MAX_RESEARCH_SOURCE_CHARS);
      byTask.set(completed.taskId, {
        taskId: completed.taskId,
        result,
        uncertain: /\b(?:uncertain|unknown|unclear|inconclusive|may|might|possibly|not verified)\b/i.test(result),
      });
    }
    const sources = [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
    const requiredResearchers = planTasks.filter((task) => task.assignedRole === 'researcher');
    const complete = requiredResearchers.length > 0
      && requiredResearchers.every((task) => task.status === 'done' && byTask.has(task.id));
    const positive = sources.filter((source) => /\b(?:yes|supported|exists|confirmed|verified)\b/i.test(source.result));
    const negative = sources.filter((source) => /\b(?:no|not supported|does not exist|absent|disproved)\b/i.test(source.result));
    const bundle: ResearchContextBundle = {
      version: 1,
      missionId,
      planId,
      complete,
      sourceTaskIds: sources.map((source) => source.taskId),
      sources,
      findings: sources.map((source) => source.result),
      evidence: sources.map((source) => ({ taskId: source.taskId, ...(source.attemptId ? { attemptId: source.attemptId } : {}) })),
      conflicts: positive.length && negative.length
        ? ['Research sources contain potentially conflicting positive and negative conclusions; Builder must verify before choosing.']
        : [],
      uncertainties: sources.filter((source) => source.uncertain).map((source) => `Uncertainty reported by research task ${source.taskId}.`),
      truncated: sources.some((source) => source.result.length === MAX_RESEARCH_SOURCE_CHARS),
    };
    let content = JSON.stringify(bundle);
    if (content.length > MAX_RESEARCH_BUNDLE_CHARS) {
      bundle.truncated = true;
      while (bundle.sources.length > 1 && JSON.stringify(bundle).length > MAX_RESEARCH_BUNDLE_CHARS) bundle.sources.pop();
      bundle.sourceTaskIds = bundle.sources.map((source) => source.taskId);
      bundle.findings = bundle.sources.map((source) => source.result);
      bundle.evidence = bundle.sources.map((source) => ({ taskId: source.taskId, ...(source.attemptId ? { attemptId: source.attemptId } : {}) }));
      bundle.uncertainties = bundle.sources.filter((source) => source.uncertain).map((source) => `Uncertainty reported by research task ${source.taskId}.`);
      content = JSON.stringify(bundle);
    }
    const lifecycle = this.lifecycleByMission.get(missionId);
    if (existing) {
      await this.v2Db.update(artifacts).set({ content, sizeBytes: Buffer.byteLength(content) })
        .where(eq(artifacts.id, this.researchArtifactId(planId)));
    } else {
      await this.v2Db.insert(artifacts).values({
        id: this.researchArtifactId(planId), missionId, taskId: null, runId: lifecycle?.runId || null,
        type: 'research', name: 'Research context bundle', path: null, content,
        sizeBytes: Buffer.byteLength(content), createdAt: new Date().toISOString(),
      });
    }

    const byId = new Map(planTasks.map((task) => [task.id, task]));
    const upstreamResearchers = (task: TaskSelect): Set<string> => {
      const found = new Set<string>();
      const visit = (id: string) => {
        const dependency = byId.get(id);
        if (!dependency || found.has(id)) return;
        if (dependency.assignedRole === 'researcher') found.add(id);
        for (const parent of (dependency.dependsOn as string[]) || []) visit(parent);
      };
      for (const id of (task.dependsOn as string[]) || []) visit(id);
      return found;
    };
    for (const builder of planTasks.filter((task) => task.assignedRole === 'builder' && (task.status === 'planned' || task.status === 'ready'))) {
      const upstream = upstreamResearchers(builder);
      const exactBundle = { ...bundle, sourceTaskIds: bundle.sourceTaskIds.filter((id) => upstream.has(id)), sources: bundle.sources.filter((source) => upstream.has(source.taskId)) };
      if (exactBundle.sources.length === 0) continue;
      const base = builder.description.split(RESEARCH_CONTEXT_START)[0].trimEnd();
      const description = `${base}\n\n${RESEARCH_CONTEXT_START}\nUse this exact completed upstream research context. Preserve provenance and verify conflicts/uncertainty:\n${JSON.stringify(exactBundle)}\n${RESEARCH_CONTEXT_END}`;
      if (description !== builder.description) {
        await this.v2WorkspaceManager!.updateTask(builder.id, { description });
        builder.description = description;
      }
    }
    return bundle;
  }

  private async applyApprovedChanges(
    missionId: string,
    options?: { operationId?: string; idempotencyKey?: string },
  ): Promise<void> {
    const manager = this.v2WorkspaceManager;
    const applyTaskChanges = this.v2ApplyTaskChanges;
    if (!manager || !applyTaskChanges) throw new Error('No deterministic apply coordinator is configured.');

    const lifecycle = this.lifecycleByMission.get(missionId);
    const runId = lifecycle?.runId;
    const mission = await this.assertMissionActionCurrent(missionId, runId);
    if (!mission.planId) throw new Error('Changes cannot be applied without an active plan.');

    const tasks = (await manager.listTasks(missionId)).filter((task) => task.planId === mission.planId);
    const resumingVerification = mission.status === 'verifying';
    const incomplete = tasks.filter((task) => task.status !== 'done');
    if (incomplete.length > 0) throw new Error('Changes cannot be applied while mission tasks are incomplete.');
    const reviewerDone = tasks.some((task) => task.assignedRole === 'reviewer' && task.status === 'done');
    const qaTasks = tasks.filter((task) => task.assignedRole === 'qa');
    if (!reviewerDone || !qaTasks.every((task) => task.status === 'done')) {
      throw new Error('Reviewer and configured QA quality gates must pass before apply.');
    }

    const builderTaskIds = tasks.filter((item) => item.assignedRole === 'builder' && item.status === 'done').map((item) => item.id);
    let operationVerification;
    if (this.v2ExecuteApplyVerificationOperation) {
      if (!resumingVerification) await manager.updateMission(missionId, { status: 'applying' });
      operationVerification = await this.v2ExecuteApplyVerificationOperation({ missionId, planId: mission.planId, runId, builderTaskIds });
      for (const taskId of operationVerification.appliedTaskIds) this.emitEvent({
        id: `changes-applied:${operationVerification.operationId}:${taskId}`,
        type: 'changes_applied', missionId, taskId, filesChanged: 0, checkpointId: '', timestamp: new Date().toISOString(),
      });
    } else {
    if (!resumingVerification) await manager.updateMission(missionId, { status: 'applying' });
    for (const task of resumingVerification ? [] : tasks.filter((item) => item.assignedRole === 'builder' && item.status === 'done')) {
      await this.assertMissionActionCurrent(missionId, runId);
      const operation = options?.operationId || options?.idempotencyKey
        ? {
          operationId: options.operationId,
          idempotencyKey: options.idempotencyKey
            ? `${options.idempotencyKey}:task:${task.id}`
            : undefined,
        }
        : undefined;
      const result = await applyTaskChanges(task.id, operation);
      await this.assertMissionActionCurrent(missionId, runId);
      if (!result.success) {
        await manager.updateMission(missionId, { status: 'blocked' });
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
    }

    await this.assertMissionActionCurrent(missionId, runId);
    await manager.updateMission(missionId, { status: 'verifying' });
    const verificationTaskId = `post-apply:${mission.planId}`;
    this.emitEvent({
      id: crypto.randomUUID(), type: 'verification_started', missionId, ...lifecycle,
      taskId: verificationTaskId, timestamp: new Date().toISOString(),
    });
    if (!operationVerification && !this.v2PostApplyVerification) {
      this.trace('post-apply-verification-pending', { missionId, planId: mission.planId, runId, builderTaskIds });
      return;
    }
    let verification: PostApplyVerificationResult | undefined = operationVerification;
    try {
      verification ||= await this.v2PostApplyVerification!({ missionId, planId: mission.planId, runId, builderTaskIds });
    } catch (error) {
      await manager.updateMission(missionId, { status: 'blocked', completedAt: null });
      throw error;
    }
    if (!verification) throw new Error('Post-apply verification did not return a result.');
    await this.assertMissionActionCurrent(missionId, runId);
    const summary = typeof verification.summary === 'string'
      ? String(redactSensitiveValue(verification.summary)).slice(0, MAX_QUALITY_SUMMARY_CHARS)
      : '';
    const evidenceItems = Array.isArray(verification.evidence)
      ? verification.evidence.filter((item: unknown): item is string => typeof item === 'string' && Boolean(item.trim()))
      : [];
    const evidence = evidenceItems.map((item: string) => String(redactSensitiveValue(item))).join('\n').slice(0, MAX_QUALITY_SUMMARY_CHARS);
    const verificationSummary = [summary, evidence].filter(Boolean).join('\n');
    this.emitEvent({
      id: crypto.randomUUID(), type: 'verification_completed', missionId, ...lifecycle,
      taskId: verificationTaskId, passed: verification.passed,
      findingCount: verification.passed ? 0 : 1, summary: verificationSummary,
      timestamp: new Date().toISOString(),
    });
    if (verification.passed !== true || !summary || evidenceItems.length === 0) {
      await manager.updateMission(missionId, { status: 'blocked', completedAt: null });
      throw new Error(verificationSummary || 'Post-apply verification failed or returned no evidence.');
    }
    await this.completeWithSynthesis({
      missionId,
      planId: mission.planId,
      tasksCompleted: tasks.length,
      totalTasks: tasks.length,
      latestResult: `Post-apply verification passed against the base workspace.\n${verificationSummary}`,
    }, async () => {
      await this.assertMissionActionCurrent(missionId, runId);
      await manager.updateMission(missionId, { status: 'completed', completedAt: new Date().toISOString() });
    });
  }

  async retryPostApplyVerification(missionId: string): Promise<void> {
    const manager = this.v2WorkspaceManager;
    if (!manager) throw new Error('No workspace manager is configured.');
    await this.enqueueMission(missionId, async () => {
      const mission = await manager.getMission(missionId);
      if (!mission || !mission.planId) throw new Error('Mission with an active plan was not found.');
      if (mission.status === 'completed') return;
      if (mission.status !== 'blocked' && mission.status !== 'verifying') {
        throw new Error('Mission is not waiting for post-apply verification.');
      }
      await manager.updateMission(missionId, { status: 'verifying', completedAt: null });
      await this.applyApprovedChanges(missionId);
    });
  }

  override async handleApprovalDecision(
    missionId: string,
    approvalType: string,
    approved: boolean,
    options?: {
      selectedCandidateId?: string;
      reason?: string;
      operationId?: string;
      idempotencyKey?: string;
    },
  ): Promise<void> {
    if (approvalType === 'plan' && approved) {
      const mission = await this.v2WorkspaceManager?.getMission(missionId);
      if (mission?.planId && this.planActions.get(mission.planId) === 'plan_only') {
        // A plan-only turn becomes a normal execution turn only after the
        // existing Chat approval gate is accepted. Without this transition,
        // later completion reconciliation still treats the approved plan as a
        // read-only preview.
        this.planActions.set(mission.planId, 'execute');
      }
    }

    if (approvalType !== 'apply' || !approved) {
      await super.handleApprovalDecision(missionId, approvalType, approved, options);
      return;
    }

    await this.enqueueMission(missionId, () => this.applyApprovedChanges(missionId, options));
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
        if (this.synthesizedPlans.has(this.completionKey(missionId, planId))) return true;
        await manager.updateMission(missionId, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        await this.completeWithSynthesis({
          missionId,
          planId,
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
    try {
      await this.reconcileMissionPlanCore(missionId, requestedPlanId);
    } catch (error) {
      if (!this.isRunFenceError(error)) {
        await this.transitionMissionDiagnostic({
          missionId,
          status: 'failed',
          reason: `Mission reconciliation failed before dispatch could complete: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      throw error;
    }
  }

  private async reconcileMissionPlanCore(missionId: string, requestedPlanId?: string | null): Promise<void> {
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
    await this.refreshResearchBundle(missionId, planId || planTasks[0].planId, planTasks);

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

    const lifecycle = this.lifecycleByMission.get(missionId);
    this.trace('plan-reconciled', {
      missionId,
      turnId: lifecycle?.turnId,
      runId: lifecycle?.runId,
      planId,
      missionStatus: mission.status,
      tasks: planTasks.map((task) => this.taskTraceDetails(task)),
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

    const completedTaskIds = planTasks
      .filter((task) => TERMINAL_TASK_STATUSES.has(String(task.status)))
      .map((task) => task.id);
    const runningWorkers = planTasks
      .filter((task) => ACTIVE_TASK_STATUSES.has(String(task.status)) && task.assignedRole)
      .map((task) => ({ role: task.assignedRole!, delegationId: task.id }));
    const allocation = allocateWorkerBatch({
      delegations: ready
        .flatMap((task) => isSchedulableWorkerRole(task.assignedRole)
          ? [{
            id: task.id,
            role: task.assignedRole,
            objective: task.description,
            requiredCapabilities: task.requiredCapabilities || [],
            dependsOnDelegationIds: ((task.dependsOn as string[]) || []),
          }]
          : []),
      completedDelegationIds: completedTaskIds,
      runningWorkers,
      policy: await manager.resolveMissionWorkerPoolPolicy(missionId),
    });
    const dispatchableTaskIds = new Set(allocation.dispatchable.map((delegation) => delegation.id));
    if (allocation.deferred.length > 0) {
      this.trace('worker-capacity-deferred', {
        missionId,
        planId,
        readyTaskIds: ready.map((task) => task.id),
        deferred: allocation.deferred.map((item) => ({ taskId: item.delegation.id, reason: item.reason })),
      });
    }

    for (const task of ready) {
      if (!dispatchableTaskIds.has(task.id)) continue;
      const latest = await manager.getTask(task.id);
      if (!latest || (latest.status !== 'planned' && latest.status !== 'ready')) continue;
      if (latest.status === 'planned') {
        await manager.updateTask(latest.id, { status: 'ready' });
      }
      await this.assignTask(latest.id, latest.assignedRole ?? undefined);
    }
  }
}

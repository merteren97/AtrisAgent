import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AtrisDatabase, TaskSelect } from '@atris-agent-code/database';
import { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import type { TaskCompleted } from '@atris-agent-code/event-schema';
import { Orchestrator as LegacyOrchestrator } from './orchestrator';
import type { OrchestratorConfig } from './orchestrator';

const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_TASK_STATUSES = new Set(['done', 'superseded']);
const SCHEDULABLE_MISSION_STATUSES = new Set(['ready', 'running', 'revising']);

/**
 * Phase 1 of the Orchestrator v2 migration.
 *
 * The existing Orchestrator remains the execution engine while this wrapper adds
 * a deterministic reconciliation boundary around task-completion handoffs.
 * LocalEventBus deliberately delivers async subscribers fire-and-forget; a raw
 * task_completed event can therefore be visible in the UI even when the
 * Orchestrator subscriber later rejects. The legacy implementation also fences
 * a runtime attempt before the state transition finishes, which means a second
 * terminal envelope can be ignored after the first handler failed.
 *
 * OrchestratorV2 fixes that failure mode without destabilising the current
 * execution state machine:
 * - terminal completion handling is serialized per mission;
 * - the persisted task is resolved by task id, with agent-instance correlation
 *   as a recovery path;
 * - the task is durably marked done before the legacy transition runs;
 * - the active plan is reconciled after every completion, even when the legacy
 *   handler returned early because it had already fenced the runtime attempt;
 * - reconciliation is idempotent because only planned/ready tasks are dispatched.
 *
 * Later phases will move planning, turn routing, dynamic worker allocation and
 * memory retrieval into this class. Keeping Phase 1 narrow makes the Task 1 ->
 * Task 2 reliability fix independently testable.
 */
export class OrchestratorV2 extends LegacyOrchestrator {
  private readonly v2WorkspaceManager?: WorkspaceManager;
  private readonly missionQueues = new Map<string, Promise<void>>();

  constructor(
    config: OrchestratorConfig,
    eventBus?: LocalEventBus,
    db?: AtrisDatabase,
    workspaceManager?: WorkspaceManager,
  ) {
    super(config, eventBus, db, workspaceManager);
    this.v2WorkspaceManager = workspaceManager
      ?? config.workspaceManager
      ?? (db ? new WorkspaceManager(db, eventBus ?? config.eventBus) : undefined);
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
        // Preserve the legacy error/reporting behaviour when no safe recovery
        // correlation exists.
        await super.handleTaskCompleted(event);
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

      const canonicalEvent: TaskCompleted = task.id === event.taskId
        ? event
        : { ...event, taskId: task.id };

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

      if (legacyError) throw legacyError;
    });
  }

  /**
   * Public recovery hook used by tests today and by the control plane in the next
   * phase. Calling it repeatedly is safe: once a task is running it is no longer
   * eligible for dispatch.
   */
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
      const dependencies = (task.dependsOn as string[] | undefined) || [];
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
        waitingFor: ((task.dependsOn as string[] | undefined) || []).filter((dependencyId) => {
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

    if (ready.length === 0) return;

    // Candidate mode requires an explicit winner before QA can run. Preserve the
    // legacy gate when reconciliation is recovering a missed handoff.
    const candidateBuilders = planTasks.filter(
      (task) => task.assignedRole === 'builder' && task.title.includes('(Candidate'),
    );
    const candidateResolved = candidateBuilders.length > 1
      && candidateBuilders.some((task) => task.status === 'superseded');
    const candidateSelectionPending = mission.executionMode === 'candidate'
      && candidateBuilders.length > 1
      && !candidateResolved;

    for (const task of ready) {
      if (candidateSelectionPending && task.assignedRole === 'qa') {
        this.trace('candidate-gate-blocked-qa', { missionId, planId, taskId: task.id });
        continue;
      }

      // Re-read immediately before dispatch. This makes repeated reconciliation
      // calls and near-simultaneous terminal events converge on one task attempt.
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

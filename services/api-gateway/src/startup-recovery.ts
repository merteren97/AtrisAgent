import type Database from 'better-sqlite3';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { OrchestratorV3 } from '@atris-agent-code/orchestration-core';
import type { RuntimeHost } from '@atris-agent-code/runtime-host';
import type { ApplyVerificationOperationStore } from './apply-verification-operation';
import type { ApprovalOutbox } from './approval-outbox';
import type { DeletionOperation, DeletionOperationStore } from './deletion-operation';
import type { LiveProjectChanges } from './live-project-changes';

export interface StartupRecoverySyncContext {
  recoveredAt: string;
  deletingMissionIds: Set<string>;
  pendingDeletions: ReturnType<DeletionOperationStore['listIncomplete']>;
}

export interface StartupRecoveryDeps {
  sqlite: Database.Database;
  liveProjectChanges: LiveProjectChanges;
  deletionStore: DeletionOperationStore;
  deletionMissionIds: (operation: DeletionOperation) => string[];
  fenceDeletionMission: (missionId: string, stoppedAt: string) => void;
  applyVerificationStore: ApplyVerificationOperationStore;
  approvalOutbox: ApprovalOutbox;
  runtimeHost: RuntimeHost;
  orchestrator: OrchestratorV3;
  eventBus: LocalEventBus;
  isPostApplyVerificationPending: (missionId: string) => boolean;
  drainMissionCommands: (missionId: string) => Promise<void>;
  scheduleDeletion: (operation: DeletionOperation) => void;
  startupAbortSignal: AbortSignal;
  isShuttingDown: () => boolean;
}

async function runWithAbortTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error(`Startup recovery aborted before ${label}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Startup recovery timed out (${timeoutMs}ms) during ${label}`)), timeoutMs);
        timer.unref?.();
        if (signal) {
          onAbort = () => reject(new Error(`Startup recovery aborted during ${label}`));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createStartupRecovery(deps: StartupRecoveryDeps) {
  const {
    sqlite,
    liveProjectChanges,
    deletionStore,
    deletionMissionIds,
    fenceDeletionMission,
    applyVerificationStore,
    approvalOutbox,
    runtimeHost,
    orchestrator,
    eventBus,
    isPostApplyVerificationPending,
    drainMissionCommands,
    scheduleDeletion,
    startupAbortSignal,
    isShuttingDown,
  } = deps;

  function recoverGatewayStartupSync(): StartupRecoverySyncContext {
    liveProjectChanges.resume();
    const recoveredAt = new Date().toISOString();
    deletionStore.recoverInterrupted();
    const pendingDeletions = deletionStore.listIncomplete();
    const deletingMissionIds = new Set(pendingDeletions.flatMap(deletionMissionIds));
    // Restore durable fences before any command/completion recovery, but keep
    // potentially large filesystem cleanup outside the sidecar readiness budget.
    for (const missionId of deletingMissionIds) fenceDeletionMission(missionId, recoveredAt);
    applyVerificationStore.recoverInterrupted();
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE mission_commands SET status = 'failed', processed_at = ?, error = COALESCE(error, 'Gateway restarted while command was starting') WHERE status = 'processing'")
        .run(recoveredAt);
      sqlite.prepare("UPDATE conversation_turns SET status = 'failed', completed_at = ? WHERE status IN ('starting', 'running')")
        .run(recoveredAt);
      sqlite.prepare("UPDATE mission_runs SET status = 'failed', completed_at = ?, heartbeat_at = ?, error = COALESCE(error, 'Gateway restarted before run completion') WHERE status IN ('starting', 'running', 'stopping')")
        .run(recoveredAt, recoveredAt);
      sqlite.prepare(`UPDATE missions SET active_run_id = NULL, status = CASE
          WHEN status IN ('planning', 'running', 'reviewing', 'revising') THEN 'ready' ELSE status END,
          completed_at = CASE WHEN status IN ('planning', 'running', 'reviewing', 'revising', 'verifying') THEN NULL ELSE completed_at END
        WHERE active_run_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM mission_runs WHERE mission_runs.id = missions.active_run_id
            AND mission_runs.status IN ('starting', 'running', 'stopping')
        )`).run();
    })();
    approvalOutbox.recoverInterrupted();
    return { recoveredAt, deletingMissionIds, pendingDeletions };
  }

  async function recoverGatewayStartupAsync(
    context: StartupRecoverySyncContext,
    options: { signal?: AbortSignal; perMissionTimeoutMs?: number } = {},
  ): Promise<void> {
    const signal = options.signal ?? startupAbortSignal;
    const timeoutMs = options.perMissionTimeoutMs ?? 15_000;
    const shouldStop = () => signal.aborted || isShuttingDown();
    if (shouldStop()) return;

    await runtimeHost.reconcileStartup(new Date(context.recoveredAt)).catch((error) => {
      console.warn('[API-Gateway] Runtime host startup reconciliation failed:', error);
    });
    if (shouldStop()) return;

    const expiredAttempts = sqlite.prepare(`SELECT id, mission_id, task_id, agent_instance_id, error
      FROM task_attempts WHERE status = 'expired' AND completed_at = ?`).all(context.recoveredAt) as Array<{
        id: string; mission_id: string; task_id: string; agent_instance_id: string; error: string | null;
      }>;
    for (const attempt of expiredAttempts) {
      if (shouldStop()) return;
      if (context.deletingMissionIds.has(attempt.mission_id)) continue;
      const failure = {
        id: `restart-${attempt.id}`,
        type: 'task_failed' as const,
        missionId: attempt.mission_id,
        taskId: attempt.task_id,
        agentInstanceId: attempt.agent_instance_id,
        error: attempt.error || 'Runtime host restarted before session completion was confirmed',
        timestamp: context.recoveredAt,
      };
      await runWithAbortTimeout(orchestrator.handleTaskFailed(failure), timeoutMs, `expired-attempt:${attempt.id}`, signal)
        .catch((error) => console.warn(`[API-Gateway] Failed expired attempt recovery for ${attempt.id}:`, error));
      eventBus.emit(failure);
    }
    if (shouldStop()) return;

    await runWithAbortTimeout(orchestrator.recoverPendingCompletions(), timeoutMs, 'recoverPendingCompletions', signal)
      .catch((error) => console.warn('[API-Gateway] Pending completion recovery failed:', error));
    if (shouldStop()) return;

    const activePlans = sqlite.prepare(`SELECT id, plan_id, status FROM missions
      WHERE status IN ('planning', 'ready', 'running', 'reviewing', 'revising', 'verifying', 'blocked') AND plan_id IS NOT NULL`)
      .all() as Array<{ id: string; plan_id: string; status: string }>;
    for (const mission of activePlans) {
      if (shouldStop()) return;
      if ((mission.status === 'verifying' || mission.status === 'blocked') && isPostApplyVerificationPending(mission.id)) {
        await runWithAbortTimeout(orchestrator.retryPostApplyVerification(mission.id), timeoutMs, `postApplyVerification:${mission.id}`, signal)
          .catch((error) => {
            console.warn(`[API-Gateway] Post-apply verification remains pending for mission ${mission.id}:`, error);
          });
      } else if (mission.status !== 'blocked') {
        await runWithAbortTimeout(orchestrator.reconcileMissionPlan(mission.id, mission.plan_id), timeoutMs, `reconcileMission:${mission.id}`, signal)
          .catch((error) => {
            console.warn(`[API-Gateway] Mission plan reconciliation failed for ${mission.id}:`, error);
          });
      }
    }
    if (shouldStop()) return;

    const pending = sqlite.prepare("SELECT DISTINCT mission_id FROM mission_commands WHERE status = 'pending'").all() as Array<{ mission_id: string }>;
    for (const row of pending) {
      if (shouldStop()) return;
      await runWithAbortTimeout(drainMissionCommands(row.mission_id), timeoutMs, `drainCommands:${row.mission_id}`, signal)
        .catch((error) => console.warn(`[API-Gateway] Command drain failed for ${row.mission_id}:`, error));
    }
    if (shouldStop()) return;
    for (const operation of context.pendingDeletions) scheduleDeletion(operation);
  }

  async function recoverGatewayStartup(): Promise<void> {
    const syncContext = recoverGatewayStartupSync();
    await recoverGatewayStartupAsync(syncContext, { signal: startupAbortSignal });
  }

  return {
    recoverGatewayStartupSync,
    recoverGatewayStartupAsync,
    recoverGatewayStartup,
  };
}

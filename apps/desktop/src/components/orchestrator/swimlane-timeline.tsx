import { GitBranch } from 'lucide-react';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import {
  formatDurationMs,
  resolveRuntimeType,
  resolveTaskVisualState,
  shortModelLabel,
  type NodeVisualStatus,
} from '@/components/orchestrator/schematic-nodes';
import {
  selectActivePlanTasks,
  type MissionGraphSnapshot,
} from '@/stores/orchestration-graph-store';
import { cn } from '@/lib/utils';

interface SwimlaneTimelineProps {
  snapshot: MissionGraphSnapshot;
  selectedNodeId: string | null;
  onSelectScope: (scope: { taskId: string | null; agentId: string | null }) => void;
}

const BAR_COLORS: Record<NodeVisualStatus, string> = {
  idle: 'bg-muted-foreground/35 border-muted-foreground/40',
  running: 'bg-primary/80 border-primary animate-pulse',
  waiting_approval: 'bg-amber-500/80 border-amber-500',
  completed: 'bg-emerald-500/75 border-emerald-500',
  failed: 'bg-destructive/80 border-destructive',
};

export function SwimlaneTimeline({
  snapshot,
  selectedNodeId,
  onSelectScope,
}: SwimlaneTimelineProps) {
  const { agents, attempts, approvals } = snapshot;
  const tasks = selectActivePlanTasks(snapshot);

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        No delegated worker tracks yet.
      </div>
    );
  }

  const timestamps: number[] = [];
  for (const task of tasks) {
    const tCreated = Date.parse(task.createdAt);
    if (!Number.isNaN(tCreated)) timestamps.push(tCreated);
    if (task.completedAt) {
      const tEnd = Date.parse(task.completedAt);
      if (!Number.isNaN(tEnd)) timestamps.push(tEnd);
    }
  }
  for (const attempt of attempts) {
    const aStart = Date.parse(attempt.startedAt);
    if (!Number.isNaN(aStart)) timestamps.push(aStart);
    if (attempt.completedAt) {
      const aEnd = Date.parse(attempt.completedAt);
      if (!Number.isNaN(aEnd)) timestamps.push(aEnd);
    }
  }

  const minTime = timestamps.length > 0 ? Math.min(...timestamps) : Date.now() - 10_000;
  const maxTime = Math.max(
    minTime + 1_000,
    timestamps.length > 0 ? Math.max(...timestamps, Date.now()) : Date.now(),
  );
  const totalSpan = maxTime - minTime;

  return (
    <div className="h-full overflow-y-auto p-4 space-y-2">
      <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground pb-1 border-b border-border/60">
        <span>Worker / Worktree Track</span>
        <span>Wall-Clock Execution</span>
      </div>

      {tasks.map((task) => {
        const agent = agents.find(
          (a) => a.id === task.assignedAgentId || a.taskId === task.id,
        );
        const taskAttempts = attempts.filter((a) => a.taskId === task.id);
        const latestAttempt = taskAttempts[taskAttempts.length - 1];
        const pendingApproval = approvals.find(
          (ap) => ap.taskId === task.id && ap.status === 'pending',
        );
        const visualStatus = resolveTaskVisualState(task, agent, pendingApproval);
        const startMs = Date.parse(
          latestAttempt?.startedAt || agent?.startedAt || task.createdAt,
        );
        const endMs = latestAttempt?.completedAt || agent?.completedAt || task.completedAt
          ? Date.parse((latestAttempt?.completedAt || agent?.completedAt || task.completedAt)!)
          : maxTime;

        const safeStart = Number.isNaN(startMs) ? minTime : Math.max(minTime, startMs);
        const safeEnd = Number.isNaN(endMs) ? maxTime : Math.max(safeStart + 200, endMs);

        const leftPct = Math.min(92, Math.max(0, ((safeStart - minTime) / totalSpan) * 100));
        const widthPct = Math.max(6, Math.min(100 - leftPct, ((safeEnd - safeStart) / totalSpan) * 100));

        const modelName =
          (task.routePreference?.modelDisplayName as string | undefined) ||
          latestAttempt?.routeModelCatalogId ||
          agent?.modelProfileId ||
          'Auto';
        const runtimeType = resolveRuntimeType(
          latestAttempt?.routeAdapterId || agent?.runtimeAdapterId,
          modelName,
        );
        const duration = formatDurationMs(
          latestAttempt?.startedAt || agent?.startedAt || task.createdAt,
          latestAttempt?.completedAt || agent?.completedAt || task.completedAt,
        );

        const isSelected = selectedNodeId === task.id;

        return (
          <button
            key={task.id}
            type="button"
            onClick={() => onSelectScope({ taskId: task.id, agentId: agent?.id || task.assignedAgentId })}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50',
              isSelected ? 'border-primary ring-1 ring-primary/40' : 'border-border/80',
            )}
          >
            <div className="w-48 shrink-0 min-w-0">
              <div className="flex items-center gap-1.5">
                <RuntimeBrandIcon runtimeId={runtimeType} className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="truncate text-xs font-medium text-foreground">
                  {agent?.displayName || task.title}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="truncate">{shortModelLabel(modelName)}</span>
                {(task.worktreeId || agent?.worktreeId) && (
                  <span className="inline-flex items-center gap-0.5 rounded bg-secondary px-1 py-0.2 text-[9px] text-secondary-foreground">
                    <GitBranch className="h-2.5 w-2.5" /> wt
                  </span>
                )}
              </div>
            </div>

            <div className="relative h-6 flex-1 rounded-md bg-muted/60 overflow-hidden border border-border/50">
              <div
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                className={cn(
                  'absolute top-1 bottom-1 rounded border transition-all flex items-center px-1.5 text-[10px] font-medium text-white',
                  BAR_COLORS[visualStatus],
                )}
              >
                <span className="truncate">{duration || visualStatus.replace(/_/g, ' ')}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

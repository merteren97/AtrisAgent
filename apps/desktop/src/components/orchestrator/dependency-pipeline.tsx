import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import {
  resolveRuntimeType,
  resolveTaskVisualState,
  roleToTier,
  shortModelLabel,
} from '@/components/orchestrator/schematic-nodes';
import {
  selectActivePlanTasks,
  type GraphTaskNode,
  type MissionGraphSnapshot,
} from '@/stores/orchestration-graph-store';
import { cn } from '@/lib/utils';

interface DependencyPipelineProps {
  snapshot: MissionGraphSnapshot;
  selectedNodeId: string | null;
  onSelectScope: (scope: { taskId: string | null; agentId: string | null }) => void;
}

type PipelineColumnId = 'queued' | 'running' | 'approval' | 'verify' | 'done';

const COLUMNS: Array<{ id: PipelineColumnId; label: string; accent: string }> = [
  { id: 'queued', label: 'Queued', accent: 'border-t-muted-foreground/50' },
  { id: 'running', label: 'Running', accent: 'border-t-primary' },
  { id: 'approval', label: 'Needs Approval', accent: 'border-t-amber-500' },
  { id: 'verify', label: 'Verify / Review', accent: 'border-t-emerald-500/70' },
  { id: 'done', label: 'Done / Failed', accent: 'border-t-border' },
];

function classifyTaskColumn(
  task: GraphTaskNode,
  snapshot: MissionGraphSnapshot,
): PipelineColumnId {
  const agent = snapshot.agents.find(
    (a) => a.id === task.assignedAgentId || a.taskId === task.id,
  );
  const pendingApproval = snapshot.approvals.find(
    (ap) => ap.taskId === task.id && ap.status === 'pending',
  );
  const visual = resolveTaskVisualState(task, agent, pendingApproval);

  if (visual === 'waiting_approval') return 'approval';
  if (visual === 'completed' || visual === 'failed') return 'done';
  const tier = roleToTier(agent?.role || task.assignedRole, agent?.sandboxTier);
  if (tier === 'verify') return 'verify';
  if (visual === 'running') return 'running';
  return 'queued';
}

export function DependencyPipeline({
  snapshot,
  selectedNodeId,
  onSelectScope,
}: DependencyPipelineProps) {
  const tasks = selectActivePlanTasks(snapshot);
  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        No tasks in pipeline yet.
      </div>
    );
  }

  const buckets = new Map<PipelineColumnId, GraphTaskNode[]>(
    COLUMNS.map((col) => [col.id, []]),
  );
  for (const task of tasks) {
    const col = classifyTaskColumn(task, snapshot);
    buckets.get(col)!.push(task);
  }

  return (
    <div className="h-full overflow-x-auto p-4">
      <div className="grid min-w-[780px] grid-cols-5 gap-3 h-full">
        {COLUMNS.map((column) => {
          const items = buckets.get(column.id) || [];
          return (
            <div
              key={column.id}
              className={cn(
                'flex flex-col rounded-xl border border-border bg-muted/30 border-t-2 overflow-hidden',
                column.accent,
              )}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-card/60">
                <span className="text-[11px] font-semibold text-foreground">{column.label}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {items.length}
                </span>
              </div>

              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {items.length === 0 ? (
                  <div className="py-6 text-center text-[11px] text-muted-foreground/70">
                    Empty
                  </div>
                ) : (
                  items.map((task) => {
                    const agent = snapshot.agents.find(
                      (a) => a.id === task.assignedAgentId || a.taskId === task.id,
                    );
                    const latestAttempt = snapshot.attempts
                      .filter((a) => a.taskId === task.id)
                      .slice(-1)[0];
                    const modelName =
                      (task.routePreference?.modelDisplayName as string | undefined) ||
                      latestAttempt?.routeModelCatalogId ||
                      agent?.modelProfileId ||
                      'Auto';
                    const runtimeType = resolveRuntimeType(
                      latestAttempt?.routeAdapterId || agent?.runtimeAdapterId,
                      modelName,
                    );
                    const tier = roleToTier(agent?.role || task.assignedRole, agent?.sandboxTier);
                    const isSelected = selectedNodeId === task.id;
                    const isFailed = ['failed', 'rejected', 'revision_requested', 'cancelled'].includes(
                      (agent?.status || task.status || '').toLowerCase(),
                    );

                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() =>
                          onSelectScope({
                            taskId: task.id,
                            agentId: agent?.id || task.assignedAgentId,
                          })
                        }
                        className={cn(
                          'w-full rounded-lg border bg-card p-2.5 text-left transition-all hover:border-primary/50',
                          isSelected
                            ? 'border-primary ring-1 ring-primary/40 shadow-sm'
                            : isFailed
                              ? 'border-destructive/50'
                              : 'border-border/80',
                        )}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="truncate text-xs font-medium text-foreground">
                            {agent?.displayName || task.title}
                          </span>
                          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                            {tier}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-[10px] text-muted-foreground">
                          {agent?.statusMessage || task.description || task.status}
                        </p>
                        <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                          <span className="inline-flex items-center gap-1 truncate">
                            <RuntimeBrandIcon runtimeId={runtimeType} className="h-3 w-3 text-primary shrink-0" />
                            <span className="truncate">{shortModelLabel(modelName)}</span>
                          </span>
                          <span className="capitalize">{task.status.replace(/_/g, ' ')}</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

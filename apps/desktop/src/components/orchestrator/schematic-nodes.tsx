import { useState, type MouseEvent } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { RuntimeType } from '@atris-agent-code/domain';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Cpu,
  GitBranch,
  Loader2,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import { useAccountStore, type DiscoveredModel } from '@/stores/account-store';
import {
  useOrchestrationGraphStore,
  type GraphAgent,
  type GraphApproval,
  type GraphAttempt,
  type GraphTaskNode,
} from '@/stores/orchestration-graph-store';
import { cn } from '@/lib/utils';

export type NodeVisualStatus =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed';

export function resolveTaskVisualState(
  task: GraphTaskNode,
  agent: GraphAgent | undefined,
  pendingApproval: GraphApproval | undefined,
): NodeVisualStatus {
  if (pendingApproval && pendingApproval.status === 'pending') return 'waiting_approval';
  const s = (agent?.status || task.status || '').toLowerCase();
  if (s === 'running' || s === 'claimed' || s === 'in_progress') return 'running';
  if (s === 'waiting' || s === 'waiting_for_approval') return 'waiting_approval';
  if (s === 'done' || s === 'completed') return 'completed';
  if (s === 'failed' || s === 'rejected' || s === 'revision_requested' || s === 'cancelled') return 'failed';
  return 'idle';
}

export function resolveRuntimeType(
  runtimeAdapterId?: string | null,
  modelId?: string | null,
): RuntimeType {
  const raw = `${runtimeAdapterId || ''} ${modelId || ''}`.toLowerCase();
  if (raw.includes('claude')) return 'claude_code';
  if (raw.includes('antigravity') || raw.includes('agy') || raw.includes('gemini')) return 'antigravity';
  if (raw.includes('opencode')) return 'opencode';
  return 'codex';
}

export function shortModelLabel(raw?: string | null): string {
  if (!raw) return 'Auto';
  const cleaned = raw.split('/').pop() || raw;
  return cleaned.length > 22 ? `${cleaned.slice(0, 20)}…` : cleaned;
}

export function formatDurationMs(startedAt?: string | null, completedAt?: string | null): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  const diffSec = Math.max(0, Math.round((end - start) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return `${mins}m ${secs}s`;
}

export function roleToTier(role?: string | null, sandboxTier?: string | null): 'inspect' | 'implement' | 'verify' {
  if (sandboxTier === 'inspect' || sandboxTier === 'implement' || sandboxTier === 'verify') {
    return sandboxTier;
  }
  if (role === 'builder') return 'implement';
  if (role === 'reviewer' || role === 'qa') return 'verify';
  return 'inspect';
}

const TIER_BADGE_CLASSES: Record<'inspect' | 'implement' | 'verify', string> = {
  inspect: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25',
  implement: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/25',
  verify: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25',
};

const STATUS_RING_CLASSES: Record<NodeVisualStatus, string> = {
  idle: 'border-border hover:border-primary/40',
  running: 'border-primary/70 ring-2 ring-primary/25',
  waiting_approval: 'border-amber-500/80 ring-2 ring-amber-500/30',
  completed: 'border-emerald-500/50',
  failed: 'border-destructive/70 ring-1 ring-destructive/30',
};

export interface OrchestratorRootNodeData extends Record<string, unknown> {
  missionId: string;
  title: string;
  status: string;
  taskCount: number;
  activeCount: number;
  selected: boolean;
}

export type OrchestratorRootFlowNode = Node<OrchestratorRootNodeData, 'orchestratorRoot'>;

export function OrchestratorRootNode({ data }: NodeProps<OrchestratorRootFlowNode>) {
  const isActive = ['running', 'planning', 'starting', 'verifying', 'revising'].includes(data.status);
  return (
    <div
      className={cn(
        'w-[248px] rounded-xl border bg-card px-3.5 py-3 text-card-foreground shadow-sm transition-all',
        data.selected
          ? 'border-primary ring-2 ring-primary/30 shadow-md'
          : 'border-border hover:border-primary/50',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Orchestrator
            </div>
            <div className="truncate text-xs font-semibold text-foreground">
              {data.title || 'Mission Lead'}
            </div>
          </div>
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize border',
            isActive
              ? 'border-primary/30 bg-primary/10 text-primary'
              : data.status === 'completed'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : data.status === 'failed'
                  ? 'border-destructive/30 bg-destructive/10 text-destructive'
                  : 'border-border bg-muted text-muted-foreground',
          )}
        >
          {isActive && <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />}
          {data.status.replace(/_/g, ' ')}
        </span>
      </div>

      <div className="mt-2.5 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/60 pt-2">
        <span>{data.taskCount} delegated {data.taskCount === 1 ? 'task' : 'tasks'}</span>
        {data.activeCount > 0 && (
          <span className="font-medium text-primary">{data.activeCount} active</span>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-background !bg-primary"
      />
    </div>
  );
}

export interface AgentTaskNodeData extends Record<string, unknown> {
  missionId: string;
  task: GraphTaskNode;
  agent?: GraphAgent;
  latestAttempt?: GraphAttempt;
  pendingApproval?: GraphApproval;
  selected: boolean;
}

export type AgentTaskFlowNode = Node<AgentTaskNodeData, 'agentTask'>;

function StatusIndicator({ status }: { status: NodeVisualStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />;
    case 'waiting_approval':
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-500 animate-pulse shrink-0" />;
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
    default:
      return <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  }
}

export function AgentTaskNode({ data }: NodeProps<AgentTaskFlowNode>) {
  const { missionId, task, agent, latestAttempt, pendingApproval, selected } = data;
  const [routeOpen, setRouteOpen] = useState(false);
  const [savingRoute, setSavingRoute] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  const discoveredModels = useAccountStore((s) => s.discoveredModels);
  const updateTaskRoute = useOrchestrationGraphStore((s) => s.updateTaskRoute);

  const visualStatus = resolveTaskVisualState(task, agent, pendingApproval);
  const tier = roleToTier(agent?.role || task.assignedRole, agent?.sandboxTier);
  const displayName =
    agent?.displayName ||
    task.title ||
    (task.assignedRole ? `${task.assignedRole} worker` : 'Worker Task');

  const routeModelName =
    (task.routePreference?.modelDisplayName as string | undefined) ||
    (task.routePreference?.modelCatalogId as string | undefined) ||
    latestAttempt?.routeModelCatalogId ||
    agent?.modelProfileId ||
    'Auto';

  const runtimeType = resolveRuntimeType(
    latestAttempt?.routeAdapterId || agent?.runtimeAdapterId,
    routeModelName,
  );

  const canSwapRoute = ['planned', 'ready', 'failed'].includes(task.status);
  const availableModels = discoveredModels.filter((m) => m.available);
  const isIsolatedWorktree = Boolean(
    task.worktreeId ||
      agent?.worktreeId ||
      latestAttempt?.worktreePath ||
      agent?.workspaceMode === 'worktree',
  );
  const durationLabel = formatDurationMs(
    latestAttempt?.startedAt || agent?.startedAt,
    latestAttempt?.completedAt || agent?.completedAt,
  );
  const activityLine =
    agent?.statusMessage ||
    latestAttempt?.error ||
    task.description ||
    task.title;

  const handleToggleRouteMenu = (event: MouseEvent) => {
    event.stopPropagation();
    if (!canSwapRoute) return;
    setRouteError(null);
    setRouteOpen((prev) => !prev);
  };

  const handleSelectModel = async (event: MouseEvent, model: DiscoveredModel) => {
    event.stopPropagation();
    setSavingRoute(true);
    setRouteError(null);
    try {
      await updateTaskRoute(missionId, task.id, {
        modelCatalogId: model.catalogId,
        reasoningLevel: model.defaultReasoning,
        accountProfileId: model.accountProfileId,
      });
      setRouteOpen(false);
    } catch (err) {
      setRouteError(err instanceof Error ? err.message : 'Route update failed');
    } finally {
      setSavingRoute(false);
    }
  };

  return (
    <div
      className={cn(
        'relative w-[272px] rounded-xl border bg-card px-3 py-2.5 text-card-foreground shadow-sm transition-all',
        STATUS_RING_CLASSES[visualStatus],
        selected && 'ring-2 ring-primary border-primary shadow-md',
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground/70"
      />

      {/* Top header: status + name + sandbox tier */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <StatusIndicator status={visualStatus} />
          <span className="truncate text-xs font-semibold text-foreground" title={displayName}>
            {displayName}
          </span>
        </div>
        <span
          className={cn(
            'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            TIER_BADGE_CLASSES[tier],
          )}
        >
          {tier}
        </span>
      </div>

      {/* 1-line live activity or objective snippet */}
      <p className="mt-1.5 truncate text-[11px] text-muted-foreground" title={activityLine}>
        {activityLine}
      </p>

      {/* Approval pulse banner if waiting approval */}
      {visualStatus === 'waiting_approval' && (
        <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-ping" />
          <span className="truncate">
            {pendingApproval?.description || 'Waiting for approval'}
          </span>
        </div>
      )}

      {/* Footer: CLI + Model badge (with 1-click route swap) + worktree + attempt/duration */}
      <div className="mt-2.5 flex items-center justify-between gap-1.5 border-t border-border/60 pt-2">
        <button
          type="button"
          onClick={handleToggleRouteMenu}
          disabled={!canSwapRoute || savingRoute}
          title={canSwapRoute ? 'Click to swap task model route' : `Model route: ${routeModelName}`}
          className={cn(
            'nodrag nopan inline-flex max-w-[146px] items-center gap-1 rounded-md border border-border/80 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground transition-colors',
            canSwapRoute
              ? 'cursor-pointer hover:border-primary/50 hover:bg-accent'
              : 'cursor-default opacity-85',
          )}
        >
          <RuntimeBrandIcon runtimeId={runtimeType} className="h-3 w-3 shrink-0 text-primary" />
          <span className="truncate">{shortModelLabel(routeModelName)}</span>
          {canSwapRoute && <ChevronDown className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />}
        </button>

        <div className="flex items-center gap-1 shrink-0">
          {isIsolatedWorktree && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground"
              title={task.worktreeId || latestAttempt?.worktreePath || 'Isolated worktree'}
            >
              <GitBranch className="h-2.5 w-2.5" />
              wt
            </span>
          )}
          {(latestAttempt || durationLabel) && (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {latestAttempt ? `#${latestAttempt.attemptNumber}` : ''}
              {durationLabel ? (latestAttempt ? ` · ${durationLabel}` : durationLabel) : ''}
            </span>
          )}
        </div>
      </div>

      {/* 1-click route swap popover */}
      {routeOpen && (
        <div
          className="nodrag nopan absolute left-2 top-full z-50 mt-1.5 w-60 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="flex items-center gap-1">
              <Cpu className="h-3 w-3" /> Swap Task Route
            </span>
            {savingRoute && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
          </div>
          {routeError && (
            <div className="mx-1 mb-1 rounded bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
              {routeError}
            </div>
          )}
          <div className="max-h-44 overflow-y-auto space-y-0.5">
            {availableModels.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                No connected models available.
              </div>
            ) : (
              availableModels.map((model) => (
                <button
                  key={`${model.accountProfileId}:${model.catalogId}`}
                  type="button"
                  disabled={savingRoute}
                  onClick={(e) => handleSelectModel(e, model)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[11px] hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <RuntimeBrandIcon runtimeId={model.runtimeType} className="h-3 w-3 shrink-0" />
                    <span className="truncate font-medium">{model.name}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {model.accountName}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground/70"
      />
    </div>
  );
}

export interface VerificationGateNodeData extends Record<string, unknown> {
  status: 'pending' | 'verifying' | 'passed' | 'failed';
  builderCount: number;
  selected: boolean;
}

export type VerificationGateFlowNode = Node<VerificationGateNodeData, 'verificationGate'>;

export function VerificationGateNode({ data }: NodeProps<VerificationGateFlowNode>) {
  return (
    <div
      className={cn(
        'w-[216px] rounded-xl border bg-card px-3.5 py-2.5 text-card-foreground shadow-sm transition-all',
        data.status === 'passed'
          ? 'border-emerald-500/60'
          : data.status === 'failed'
            ? 'border-destructive/60'
            : data.status === 'verifying'
              ? 'border-primary/70 ring-2 ring-primary/25'
              : 'border-border',
        data.selected && 'ring-2 ring-primary border-primary',
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-background !bg-emerald-500/80"
      />
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Merge &amp; Verify Gate
          </div>
          <div className="truncate text-xs font-semibold capitalize">
            {data.status} · {data.builderCount} {data.builderCount === 1 ? 'stream' : 'streams'}
          </div>
        </div>
      </div>
    </div>
  );
}

export const schematicNodeTypes = {
  orchestratorRoot: OrchestratorRootNode,
  agentTask: AgentTaskNode,
  verificationGate: VerificationGateNode,
};

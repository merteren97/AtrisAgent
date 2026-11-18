import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RuntimeType } from '@atris-agent-code/domain';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Archive,
  Ban,
  BookOpen,
  Check,
  CheckCircle2,
  Circle,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ConversationDeleteDialog } from '@/components/history/ConversationDeleteDialog';
import { markManualClosed } from '@/components/manual/manual-activity';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import {
  formatDurationCompact,
  formatLiveClock,
  navigateToActivityTarget,
} from '@/lib/activity-navigation';
import type { ActivityMode, ActivityState, ActivitySummaryItem } from '@/lib/activity-types';
import { apiRequest } from '@/lib/api-client';
import { isTauriRuntime } from '@/lib/secure-storage';
import { cn } from '@/lib/utils';
import { isClearableActivityItem, useActivityStore } from '@/stores/activity-store';
import { useManualStore } from '@/stores/manual-store';
import { useMissionStore, type Mission } from '@/stores/mission-store';
import { usePlanningStore } from '@/stores/planning-store';
import { useRightDockStore } from '@/stores/right-dock-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

type ScopeFilter = 'all' | 'project';
type StatusFilter = 'all' | 'attention' | 'running' | 'done';
type ModeFilter = 'all' | ActivityMode;

const BRAND_RUNTIMES = new Set<RuntimeType>(['codex', 'claude_code', 'antigravity', 'opencode']);

function primaryBrandRuntime(runtimeTypes: string[]): RuntimeType | null {
  for (const runtime of runtimeTypes) {
    if (BRAND_RUNTIMES.has(runtime as RuntimeType)) {
      return runtime as RuntimeType;
    }
  }
  return null;
}

function modeLabel(mode: ActivityMode): string {
  if (mode === 'manual') return 'Manual';
  if (mode === 'orchestrator') return 'Orchestrator';
  return 'Plan';
}

function ModeGlyph({ mode, className }: { mode: ActivityMode; className?: string }) {
  if (mode === 'manual') return <TerminalSquare className={className} />;
  if (mode === 'orchestrator') return <Workflow className={className} />;
  return <BookOpen className={className} />;
}

function ItemLeadingIcon({ item, className }: { item: ActivitySummaryItem; className?: string }) {
  const brand = primaryBrandRuntime(item.runtimeTypes);
  if (brand) {
    return <RuntimeBrandIcon runtimeId={brand} className={cn('shrink-0', className)} />;
  }
  return <ModeGlyph mode={item.mode} className={cn('shrink-0', className)} />;
}

function formatRelativeTime(iso: string, nowMs: number): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  const seconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatWaitLabel(iso: string | undefined, nowMs: number): string {
  if (!iso) return 'Waiting';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'Waiting';
  const seconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (seconds < 60) return `Waiting ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `Waiting ${hours}h`;
}

function StateGlyph({ state }: { state: ActivityState }) {
  if (state === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
  if (state === 'failed') return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
  if (state === 'cancelled') return <Ban className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Circle className="h-3 w-3 text-muted-foreground/70" />;
}

export function ActivityPanel() {
  const dockOpen = useRightDockStore((state) => state.open);
  const dockTab = useRightDockStore((state) => state.activeTab);
  const visible = dockOpen && dockTab === 'activity';

  const items = useActivityStore((state) => state.items);
  const loading = useActivityStore((state) => state.loading);
  const refreshing = useActivityStore((state) => state.refreshing);
  const error = useActivityStore((state) => state.error);
  const refresh = useActivityStore((state) => state.refresh);
  const togglePin = useActivityStore((state) => state.togglePin);
  const markSeen = useActivityStore((state) => state.markSeen);
  const renameItem = useActivityStore((state) => state.renameItem);
  const clearCompleted = useActivityStore((state) => state.clearCompleted);

  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const activeView = useSettingsStore((state) => state.activeView);
  const manualMode = useManualStore((state) => state.mode);
  const manualActiveByWorkspace = useManualStore((state) => state.activeByWorkspace);
  const missions = useMissionStore((state) => state.missions);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const planningActiveByWorkspace = usePlanningStore((state) => state.activeByWorkspace);

  const [scope, setScope] = useState<ScopeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [now, setNow] = useState(() => Date.now());
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [renameTarget, setRenameTarget] = useState<ActivitySummaryItem | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  const [deleteMission, setDeleteMission] = useState<Mission | null>(null);
  const [deleteOtherTarget, setDeleteOtherTarget] = useState<ActivitySummaryItem | null>(null);
  const [deletingOther, setDeletingOther] = useState(false);

  useEffect(() => {
    if (!visible) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    if (scope === 'project' && !activeWorkspaceId) {
      setScope('all');
    }
  }, [activeWorkspaceId, scope]);

  // Auto-mark completed items as seen when the user already has that exact chat open.
  useEffect(() => {
    if (!visible || activeView !== 'chat') return;
    for (const item of items) {
      if (!item.unreadCompletion) continue;
      const isOpen = (
        (item.mode === 'manual'
          && manualMode === 'manual'
          && item.workspaceId === activeWorkspaceId
          && Boolean(item.target.conversationId)
          && manualActiveByWorkspace[activeWorkspaceId || ''] === item.target.conversationId)
        || (item.mode === 'orchestrator'
          && manualMode === 'orchestrator'
          && Boolean(item.target.missionId)
          && activeMissionId === item.target.missionId)
        || (item.mode === 'planning'
          && manualMode === 'planning'
          && item.workspaceId === activeWorkspaceId
          && Boolean(item.target.planId)
          && planningActiveByWorkspace[activeWorkspaceId || ''] === item.target.planId)
      );
      if (isOpen) {
        void markSeen(item.itemKey);
      }
    }
  }, [
    visible,
    activeView,
    items,
    manualMode,
    activeWorkspaceId,
    manualActiveByWorkspace,
    activeMissionId,
    planningActiveByWorkspace,
    markSeen,
  ]);

  const scopeWorkspaceId = scope === 'project' ? activeWorkspaceId : null;

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (scopeWorkspaceId && item.workspaceId !== scopeWorkspaceId) return false;
      if (modeFilter !== 'all' && item.mode !== modeFilter) return false;
      if (statusFilter === 'attention' && item.state !== 'attention') return false;
      if (statusFilter === 'running' && item.state !== 'running') return false;
      if (statusFilter === 'done' && (item.state === 'attention' || item.state === 'running')) return false;
      if (!query) return true;
      const haystack = [
        item.title,
        item.workspaceName,
        item.subtitle || '',
        item.statusLabel,
        item.attention?.preview || '',
        ...item.models,
        ...item.runtimeTypes,
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [items, scopeWorkspaceId, modeFilter, statusFilter, searchQuery]);

  const attentionItems = useMemo(
    () => filteredItems.filter((item) => item.state === 'attention'),
    [filteredItems],
  );
  const runningItems = useMemo(
    () => filteredItems.filter((item) => item.state === 'running'),
    [filteredItems],
  );
  const historyItems = useMemo(() => {
    return filteredItems
      .filter((item) => item.state !== 'attention' && item.state !== 'running')
      .sort((a, b) => {
        const pinDiff = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt));
        if (pinDiff !== 0) return pinDiff;
        if (a.pinnedAt && b.pinnedAt && a.pinnedAt !== b.pinnedAt) {
          return b.pinnedAt.localeCompare(a.pinnedAt);
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [filteredItems]);

  const clearableCount = useMemo(
    () => items.filter((item) => isClearableActivityItem(item, scopeWorkspaceId, modeFilter)).length,
    [items, scopeWorkspaceId, modeFilter],
  );

  const handleOpenItem = (item: ActivitySummaryItem) => {
    void navigateToActivityTarget(item.target);
    if (item.unreadCompletion) {
      void markSeen(item.itemKey);
    }
  };

  const handleOpenRename = (item: ActivitySummaryItem) => {
    setActionError(null);
    setRenameTarget(item);
    setRenameValue(item.title);
  };

  const handleConfirmRename = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!renameTarget || !renameValue.trim() || renaming) return;
    setRenaming(true);
    setActionError(null);
    try {
      await renameItem(renameTarget.target, renameValue.trim());
      setRenameTarget(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Rename failed.');
    } finally {
      setRenaming(false);
    }
  };

  const handleRequestDelete = (item: ActivitySummaryItem) => {
    setActionError(null);
    if (item.mode === 'orchestrator' && item.target.missionId) {
      const existing = missions.find((mission) => mission.id === item.target.missionId);
      setDeleteMission(existing || {
        id: item.target.missionId,
        workspaceId: item.workspaceId,
        title: item.title,
        status: item.state === 'running'
          ? 'running'
          : item.state === 'failed'
            ? 'failed'
            : item.state === 'cancelled'
              ? 'cancelled'
              : 'completed',
        createdAt: item.createdAt,
      });
      return;
    }
    setDeleteOtherTarget(item);
  };

  const handleConfirmDeleteOther = async () => {
    if (!deleteOtherTarget || deletingOther) return;
    setDeletingOther(true);
    setActionError(null);
    try {
      const target = deleteOtherTarget.target;
      if (deleteOtherTarget.mode === 'manual' && target.conversationId) {
        const conversations = useManualStore.getState().conversations[deleteOtherTarget.workspaceId] || [];
        const loaded = conversations.find((conv) => conv.id === target.conversationId);
        const agentIds = new Set<string>([
          ...(deleteOtherTarget.manualAgents || []).map((agent) => agent.id),
          ...(loaded?.agents.map((agent) => agent.id) || []),
        ]);

        if (isTauriRuntime()) {
          for (const agentId of agentIds) {
            try {
              await invoke('manual_terminal_close', { id: agentId });
            } catch {
              // Terminal may already be closed.
            }
            markManualClosed(agentId);
            useManualStore.getState().hideAgent(agentId, true);
          }
          try {
            const { disposeManualTerminal } = await import('@/components/manual/manual-terminal');
            agentIds.forEach((agentId) => disposeManualTerminal(agentId));
          } catch {
            // Optional cleanup.
          }
        }

        if (loaded) {
          await useManualStore.getState().remove(loaded);
        } else {
          await apiRequest(`/manual/conversations/${encodeURIComponent(target.conversationId)}`, { method: 'DELETE' });
          await useManualStore.getState().refresh(deleteOtherTarget.workspaceId);
        }
      } else if (deleteOtherTarget.mode === 'planning' && target.planId) {
        await usePlanningStore.getState().update(deleteOtherTarget.workspaceId, target.planId, {
          archivedAt: new Date().toISOString(),
        });
      }
      setDeleteOtherTarget(null);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not remove item.');
    } finally {
      setDeletingOther(false);
    }
  };

  const handleConfirmClear = async () => {
    if (clearing) return;
    setClearing(true);
    setActionError(null);
    try {
      await clearCompleted(scopeWorkspaceId, modeFilter);
      setClearConfirmOpen(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not clear completed items.');
    } finally {
      setClearing(false);
    }
  };

  const renderRowMenu = (item: ActivitySummaryItem) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${item.title}`}
          className="h-6 w-6 shrink-0 text-muted-foreground opacity-70 transition-opacity hover:text-foreground group-hover/row:opacity-100 data-[state=open]:opacity-100"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => void togglePin(item.itemKey, !item.pinnedAt)}>
          {item.pinnedAt ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          {item.pinnedAt ? 'Unpin' : 'Pin'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handleOpenRename(item)}>
          <Pencil className="h-3.5 w-3.5" />
          Rename…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => handleRequestDelete(item)}
        >
          {item.mode === 'planning' ? <Archive className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
          {item.mode === 'planning' ? 'Archive plan…' : 'Delete…'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <div className="shrink-0 space-y-2.5 border-b border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5" role="group" aria-label="Activity scope">
            <button
              type="button"
              onClick={() => setScope('all')}
              aria-pressed={scope === 'all'}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                scope === 'all'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              All projects
            </button>
            <button
              type="button"
              disabled={!activeWorkspaceId}
              onClick={() => setScope('project')}
              aria-pressed={scope === 'project'}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                scope === 'project'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              This project
            </button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            aria-label="Refresh activity"
            title="Refresh"
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', (loading || refreshing) && 'animate-spin motion-reduce:animate-none')} />
          </Button>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && searchQuery) {
                event.stopPropagation();
                setSearchQuery('');
              }
            }}
            placeholder="Search tasks & chats…"
            aria-label="Search tasks and chats"
            className="h-7.5 bg-muted/30 pl-8 pr-7 text-xs"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
            {([
              { id: 'all', label: 'All' },
              { id: 'attention', label: 'Attention' },
              { id: 'running', label: 'Running' },
              { id: 'done', label: 'Done' },
            ] as const).map((pill) => (
              <button
                key={pill.id}
                type="button"
                aria-pressed={statusFilter === pill.id}
                onClick={() => setStatusFilter(pill.id)}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors',
                  statusFilter === pill.id
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {pill.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by mode">
            {([
              { id: 'all', label: 'All' },
              { id: 'manual', label: 'Manual' },
              { id: 'orchestrator', label: 'Orchestrator' },
              { id: 'planning', label: 'Plan' },
            ] as const).map((pill) => (
              <button
                key={pill.id}
                type="button"
                aria-pressed={modeFilter === pill.id}
                onClick={() => setModeFilter(pill.id)}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors',
                  modeFilter === pill.id
                    ? 'border-border bg-accent text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                {pill.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {(error || actionError) && (
        <div role="alert" className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 truncate">{actionError || error}</span>
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => { setActionError(null); void refresh(); }}>
            Retry
          </Button>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {loading && items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-xs text-muted-foreground" role="status">
              <Loader2 className="mb-2 h-5 w-5 animate-spin text-primary" />
              Loading activity…
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-12 text-center">
              <Activity className="mb-2.5 h-6 w-6 text-muted-foreground/70" />
              <p className="text-xs font-medium text-foreground">
                {items.length === 0 ? 'No recent tasks or chats' : 'No matching activity'}
              </p>
              <p className="mt-1 max-w-[220px] text-[11px] leading-relaxed text-muted-foreground">
                {items.length === 0
                  ? 'Start a Manual, Orchestrator, or Planning conversation to track live agents and approvals here.'
                  : 'Try clearing your search or switching scope and filters.'}
              </p>
            </div>
          ) : (
            <>
              {attentionItems.length > 0 && (
                <section aria-label="Needs Attention" className="space-y-2">
                  <div className="flex items-center justify-between px-0.5">
                    <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Needs Attention
                    </h2>
                    <Badge variant="warning" className="h-4 px-1.5 text-[10px] tabular-nums">
                      {attentionItems.length}
                    </Badge>
                  </div>
                  <div className="space-y-1.5">
                    {attentionItems.map((item) => (
                      <div
                        key={item.itemKey}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleOpenItem(item)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleOpenItem(item);
                          }
                        }}
                        className="group/row flex cursor-pointer flex-col gap-1.5 rounded-xl border border-amber-500/35 bg-amber-500/[0.07] p-2.5 text-left transition-colors hover:border-amber-500/55 hover:bg-amber-500/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
                            <ItemLeadingIcon item={item} className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="truncate text-xs font-semibold text-foreground">{item.title}</span>
                              <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-amber-700 dark:text-amber-300">
                                {formatWaitLabel(item.attention?.sinceAt || item.updatedAt, now)}
                              </span>
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                              <span className="max-w-[130px] truncate rounded bg-background/70 px-1.5 py-0.5 font-medium text-foreground/80">
                                {item.workspaceName}
                              </span>
                              <span>{modeLabel(item.mode)}</span>
                            </div>
                          </div>
                          {renderRowMenu(item)}
                        </div>
                        {item.attention?.preview && (
                          <p className="line-clamp-2 pl-7 text-[11px] leading-snug text-foreground/85">
                            {item.attention.preview}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {runningItems.length > 0 && (
                <section aria-label="Active Agents" className="space-y-2">
                  <div className="flex items-center justify-between px-0.5">
                    <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none" />
                      Active Agents
                    </h2>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{runningItems.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {runningItems.map((item) => (
                      <div
                        key={item.itemKey}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleOpenItem(item)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleOpenItem(item);
                          }
                        }}
                        className="group/row flex cursor-pointer items-start gap-2 rounded-xl border border-border bg-background/70 p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <ItemLeadingIcon item={item} className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-medium text-foreground">{item.title}</span>
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none" />
                              {formatLiveClock(item.startedAt || item.updatedAt, now)}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                            <span className="max-w-[120px] truncate rounded bg-muted px-1.5 py-0.5 font-medium text-foreground/80">
                              {item.workspaceName}
                            </span>
                            <span>{modeLabel(item.mode)}</span>
                            <span>·</span>
                            <span className="truncate">
                              {item.activeCount > 1 ? `${item.activeCount} active` : item.statusLabel}
                            </span>
                          </div>
                        </div>
                        {renderRowMenu(item)}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {historyItems.length > 0 && (
                <section aria-label="Pinned and History" className="space-y-2">
                  <div className="flex items-center justify-between gap-2 px-0.5">
                    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Pinned & History
                    </h2>
                    {clearableCount > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => setClearConfirmOpen((prev) => !prev)}
                      >
                        Clear completed
                      </Button>
                    )}
                  </div>

                  {clearConfirmOpen && clearableCount > 0 && (
                    <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/40 p-2.5 text-xs">
                      <p className="text-[11px] leading-relaxed text-foreground">
                        Clear {clearableCount} completed item{clearableCount === 1 ? '' : 's'}? Pinned and active items will be kept.
                      </p>
                      <div className="flex justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 px-2.5 text-[11px]"
                          disabled={clearing}
                          onClick={() => setClearConfirmOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="h-6 px-2.5 text-[11px]"
                          disabled={clearing}
                          onClick={() => void handleConfirmClear()}
                        >
                          {clearing && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                          Clear
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="space-y-1">
                    {historyItems.map((item) => (
                      <div
                        key={item.itemKey}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleOpenItem(item)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleOpenItem(item);
                          }
                        }}
                        className={cn(
                          'group/row flex cursor-pointer items-start gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          item.unreadCompletion
                            ? 'border-primary/30 bg-primary/[0.04] hover:bg-primary/[0.08]'
                            : 'border-transparent hover:border-border hover:bg-accent/40',
                        )}
                      >
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground">
                          <ItemLeadingIcon item={item} className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            {item.pinnedAt && (
                              <Pin className="h-3 w-3 shrink-0 text-primary" aria-label="Pinned" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                              {item.title}
                            </span>
                            {item.unreadCompletion && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                                New
                              </span>
                            )}
                            <StateGlyph state={item.state} />
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
                            <span className="max-w-[115px] truncate rounded bg-muted/70 px-1.5 py-0.5 font-medium text-foreground/75">
                              {item.workspaceName}
                            </span>
                            <span>{modeLabel(item.mode)}</span>
                            {item.durationMs !== null && item.durationMs > 0 && (
                              <>
                                <span>·</span>
                                <span className="tabular-nums">{formatDurationCompact(item.durationMs)}</span>
                              </>
                            )}
                            <span>·</span>
                            <span className="tabular-nums">{formatRelativeTime(item.updatedAt, now)}</span>
                          </div>
                        </div>
                        {renderRowMenu(item)}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => { if (!open && !renaming) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>Choose a clear name for this item.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void handleConfirmRename(event)}>
            <Input
              autoFocus
              value={renameValue}
              maxLength={200}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') event.stopPropagation();
              }}
              aria-label="New title"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" disabled={renaming} onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renameValue.trim() || renaming}>
                {renaming ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConversationDeleteDialog
        mission={deleteMission}
        onOpenChange={(open) => { if (!open) setDeleteMission(null); }}
        onDeleted={() => { void refresh(); }}
      />

      <Dialog open={Boolean(deleteOtherTarget)} onOpenChange={(open) => { if (!open && !deletingOther) setDeleteOtherTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {deleteOtherTarget?.mode === 'planning' ? 'Archive plan?' : 'Delete conversation?'}
            </DialogTitle>
            <DialogDescription>
              {deleteOtherTarget?.mode === 'planning'
                ? 'This removes the plan from active activity. Your Markdown files and research stay preserved in Archive.'
                : 'Its CLI sessions will close and this conversation will be removed from AtrisAgent. Saved project memory and provider-owned history are retained.'}
            </DialogDescription>
          </DialogHeader>
          {deleteOtherTarget && (
            <div className="break-words rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm font-medium">
              {deleteOtherTarget.title}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={deletingOther} onClick={() => setDeleteOtherTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={deleteOtherTarget?.mode === 'planning' ? 'default' : 'destructive'}
              disabled={deletingOther}
              onClick={() => void handleConfirmDeleteOther()}
            >
              {deletingOther && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {deleteOtherTarget?.mode === 'planning' ? 'Archive plan' : 'Delete conversation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

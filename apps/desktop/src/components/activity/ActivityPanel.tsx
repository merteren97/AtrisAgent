import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RuntimeType } from '@atris-agent-code/domain';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Ban,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Folder,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  SlidersHorizontal,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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

function formatWaitShort(iso: string | undefined, nowMs: number): string {
  if (!iso) return 'Wait';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'Wait';
  const seconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function formatAttentionBadge(
  item: ActivitySummaryItem,
  nowMs: number,
  compact: boolean,
): { label: string; isError: boolean } {
  if (item.attention?.kind === 'error') {
    return { label: 'Failed', isError: true };
  }
  const timestamp = item.attention?.sinceAt || item.updatedAt;
  return {
    label: compact ? formatWaitShort(timestamp, nowMs) : formatWaitLabel(timestamp, nowMs),
    isError: false,
  };
}

function StateGlyph({ state }: { state: ActivityState }) {
  if (state === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  if (state === 'failed') return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  if (state === 'cancelled') return <Ban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  return <Circle className="h-3 w-3 shrink-0 text-muted-foreground/70" />;
}

export function ActivityPanel({ compact: compactProp }: { compact?: boolean } = {}) {
  const dockOpen = useRightDockStore((state) => state.open);
  const dockTab = useRightDockStore((state) => state.activeTab);
  const dockWidth = useRightDockStore((state) => state.width);
  const dockExpanded = useRightDockStore((state) => state.expanded);
  const visible = dockOpen && dockTab === 'activity';
  const compact = compactProp ?? (dockWidth < 340 && !dockExpanded);

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

  const statusCounts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    let attention = 0;
    let running = 0;
    for (const item of items) {
      if (scopeWorkspaceId && item.workspaceId !== scopeWorkspaceId) continue;
      if (modeFilter !== 'all' && item.mode !== modeFilter) continue;
      if (query) {
        const haystack = [
          item.title,
          item.workspaceName,
          item.subtitle || '',
          item.statusLabel,
          item.attention?.preview || '',
          ...item.models,
          ...item.runtimeTypes,
        ].join(' ').toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      if (item.state === 'attention') attention += 1;
      else if (item.state === 'running') running += 1;
    }
    return { attention, running };
  }, [items, scopeWorkspaceId, modeFilter, searchQuery]);

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

  const handleDismissOrMarkSeen = async (item: ActivitySummaryItem) => {
    setActionError(null);
    if (item.unreadCompletion) {
      await markSeen(item.itemKey);
    }
    if (item.state === 'attention' && item.attention?.kind === 'error') {
      try {
        await apiRequest('/activity/meta', {
          method: 'PUT',
          body: JSON.stringify({ itemKey: item.itemKey, markSeen: true }),
        });
        await refresh();
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : 'Could not dismiss item.');
      }
    }
  };

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
        await apiRequest('/activity/meta', {
          method: 'PUT',
          body: JSON.stringify({
            itemKey: deleteOtherTarget.itemKey,
            cleared: true,
            pinned: false,
          }),
        });
        if (target.conversationId && target.conversationId !== 'default') {
          await apiRequest(
            `/planning/${encodeURIComponent(deleteOtherTarget.workspaceId)}/plans/${encodeURIComponent(target.planId)}/chat/conversations/${encodeURIComponent(target.conversationId)}`,
            {
              method: 'PATCH',
              body: JSON.stringify({ closed: true }),
            },
          ).catch(() => {});
        }
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

  const renderRowMenu = (item: ActivitySummaryItem, rowCompact = false) => {
    const canDismissError = item.state === 'attention' && item.attention?.kind === 'error';
    const canMarkSeen = canDismissError || item.unreadCompletion;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${item.title}`}
            className={cn(
              'shrink-0 text-muted-foreground transition-opacity hover:text-foreground group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
              rowCompact
                ? 'h-5 w-5 opacity-0 group-hover/row:opacity-100'
                : 'h-6 w-6 opacity-70 group-hover/row:opacity-100',
            )}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48" onClick={(event) => event.stopPropagation()}>
          {canMarkSeen && (
            <DropdownMenuItem onSelect={() => void handleDismissOrMarkSeen(item)}>
              <Check className="h-3.5 w-3.5" />
              {canDismissError ? 'Dismiss' : 'Mark as seen'}
            </DropdownMenuItem>
          )}
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
            className={item.mode === 'planning' ? undefined : 'text-destructive focus:text-destructive'}
            onSelect={() => handleRequestDelete(item)}
          >
            {item.mode === 'planning' ? <X className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
            {item.mode === 'planning' ? 'Remove from activity…' : 'Delete…'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-card">
      <div className={cn('shrink-0 border-b border-border', compact ? 'space-y-1.5 px-2 py-2' : 'space-y-2 px-3 py-2')}>
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && searchQuery) {
                  event.stopPropagation();
                  setSearchQuery('');
                }
              }}
              placeholder={compact ? 'Search…' : 'Search tasks & chats…'}
              aria-label="Search tasks and chats"
              className="h-7 w-full min-w-0 bg-muted/30 pl-7 pr-6 text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!activeWorkspaceId && scope === 'all'}
            aria-pressed={scope === 'project'}
            aria-label={scope === 'project' ? 'Scope: This project' : 'Scope: All projects'}
            title={scope === 'project' ? 'Showing this project (click for all projects)' : 'Showing all projects (click for this project)'}
            onClick={() => setScope((prev) => (prev === 'all' ? 'project' : 'all'))}
            className={cn(
              'h-7 shrink-0 gap-1 border-border/70 text-[11px] font-medium shadow-none',
              compact ? 'w-7 px-0' : 'px-2',
              scope === 'project'
                ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
                : 'bg-muted/30 text-muted-foreground hover:text-foreground',
            )}
          >
            <Folder className="h-3.5 w-3.5 shrink-0" />
            {!compact && <span>{scope === 'project' ? 'Project' : 'All'}</span>}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Filter by mode"
                title={modeFilter === 'all' ? 'Filter by mode' : `Mode: ${modeLabel(modeFilter)}`}
                className={cn(
                  'relative h-7 shrink-0 gap-1 border-border/70 text-[11px] font-medium shadow-none',
                  compact ? 'w-7 px-0' : 'px-2',
                  modeFilter !== 'all'
                    ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
                    : 'bg-muted/30 text-muted-foreground hover:text-foreground',
                )}
              >
                {modeFilter === 'all' ? (
                  <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ModeGlyph mode={modeFilter} className="h-3.5 w-3.5 shrink-0" />
                )}
                {!compact && <span>{modeFilter === 'all' ? 'Mode' : modeLabel(modeFilter)}</span>}
                {!compact && <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />}
                {modeFilter !== 'all' && (
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuRadioGroup value={modeFilter} onValueChange={(value) => setModeFilter(value as ModeFilter)}>
                <DropdownMenuRadioItem value="all">All modes</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="manual">Manual</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="orchestrator">Orchestrator</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="planning">Plan</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Refresh activity"
            title="Refresh"
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', (loading || refreshing) && 'animate-spin motion-reduce:animate-none')} />
          </Button>
        </div>

        <div className="grid w-full grid-cols-4 rounded-lg bg-muted/40 p-0.5 text-[11px]" role="group" aria-label="Filter by status">
          {([
            { id: 'all', label: 'All', count: 0 },
            { id: 'attention', label: compact ? 'Alert' : 'Attention', count: statusCounts.attention },
            { id: 'running', label: compact ? 'Live' : 'Active', count: statusCounts.running },
            { id: 'done', label: 'Done', count: 0 },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={statusFilter === tab.id}
              onClick={() => setStatusFilter(tab.id)}
              className={cn(
                'flex min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 py-1 font-medium transition-colors',
                statusFilter === tab.id
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="truncate">{tab.label}</span>
              {tab.count > 0 && (
                <span
                  className={cn(
                    'shrink-0 text-[10px] tabular-nums',
                    tab.id === 'attention'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-emerald-600 dark:text-emerald-400',
                  )}
                >
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {(error || actionError) && (
        <div role="alert" className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 truncate">{actionError || error}</span>
          <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => { setActionError(null); void refresh(); }}>
            Retry
          </Button>
        </div>
      )}

      <ScrollArea className="min-h-0 w-full flex-1 overflow-x-hidden [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:w-full [&_[data-radix-scroll-area-viewport]>div]:min-w-0 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:w-full [&_[data-slot=scroll-area-viewport]>div]:min-w-0">
        <div className={cn('w-full min-w-0 overflow-hidden', compact ? 'space-y-3 p-2' : 'space-y-4 p-3')}>
          {loading && items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-xs text-muted-foreground" role="status">
              <Loader2 className="mb-2 h-5 w-5 animate-spin text-primary" />
              Loading activity…
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex w-full min-w-0 flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-12 text-center">
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
                <section aria-label="Needs Attention" className="w-full min-w-0 space-y-1.5 overflow-hidden">
                  <div className="flex min-w-0 items-center justify-between gap-2 px-0.5">
                    <h2 className="flex min-w-0 items-center gap-1.5 truncate text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">Needs Attention</span>
                    </h2>
                    <Badge variant="warning" className="h-4 shrink-0 px-1.5 text-[10px] tabular-nums">
                      {attentionItems.length}
                    </Badge>
                  </div>
                  <div className="w-full min-w-0 space-y-1.5">
                    {attentionItems.map((item) => {
                      const attentionBadge = formatAttentionBadge(item, now, compact);
                      if (compact) {
                        return (
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
                            className="group/row flex w-full min-w-0 cursor-pointer flex-col gap-0.5 overflow-hidden rounded-lg border border-amber-500/25 border-l-2 border-l-amber-500 bg-amber-500/[0.05] px-2 py-1.5 text-left transition-colors hover:border-amber-500/45 hover:bg-amber-500/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <div className="flex min-w-0 items-center gap-1.5">
                              <ItemLeadingIcon item={item} className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{item.title}</span>
                              <span
                                className={cn(
                                  'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
                                  attentionBadge.isError
                                    ? 'bg-destructive/15 text-destructive'
                                    : 'bg-amber-500/20 text-amber-700 dark:text-amber-300',
                                )}
                              >
                                {attentionBadge.label}
                              </span>
                              {renderRowMenu(item, true)}
                            </div>
                            {item.attention?.preview && (
                              <p className="min-w-0 truncate pl-5 text-[11px] text-foreground/80">
                                {item.attention.preview}
                              </p>
                            )}
                            <span className="min-w-0 truncate pl-5 text-[10px] text-muted-foreground">
                              {item.workspaceName}
                            </span>
                          </div>
                        );
                      }

                      return (
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
                          className="group/row flex w-full min-w-0 cursor-pointer flex-col gap-1.5 overflow-hidden rounded-xl border border-amber-500/35 bg-amber-500/[0.07] p-2.5 text-left transition-colors hover:border-amber-500/55 hover:bg-amber-500/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <div className="flex min-w-0 items-start gap-2">
                            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
                              <ItemLeadingIcon item={item} className="h-3.5 w-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center justify-between gap-1.5">
                                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{item.title}</span>
                                <span
                                  className={cn(
                                    'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
                                    attentionBadge.isError
                                      ? 'bg-destructive/15 text-destructive'
                                      : 'bg-amber-500/20 text-amber-700 dark:text-amber-300',
                                  )}
                                >
                                  {attentionBadge.label}
                                </span>
                              </div>
                              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                <span className="max-w-[110px] truncate rounded bg-background/70 px-1.5 py-0.5 font-medium text-foreground/80">
                                  {item.workspaceName}
                                </span>
                                <span className="shrink-0">{modeLabel(item.mode)}</span>
                              </div>
                            </div>
                            {renderRowMenu(item)}
                          </div>
                          {item.attention?.preview && (
                            <p className="line-clamp-2 min-w-0 pl-7 text-[11px] leading-snug text-foreground/85">
                              {item.attention.preview}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {runningItems.length > 0 && (
                <section aria-label="Active Agents" className="w-full min-w-0 space-y-1.5 overflow-hidden">
                  <div className="flex min-w-0 items-center justify-between gap-2 px-0.5">
                    <h2 className="flex min-w-0 items-center gap-1.5 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none" />
                      <span className="truncate">Active Agents</span>
                    </h2>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{runningItems.length}</span>
                  </div>
                  <div className="w-full min-w-0 space-y-1.5">
                    {runningItems.map((item) => {
                      if (compact) {
                        return (
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
                            className="group/row flex w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg border border-border/60 bg-background/50 px-2 py-1.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <ItemLeadingIcon item={item} className="h-4 w-4 shrink-0 text-primary" />
                            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{item.title}</span>
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none" />
                              {formatLiveClock(item.startedAt || item.updatedAt, now)}
                            </span>
                            {renderRowMenu(item, true)}
                          </div>
                        );
                      }

                      return (
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
                          className="group/row flex w-full min-w-0 cursor-pointer items-start gap-2 overflow-hidden rounded-xl border border-border bg-background/70 p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                            <ItemLeadingIcon item={item} className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center justify-between gap-2">
                              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{item.title}</span>
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none" />
                                {formatLiveClock(item.startedAt || item.updatedAt, now)}
                              </span>
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                              <span className="max-w-[110px] truncate rounded bg-muted px-1.5 py-0.5 font-medium text-foreground/80">
                                {item.workspaceName}
                              </span>
                              <span className="shrink-0">{modeLabel(item.mode)}</span>
                              <span className="shrink-0">·</span>
                              <span className="min-w-0 truncate">
                                {item.activeCount > 1 ? `${item.activeCount} active` : item.statusLabel}
                              </span>
                            </div>
                          </div>
                          {renderRowMenu(item)}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {historyItems.length > 0 && (
                <section aria-label="Pinned and History" className="w-full min-w-0 space-y-1.5 overflow-hidden">
                  <div className="flex min-w-0 items-center justify-between gap-2 px-0.5">
                    <h2 className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {compact ? 'History' : 'Pinned & History'}
                    </h2>
                    {clearableCount > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => setClearConfirmOpen((prev) => !prev)}
                      >
                        {compact ? 'Clear' : 'Clear completed'}
                      </Button>
                    )}
                  </div>

                  {clearConfirmOpen && clearableCount > 0 && (
                    <div className="flex w-full min-w-0 flex-col gap-2 rounded-xl border border-border bg-muted/40 p-2.5 text-xs">
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

                  <div className={cn('w-full min-w-0', compact ? 'space-y-0.5' : 'space-y-1')}>
                    {historyItems.map((item) => {
                      if (compact) {
                        return (
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
                              'group/row flex w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              item.unreadCompletion
                                ? 'bg-primary/[0.05] hover:bg-primary/[0.09]'
                                : 'hover:bg-accent/40',
                            )}
                          >
                            <ItemLeadingIcon item={item} className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-1">
                                {item.pinnedAt && (
                                  <Pin className="h-3 w-3 shrink-0 text-primary" aria-label="Pinned" />
                                )}
                                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                                  {item.title}
                                </span>
                              </div>
                              <div className="truncate text-[10px] text-muted-foreground">
                                {item.workspaceName} · {formatRelativeTime(item.updatedAt, now)}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              {item.unreadCompletion && (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="New completion" />
                              )}
                              <StateGlyph state={item.state} />
                              {renderRowMenu(item, true)}
                            </div>
                          </div>
                        );
                      }

                      return (
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
                            'group/row flex w-full min-w-0 cursor-pointer items-start gap-2 overflow-hidden rounded-xl border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            item.unreadCompletion
                              ? 'border-primary/30 bg-primary/[0.04] hover:bg-primary/[0.08]'
                              : 'border-transparent hover:border-border hover:bg-accent/40',
                          )}
                        >
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground">
                            <ItemLeadingIcon item={item} className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
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
                            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
                              <span className="max-w-[110px] truncate rounded bg-muted/70 px-1.5 py-0.5 font-medium text-foreground/75">
                                {item.workspaceName}
                              </span>
                              <span className="shrink-0">{modeLabel(item.mode)}</span>
                              {item.durationMs !== null && item.durationMs > 0 && (
                                <>
                                  <span className="shrink-0">·</span>
                                  <span className="shrink-0 tabular-nums">{formatDurationCompact(item.durationMs)}</span>
                                </>
                              )}
                              <span className="shrink-0">·</span>
                              <span className="shrink-0 tabular-nums">{formatRelativeTime(item.updatedAt, now)}</span>
                            </div>
                          </div>
                          {renderRowMenu(item)}
                        </div>
                      );
                    })}
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
              {deleteOtherTarget?.mode === 'planning' ? 'Remove from activity?' : 'Delete conversation?'}
            </DialogTitle>
            <DialogDescription>
              {deleteOtherTarget?.mode === 'planning'
                ? 'This removes the planning chat from Activity history. Your plan documents and board stay untouched.'
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
              {deleteOtherTarget?.mode === 'planning' ? 'Remove' : 'Delete conversation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

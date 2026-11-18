import { useEffect } from 'react';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type {
  ActivityManualAgentSnapshot,
  ActivityMode,
  ActivityState,
  ActivitySummaryItem,
  ActivitySummaryResponse,
  ActivityTarget,
} from '@/lib/activity-types';
import { apiRequest } from '@/lib/api-client';
import { isTauriRuntime } from '@/lib/secure-storage';
import { markManualClosed, useManualActivity } from '@/components/manual/manual-activity';
import type { TerminalSnapshot } from '@/components/manual/manual-terminal';
import { useAccountStore } from '@/stores/account-store';
import { useManualStore } from '@/stores/manual-store';
import { useMissionStore } from '@/stores/mission-store';
import { usePlanningStore } from '@/stores/planning-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

export interface ManualTerminalObservation {
  lifecycle?: string;
  state?: string;
}

const TERMINAL_STATES = new Set<ActivityState>(['completed', 'failed', 'cancelled', 'idle']);

export function computeActivityCounts(items: ActivitySummaryItem[]): ActivitySummaryResponse['counts'] {
  let attention = 0;
  let running = 0;
  let unreadCompleted = 0;
  for (const item of items) {
    if (item.state === 'attention') attention += 1;
    else if (item.state === 'running') running += 1;
    if (item.unreadCompletion && item.state === 'completed') unreadCompleted += 1;
  }
  return {
    attention,
    running,
    unreadCompleted,
    total: items.length,
  };
}

export function sortActivityItems(items: ActivitySummaryItem[]): ActivitySummaryItem[] {
  const rank = (item: ActivitySummaryItem): number => {
    if (item.state === 'attention') return 0;
    if (item.state === 'running') return 1;
    if (item.pinnedAt) return 2;
    return 3;
  };
  return [...items].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    if (a.pinnedAt && b.pinnedAt && a.pinnedAt !== b.pinnedAt) {
      return b.pinnedAt.localeCompare(a.pinnedAt);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function reconcileActivitySummary(
  summary: ActivitySummaryResponse,
  terminalStates: Record<string, ManualTerminalObservation>,
  isNative: boolean,
): ActivitySummaryResponse {
  if (!isNative) {
    return {
      ...summary,
      counts: computeActivityCounts(summary.items),
    };
  }

  const items = summary.items.map((item) => {
    if (item.mode !== 'manual' || !item.manualAgents?.length) return item;

    const hasDuration = (item.durationMs !== null && item.durationMs !== undefined && item.durationMs > 0) || Boolean(item.completedAt);
    const reconciledAgents: ActivityManualAgentSnapshot[] = item.manualAgents.map((agent) => {
      const obs = terminalStates[agent.id];
      const isOpen = obs?.lifecycle === 'open';
      if (!isOpen && (agent.rawState === 'working' || agent.rawState === 'attention')) {
        return {
          ...agent,
          rawState: hasDuration ? 'completed' : 'ready',
          attentionPreview: undefined,
        };
      }
      return agent;
    });

    const attentionAgent = reconciledAgents.find((agent) => agent.rawState === 'attention');
    const workingAgents = reconciledAgents.filter((agent) => agent.rawState === 'working');
    const anyOpen = reconciledAgents.some((agent) => terminalStates[agent.id]?.lifecycle === 'open');

    if (attentionAgent) {
      return {
        ...item,
        manualAgents: reconciledAgents,
        state: 'attention' as const,
        activeCount: workingAgents.length,
        attention: item.attention ?? {
          kind: 'blocked',
          preview: attentionAgent.attentionPreview || 'Needs attention',
          sinceAt: item.updatedAt,
          agentId: attentionAgent.id,
        },
      };
    }

    if (workingAgents.length > 0) {
      return {
        ...item,
        manualAgents: reconciledAgents,
        state: 'running' as const,
        activeCount: workingAgents.length,
        attention: null,
        statusLabel: workingAgents.length === 1 ? 'Running' : `${workingAgents.length} active`,
      };
    }

    if (item.state === 'attention' || item.state === 'running') {
      const nextState: ActivityState = hasDuration ? 'completed' : 'idle';
      return {
        ...item,
        manualAgents: reconciledAgents,
        state: nextState,
        activeCount: 0,
        attention: null,
        startedAt: null,
        statusLabel: nextState === 'completed' ? 'Completed' : anyOpen ? 'Ready' : 'Session closed',
      };
    }

    return {
      ...item,
      manualAgents: reconciledAgents,
    };
  });

  return {
    ...summary,
    items,
    counts: computeActivityCounts(items),
  };
}

export function isClearableActivityItem(
  item: ActivitySummaryItem,
  scopeWorkspaceId?: string | null,
  mode?: ActivityMode | 'all',
): boolean {
  if (item.pinnedAt) return false;
  if (!TERMINAL_STATES.has(item.state)) return false;
  if (scopeWorkspaceId && item.workspaceId !== scopeWorkspaceId) return false;
  if (mode && mode !== 'all' && item.mode !== mode) return false;
  return true;
}

interface ActivityStoreState {
  items: ActivitySummaryItem[];
  counts: ActivitySummaryResponse['counts'];
  generatedAt: string | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  togglePin: (itemKey: string, pinned: boolean) => Promise<void>;
  markSeen: (itemKey: string) => Promise<void>;
  renameItem: (target: ActivityTarget, title: string) => Promise<void>;
  clearCompleted: (scopeWorkspaceId?: string | null, mode?: ActivityMode | 'all') => Promise<number>;
}

const EMPTY_COUNTS: ActivitySummaryResponse['counts'] = {
  attention: 0,
  running: 0,
  unreadCompleted: 0,
  total: 0,
};

let refreshSequence = 0;

async function collectManualTerminalObservations(items: ActivitySummaryItem[]): Promise<Record<string, ManualTerminalObservation>> {
  const cached = useManualActivity.getState().agents;
  const result: Record<string, ManualTerminalObservation> = {};
  const idsToProbe: string[] = [];
  const now = Date.now();

  for (const item of items) {
    if (item.mode !== 'manual' || !item.manualAgents?.length) continue;
    for (const agent of item.manualAgents) {
      const entry = cached[agent.id];
      if (entry) {
        result[agent.id] = { lifecycle: entry.lifecycle, state: entry.state };
      }
      const stale = !entry || (now - entry.checkedAt > 10_000);
      if (stale || agent.rawState === 'working' || agent.rawState === 'attention') {
        idsToProbe.push(agent.id);
      }
    }
  }

  const uniqueIds = [...new Set(idsToProbe)];
  for (let i = 0; i < uniqueIds.length; i += 6) {
    const batch = uniqueIds.slice(i, i + 6);
    await Promise.all(batch.map(async (id) => {
      try {
        const snapshot = await invoke<TerminalSnapshot>('manual_terminal_snapshot', { id, after: 0, statusOnly: true });
        result[id] = { lifecycle: snapshot.status, state: result[id]?.state };
      } catch {
        result[id] = { lifecycle: 'closed', state: 'unknown' };
      }
    }));
  }

  return result;
}

export const useActivityStore = create<ActivityStoreState>((set, get) => ({
  items: [],
  counts: EMPTY_COUNTS,
  generatedAt: null,
  loading: false,
  refreshing: false,
  error: null,

  refresh: async () => {
    const seq = ++refreshSequence;
    const isInitial = get().generatedAt === null;
    set(isInitial ? { loading: true } : { refreshing: true });
    try {
      const summary = await apiRequest<ActivitySummaryResponse>('/activity/summary');
      if (seq !== refreshSequence) return;
      const native = isTauriRuntime();
      const observations = native ? await collectManualTerminalObservations(summary.items) : {};
      if (seq !== refreshSequence) return;
      const reconciled = reconcileActivitySummary(summary, observations, native);
      set({
        items: reconciled.items,
        counts: reconciled.counts,
        generatedAt: reconciled.generatedAt,
        loading: false,
        refreshing: false,
        error: null,
      });
    } catch (error) {
      if (seq !== refreshSequence) return;
      set({
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : 'Could not load activity summary.',
      });
    }
  },

  togglePin: async (itemKey, pinned) => {
    const pinnedAt = pinned ? new Date().toISOString() : null;
    set((state) => {
      const items = sortActivityItems(
        state.items.map((item) => item.itemKey === itemKey ? { ...item, pinnedAt } : item),
      );
      return { items, counts: computeActivityCounts(items) };
    });
    try {
      await apiRequest('/activity/meta', {
        method: 'PUT',
        body: JSON.stringify({ itemKey, pinned }),
      });
    } finally {
      await get().refresh();
    }
  },

  markSeen: async (itemKey) => {
    const targetItem = get().items.find((item) => item.itemKey === itemKey);
    if (!targetItem || !targetItem.unreadCompletion) return;
    set((state) => {
      const items = state.items.map((item) => (
        item.itemKey === itemKey ? { ...item, unreadCompletion: false } : item
      ));
      return { items, counts: computeActivityCounts(items) };
    });
    try {
      await apiRequest('/activity/meta', {
        method: 'PUT',
        body: JSON.stringify({ itemKey, markSeen: true }),
      });
    } catch {
      // Non-fatal: next poll reconciles authoritative last_seen_at.
    }
  },

  renameItem: async (target, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    await apiRequest('/activity/rename', {
      method: 'PATCH',
      body: JSON.stringify({ target, title: trimmed }),
    });

    if (target.mode === 'manual' && target.conversationId) {
      const manualState = useManualStore.getState();
      const existing = manualState.conversations[target.workspaceId];
      if (existing) {
        useManualStore.setState({
          conversations: {
            ...manualState.conversations,
            [target.workspaceId]: existing.map((conv) => (
              conv.id === target.conversationId ? { ...conv, title: trimmed } : conv
            )),
          },
        });
      }
    } else if (target.mode === 'orchestrator' && target.missionId) {
      useMissionStore.setState((state) => ({
        missions: state.missions.map((mission) => (
          mission.id === target.missionId ? { ...mission, title: trimmed } : mission
        )),
      }));
    } else if (target.mode === 'planning' && target.planId) {
      void usePlanningStore.getState().refresh(target.workspaceId);
    }

    await get().refresh();
  },

  clearCompleted: async (scopeWorkspaceId, mode) => {
    const candidates = get().items.filter((item) => isClearableActivityItem(item, scopeWorkspaceId, mode));
    const closedManualConversationIds: string[] = [];
    const affectedWorkspaces = new Set<string>();
    const native = isTauriRuntime();

    for (const item of candidates) {
      affectedWorkspaces.add(item.workspaceId);
      if (item.mode === 'manual' && item.target.conversationId) {
        const conversationId = item.target.conversationId;
        const hasActiveAgent = (item.manualAgents || []).some(
          (agent) => agent.rawState === 'working' || agent.rawState === 'attention',
        );
        if (hasActiveAgent) continue;

        const storeConversations = useManualStore.getState().conversations[item.workspaceId] || [];
        const storeConversation = storeConversations.find((conv) => conv.id === conversationId);
        const agentIds = new Set<string>([
          ...(item.manualAgents || []).map((agent) => agent.id),
          ...(storeConversation?.agents.map((agent) => agent.id) || []),
        ]);

        if (native) {
          for (const agentId of agentIds) {
            try {
              await invoke('manual_terminal_close', { id: agentId });
            } catch {
              // Terminal may already be closed or never spawned.
            }
            markManualClosed(agentId);
          }
          try {
            const { disposeManualTerminal } = await import('@/components/manual/manual-terminal');
            agentIds.forEach((agentId) => disposeManualTerminal(agentId));
          } catch {
            // Optional terminal cache cleanup.
          }
        }
        closedManualConversationIds.push(conversationId);
      }
    }

    const result = await apiRequest<{ clearedCount: number }>('/activity/clear-completed', {
      method: 'POST',
      body: JSON.stringify({
        ...(scopeWorkspaceId ? { workspaceId: scopeWorkspaceId } : {}),
        ...(mode && mode !== 'all' ? { mode } : {}),
        closedManualConversationIds,
      }),
    });

    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (activeWorkspaceId) affectedWorkspaces.add(activeWorkspaceId);

    await Promise.allSettled([
      ...[...affectedWorkspaces].map((workspaceId) => useManualStore.getState().refresh(workspaceId)),
      useMissionStore.getState().fetchMissions(activeWorkspaceId || undefined),
      get().refresh(),
    ]);

    return result.clearedCount ?? 0;
  },
}));

export function useActivityMonitor(): void {
  const serviceOnline = useAccountStore((state) => state.serviceOnline);

  useEffect(() => {
    if (!serviceOnline) return undefined;
    let disposed = false;
    let timer: number | null = null;

    const tick = async () => {
      if (disposed) return;
      if (document.visibilityState !== 'hidden') {
        await useActivityStore.getState().refresh();
      }
      if (!disposed) {
        timer = window.setTimeout(() => void tick(), 3_000);
      }
    };

    const onFocus = () => {
      if (!disposed) void useActivityStore.getState().refresh();
    };

    void tick();
    window.addEventListener('focus', onFocus);

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [serviceOnline]);
}

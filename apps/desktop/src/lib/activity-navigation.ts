import type { ActivityTarget } from '@/lib/activity-types';
import { apiRequest } from '@/lib/api-client';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useManualStore } from '@/stores/manual-store';
import { useMissionStore } from '@/stores/mission-store';
import { useAgentStore } from '@/stores/agent-store';
import { usePlanningStore } from '@/stores/planning-store';
import { planningChatKey, usePlanningChatStore } from '@/stores/planning-chat-store';
import { useSettingsStore } from '@/stores/settings-store';

export async function navigateToActivityTarget(target: ActivityTarget): Promise<void> {
  const workspaceStore = useWorkspaceStore.getState();
  const manualStore = useManualStore.getState();
  const settingsStore = useSettingsStore.getState();

  manualStore.setCreating(false);
  usePlanningStore.getState().setCreating(false);

  if (target.mode === 'orchestrator' && target.missionId) {
    // Remember mission BEFORE switching workspace so Sidebar's activeWorkspaceId
    // effect does not restore an older lastMissionByWorkspace over our target.
    workspaceStore.rememberMission(target.workspaceId, target.missionId);
    if (workspaceStore.activeWorkspaceId !== target.workspaceId) {
      workspaceStore.setActiveWorkspace(target.workspaceId);
    }
    useManualStore.getState().setMode('orchestrator');
    useMissionStore.getState().setActiveMission(target.missionId);
    settingsStore.setActiveView('chat');
    if (target.agentId) {
      const agentId = target.agentId;
      window.setTimeout(() => {
        if (useMissionStore.getState().activeMissionId === target.missionId) {
          useAgentStore.getState().setSelectedAgent(agentId);
        }
      }, 120);
    }
    return;
  }

  if (target.mode === 'manual' && target.conversationId) {
    if (workspaceStore.activeWorkspaceId !== target.workspaceId) {
      workspaceStore.setActiveWorkspace(target.workspaceId);
    }
    let conversations = useManualStore.getState().conversations[target.workspaceId];
    if (!conversations || !conversations.some((item) => item.id === target.conversationId)) {
      await useManualStore.getState().refresh(target.workspaceId);
      conversations = useManualStore.getState().conversations[target.workspaceId];
    }
    const conversation = (conversations || []).find((item) => item.id === target.conversationId);
    if (conversation) {
      useManualStore.getState().select(conversation);
      if (target.agentId) {
        useManualStore.getState().hideAgent(target.agentId, false);
        useManualStore.getState().selectAgent(conversation.id, target.agentId);
      }
    } else {
      useManualStore.getState().setMode('manual');
    }
    settingsStore.setActiveView('chat');
    return;
  }

  if (target.mode === 'planning' && target.planId) {
    if (workspaceStore.activeWorkspaceId !== target.workspaceId) {
      workspaceStore.setActiveWorkspace(target.workspaceId);
    }
    const existingPlans = usePlanningStore.getState().plans[target.workspaceId];
    if (!existingPlans || !existingPlans.some((plan) => plan.id === target.planId)) {
      void usePlanningStore.getState().refresh(target.workspaceId);
    }
    usePlanningStore.getState().select(target.workspaceId, target.planId);
    usePlanningStore.getState().setChatHidden(target.workspaceId, false);
    if (target.conversationId) {
      if (target.conversationId !== 'default') {
        void apiRequest(
          `/planning/${encodeURIComponent(target.workspaceId)}/plans/${encodeURIComponent(target.planId)}/chat/conversations/${encodeURIComponent(target.conversationId)}`,
          { method: 'PATCH', body: JSON.stringify({ closed: false }) },
        ).catch(() => {});
      }
      usePlanningChatStore.getState().select(
        planningChatKey(target.workspaceId, target.planId),
        target.conversationId,
      );
    }
    useManualStore.getState().setMode('planning');
    settingsStore.setActiveView('chat');
  }
}

export function formatDurationCompact(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatLiveClock(startedAt: string | null | undefined, nowMs: number): string {
  if (!startedAt) return '00:00';
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) return '00:00';
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

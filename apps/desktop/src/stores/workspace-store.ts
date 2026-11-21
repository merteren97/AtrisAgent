import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiRequest } from '@/lib/api-client';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '@/lib/secure-storage';
import { useManualStore, type ManualConversation } from './manual-store';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  gitInitialized?: boolean;
  lastOpenedAt?: string | null;
  lastTeamTemplateId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  lastMissionByWorkspace: Record<string, string>;
  loading: boolean;
  error: string | null;
  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (name: string, path: string, gitInitialized?: boolean) => Promise<Workspace | null>;
  addWorkspace: (workspace: Workspace) => void;
  setActiveWorkspace: (id: string) => void;
  rememberMission: (workspaceId: string, missionId: string) => void;
  forgetMission: (workspaceId: string, missionId: string) => void;
  removeWorkspace: (id: string, removeMemory?: boolean) => Promise<void>;
  clearError: () => void;
}

// Keep only the latest GET and replay mutations it overlapped. This keeps
// unrelated projects from the refresh without undoing a confirmed local write.
let pendingFetch: { changes: Map<string, Workspace | null>; canReportError: boolean } | undefined;
let pendingMutations = 0;

function recordWorkspaceChange(id: string, workspace: Workspace | null) {
  if (!pendingFetch) return;
  pendingFetch.changes.delete(id);
  pendingFetch.changes.set(id, workspace);
}

function beginWorkspaceMutation() {
  pendingMutations += 1;
  if (pendingFetch) pendingFetch.canReportError = false;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeWorkspaceId: null,
      lastMissionByWorkspace: {},
      loading: false,
      error: null,

      clearError: () => set({ error: null }),

      fetchWorkspaces: async () => {
        const request = { changes: new Map<string, Workspace | null>(), canReportError: pendingMutations === 0 };
        pendingFetch = request;
        set({ loading: true, error: null });
        try {
          const fetched = await apiRequest<Workspace[]>('/workspaces');
          if (pendingFetch !== request) return;
          const workspaces = [
            ...Array.from(request.changes.values()).reverse().filter((workspace) => workspace !== null),
            ...fetched.filter((workspace) => !request.changes.has(workspace.id)),
          ];
          const current = get().activeWorkspaceId;
          pendingFetch = undefined;
          set({
            workspaces,
            activeWorkspaceId: current && workspaces.some((workspace) => workspace.id === current)
              ? current
              : workspaces[0]?.id || null,
            loading: pendingMutations > 0,
          });
        } catch (error: any) {
          if (pendingFetch !== request) return;
          pendingFetch = undefined;
          // A temporary gateway restart must never make a user's projects appear
          // deleted. Keep the last known navigation state and surface a degraded
          // status until the runtime supervisor reconnects and refreshes it.
          set({
            loading: pendingMutations > 0,
            ...(request.canReportError && {
              error: error?.message || 'Could not refresh workspaces from the local service. Showing the last known workspace list.',
            }),
          });
        }
      },

      createWorkspace: async (name, workspacePath, gitInitialized = false) => {
        beginWorkspaceMutation();
        set({ loading: true, error: null });
        try {
          const normalizedPath = workspacePath.trim();
          const duplicate = get().workspaces.find((workspace) => workspace.path.toLowerCase() === normalizedPath.toLowerCase());
          if (duplicate) {
            set({ activeWorkspaceId: duplicate.id });
            return duplicate;
          }

          const workspace = await apiRequest<Workspace>('/workspaces', {
            method: 'POST',
            body: JSON.stringify({ name: name.trim(), path: normalizedPath, gitInitialized }),
          });
          recordWorkspaceChange(workspace.id, workspace);
          set((state) => ({
            workspaces: [workspace, ...state.workspaces.filter((item) => item.id !== workspace.id)],
            activeWorkspaceId: workspace.id,
          }));
          return workspace;
        } catch (error: any) {
          set({ error: error?.message || 'Workspace creation failed.' });
          return null;
        } finally {
          pendingMutations -= 1;
          if (!pendingFetch && pendingMutations === 0) set({ loading: false });
        }
      },

      addWorkspace: (workspace) => {
        recordWorkspaceChange(workspace.id, workspace);
        set((state) => ({
          workspaces: [workspace, ...state.workspaces.filter((item) => item.id !== workspace.id)],
        }));
      },

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
      rememberMission: (workspaceId, missionId) => set((state) => ({
        lastMissionByWorkspace: { ...state.lastMissionByWorkspace, [workspaceId]: missionId },
      })),
      forgetMission: (workspaceId, missionId) => set((state) => {
        if (state.lastMissionByWorkspace[workspaceId] !== missionId) return state;
        const { [workspaceId]: _removed, ...lastMissionByWorkspace } = state.lastMissionByWorkspace;
        return { lastMissionByWorkspace };
      }),

      removeWorkspace: async (id, removeMemory = false) => {
        beginWorkspaceMutation();
        set({ loading: true, error: null });
        try {
          const manual = await apiRequest<ManualConversation[]>(`/manual/conversations?workspaceId=${encodeURIComponent(id)}`);
          const agents = manual.flatMap(conversation => conversation.agents);
          if (agents.length) {
            if (!isTauriRuntime()) throw new Error('Remove this project in the desktop app so its manual terminals can be checked first.');
            const states = await Promise.all(agents.map(agent => invoke<{status: string}>('manual_terminal_snapshot', { id: agent.id, after: 0, statusOnly: true })));
            if (states.some(state => state.status === 'open')) throw new Error('Close the project’s manual agents before removing it. Their sessions will not be closed automatically.');
          }
          await apiRequest(`/workspaces/${id}`, {
            method: 'DELETE',
            body: JSON.stringify({ removeMemory }),
          });
          recordWorkspaceChange(id, null);
          useManualStore.getState().forgetWorkspace(id, manual);
          set((state) => {
            const workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
            const { [id]: _removed, ...lastMissionByWorkspace } = state.lastMissionByWorkspace;
            return {
              workspaces,
              lastMissionByWorkspace,
              activeWorkspaceId: state.activeWorkspaceId === id ? workspaces[0]?.id || null : state.activeWorkspaceId,
            };
          });
        } catch (error: any) {
          const message = error?.message || 'Workspace removal failed.';
          set({ error: message });
          throw new Error(message);
        } finally {
          pendingMutations -= 1;
          if (!pendingFetch && pendingMutations === 0) set({ loading: false });
        }
      },
    }),
    {
      name: 'atris-workspace-navigation',
      version: 2,
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
        lastMissionByWorkspace: state.lastMissionByWorkspace,
      }),
    },
  ),
);

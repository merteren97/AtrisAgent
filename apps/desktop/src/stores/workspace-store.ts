import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiRequest } from '@/lib/api-client';

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
  removeWorkspace: (id: string) => Promise<void>;
  clearError: () => void;
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
        set({ loading: true, error: null });
        try {
          const workspaces = await apiRequest<Workspace[]>('/workspaces');
          const current = get().activeWorkspaceId;
          set({
            workspaces,
            activeWorkspaceId: current && workspaces.some((workspace) => workspace.id === current)
              ? current
              : workspaces[0]?.id || null,
            loading: false,
          });
        } catch (error: any) {
          set({
            workspaces: [],
            activeWorkspaceId: null,
            loading: false,
            error: error?.message || 'Could not load workspaces from the local service.',
          });
        }
      },

      createWorkspace: async (name, workspacePath, gitInitialized = false) => {
        set({ loading: true, error: null });
        try {
          const normalizedPath = workspacePath.trim();
          const duplicate = get().workspaces.find((workspace) => workspace.path.toLowerCase() === normalizedPath.toLowerCase());
          if (duplicate) {
            set({ activeWorkspaceId: duplicate.id, loading: false });
            return duplicate;
          }

          const workspace = await apiRequest<Workspace>('/workspaces', {
            method: 'POST',
            body: JSON.stringify({ name: name.trim(), path: normalizedPath, gitInitialized }),
          });
          set((state) => ({
            workspaces: [workspace, ...state.workspaces.filter((item) => item.id !== workspace.id)],
            activeWorkspaceId: workspace.id,
            loading: false,
          }));
          return workspace;
        } catch (error: any) {
          set({ loading: false, error: error?.message || 'Workspace creation failed.' });
          return null;
        }
      },

      addWorkspace: (workspace) => set((state) => ({
        workspaces: [workspace, ...state.workspaces.filter((item) => item.id !== workspace.id)],
      })),

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
      rememberMission: (workspaceId, missionId) => set((state) => ({
        lastMissionByWorkspace: { ...state.lastMissionByWorkspace, [workspaceId]: missionId },
      })),

      removeWorkspace: async (id) => {
        set({ loading: true, error: null });
        try {
          await apiRequest(`/workspaces/${id}`, { method: 'DELETE' });
          set((state) => {
            const workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
            const { [id]: _removed, ...lastMissionByWorkspace } = state.lastMissionByWorkspace;
            return {
              workspaces,
              lastMissionByWorkspace,
              activeWorkspaceId: state.activeWorkspaceId === id ? workspaces[0]?.id || null : state.activeWorkspaceId,
              loading: false,
            };
          });
        } catch (error: any) {
          set({ loading: false, error: error?.message || 'Workspace removal failed.' });
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

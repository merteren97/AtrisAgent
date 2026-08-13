import { create } from 'zustand';
import { apiRequest } from '@/lib/api-client';

export type MemoryProjectStatus = 'active' | 'detached' | 'archived';
export type MemoryNodeStatus = 'active' | 'stale' | 'superseded' | 'disputed' | 'archived';
export type MemoryNodeType =
  | 'project' | 'component' | 'file' | 'symbol' | 'research_finding' | 'decision'
  | 'change' | 'issue' | 'bug' | 'lesson' | 'mistake' | 'pattern' | 'session'
  | 'turn' | 'task' | 'agent_run' | 'test' | 'verification' | 'artifact'
  | 'external_source' | 'requirement' | 'user_constraint';

export interface MemoryProvenance {
  sourceType: string;
  sourceId?: string | null;
  missionId?: string | null;
  turnId?: string | null;
  taskId?: string | null;
  agentInstanceId?: string | null;
  path?: string | null;
  url?: string | null;
  createdBy: string;
}

export interface MemoryProject {
  id: string;
  displayName: string;
  normalizedPath?: string | null;
  repositoryFingerprint?: string | null;
  status: MemoryProjectStatus;
  createdAt: string;
  updatedAt: string;
  detachedAt?: string | null;
}

export interface MemorySpace {
  id: string;
  projectId: string;
  status: 'active' | 'archived';
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryNode {
  id: string;
  projectId: string;
  type: MemoryNodeType;
  title: string;
  summary: string;
  body?: string | null;
  status: MemoryNodeStatus;
  confidence: number;
  importance: number;
  pinned: boolean;
  tags: string[];
  provenance: MemoryProvenance[];
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string | null;
}

export interface MemoryEdge {
  id: string;
  projectId: string;
  fromNodeId: string;
  toNodeId: string;
  type: string;
  confidence: number;
  createdAt: string;
  createdBy: string;
}

export interface MemoryOverview {
  project: MemoryProject;
  space: MemorySpace | null;
  activeWorkspaceIds: string[];
  evidenceCount: number;
}

export interface MemorySnapshot extends MemoryOverview {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}

export interface MemorySearchHit {
  node: MemoryNode;
  score: number;
  lexicalScore: number;
  graphScore: number;
  confidenceScore: number;
  importanceScore: number;
  recencyScore: number;
}

export interface CreateMemoryInput {
  type?: MemoryNodeType;
  title: string;
  summary: string;
  body?: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  pinned?: boolean;
}

export type UpdateMemoryInput = Partial<Pick<MemoryNode,
  'title' | 'summary' | 'body' | 'status' | 'confidence' | 'importance' | 'pinned' | 'tags' | 'lastVerifiedAt'
>>;

interface MemoryState {
  projects: MemoryOverview[];
  snapshot: MemorySnapshot | null;
  selectedProjectId: string | null;
  selectedNodeId: string | null;
  searchHits: MemorySearchHit[];
  loading: boolean;
  mutating: boolean;
  error: string | null;
  fetchProjects: () => Promise<MemoryOverview[]>;
  loadWorkspaceMemory: (workspaceId: string) => Promise<MemorySnapshot | null>;
  loadProject: (projectId: string) => Promise<MemorySnapshot | null>;
  refreshSelectedProject: () => Promise<void>;
  selectProject: (projectId: string | null) => void;
  selectNode: (nodeId: string | null) => void;
  search: (query: string, types?: MemoryNodeType[], statuses?: MemoryNodeStatus[]) => Promise<void>;
  clearSearch: () => void;
  createMemory: (input: CreateMemoryInput) => Promise<MemoryNode | null>;
  updateMemory: (nodeId: string, updates: UpdateMemoryInput) => Promise<MemoryNode | null>;
  deleteMemory: (nodeId: string) => Promise<boolean>;
  archiveProject: (projectId: string) => Promise<boolean>;
  restoreProject: (projectId: string) => Promise<boolean>;
  deleteProjectMemory: (projectId: string) => Promise<boolean>;
  exportProject: (projectId: string, targetPath: string) => Promise<{ path: string; bytes: number } | null>;
  clearError: () => void;
}

function upsertProject(projects: MemoryOverview[], overview: MemoryOverview): MemoryOverview[] {
  return [overview, ...projects.filter((item) => item.project.id !== overview.project.id)]
    .sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt));
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  projects: [],
  snapshot: null,
  selectedProjectId: null,
  selectedNodeId: null,
  searchHits: [],
  loading: false,
  mutating: false,
  error: null,

  clearError: () => set({ error: null }),
  clearSearch: () => set({ searchHits: [] }),
  selectProject: (projectId) => set({ selectedProjectId: projectId, selectedNodeId: null, searchHits: [] }),
  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  fetchProjects: async () => {
    try {
      const projects = await apiRequest<MemoryOverview[]>('/memory/projects');
      set({ projects, error: null });
      return projects;
    } catch (error: any) {
      set({ error: error?.message || 'Could not load project memory spaces.' });
      return [];
    }
  },

  loadWorkspaceMemory: async (workspaceId) => {
    set({ loading: true, error: null, searchHits: [] });
    try {
      const snapshot = await apiRequest<MemorySnapshot>(`/memory/workspaces/${workspaceId}`);
      set((state) => ({
        snapshot,
        selectedProjectId: snapshot.project.id,
        selectedNodeId: state.selectedNodeId && snapshot.nodes.some((node) => node.id === state.selectedNodeId) ? state.selectedNodeId : null,
        projects: upsertProject(state.projects, snapshot),
        loading: false,
      }));
      return snapshot;
    } catch (error: any) {
      set({ loading: false, error: error?.message || 'Could not load project memory.' });
      return null;
    }
  },

  loadProject: async (projectId) => {
    set({ loading: true, error: null, searchHits: [] });
    try {
      const snapshot = await apiRequest<MemorySnapshot>(`/memory/projects/${projectId}`);
      set((state) => ({
        snapshot,
        selectedProjectId: projectId,
        selectedNodeId: state.selectedNodeId && snapshot.nodes.some((node) => node.id === state.selectedNodeId) ? state.selectedNodeId : null,
        projects: upsertProject(state.projects, snapshot),
        loading: false,
      }));
      return snapshot;
    } catch (error: any) {
      set({ loading: false, error: error?.message || 'Could not load project memory.' });
      return null;
    }
  },

  refreshSelectedProject: async () => {
    const projectId = get().selectedProjectId;
    if (projectId) await get().loadProject(projectId);
  },

  search: async (query, types = [], statuses = []) => {
    const projectId = get().selectedProjectId;
    const text = query.trim();
    if (!projectId || !text) {
      set({ searchHits: [] });
      return;
    }
    try {
      const params = new URLSearchParams({ q: text, limit: '80' });
      if (types.length) params.set('types', types.join(','));
      if (statuses.length) params.set('statuses', statuses.join(','));
      if (get().snapshot?.project.status === 'archived') params.set('includeArchived', 'true');
      const searchHits = await apiRequest<MemorySearchHit[]>(`/memory/projects/${projectId}/search?${params}`);
      set({ searchHits, error: null });
    } catch (error: any) {
      set({ error: error?.message || 'Memory search failed.' });
    }
  },

  createMemory: async (input) => {
    const projectId = get().selectedProjectId;
    if (!projectId) return null;
    set({ mutating: true, error: null });
    try {
      const node = await apiRequest<MemoryNode>(`/memory/projects/${projectId}/nodes`, { method: 'POST', body: JSON.stringify(input) });
      await get().loadProject(projectId);
      set({ mutating: false, selectedNodeId: node.id });
      return node;
    } catch (error: any) {
      set({ mutating: false, error: error?.message || 'Could not create memory note.' });
      return null;
    }
  },

  updateMemory: async (nodeId, updates) => {
    set({ mutating: true, error: null });
    try {
      const node = await apiRequest<MemoryNode>(`/memory/nodes/${nodeId}`, { method: 'PATCH', body: JSON.stringify(updates) });
      set((state) => ({
        snapshot: state.snapshot ? { ...state.snapshot, nodes: state.snapshot.nodes.map((item) => item.id === node.id ? node : item) } : null,
        mutating: false,
      }));
      return node;
    } catch (error: any) {
      set({ mutating: false, error: error?.message || 'Could not update memory note.' });
      return null;
    }
  },

  deleteMemory: async (nodeId) => {
    set({ mutating: true, error: null });
    try {
      await apiRequest(`/memory/nodes/${nodeId}`, { method: 'DELETE' });
      const projectId = get().selectedProjectId;
      if (projectId) await get().loadProject(projectId);
      set({ mutating: false, selectedNodeId: null });
      return true;
    } catch (error: any) {
      set({ mutating: false, error: error?.message || 'Could not delete memory note.' });
      return false;
    }
  },

  archiveProject: async (projectId) => {
    set({ mutating: true, error: null });
    try {
      await apiRequest(`/memory/projects/${projectId}/archive`, { method: 'POST' });
      await get().loadProject(projectId);
      await get().fetchProjects();
      set({ mutating: false });
      return true;
    } catch (error: any) {
      set({ mutating: false, error: error?.message || 'Could not archive project memory.' });
      return false;
    }
  },

  restoreProject: async (projectId) => {
    set({ mutating: true, error: null });
    try {
      await apiRequest(`/memory/projects/${projectId}/restore`, { method: 'POST' });
      await get().loadProject(projectId);
      await get().fetchProjects();
      set({ mutating: false });
      return true;
    } catch (error: any) {
      set({ mutating: false, error: error?.message || 'Could not restore project memory.' });
      return false;
    }
  },

  deleteProjectMemory: async (projectId) => {
    set({ mutating: true, error: null });
    try {
      await apiRequest(`/memory/projects/${projectId}`, { method: 'DELETE' });
      const projects = await get().fetchProjects();
      const next = projects[0]?.project.id || null;
      if (get().selectedProjectId === projectId) {
        set({ selectedProjectId: next, snapshot: null, selectedNodeId: null, searchHits: [] });
        if (next) await get().loadProject(next);
      }
      set({ mutating: false });
      return true;
    } catch (error: any) {
      set({ mutating: false, error: error?.message || 'Could not delete project memory.' });
      return false;
    }
  },

  exportProject: async (projectId, targetPath) => {
    set({ mutating: true, error: null });
    try {
      const result = await apiRequest<{ success: true; path: string; bytes: number }>(`/memory/projects/${projectId}/export`, {
        method: 'POST',
        body: JSON.stringify({ targetPath }),
      });
      set({ mutating: false });
      return { path: result.path, bytes: result.bytes };
    } catch (error: any) {
      set({ mutating: false, error: error?.message || 'Could not export project memory.' });
      return null;
    }
  },
}));

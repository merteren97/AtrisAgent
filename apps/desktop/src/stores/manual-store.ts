import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiRequest } from '@/lib/api-client';

export interface ManualAgent {
  id: string; conversationId: string; name: string; catalogId: string; runtimeType: string;
  model: string; accountProfileId: string; providerSessionId: string; cwd: string; createdAt: string;
}
export interface ManualConversation { id: string; workspaceId: string; title: string; createdAt: string; agents: ManualAgent[] }
export interface ManualMessage { id: string; role: 'user' | 'assistant' | 'tool'; text: string; toolName?: string; failed?: boolean }
export type ManualMode = 'choose' | 'manual' | 'orchestrator';
interface ManualState {
  creating: boolean;
  setCreating: (creating: boolean) => void;
  mode: ManualMode;
  conversations: Record<string, ManualConversation[]>;
  activeByWorkspace: Record<string, string>;
  agentByConversation: Record<string, string>;
  surfaceByConversation: Record<string, 'chat' | 'code'>;
  layoutByConversation: Record<string, number>;
  setLayout: (conversationId: string, panes: number) => void;
  drafts: Record<string, string>;
  error: string | null;
  setMode: (mode: ManualMode) => void;
  select: (conversation: ManualConversation) => void;
  selectAgent: (conversationId: string, id: string) => void;
  setSurface: (conversationId: string, surface: 'chat' | 'code') => void;
  setDraft: (id: string, text: string) => void;
  refresh: (workspaceId: string) => Promise<void>;
  create: (workspaceId: string, title: string, id: string) => Promise<ManualConversation>;
  addAgent: (conversationId: string, name: string, catalogId: string, id: string) => Promise<ManualAgent>;
  addAgents: (conversationId: string, agents: Array<{id: string; name: string; catalogId: string}>) => Promise<ManualAgent[]>;
}
const fetchVersions = new Map<string, number>();
export function migrateManualNavigation(persisted: unknown) {
  const previous = (persisted || {}) as Partial<ManualState>;
  return { mode: 'choose' as ManualMode, activeByWorkspace: previous.activeByWorkspace || {},
    agentByConversation: previous.agentByConversation || {}, surfaceByConversation: previous.surfaceByConversation || {} };
}
export const useManualStore = create<ManualState>()(persist((set, get) => ({
  creating: false, setCreating: creating => set({ creating }),
  mode: 'choose', conversations: {}, activeByWorkspace: {}, agentByConversation: {}, surfaceByConversation: {}, drafts: {}, error: null,
  layoutByConversation: {},
  setLayout: (conversationId, panes) => set(state => ({ layoutByConversation: { ...state.layoutByConversation, [conversationId]: [1, 2, 4].includes(panes) ? panes : 1 } })),
  setMode: mode => set({ mode }),
  select: conversation => set(state => ({ mode: 'manual', activeByWorkspace: { ...state.activeByWorkspace, [conversation.workspaceId]: conversation.id } })),
  selectAgent: (conversationId, id) => set(state => ({ agentByConversation: { ...state.agentByConversation, [conversationId]: id } })),
  setSurface: (conversationId, surface) => set(state => ({ surfaceByConversation: { ...state.surfaceByConversation, [conversationId]: surface } })),
  setDraft: (id, text) => set(state => ({ drafts: { ...state.drafts, [id]: text } })),
  refresh: async workspaceId => {
    const version = (fetchVersions.get(workspaceId) || 0) + 1; fetchVersions.set(workspaceId, version);
    try {
      const conversations = await apiRequest<ManualConversation[]>(`/manual/conversations?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (fetchVersions.get(workspaceId) !== version) return;
      set(state => ({ conversations: { ...state.conversations, [workspaceId]: conversations }, error: null }));
    } catch (error) { if (fetchVersions.get(workspaceId) === version) set({ error: error instanceof Error ? error.message : 'Could not load manual conversations.' }); }
  },
  create: async (workspaceId, title, id) => {
    const conversation = await apiRequest<ManualConversation>('/manual/conversations', { method: 'POST', body: JSON.stringify({ workspaceId, title, id }) });
    // Invalidate older hydration before merging this authoritative write response.
    fetchVersions.set(workspaceId, (fetchVersions.get(workspaceId) || 0) + 1);
    set(state => ({ conversations: { ...state.conversations, [workspaceId]: [conversation, ...(state.conversations[workspaceId] || []).filter(c => c.id !== conversation.id)] } }));
    get().select(conversation);
    return conversation;
  },
  addAgent: async (conversationId, name, catalogId, id) => {
    const agent = await apiRequest<ManualAgent>(`/manual/conversations/${conversationId}/agents`, { method: 'POST', body: JSON.stringify({ name, catalogId, id }) });
    const workspaceId = Object.keys(get().conversations).find(key => get().conversations[key].some(c => c.id === conversationId));
    if (workspaceId) {
      fetchVersions.set(workspaceId, (fetchVersions.get(workspaceId) || 0) + 1);
      set(state => ({ conversations: { ...state.conversations, [workspaceId]: state.conversations[workspaceId].map(c => c.id === conversationId ? { ...c, agents: [...c.agents.filter(a => a.id !== id), agent] } : c) } }));
    }
    get().selectAgent(conversationId, agent.id);
    return agent;
  },
  addAgents: async (conversationId, inputs) => {
    const agents = await apiRequest<ManualAgent[]>(`/manual/conversations/${conversationId}/agents`, { method: 'POST', body: JSON.stringify({ agents: inputs }) });
    const workspaceId = Object.keys(get().conversations).find(key => get().conversations[key].some(c => c.id === conversationId));
    if (workspaceId) {
      fetchVersions.set(workspaceId, (fetchVersions.get(workspaceId) || 0) + 1);
      const ids = new Set(agents.map(agent => agent.id));
      set(state => ({ conversations: { ...state.conversations, [workspaceId]: state.conversations[workspaceId].map(c => c.id === conversationId ? { ...c, agents: [...c.agents.filter(agent => !ids.has(agent.id)), ...agents] } : c) } }));
    }
    if (agents[0]) get().selectAgent(conversationId, agents[0].id);
    return agents;
  },
}), { name: 'atris-manual-navigation', version: 1,
  migrate: migrateManualNavigation,
  partialize: state => ({ mode: state.mode, activeByWorkspace: state.activeByWorkspace, agentByConversation: state.agentByConversation, surfaceByConversation: state.surfaceByConversation, layoutByConversation: state.layoutByConversation }) }));

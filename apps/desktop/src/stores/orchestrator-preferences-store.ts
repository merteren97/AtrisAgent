import { useCallback, useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WorkMode, TeamLaunch } from '@atris-agent-code/domain';
import { useSettingsStore, normalizeAgentProfileSelections, type AgentProfileSelections, type TrustMode } from './settings-store';
import { useMissionStore } from './mission-store';
import { useWorkspaceStore } from './workspace-store';
import { normalizeStoredTeamTemplateId } from '@/lib/team-template-utils';

export interface OrchestratorPreferences {
  selectedModel: string;
  modelScope: 'coordinator' | 'all';
  reasoningLevel: string;
  teamTemplate: string;
  agentProfileIds: AgentProfileSelections;
  trustMode: TrustMode;
  automationSettings: { fileWrite: boolean | null; gitCommit: boolean | null; packageInstall: boolean | null };
  workMode: WorkMode;
  teamLaunch: TeamLaunch;
}

export function normalizeOrchestratorPreferences(value: Partial<OrchestratorPreferences>, base: OrchestratorPreferences): OrchestratorPreferences {
  const reasoning = typeof value.reasoningLevel === 'string' ? value.reasoningLevel.toLowerCase() : '';
  const automation = value.automationSettings && typeof value.automationSettings === 'object' && !Array.isArray(value.automationSettings) ? value.automationSettings : {};
  const permission = (key: keyof OrchestratorPreferences['automationSettings']) => {
    const candidate = (automation as Record<string, unknown>)[key];
    return candidate === null || typeof candidate === 'boolean' ? candidate : base.automationSettings[key];
  };
  return {
    selectedModel: typeof value.selectedModel === 'string' ? value.selectedModel : base.selectedModel,
    modelScope: value.modelScope === 'all' ? 'all' : value.modelScope === 'coordinator' ? 'coordinator' : base.modelScope,
    reasoningLevel: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoning) ? reasoning : base.reasoningLevel,
    teamTemplate: normalizeStoredTeamTemplateId(typeof value.teamTemplate === 'string' && value.teamTemplate ? value.teamTemplate : base.teamTemplate),
    agentProfileIds: normalizeAgentProfileSelections(value.agentProfileIds ?? base.agentProfileIds),
    trustMode: ['Review Driven', 'Balanced', 'Autonomous', 'Candidate'].includes(value.trustMode || '') ? value.trustMode! : base.trustMode,
    automationSettings: { fileWrite: permission('fileWrite'), gitCommit: permission('gitCommit'), packageInstall: permission('packageInstall') },
    workMode: ['auto', 'research', 'plan', 'execute'].includes(value.workMode || '') ? value.workMode! : base.workMode,
    teamLaunch: value.teamLaunch === 'confirm' ? 'confirm' : value.teamLaunch === 'automatic' ? 'automatic' : base.teamLaunch,
  };
}

const legacy = useSettingsStore.getState();
const INITIAL: OrchestratorPreferences = {
  selectedModel: legacy.selectedModel, reasoningLevel: legacy.reasoningLevel,
  teamTemplate: legacy.teamTemplate, agentProfileIds: legacy.agentProfileIds,
  trustMode: legacy.trustMode, automationSettings: legacy.automationSettings,
  modelScope: 'coordinator', workMode: 'auto', teamLaunch: 'automatic',
};

interface PreferenceState {
  defaults: OrchestratorPreferences;
  projects: Record<string, OrchestratorPreferences>;
  conversations: Record<string, OrchestratorPreferences>;
  drafts: Record<string, string>;
  setConversation(key: string, preferences: OrchestratorPreferences): void;
  saveDefaults(preferences: OrchestratorPreferences, workspaceId?: string): void;
  resetConversation(key: string): void;
  resetProject(workspaceId: string): void;
  setDraft(key: string, text: string): void;
}

export const useOrchestratorPreferencesStore = create<PreferenceState>()(persist((set) => ({
  defaults: INITIAL, projects: {}, conversations: {}, drafts: {},
  setConversation: (key, preferences) => set(state => ({ conversations: { ...state.conversations, [key]: normalizeOrchestratorPreferences(preferences, state.defaults) } })),
  saveDefaults: (preferences, workspaceId) => set(state => workspaceId
    ? { projects: { ...state.projects, [workspaceId]: normalizeOrchestratorPreferences(preferences, state.defaults) } }
    : { defaults: normalizeOrchestratorPreferences(preferences, state.defaults) }),
  resetConversation: key => set(state => ({ conversations: Object.fromEntries(Object.entries(state.conversations).filter(([id]) => id !== key)) })),
  resetProject: workspaceId => set(state => ({ projects: Object.fromEntries(Object.entries(state.projects).filter(([id]) => id !== workspaceId)) })),
  setDraft: (key, text) => set(state => ({ drafts: text ? { ...state.drafts, [key]: text } : Object.fromEntries(Object.entries(state.drafts).filter(([id]) => id !== key)) })),
}), {
  name: 'atris-orchestrator-preferences', version: 1,
  partialize: ({ defaults, projects, conversations, drafts }) => ({ defaults, projects, conversations, drafts }),
  merge: (persisted, current) => {
    const data = persisted && typeof persisted === 'object' ? persisted as Partial<PreferenceState> : {};
    const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const normalizeMap = (map: unknown) => Object.fromEntries(Object.entries(object(map)).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value)).map(([key, value]) => [key, normalizeOrchestratorPreferences(value as OrchestratorPreferences, INITIAL)]));
    return { ...current, defaults: normalizeOrchestratorPreferences(object(data.defaults), INITIAL), projects: normalizeMap(data.projects), conversations: normalizeMap(data.conversations), drafts: Object.fromEntries(Object.entries(object(data.drafts)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) };
  },
}));

export function useOrchestratorPreferences() {
  const workspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const missionId = useMissionStore(state => state.activeMissionId);
  const scopeKey = missionId ? `conversation:${missionId}` : `draft:${workspaceId || 'none'}`;
  const defaults = useOrchestratorPreferencesStore(state => state.defaults);
  const project = useOrchestratorPreferencesStore(state => workspaceId ? state.projects[workspaceId] : undefined);
  const conversation = useOrchestratorPreferencesStore(state => state.conversations[scopeKey]);
  const draft = useOrchestratorPreferencesStore(state => state.drafts[scopeKey] || '');
  const preferences = useMemo(() => conversation || project || defaults, [conversation, project, defaults]);
  const updatePreferences = useCallback((patch: Partial<OrchestratorPreferences>) => {
    const store = useOrchestratorPreferencesStore.getState();
    const current = store.conversations[scopeKey] || (workspaceId && store.projects[workspaceId]) || store.defaults;
    store.setConversation(scopeKey, { ...current, ...patch });
  }, [scopeKey, workspaceId]);
  const setDraft = useCallback((text: string) => useOrchestratorPreferencesStore.getState().setDraft(scopeKey, text), [scopeKey]);
  return { preferences, updatePreferences, scopeKey, workspaceId, missionId, draft, setDraft, customized: Boolean(conversation) };
}

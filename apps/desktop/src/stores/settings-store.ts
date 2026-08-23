import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AppView = 'chat' | 'dashboard' | 'settings' | 'agents' | 'projects' | 'accounts';
export type TrustMode = 'Review Driven' | 'Balanced' | 'Autonomous' | 'Candidate';
export type InspectorTab = 'plan' | 'board' | 'agents' | 'context' | 'changes' | 'checks' | 'memory' | 'artifacts' | 'activity';
export type CloseBehavior = 'quit' | 'tray';
export type UpdateBehavior = 'notify' | 'automatic';
export type TimelineDetailMode = 'summary' | 'activity' | 'telemetry';

interface SettingsState {
  hasSeenOnboarding: boolean;
  telemetryOptIn: boolean;
  devMode: boolean;
  activeView: AppView;
  selectedRole: string;
  /** Stable ModelDescriptor.catalogId. Empty means "let the scheduler resolve it". */
  selectedModel: string;
  /** Canonical lowercase reasoning value understood by runtime adapters. */
  reasoningLevel: string;
  teamTemplate: string;
  trustMode: TrustMode;
  closeBehavior: CloseBehavior;
  updateBehavior: UpdateBehavior;
  timelineDetailMode: TimelineDetailMode;
  automationSettings: {
    fileWrite: boolean | null;
    gitCommit: boolean | null;
    packageInstall: boolean | null;
  };
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  inspectorCollapsed: boolean;
  inspectorWidth: number;
  inspectorExpanded: boolean;
  inspectorTab: InspectorTab;
  commandPaletteOpen: boolean;
  setHasSeenOnboarding: (value: boolean) => void;
  setTelemetryOptIn: (value: boolean) => void;
  toggleDevMode: () => void;
  setActiveView: (view: AppView) => void;
  setSelectedRole: (role: string) => void;
  setSelectedModel: (modelCatalogId: string) => void;
  setReasoningLevel: (level: string) => void;
  setTeamTemplate: (template: string) => void;
  setTrustMode: (mode: TrustMode) => void;
  setCloseBehavior: (behavior: CloseBehavior) => void;
  setUpdateBehavior: (behavior: UpdateBehavior) => void;
  setTimelineDetailMode: (mode: TimelineDetailMode) => void;
  setAutomationSettings: (settings: Partial<SettingsState['automationSettings']>) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  toggleInspector: () => void;
  openInspector: (tab?: InspectorTab) => void;
  setInspectorWidth: (width: number) => void;
  toggleInspectorExpanded: () => void;
  setInspectorExpanded: (expanded: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setCommandPaletteOpen: (open: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      hasSeenOnboarding: false,
      telemetryOptIn: false,
      devMode: false,
      activeView: 'chat',
      selectedRole: 'Orchestrator',
      selectedModel: '',
      reasoningLevel: 'medium',
      teamTemplate: 'default-core-dev-team',
      trustMode: 'Balanced',
      closeBehavior: 'quit',
      updateBehavior: 'notify',
      timelineDetailMode: 'summary',
      automationSettings: {
        fileWrite: null,
        gitCommit: null,
        packageInstall: null,
      },
      sidebarCollapsed: false,
      sidebarWidth: 256,
      inspectorCollapsed: false,
      inspectorWidth: 320,
      inspectorExpanded: false,
      inspectorTab: 'agents',
      commandPaletteOpen: false,
      setHasSeenOnboarding: (value) => set({ hasSeenOnboarding: value }),
      setTelemetryOptIn: (value) => set({ telemetryOptIn: value }),
      toggleDevMode: () => set((state) => ({ devMode: !state.devMode })),
      setActiveView: (view) => set({ activeView: view }),
      setSelectedRole: (role) => set({ selectedRole: role }),
      setSelectedModel: (model) => set({ selectedModel: model }),
      setReasoningLevel: (level) => set({ reasoningLevel: level.toLowerCase() }),
      setTeamTemplate: (template) => set({ teamTemplate: template }),
      setTrustMode: (mode) => set({ trustMode: mode }),
      setCloseBehavior: (behavior) => set({ closeBehavior: behavior }),
      setUpdateBehavior: (behavior) => set({ updateBehavior: behavior }),
      setTimelineDetailMode: (timelineDetailMode) => set({ timelineDetailMode }),
      setAutomationSettings: (settings) =>
        set((state) => ({ automationSettings: { ...state.automationSettings, ...settings } })),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      toggleInspector: () => set((state) => ({
        inspectorCollapsed: !state.inspectorCollapsed,
        inspectorExpanded: state.inspectorCollapsed ? state.inspectorExpanded : false,
      })),
      openInspector: (tab) => set((state) => ({ inspectorCollapsed: false, inspectorTab: tab || state.inspectorTab })),
      setInspectorWidth: (width) => set({ inspectorWidth: width }),
      toggleInspectorExpanded: () => set((state) => ({
        inspectorCollapsed: false,
        inspectorExpanded: !state.inspectorExpanded,
      })),
      setInspectorExpanded: (expanded) => set({ inspectorCollapsed: false, inspectorExpanded: expanded }),
      setInspectorTab: (tab) => set({ inspectorTab: tab }),
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
    }),
    {
      name: 'atris-settings-storage',
      version: 9,
      migrate: (persistedState) => {
        const state = (persistedState || {}) as Partial<SettingsState>;
        const validInspectorTabs: InspectorTab[] = ['plan', 'board', 'agents', 'context', 'changes', 'checks', 'memory', 'artifacts', 'activity'];
        return {
          ...state,
          selectedModel: state.selectedModel?.includes(':') ? state.selectedModel : '',
          reasoningLevel: (state.reasoningLevel || 'medium').toLowerCase(),
          teamTemplate: state.teamTemplate === 'Core Dev Team' || !state.teamTemplate ? 'default-core-dev-team' : state.teamTemplate,
          closeBehavior: state.closeBehavior === 'tray' ? 'tray' : 'quit',
          updateBehavior: state.updateBehavior === 'automatic' ? 'automatic' : 'notify',
          timelineDetailMode: ['activity', 'telemetry'].includes(state.timelineDetailMode || '')
            ? state.timelineDetailMode
            : 'summary',
          inspectorTab: validInspectorTabs.includes(state.inspectorTab as InspectorTab) ? state.inspectorTab : 'agents',
          inspectorExpanded: false,
          automationSettings: { fileWrite: null, gitCommit: null, packageInstall: null },
          // Direct role selection is now an advanced capability; normal missions always
          // enter through the orchestrator and @mentions can still target specialists.
          selectedRole: 'Orchestrator',
        } as SettingsState;
      },
    },
  ),
);

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RightDockTab = 'activity' | 'browser' | 'changes';

export const RIGHT_DOCK_MIN_WIDTH = 260;
export const RIGHT_DOCK_MAX_WIDTH = 900;
export const RIGHT_DOCK_DEFAULT_WIDTH = 360;

export function clampRightDockWidth(width: number): number {
  if (!Number.isFinite(width)) return RIGHT_DOCK_DEFAULT_WIDTH;
  return Math.max(RIGHT_DOCK_MIN_WIDTH, Math.min(RIGHT_DOCK_MAX_WIDTH, Math.round(width)));
}

interface RightDockState {
  open: boolean;
  activeTab: RightDockTab;
  width: number;
  expanded: boolean;
  openActivity: () => void;
  toggleActivity: () => void;
  openBrowser: () => void;
  toggleBrowser: () => void;
  closeDock: () => void;
  setTab: (tab: RightDockTab) => void;
  setWidth: (width: number) => void;
  setExpanded: (expanded: boolean) => void;
}

export const useRightDockStore = create<RightDockState>()(
  persist(
    (set) => ({
      open: false,
      activeTab: 'activity',
      width: RIGHT_DOCK_DEFAULT_WIDTH,
      expanded: false,
      openActivity: () => set({ open: true, activeTab: 'activity' }),
      toggleActivity: () => set((state) => (
        state.open && state.activeTab === 'activity'
          ? { open: false, expanded: false }
          : { open: true, activeTab: 'activity' }
      )),
      openBrowser: () => set({ open: true, activeTab: 'browser' }),
      toggleBrowser: () => set((state) => (
        state.open && state.activeTab === 'browser'
          ? { open: false, expanded: false }
          : { open: true, activeTab: 'browser' }
      )),
      closeDock: () => set({ open: false, expanded: false }),
      setTab: (activeTab) => set({ activeTab }),
      setWidth: (width) => set({ width: clampRightDockWidth(width) }),
      setExpanded: (expanded) => set((state) => ({
        expanded,
        open: expanded ? true : state.open,
      })),
    }),
    {
      name: 'atris-right-dock',
      version: 1,
      partialize: ({ width }) => ({ width }),
      migrate: (persisted) => {
        const previous = (persisted || {}) as Partial<RightDockState>;
        return { width: clampRightDockWidth(previous.width ?? RIGHT_DOCK_DEFAULT_WIDTH) };
      },
    },
  ),
);

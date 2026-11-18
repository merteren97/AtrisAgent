import { create } from 'zustand';
import { useRightDockStore } from '@/stores/right-dock-store';

export function browserUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

interface BrowserState {
  url: string | null;
  requestId: number;
  expanded: boolean;
  width: number;
  open: (url: string) => void;
  close: () => void;
  setExpanded: (expanded: boolean) => void;
  setWidth: (width: number) => void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
  url: null,
  requestId: 0,
  expanded: false,
  width: useRightDockStore.getState().width,
  open: (value) => {
    const url = browserUrl(value);
    if (!url) return;
    set((state) => ({ url, requestId: state.requestId + 1 }));
    useRightDockStore.getState().openBrowser();
  },
  close: () => set({ url: null, expanded: false }),
  setExpanded: (expanded) => {
    set({ expanded });
    useRightDockStore.getState().setExpanded(expanded);
  },
  setWidth: (width) => {
    const clamped = Math.max(340, Math.min(900, Math.round(width)));
    set({ width: clamped });
    useRightDockStore.getState().setWidth(clamped);
  },
}));

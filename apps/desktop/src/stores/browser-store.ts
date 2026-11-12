import { create } from 'zustand';

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
  open: (url:string) => void;
  close: () => void;
  setExpanded: (expanded:boolean) => void;
  setWidth: (width:number) => void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
  url: null, requestId: 0, expanded: false, width: 480,
  open: value => { const url = browserUrl(value); if (url) set(state => ({url,requestId:state.requestId+1})); },
  close: () => set({url:null,expanded:false}),
  setExpanded: expanded => set({expanded}),
  setWidth: width => set({width:Math.max(320,Math.min(900,width))}),
}));

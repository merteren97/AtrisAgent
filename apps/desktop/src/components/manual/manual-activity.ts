import { create } from 'zustand';
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { apiRequest } from '@/lib/api-client';
import { isTauriRuntime } from '@/lib/secure-storage';
import { useManualStore, type ManualAgent } from '@/stores/manual-store';
import type { TerminalSnapshot } from './manual-terminal';

export interface AgentActivity { lifecycle: TerminalSnapshot['status']; state: string; at?: string; checkedAt: number }
export const useManualActivity = create<{ agents: Record<string, AgentActivity>; launched: Record<string, number> }>(() => ({ agents: {}, launched: {} }));
export function markManualLaunch(id: string) {
  useManualActivity.setState(state => ({ launched: { ...state.launched, [id]: Date.now() }, agents: { ...state.agents, [id]: { lifecycle: 'open', state: 'unknown', checkedAt: Date.now() } } }));
}
export function markManualClosed(id: string) {
  useManualActivity.setState(state => ({ launched: { ...state.launched, [id]: Date.now() }, agents: { ...state.agents, [id]: { lifecycle: 'closed', state: 'unknown', checkedAt: Date.now() } } }));
}
export function conversationActivity(agents: ManualAgent[], observations: Record<string, AgentActivity>, now: number) {
  if (!agents.length) return { text: 'No agents yet', kind: 'empty' };
  const items = agents.map(agent => observations[agent.id]);
  if (items.some(item => !item || now - item.checkedAt > 15000)) return { text: 'Checking sessions', kind: 'unknown' };
  const live = items.filter(item => item.lifecycle === 'open');
  if (!live.length) return items.every(item => ['closed', 'exited'].includes(item.lifecycle)) ? { text: 'All terminals closed', kind: 'closed' } : { text: 'Sessions disconnected', kind: 'unknown' };
  if (live.some(item => item.state === 'attention')) return { text: 'Needs your attention', kind: 'attention' };
  if (live.some(item => item.state === 'working')) return { text: 'Processing', kind: 'working' };
  if (items.every(item => item.lifecycle === 'open' || ['closed', 'exited'].includes(item.lifecycle)) && live.every(item => item.state === 'completed' && item.at)) {
    const seconds = Math.max(0, Math.floor((now - Math.max(...live.map(item => Date.parse(item.at!)))) / 1000));
    const ago = seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
    return { text: `Turns finished ${ago}`, kind: 'completed' };
  }
  return { text: `${live.length} open · ${live.every(item => item.state === 'ready') ? 'Ready' : 'Activity unavailable'}`, kind: 'open' };
}
// One shell-level observer keeps inactive conversations truthful without mounting terminal emulators.
export function useManualActivityMonitor() {
  const conversations = useManualStore(state => state.conversations);
  const ids = Object.values(conversations).flat().flatMap(c => c.agents.map(a => a.id)).sort().join(',');
  useEffect(() => {
    if (!ids || !isTauriRuntime()) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const agentIds = ids.split(',');
      for (let start = 0; start < agentIds.length && !disposed; start += 4) {
        await Promise.all(agentIds.slice(start, start + 4).map(async id => {
          const epoch = useManualActivity.getState().launched[id];
          try {
            const snapshot = await invoke<TerminalSnapshot>('manual_terminal_snapshot', { id, after: 0, statusOnly: true });
            const activity = snapshot.status === 'open' ? await apiRequest<{ state: string; at?: string }>(`/manual/agents/${id}/activity`).catch(() => ({ state: 'unknown', at: undefined })) : { state: 'unknown', at: undefined };
            if (disposed || epoch !== useManualActivity.getState().launched[id]) return;
            const verified = activity.at && Date.parse(activity.at) >= (epoch || 0) && Date.parse(activity.at) <= Date.now() + 5000;
            useManualActivity.setState(state => ({ agents: { ...state.agents, [id]: { lifecycle: snapshot.status, state: verified ? activity.state : 'unknown', at: verified ? activity.at : undefined, checkedAt: Date.now() } } }));
          } catch { if (!disposed) useManualActivity.setState(state => ({ agents: { ...state.agents, [id]: { lifecycle: 'disconnected', state: 'unknown', checkedAt: Date.now() } } })); }
        }));
      }
      if (!disposed) timer = setTimeout(poll, 3000);
    }
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [ids]);
}

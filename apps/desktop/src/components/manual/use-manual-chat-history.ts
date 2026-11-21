import { useEffect, useRef, useState, type RefObject } from 'react';
import { apiRequest } from '@/lib/api-client';
import { useManualStore, type ManualMessage, type ManualNamingUpdate, type ManualQuestion } from '@/stores/manual-store';
import type { OpenCodeAutoApprove } from './manual-composer';

interface ChatSnapshot {
  revision: string;
  messages: ManualMessage[];
  recentTools: ManualMessage[];
  questions?: ManualQuestion[];
  autoApprove?: OpenCodeAutoApprove;
  routeStatus?: { pending: boolean; error?: string };
  truncated: boolean;
  bound: boolean;
  loading?: boolean;
  naming?: ManualNamingUpdate;
  hasOlder: boolean;
  memoryRevision?: string;
}

type UnchangedSnapshot = { revision: string; messages?: never };
type HistoryStatus = { loading?: boolean; pageError?: boolean; connectionError?: string };
const EMPTY_MESSAGES: ManualMessage[] = [];
const EMPTY_QUESTIONS: ManualQuestion[] = [];

export function useManualChatHistory(agentId: string | undefined, conversationId: string | undefined,
  following: RefObject<boolean>, preservePosition: () => void) {
  const [state, setState] = useState<{ agentId: string; snapshot: ChatSnapshot }>();
  const [status, setStatus] = useState<HistoryStatus & { agentId: string }>();
  const load = useRef<() => void>(undefined);
  const snapshot = state?.agentId === agentId ? state?.snapshot : undefined;
  const currentStatus = status?.agentId === agentId ? status : undefined;

  useEffect(() => {
    setState(undefined);
    setStatus(undefined);
    if (!agentId || !conversationId) return;
    const abort = new AbortController();
    const { signal } = abort;
    const base = `/manual/agents/${encodeURIComponent(agentId)}/messages`;
    let timer: ReturnType<typeof setTimeout>;
    let current: ChatSnapshot | undefined;
    let polling = false;
    let queuedOlder = false;
    let loadingOlder = false;
    let expanded = false;
    let memoryRevision: string | undefined;
    let syncingMemory = false;
    let failures = 0;
    const updateStatus = (next: HistoryStatus) => {
      setStatus(previous => ({ ...(previous?.agentId === agentId ? previous : {}), agentId, ...next }));
    };
    const poll = async () => {
      if (polling || signal.aborted) return;
      clearTimeout(timer);
      polling = true;
      const older = queuedOlder;
      queuedOlder = false;
      try {
        const query = new URLSearchParams({ view: 'chat' });
        const anchor = current?.messages[0]?.id;
        if (anchor && (older || expanded || !following.current)) query.set('anchor', anchor);
        if (older && anchor) query.set('older', '1');
        if (current && !older) query.set('known', current.revision);
        const result = await apiRequest<ChatSnapshot | UnchangedSnapshot>(`${base}?${query}`, { signal, cache: 'no-store' });
        if (signal.aborted) return;
        if (result.messages !== undefined) {
          // A poll started at the bottom may finish after the reader scrolled up.
          // Keep the rendered anchor for the next poll instead of dropping it now.
          if (!following.current && !query.has('anchor') && anchor && result.messages[0]?.id !== anchor) return;
          if (older && anchor && result.messages[0]?.id !== anchor && result.messages.some(message => message.id === anchor)) {
            preservePosition();
            expanded = true;
          }
          current = result;
          setState({ agentId, snapshot: result });
          useManualStore.getState().applyNaming(result.naming);
        }
        if (older) updateStatus({ loading: false, pageError: false });
        if (failures >= 3) updateStatus({ connectionError: undefined });
        failures = 0;
        const nextMemoryRevision = current?.bound && current.memoryRevision;
        if (nextMemoryRevision && nextMemoryRevision !== memoryRevision && !syncingMemory) {
          syncingMemory = true;
          void apiRequest(`/manual/conversations/${encodeURIComponent(conversationId)}/memory/sync`, {
            method: 'POST', body: JSON.stringify({ agentId }), signal,
          }).then(() => { memoryRevision = nextMemoryRevision; }).catch(() => {}).finally(() => { syncingMemory = false; });
        }
      } catch (error) {
        if (!signal.aborted) {
          if (older) updateStatus({ loading: false, pageError: true });
          else if (++failures >= 3) updateStatus({ connectionError: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (older) loadingOlder = false;
        polling = false;
        if (!signal.aborted) timer = setTimeout(poll, queuedOlder ? 0 : 1500);
      }
    };
    load.current = () => {
      if (loadingOlder || !current?.hasOlder) return;
      loadingOlder = true;
      queuedOlder = true;
      updateStatus({ loading: true, pageError: false });
      void poll();
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); load.current = undefined; };
  }, [agentId, conversationId, following, preservePosition]);

  return {
    snapshot, messages: snapshot?.messages ?? EMPTY_MESSAGES, recentTools: snapshot?.recentTools ?? EMPTY_MESSAGES,
    questions: snapshot?.questions ?? EMPTY_QUESTIONS, status: currentStatus, loadOlder: () => load.current?.(),
    dismissConnectionError: () => setStatus(previous => previous && { ...previous, connectionError: undefined }),
  };
}

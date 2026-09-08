import { useMissionStore } from '@/stores/mission-store';

/** Observe accepted deletions even after their dialog closes. Never retry writes. */
export function startConversationDeletionMonitor(intervalMs = 1_500): () => void {
  let disposed = false;
  let polling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const pendingIds = () => {
    const state = useMissionStore.getState();
    const tracked = Object.entries(state.deletionTracking)
      .filter(([, entry]) => entry.result.status === 'pending')
      .map(([id]) => id);
    const visible = state.missions
      .filter((mission) => mission.deletionState?.status === 'pending')
      .map((mission) => mission.id);
    return [...new Set([...tracked, ...visible])];
  };

  const schedule = () => {
    if (disposed || polling || timer !== undefined || !pendingIds().length) return;
    timer = setTimeout(() => void poll(), intervalMs);
  };
  const poll = async () => {
    timer = undefined;
    if (disposed) return;
    polling = true;
    try {
      for (const id of pendingIds()) {
        if (disposed) break;
        await useMissionStore.getState().checkMissionDeletion(id, controller.signal).catch(() => undefined);
      }
    } finally {
      polling = false;
      schedule();
    }
  };
  const unsubscribe = useMissionStore.subscribe(schedule);
  schedule();
  return () => {
    disposed = true;
    controller.abort();
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  };
}

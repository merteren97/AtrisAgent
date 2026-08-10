import { Channel, invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { isTauriRuntime } from '@/lib/secure-storage';
import { useSettingsStore } from '@/stores/settings-store';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'error';

export interface UpdateRuntimeInfo {
  configured: boolean;
  currentVersion: string;
  endpoint: string;
}

export interface UpdateMetadata {
  version: string;
  currentVersion: string;
  notes?: string | null;
  pubDate?: string | null;
}

interface DownloadEvent {
  event: 'started' | 'progress' | 'finished';
  contentLength?: number | null;
  chunkLength: number;
}

interface UpdateState {
  initialized: boolean;
  runtime: UpdateRuntimeInfo | null;
  availableUpdate: UpdateMetadata | null;
  status: UpdateStatus;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  dismissedVersion: string | null;
  initialize: () => Promise<void>;
  checkForUpdates: (manual?: boolean) => Promise<UpdateMetadata | null>;
  installAvailableUpdate: () => Promise<void>;
  dismissAvailableUpdate: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown updater error';
  }
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  initialized: false,
  runtime: null,
  availableUpdate: null,
  status: 'idle',
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  dismissedVersion: null,

  initialize: async () => {
    if (get().initialized) return;

    if (!isTauriRuntime()) {
      set({
        initialized: true,
        runtime: { configured: false, currentVersion: 'development', endpoint: '' },
      });
      return;
    }

    try {
      const runtime = await invoke<UpdateRuntimeInfo>('get_update_runtime_info');
      set({ initialized: true, runtime, error: null });
      if (!runtime.configured) return;
      await get().checkForUpdates(false);
    } catch (error) {
      set({ initialized: true, status: 'error', error: errorMessage(error) });
    }
  },

  checkForUpdates: async (manual = false) => {
    let runtime = get().runtime;
    if (!runtime && isTauriRuntime()) {
      try {
        runtime = await invoke<UpdateRuntimeInfo>('get_update_runtime_info');
        set({ runtime, initialized: true });
      } catch (error) {
        set({ status: 'error', error: errorMessage(error) });
        return null;
      }
    }

    if (!runtime?.configured) {
      if (manual) {
        set({
          status: 'error',
          error: 'Updates are available only in signed AtrisAgent release builds.',
        });
      }
      return null;
    }

    set({ status: 'checking', error: null });
    try {
      const update = await invoke<UpdateMetadata | null>('check_for_updates');
      if (!update) {
        set({
          availableUpdate: null,
          status: 'up-to-date',
          downloadedBytes: 0,
          totalBytes: null,
          dismissedVersion: null,
        });
        return null;
      }

      set((state) => ({
        availableUpdate: update,
        status: 'available',
        downloadedBytes: 0,
        totalBytes: null,
        dismissedVersion: state.dismissedVersion === update.version ? state.dismissedVersion : null,
      }));

      if (useSettingsStore.getState().updateBehavior === 'automatic') {
        await get().installAvailableUpdate();
      }
      return update;
    } catch (error) {
      set({ status: 'error', error: errorMessage(error) });
      return null;
    }
  },

  installAvailableUpdate: async () => {
    if (!get().availableUpdate) {
      const update = await get().checkForUpdates(true);
      if (!update) return;
    }

    set({ status: 'downloading', downloadedBytes: 0, totalBytes: null, error: null });
    const onEvent = new Channel<DownloadEvent>();
    onEvent.onmessage = (event) => {
      if (event.event === 'started') {
        set({ status: 'downloading', downloadedBytes: 0, totalBytes: event.contentLength ?? null });
        return;
      }
      if (event.event === 'progress') {
        set((state) => ({ downloadedBytes: state.downloadedBytes + event.chunkLength }));
        return;
      }
      if (event.event === 'finished') {
        set({ status: 'installing' });
      }
    };

    try {
      await invoke('install_update', { onEvent });
      set({ status: 'installed' });
    } catch (error) {
      set({ status: 'error', error: errorMessage(error) });
    }
  },

  dismissAvailableUpdate: () => {
    const version = get().availableUpdate?.version;
    if (version) set({ dismissedVersion: version });
  },
}));

import { invoke } from '@tauri-apps/api/core';
import { configureApiRuntime } from '@/lib/api-client';
import { normalizeApiOrigin } from '@/lib/api-base';
import { isTauriRuntime } from '@/lib/secure-storage';

export type RuntimeBootstrap =
  | { status: 'ready'; mode: 'native' | 'browser'; origin: string }
  | { status: 'failed'; mode: 'native'; error: string };

interface NativeRuntimeConfig {
  origin: string;
  runtimeToken?: string | null;
  transportProtected: boolean;
}

const browserOrigin = normalizeApiOrigin(import.meta.env?.VITE_ATRIS_API_URL as string | undefined);
let bootstrapPromise: Promise<RuntimeBootstrap> | null = null;

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && Number(url.port) > 0
      && url.origin === value;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The local AtrisAgent runtime could not be started.';
}

export function validateNativeRuntimeConfig(
  nativeConfig: NativeRuntimeConfig,
  isDevelopment = Boolean(import.meta.env?.DEV),
): { origin: string; runtimeToken: string | null } {
  if (!nativeConfig?.origin || !isLoopbackOrigin(nativeConfig.origin)) {
    throw new Error('The local runtime reported an invalid loopback origin.');
  }
  if (nativeConfig.transportProtected) {
    if (!nativeConfig.runtimeToken?.trim()) {
      throw new Error('The local runtime did not provide its transport token.');
    }
  } else if (!isDevelopment) {
    throw new Error('The local runtime did not identify a protected transport.');
  }
  return {
    origin: nativeConfig.origin,
    runtimeToken: nativeConfig.runtimeToken?.trim() || null,
  };
}

export function initializeRuntime(): Promise<RuntimeBootstrap> {
  if (bootstrapPromise) return bootstrapPromise;
  const pending: Promise<RuntimeBootstrap> = (async (): Promise<RuntimeBootstrap> => {
    if (!isTauriRuntime()) {
      configureApiRuntime({ origin: browserOrigin, runtimeToken: null });
      return { status: 'ready', mode: 'browser', origin: browserOrigin };
    }

    try {
      const nativeConfig = await invoke<NativeRuntimeConfig>('get_runtime_config');
      const validated = validateNativeRuntimeConfig(nativeConfig);
      configureApiRuntime(validated);
      return { status: 'ready', mode: 'native', origin: validated.origin };
    } catch (error) {
      return { status: 'failed', mode: 'native', error: errorMessage(error) };
    }
  })();
  const configured = pending.then((result) => {
    if (result.status === 'failed') bootstrapPromise = null;
    return result;
  }, (error) => {
    bootstrapPromise = null;
    throw error;
  });
  bootstrapPromise = configured;
  return configured;
}

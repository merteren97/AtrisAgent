import { apiBaseUrl, normalizeApiOrigin } from '@/lib/api-base';
import { getAuthToken, notifyUnauthorized } from '@/lib/token-provider';

const configuredBase = import.meta.env?.VITE_ATRIS_API_URL as string | undefined;
let apiOrigin = normalizeApiOrigin(configuredBase);
let runtimeTransportToken: string | null = null;
const API_REQUEST_TIMEOUT_MS = 30_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

export interface ApiRuntimeConfig {
  origin: string;
  runtimeToken?: string | null;
}

export function configureApiRuntime(config: ApiRuntimeConfig): void {
  apiOrigin = normalizeApiOrigin(config.origin);
  runtimeTransportToken = config.runtimeToken?.trim() || null;
}

export function getApiOrigin(): string {
  return apiOrigin;
}

export function getApiBaseUrl(): string {
  return apiBaseUrl(apiOrigin);
}

export function getRuntimeTransportToken(): string | null {
  return runtimeTransportToken;
}

export function runtimeHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (runtimeTransportToken && !headers.has('X-Atris-Runtime-Token')) {
    headers.set('X-Atris-Runtime-Token', runtimeTransportToken);
  }
  return headers;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestInit extends RequestInit {
  /** Auth endpoints can opt out when there is a stale token in memory. */
  skipAuth?: boolean;
  /** Logout handles cleanup itself and should not race the session-expired callback. */
  suppressUnauthorized?: boolean;
  /** Override the desktop request deadline, or set to 0 to disable it. */
  timeoutMs?: number;
}

async function fetchWithDeadline(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (timeoutMs <= 0) return fetch(input, init);

  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}

export async function apiRequestWithHeaders<T>(pathname: string, init: ApiRequestInit = {}): Promise<{ data: T; headers: Headers }> {
  const { skipAuth = false, suppressUnauthorized = false, timeoutMs = API_REQUEST_TIMEOUT_MS, ...requestInit } = init;
  const headers = runtimeHeaders(requestInit.headers);
  if (requestInit.body && !(requestInit.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const token = getAuthToken();
  if (!skipAuth && token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetchWithDeadline(`${getApiBaseUrl()}${pathname.startsWith('/') ? pathname : `/${pathname}`}`, {
    ...requestInit,
    headers,
  }, timeoutMs);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  if (!response.ok) {
    if (response.status === 401 && !suppressUnauthorized) notifyUnauthorized();
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, payload);
  }
  return { data: payload as T, headers: response.headers };
}

export async function apiRequest<T>(pathname: string, init: ApiRequestInit = {}): Promise<T> {
  return (await apiRequestWithHeaders<T>(pathname, init)).data;
}

export async function checkApiHealth(): Promise<{ status: string; version?: string; connectedAccounts?: number }> {
  // Health is intentionally public: it reports local process availability,
  // not AtrisHub identity or Premium entitlement.
  const response = await fetchWithDeadline(`${getApiOrigin()}/health`, { headers: runtimeHeaders() }, HEALTH_REQUEST_TIMEOUT_MS);
  if (!response.ok) throw new ApiError(`Local service returned ${response.status}`, response.status);
  return response.json();
}

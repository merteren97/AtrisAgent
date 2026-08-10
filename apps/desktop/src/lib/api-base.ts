const DEFAULT_API_ORIGIN = 'http://127.0.0.1:3001';

/**
 * Keep the gateway origin and API prefix separate.  Operators commonly set
 * VITE_ATRIS_API_URL to either `http://host:port` or `http://host:port/api`;
 * both forms must address exactly one `/api` segment at runtime.
 */
export function normalizeApiOrigin(value?: string): string {
  const candidate = value?.trim() || DEFAULT_API_ORIGIN;
  const withoutTrailingSlash = candidate.replace(/\/+$/, '');
  const origin = withoutTrailingSlash.replace(/(?:\/api)+$/i, '');
  return origin || DEFAULT_API_ORIGIN;
}

export function apiBaseUrl(value?: string): string {
  return `${normalizeApiOrigin(value)}/api`;
}

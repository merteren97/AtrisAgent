import type { RuntimeType } from '@atris-agent-code/domain';

export type RuntimeFailureKind =
  | 'rate_limited'
  | 'quota_exceeded'
  | 'overloaded'
  | 'auth_error'
  | 'timeout'
  | 'unknown';

export interface RuntimeFailureClassification {
  kind: RuntimeFailureKind;
  retryable: boolean;
  rateLimited: boolean;
  retryAfterMs?: number;
  reason: string;
}

const DEFAULT_MAX_RETRY_AFTER_MS = 120_000;

function extractErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    const record = error as Error & { stderr?: unknown; stdout?: unknown; code?: unknown; status?: unknown };
    return [record.message, record.stderr, record.stdout, record.code, record.status]
      .filter((value) => value !== undefined && value !== null)
      .map(String)
      .join('\n');
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return [record.message, record.error, record.stderr, record.stdout, record.code, record.status]
      .filter((value) => value !== undefined && value !== null)
      .map(String)
      .join('\n');
  }
  return String(error ?? '');
}

function parseRetryAfterMs(text: string): number | undefined {
  const secMatch = text.match(/(?:retry[- ]after|try again in|wait|after)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i);
  if (secMatch) {
    const ms = Math.ceil(Number(secMatch[1]) * 1000);
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, DEFAULT_MAX_RETRY_AFTER_MS);
  }
  const minMatch = text.match(/(?:retry[- ]after|try again in|wait|after)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/i);
  if (minMatch) {
    const ms = Math.ceil(Number(minMatch[1]) * 60_000);
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, DEFAULT_MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

/**
 * Classifies runtime/CLI failures across Codex, Claude Code, OpenCode, and Antigravity
 * so rate-limit/quota errors can trigger bounded cooldowns and automatic route fallback.
 */
export function classifyRuntimeFailure(error: unknown, runtimeType?: RuntimeType | string): RuntimeFailureClassification {
  const text = extractErrorText(error).trim();
  const lower = text.toLowerCase();
  const retryAfterMs = parseRetryAfterMs(text);

  if (
    /\b401\b/.test(lower)
    || /\b(unauthorized|invalid_api_key|authentication_error|reauth_required|login_required|not logged in|token expired)\b/.test(lower)
  ) {
    return {
      kind: 'auth_error',
      retryable: false,
      rateLimited: false,
      reason: `Authentication failure${runtimeType ? ` on ${runtimeType}` : ''}`,
    };
  }

  if (
    /insufficient_quota|quota[_\s-]?exceeded|exceeded your current quota|billing[_\s-]?hard[_\s-]?limit|usage limit reached|out of quota|credit balance is too low/.test(lower)
  ) {
    return {
      kind: 'quota_exceeded',
      retryable: true,
      rateLimited: true,
      retryAfterMs,
      reason: `Quota exceeded${runtimeType ? ` on ${runtimeType}` : ''}`,
    };
  }

  if (
    /\b429\b/.test(lower)
    || /resource[_\s-]?exhausted/.test(lower)
    || /rate[_\s-]?limit|ratelimit|too many requests|requests per min|tokens per min|\brpm\b|\btpm\b|throttl/.test(lower)
  ) {
    return {
      kind: 'rate_limited',
      retryable: true,
      rateLimited: true,
      retryAfterMs,
      reason: `Rate limit (429 / resource exhausted)${runtimeType ? ` on ${runtimeType}` : ''}`,
    };
  }

  if (
    /\b529\b|\b503\b/.test(lower)
    || /overloaded(?:_error)?|server_is_busy|capacity(?:_exceeded)?|temporarily unavailable|service unavailable/.test(lower)
  ) {
    return {
      kind: 'overloaded',
      retryable: true,
      rateLimited: true,
      retryAfterMs,
      reason: `Provider overloaded${runtimeType ? ` on ${runtimeType}` : ''}`,
    };
  }

  if (/timed?\s*out|etimedout|timeout/.test(lower)) {
    return {
      kind: 'timeout',
      retryable: true,
      rateLimited: false,
      reason: `Runtime timeout${runtimeType ? ` on ${runtimeType}` : ''}`,
    };
  }

  return {
    kind: 'unknown',
    retryable: false,
    rateLimited: false,
    reason: text || 'Unknown runtime failure',
  };
}

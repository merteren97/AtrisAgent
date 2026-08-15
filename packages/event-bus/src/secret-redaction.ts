const REDACTED = '[REDACTED_SECRET]';

const SENSITIVE_KEYS = new Set([
  'password',
  'passphrase',
  'apikey',
  'secret',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'runtimetoken',
  'controlplanetoken',
  'token',
  'authorization',
  'authheader',
  'privatekey',
  'clientsecret',
  'credential',
  'cookie',
  'setcookie',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveEventKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

export function redactSensitiveString(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED)
    .replace(/Authorization:\s*(?:Bearer|Basic)\s+[^\s"'\r\n]+/gi, 'Authorization: [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, REDACTED)
    .replace(/(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|session[_-]?token|runtime[_-]?token|secret|token|password|passphrase)\s*[:=]\s*["']?[^\s"'`,;]{8,}["']?/gi, '$1=[REDACTED]');
}

export function redactSensitiveValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactSensitiveString(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[REDACTED_CIRCULAR]';
    seen.add(value);
    return value.map((item) => redactSensitiveValue(item, seen));
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[REDACTED_CIRCULAR]';
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveEventKey(key) ? REDACTED : redactSensitiveValue(item, seen);
  }
  return output;
}

export { REDACTED as REDACTED_SECRET_VALUE };

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

const PEM_BEGIN_PREFIX = '-----BEGIN ';
const PEM_FOOTER_PREFIX = '-----END ';
const PEM_MARKER_SUFFIX = '-----';
const PRIVATE_KEY_SUFFIX = 'PRIVATE KEY';
const MAX_PEM_LABEL_LENGTH = 64;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveEventKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

function isPrivateKeyPemLabel(label: string): boolean {
  if (!label.endsWith(PRIVATE_KEY_SUFFIX) || label.length > MAX_PEM_LABEL_LENGTH) return false;
  for (let index = 0; index < label.length; index += 1) {
    const code = label.charCodeAt(index);
    const isUppercase = code >= 65 && code <= 90;
    const isDigit = code >= 48 && code <= 57;
    if (!isUppercase && !isDigit && code !== 32) return false;
  }
  return true;
}

/**
 * Redact PEM private-key blocks with deterministic string scanning instead of a
 * cross-input regular expression. Event text is provider/library controlled data,
 * so keeping this pass linear avoids a ReDoS/polynomial-regex boundary while still
 * handling RSA/EC/OpenSSH/PKCS8-style private-key labels.
 */
function redactPemPrivateKeyBlocks(value: string): string {
  let cursor = 0;
  let output = '';

  while (cursor < value.length) {
    const begin = value.indexOf(PEM_BEGIN_PREFIX, cursor);
    if (begin < 0) {
      output += value.slice(cursor);
      break;
    }

    output += value.slice(cursor, begin);
    const labelStart = begin + PEM_BEGIN_PREFIX.length;
    const headerEnd = value.indexOf(PEM_MARKER_SUFFIX, labelStart);
    if (headerEnd < 0) {
      output += value.slice(begin);
      break;
    }

    const label = value.slice(labelStart, headerEnd);
    if (!isPrivateKeyPemLabel(label)) {
      output += value.slice(begin, headerEnd + PEM_MARKER_SUFFIX.length);
      cursor = headerEnd + PEM_MARKER_SUFFIX.length;
      continue;
    }

    const footer = `${PEM_FOOTER_PREFIX}${label}${PEM_MARKER_SUFFIX}`;
    const footerStart = value.indexOf(footer, headerEnd + PEM_MARKER_SUFFIX.length);
    if (footerStart < 0) {
      // A recognized private-key header without a closing footer is safer to treat
      // as secret through end-of-input than to leak a truncated credential.
      output += REDACTED;
      break;
    }

    output += REDACTED;
    cursor = footerStart + footer.length;
  }

  return output;
}

export function redactSensitiveString(value: string): string {
  return redactPemPrivateKeyBlocks(value)
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

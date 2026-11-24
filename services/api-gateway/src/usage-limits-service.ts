import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ProviderUsageLimit,
  QuotaProviderId,
  QuotaWindow,
  UsageLimitsResponse,
} from './activity-types';

export const OPENCODE_USAGE_LIMITS_NOTE =
  'OpenCode uses provider API keys and has no 5-hour or weekly plan limits.';

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 120_000;
const DEFAULT_REFRESH_DEBOUNCE_MS = 5_000;
const DEFAULT_STALE_MAX_AGE_MS = 15 * 60_000;

const DEFAULT_TIMEOUTS_MS: Record<QuotaProviderId, number> = {
  antigravity: 18_000,
  codex: 10_000,
  claude_code: 8_000,
};

const PROVIDER_LABELS: Record<QuotaProviderId, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
  claude_code: 'Claude Code',
};

const PROVIDER_ORDER: readonly QuotaProviderId[] = ['antigravity', 'codex', 'claude_code'];

export interface ExecCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface CodexRateLimitWindowRaw {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | string | null;
}

export interface CodexRateLimitsPayload {
  planType?: string | null;
  primary?: CodexRateLimitWindowRaw | null;
  secondary?: CodexRateLimitWindowRaw | null;
}

export interface UsageLimitsServiceDeps {
  now?: () => number;
  cacheTtlMs?: number;
  rateLimitCooldownMs?: number;
  refreshDebounceMs?: number;
  staleMaxAgeMs?: number;
  timeoutsMs?: Partial<Record<QuotaProviderId, number>>;
  findAntigravityExecutable?: () => string | null;
  findCodexExecutable?: () => string | null;
  findClaudeExecutable?: () => string | null;
  runCli?: (
    executable: string,
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<ExecCliResult>;
  queryCodexRateLimits?: (
    executable: string,
    options: { timeoutMs: number },
  ) => Promise<{
    rateLimits?: CodexRateLimitsPayload | null;
    error?: { code?: number; message?: string } | null;
    rawErrorText?: string;
  }>;
  readClaudeCredentials?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function normalizeIsoTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return normalizeIsoTimestamp(Number(trimmed));
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

export function redactSecrets(text: string, knownSecrets: string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]');
  out = out.replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED]');
  return out;
}

function findExecutableInPath(names: string[], extraCandidates: string[] = []): string | null {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Ignore inaccessible PATH entries.
      }
    }
  }
  for (const candidate of extraCandidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore inaccessible fallback paths.
    }
  }
  return null;
}

export function findAntigravityExecutable(): string | null {
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return findExecutableInPath(
      ['agy.exe', 'agy.cmd', 'agy'],
      [path.join(localAppData, 'agy', 'bin', 'agy.exe')],
    );
  }
  return findExecutableInPath(['agy']);
}

export function findCodexExecutable(): string | null {
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return findExecutableInPath(
      ['codex.exe', 'codex.cmd', 'codex'],
      [path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')],
    );
  }
  return findExecutableInPath(['codex']);
}

export function findClaudeExecutable(): string | null {
  if (process.platform === 'win32') {
    return findExecutableInPath(
      ['claude.exe', 'claude.cmd', 'claude'],
      [path.join(os.homedir(), '.local', 'bin', 'claude.exe')],
    );
  }
  return findExecutableInPath(
    ['claude'],
    [path.join(os.homedir(), '.local', 'bin', 'claude')],
  );
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill();
    } catch {
      // Ignore.
    }
    return;
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref();
    } catch {
      try {
        child.kill();
      } catch {
        // Ignore.
      }
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore.
  }
}

async function defaultRunCli(
  executable: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<ExecCliResult> {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      const err = new Error(`Command timed out after ${options.timeoutMs}ms`);
      (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      reject(err);
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

async function defaultQueryCodexRateLimits(
  executable: string,
  options: { timeoutMs: number },
): Promise<{
  rateLimits?: CodexRateLimitsPayload | null;
  error?: { code?: number; message?: string } | null;
  rawErrorText?: string;
}> {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true,
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin?.on('error', () => {});

    let buffer = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      killProcessTree(child);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error(`Codex app-server timed out after ${options.timeoutMs}ms`);
      (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      reject(err);
    }, options.timeoutMs);

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) return;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.id === 2) {
        if (settled) return;
        settled = true;
        cleanup();
        if (msg.error) {
          resolve({
            error: {
              code: typeof msg.error.code === 'number' ? msg.error.code : undefined,
              message: typeof msg.error.message === 'string' ? msg.error.message : String(msg.error),
            },
          });
          return;
        }
        const result = msg.result;
        const rateLimits =
          result && typeof result === 'object'
            ? 'rateLimits' in result
              ? (result.rateLimits as CodexRateLimitsPayload | null)
              : (result as CodexRateLimitsPayload)
            : null;
        resolve({ rateLimits });
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
        if (settled) return;
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      if (buffer.trim()) {
        handleLine(buffer);
        if (settled) return;
      }
      settled = true;
      cleanup();
      resolve({
        rawErrorText: stderr.trim() || `Codex app-server exited with code ${exitCode ?? 'unknown'}`,
      });
    });

    try {
      const initReq = JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'AtrisAgent', version: '0.2.0' } },
      });
      const initializedNotif = JSON.stringify({ method: 'initialized', params: {} });
      const rateLimitsReq = JSON.stringify({
        id: 2,
        method: 'account/rateLimits/read',
        params: {},
      });
      child.stdin?.write(`${initReq}\n${initializedNotif}\n${rateLimitsReq}\n`);
    } catch (err) {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    }
  });
}

async function defaultReadClaudeCredentials(): Promise<string | null> {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const raw = await fs.promises.readFile(credPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, any>;
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token === 'string' && token.trim().length > 0) {
      return token.trim();
    }
    return null;
  } catch {
    return null;
  }
}

const WINDOW_KIND_ORDER: Record<QuotaWindow['windowKind'], number> = {
  five_hour: 0,
  weekly: 1,
  other: 2,
};

function sortGroupWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort(
    (a, b) => WINDOW_KIND_ORDER[a.windowKind] - WINDOW_KIND_ORDER[b.windowKind],
  );
}

function isAuthErrorText(text: string): boolean {
  return /not signed in|not logged in|unauthenticated|login required|sign in with|auth(?:entication)? required|unauthorized|please log in/i.test(
    text,
  );
}

function isRateLimitErrorText(text: string): boolean {
  return /\b429\b|rate.?limit|too many requests|quota exceeded/i.test(text);
}

export function parseAntigravityUsageOutput(
  stdout: string,
  stderr = '',
  exitCode: number | null = 0,
  fetchedAt = new Date().toISOString(),
): ProviderUsageLimit {
  const base = {
    provider: 'antigravity' as const,
    label: PROVIDER_LABELS.antigravity,
    fetchedAt,
  };

  const combined = `${stdout}\n${stderr}`.trim();
  const trimmed = stdout.trim();

  let parsedJson: Record<string, any> | null = null;
  if (trimmed) {
    try {
      parsedJson = JSON.parse(trimmed) as Record<string, any>;
    } catch {
      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
          parsedJson = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as Record<string, any>;
        } catch {
          parsedJson = null;
        }
      }
    }
  }

  if (parsedJson) {
    const errText =
      (typeof parsedJson.error === 'string' ? parsedJson.error : parsedJson.error?.message) ||
      (typeof parsedJson.command?.error === 'string'
        ? parsedJson.command.error
        : parsedJson.command?.error?.message) ||
      '';
    if (errText) {
      if (isAuthErrorText(errText)) {
        return {
          ...base,
          status: 'unauthenticated',
          windows: [],
          message: 'Not signed in · Sign in with Antigravity CLI',
        };
      }
      if (isRateLimitErrorText(errText)) {
        return {
          ...base,
          status: 'rate_limited',
          windows: [],
          message: redactSecrets(errText),
        };
      }
    }

    const groups = parsedJson?.command?.data?.groups;
    if (Array.isArray(groups)) {
      const windows: QuotaWindow[] = [];
      for (const group of groups) {
        const groupName = typeof group?.name === 'string' ? group.name : undefined;
        const groupDescription =
          typeof group?.description === 'string' ? group.description : undefined;
        const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
        const groupWindows: QuotaWindow[] = [];

        for (let idx = 0; idx < buckets.length; idx++) {
          const bucket = buckets[idx];
          if (!bucket || typeof bucket !== 'object') continue;
          const windowKind: QuotaWindow['windowKind'] =
            bucket.window === '5h'
              ? 'five_hour'
              : bucket.window === 'weekly'
                ? 'weekly'
                : 'other';
          const label =
            windowKind === 'five_hour'
              ? '5-Hour Limit'
              : windowKind === 'weekly'
                ? 'Weekly Limit'
                : String(bucket.name || 'Usage Limit');
          const fraction = Number(bucket.remaining_fraction);
          const remainingPercent = clampPercent(fraction * 100);
          const usedPercent = 100 - remainingPercent;
          const windowDurationMins =
            windowKind === 'five_hour'
              ? 300
              : windowKind === 'weekly'
                ? 10080
                : undefined;

          groupWindows.push({
            id: typeof bucket.id === 'string' && bucket.id ? bucket.id : `${groupName || 'group'}-${idx}`,
            label,
            ...(groupName ? { group: groupName } : {}),
            ...(groupDescription ? { groupDescription } : {}),
            windowKind,
            usedPercent,
            remainingPercent,
            ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
            resetsAt: normalizeIsoTimestamp(bucket.reset_time),
            description: typeof bucket.description === 'string' && bucket.description ? bucket.description : null,
          });
        }

        windows.push(...sortGroupWindows(groupWindows));
      }

      return {
        ...base,
        status: 'ok',
        windows,
      };
    }
  }

  // Fallback: tab-separated lines: Group\tBucketName\t90%\t2026-11-30T20:20:24Z
  if (trimmed) {
    const grouped = new Map<string, QuotaWindow[]>();
    const groupOrder: string[] = [];

    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || !line.includes('\t')) continue;
      const parts = line.split('\t').map((p) => p.trim());
      if (parts.length < 3) continue;
      const [groupName, bucketName, pctRaw, resetRaw] = parts;
      const pctMatch = pctRaw.match(/^(\d+(?:\.\d+)?)\s*%$/);
      if (!pctMatch) continue;

      const remainingPercent = clampPercent(Number(pctMatch[1]));
      const usedPercent = 100 - remainingPercent;
      const windowKind: QuotaWindow['windowKind'] = /5\s*h|five.?hour/i.test(bucketName)
        ? 'five_hour'
        : /week|7\s*d/i.test(bucketName)
          ? 'weekly'
          : 'other';
      const label =
        windowKind === 'five_hour'
          ? '5-Hour Limit'
          : windowKind === 'weekly'
            ? 'Weekly Limit'
            : bucketName;
      const windowDurationMins =
        windowKind === 'five_hour'
          ? 300
          : windowKind === 'weekly'
            ? 10080
            : undefined;

      if (!grouped.has(groupName)) {
        grouped.set(groupName, []);
        groupOrder.push(groupName);
      }
      grouped.get(groupName)!.push({
        id: `${groupName}-${bucketName}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        label,
        group: groupName,
        windowKind,
        usedPercent,
        remainingPercent,
        ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
        resetsAt: normalizeIsoTimestamp(resetRaw),
        description: null,
      });
    }

    if (groupOrder.length > 0) {
      const windows: QuotaWindow[] = [];
      for (const groupName of groupOrder) {
        windows.push(...sortGroupWindows(grouped.get(groupName)!));
      }
      return {
        ...base,
        status: 'ok',
        windows,
      };
    }
  }

  if (isAuthErrorText(combined)) {
    return {
      ...base,
      status: 'unauthenticated',
      windows: [],
      message: 'Not signed in · Sign in with Antigravity CLI',
    };
  }

  if (isRateLimitErrorText(combined)) {
    return {
      ...base,
      status: 'rate_limited',
      windows: [],
      message: redactSecrets(combined || 'Antigravity usage check rate limited'),
    };
  }

  return {
    ...base,
    status: 'error',
    windows: [],
    message: redactSecrets(
      combined || `Antigravity CLI exited with code ${exitCode ?? 'unknown'}`,
    ),
  };
}

function capitalizePlanType(planType: unknown): string | null {
  if (typeof planType !== 'string') return null;
  const trimmed = planType.trim();
  if (!trimmed) return null;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

export function parseCodexRateLimits(
  payload: {
    rateLimits?: CodexRateLimitsPayload | null;
    error?: { code?: number; message?: string } | null;
    rawErrorText?: string;
  },
  fetchedAt = new Date().toISOString(),
): ProviderUsageLimit {
  const base = {
    provider: 'codex' as const,
    label: PROVIDER_LABELS.codex,
    fetchedAt,
  };

  if (payload.error) {
    const msg = payload.error.message || 'Codex JSON-RPC error';
    if (isAuthErrorText(msg)) {
      return {
        ...base,
        status: 'unauthenticated',
        windows: [],
        message: 'Not connected · Sign in with codex login',
      };
    }
    if (isRateLimitErrorText(msg)) {
      return {
        ...base,
        status: 'rate_limited',
        windows: [],
        message: redactSecrets(msg),
      };
    }
    return {
      ...base,
      status: 'error',
      windows: [],
      message: redactSecrets(msg),
    };
  }

  if (payload.rawErrorText) {
    if (isAuthErrorText(payload.rawErrorText)) {
      return {
        ...base,
        status: 'unauthenticated',
        windows: [],
        message: 'Not connected · Sign in with codex login',
      };
    }
    return {
      ...base,
      status: 'error',
      windows: [],
      message: redactSecrets(payload.rawErrorText),
    };
  }

  const rateLimits = payload.rateLimits;
  if (!rateLimits || (!rateLimits.primary && !rateLimits.secondary)) {
    return {
      ...base,
      status: 'unavailable',
      windows: [],
      message: 'API key mode · No subscription plan quota limits',
    };
  }

  const windows: QuotaWindow[] = [];
  const entries: Array<['primary' | 'secondary', CodexRateLimitWindowRaw | null | undefined]> = [
    ['primary', rateLimits.primary],
    ['secondary', rateLimits.secondary],
  ];

  for (const [key, win] of entries) {
    if (!win || typeof win !== 'object') continue;
    const rawDuration =
      typeof win.windowDurationMins === 'number' && Number.isFinite(win.windowDurationMins)
        ? win.windowDurationMins
        : undefined;
    const windowKind: QuotaWindow['windowKind'] =
      rawDuration !== undefined
        ? rawDuration <= 360
          ? 'five_hour'
          : rawDuration >= 1440
            ? 'weekly'
            : 'other'
        : key === 'primary'
          ? 'five_hour'
          : 'weekly';
    const label =
      windowKind === 'five_hour'
        ? '5-Hour Limit'
        : windowKind === 'weekly'
          ? 'Weekly Limit'
          : 'Usage Limit';
    const usedPercent = clampPercent(Number(win.usedPercent ?? 0));
    const remainingPercent = 100 - usedPercent;

    windows.push({
      id: key,
      label,
      windowKind,
      usedPercent,
      remainingPercent,
      ...(rawDuration !== undefined ? { windowDurationMins: rawDuration } : {}),
      resetsAt: normalizeIsoTimestamp(win.resetsAt),
    });
  }

  if (windows.length === 0) {
    return {
      ...base,
      status: 'unavailable',
      windows: [],
      message: 'API key mode · No subscription plan quota limits',
    };
  }

  return {
    ...base,
    status: 'ok',
    planLabel: capitalizePlanType(rateLimits.planType),
    windows: sortGroupWindows(windows),
  };
}

export function parseClaudeUsagePayload(
  payload: Record<string, any>,
  fetchedAt = new Date().toISOString(),
): ProviderUsageLimit {
  const base = {
    provider: 'claude_code' as const,
    label: PROVIDER_LABELS.claude_code,
    fetchedAt,
  };

  const windows: QuotaWindow[] = [];
  const specs: Array<{
    key: string;
    id: string;
    label: string;
    windowKind: QuotaWindow['windowKind'];
    windowDurationMins: number;
  }> = [
    {
      key: 'five_hour',
      id: 'five_hour',
      label: '5-Hour Limit',
      windowKind: 'five_hour',
      windowDurationMins: 300,
    },
    {
      key: 'seven_day',
      id: 'seven_day',
      label: 'Weekly Limit',
      windowKind: 'weekly',
      windowDurationMins: 10080,
    },
    {
      key: 'seven_day_opus',
      id: 'seven_day_opus',
      label: 'Weekly Limit (Opus)',
      windowKind: 'weekly',
      windowDurationMins: 10080,
    },
    {
      key: 'seven_day_sonnet',
      id: 'seven_day_sonnet',
      label: 'Weekly Limit (Sonnet)',
      windowKind: 'weekly',
      windowDurationMins: 10080,
    },
  ];

  for (const spec of specs) {
    const raw = payload?.[spec.key];
    if (!raw || typeof raw !== 'object') continue;
    if (raw.utilization == null) continue;
    const usedPercent = clampPercent(Number(raw.utilization));
    const remainingPercent = 100 - usedPercent;
    windows.push({
      id: spec.id,
      label: spec.label,
      windowKind: spec.windowKind,
      usedPercent,
      remainingPercent,
      windowDurationMins: spec.windowDurationMins,
      resetsAt: normalizeIsoTimestamp(raw.resets_at),
    });
  }

  return {
    ...base,
    status: 'ok',
    windows,
  };
}

function isClaudeApiKeyAuthMethod(authMethod: unknown): boolean {
  if (typeof authMethod !== 'string') return false;
  const normalized = authMethod.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('oauth') || normalized.includes('claude.ai')) return false;
  return normalized.includes('api') || normalized.includes('key');
}

interface CachedProviderEntry {
  result: ProviderUsageLimit;
  fetchedAtMs: number;
}

export class UsageLimitsService {
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly refreshDebounceMs: number;
  private readonly staleMaxAgeMs: number;
  private readonly timeoutsMs: Record<QuotaProviderId, number>;
  private readonly findAntigravityExecutableFn: () => string | null;
  private readonly findCodexExecutableFn: () => string | null;
  private readonly findClaudeExecutableFn: () => string | null;
  private readonly runCliFn: (
    executable: string,
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<ExecCliResult>;
  private readonly queryCodexRateLimitsFn: (
    executable: string,
    options: { timeoutMs: number },
  ) => Promise<{
    rateLimits?: CodexRateLimitsPayload | null;
    error?: { code?: number; message?: string } | null;
    rawErrorText?: string;
  }>;
  private readonly readClaudeCredentialsFn: () => Promise<string | null>;
  private readonly fetchFn: typeof fetch;

  private readonly cache = new Map<QuotaProviderId, CachedProviderEntry>();
  private readonly lastOk = new Map<QuotaProviderId, CachedProviderEntry>();
  private readonly rateLimitedUntil = new Map<QuotaProviderId, number>();
  private readonly lastRefreshAttemptAt = new Map<QuotaProviderId, number>();
  private readonly inFlight = new Map<QuotaProviderId, Promise<ProviderUsageLimit>>();

  constructor(deps: UsageLimitsServiceDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.rateLimitCooldownMs = deps.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.refreshDebounceMs = deps.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS;
    this.staleMaxAgeMs = deps.staleMaxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
    this.timeoutsMs = {
      ...DEFAULT_TIMEOUTS_MS,
      ...deps.timeoutsMs,
    };
    this.findAntigravityExecutableFn = deps.findAntigravityExecutable ?? findAntigravityExecutable;
    this.findCodexExecutableFn = deps.findCodexExecutable ?? findCodexExecutable;
    this.findClaudeExecutableFn = deps.findClaudeExecutable ?? findClaudeExecutable;
    this.runCliFn = deps.runCli ?? defaultRunCli;
    this.queryCodexRateLimitsFn = deps.queryCodexRateLimits ?? defaultQueryCodexRateLimits;
    this.readClaudeCredentialsFn = deps.readClaudeCredentials ?? defaultReadClaudeCredentials;
    this.fetchFn = deps.fetchImpl ?? fetch;
  }

  async getUsageLimits(options: { refresh?: boolean } = {}): Promise<UsageLimitsResponse> {
    const refresh = Boolean(options.refresh);
    let anyFreshFetch = false;

    const settled = await Promise.allSettled(
      PROVIDER_ORDER.map(async (provider) => {
        const res = await this.getProviderLimit(provider, refresh);
        if (res.fresh) anyFreshFetch = true;
        return res.limit;
      }),
    );

    const providers: ProviderUsageLimit[] = settled.map((item, idx) => {
      if (item.status === 'fulfilled') return item.value;
      const provider = PROVIDER_ORDER[idx];
      return {
        provider,
        label: PROVIDER_LABELS[provider],
        status: 'error',
        windows: [],
        message: redactSecrets(item.reason?.message || 'Unexpected provider check failure'),
        fetchedAt: new Date(this.now()).toISOString(),
      };
    });

    return {
      providers,
      opencodeNote: OPENCODE_USAGE_LIMITS_NOTE,
      cached: !anyFreshFetch,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  private async getProviderLimit(
    provider: QuotaProviderId,
    refresh: boolean,
  ): Promise<{ limit: ProviderUsageLimit; fresh: boolean }> {
    const nowMs = this.now();

    // Active 429 cooldown is always respected, even with refresh=true.
    const cooldownUntil = this.rateLimitedUntil.get(provider);
    if (cooldownUntil !== undefined && nowMs < cooldownUntil) {
      const cached = this.cache.get(provider);
      if (cached) {
        return { limit: cached.result, fresh: false };
      }
      return {
        limit: {
          provider,
          label: PROVIDER_LABELS[provider],
          status: 'rate_limited',
          windows: [],
          message: 'Rate limited · Cooling down before next check',
          fetchedAt: new Date(nowMs).toISOString(),
        },
        fresh: false,
      };
    }

    const cached = this.cache.get(provider);
    if (!refresh && cached && nowMs - cached.fetchedAtMs < this.cacheTtlMs) {
      return { limit: cached.result, fresh: false };
    }

    // Coalesce concurrent in-flight requests for the same provider.
    const existingFlight = this.inFlight.get(provider);
    if (existingFlight) {
      const limit = await existingFlight;
      return { limit, fresh: true };
    }

    // Per-provider 5s debounce for repeated refresh=true calls.
    const lastAttempt = this.lastRefreshAttemptAt.get(provider);
    if (
      refresh &&
      cached &&
      lastAttempt !== undefined &&
      nowMs - lastAttempt < this.refreshDebounceMs
    ) {
      return { limit: cached.result, fresh: false };
    }

    this.lastRefreshAttemptAt.set(provider, nowMs);
    const promise = this.fetchAndCacheProvider(provider).finally(() => {
      this.inFlight.delete(provider);
    });
    this.inFlight.set(provider, promise);
    const limit = await promise;
    return { limit, fresh: true };
  }

  private async fetchAndCacheProvider(provider: QuotaProviderId): Promise<ProviderUsageLimit> {
    const timeoutMs = this.timeoutsMs[provider];
    let result: ProviderUsageLimit;

    try {
      result = await this.withHardTimeout(
        this.fetchProviderUncached(provider, timeoutMs),
        timeoutMs,
        provider,
      );
    } catch (err: any) {
      result = {
        provider,
        label: PROVIDER_LABELS[provider],
        status: 'error',
        windows: [],
        message: redactSecrets(err?.message || `${PROVIDER_LABELS[provider]} usage check failed`),
        fetchedAt: new Date(this.now()).toISOString(),
      };
    }

    const nowMs = this.now();

    if (result.status === 'rate_limited') {
      this.rateLimitedUntil.set(provider, nowMs + this.rateLimitCooldownMs);
      this.cache.set(provider, { result, fetchedAtMs: nowMs });
      return result;
    }

    if (result.status === 'ok') {
      this.rateLimitedUntil.delete(provider);
      this.lastOk.set(provider, { result, fetchedAtMs: nowMs });
      this.cache.set(provider, { result, fetchedAtMs: nowMs });
      return result;
    }

    if (result.status === 'error') {
      const recentOk = this.lastOk.get(provider);
      if (recentOk && nowMs - recentOk.fetchedAtMs < this.staleMaxAgeMs) {
        const staleResult: ProviderUsageLimit = {
          ...recentOk.result,
          stale: true,
          message: `Showing cached data · ${result.message || 'Refresh failed'}`,
        };
        this.cache.set(provider, { result: staleResult, fetchedAtMs: nowMs });
        return staleResult;
      }
    }

    this.cache.set(provider, { result, fetchedAtMs: nowMs });
    return result;
  }

  private async withHardTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    provider: QuotaProviderId,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${PROVIDER_LABELS[provider]} check timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchProviderUncached(
    provider: QuotaProviderId,
    timeoutMs: number,
  ): Promise<ProviderUsageLimit> {
    if (provider === 'antigravity') return this.fetchAntigravity(timeoutMs);
    if (provider === 'codex') return this.fetchCodex(timeoutMs);
    return this.fetchClaudeCode(timeoutMs);
  }

  private async fetchAntigravity(timeoutMs: number): Promise<ProviderUsageLimit> {
    const fetchedAt = new Date(this.now()).toISOString();
    const executable = this.findAntigravityExecutableFn();
    if (!executable) {
      return {
        provider: 'antigravity',
        label: PROVIDER_LABELS.antigravity,
        status: 'unavailable',
        windows: [],
        message: 'Antigravity CLI (agy) is not installed.',
        fetchedAt,
      };
    }

    try {
      const res = await this.runCliFn(
        executable,
        ['--print-timeout', '15s', '--output-format', 'json', '--print=/usage'],
        { timeoutMs },
      );
      return parseAntigravityUsageOutput(res.stdout, res.stderr, res.exitCode, fetchedAt);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return {
          provider: 'antigravity',
          label: PROVIDER_LABELS.antigravity,
          status: 'unavailable',
          windows: [],
          message: 'Antigravity CLI (agy) is not installed.',
          fetchedAt,
        };
      }
      return {
        provider: 'antigravity',
        label: PROVIDER_LABELS.antigravity,
        status: 'error',
        windows: [],
        message: redactSecrets(err?.message || 'Failed to run Antigravity CLI'),
        fetchedAt,
      };
    }
  }

  private async fetchCodex(timeoutMs: number): Promise<ProviderUsageLimit> {
    const fetchedAt = new Date(this.now()).toISOString();
    const executable = this.findCodexExecutableFn();
    if (!executable) {
      return {
        provider: 'codex',
        label: PROVIDER_LABELS.codex,
        status: 'unavailable',
        windows: [],
        message: 'Codex CLI is not installed.',
        fetchedAt,
      };
    }

    try {
      const payload = await this.queryCodexRateLimitsFn(executable, { timeoutMs });
      return parseCodexRateLimits(payload, fetchedAt);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return {
          provider: 'codex',
          label: PROVIDER_LABELS.codex,
          status: 'unavailable',
          windows: [],
          message: 'Codex CLI is not installed.',
          fetchedAt,
        };
      }
      return {
        provider: 'codex',
        label: PROVIDER_LABELS.codex,
        status: 'error',
        windows: [],
        message: redactSecrets(err?.message || 'Failed to query Codex CLI'),
        fetchedAt,
      };
    }
  }

  private async fetchClaudeCode(timeoutMs: number): Promise<ProviderUsageLimit> {
    const fetchedAt = new Date(this.now()).toISOString();
    const executable = this.findClaudeExecutableFn();
    if (!executable) {
      return {
        provider: 'claude_code',
        label: PROVIDER_LABELS.claude_code,
        status: 'unavailable',
        windows: [],
        message: 'Claude Code CLI is not installed.',
        fetchedAt,
      };
    }

    let authResult: ExecCliResult;
    try {
      authResult = await this.runCliFn(executable, ['auth', 'status'], {
        timeoutMs: Math.min(4_000, timeoutMs),
      });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return {
          provider: 'claude_code',
          label: PROVIDER_LABELS.claude_code,
          status: 'unavailable',
          windows: [],
          message: 'Claude Code CLI is not installed.',
          fetchedAt,
        };
      }
      return {
        provider: 'claude_code',
        label: PROVIDER_LABELS.claude_code,
        status: 'error',
        windows: [],
        message: redactSecrets(err?.message || 'Failed to check Claude Code auth status'),
        fetchedAt,
      };
    }

    let authStatus: { loggedIn?: boolean; authMethod?: string; apiProvider?: string } | null = null;
    try {
      authStatus = JSON.parse(authResult.stdout.trim());
    } catch {
      authStatus = null;
    }

    if (!authStatus) {
      const combined = `${authResult.stdout}\n${authResult.stderr}`.trim();
      if (isAuthErrorText(combined)) {
        return {
          provider: 'claude_code',
          label: PROVIDER_LABELS.claude_code,
          status: 'unauthenticated',
          windows: [],
          message: 'Not connected · Sign in with claude auth login',
          fetchedAt,
        };
      }
      return {
        provider: 'claude_code',
        label: PROVIDER_LABELS.claude_code,
        status: 'error',
        windows: [],
        message: redactSecrets(combined || 'Failed to parse Claude auth status'),
        fetchedAt,
      };
    }

    if (!authStatus.loggedIn) {
      return {
        provider: 'claude_code',
        label: PROVIDER_LABELS.claude_code,
        status: 'unauthenticated',
        windows: [],
        message: 'Not connected · Sign in with claude auth login',
        fetchedAt,
      };
    }

    if (isClaudeApiKeyAuthMethod(authStatus.authMethod)) {
      return {
        provider: 'claude_code',
        label: PROVIDER_LABELS.claude_code,
        status: 'unavailable',
        windows: [],
        message: 'API key mode · No subscription plan quota limits',
        fetchedAt,
      };
    }

    const accessToken = await this.readClaudeCredentialsFn();
    if (!accessToken) {
      return {
        provider: 'claude_code',
        label: PROVIDER_LABELS.claude_code,
        status: 'unavailable',
        windows: [],
        message: 'Connected via OS keychain or missing local OAuth credentials.',
        fetchedAt,
      };
    }

    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchFn('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        return {
          provider: 'claude_code',
          label: PROVIDER_LABELS.claude_code,
          status: 'unauthenticated',
          windows: [],
          message: 'Not connected · Sign in with claude auth login',
          fetchedAt,
        };
      }

      if (response.status === 429) {
        return {
          provider: 'claude_code',
          label: PROVIDER_LABELS.claude_code,
          status: 'rate_limited',
          windows: [],
          message: 'Rate limited by Anthropic usage API · Cooling down for 120s',
          fetchedAt,
        };
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return {
          provider: 'claude_code',
          label: PROVIDER_LABELS.claude_code,
          status: 'error',
          windows: [],
          message: redactSecrets(
            `Anthropic usage API returned HTTP ${response.status}${errText ? `: ${errText.slice(0, 160)}` : ''}`,
            [accessToken],
          ),
          fetchedAt,
        };
      }

      const payload = (await response.json()) as Record<string, any>;
      return parseClaudeUsagePayload(payload, fetchedAt);
    } catch (err: any) {
      return {
        provider: 'claude_code',
        label: PROVIDER_LABELS.claude_code,
        status: 'error',
        windows: [],
        message: redactSecrets(err?.message || 'Failed to fetch Claude Code usage', [accessToken]),
        fetchedAt,
      };
    } finally {
      clearTimeout(fetchTimer);
    }
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { CliProviderId } from './activity-types';
import { listRecentOpenCodeSessions } from './opencode-usage-reader';

export interface LocalCliScannerRoots {
  xdgDataHome?: string;
  codexHome?: string;
  antigravityRoot?: string;
  claudeConfigDir?: string;
}

export interface ExternalCliSession {
  provider: CliProviderId;
  sessionId: string;
  title: string;
  directory: string | null;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  durationMs: number;
  turnCount: number;
  usageAvailable: boolean;
  recordedAt: string;
}

interface CachedFileSummary<T> {
  signature: string;
  value: T;
}

const FILE_SUMMARY_CACHE = new Map<string, CachedFileSummary<any>>();
const FILE_SUMMARY_CACHE_LIMIT = 512;

function setFileCache<T>(key: string, signature: string, value: T): void {
  FILE_SUMMARY_CACHE.delete(key);
  FILE_SUMMARY_CACHE.set(key, { signature, value });
  if (FILE_SUMMARY_CACHE.size > FILE_SUMMARY_CACHE_LIMIT) {
    const oldest = FILE_SUMMARY_CACHE.keys().next().value;
    if (oldest) FILE_SUMMARY_CACHE.delete(oldest);
  }
}

function nonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function parseTsMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readTextBounded(filePath: string, maxBytes = 8 * 1024 * 1024): string {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(filePath, 'utf8');
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function collectRecentFiles(
  rootDir: string,
  ext: string,
  maxDepth: number,
  maxFiles: number,
): Array<{ file: string; mtimeMs: number; size: number }> {
  try {
    const stat = fs.lstatSync(rootDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
  } catch {
    return [];
  }

  const collected: Array<{ file: string; mtimeMs: number; size: number }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || collected.length >= maxFiles * 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        try {
          const st = fs.statSync(full);
          collected.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // Ignore disappearing file.
        }
      }
    }
  };
  walk(rootDir, 0);
  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return collected.slice(0, maxFiles);
}

function parseCodexRolloutFile(file: string, mtimeMs: number, size: number): ExternalCliSession | null {
  const sig = `${mtimeMs}:${size}`;
  const cacheKey = `codex:${file}`;
  const cached = FILE_SUMMARY_CACHE.get(cacheKey);
  if (cached && cached.signature === sig) return cached.value;

  let sessionId = '';
  let title = '';
  let directory: string | null = null;
  let model: string | undefined;
  let latestUsage: Record<string, unknown> | null = null;
  let taskCompletes = 0;
  let assistantMsgs = 0;
  let minTs: number | null = null;
  let maxTs: number | null = null;

  try {
    const source = readTextBounded(file);
    for (const line of source.split('\n')) {
      if (!line.trim()) continue;
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = parseTsMs(record.timestamp);
      if (ts !== null) {
        minTs = minTs === null ? ts : Math.min(minTs, ts);
        maxTs = maxTs === null ? ts : Math.max(maxTs, ts);
      }
      if (record.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
        if (typeof record.payload.id === 'string' && record.payload.id.trim()) {
          sessionId = record.payload.id.trim();
        }
        if (typeof record.payload.cwd === 'string' && record.payload.cwd.trim()) {
          directory = record.payload.cwd.trim();
        }
      } else if (record.type === 'turn_context' && record.payload && typeof record.payload === 'object') {
        if (!model && typeof record.payload.model === 'string' && record.payload.model.trim()) {
          model = record.payload.model.trim();
        }
        if (!directory && typeof record.payload.cwd === 'string' && record.payload.cwd.trim()) {
          directory = record.payload.cwd.trim();
        }
      } else if (record.type === 'event_msg' && record.payload && typeof record.payload === 'object') {
        if (record.payload.type === 'user_message' && !title && typeof record.payload.message === 'string') {
          title = record.payload.message.trim().slice(0, 80);
        } else if (record.payload.type === 'token_count' && record.payload.info?.total_token_usage) {
          latestUsage = record.payload.info.total_token_usage as Record<string, unknown>;
        } else if (record.payload.type === 'task_complete') {
          taskCompletes += 1;
        } else if (
          record.payload.type === 'agent_message'
          || (record.payload.type === 'item_completed' && record.payload.item?.type === 'AgentMessage')
        ) {
          assistantMsgs += 1;
        }
      } else if (
        record.type === 'response_item'
        && record.payload?.type === 'message'
        && record.payload?.role === 'assistant'
      ) {
        assistantMsgs += 1;
      }
    }
  } catch {
    setFileCache(cacheKey, sig, null);
    return null;
  }

  if (!sessionId) {
    setFileCache(cacheKey, sig, null);
    return null;
  }

  const inputTokens = latestUsage ? nonNegInt(latestUsage.input_tokens) : 0;
  const cachedTokens = latestUsage ? nonNegInt(latestUsage.cached_input_tokens) : 0;
  const outputTokens = latestUsage ? nonNegInt(latestUsage.output_tokens) : 0;
  const reasoningTokens = latestUsage ? nonNegInt(latestUsage.reasoning_output_tokens) : 0;
  const turnCount = taskCompletes > 0 ? taskCompletes : assistantMsgs > 0 ? assistantMsgs : latestUsage ? 1 : 0;
  const usageAvailable = Boolean(latestUsage) && (inputTokens > 0 || outputTokens > 0 || cachedTokens > 0 || reasoningTokens > 0);
  const durationMs = minTs !== null && maxTs !== null ? Math.max(0, maxTs - minTs) : 0;
  const recordedAt = new Date(maxTs ?? mtimeMs).toISOString();

  const summary: ExternalCliSession = {
    provider: 'codex',
    sessionId,
    title: title || `Codex ${sessionId.slice(0, 8)}`,
    directory,
    ...(model ? { model } : {}),
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    costUsd: null,
    durationMs,
    turnCount,
    usageAvailable,
    recordedAt,
  };
  setFileCache(cacheKey, sig, summary);
  return summary;
}

function parseClaudeJsonlFile(file: string, mtimeMs: number, size: number): ExternalCliSession[] {
  const sig = `${mtimeMs}:${size}`;
  const cacheKey = `claude:${file}`;
  const cached = FILE_SUMMARY_CACHE.get(cacheKey);
  if (cached && cached.signature === sig) return cached.value;

  interface SessionBucket {
    sessionId: string;
    title: string;
    directory: string | null;
    model?: string;
    deduped: Map<string, any>;
    minTs: number | null;
    maxTs: number | null;
    anonSeq: number;
  }

  const buckets = new Map<string, SessionBucket>();
  try {
    const source = readTextBounded(file);
    for (const line of source.split('\n')) {
      if (!line.trim()) continue;
      let item: any;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (item.isSidechain) continue;
      const sessionId = typeof item.sessionId === 'string' && item.sessionId.trim() ? item.sessionId.trim() : '';
      if (!sessionId) continue;

      let bucket = buckets.get(sessionId);
      if (!bucket) {
        bucket = {
          sessionId,
          title: '',
          directory: typeof item.cwd === 'string' && item.cwd.trim() ? item.cwd.trim() : null,
          deduped: new Map<string, any>(),
          minTs: null,
          maxTs: null,
          anonSeq: 0,
        };
        buckets.set(sessionId, bucket);
      }
      if (!bucket.directory && typeof item.cwd === 'string' && item.cwd.trim()) {
        bucket.directory = item.cwd.trim();
      }
      if (!bucket.title && item.type === 'user') {
        const raw = typeof item.message?.content === 'string' ? item.message.content.trim() : '';
        if (raw) bucket.title = raw.slice(0, 80);
      }
      if (!bucket.model && typeof item.message?.model === 'string' && item.message.model.trim()) {
        bucket.model = item.message.model.trim();
      }

      const ts = parseTsMs(item.timestamp);
      if (ts !== null) {
        bucket.minTs = bucket.minTs === null ? ts : Math.min(bucket.minTs, ts);
        bucket.maxTs = bucket.maxTs === null ? ts : Math.max(bucket.maxTs, ts);
      }

      if (item.type !== 'assistant' && !item.message?.usage) continue;
      const dedupeId = String(item.message?.id || item.uuid || `anon:${++bucket.anonSeq}`);
      bucket.deduped.set(dedupeId, item);
    }
  } catch {
    setFileCache(cacheKey, sig, []);
    return [];
  }

  const results: ExternalCliSession[] = [];
  for (const bucket of buckets.values()) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let costSum = 0;
    let hasCost = false;
    let hasUsage = false;
    let turnCount = 0;

    for (const item of bucket.deduped.values()) {
      turnCount += 1;
      const usage = item.message?.usage || item.usage;
      if (usage && typeof usage === 'object') {
        inputTokens += nonNegInt(usage.input_tokens);
        cachedTokens += nonNegInt(usage.cache_read_input_tokens) + nonNegInt(usage.cache_creation_input_tokens);
        outputTokens += nonNegInt(usage.output_tokens);
        hasUsage = true;
      }
      if (typeof item.costUSD === 'number' && Number.isFinite(item.costUSD) && item.costUSD >= 0) {
        costSum += item.costUSD;
        hasCost = true;
      }
    }

    const usageAvailable = hasUsage && (inputTokens > 0 || outputTokens > 0 || cachedTokens > 0);
    if (turnCount === 0 && !usageAvailable) continue;

    results.push({
      provider: 'claude_code',
      sessionId: bucket.sessionId,
      title: bucket.title || `Claude ${bucket.sessionId.slice(0, 8)}`,
      directory: bucket.directory,
      ...(bucket.model ? { model: bucket.model } : {}),
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens: 0,
      costUsd: hasCost ? costSum : null,
      durationMs: bucket.minTs !== null && bucket.maxTs !== null ? Math.max(0, bucket.maxTs - bucket.minTs) : 0,
      turnCount,
      usageAvailable,
      recordedAt: new Date(bucket.maxTs ?? mtimeMs).toISOString(),
    });
  }

  setFileCache(cacheKey, sig, results);
  return results;
}

function parseAntigravityTranscriptSummary(
  transcriptPath: string,
  sessionId: string,
  meta?: { title?: string; directory?: string | null; updatedAtMs?: number | null },
): ExternalCliSession | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(transcriptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }

  const sig = `${stat.mtimeMs}:${stat.size}:${meta?.title || ''}:${meta?.directory || ''}`;
  const cacheKey = `antigravity:${transcriptPath}`;
  const cached = FILE_SUMMARY_CACHE.get(cacheKey);
  if (cached && cached.signature === sig) return cached.value;

  const steps = new Map<number, any>();
  let fallbackTitle = '';
  try {
    const source = readTextBounded(transcriptPath);
    for (const line of source.split('\n')) {
      if (!line.trim()) continue;
      let step: any;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof step.step_index === 'number') {
        steps.set(step.step_index, step);
      }
      if (!fallbackTitle && step.type === 'USER_INPUT' && typeof step.content === 'string') {
        const cleaned = step.content.replace(/<\/?USER_REQUEST>/g, '').trim();
        if (cleaned) fallbackTitle = cleaned.slice(0, 80);
      }
    }
  } catch {
    setFileCache(cacheKey, sig, null);
    return null;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let turnCount = 0;
  let minTs: number | null = null;
  let maxTs: number | null = null;

  for (const step of steps.values()) {
    const ts = parseTsMs(step.created_at ?? step.createdAt ?? step.timestamp);
    if (ts !== null) {
      minTs = minTs === null ? ts : Math.min(minTs, ts);
      maxTs = maxTs === null ? ts : Math.max(maxTs, ts);
    }
    if (step.type !== 'PLANNER_RESPONSE' || step.source !== 'MODEL') continue;
    turnCount += 1;
    const input = nonNegInt(step.input_tokens);
    const output = nonNegInt(step.output_tokens);
    const cachedTok = nonNegInt(step.cache_read_tokens);
    const thinking = nonNegInt(step.thinking_tokens);
    inputTokens += input;
    cachedTokens += cachedTok;
    if (step.thinking_tokens !== undefined) {
      reasoningTokens += thinking;
      outputTokens += output;
    } else if (
      step.input_tokens === undefined
      && step.cache_read_tokens === undefined
      && typeof step.thinking === 'string'
      && step.thinking.trim()
    ) {
      reasoningTokens += output;
    } else {
      outputTokens += output;
    }
  }

  const usageAvailable = inputTokens > 0 || outputTokens > 0 || cachedTokens > 0 || reasoningTokens > 0;
  if (turnCount === 0 && !usageAvailable) {
    setFileCache(cacheKey, sig, null);
    return null;
  }

  const summary: ExternalCliSession = {
    provider: 'antigravity',
    sessionId,
    title: meta?.title || fallbackTitle || `Antigravity ${sessionId.slice(0, 8)}`,
    directory: meta?.directory ?? null,
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    costUsd: null,
    durationMs: minTs !== null && maxTs !== null ? Math.max(0, maxTs - minTs) : 0,
    turnCount,
    usageAvailable,
    recordedAt: new Date(maxTs ?? meta?.updatedAtMs ?? stat.mtimeMs).toISOString(),
  };
  setFileCache(cacheKey, sig, summary);
  return summary;
}

export class LocalCliInsightsScanner {
  constructor(private roots: LocalCliScannerRoots = {}) {}

  private resolveRoots(): Required<LocalCliScannerRoots> {
    return {
      xdgDataHome: this.roots.xdgDataHome || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
      codexHome: this.roots.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      antigravityRoot: this.roots.antigravityRoot || path.join(os.homedir(), '.gemini', 'antigravity-cli'),
      claudeConfigDir: this.roots.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    };
  }

  scan(options: {
    cutoffIso: string | null;
    excludeSessionIds?: Partial<Record<CliProviderId, Set<string>>>;
  }): ExternalCliSession[] {
    const roots = this.resolveRoots();
    const cutoffMs = options.cutoffIso ? Date.parse(options.cutoffIso) : null;
    const validCutoffMs = cutoffMs !== null && Number.isFinite(cutoffMs) ? cutoffMs : null;
    const exclude = options.excludeSessionIds || {};
    const results: ExternalCliSession[] = [];

    // 1. OpenCode (~/.local/share/opencode/opencode.db)
    try {
      const ocExcluded = exclude.opencode || new Set<string>();
      const ocSessions = listRecentOpenCodeSessions({
        cutoffMs: validCutoffMs,
        limit: 500,
        xdgDataHome: roots.xdgDataHome,
      });
      for (const s of ocSessions) {
        if (ocExcluded.has(s.sessionId)) continue;
        if (s.turnCount === 0 && !s.usageAvailable && s.durationMs === 0) continue;
        const recordedAt = s.lastRecordedAt || new Date(0).toISOString();
        if (options.cutoffIso && recordedAt < options.cutoffIso) continue;
        results.push({
          provider: 'opencode',
          sessionId: s.sessionId,
          title: s.title || `OpenCode ${s.sessionId.slice(0, 8)}`,
          directory: s.directory ?? null,
          ...(s.model ? { model: s.model } : {}),
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cachedTokens: s.cachedTokens,
          reasoningTokens: s.reasoningTokens,
          costUsd: s.totalCostUsd,
          durationMs: s.durationMs,
          turnCount: s.turnCount,
          usageAvailable: s.usageAvailable,
          recordedAt,
        });
      }
    } catch {
      // Best-effort scan.
    }

    // 2. Codex CLI (~/.codex/state_5.sqlite + ~/.codex/sessions)
    try {
      const codexExcluded = exclude.codex || new Set<string>();
      const seenCodex = new Set<string>();
      const stateDbPath = path.join(roots.codexHome, 'state_5.sqlite');
      try {
        const dbStat = fs.lstatSync(stateDbPath);
        if (dbStat.isFile() && !dbStat.isSymbolicLink()) {
          let db: Database.Database | undefined;
          try {
            db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
            const cols = new Set(
              (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name?: string }>)
                .map((c) => c.name)
                .filter((n): n is string => Boolean(n)),
            );
            if (cols.has('id')) {
              const selectCols = ['id', 'title', 'cwd', 'rollout_path', 'tokens_used', 'created_at', 'updated_at'].filter((c) => cols.has(c));
              const orderCol = cols.has('updated_at') ? 'updated_at' : cols.has('created_at') ? 'created_at' : 'rowid';
              const rows = db
                .prepare(`SELECT ${selectCols.join(', ')} FROM threads ORDER BY ${orderCol} DESC LIMIT 200`)
                .all() as Array<Record<string, any>>;
              for (const row of rows) {
                const sid = typeof row.id === 'string' ? row.id.trim() : '';
                if (!sid || codexExcluded.has(sid) || seenCodex.has(sid)) continue;
                const rolloutPath = typeof row.rollout_path === 'string' ? row.rollout_path.trim() : '';
                let parsed: ExternalCliSession | null = null;
                if (rolloutPath) {
                  try {
                    const st = fs.lstatSync(rolloutPath);
                    if (st.isFile() && !st.isSymbolicLink()) {
                      parsed = parseCodexRolloutFile(rolloutPath, st.mtimeMs, st.size);
                    }
                  } catch {
                    // Rollout file missing; fallback to SQLite row.
                  }
                }
                if (parsed) {
                  seenCodex.add(parsed.sessionId);
                  if (!options.cutoffIso || parsed.recordedAt >= options.cutoffIso) {
                    results.push(parsed);
                  }
                } else {
                  const tokensUsed = nonNegInt(row.tokens_used);
                  const createdAt = parseTsMs(row.created_at);
                  const updatedAt = parseTsMs(row.updated_at);
                  const lastTs = updatedAt ?? createdAt;
                  if (tokensUsed > 0 && lastTs !== null) {
                    const recordedAt = new Date(lastTs).toISOString();
                    if (!options.cutoffIso || recordedAt >= options.cutoffIso) {
                      seenCodex.add(sid);
                      results.push({
                        provider: 'codex',
                        sessionId: sid,
                        title: (typeof row.title === 'string' && row.title.trim()) || `Codex ${sid.slice(0, 8)}`,
                        directory: typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd.trim() : null,
                        inputTokens: tokensUsed,
                        outputTokens: 0,
                        cachedTokens: 0,
                        reasoningTokens: 0,
                        costUsd: null,
                        durationMs: createdAt !== null && updatedAt !== null ? Math.max(0, updatedAt - createdAt) : 0,
                        turnCount: 1,
                        usageAvailable: true,
                        recordedAt,
                      });
                    }
                  }
                }
              }
            }
          } finally {
            try { db?.close(); } catch {}
          }
        }
      } catch {
        // state_5.sqlite absent or unreadable.
      }

      const rolloutFiles = collectRecentFiles(path.join(roots.codexHome, 'sessions'), '.jsonl', 4, 200);
      for (const { file, mtimeMs, size } of rolloutFiles) {
        if (validCutoffMs !== null && mtimeMs < validCutoffMs - 86_400_000) continue;
        const parsed = parseCodexRolloutFile(file, mtimeMs, size);
        if (!parsed || codexExcluded.has(parsed.sessionId) || seenCodex.has(parsed.sessionId)) continue;
        if (options.cutoffIso && parsed.recordedAt < options.cutoffIso) continue;
        seenCodex.add(parsed.sessionId);
        results.push(parsed);
      }
    } catch {
      // Best-effort scan.
    }

    // 3. Antigravity CLI (~/.gemini/antigravity-cli/conversation_summaries.db + brain/*/transcript)
    try {
      const agExcluded = exclude.antigravity || new Set<string>();
      const seenAg = new Set<string>();
      const agDbPath = path.join(roots.antigravityRoot, 'conversation_summaries.db');
      try {
        const dbStat = fs.lstatSync(agDbPath);
        if (dbStat.isFile() && !dbStat.isSymbolicLink()) {
          let db: Database.Database | undefined;
          try {
            db = new Database(agDbPath, { readonly: true, fileMustExist: true });
            const cols = new Set(
              (db.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name?: string }>)
                .map((c) => c.name)
                .filter((n): n is string => Boolean(n)),
            );
            if (cols.has('conversation_id')) {
              const selectCols = ['conversation_id', 'title', 'workspace_uris', 'cwd', 'last_modified_time'].filter((c) => cols.has(c));
              const orderCol = cols.has('last_modified_time') ? 'last_modified_time' : 'rowid';
              const rows = db
                .prepare(`SELECT ${selectCols.join(', ')} FROM conversation_summaries ORDER BY ${orderCol} DESC LIMIT 200`)
                .all() as Array<Record<string, any>>;
              for (const row of rows) {
                const cid = typeof row.conversation_id === 'string' ? row.conversation_id.trim() : '';
                if (!cid || agExcluded.has(cid) || seenAg.has(cid)) continue;
                const updatedAtMs = parseTsMs(row.last_modified_time);
                if (validCutoffMs !== null && updatedAtMs !== null && updatedAtMs < validCutoffMs - 86_400_000) {
                  continue;
                }
                let directory: string | null = typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd.trim() : null;
                if (!directory && typeof row.workspace_uris === 'string' && row.workspace_uris.trim()) {
                  try {
                    const uris = JSON.parse(row.workspace_uris);
                    const first = Array.isArray(uris) ? uris[0] : undefined;
                    if (typeof first === 'string' && first.trim()) {
                      if (first.startsWith('file://')) {
                        try {
                          directory = fileURLToPath(first);
                        } catch {
                          directory = decodeURIComponent(new URL(first).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
                        }
                      } else {
                        directory = first;
                      }
                    }
                  } catch {
                    // Ignore malformed workspace_uris.
                  }
                }
                const fullPath = path.join(roots.antigravityRoot, 'brain', cid, '.system_generated', 'logs', 'transcript_full.jsonl');
                const compactPath = path.join(roots.antigravityRoot, 'brain', cid, '.system_generated', 'logs', 'transcript.jsonl');
                const transcriptPath = fs.existsSync(fullPath) ? fullPath : compactPath;
                const parsed = parseAntigravityTranscriptSummary(transcriptPath, cid, {
                  title: typeof row.title === 'string' ? row.title.trim() : undefined,
                  directory,
                  updatedAtMs,
                });
                if (!parsed) continue;
                if (options.cutoffIso && parsed.recordedAt < options.cutoffIso) continue;
                seenAg.add(cid);
                results.push(parsed);
              }
            }
          } finally {
            try { db?.close(); } catch {}
          }
        }
      } catch {
        // conversation_summaries.db absent or unreadable.
      }
    } catch {
      // Best-effort scan.
    }

    // 4. Claude Code (~/.claude/projects/**/*.jsonl)
    try {
      const claudeExcluded = exclude.claude_code || new Set<string>();
      const seenClaude = new Set<string>();
      const claudeFiles = collectRecentFiles(path.join(roots.claudeConfigDir, 'projects'), '.jsonl', 3, 200);
      for (const { file, mtimeMs, size } of claudeFiles) {
        if (validCutoffMs !== null && mtimeMs < validCutoffMs - 86_400_000) continue;
        const parsedList = parseClaudeJsonlFile(file, mtimeMs, size);
        for (const parsed of parsedList) {
          if (claudeExcluded.has(parsed.sessionId) || seenClaude.has(parsed.sessionId)) continue;
          if (options.cutoffIso && parsed.recordedAt < options.cutoffIso) continue;
          seenClaude.add(parsed.sessionId);
          results.push(parsed);
        }
      }
    } catch {
      // Best-effort scan.
    }

    return results;
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface OpenCodeSessionUsage {
  sessionId: string;
  title?: string;
  directory?: string | null;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalCostUsd: number | null;
  turnCount: number;
  durationMs: number;
  usageAvailable: boolean;
  lastRecordedAt: string | null;
}

export interface OpenCodeUsageLookupOptions {
  configDir?: string;
  sharedProfile?: boolean;
  xdgDataHome?: string;
  dbPath?: string;
}

export interface OpenCodeRecentSessionsOptions {
  cutoffMs?: number | null;
  limit?: number;
  xdgDataHome?: string;
  dbPath?: string;
}

interface CachedEntry<T> {
  signature: string;
  value: T;
}

const SESSION_CACHE = new Map<string, CachedEntry<OpenCodeSessionUsage | null>>();
const LIST_CACHE = new Map<string, CachedEntry<OpenCodeSessionUsage[]>>();
const CACHE_LIMIT = 128;

function setBoundedCache<T>(cache: Map<string, CachedEntry<T>>, key: string, signature: string, value: T): void {
  cache.delete(key);
  cache.set(key, { signature, value });
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
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

function dbSignature(dbPath: string): string | null {
  try {
    const stat = fs.lstatSync(dbPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    let walSig = '0:0';
    try {
      const walStat = fs.statSync(`${dbPath}-wal`);
      walSig = `${walStat.mtimeMs}:${walStat.size}`;
    } catch {
      // No WAL file.
    }
    return `${dbPath}:${stat.mtimeMs}:${stat.size}:${walSig}`;
  } catch {
    return null;
  }
}

export function resolveOpenCodeDbPaths(options: OpenCodeUsageLookupOptions = {}): string[] {
  if (options.dbPath) return [options.dbPath];
  const candidates: string[] = [];
  if (!options.sharedProfile && options.configDir) {
    candidates.push(
      path.join(options.configDir, 'data', 'opencode', 'opencode.db'),
      path.join(options.configDir, 'opencode', 'opencode.db'),
    );
  }
  const xdgDataHome = options.xdgDataHome || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  candidates.push(path.join(xdgDataHome, 'opencode', 'opencode.db'));
  return [...new Set(candidates)];
}

function tableColumns(db: Database.Database, table: 'session' | 'message'): Set<string> {
  // SECURITY: Only inspect 'session' and 'message' tables. Never touch 'account' or 'control_account'.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((r) => r.name).filter((n): n is string => Boolean(n)));
}

function aggregateMessageRows(
  rows: Array<{ data?: string | null; time_created?: number | string | null; time_updated?: number | string | null }>,
): {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costSum: number;
  hasCost: boolean;
  hasTokens: boolean;
  turnCount: number;
  minTs: number | null;
  maxTs: number | null;
  model?: string;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let costSum = 0;
  let hasCost = false;
  let hasTokens = false;
  let turnCount = 0;
  let minTs: number | null = null;
  let maxTs: number | null = null;
  let model: string | undefined;

  for (const row of rows) {
    let data: any = null;
    if (typeof row.data === 'string' && row.data.trim()) {
      try {
        data = JSON.parse(row.data);
      } catch {
        data = null;
      }
    }
    const created = parseTsMs(data?.time?.created ?? row.time_created);
    const completed = parseTsMs(data?.time?.completed ?? row.time_updated);
    for (const ts of [created, completed]) {
      if (ts !== null) {
        minTs = minTs === null ? ts : Math.min(minTs, ts);
        maxTs = maxTs === null ? ts : Math.max(maxTs, ts);
      }
    }

    if (!data || typeof data !== 'object') continue;
    if (!model) {
      const providerId = typeof data.providerID === 'string' ? data.providerID.trim() : '';
      const modelId = typeof data.modelID === 'string' ? data.modelID.trim() : '';
      if (providerId && modelId) model = `${providerId}/${modelId}`;
      else if (modelId) model = modelId;
    }

    const isAssistant = data.role === 'assistant';
    const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : null;
    if (isAssistant || tokens) {
      turnCount += 1;
      if (tokens) {
        inputTokens += nonNegInt(tokens.input);
        outputTokens += nonNegInt(tokens.output);
        reasoningTokens += nonNegInt(tokens.reasoning);
        cachedTokens += nonNegInt(tokens.cache?.read) + nonNegInt(tokens.cache?.write);
        hasTokens = true;
      }
      if (typeof data.cost === 'number' && Number.isFinite(data.cost) && data.cost >= 0) {
        costSum += data.cost;
        hasCost = true;
      }
    }
  }

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    costSum,
    hasCost,
    hasTokens,
    turnCount,
    minTs,
    maxTs,
    model,
  };
}

function buildSessionUsageFromParts(
  sessionId: string,
  sessionRow: Record<string, any> | undefined,
  msgAgg: ReturnType<typeof aggregateMessageRows>,
): OpenCodeSessionUsage | null {
  if (!sessionRow && msgAgg.turnCount === 0 && !msgAgg.hasTokens) return null;

  let inputTokens = msgAgg.inputTokens;
  let outputTokens = msgAgg.outputTokens;
  let cachedTokens = msgAgg.cachedTokens;
  let reasoningTokens = msgAgg.reasoningTokens;
  let totalCostUsd = msgAgg.hasCost ? msgAgg.costSum : null;
  let hasTokens = msgAgg.hasTokens;

  if (!hasTokens && sessionRow) {
    const sInput = nonNegInt(sessionRow.tokens_input);
    const sOutput = nonNegInt(sessionRow.tokens_output);
    const sReasoning = nonNegInt(sessionRow.tokens_reasoning);
    const sCacheRead = nonNegInt(sessionRow.tokens_cache_read);
    const sCacheWrite = nonNegInt(sessionRow.tokens_cache_write);
    if (sInput > 0 || sOutput > 0 || sReasoning > 0 || sCacheRead > 0 || sCacheWrite > 0) {
      inputTokens = sInput;
      outputTokens = sOutput;
      reasoningTokens = sReasoning;
      cachedTokens = sCacheRead + sCacheWrite;
      hasTokens = true;
    }
    if (totalCostUsd === null && typeof sessionRow.cost === 'number' && Number.isFinite(sessionRow.cost) && sessionRow.cost >= 0) {
      totalCostUsd = sessionRow.cost;
    }
  }

  let minTs = msgAgg.minTs;
  let maxTs = msgAgg.maxTs;
  if (sessionRow) {
    const sCreated = parseTsMs(sessionRow.time_created);
    const sUpdated = parseTsMs(sessionRow.time_updated);
    if (minTs === null && sCreated !== null) minTs = sCreated;
    if (maxTs === null && sUpdated !== null) maxTs = sUpdated;
    if (maxTs === null && sCreated !== null) maxTs = sCreated;
  }

  const turnCount = msgAgg.turnCount > 0 ? msgAgg.turnCount : hasTokens ? 1 : 0;
  const usageAvailable = hasTokens && (inputTokens > 0 || outputTokens > 0 || cachedTokens > 0 || reasoningTokens > 0);
  const durationMs = minTs !== null && maxTs !== null ? Math.max(0, maxTs - minTs) : 0;
  const lastRecordedAt = maxTs !== null ? new Date(maxTs).toISOString() : null;

  return {
    sessionId,
    ...(typeof sessionRow?.title === 'string' && sessionRow.title.trim() ? { title: sessionRow.title.trim() } : {}),
    directory: typeof sessionRow?.directory === 'string' && sessionRow.directory.trim() ? sessionRow.directory.trim() : null,
    ...(msgAgg.model ? { model: msgAgg.model } : {}),
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    totalCostUsd,
    turnCount,
    durationMs,
    usageAvailable,
    lastRecordedAt,
  };
}

export function readOpenCodeSessionUsage(
  sessionId: string,
  options: OpenCodeUsageLookupOptions = {},
): OpenCodeSessionUsage | null {
  if (!sessionId) return null;
  for (const dbPath of resolveOpenCodeDbPaths(options)) {
    const sig = dbSignature(dbPath);
    if (!sig) continue;

    const cacheKey = `${dbPath}\u0000${sessionId}`;
    const cached = SESSION_CACHE.get(cacheKey);
    if (cached && cached.signature === sig) {
      return cached.value;
    }

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const sessCols = tableColumns(db, 'session');
      const msgCols = tableColumns(db, 'message');
      if (!sessCols.size && !msgCols.size) {
        setBoundedCache(SESSION_CACHE, cacheKey, sig, null);
        continue;
      }

      let sessionRow: Record<string, any> | undefined;
      if (sessCols.has('id')) {
        const selectSessCols = [
          'id', 'title', 'directory', 'time_created', 'time_updated',
          'tokens_input', 'tokens_output', 'tokens_reasoning',
          'tokens_cache_read', 'tokens_cache_write', 'cost',
        ].filter((col) => sessCols.has(col));
        sessionRow = db
          .prepare(`SELECT ${selectSessCols.join(', ')} FROM session WHERE id = ?`)
          .get(sessionId) as Record<string, any> | undefined;
      }

      let msgRows: Array<{ data?: string | null; time_created?: number | string | null; time_updated?: number | string | null }> = [];
      if (msgCols.has('session_id') && msgCols.has('data')) {
        const selectMsgCols = ['data', 'time_created', 'time_updated'].filter((col) => msgCols.has(col));
        msgRows = db
          .prepare(`SELECT ${selectMsgCols.join(', ')} FROM message WHERE session_id = ?`)
          .all(sessionId) as Array<{ data?: string | null; time_created?: number | string | null; time_updated?: number | string | null }>;
      }

      const result = buildSessionUsageFromParts(sessionId, sessionRow, aggregateMessageRows(msgRows));
      setBoundedCache(SESSION_CACHE, cacheKey, sig, result);
      if (result) return result;
    } catch {
      // Ignore unreadable or incompatible DBs and try next candidate.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
  return null;
}

export function listRecentOpenCodeSessions(
  options: OpenCodeRecentSessionsOptions = {},
): OpenCodeSessionUsage[] {
  const limit = Math.min(500, Math.max(1, options.limit ?? 500));
  const cutoffMs = options.cutoffMs ?? null;

  for (const dbPath of resolveOpenCodeDbPaths({ xdgDataHome: options.xdgDataHome, dbPath: options.dbPath })) {
    const sig = dbSignature(dbPath);
    if (!sig) continue;

    const cacheKey = `${dbPath}\u0000${cutoffMs ?? 'all'}\u0000${limit}`;
    const cached = LIST_CACHE.get(cacheKey);
    if (cached && cached.signature === sig) {
      return cached.value;
    }

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const sessCols = tableColumns(db, 'session');
      const msgCols = tableColumns(db, 'message');
      if (!sessCols.has('id')) {
        setBoundedCache(LIST_CACHE, cacheKey, sig, []);
        return [];
      }

      const selectSessCols = [
        'id', 'title', 'directory', 'time_created', 'time_updated',
        'tokens_input', 'tokens_output', 'tokens_reasoning',
        'tokens_cache_read', 'tokens_cache_write', 'cost',
      ].filter((col) => sessCols.has(col));

      const orderCol = sessCols.has('time_updated')
        ? 'time_updated'
        : sessCols.has('time_created')
          ? 'time_created'
          : 'rowid';

      const whereClause = cutoffMs !== null && sessCols.has('time_updated')
        ? 'WHERE time_updated >= ?'
        : '';
      const params: unknown[] = cutoffMs !== null && sessCols.has('time_updated')
        ? [cutoffMs, limit]
        : [limit];

      const sessionRows = db
        .prepare(`SELECT ${selectSessCols.join(', ')} FROM session ${whereClause} ORDER BY ${orderCol} DESC LIMIT ?`)
        .all(...params) as Array<Record<string, any>>;

      const messagesBySession = new Map<string, Array<{ data?: string | null; time_created?: number | string | null; time_updated?: number | string | null }>>();
      if (sessionRows.length && msgCols.has('session_id') && msgCols.has('data')) {
        const selectMsgCols = ['session_id', 'data', 'time_created', 'time_updated'].filter((col) => msgCols.has(col));
        const ids = sessionRows.map((r) => String(r.id));
        const chunkSize = 100;
        for (let i = 0; i < ids.length; i += chunkSize) {
          const chunk = ids.slice(i, i + chunkSize);
          const placeholders = chunk.map(() => '?').join(', ');
          const rows = db
            .prepare(`SELECT ${selectMsgCols.join(', ')} FROM message WHERE session_id IN (${placeholders})`)
            .all(...chunk) as Array<{ session_id: string; data?: string | null; time_created?: number | string | null; time_updated?: number | string | null }>;
          for (const row of rows) {
            let bucket = messagesBySession.get(row.session_id);
            if (!bucket) {
              bucket = [];
              messagesBySession.set(row.session_id, bucket);
            }
            bucket.push(row);
          }
        }
      }

      const results: OpenCodeSessionUsage[] = [];
      for (const sRow of sessionRows) {
        const sid = String(sRow.id);
        const msgRows = messagesBySession.get(sid) || [];
        const usage = buildSessionUsageFromParts(sid, sRow, aggregateMessageRows(msgRows));
        if (!usage) continue;
        if (cutoffMs !== null && usage.lastRecordedAt) {
          const recMs = Date.parse(usage.lastRecordedAt);
          if (Number.isFinite(recMs) && recMs < cutoffMs) continue;
        }
        results.push(usage);
      }

      setBoundedCache(LIST_CACHE, cacheKey, sig, results);
      return results;
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  return [];
}

import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Application, Request, Response } from 'express';
import type {
  ActivityMode,
  ActivityTarget,
  CliProviderId,
  InsightsDailyPoint,
  InsightsModeBreakdown,
  InsightsProviderBreakdown,
  InsightsSourceScope,
  InsightsTimeRange,
  InsightsTopSession,
  InsightsUsageResponse,
} from './activity-types';
import { ensureActivityTables } from './activity-routes';
import type { LocalCliInsightsScanner } from './local-cli-insights-scanner';
import type { ManualAgent, ManualConversationStore } from './manual-conversations';
import type { PlanningTurnTelemetry } from './planning-chat';

export interface InsightsRoutesDependencies {
  sqlite: Database.Database;
  manualConversationStore: Pick<
    ManualConversationStore,
    'listAllConversations' | 'agentUsageSummary'
  > & {
    boundSessionIds?: (agent: ManualAgent) => string[];
  };
  localCliScanner?: LocalCliInsightsScanner;
}

const PROVIDERS: ReadonlyArray<{ id: CliProviderId; label: string }> = [
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'opencode', label: 'OpenCode' },
];

const MODES: readonly ActivityMode[] = ['manual', 'orchestrator', 'planning'];

function hasTable(sqlite: Database.Database, name: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function tableColumns(sqlite: Database.Database, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((r) => r.name).filter((n): n is string => Boolean(n)));
}

function normalizeFsPath(rawPath: string): string {
  const resolved = path.resolve(rawPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function matchWorkspaceForDirectory(
  directory: string | null | undefined,
  workspaces: Array<{ id: string; name: string; normPath: string }>,
): { id: string; name: string } | null {
  if (!directory || !directory.trim()) return null;
  const normDir = normalizeFsPath(directory.trim());
  let best: { id: string; name: string; normPath: string } | null = null;
  for (const ws of workspaces) {
    if (!ws.normPath) continue;
    if (normDir === ws.normPath || normDir.startsWith(`${ws.normPath}${path.sep}`)) {
      if (!best || ws.normPath.length > best.normPath.length) {
        best = ws;
      }
    }
  }
  return best ? { id: best.id, name: best.name } : null;
}

export function normalizeCliProvider(raw: unknown): CliProviderId | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'claude_code' || value === 'claude-code' || value === 'claude') return 'claude_code';
  if (value === 'codex' || value === 'openai-codex') return 'codex';
  if (value === 'antigravity' || value === 'gemini') return 'antigravity';
  if (value === 'opencode' || value === 'open_code' || value === 'open-code') return 'opencode';
  return null;
}

export function rangeCutoffIso(range: InsightsTimeRange, nowMs = Date.now()): string | null {
  const now = new Date(nowMs);
  if (range === 'today') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
  if (range === '7d') {
    return new Date(nowMs - 7 * 86_400_000).toISOString();
  }
  if (range === '30d') {
    return new Date(nowMs - 30 * 86_400_000).toISOString();
  }
  return null;
}

export function recordPlanningTurnTelemetry(
  sqlite: Database.Database,
  entry: PlanningTurnTelemetry,
  title: string,
): void {
  ensureActivityTables(sqlite);
  const itemKey = `planning:${entry.workspaceId}:${entry.planId}:${entry.conversationId}`;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO usage_ledger
        (id, workspace_id, mode, item_key, title, provider, model, outcome,
         usage_available, input_tokens, output_tokens, cached_tokens, reasoning_tokens,
         cost_usd, duration_ms, recorded_at)
       VALUES (?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `planning:${entry.turnId}`,
      entry.workspaceId,
      itemKey,
      title,
      entry.runtimeType,
      entry.model || null,
      entry.outcome,
      entry.usageAvailable ? 1 : 0,
      Math.max(0, Math.round(entry.inputTokens)),
      Math.max(0, Math.round(entry.outputTokens)),
      Math.max(0, Math.round(entry.cachedTokens || 0)),
      Math.max(0, Math.round(entry.reasoningTokens)),
      entry.totalCost == null ? null : Math.max(0, Number(entry.totalCost) || 0),
      Math.max(0, Math.round(entry.durationMs)),
      entry.recordedAt,
    );
}

interface SessionAccumulator {
  itemKey: string;
  title: string;
  workspaceId: string;
  workspaceName: string;
  mode: ActivityMode;
  providers: Set<CliProviderId>;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  durationMs: number;
  turnCount: number;
  usageAvailable: boolean;
  recordedAt: string;
  target: ActivityTarget;
  external?: boolean;
}

export function buildInsightsUsage(
  deps: InsightsRoutesDependencies,
  options: {
    range: InsightsTimeRange;
    workspaceId: string | null;
    provider?: CliProviderId | null;
    sourceScope?: InsightsSourceScope;
    nowMs?: number;
  },
): InsightsUsageResponse {
  const { sqlite, manualConversationStore, localCliScanner } = deps;
  ensureActivityTables(sqlite);

  const nowMs = options.nowMs ?? Date.now();
  const cutoff = rangeCutoffIso(options.range, nowMs);
  const workspaceId = options.workspaceId;
  const sourceScope: InsightsSourceScope = options.sourceScope ?? (localCliScanner ? 'all' : 'atris');

  const providerMap = new Map<CliProviderId, InsightsProviderBreakdown>(
    PROVIDERS.map(({ id, label }) => [
      id,
      {
        provider: id,
        label,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        totalCostUsd: null,
        sessionCount: 0,
        turnCount: 0,
        totalDurationMs: 0,
        tokenReportingCount: 0,
      },
    ]),
  );
  const providerSessions = new Map<CliProviderId, Set<string>>(
    PROVIDERS.map(({ id }) => [id, new Set<string>()]),
  );

  const modeMap = new Map<ActivityMode, InsightsModeBreakdown>(
    MODES.map((mode) => [
      mode,
      {
        mode,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        runCount: 0,
        totalDurationMs: 0,
      },
    ]),
  );

  const dailyMap = new Map<string, InsightsDailyPoint>();
  const sessions = new Map<string, SessionAccumulator>();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalReasoningTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let hasAnyCost = false;
  let totalDurationMs = 0;
  let totalRuns = 0;
  let tokenReportedRuns = 0;

  const addContribution = (entry: {
    itemKey: string;
    title: string;
    workspaceId: string;
    workspaceName: string;
    mode: ActivityMode;
    provider: CliProviderId;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    costUsd: number | null;
    durationMs: number;
    runCount: number;
    turnCount: number;
    usageAvailable: boolean;
    recordedAt: string;
    target: ActivityTarget;
    external?: boolean;
  }): void => {
    const input = Math.max(0, Math.round(entry.inputTokens));
    const output = Math.max(0, Math.round(entry.outputTokens));
    const cached = Math.max(0, Math.round(entry.cachedTokens));
    const reasoning = Math.max(0, Math.round(entry.reasoningTokens));
    const tokens = input + output + cached + reasoning;
    const duration = Math.max(0, Math.round(entry.durationMs));

    totalInputTokens += input;
    totalOutputTokens += output;
    totalCachedTokens += cached;
    totalReasoningTokens += reasoning;
    totalTokens += tokens;
    totalDurationMs += duration;
    totalRuns += entry.runCount;
    if (entry.usageAvailable) tokenReportedRuns += entry.runCount;

    if (entry.costUsd !== null && Number.isFinite(entry.costUsd) && entry.costUsd >= 0) {
      totalCostUsd += entry.costUsd;
      hasAnyCost = true;
    }

    const prov = providerMap.get(entry.provider)!;
    prov.inputTokens += input;
    prov.outputTokens += output;
    prov.cachedTokens += cached;
    prov.reasoningTokens += reasoning;
    prov.totalTokens += tokens;
    prov.turnCount += entry.turnCount;
    prov.totalDurationMs += duration;
    if (entry.usageAvailable) prov.tokenReportingCount += entry.runCount;
    if (entry.costUsd !== null && Number.isFinite(entry.costUsd) && entry.costUsd >= 0) {
      prov.totalCostUsd = (prov.totalCostUsd ?? 0) + entry.costUsd;
    }
    providerSessions.get(entry.provider)!.add(entry.itemKey);

    const modeEntry = modeMap.get(entry.mode)!;
    modeEntry.inputTokens += input;
    modeEntry.outputTokens += output;
    modeEntry.cachedTokens += cached;
    modeEntry.reasoningTokens += reasoning;
    modeEntry.totalTokens += tokens;
    modeEntry.runCount += entry.runCount;
    modeEntry.totalDurationMs += duration;

    const dateKey = entry.recordedAt.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      let point = dailyMap.get(dateKey);
      if (!point) {
        point = { date: dateKey, totalTokens: 0, byProvider: {} };
        dailyMap.set(dateKey, point);
      }
      point.totalTokens += tokens;
      point.byProvider[entry.provider] = (point.byProvider[entry.provider] ?? 0) + tokens;
    }

    let acc = sessions.get(entry.itemKey);
    if (!acc) {
      acc = {
        itemKey: entry.itemKey,
        title: entry.title,
        workspaceId: entry.workspaceId,
        workspaceName: entry.workspaceName,
        mode: entry.mode,
        providers: new Set([entry.provider]),
        model: entry.model,
        inputTokens: input,
        outputTokens: output,
        cachedTokens: cached,
        reasoningTokens: reasoning,
        totalTokens: tokens,
        durationMs: duration,
        turnCount: entry.turnCount,
        usageAvailable: entry.usageAvailable,
        recordedAt: entry.recordedAt,
        target: entry.target,
        ...(entry.external ? { external: true } : {}),
      };
      sessions.set(entry.itemKey, acc);
    } else {
      acc.providers.add(entry.provider);
      if (!acc.model && entry.model) acc.model = entry.model;
      acc.inputTokens += input;
      acc.outputTokens += output;
      acc.cachedTokens += cached;
      acc.reasoningTokens += reasoning;
      acc.totalTokens += tokens;
      acc.durationMs += duration;
      acc.turnCount += entry.turnCount;
      acc.usageAvailable = acc.usageAvailable || entry.usageAvailable;
      if (entry.recordedAt > acc.recordedAt) acc.recordedAt = entry.recordedAt;
      if (entry.external) acc.external = true;
    }
  };

  // 1. Orchestrator telemetry
  if (hasTable(sqlite, 'runtime_telemetry') && hasTable(sqlite, 'missions') && hasTable(sqlite, 'workspaces')) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (workspaceId) {
      conditions.push('m.workspace_id = ?');
      params.push(workspaceId);
    }
    if (cutoff) {
      conditions.push('rt.recorded_at >= ?');
      params.push(cutoff);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const hasAgentInstances = hasTable(sqlite, 'agent_instances');
    const rtCols = tableColumns(sqlite, 'runtime_telemetry');
    const cachedSelect = rtCols.has('cached_tokens') ? 'rt.cached_tokens AS cachedTokens' : '0 AS cachedTokens';
    const reasoningSelect = rtCols.has('reasoning_tokens') ? 'rt.reasoning_tokens AS reasoningTokens' : '0 AS reasoningTokens';
    const sql = hasAgentInstances
      ? `SELECT rt.mission_id AS missionId, m.workspace_id AS workspaceId, w.name AS workspaceName,
                m.title AS title, rt.adapter_id AS adapterId, ai.model_profile_id AS model,
                rt.usage_available AS usageAvailable, rt.input_tokens AS inputTokens,
                rt.output_tokens AS outputTokens, ${cachedSelect}, ${reasoningSelect},
                rt.cost AS cost, rt.currency AS currency,
                rt.duration_ms AS durationMs, rt.recorded_at AS recordedAt
         FROM runtime_telemetry rt
         JOIN missions m ON m.id = rt.mission_id
         JOIN workspaces w ON w.id = m.workspace_id
         LEFT JOIN agent_instances ai ON ai.id = rt.agent_instance_id
         ${whereClause}`
      : `SELECT rt.mission_id AS missionId, m.workspace_id AS workspaceId, w.name AS workspaceName,
                m.title AS title, rt.adapter_id AS adapterId, NULL AS model,
                rt.usage_available AS usageAvailable, rt.input_tokens AS inputTokens,
                rt.output_tokens AS outputTokens, ${cachedSelect}, ${reasoningSelect},
                rt.cost AS cost, rt.currency AS currency,
                rt.duration_ms AS durationMs, rt.recorded_at AS recordedAt
         FROM runtime_telemetry rt
         JOIN missions m ON m.id = rt.mission_id
         JOIN workspaces w ON w.id = m.workspace_id
         ${whereClause}`;

    const rows = sqlite.prepare(sql).all(...params) as Array<{
      missionId: string;
      workspaceId: string;
      workspaceName: string;
      title: string;
      adapterId: string;
      model: string | null;
      usageAvailable: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      reasoningTokens: number;
      cost: number | null;
      currency: string | null;
      durationMs: number;
      recordedAt: string;
    }>;

    for (const row of rows) {
      const provider = normalizeCliProvider(row.adapterId);
      if (!provider) continue;
      const isUsd = !row.currency || row.currency.toUpperCase() === 'USD';
      const costUsd = isUsd && row.cost !== null && row.cost !== undefined ? Number(row.cost) : null;
      addContribution({
        itemKey: `orchestrator:${row.missionId}`,
        title: row.title,
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        mode: 'orchestrator',
        provider,
        model: row.model || undefined,
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        cachedTokens: Number(row.cachedTokens || 0),
        reasoningTokens: Number(row.reasoningTokens || 0),
        costUsd: costUsd !== null && Number.isFinite(costUsd) ? costUsd : null,
        durationMs: Number(row.durationMs || 0),
        runCount: 1,
        turnCount: 1,
        usageAvailable: Boolean(row.usageAvailable),
        recordedAt: row.recordedAt,
        target: {
          mode: 'orchestrator',
          workspaceId: row.workspaceId,
          missionId: row.missionId,
        },
      });
    }
  }

  // 2. Planning usage ledger
  if (hasTable(sqlite, 'usage_ledger') && hasTable(sqlite, 'workspaces')) {
    const conditions: string[] = ["ul.mode = 'planning'"];
    const params: unknown[] = [];
    if (workspaceId) {
      conditions.push('ul.workspace_id = ?');
      params.push(workspaceId);
    }
    if (cutoff) {
      conditions.push('ul.recorded_at >= ?');
      params.push(cutoff);
    }
    const sql = `
      SELECT ul.workspace_id AS workspaceId, w.name AS workspaceName, ul.item_key AS itemKey,
             ul.title AS title, ul.provider AS provider, ul.model AS model,
             ul.usage_available AS usageAvailable, ul.input_tokens AS inputTokens,
             ul.output_tokens AS outputTokens, ul.cached_tokens AS cachedTokens,
             ul.reasoning_tokens AS reasoningTokens, ul.cost_usd AS costUsd,
             ul.duration_ms AS durationMs, ul.recorded_at AS recordedAt
      FROM usage_ledger ul
      JOIN workspaces w ON w.id = ul.workspace_id
      WHERE ${conditions.join(' AND ')}`;

    const rows = sqlite.prepare(sql).all(...params) as Array<{
      workspaceId: string;
      workspaceName: string;
      itemKey: string;
      title: string;
      provider: string;
      model: string | null;
      usageAvailable: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      reasoningTokens: number;
      costUsd: number | null;
      durationMs: number;
      recordedAt: string;
    }>;

    for (const row of rows) {
      const provider = normalizeCliProvider(row.provider);
      if (!provider) continue;
      const parts = row.itemKey.split(':');
      const planId = parts.length >= 4 ? parts[2] : undefined;
      const conversationId = parts.length >= 4 ? parts.slice(3).join(':') : undefined;
      addContribution({
        itemKey: row.itemKey,
        title: row.title,
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        mode: 'planning',
        provider,
        model: row.model || undefined,
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        cachedTokens: Number(row.cachedTokens || 0),
        reasoningTokens: Number(row.reasoningTokens || 0),
        costUsd: row.costUsd !== null && row.costUsd !== undefined ? Number(row.costUsd) : null,
        durationMs: Number(row.durationMs || 0),
        runCount: 1,
        turnCount: 1,
        usageAvailable: Boolean(row.usageAvailable),
        recordedAt: row.recordedAt,
        target: {
          mode: 'planning',
          workspaceId: row.workspaceId,
          ...(planId ? { planId } : {}),
          ...(conversationId ? { conversationId } : {}),
        },
      });
    }
  }

  // 3. Manual conversations
  const manualConversations = manualConversationStore.listAllConversations(workspaceId ?? undefined);
  for (const conv of manualConversations) {
    for (const agent of conv.agents) {
      const provider = normalizeCliProvider(agent.runtimeType);
      if (!provider) continue;
      const summary = manualConversationStore.agentUsageSummary(agent);
      if (summary.turnCount === 0 && !summary.usageAvailable && summary.durationMs === 0) continue;
      const recordedAt = summary.lastRecordedAt || agent.createdAt || conv.createdAt;
      if (cutoff && recordedAt < cutoff) continue;

      addContribution({
        itemKey: `manual:${conv.id}`,
        title: conv.title,
        workspaceId: conv.workspaceId,
        workspaceName: conv.workspaceName,
        mode: 'manual',
        provider,
        model: agent.model || undefined,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        cachedTokens: summary.cachedTokens,
        reasoningTokens: summary.reasoningTokens,
        costUsd: summary.totalCostUsd,
        durationMs: summary.durationMs,
        runCount: 1,
        turnCount: summary.turnCount,
        usageAvailable: summary.usageAvailable,
        recordedAt,
        target: {
          mode: 'manual',
          workspaceId: conv.workspaceId,
          conversationId: conv.id,
          agentId: agent.id,
        },
      });
    }
  }

  // 4. Optional standalone local CLI history (when sourceScope === 'all')
  if (sourceScope === 'all' && localCliScanner) {
    const excludeSessionIds: Partial<Record<CliProviderId, Set<string>>> = {};
    const allManual = workspaceId
      ? manualConversationStore.listAllConversations(undefined)
      : manualConversations;
    for (const conv of allManual) {
      for (const agent of conv.agents) {
        const provider = normalizeCliProvider(agent.runtimeType);
        if (!provider) continue;
        const boundIds = [
          ...(agent.providerSessionId ? [agent.providerSessionId] : []),
          ...(manualConversationStore.boundSessionIds?.(agent) || []),
        ];
        if (!boundIds.length) continue;
        let set = excludeSessionIds[provider];
        if (!set) {
          set = new Set<string>();
          excludeSessionIds[provider] = set;
        }
        for (const id of boundIds) {
          if (id) set.add(id);
        }
      }
    }

    const workspacesList: Array<{ id: string; name: string; normPath: string }> = hasTable(sqlite, 'workspaces')
      ? (sqlite.prepare('SELECT id, name, path FROM workspaces').all() as Array<{ id: string; name: string; path: string }>)
          .filter((w) => typeof w.path === 'string' && w.path.trim().length > 0)
          .map((w) => ({ id: w.id, name: w.name, normPath: normalizeFsPath(w.path) }))
      : [];

    const externalSessions = localCliScanner.scan({ cutoffIso: cutoff, excludeSessionIds });
    for (const ext of externalSessions) {
      const matched = matchWorkspaceForDirectory(ext.directory, workspacesList);
      if (workspaceId) {
        if (!matched || matched.id !== workspaceId) continue;
      }
      const wsId = matched?.id ?? 'external';
      const wsName = matched?.name ?? 'Local CLI';
      addContribution({
        itemKey: `external:${ext.provider}:${ext.sessionId}`,
        title: ext.title,
        workspaceId: wsId,
        workspaceName: wsName,
        mode: 'manual',
        provider: ext.provider,
        ...(ext.model ? { model: ext.model } : {}),
        inputTokens: ext.inputTokens,
        outputTokens: ext.outputTokens,
        cachedTokens: ext.cachedTokens,
        reasoningTokens: ext.reasoningTokens,
        costUsd: ext.costUsd,
        durationMs: ext.durationMs,
        runCount: 1,
        turnCount: ext.turnCount,
        usageAvailable: ext.usageAvailable,
        recordedAt: ext.recordedAt,
        target: {
          mode: 'manual',
          workspaceId: wsId,
        },
        external: true,
      });
    }
  }

  for (const { id } of PROVIDERS) {
    const prov = providerMap.get(id)!;
    prov.sessionCount = providerSessions.get(id)!.size;
  }

  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const topSessions: InsightsTopSession[] = [...sessions.values()]
    .map((acc) => ({
      itemKey: acc.itemKey,
      title: acc.title,
      workspaceId: acc.workspaceId,
      workspaceName: acc.workspaceName,
      mode: acc.mode,
      provider: acc.providers.size === 1 ? [...acc.providers][0] : ('mixed' as const),
      ...(acc.model ? { model: acc.model } : {}),
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cachedTokens: acc.cachedTokens,
      reasoningTokens: acc.reasoningTokens,
      totalTokens: acc.totalTokens,
      durationMs: acc.durationMs,
      turnCount: acc.turnCount,
      usageAvailable: acc.usageAvailable,
      recordedAt: acc.recordedAt,
      target: acc.target,
      ...(acc.external ? { external: true } : {}),
    }))
    .filter((session) => !options.provider || session.provider === options.provider)
    .sort((a, b) => {
      if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
      if (b.durationMs !== a.durationMs) return b.durationMs - a.durationMs;
      return b.recordedAt.localeCompare(a.recordedAt);
    })
    .slice(0, 25);

  return {
    range: options.range,
    workspaceId,
    sourceScope,
    totals: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedTokens: totalCachedTokens,
      reasoningTokens: totalReasoningTokens,
      totalTokens,
      totalCostUsd: hasAnyCost ? totalCostUsd : null,
      totalDurationMs,
      totalRuns,
      tokenReportedRuns,
    },
    byProvider: PROVIDERS.map(({ id }) => providerMap.get(id)!),
    byMode: MODES.map((mode) => modeMap.get(mode)!),
    daily,
    topSessions,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

export function installInsightsRoutes(app: Application, deps: InsightsRoutesDependencies): void {
  ensureActivityTables(deps.sqlite);

  app.get('/api/insights/usage', (req: Request, res: Response) => {
    try {
      const rawRange = typeof req.query.range === 'string' && req.query.range.trim()
        ? req.query.range.trim()
        : '30d';
      if (!['today', '7d', '30d', 'all'].includes(rawRange)) {
        return void res.status(400).json({ error: 'Invalid range. Expected today, 7d, 30d, or all.' });
      }
      const workspaceId =
        typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
          ? req.query.workspaceId.trim()
          : null;
      let provider: CliProviderId | null = null;
      if (typeof req.query.provider === 'string' && req.query.provider.trim() && req.query.provider.trim().toLowerCase() !== 'all') {
        provider = normalizeCliProvider(req.query.provider);
        if (!provider) {
          return void res.status(400).json({ error: 'Invalid provider.' });
        }
      }
      let sourceScope: InsightsSourceScope | undefined;
      if (typeof req.query.sourceScope === 'string' && req.query.sourceScope.trim()) {
        const rawScope = req.query.sourceScope.trim().toLowerCase();
        if (rawScope !== 'all' && rawScope !== 'atris') {
          return void res.status(400).json({ error: 'Invalid sourceScope. Expected all or atris.' });
        }
        sourceScope = rawScope;
      }
      const result = buildInsightsUsage(deps, {
        range: rawRange as InsightsTimeRange,
        workspaceId,
        provider,
        sourceScope,
      });
      res.json(result);
    } catch (error: any) {
      res.status(error?.status || error?.statusCode || 500).json({
        error: error?.message || 'Failed to compute insights usage',
      });
    }
  });
}

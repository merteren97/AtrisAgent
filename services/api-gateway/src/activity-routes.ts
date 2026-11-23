import type Database from 'better-sqlite3';
import type { Application, Request, Response } from 'express';
import { redactSensitiveValue } from '@atris-agent-code/event-bus';
import type {
  ActivityAttentionInfo,
  ActivityManualAgentSnapshot,
  ActivityMode,
  ActivityState,
  ActivitySummaryItem,
  ActivitySummaryResponse,
  ActivityTarget,
} from './activity-types';
import type { ManualConversationStore } from './manual-conversations';
import type { PlanningChatController } from './planning-chat';
import type { PlanningStore } from './planning-store';

export interface ActivityRoutesDependencies {
  sqlite: Database.Database;
  manualConversationStore: Pick<
    ManualConversationStore,
    'listAllConversations' | 'agentActivitySummary' | 'rename' | 'remove' | 'conversation'
  >;
  planningStore: Pick<PlanningStore, 'list' | 'update'>;
  planningChat: Pick<PlanningChatController, 'summarizePlanConversations' | 'updateConversation'>;
  isDeletionFenced?: (targetType: 'mission' | 'workspace', targetId: string) => boolean;
  onManualConversationRemoved?: (conversationId: string) => void;
}

interface ActivityItemMetaRow {
  item_key: string;
  pinned_at: string | null;
  last_seen_at: string | null;
  active_started_at: string | null;
  last_completed_at: string | null;
  duration_ms: number | null;
  cleared_at: string | null;
  updated_at: string;
}

const ACTIVE_MISSION_STATUSES = new Set([
  'queued',
  'starting',
  'planning',
  'running',
  'reviewing',
  'revising',
  'applying',
  'verifying',
]);

const TERMINAL_CLEARABLE_MISSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const FAILURE_ATTENTION_WINDOW_MS = 2 * 60 * 60 * 1000;
const STALE_MANUAL_START_WINDOW_MS = 6 * 60 * 60 * 1000;
const RECENT_MANUAL_AGENT_UPDATE_MS = 15 * 60 * 1000;
const MAX_MANUAL_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const UNREAD_COMPLETION_WINDOW_MS = 30 * 60 * 1000;

function isRecentUnseenFailure(
  updatedAt: string,
  meta: ActivityItemMetaRow | undefined,
  nowMs: number,
): boolean {
  const unseen = !meta?.last_seen_at || updatedAt > meta.last_seen_at;
  if (!unseen) return false;
  const updMs = safeParseMs(updatedAt);
  return updMs !== null && nowMs - updMs <= FAILURE_ATTENTION_WINDOW_MS;
}

function isUnreadCompletion(
  state: ActivityState,
  updatedAt: string,
  meta: ActivityItemMetaRow | undefined,
  nowMs: number,
): boolean {
  if (state !== 'completed') return false;
  if (meta?.last_seen_at && updatedAt <= meta.last_seen_at) return false;
  if (meta?.last_completed_at) return true;
  const updMs = safeParseMs(updatedAt);
  return updMs !== null && nowMs - updMs <= UNREAD_COMPLETION_WINDOW_MS;
}

function getExistingTables(sqlite: Database.Database, names: string[]): Set<string> {
  if (names.length === 0) return new Set();
  const placeholders = names.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...names) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function hasTable(sqlite: Database.Database, name: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function redactPreview(raw: unknown, fallback: string): string {
  const text = typeof raw === 'string' && raw.trim() ? raw : fallback;
  const cleaned = String(redactSensitiveValue(text)).replace(/\s+/g, ' ').trim();
  const resolved = cleaned || fallback;
  return resolved.length > 140 ? `${resolved.slice(0, 137)}...` : resolved;
}

function safeParseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function capitalizeStatus(status: string): string {
  if (!status) return 'Idle';
  const cleaned = status.replace(/_/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

const ensuredActivityDbs = new WeakSet<Database.Database>();

export function ensureActivityTables(sqlite: Database.Database): void {
  if (ensuredActivityDbs.has(sqlite)) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS activity_item_meta (
      item_key TEXT PRIMARY KEY,
      pinned_at TEXT,
      last_seen_at TEXT,
      active_started_at TEXT,
      last_completed_at TEXT,
      duration_ms INTEGER,
      cleared_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_ledger (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      item_key TEXT NOT NULL,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      outcome TEXT NOT NULL,
      usage_available INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_recorded ON usage_ledger(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_workspace ON usage_ledger(workspace_id, recorded_at);
  `);
  ensuredActivityDbs.add(sqlite);
}

function getMetaRow(sqlite: Database.Database, itemKey: string): ActivityItemMetaRow | undefined {
  return sqlite
    .prepare(
      `SELECT item_key, pinned_at, last_seen_at, active_started_at, last_completed_at, duration_ms, cleared_at, updated_at
       FROM activity_item_meta WHERE item_key = ?`,
    )
    .get(itemKey) as ActivityItemMetaRow | undefined;
}

function upsertManualTiming(
  sqlite: Database.Database,
  itemKey: string,
  patch: {
    activeStartedAt: string | null;
    lastCompletedAt?: string | null;
    durationMs?: number | null;
    nowIso: string;
    existing?: ActivityItemMetaRow;
  },
): ActivityItemMetaRow {
  const existing = patch.existing ?? getMetaRow(sqlite, itemKey);
  const next: ActivityItemMetaRow = {
    item_key: itemKey,
    pinned_at: existing?.pinned_at ?? null,
    last_seen_at: existing?.last_seen_at ?? null,
    active_started_at: patch.activeStartedAt,
    last_completed_at: patch.lastCompletedAt !== undefined ? patch.lastCompletedAt : (existing?.last_completed_at ?? null),
    duration_ms: patch.durationMs !== undefined ? patch.durationMs : (existing?.duration_ms ?? null),
    cleared_at: existing?.cleared_at ?? null,
    updated_at: patch.nowIso,
  };
  sqlite
    .prepare(
      `INSERT INTO activity_item_meta (item_key, pinned_at, last_seen_at, active_started_at, last_completed_at, duration_ms, cleared_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_key) DO UPDATE SET
         active_started_at = excluded.active_started_at,
         last_completed_at = excluded.last_completed_at,
         duration_ms = excluded.duration_ms,
         updated_at = excluded.updated_at`,
    )
    .run(
      next.item_key,
      next.pinned_at,
      next.last_seen_at,
      next.active_started_at,
      next.last_completed_at,
      next.duration_ms,
      next.cleared_at,
      next.updated_at,
    );
  return next;
}

function groupByMissionId<T extends { mission_id: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    let list = map.get(row.mission_id);
    if (!list) {
      list = [];
      map.set(row.mission_id, list);
    }
    list.push(row);
  }
  return map;
}

export async function buildActivitySummary(
  deps: ActivityRoutesDependencies,
  workspaceId?: string,
): Promise<ActivitySummaryResponse> {
  const { sqlite, manualConversationStore, planningStore, planningChat } = deps;
  ensureActivityTables(sqlite);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const workspaces = (workspaceId
    ? sqlite.prepare('SELECT id, name FROM workspaces WHERE id = ?').all(workspaceId)
    : sqlite.prepare('SELECT id, name FROM workspaces').all()) as Array<{ id: string; name: string }>;
  const workspaceNameById = new Map(workspaces.map((ws) => [ws.id, ws.name]));

  const metaRows = sqlite
    .prepare(
      `SELECT item_key, pinned_at, last_seen_at, active_started_at, last_completed_at, duration_ms, cleared_at, updated_at
       FROM activity_item_meta`,
    )
    .all() as ActivityItemMetaRow[];
  const metaByKey = new Map(metaRows.map((row) => [row.item_key, row]));

  const items: ActivitySummaryItem[] = [];

  // 1. Orchestrator missions
  const existingTables = getExistingTables(sqlite, [
    'missions',
    'mission_runs',
    'conversation_turns',
    'agent_instances',
    'approvals',
    'orchestrator_questions',
  ]);
  if (existingTables.has('missions')) {
    const missionRows = (workspaceId
      ? sqlite
          .prepare(
            `SELECT m.id, m.workspace_id, w.name AS workspace_name, m.title, m.status, m.execution_mode,
                    m.active_run_id, m.created_at, m.updated_at, m.completed_at
             FROM missions m
             JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.workspace_id = ?
             ORDER BY m.updated_at DESC`,
          )
          .all(workspaceId)
      : sqlite
          .prepare(
            `SELECT m.id, m.workspace_id, w.name AS workspace_name, m.title, m.status, m.execution_mode,
                    m.active_run_id, m.created_at, m.updated_at, m.completed_at
             FROM missions m
             JOIN workspaces w ON w.id = m.workspace_id
             ORDER BY m.updated_at DESC`,
          )
          .all()) as Array<{
      id: string;
      workspace_id: string;
      workspace_name: string;
      title: string;
      status: string;
      execution_mode: string;
      active_run_id: string | null;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>;

    type MissionRunRow = {
      id: string;
      mission_id: string;
      turn_id: string | null;
      status: string;
      started_at: string;
      completed_at: string | null;
      error: string | null;
    };
    type ConversationTurnRow = {
      id: string;
      mission_id: string;
      status: string;
      created_at: string;
      started_at: string | null;
      completed_at: string | null;
    };
    type AgentInstanceRow = {
      id: string;
      mission_id: string;
      role: string;
      model_profile_id: string;
      account_profile_id: string;
      runtime_adapter_id: string;
      status: string;
      created_at: string;
    };
    type PendingApprovalRow = {
      id: string;
      mission_id: string;
      task_id: string | null;
      type: string;
      description: string;
      status: string;
      created_at: string;
    };

    const hasMissions = missionRows.length > 0;
    const missionFilterClause = workspaceId ? 'mission_id IN (SELECT id FROM missions WHERE workspace_id = ?)' : '';
    const runsByMission: Map<string, MissionRunRow[]> = hasMissions && existingTables.has('mission_runs')
      ? groupByMissionId(
          (workspaceId
            ? sqlite
                .prepare(
                  `SELECT id, mission_id, turn_id, status, started_at, completed_at, error
                   FROM mission_runs WHERE ${missionFilterClause} ORDER BY started_at DESC`,
                )
                .all(workspaceId)
            : sqlite
                .prepare(
                  `SELECT id, mission_id, turn_id, status, started_at, completed_at, error
                   FROM mission_runs ORDER BY started_at DESC`,
                )
                .all()) as MissionRunRow[],
        )
      : new Map();

    const turnsByMission: Map<string, ConversationTurnRow[]> = hasMissions && existingTables.has('conversation_turns')
      ? groupByMissionId(
          (workspaceId
            ? sqlite
                .prepare(
                  `SELECT id, mission_id, status, created_at, started_at, completed_at
                   FROM conversation_turns WHERE ${missionFilterClause} ORDER BY created_at DESC`,
                )
                .all(workspaceId)
            : sqlite
                .prepare(
                  `SELECT id, mission_id, status, created_at, started_at, completed_at
                   FROM conversation_turns ORDER BY created_at DESC`,
                )
                .all()) as ConversationTurnRow[],
        )
      : new Map();

    const agentsByMission: Map<string, AgentInstanceRow[]> = hasMissions && existingTables.has('agent_instances')
      ? groupByMissionId(
          (workspaceId
            ? sqlite
                .prepare(
                  `SELECT id, mission_id, role, model_profile_id, account_profile_id, runtime_adapter_id, status, created_at
                   FROM agent_instances WHERE ${missionFilterClause} ORDER BY created_at DESC`,
                )
                .all(workspaceId)
            : sqlite
                .prepare(
                  `SELECT id, mission_id, role, model_profile_id, account_profile_id, runtime_adapter_id, status, created_at
                   FROM agent_instances ORDER BY created_at DESC`,
                )
                .all()) as AgentInstanceRow[],
        )
      : new Map();

    const approvalsByMission: Map<string, PendingApprovalRow[]> = hasMissions && existingTables.has('approvals')
      ? groupByMissionId(
          (workspaceId
            ? sqlite
                .prepare(
                  `SELECT id, mission_id, task_id, type, description, status, created_at
                   FROM approvals WHERE status = 'pending' AND ${missionFilterClause} ORDER BY created_at DESC`,
                )
                .all(workspaceId)
            : sqlite
                .prepare(
                  `SELECT id, mission_id, task_id, type, description, status, created_at
                   FROM approvals WHERE status = 'pending' ORDER BY created_at DESC`,
                )
                .all()) as PendingApprovalRow[],
        )
      : new Map();

    const questionsByMission = new Map<
      string,
      Array<{
        missionId: string;
        timestamp?: string;
        updatedAt?: string;
        agentInstanceId?: string;
        questions?: Array<{ question?: string }>;
      }>
    >();
    if (hasMissions && existingTables.has('orchestrator_questions')) {
      const qRows = (workspaceId
        ? sqlite
            .prepare(`SELECT mission_id, payload FROM orchestrator_questions WHERE ${missionFilterClause}`)
            .all(workspaceId)
        : sqlite
            .prepare('SELECT mission_id, payload FROM orchestrator_questions')
            .all()) as Array<{ mission_id: string; payload: string }>;
      for (const row of qRows) {
        try {
          const parsed = JSON.parse(row.payload);
          if (parsed?.status !== 'pending') continue;
          let list = questionsByMission.get(row.mission_id);
          if (!list) {
            list = [];
            questionsByMission.set(row.mission_id, list);
          }
          list.push(parsed);
        } catch {
          // Ignore malformed question records.
        }
      }
    }

    for (const m of missionRows) {
      const itemKey = `orchestrator:${m.id}`;
      const meta = metaByKey.get(itemKey);
      const runs = runsByMission.get(m.id) || [];
      const turns = turnsByMission.get(m.id) || [];
      const agents = agentsByMission.get(m.id) || [];
      const pendingApprovals = approvalsByMission.get(m.id) || [];
      const pendingQuestions = questionsByMission.get(m.id) || [];

      const updatedAt = m.updated_at || m.created_at;

      let state: ActivityState;
      let statusLabel: string;
      let attention: ActivityAttentionInfo | null = null;

      if (pendingQuestions.length > 0) {
        const q = pendingQuestions[0];
        state = 'attention';
        statusLabel = 'Needs input';
        attention = {
          kind: 'question',
          preview: redactPreview(q.questions?.[0]?.question, 'Question awaiting your answer'),
          sinceAt: q.timestamp || q.updatedAt || m.updated_at,
          ...(q.agentInstanceId ? { agentId: q.agentInstanceId } : {}),
        };
      } else if (pendingApprovals.length > 0) {
        const approval = pendingApprovals[0];
        state = 'attention';
        statusLabel = 'Approval needed';
        attention = {
          kind: 'approval',
          preview: redactPreview(approval.description || approval.type, 'Approval required'),
          sinceAt: approval.created_at || m.updated_at,
        };
      } else if (m.status === 'waiting_for_approval') {
        state = 'attention';
        statusLabel = 'Approval needed';
        attention = {
          kind: 'approval',
          preview: 'Waiting for approval',
          sinceAt: m.updated_at,
        };
      } else if (m.status === 'blocked') {
        state = 'attention';
        statusLabel = 'Blocked';
        attention = {
          kind: 'blocked',
          preview: 'Mission blocked',
          sinceAt: m.updated_at,
        };
      } else if (m.status === 'failed') {
        if (isRecentUnseenFailure(updatedAt, meta, nowMs)) {
          const failedRun = runs.find((run) => run.status === 'failed' && run.error);
          state = 'attention';
          statusLabel = 'Failed';
          attention = {
            kind: 'error',
            preview: redactPreview(failedRun?.error, 'Mission failed'),
            sinceAt: m.completed_at || m.updated_at,
          };
        } else {
          state = 'failed';
          statusLabel = 'Failed';
        }
      } else if (ACTIVE_MISSION_STATUSES.has(m.status)) {
        state = 'running';
        statusLabel = capitalizeStatus(m.status);
      } else if (m.status === 'completed') {
        state = 'completed';
        statusLabel = 'Completed';
      } else if (m.status === 'cancelled') {
        state = 'cancelled';
        statusLabel = 'Cancelled';
      } else {
        state = 'idle';
        statusLabel = capitalizeStatus(m.status);
      }

      if (
        meta?.cleared_at &&
        !meta.pinned_at &&
        state !== 'running' &&
        state !== 'attention' &&
        meta.cleared_at >= updatedAt
      ) {
        continue;
      }

      const activeRun =
        runs.find((r) => r.id === m.active_run_id) ||
        runs.find((r) => ['starting', 'running', 'stopping'].includes(r.status));
      const latestRun = activeRun || runs[0];
      const latestTurn = turns[0];
      const startedAt =
        latestRun?.started_at ||
        latestTurn?.started_at ||
        (state === 'running' ? m.created_at : null);
      const completedAt =
        state === 'running' ? null : (m.completed_at || latestRun?.completed_at || null);

      let durationMs: number | null = null;
      if (state === 'running') {
        const startMs = safeParseMs(startedAt);
        if (startMs !== null) durationMs = Math.max(0, nowMs - startMs);
      } else {
        let totalRunMs = 0;
        let hasRunSpan = false;
        for (const run of runs) {
          const s = safeParseMs(run.started_at);
          const e = safeParseMs(run.completed_at);
          if (s !== null && e !== null && e >= s) {
            totalRunMs += e - s;
            hasRunSpan = true;
          }
        }
        if (hasRunSpan) {
          durationMs = totalRunMs;
        } else {
          const s = safeParseMs(startedAt ?? m.created_at);
          const e = safeParseMs(completedAt);
          if (s !== null && e !== null && e >= s) durationMs = e - s;
        }
      }

      const runtimeTypes = [
        ...new Set(agents.map((a) => a.runtime_adapter_id).filter((v): v is string => Boolean(v && v.trim()))),
      ];
      const models = [
        ...new Set(agents.map((a) => a.model_profile_id).filter((v): v is string => Boolean(v && v.trim()))),
      ];
      const activeAgents = agents.filter((a) =>
        ['running', 'starting', 'active', 'working'].includes(String(a.status)),
      );
      const activeCount = activeAgents.length || (state === 'running' ? 1 : 0);
      const activeAgentId = attention?.agentId || activeAgents[0]?.id || agents[0]?.id;

      const pinnedAt = meta?.pinned_at ?? null;
      const unreadCompletion = isUnreadCompletion(state, updatedAt, meta, nowMs);

      items.push({
        itemKey,
        mode: 'orchestrator',
        workspaceId: m.workspace_id,
        workspaceName: m.workspace_name,
        title: m.title,
        state,
        statusLabel,
        runtimeTypes,
        models,
        activeCount,
        totalAgentCount: agents.length,
        attention,
        startedAt,
        completedAt,
        updatedAt,
        createdAt: m.created_at,
        durationMs,
        pinnedAt,
        unreadCompletion,
        target: {
          mode: 'orchestrator',
          workspaceId: m.workspace_id,
          missionId: m.id,
          ...(activeAgentId ? { agentId: activeAgentId } : {}),
        },
      });
    }
  }

  // 2. Manual conversations
  const manualConversations = manualConversationStore.listAllConversations(workspaceId);
  for (const conv of manualConversations) {
    const itemKey = `manual:${conv.id}`;
    let meta = metaByKey.get(itemKey);

    const agentSummaries = conv.agents.map((agent) => ({
      agent,
      summary: manualConversationStore.agentActivitySummary(agent),
    }));

    const manualAgents: ActivityManualAgentSnapshot[] = agentSummaries.map(({ agent, summary }) => {
      const activityAt = safeParseMs(summary.at);
      return {
        id: agent.id,
        name: agent.name,
        runtimeType: agent.runtimeType,
        model: agent.model,
        rawState: summary.state,
        ...(activityAt !== null ? { activityAt } : {}),
        ...(summary.attentionPreview ? { attentionPreview: summary.attentionPreview } : {}),
      };
    });

    const attentionEntry = agentSummaries.find((entry) => entry.summary.state === 'attention');
    const workingEntries = agentSummaries.filter((entry) => entry.summary.state === 'working');
    const completedEntries = agentSummaries.filter((entry) => entry.summary.state === 'completed');

    let state: ActivityState;
    let statusLabel: string;
    let attention: ActivityAttentionInfo | null = null;

    if (attentionEntry) {
      const kind = attentionEntry.summary.attentionKind || 'approval';
      state = 'attention';
      statusLabel = kind === 'question' ? 'Needs input' : 'Needs attention';
      attention = {
        kind,
        preview: attentionEntry.summary.attentionPreview || 'Needs attention',
        sinceAt: attentionEntry.summary.at || conv.createdAt,
        agentId: attentionEntry.agent.id,
      };
    } else if (workingEntries.length > 0) {
      state = 'running';
      statusLabel = 'Running';
    } else if (completedEntries.length > 0) {
      state = 'completed';
      statusLabel = 'Completed';
    } else {
      state = 'idle';
      statusLabel = agentSummaries.some((entry) => entry.summary.state === 'ready') ? 'Ready' : 'Idle';
    }

    const latestAgentAt = agentSummaries
      .map((entry) => entry.summary.at)
      .filter((at): at is string => Boolean(at && safeParseMs(at) !== null))
      .sort()
      .at(-1);
    const latestAgentMs = safeParseMs(latestAgentAt);
    const hasRecentAgentUpdate =
      latestAgentMs !== null && nowMs - latestAgentMs <= RECENT_MANUAL_AGENT_UPDATE_MS;

    let startedAt: string | null = null;
    let completedAt: string | null = null;
    let durationMs: number | null = null;

    if (state === 'running') {
      if (!meta?.active_started_at) {
        const earliestWorkingAt = workingEntries
          .map((entry) => entry.summary.at)
          .filter((at): at is string => Boolean(at && safeParseMs(at) !== null))
          .sort()[0];
        meta = upsertManualTiming(sqlite, itemKey, {
          activeStartedAt: earliestWorkingAt || nowIso,
          nowIso,
          existing: meta,
        });
        metaByKey.set(itemKey, meta);
      }
      startedAt = meta.active_started_at;
      const startMs = safeParseMs(startedAt);
      const isStaleStart =
        startMs !== null &&
        nowMs - startMs > STALE_MANUAL_START_WINDOW_MS &&
        !hasRecentAgentUpdate;
      durationMs = startMs !== null && !isStaleStart ? Math.max(0, nowMs - startMs) : null;
    } else if (state === 'attention') {
      startedAt = meta?.active_started_at ?? null;
      const startMs = safeParseMs(startedAt);
      const isStaleStart =
        startMs !== null &&
        nowMs - startMs > STALE_MANUAL_START_WINDOW_MS &&
        !hasRecentAgentUpdate;
      durationMs = startMs !== null
        ? (isStaleStart ? null : Math.max(0, nowMs - startMs))
        : (meta?.duration_ms ?? null);
    } else {
      if (meta?.active_started_at) {
        const startMs = safeParseMs(meta.active_started_at);
        const endIso = latestAgentAt || nowIso;
        const endMs = safeParseMs(endIso) ?? nowMs;
        let computedDuration: number | null =
          startMs !== null && endMs >= startMs ? endMs - startMs : null;
        if (computedDuration !== null && computedDuration > MAX_MANUAL_SESSION_DURATION_MS) {
          computedDuration = null;
        }
        startedAt = meta.active_started_at;
        completedAt = endIso;
        durationMs = computedDuration;
        meta = upsertManualTiming(sqlite, itemKey, {
          activeStartedAt: null,
          lastCompletedAt: endIso,
          durationMs: computedDuration,
          nowIso,
          existing: meta,
        });
        metaByKey.set(itemKey, meta);
      } else {
        completedAt = meta?.last_completed_at ?? (state === 'completed' ? latestAgentAt ?? null : null);
        durationMs = meta?.duration_ms ?? null;
      }
    }

    const updatedAt = latestAgentAt || completedAt || meta?.active_started_at || conv.createdAt;
    if (
      meta?.cleared_at &&
      !meta.pinned_at &&
      state !== 'running' &&
      state !== 'attention' &&
      meta.cleared_at >= updatedAt
    ) {
      continue;
    }

    const runtimeTypes = [...new Set(conv.agents.map((a) => a.runtimeType).filter(Boolean))];
    const models = [...new Set(conv.agents.map((a) => a.model).filter(Boolean))];
    const activeCount = workingEntries.length + (attentionEntry ? 1 : 0);
    const targetAgentId = attention?.agentId || workingEntries[0]?.agent.id || conv.agents[0]?.id;
    const pinnedAt = meta?.pinned_at ?? null;
    const unreadCompletion = isUnreadCompletion(state, updatedAt, meta, nowMs);

    items.push({
      itemKey,
      mode: 'manual',
      workspaceId: conv.workspaceId,
      workspaceName: conv.workspaceName,
      title: conv.title,
      state,
      statusLabel,
      runtimeTypes,
      models,
      activeCount,
      totalAgentCount: conv.agents.length,
      attention,
      startedAt,
      completedAt,
      updatedAt,
      createdAt: conv.createdAt,
      durationMs,
      pinnedAt,
      unreadCompletion,
      target: {
        mode: 'manual',
        workspaceId: conv.workspaceId,
        conversationId: conv.id,
        ...(targetAgentId ? { agentId: targetAgentId } : {}),
      },
      manualAgents,
    });
  }

  // 3. Planning conversations
  for (const ws of workspaces) {
    let plans: ReturnType<typeof planningStore.list> = [];
    try {
      plans = planningStore.list(ws.id).filter((plan) => !plan.archivedAt);
    } catch {
      continue;
    }
    for (const plan of plans) {
      let summaries: ReturnType<typeof planningChat.summarizePlanConversations> = [];
      try {
        summaries = planningChat.summarizePlanConversations(ws.id, plan.id);
      } catch {
        continue;
      }
      for (const conv of summaries) {
        const itemKey = `planning:${ws.id}:${plan.id}:${conv.conversationId}`;
        const meta = metaByKey.get(itemKey);

        const isClosed = Boolean(conv.closedAt);
        if (isClosed && !meta?.pinned_at) {
          continue;
        }

        const updatedAt = conv.updatedAt || plan.updatedAt;

        let state: ActivityState;
        let statusLabel: string;
        let attention: ActivityAttentionInfo | null = null;

        if (isClosed) {
          if (conv.status === 'complete') {
            state = 'completed';
            statusLabel = 'Completed';
          } else if (conv.status === 'failed') {
            state = 'failed';
            statusLabel = 'Failed';
          } else if (conv.status === 'cancelled') {
            state = 'cancelled';
            statusLabel = 'Cancelled';
          } else {
            state = 'idle';
            statusLabel = conv.status === 'interrupted' ? 'Interrupted' : 'Idle';
          }
        } else if (conv.approvals.length > 0) {
          const ap = conv.approvals[0];
          state = 'attention';
          statusLabel = 'Approval needed';
          attention = {
            kind: 'approval',
            preview: redactPreview(ap.description || ap.toolName, 'Approval required'),
            sinceAt: conv.updatedAt,
          };
        } else if (conv.questions.length > 0) {
          const q = conv.questions[0];
          state = 'attention';
          statusLabel = 'Needs input';
          attention = {
            kind: 'question',
            preview: redactPreview(q.questions[0]?.question, 'Waiting for your answer'),
            sinceAt: conv.updatedAt,
          };
        } else if (conv.status === 'failed') {
          if (isRecentUnseenFailure(updatedAt, meta, nowMs)) {
            state = 'attention';
            statusLabel = 'Failed';
            attention = {
              kind: 'error',
              preview: redactPreview(conv.error, 'Planning turn failed'),
              sinceAt: conv.updatedAt,
            };
          } else {
            state = 'failed';
            statusLabel = 'Failed';
          }
        } else if (conv.status === 'running') {
          state = 'running';
          statusLabel = conv.activity || 'Running';
        } else if (conv.status === 'complete') {
          state = 'completed';
          statusLabel = 'Completed';
        } else if (conv.status === 'cancelled') {
          state = 'cancelled';
          statusLabel = 'Cancelled';
        } else {
          state = 'idle';
          statusLabel = conv.status === 'interrupted' ? 'Interrupted' : 'Idle';
        }

        if (
          meta?.cleared_at &&
          !meta.pinned_at &&
          state !== 'running' &&
          state !== 'attention' &&
          meta.cleared_at >= updatedAt
        ) {
          continue;
        }

        const startMs = safeParseMs(conv.startedAt);
        const endMs = state === 'running' ? nowMs : safeParseMs(conv.updatedAt);
        const durationMs =
          startMs !== null && endMs !== null && endMs >= startMs ? endMs - startMs : null;

        const isDefaultUntitled = conv.conversationId === 'default' && conv.title === 'Planning chat';
        const title = isDefaultUntitled ? plan.title : conv.title;
        const subtitle = isDefaultUntitled ? 'Planning chat' : plan.title;
        const pinnedAt = meta?.pinned_at ?? null;
        const unreadCompletion = !isClosed && isUnreadCompletion(state, updatedAt, meta, nowMs);

        items.push({
          itemKey,
          mode: 'planning',
          workspaceId: ws.id,
          workspaceName: workspaceNameById.get(ws.id) || ws.name,
          title,
          subtitle,
          state,
          statusLabel,
          runtimeTypes: conv.runtimeType ? [conv.runtimeType] : [],
          models: conv.model ? [conv.model] : [],
          activeCount: state === 'running' || state === 'attention' ? 1 : 0,
          totalAgentCount: 1,
          attention,
          startedAt: conv.startedAt,
          completedAt: state === 'completed' ? updatedAt : null,
          updatedAt,
          createdAt: conv.createdAt,
          durationMs,
          pinnedAt,
          unreadCompletion,
          target: {
            mode: 'planning',
            workspaceId: ws.id,
            planId: plan.id,
            conversationId: conv.conversationId,
          },
        });
      }
    }
  }

  // Sort: pinned -> attention -> running -> updatedAt desc
  items.sort((a, b) => {
    const pinDiff = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt));
    if (pinDiff !== 0) return pinDiff;
    const attnDiff = Number(b.state === 'attention') - Number(a.state === 'attention');
    if (attnDiff !== 0) return attnDiff;
    const runDiff = Number(b.state === 'running') - Number(a.state === 'running');
    if (runDiff !== 0) return runDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  let attentionCount = 0;
  let runningCount = 0;
  let unreadCompletedCount = 0;
  for (const item of items) {
    if (item.state === 'attention') attentionCount += 1;
    else if (item.state === 'running') runningCount += 1;
    if (item.unreadCompletion) unreadCompletedCount += 1;
  }
  const counts = {
    attention: attentionCount,
    running: runningCount,
    unreadCompleted: unreadCompletedCount,
    total: items.length,
  };

  return {
    items,
    counts,
    generatedAt: nowIso,
  };
}

export function installActivityRoutes(app: Application, deps: ActivityRoutesDependencies): void {
  const { sqlite, manualConversationStore, planningStore, planningChat, isDeletionFenced, onManualConversationRemoved } = deps;
  ensureActivityTables(sqlite);

  app.get('/api/activity/summary', async (req: Request, res: Response) => {
    try {
      const workspaceId =
        typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
          ? req.query.workspaceId.trim()
          : undefined;
      const summary = await buildActivitySummary(deps, workspaceId);
      res.json(summary);
    } catch (error: any) {
      res.status(error?.status || error?.statusCode || 500).json({
        error: error?.message || 'Failed to build activity summary',
      });
    }
  });

  app.put('/api/activity/meta', (req: Request, res: Response) => {
    try {
      const itemKey = typeof req.body?.itemKey === 'string' ? req.body.itemKey.trim() : '';
      if (!itemKey || itemKey.length > 512) {
        return void res.status(400).json({ error: 'Invalid itemKey.' });
      }
      const pinned = req.body?.pinned;
      const markSeen = req.body?.markSeen;
      const cleared = req.body?.cleared;
      if (pinned !== undefined && typeof pinned !== 'boolean') {
        return void res.status(400).json({ error: 'pinned must be a boolean.' });
      }
      if (markSeen !== undefined && typeof markSeen !== 'boolean') {
        return void res.status(400).json({ error: 'markSeen must be a boolean.' });
      }
      if (cleared !== undefined && typeof cleared !== 'boolean') {
        return void res.status(400).json({ error: 'cleared must be a boolean.' });
      }

      const nowIso = new Date().toISOString();
      const existing = getMetaRow(sqlite, itemKey);
      const nextPinnedAt =
        pinned === true ? (existing?.pinned_at || nowIso) : pinned === false ? null : (existing?.pinned_at ?? null);
      const nextLastSeenAt =
        markSeen === true ? nowIso : (existing?.last_seen_at ?? null);
      const nextClearedAt =
        cleared === true ? nowIso : cleared === false ? null : (existing?.cleared_at ?? null);

      sqlite
        .prepare(
          `INSERT INTO activity_item_meta (item_key, pinned_at, last_seen_at, active_started_at, last_completed_at, duration_ms, cleared_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(item_key) DO UPDATE SET
             pinned_at = excluded.pinned_at,
             last_seen_at = excluded.last_seen_at,
             cleared_at = excluded.cleared_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          itemKey,
          nextPinnedAt,
          nextLastSeenAt,
          existing?.active_started_at ?? null,
          existing?.last_completed_at ?? null,
          existing?.duration_ms ?? null,
          nextClearedAt,
          nowIso,
        );

      res.json({
        ok: true,
        itemKey,
        pinnedAt: nextPinnedAt,
        lastSeenAt: nextLastSeenAt,
        clearedAt: nextClearedAt,
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to update activity metadata' });
    }
  });

  app.patch('/api/activity/rename', async (req: Request, res: Response) => {
    try {
      const target = req.body?.target as ActivityTarget | undefined;
      const rawTitle = req.body?.title;
      if (typeof rawTitle !== 'string' || !rawTitle.trim() || rawTitle.trim().length > 200) {
        return void res.status(400).json({ error: 'Title must be 1-200 characters.' });
      }
      const title = rawTitle.trim();
      if (!target || typeof target !== 'object' || !target.workspaceId) {
        return void res.status(400).json({ error: 'Invalid rename target.' });
      }

      if (target.mode === 'manual') {
        if (!target.conversationId) {
          return void res.status(400).json({ error: 'conversationId is required for manual rename.' });
        }
        const updated = manualConversationStore.rename(target.conversationId, title);
        return void res.json({ ok: true, target, title: updated.title });
      }

      if (target.mode === 'orchestrator') {
        if (!target.missionId) {
          return void res.status(400).json({ error: 'missionId is required for orchestrator rename.' });
        }
        const mission = sqlite
          .prepare('SELECT id, workspace_id FROM missions WHERE id = ?')
          .get(target.missionId) as { id: string; workspace_id: string } | undefined;
        if (!mission) {
          return void res.status(404).json({ error: 'Conversation not found.' });
        }
        if (isDeletionFenced?.('mission', target.missionId) || isDeletionFenced?.('workspace', mission.workspace_id)) {
          return void res.status(409).json({ error: 'Conversation deletion is in progress.' });
        }
        const nowIso = new Date().toISOString();
        sqlite
          .prepare('UPDATE missions SET title = ?, updated_at = ? WHERE id = ?')
          .run(title, nowIso, target.missionId);
        return void res.json({ ok: true, target, title });
      }

      if (target.mode === 'planning') {
        if (!target.planId) {
          return void res.status(400).json({ error: 'planId is required for planning rename.' });
        }
        if (isDeletionFenced?.('workspace', target.workspaceId)) {
          return void res.status(409).json({ error: 'Workspace deletion is in progress.' });
        }
        if (target.conversationId && target.conversationId !== 'default') {
          const updated = await planningChat.updateConversation(
            target.workspaceId,
            target.planId,
            target.conversationId,
            { title },
          );
          return void res.json({ ok: true, target, title: updated.title });
        }
        const updatedPlan = planningStore.update(target.workspaceId, target.planId, { title });
        return void res.json({ ok: true, target, title: updatedPlan.title });
      }

      return void res.status(400).json({ error: 'Unsupported activity target mode.' });
    } catch (error: any) {
      res.status(error?.status || error?.statusCode || 500).json({
        error: error?.message || 'Failed to rename activity item',
      });
    }
  });

  app.post('/api/activity/clear-completed', async (req: Request, res: Response) => {
    try {
      const workspaceId =
        typeof req.body?.workspaceId === 'string' && req.body.workspaceId.trim()
          ? req.body.workspaceId.trim()
          : undefined;
      const mode = req.body?.mode as ActivityMode | undefined;
      if (mode !== undefined && mode !== 'manual' && mode !== 'orchestrator' && mode !== 'planning') {
        return void res.status(400).json({ error: 'Invalid mode.' });
      }
      const closedManualIds: string[] = Array.isArray(req.body?.closedManualConversationIds)
        ? (req.body.closedManualConversationIds as unknown[]).filter(
            (id: unknown): id is string => typeof id === 'string' && Boolean(id.trim()),
          )
        : [];

      const nowIso = new Date().toISOString();
      let clearedCount = 0;

      // 1. Orchestrator missions
      if ((!mode || mode === 'orchestrator') && hasTable(sqlite, 'missions')) {
        const candidates = (workspaceId
          ? sqlite
              .prepare('SELECT id, workspace_id, status, active_run_id FROM missions WHERE workspace_id = ?')
              .all(workspaceId)
          : sqlite
              .prepare('SELECT id, workspace_id, status, active_run_id FROM missions')
              .all()) as Array<{ id: string; workspace_id: string; status: string; active_run_id: string | null }>;

        const pendingApprovalMissions = new Set<string>(
          hasTable(sqlite, 'approvals')
            ? (sqlite.prepare("SELECT DISTINCT mission_id FROM approvals WHERE status = 'pending'").all() as Array<{ mission_id: string }>).map(
                (r) => r.mission_id,
              )
            : [],
        );
        const activeRunMissions = new Set<string>(
          hasTable(sqlite, 'mission_runs')
            ? (
                sqlite
                  .prepare("SELECT DISTINCT mission_id FROM mission_runs WHERE status IN ('starting', 'running', 'stopping')")
                  .all() as Array<{ mission_id: string }>
              ).map((r) => r.mission_id)
            : [],
        );
        const pendingQuestionMissions = new Set<string>();
        if (hasTable(sqlite, 'orchestrator_questions')) {
          const rows = sqlite
            .prepare('SELECT mission_id, payload FROM orchestrator_questions')
            .all() as Array<{ mission_id: string; payload: string }>;
          for (const row of rows) {
            try {
              if (JSON.parse(row.payload)?.status === 'pending') {
                pendingQuestionMissions.add(row.mission_id);
              }
            } catch {
              // Ignore malformed JSON.
            }
          }
        }

        sqlite.transaction(() => {
          for (const mission of candidates) {
            if (!TERMINAL_CLEARABLE_MISSION_STATUSES.has(mission.status)) continue;
            if (mission.active_run_id !== null) continue;
            if (isDeletionFenced?.('mission', mission.id) || isDeletionFenced?.('workspace', mission.workspace_id)) {
              continue;
            }
            if (
              pendingApprovalMissions.has(mission.id) ||
              activeRunMissions.has(mission.id) ||
              pendingQuestionMissions.has(mission.id)
            ) {
              continue;
            }
            const itemKey = `orchestrator:${mission.id}`;
            const meta = getMetaRow(sqlite, itemKey);
            if (meta?.pinned_at) continue;

            // Keep failed missions out of clear-completed if they are still flagged as attention?
            // Wait: clear-completed clears terminal ('completed', 'failed', 'cancelled') missions that are not pinned or active.
            const result = sqlite
              .prepare('DELETE FROM missions WHERE id = ? AND active_run_id IS NULL')
              .run(mission.id);
            if (result.changes > 0) {
              sqlite.prepare('DELETE FROM activity_item_meta WHERE item_key = ?').run(itemKey);
              clearedCount += 1;
            }
          }
        })();
      }

      // 2. Manual conversations (only explicit closedManualConversationIds)
      if ((!mode || mode === 'manual') && closedManualIds.length > 0) {
        const allManual = manualConversationStore.listAllConversations(workspaceId);
        const byId = new Map(allManual.map((conv) => [conv.id, conv]));
        for (const convId of new Set(closedManualIds)) {
          const conv = byId.get(convId);
          if (!conv) continue;
          const itemKey = `manual:${conv.id}`;
          const meta = getMetaRow(sqlite, itemKey);
          if (meta?.pinned_at) continue;
          const agentStates = conv.agents.map((agent) => manualConversationStore.agentActivitySummary(agent).state);
          if (agentStates.some((state) => state === 'working' || state === 'attention')) continue;

          onManualConversationRemoved?.(conv.id);
          manualConversationStore.remove(conv.id);
          sqlite.prepare('DELETE FROM activity_item_meta WHERE item_key = ?').run(itemKey);
          clearedCount += 1;
        }
      }

      // 3. Planning conversations (soft clear via cleared_at; never delete plan markdown files)
      if (!mode || mode === 'planning') {
        const workspaces = (workspaceId
          ? sqlite.prepare('SELECT id FROM workspaces WHERE id = ?').all(workspaceId)
          : sqlite.prepare('SELECT id FROM workspaces').all()) as Array<{ id: string }>;
        for (const ws of workspaces) {
          let plans: ReturnType<typeof planningStore.list> = [];
          try {
            plans = planningStore.list(ws.id).filter((plan) => !plan.archivedAt);
          } catch {
            continue;
          }
          for (const plan of plans) {
            let summaries: ReturnType<typeof planningChat.summarizePlanConversations> = [];
            try {
              summaries = planningChat.summarizePlanConversations(ws.id, plan.id);
            } catch {
              continue;
            }
            for (const conv of summaries) {
              if (conv.status === 'running' || conv.approvals.length > 0 || conv.questions.length > 0 || conv.status === 'failed') {
                continue;
              }
              const itemKey = `planning:${ws.id}:${plan.id}:${conv.conversationId}`;
              const meta = getMetaRow(sqlite, itemKey);
              if (meta?.pinned_at) continue;
              const updatedAt = conv.updatedAt || plan.updatedAt;
              if (meta?.cleared_at && meta.cleared_at >= updatedAt) continue;

              sqlite
                .prepare(
                  `INSERT INTO activity_item_meta (item_key, pinned_at, last_seen_at, active_started_at, last_completed_at, duration_ms, cleared_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(item_key) DO UPDATE SET
                     cleared_at = excluded.cleared_at,
                     updated_at = excluded.updated_at`,
                )
                .run(
                  itemKey,
                  meta?.pinned_at ?? null,
                  meta?.last_seen_at ?? null,
                  meta?.active_started_at ?? null,
                  meta?.last_completed_at ?? null,
                  meta?.duration_ms ?? null,
                  nowIso,
                  nowIso,
                );
              clearedCount += 1;
            }
          }
        }
      }

      res.json({ clearedCount });
    } catch (error: any) {
      res.status(error?.status || error?.statusCode || 500).json({
        error: error?.message || 'Failed to clear completed items',
      });
    }
  });
}

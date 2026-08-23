import http from 'node:http';
import { createHash } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import * as schema from '@atris-agent-code/database';
import type { AtrisDatabase } from '@atris-agent-code/database';
import { migrateDatabase } from '@atris-agent-code/database';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import { Orchestrator } from '@atris-agent-code/orchestration-core';
import { RuntimeHost } from '@atris-agent-code/runtime-host';
import { MergeCoordinator } from '@atris-agent-code/merge-coordinator';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import { AtrisAuthService, extractBearerHeader, installAuthRoutes } from './auth';
import {
  authorizeRuntimeToken,
  createRuntimeTokenMiddleware,
  emitRuntimeReady,
  gatewayVersion,
  resolveGatewayDataPath,
  resolveGatewayPort,
  runtimeTokenFromEnvironment,
  shouldAutoStartGateway,
} from './runtime-protocol';
import {
  createRuntimeShutdownCoordinator,
  installRuntimeShutdownRoute,
} from './runtime-lifecycle';

import path from 'path';
import fs from 'fs';

// 1. Database Initialization
const RUNTIME_TOKEN = runtimeTokenFromEnvironment();
const gatewayDataPath = resolveGatewayDataPath();
const dbDir = path.dirname(gatewayDataPath.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = gatewayDataPath.dbPath;
const sqlite = new Database(dbPath);
sqlite.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    git_initialized INTEGER NOT NULL DEFAULT 0,
    last_opened_at TEXT,
    last_team_template_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    team_template_id TEXT NOT NULL DEFAULT '',
    plan_id TEXT,
    execution_mode TEXT NOT NULL DEFAULT 'balanced',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned',
    priority TEXT NOT NULL DEFAULT 'medium',
    assigned_agent_id TEXT,
    assigned_role TEXT,
    required_capabilities TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    worktree_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS account_profiles (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    runtime_type TEXT NOT NULL,
    profile_name TEXT NOT NULL,
    auth_status TEXT NOT NULL DEFAULT 'not_installed',
    config_dir TEXT NOT NULL DEFAULT '',
    supported_models TEXT NOT NULL,
    usage_scope TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_default INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_roles (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES team_templates(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    model_profile_id TEXT DEFAULT '',
    account_profile_id TEXT DEFAULT '',
    default_capabilities TEXT NOT NULL,
    access_level TEXT NOT NULL DEFAULT 'read'
  );

  CREATE TABLE IF NOT EXISTS execution_policies (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    role TEXT NOT NULL,
    model_catalog_id TEXT,
    account_profile_id TEXT,
    reasoning_level TEXT,
    fallback_catalog_ids TEXT NOT NULL DEFAULT '[]',
    selection_mode TEXT NOT NULL DEFAULT 'auto',
    source TEXT NOT NULL DEFAULT 'team_template',
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_policies_scope_role
    ON execution_policies(scope_type, scope_id, role);

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    task_id TEXT,
    run_id TEXT,
    type TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT DEFAULT 'pending',
    decided_by TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );

  CREATE TABLE IF NOT EXISTS mission_events (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    task_id TEXT,
    agent_instance_id TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mission_events_mission_created ON mission_events(mission_id, created_at);

  CREATE TABLE IF NOT EXISTS task_dependencies (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS task_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    agent_instance_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'running',
    worktree_path TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT,
    result_summary TEXT,
    review_pack TEXT
  );

  CREATE TABLE IF NOT EXISTS model_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    runtime_type TEXT NOT NULL,
    account_profile_id TEXT,
    suitable_roles TEXT NOT NULL,
    available INTEGER DEFAULT 1,
    supports_reasoning INTEGER DEFAULT 0,
    reasoning_levels TEXT NOT NULL,
    context_class TEXT DEFAULT 'medium',
    speed_class TEXT DEFAULT 'standard',
    is_subscription INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agent_instances (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    model_profile_id TEXT DEFAULT '',
    account_profile_id TEXT DEFAULT '',
    runtime_adapter_id TEXT DEFAULT '',
    session_id TEXT,
    status TEXT DEFAULT 'idle',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resource_leases (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    held_by_agent_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    task_id TEXT,
    run_id TEXT,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT,
    content TEXT,
    size_bytes INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage_snapshots (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    agent_instance_id TEXT,
    account_profile_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost INTEGER,
    currency TEXT DEFAULT 'USD',
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS worktrees (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    label TEXT NOT NULL,
    git_ref TEXT,
    snapshot_path TEXT,
    created_at TEXT NOT NULL,
    is_rollback_target INTEGER NOT NULL DEFAULT 0
  );
`);
migrateDatabase(sqlite as any);

const db = drizzle(sqlite, { schema }) as unknown as AtrisDatabase;

// Seed default team template
try {
  const existingTemplates = db.select().from((schema as any).teamTemplates).all() as any[];
  if (existingTemplates.length === 0) {
    const templateId = 'default-core-dev-team';
    const now = new Date().toISOString();
    db.insert((schema as any).teamTemplates).values({
      id: templateId,
      name: 'Core Dev Team',
      description: 'Orchestrator, Builder, Reviewer, Researcher, QA',
      isDefault: true,
      createdAt: now,
    }).run();

    const roles = [
      { role: 'orchestrator', accessLevel: 'orchestration', caps: ['planning', 'evaluation'] },
      { role: 'builder', accessLevel: 'write', caps: ['TypeScript', 'React', 'workspace-write'] },
      { role: 'reviewer', accessLevel: 'read', caps: ['code-review', 'security-review'] },
      { role: 'researcher', accessLevel: 'read', caps: ['documentation', 'research'] },
      { role: 'qa', accessLevel: 'tests_and_build', caps: ['testing', 'build', 'lint'] },
    ];

    for (const r of roles) {
      db.insert((schema as any).teamRoles).values({
        id: crypto.randomUUID(),
        templateId,
        role: r.role,
        modelProfileId: '',
        accountProfileId: '',
        defaultCapabilities: r.caps,
        accessLevel: r.accessLevel,
      }).run();
    }
    console.log('[API Gateway] Seeded default Core Dev Team template');
  }
} catch {
  console.log('[API Gateway] Skipping seed: tables might not exist yet.');
}

// 2. Core Service Setup
const eventBus = new LocalEventBus();
const workspaceManager = new WorkspaceManager(db, eventBus);
const mergeCoordinator = new MergeCoordinator(workspaceManager);
const orchestrator = new Orchestrator(
  {
    workspacePath: process.cwd(),
    applyTaskChanges: async (taskId) => {
      const result = await mergeCoordinator.applyWorktree(taskId);
      return { success: result.success, output: result.output, checkpointId: result.checkpointId };
    },
  },
  eventBus,
  db,
  workspaceManager,
);
const runtimeHost = new RuntimeHost(eventBus, { workspacePath: process.cwd(), workspaceManager });

function redactEventValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/Authorization:\s*(?:Bearer|Basic)\s+[^\s"'\r\n]+/gi, 'Authorization: [REDACTED]')
      .replace(/\b(?:sk-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_.-]{12,}\b/g, '[REDACTED_SECRET]')
      .replace(/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi, '$1=[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redactEventValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactEventValue(item)]));
  }
  return value;
}

// Persist normalized events so the timeline, checks and artifacts can be restored after restart.
eventBus.on('*', (event: AgentEvent) => {
  if (!event.missionId) return;
  const taskId = 'taskId' in event && typeof event.taskId === 'string' ? event.taskId : null;
  const agentInstanceId = 'agentInstanceId' in event && typeof event.agentInstanceId === 'string' ? event.agentInstanceId : null;
  const payload = redactEventValue(event) as Record<string, unknown>;
  if (event.type === 'approval_requested') {
    try {
      const existing = (db.select().from((schema as any).approvals)
        .where(eq((schema as any).approvals.id, event.approvalId)).all() as any[])[0];
      if (!existing) {
        db.insert((schema as any).approvals).values({
          id: event.approvalId,
          missionId: event.missionId,
          taskId: 'taskId' in event && typeof (event as any).taskId === 'string' ? (event as any).taskId : null,
          runId: null,
          type: event.approvalType as any,
          description: event.description,
          status: 'pending',
          createdAt: event.timestamp,
        }).run();
      }
    } catch (error) {
      console.warn('[API Gateway] Failed to persist approval request:', error);
    }
  }
  try {
    const persisted = sqlite.transaction(() => {
      const duplicate = sqlite.prepare('SELECT payload FROM mission_events WHERE id = ?').get(event.id) as { payload: string } | undefined;
      if (duplicate) return JSON.parse(duplicate.payload) as AgentEvent;
      const sequence = Number((sqlite.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM mission_events WHERE mission_id = ?')
        .get(event.missionId) as { sequence: number }).sequence);
      const enriched = { ...payload, sequence, schemaVersion: 1 } as unknown as AgentEvent;
      sqlite.prepare(`INSERT INTO mission_events
        (id, mission_id, task_id, agent_instance_id, type, payload, sequence, schema_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(event.id, event.missionId, taskId, agentInstanceId, event.type, JSON.stringify(enriched), sequence, event.timestamp);
      return enriched;
    })();
    Object.assign(event, persisted);
  } catch (error) {
    console.warn('[API Gateway] Failed to persist mission event:', error);
  }
});

// 3. Express App & HTTP Server
const app = express();
const allowedOrigins = new Set([
  'http://127.0.0.1:1420',
  'http://localhost:1420',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) callback(null, true);
    else callback(new Error(`Origin ${origin} is not allowed by the local AtrisAgent service.`));
  },
}));
app.use(createRuntimeTokenMiddleware(RUNTIME_TOKEN));
app.use(express.json({ limit: '2mb' }));

// AtrisHub remains the authoritative identity and Premium entitlement service.
// Auth routes are installed before the business API gate so login/logout can be
// reached without a local session, while every other /api route is protected.
const authService = new AtrisAuthService();
const PORT = resolveGatewayPort();
const server = http.createServer(app);
const shutdownCoordinator = createRuntimeShutdownCoordinator({
  stopRuntimeHost: () => runtimeHost.stopAll(),
  closeServer: () => new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    // End long-lived SSE/upgrade clients so graceful shutdown is not held
    // open until the bounded forced-exit timer fires.
    server.closeAllConnections?.();
    server.close(() => resolve());
  }),
  closeDatabase: () => {
    if ((sqlite as Database.Database).open) sqlite.close();
  },
}, {
  onComplete: () => process.exit(0),
});

// This endpoint is deliberately absent from development runtimes without a
// sidecar token. When present it is registered before AtrisHub/Premium
// middleware, while the global runtime-token gate remains the first transport
// boundary for every request.
installRuntimeShutdownRoute(app, RUNTIME_TOKEN, shutdownCoordinator);
installAuthRoutes(app, authService);

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] || '' : value;
}

function normalizeFallbackCatalogIds(value: unknown, primaryCatalogId?: string): string[] {
  const values: unknown[] = Array.isArray(value) ? value : [];
  return Array.from(new Set(
    values
      .map((item: unknown) => String(item).trim())
      .filter((item: string) => item.length > 0 && item !== primaryCatalogId),
  ));
}

const ACTIVE_MISSION_STATUSES = new Set([
  'planning',
  'ready',
  'running',
  'waiting_for_approval',
  'applying',
  'reviewing',
  'verifying',
  'revising',
]);
const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const missionDrains = new Map<string, Promise<void>>();

function stableJson(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
    return item;
  };
  return JSON.stringify(canonicalize(value));
}

function turnRequestHash(missionId: string, content: string, delivery: string, options: Record<string, unknown>): string {
  return createHash('sha256').update(`${missionId}\n${content}\n${delivery}\n${stableJson(options)}`).digest('hex');
}

function turnDto(turn: any, command?: any): Record<string, unknown> {
  const options = typeof turn.options === 'string' ? JSON.parse(turn.options || '{}') : turn.options || {};
  return {
    id: turn.id,
    missionId: turn.mission_id,
    commandId: turn.command_id || command?.id || null,
    content: turn.content,
    delivery: turn.delivery,
    options,
    status: turn.status,
    priorityPending: turn.status === 'pending_priority',
    createdAt: turn.created_at,
    startedAt: turn.started_at || null,
    completedAt: turn.completed_at || null,
  };
}

function normalizeAutomationPolicy(body: Record<string, any>): import('@atris-agent-code/domain').MissionAutomationPolicy {
  const legacy = String(body.trustMode || body.executionMode || '').toLowerCase();
  const profile = body.trustProfile === 'ask' || body.trustProfile === 'review' || body.trustProfile === 'auto'
    ? body.trustProfile
    : legacy.includes('review driven') || legacy === 'review_driven' ? 'ask'
      : legacy.includes('autonomous') || legacy === 'autonomous' ? 'auto' : 'review';
  const strategy = body.executionStrategy === 'candidate' || legacy === 'candidate' ? 'candidate' : 'standard';
  const allowedActions = new Set(['plan', 'fileWrite', 'deleteFiles', 'commandExecution', 'packageInstall', 'gitCommit', 'databaseMigration', 'workspaceApply', 'gitPush', 'pullRequest']);
  const allowedDecisions = new Set(['ask', 'review', 'auto', 'deny']);
  const overrides: Record<string, string> = {};
  for (const [action, decision] of Object.entries(body.automationOverrides || {})) {
    if (!allowedActions.has(action) || !allowedDecisions.has(String(decision))) throw new Error(`Invalid automation override: ${action}`);
    overrides[action] = String(decision);
  }
  for (const [action, enabled] of Object.entries(body.automationSettings || {})) {
    if (allowedActions.has(action) && typeof enabled === 'boolean' && overrides[action] === undefined) overrides[action] = enabled ? 'auto' : 'ask';
  }
  return { profile, strategy, overrides } as import('@atris-agent-code/domain').MissionAutomationPolicy;
}

function emitTurnEvent(event: AgentEvent): void {
  eventBus.emit(event);
}

async function startDurableTurn(command: any, turn: any): Promise<void> {
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE conversation_turns SET status = 'starting', started_at = ? WHERE id = ?").run(now, turn.id);
    sqlite.prepare("INSERT INTO mission_runs (id, mission_id, turn_id, command_id, status, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 'starting', ?, ?)")
      .run(runId, command.mission_id, turn.id, command.id, now, now);
    sqlite.prepare('UPDATE missions SET active_run_id = ? WHERE id = ?').run(runId, command.mission_id);
  })();
  emitTurnEvent({ id: crypto.randomUUID(), type: 'turn_started', missionId: command.mission_id, turnId: turn.id, runId,
    content: turn.content, delivery: turn.delivery, timestamp: now });
  try {
    const options = turn.options ? JSON.parse(turn.options) : {};
    configureMissionRouting(command.mission_id, options);
    const result = await orchestrator.startMission(command.mission_id, turn.content, { ...options, turnId: turn.id, runId });
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE mission_commands SET status = 'completed', processed_at = ? WHERE id = ?").run(new Date().toISOString(), command.id);
      sqlite.prepare("UPDATE conversation_turns SET status = 'running' WHERE id = ? AND status = 'starting'").run(turn.id);
      sqlite.prepare("UPDATE mission_runs SET status = 'running', plan_id = ?, heartbeat_at = ? WHERE id = ? AND status = 'starting'")
        .run(result.planId || null, new Date().toISOString(), runId);
    })();
  } catch (error: any) {
    const failedAt = new Date().toISOString();
    sqlite.transaction(() => {
      sqlite.prepare("UPDATE mission_commands SET status = 'failed', processed_at = ?, error = ? WHERE id = ?").run(failedAt, error?.message || String(error), command.id);
      sqlite.prepare("UPDATE conversation_turns SET status = 'failed', completed_at = ? WHERE id = ?").run(failedAt, turn.id);
      sqlite.prepare("UPDATE mission_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?").run(failedAt, error?.message || String(error), runId);
      sqlite.prepare('UPDATE missions SET active_run_id = NULL WHERE id = ? AND active_run_id = ?').run(command.mission_id, runId);
    })();
    throw error;
  }
}

function drainMissionCommands(missionId: string): Promise<void> {
  const existing = missionDrains.get(missionId);
  if (existing) return existing;
  const drain = (async () => {
    while (true) {
      const mission = await workspaceManager.getMission(missionId);
      if (!mission || !TERMINAL_MISSION_STATUSES.has(String(mission.status))) return;
      const claimed = sqlite.transaction(() => {
      const activeRun = sqlite.prepare("SELECT id FROM mission_runs WHERE mission_id = ? AND status IN ('starting', 'running', 'stopping') LIMIT 1").get(missionId);
      if (activeRun) return null;
      const candidate = sqlite.prepare(`SELECT * FROM mission_commands WHERE mission_id = ? AND status = 'pending'
        ORDER BY priority DESC, created_at, id LIMIT 1`).get(missionId) as any;
      if (!candidate) return null;
      const claim = sqlite.prepare("UPDATE mission_commands SET status = 'processing', claimed_at = ?, attempt_count = attempt_count + 1 WHERE id = ? AND status = 'pending'")
        .run(new Date().toISOString(), candidate.id) as { changes: number };
      return claim.changes === 1 ? candidate : null;
      })();
      const command = claimed as any;
      if (!command) return;
      const turn = sqlite.prepare('SELECT * FROM conversation_turns WHERE id = ?').get(command.turn_id) as any;
      if (!turn) {
        sqlite.prepare("UPDATE mission_commands SET status = 'failed', processed_at = ?, error = 'Conversation turn is missing' WHERE id = ?")
          .run(new Date().toISOString(), command.id);
        continue;
      }
      await startDurableTurn(command, turn);
      const active = sqlite.prepare("SELECT id FROM mission_runs WHERE mission_id = ? AND status IN ('starting', 'running', 'stopping') LIMIT 1").get(missionId);
      if (active) return;
    }
  })().catch((error) => console.warn('[API Gateway] Failed to drain mission command:', error))
    .finally(() => missionDrains.delete(missionId));
  missionDrains.set(missionId, drain);
  return drain;
}

async function startMissionWithDurability(missionId: string, content: string, options: Record<string, any>): Promise<any> {
  const now = new Date().toISOString();
  const turnId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  sqlite.transaction(() => {
    sqlite.prepare(`INSERT INTO conversation_turns
      (id, mission_id, content, delivery, options, status, created_at, started_at)
      VALUES (?, ?, ?, 'queue', ?, 'starting', ?, ?)`).run(turnId, missionId, content, JSON.stringify(options), now, now);
    sqlite.prepare(`INSERT INTO mission_runs (id, mission_id, turn_id, status, started_at, heartbeat_at)
      VALUES (?, ?, ?, 'starting', ?, ?)`).run(runId, missionId, turnId, now, now);
    sqlite.prepare('UPDATE missions SET active_run_id = ? WHERE id = ?').run(runId, missionId);
  })();
  emitTurnEvent({ id: crypto.randomUUID(), type: 'turn_started', missionId, turnId, runId,
    content, delivery: 'queue', timestamp: now });
  try {
    const result = await orchestrator.startMission(missionId, content, { ...options, turnId, runId });
    sqlite.prepare("UPDATE conversation_turns SET status = 'running' WHERE id = ? AND status = 'starting'").run(turnId);
    sqlite.prepare("UPDATE mission_runs SET status = 'running', plan_id = ?, heartbeat_at = ? WHERE id = ? AND status = 'starting'")
      .run(result.planId || null, new Date().toISOString(), runId);
    return result;
  } catch (error: any) {
    const failedAt = new Date().toISOString();
    sqlite.prepare("UPDATE conversation_turns SET status = 'failed', completed_at = ? WHERE id = ?").run(failedAt, turnId);
    sqlite.prepare("UPDATE mission_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?")
      .run(failedAt, error?.message || String(error), runId);
    sqlite.prepare('UPDATE missions SET active_run_id = NULL WHERE id = ? AND active_run_id = ?').run(missionId, runId);
    throw error;
  }
}

eventBus.on('*', (event) => {
  if (event.type !== 'mission_completed' && event.type !== 'mission_failed') return;
  if (!event.runId) return;
  const completedAt = event.timestamp;
  sqlite.transaction(() => {
    const run = sqlite.prepare("SELECT turn_id FROM mission_runs WHERE id = ? AND mission_id = ? AND status IN ('starting', 'running', 'stopping')")
      .get(event.runId, event.missionId) as { turn_id: string | null } | undefined;
    if (!run) return;
    sqlite.prepare("UPDATE mission_runs SET status = ?, completed_at = ? WHERE id = ?")
      .run(event.type === 'mission_completed' ? 'completed' : 'failed', completedAt, event.runId);
    if (run.turn_id) sqlite.prepare('UPDATE conversation_turns SET status = ?, completed_at = ? WHERE id = ?')
      .run(event.type === 'mission_completed' ? 'completed' : 'failed', completedAt, run.turn_id);
    sqlite.prepare('UPDATE missions SET active_run_id = NULL WHERE id = ? AND active_run_id = ?').run(event.missionId, event.runId);
  })();
  setImmediate(() => void drainMissionCommands(event.missionId));
});

async function cleanupMissionResources(missionId: string): Promise<void> {
  await runtimeHost.stopMission(missionId).catch(() => undefined);
  const missionTasks = await workspaceManager.listTasks(missionId);
  for (const task of missionTasks) {
    if (task.worktreeId) await workspaceManager.removeWorktreeForTask(task.id);
  }
  await workspaceManager.deleteRoleExecutionPolicies('mission', missionId);
  runtimeHost.clearMissionRoutingPreference(missionId, false);
}

function configureMissionRouting(missionId: string, body: Record<string, any>): void {
  const modelCatalogId = typeof body.modelCatalogId === 'string' && body.modelCatalogId ? body.modelCatalogId : undefined;
  const accountProfileId = typeof body.accountProfileId === 'string' && body.accountProfileId ? body.accountProfileId : undefined;
  const targetRole = typeof body.targetRole === 'string' ? body.targetRole.toLowerCase() : undefined;
  const routeRole = typeof body.routeRole === 'string' ? body.routeRole.toLowerCase() : targetRole;
  const routeScope = body.routeScope === 'mission'
    ? 'mission'
    : body.routeScope === 'role'
      ? routeRole
      : modelCatalogId
        ? 'mission'
        : routeRole;
  const validSelectionModes = new Set(['auto', 'prefer', 'fixed']);
  const selectionMode = validSelectionModes.has(String(body.routeSelectionMode))
    ? String(body.routeSelectionMode)
    : modelCatalogId ? 'fixed' : 'prefer';
  const fallbackCatalogIds = normalizeFallbackCatalogIds(body.fallbackCatalogIds, modelCatalogId);

  if (!modelCatalogId && !accountProfileId && !body.reasoningLevel && fallbackCatalogIds.length === 0) return;
  runtimeHost.setMissionRoutingPreference(missionId, {
    modelCatalogId,
    accountProfileId,
    reasoningLevel: typeof body.reasoningLevel === 'string' ? body.reasoningLevel.toLowerCase() as any : undefined,
    fallbackCatalogIds,
    selectionMode: selectionMode as any,
    scopeRole: routeScope as any,
    targetRole: targetRole as any,
  });
}

// 4. REST API Routes
app.get('/health', async (_req: Request, res: Response) => {
  const accounts = await runtimeHost.discoverAccounts();
  res.json({
    status: 'ok',
    version: gatewayVersion(),
    localOnly: true,
    connectedAccounts: accounts.filter((profile) => profile.authStatus === 'connected').length,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/workspaces', async (req: Request, res: Response) => {
  try {
    const { name, path: workspacePath, gitInitialized } = req.body;
    if (!name || !workspacePath) return void res.status(400).json({ error: 'name and path are required' });
    const resolvedPath = path.resolve(String(workspacePath));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      return void res.status(400).json({ error: 'Workspace path must be an existing local directory.' });
    }
    const workspace = await workspaceManager.createWorkspace({ name, path: resolvedPath, gitInitialized });
    res.status(201).json(workspace);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to create workspace' });
  }
});

app.get('/api/workspaces', async (_req: Request, res: Response) => {
  try { res.json(await workspaceManager.listWorkspaces()); }
  catch (error: any) { res.status(500).json({ error: error?.message || 'Failed to list workspaces' }); }
});

app.get('/api/workspaces/:id', async (req: Request, res: Response) => {
  try {
    const workspace = await workspaceManager.getWorkspace(req.params.id);
    if (!workspace) return void res.status(404).json({ error: 'Workspace not found' });
    res.json(workspace);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to get workspace' });
  }
});

app.delete('/api/workspaces/:id', async (req: Request, res: Response) => {
  try {
    const workspaceId = routeParam(req.params.id);
    const workspace = await workspaceManager.getWorkspace(workspaceId);
    if (!workspace) return void res.status(404).json({ error: 'Workspace not found' });

    const workspaceMissions = await workspaceManager.listMissions(workspaceId);
    const activeMissions = workspaceMissions.filter((mission) => ACTIVE_MISSION_STATUSES.has(String(mission.status)));
    if (activeMissions.length > 0) {
      return void res.status(409).json({
        error: `Stop or finish ${activeMissions.length === 1 ? 'the active conversation' : 'all active conversations'} before deleting this workspace.`,
      });
    }

    // Remove runtime-owned resources before the workspace cascade removes the
    // mission rows that are needed to locate them.
    for (const mission of workspaceMissions) await cleanupMissionResources(mission.id);
    await workspaceManager.deleteRoleExecutionPolicies('workspace', workspaceId);
    db.delete((schema as any).workspaces).where(eq((schema as any).workspaces.id, workspaceId)).run();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to remove workspace' });
  }
});

app.post('/api/missions', async (req: Request, res: Response) => {
  try {
    const { workspaceId, title, description, teamTemplateId, executionMode } = req.body;
    if (!workspaceId || !title) return void res.status(400).json({ error: 'workspaceId and title are required' });
    const mission = await workspaceManager.createMission({ workspaceId, title, description, teamTemplateId, executionMode });
    res.status(201).json(mission);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to create mission' });
  }
});

app.get('/api/missions', async (req: Request, res: Response) => {
  try { res.json(await workspaceManager.listMissions(req.query.workspaceId as string | undefined)); }
  catch (error: any) { res.status(500).json({ error: error?.message || 'Failed to list missions' }); }
});

app.get('/api/missions/:id', async (req: Request, res: Response) => {
  try {
    const missionId = routeParam(req.params.id);
    const state = await orchestrator.getMissionState(missionId);
    if (!state.mission) return void res.status(404).json({ error: 'Mission not found' });
    res.json(state);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to get mission state' });
  }
});

app.delete('/api/missions/:id', async (req: Request, res: Response) => {
  try {
    const missionId = routeParam(req.params.id);
    const mission = await workspaceManager.getMission(missionId);
    if (!mission) return void res.status(404).json({ error: 'Conversation not found' });

    const deletableStatuses = new Set(['completed', 'failed', 'cancelled']);
    if (!deletableStatuses.has(String(mission.status))) {
      return void res.status(409).json({ error: 'Stop or finish this conversation before deleting it.' });
    }

    await cleanupMissionResources(missionId);
    db.delete((schema as any).missions).where(eq((schema as any).missions.id, missionId)).run();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to delete conversation' });
  }
});

app.post('/api/missions/:id/messages', async (req: Request, res: Response) => {
  try {
    const missionId = routeParam(req.params.id);
    const mission = await workspaceManager.getMission(missionId);
    if (!mission) return void res.status(404).json({ error: 'Mission not found' });
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    const delivery = String(req.body?.delivery || '');
    if (!content || !['steer', 'queue', 'stop_and_replan'].includes(delivery)) {
      return void res.status(400).json({ error: "content and delivery ('steer', 'queue', or 'stop_and_replan') are required" });
    }
    const idempotencyKey = typeof req.header('Idempotency-Key') === 'string' ? req.header('Idempotency-Key')!.trim() : '';
    const active = ACTIVE_MISSION_STATUSES.has(String(mission.status));
    const turnId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const now = new Date().toISOString();
    const requestedOptions = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
    const turnOptions = {
      ...requestedOptions,
      modelCatalogId: requestedOptions.modelCatalogId || requestedOptions.model || undefined,
    };
    delete turnOptions.model;
    const requestHash = turnRequestHash(missionId, content, delivery, turnOptions);
    if (idempotencyKey) {
      const existing = sqlite.prepare('SELECT * FROM conversation_turns WHERE mission_id = ? AND idempotency_key = ?')
        .get(missionId, idempotencyKey) as any;
      if (existing) {
        if (existing.request_hash && existing.request_hash !== requestHash) {
          return void res.status(409).json({ code: 'IDEMPOTENCY_KEY_REUSED', error: 'Idempotency key was already used for a different message.' });
        }
        return void res.status(200).json(turnDto(existing));
      }
    }
    const priorityPending = active && delivery === 'steer';
    const turnStatus = priorityPending ? 'pending_priority' : 'queued';
    sqlite.transaction(() => {
      sqlite.prepare(`INSERT INTO conversation_turns
        (id, mission_id, content, delivery, options, status, idempotency_key, request_hash, command_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(turnId, missionId, content, delivery, JSON.stringify(turnOptions), turnStatus, idempotencyKey || null, requestHash, commandId, now);
      sqlite.prepare(`INSERT INTO mission_commands
        (id, mission_id, turn_id, type, status, priority, request_hash, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(commandId, missionId, turnId, delivery, priorityPending ? 100 : delivery === 'stop_and_replan' ? 200 : 0, requestHash, now);
    })();
    emitTurnEvent({ id: crypto.randomUUID(), type: 'user_message', missionId, turnId, clientMessageId: idempotencyKey || undefined,
      content, timestamp: now });
    emitTurnEvent({ id: crypto.randomUUID(), type: 'turn_queued', missionId, turnId, content,
      delivery: delivery as any, priorityPending, clientMessageId: idempotencyKey || undefined, timestamp: now });
    if (priorityPending) {
      const activeRun = sqlite.prepare("SELECT id, turn_id FROM mission_runs WHERE mission_id = ? AND status IN ('starting', 'running') ORDER BY started_at DESC LIMIT 1")
        .get(missionId) as { id: string; turn_id: string } | undefined;
      if (!activeRun) throw new Error('Active run metadata is unavailable for steering.');
      sqlite.prepare("UPDATE mission_commands SET status = 'processing', claimed_at = ?, attempt_count = attempt_count + 1 WHERE id = ? AND status = 'pending'")
        .run(now, commandId);
      try {
        const applied = await orchestrator.steerActiveTurn({ missionId, targetTurnId: activeRun.turn_id, content });
        const appliedAt = new Date().toISOString();
        sqlite.transaction(() => {
          sqlite.prepare("UPDATE mission_commands SET status = 'completed', processed_at = ? WHERE id = ?").run(appliedAt, commandId);
          sqlite.prepare("UPDATE conversation_turns SET status = 'completed', started_at = ?, completed_at = ? WHERE id = ?").run(appliedAt, appliedAt, turnId);
        })();
        emitTurnEvent({ id: crypto.randomUUID(), type: 'turn_steered', missionId, turnId, runId: activeRun.id,
          targetTurnId: activeRun.turn_id, content, disposition: applied.boundary === 'future_tasks' ? 'applied_future_tasks' : 'applied_synthesis', timestamp: appliedAt });
      } catch (error: any) {
        sqlite.transaction(() => {
          sqlite.prepare("UPDATE mission_commands SET status = 'failed', processed_at = ?, error = ? WHERE id = ?").run(new Date().toISOString(), error?.message || String(error), commandId);
          sqlite.prepare("UPDATE conversation_turns SET status = 'failed', completed_at = ? WHERE id = ?").run(new Date().toISOString(), turnId);
        })();
        throw error;
      }
    }
    if (delivery === 'stop_and_replan') {
      const activeTurns = sqlite.prepare("SELECT id FROM conversation_turns WHERE mission_id = ? AND status IN ('starting', 'running')")
        .all(missionId) as Array<{ id: string }>;
      try {
        await runtimeHost.stopMission(missionId);
      } catch (error: any) {
        const failedAt = new Date().toISOString();
        sqlite.transaction(() => {
          sqlite.prepare("UPDATE mission_commands SET status = 'failed', processed_at = ?, error = ? WHERE id = ?").run(failedAt, error?.message || String(error), commandId);
          sqlite.prepare("UPDATE conversation_turns SET status = 'failed', completed_at = ? WHERE id = ?").run(failedAt, turnId);
        })();
        throw error;
      }
      await workspaceManager.cancelMissionTasks(missionId);
      await workspaceManager.updateMission(missionId, { status: 'cancelled' });
      const cancelledAt = new Date().toISOString();
      sqlite.transaction(() => {
        sqlite.prepare("UPDATE mission_runs SET status = 'cancelled', completed_at = ? WHERE mission_id = ? AND status IN ('starting', 'running', 'stopping')")
          .run(cancelledAt, missionId);
        sqlite.prepare("UPDATE conversation_turns SET status = 'cancelled', completed_at = ? WHERE mission_id = ? AND status IN ('starting', 'running')")
          .run(cancelledAt, missionId);
        sqlite.prepare('UPDATE missions SET active_run_id = NULL WHERE id = ?').run(missionId);
      })();
      for (const activeTurn of activeTurns) emitTurnEvent({ id: crypto.randomUUID(), type: 'turn_cancelled',
        missionId, turnId: activeTurn.id, reason: 'Stopped for replanning', timestamp: cancelledAt });
      void drainMissionCommands(missionId);
    } else if (!active) {
      void drainMissionCommands(missionId);
    }
    res.status(202).json(turnDto(sqlite.prepare('SELECT * FROM conversation_turns WHERE id = ?').get(turnId), { id: commandId }));
  } catch (error: any) {
    if (String(error?.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
      const missionId = routeParam(req.params.id);
      const key = String(req.header('Idempotency-Key') || '').trim();
      const existing = key ? sqlite.prepare('SELECT * FROM conversation_turns WHERE mission_id = ? AND idempotency_key = ?').get(missionId, key) as any : null;
      if (existing) {
        const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
        const delivery = String(req.body?.delivery || '');
        const requested = req.body?.options && typeof req.body.options === 'object' ? { ...req.body.options } : {};
        requested.modelCatalogId = requested.modelCatalogId || requested.model || undefined;
        delete requested.model;
        if (existing.request_hash && existing.request_hash !== turnRequestHash(missionId, content, delivery, requested)) {
          return void res.status(409).json({ code: 'IDEMPOTENCY_KEY_REUSED', error: 'Idempotency key was already used for a different message.' });
        }
        return void res.status(200).json(turnDto(existing));
      }
      return void res.status(409).json({ error: 'Idempotency key conflict' });
    }
    res.status(500).json({ error: error?.message || 'Failed to queue message' });
  }
});

app.post('/api/missions/:id/start', async (req: Request, res: Response) => {
  try {
    const missionId = routeParam(req.params.id);
    const existingMission = await workspaceManager.getMission(missionId);
    const userRequest = req.body?.request || existingMission?.title || 'Execute Mission';
    configureMissionRouting(missionId, req.body || {});
    res.json(await startMissionWithDurability(missionId, userRequest, {
      modelCatalogId: req.body?.modelCatalogId,
      reasoningLevel: req.body?.reasoningLevel,
      targetRole: req.body?.targetRole,
      command: req.body?.command,
    }));
  } catch (error: any) {
    const message = error?.message || 'Failed to start mission';
    res.status(/^Invalid automation override:/.test(message) ? 400 : 500).json({ error: message });
  }
});

app.post('/api/missions/start', async (req: Request, res: Response) => {
  try {
    const {
      request,
      title,
      workspaceId,
      modelCatalogId,
      accountProfileId,
      reasoningLevel,
      fallbackCatalogIds,
      routeSelectionMode,
      routeRole,
      teamTemplate,
      trustMode,
      executionMode,
      targetRole,
      command,
      automationSettings,
      automationOverrides,
      trustProfile,
      executionStrategy,
    } = req.body;
    const automationPolicy = normalizeAutomationPolicy({ trustMode, executionMode, automationSettings, automationOverrides, trustProfile, executionStrategy });
    const promptText = request || title;
    if (!promptText) return void res.status(400).json({ error: 'title or request is required' });

    let targetWorkspaceId = workspaceId;
    if (!targetWorkspaceId) {
      const existingWorkspaces = await workspaceManager.listWorkspaces();
      targetWorkspaceId = existingWorkspaces[0]?.id;
      if (!targetWorkspaceId) return void res.status(400).json({ error: 'Create or select a workspace before starting a mission.' });
    }

    const missionId = crypto.randomUUID();
    await workspaceManager.createMission({
      id: missionId,
      workspaceId: targetWorkspaceId,
      title: promptText,
      description: promptText,
      status: 'running',
      executionMode: executionMode || 'balanced',
      automationPolicy,
      teamTemplateId: teamTemplate || 'default-core-dev-team',
    });

    configureMissionRouting(missionId, {
      modelCatalogId,
      accountProfileId,
      reasoningLevel,
      fallbackCatalogIds,
      routeSelectionMode,
      routeRole,
      routeScope: req.body?.routeScope,
      targetRole,
    });

    const result = await startMissionWithDurability(missionId, promptText, {
      modelCatalogId,
      reasoningLevel,
      targetRole,
      command,
      automationPolicy,
    });
    res.status(201).json({
      missionId: result.missionId,
      planId: result.planId,
      tasks: result.tasks,
      status: (await workspaceManager.getMission(result.missionId))?.status || 'running',
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to start mission';
    res.status(/^Invalid automation override:/.test(message) ? 400 : 500).json({ error: message });
  }
});

app.get('/api/tasks/:id/diff', async (req: Request, res: Response) => {
  try {
    const taskId = routeParam(req.params.id);
    res.json({ diff: await mergeCoordinator.generateReviewPack(taskId) });
  } catch (error: any) { res.status(500).json({ error: error?.message || 'Failed to generate diff' }); }
});

app.get('/api/tasks/:id/worktree', async (req: Request, res: Response) => {
  try {
    const task = await workspaceManager.getTask(routeParam(req.params.id));
    if (!task) return void res.status(404).json({ error: 'Task not found' });
    if (!task.worktreeId) return void res.status(409).json({ error: 'This task does not have an isolated worktree yet.' });
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    res.json(await workspaceManager.getWorktreeManager().inspectEntry(task.worktreeId, requestedPath));
  } catch (error: any) {
    const message = error?.message || 'Failed to inspect worktree';
    const status = /relative|escapes|symbolic/i.test(message) ? 400 : /ENOENT/.test(String(error?.code || message)) ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

app.post('/api/tasks/:id/merge', async (req: Request, res: Response) => {
  try {
    const taskId = routeParam(req.params.id);
    const task = await workspaceManager.getTask(taskId);
    if (!task) return void res.status(404).json({ error: 'Task not found' });
    const mission = await workspaceManager.getMission(task.missionId);
    const policy = mission?.automationPolicy as any;
    const workspaceApply = policy?.overrides?.workspaceApply || (policy?.profile === 'auto' ? 'auto' : policy?.profile === 'review' ? 'review' : 'ask');
    if (workspaceApply !== 'auto') {
      return void res.status(409).json({ code: 'APPROVAL_REQUIRED', error: 'Workspace apply must continue through the mission approval flow.' });
    }
    const result = await mergeCoordinator.applyWorktree(taskId);
    if (!result.success) return void res.status(400).json({ error: result.output });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to merge worktree' });
  }
});

app.get('/api/runtimes', async (_req, res) => {
  try { res.json(await runtimeHost.discoverRuntimeStatuses()); }
  catch (error: any) { res.status(500).json({ error: error?.message || 'Failed to discover runtimes' }); }
});

app.post('/api/runtimes/discover', async (_req, res) => {
  try { res.json(await runtimeHost.discoverRuntimeStatuses()); }
  catch (error: any) { res.status(500).json({ error: error?.message || 'Failed to probe runtimes' }); }
});

app.get('/api/accounts', async (_req, res) => {
  try { res.json(await runtimeHost.discoverAccounts()); }
  catch (error: any) { res.status(500).json({ error: error?.message || 'Failed to fetch account profiles' }); }
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { runtimeType, provider, profileName, allowedRoles, schedulerAuto, authMethod, profileMode } = req.body;
    if (!runtimeType || !profileName) return void res.status(400).json({ error: 'runtimeType and profileName are required' });
    const profile = await runtimeHost.createAccountProfile({ runtimeType, provider, profileName, allowedRoles, schedulerAuto, authMethod, profileMode });
    res.status(201).json(profile);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to create account profile' });
  }
});

app.patch('/api/accounts/:id', async (req, res) => {
  try { res.json(await runtimeHost.updateAccount(req.params.id, req.body || {})); }
  catch (error: any) { res.status(404).json({ error: error?.message || 'Failed to update account profile' }); }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const deleted = await runtimeHost.deleteAccount(req.params.id);
    if (!deleted) return void res.status(404).json({ error: 'Account profile not found' });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to delete account profile' });
  }
});

app.post('/api/accounts/:id/auth/begin', async (req, res) => {
  try {
    const { method, ...options } = req.body || {};
    if (!method) return void res.status(400).json({ error: 'method is required' });
    const result = await runtimeHost.beginAuthentication(req.params.id, method, options);
    res.status(result.status === 'failed' ? 400 : 202).json(result);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to start authentication' });
  }
});

app.get('/api/accounts/:id/auth/:authId', async (req, res) => {
  try { res.json(await runtimeHost.pollAuthentication(req.params.id, req.params.authId)); }
  catch (error: any) { res.status(404).json({ error: error?.message || 'Failed to poll authentication' }); }
});

app.post('/api/accounts/:id/verify', async (req, res) => {
  try { res.json(await runtimeHost.verifyAccount(req.params.id)); }
  catch (error: any) { res.status(400).json({ error: error?.message || 'Account verification failed' }); }
});

app.post('/api/accounts/:id/logout', async (req, res) => {
  try { res.json(await runtimeHost.logoutAccount(req.params.id)); }
  catch (error: any) { res.status(400).json({ error: error?.message || 'Runtime logout failed' }); }
});

app.post('/api/accounts/:id/models/refresh', async (req, res) => {
  try {
    const models = await runtimeHost.refreshModels(req.params.id);
    res.json({ models, refreshedAt: new Date().toISOString() });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Model discovery failed' });
  }
});

app.get('/api/models', async (req, res) => {
  try {
    const models = req.query.refresh === 'true' ? await runtimeHost.discoverModels() : runtimeHost.getCachedModels();
    res.json(models);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to load model catalog' });
  }
});

const validRoles = new Set(['orchestrator', 'builder', 'reviewer', 'researcher', 'qa']);
const validReasoning = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const validSelectionModes = new Set(['auto', 'prefer', 'fixed']);
const validPolicyScopes = new Set(['team_template', 'workspace', 'mission']);

function normalizeTeamRoles(roles: Array<Record<string, unknown>>): any[] {
  const seen = new Set<string>();
  return (Array.isArray(roles) ? roles : []).filter((role) => {
    const id = String(role?.role || '').toLowerCase();
    if (!validRoles.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((role) => {
    const modelCatalogId = String(role.modelCatalogId || role.modelProfileId || '').trim();
    const fallbackCatalogIds = normalizeFallbackCatalogIds(role.fallbackCatalogIds, modelCatalogId);
    const preferredReasoning = validReasoning.has(String(role.preferredReasoning)) ? String(role.preferredReasoning) : undefined;
    const routeSelectionMode = validSelectionModes.has(String(role.routeSelectionMode))
      ? String(role.routeSelectionMode)
      : modelCatalogId ? 'prefer' : 'auto';
    return {
      role: String(role.role).toLowerCase(),
      modelProfileId: modelCatalogId,
      modelCatalogId,
      accountProfileId: String(role.accountProfileId || '').trim(),
      fallbackCatalogIds,
      preferredReasoning,
      routeSelectionMode,
      defaultCapabilities: Array.isArray(role.defaultCapabilities) ? role.defaultCapabilities.map(String) : [],
      accessLevel: String(role.accessLevel || 'read'),
    };
  });
}

function readTeamTemplate(templateId: string): any | null {
  const template = db.select().from((schema as any).teamTemplates)
    .where(eq((schema as any).teamTemplates.id, templateId)).get() as any;
  if (!template) return null;
  const roles = db.select().from((schema as any).teamRoles)
    .where(eq((schema as any).teamRoles.templateId, templateId)).all() as any[];
  const policies = db.select().from((schema as any).executionPolicies).where(and(
    eq((schema as any).executionPolicies.scopeType, 'team_template'),
    eq((schema as any).executionPolicies.scopeId, templateId),
  )).all() as any[];
  const byRole = new Map(policies.map((policy) => [policy.role, policy]));
  return {
    ...template,
    roles: roles.map((role) => {
      const policy = byRole.get(role.role) as any;
      return {
        ...role,
        modelCatalogId: policy?.modelCatalogId || role.modelProfileId || '',
        accountProfileId: policy?.accountProfileId || role.accountProfileId || '',
        fallbackCatalogIds: policy?.fallbackCatalogIds || [],
        preferredReasoning: policy?.reasoningLevel || undefined,
        routeSelectionMode: policy?.selectionMode || (role.modelProfileId ? 'prefer' : 'auto'),
      };
    }),
  };
}

function replaceTemplateRoles(templateId: string, inputRoles: any[]): void {
  const roles = normalizeTeamRoles(inputRoles);
  db.delete((schema as any).teamRoles).where(eq((schema as any).teamRoles.templateId, templateId)).run();
  db.delete((schema as any).executionPolicies).where(and(
    eq((schema as any).executionPolicies.scopeType, 'team_template'),
    eq((schema as any).executionPolicies.scopeId, templateId),
  )).run();
  for (const role of roles) {
    db.insert((schema as any).teamRoles).values({
      id: crypto.randomUUID(),
      templateId,
      role: role.role,
      modelProfileId: role.modelCatalogId,
      accountProfileId: role.accountProfileId,
      defaultCapabilities: role.defaultCapabilities,
      accessLevel: role.accessLevel,
    }).run();
    db.insert((schema as any).executionPolicies).values({
      id: crypto.randomUUID(),
      scopeType: 'team_template',
      scopeId: templateId,
      role: role.role,
      modelCatalogId: role.modelCatalogId || null,
      accountProfileId: role.accountProfileId || null,
      reasoningLevel: role.preferredReasoning || null,
      fallbackCatalogIds: role.fallbackCatalogIds,
      selectionMode: role.routeSelectionMode,
      source: 'team_template',
      updatedAt: new Date().toISOString(),
    }).run();
  }
}

app.get('/api/team-templates', (_req, res) => {
  try {
    const templates = db.select().from((schema as any).teamTemplates).all() as any[];
    res.json(templates.map((template) => readTeamTemplate(template.id)));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch team templates' });
  }
});

app.post('/api/team-templates', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim();
    const roles = normalizeTeamRoles(req.body?.roles || []);
    if (!name) return void res.status(400).json({ error: 'Template name is required.' });
    if (!roles.length) return void res.status(400).json({ error: 'Select at least one valid agent role.' });
    const duplicate = (db.select().from((schema as any).teamTemplates).all() as any[])
      .some((template) => String(template.name).trim().toLowerCase() === name.toLowerCase());
    if (duplicate) return void res.status(409).json({ error: `A team template named '${name}' already exists.` });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sqlite.transaction(() => {
      db.insert((schema as any).teamTemplates).values({ id, name, description, isDefault: false, createdAt: now }).run();
      replaceTemplateRoles(id, roles);
    })();
    res.status(201).json(readTeamTemplate(id));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to create team template' });
  }
});

app.patch('/api/team-templates/:id', (req, res) => {
  try {
    const template = readTeamTemplate(req.params.id);
    if (!template) return void res.status(404).json({ error: 'Team template not found.' });
    const name = String(req.body?.name ?? template.name).trim();
    const description = String(req.body?.description ?? template.description).trim();
    const roles = req.body?.roles === undefined ? template.roles : normalizeTeamRoles(req.body.roles);
    if (!name) return void res.status(400).json({ error: 'Template name is required.' });
    if (!roles.length) return void res.status(400).json({ error: 'Select at least one valid agent role.' });
    const duplicate = (db.select().from((schema as any).teamTemplates).all() as any[])
      .some((item) => item.id !== req.params.id && String(item.name).trim().toLowerCase() === name.toLowerCase());
    if (duplicate) return void res.status(409).json({ error: `A team template named '${name}' already exists.` });

    sqlite.transaction(() => {
      db.update((schema as any).teamTemplates).set({ name, description })
        .where(eq((schema as any).teamTemplates.id, req.params.id)).run();
      replaceTemplateRoles(req.params.id, roles);
    })();
    res.json(readTeamTemplate(req.params.id));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to update team template' });
  }
});

app.post('/api/team-templates/:id/default', (req, res) => {
  try {
    if (!readTeamTemplate(req.params.id)) return void res.status(404).json({ error: 'Team template not found.' });
    sqlite.transaction(() => {
      for (const template of db.select().from((schema as any).teamTemplates).all() as any[]) {
        db.update((schema as any).teamTemplates)
          .set({ isDefault: template.id === req.params.id })
          .where(eq((schema as any).teamTemplates.id, template.id)).run();
      }
    })();
    res.json(readTeamTemplate(req.params.id));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to set the default team template' });
  }
});

app.delete('/api/team-templates/:id', (req, res) => {
  try {
    const template = readTeamTemplate(req.params.id);
    if (!template) return void res.status(404).json({ error: 'Team template not found.' });
    if (template.isDefault) return void res.status(409).json({ error: 'The default template cannot be deleted. Set another template as default first.' });
    sqlite.transaction(() => {
      db.delete((schema as any).executionPolicies).where(and(
        eq((schema as any).executionPolicies.scopeType, 'team_template'),
        eq((schema as any).executionPolicies.scopeId, req.params.id),
      )).run();
      db.delete((schema as any).teamRoles).where(eq((schema as any).teamRoles.templateId, req.params.id)).run();
      db.delete((schema as any).teamTemplates).where(eq((schema as any).teamTemplates.id, req.params.id)).run();
    })();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to delete team template' });
  }
});

app.get('/api/execution-policies/:scopeType/:scopeId', async (req, res) => {
  try {
    const scopeType = String(req.params.scopeType);
    if (!validPolicyScopes.has(scopeType)) return void res.status(400).json({ error: 'Invalid execution policy scope.' });
    res.json(await workspaceManager.listRoleExecutionPolicies(scopeType as any, req.params.scopeId));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to load execution policies' });
  }
});

app.put('/api/execution-policies/:scopeType/:scopeId/:role', async (req, res) => {
  try {
    const scopeType = String(req.params.scopeType);
    const role = String(req.params.role).toLowerCase();
    if (!validPolicyScopes.has(scopeType) || !validRoles.has(role)) {
      return void res.status(400).json({ error: 'Invalid execution policy scope or role.' });
    }
    const modelCatalogId = String(req.body?.modelCatalogId || '').trim() || undefined;
    const fallbackCatalogIds = normalizeFallbackCatalogIds(req.body?.fallbackCatalogIds, modelCatalogId);
    const selectionMode = validSelectionModes.has(String(req.body?.selectionMode))
      ? String(req.body.selectionMode)
      : modelCatalogId ? 'prefer' : 'auto';
    const reasoning = validReasoning.has(String(req.body?.reasoningLevel)) ? String(req.body.reasoningLevel) : undefined;
    await workspaceManager.upsertRoleExecutionPolicy(scopeType as any, req.params.scopeId, {
      role: role as any,
      selectionMode: selectionMode as any,
      modelCatalogId,
      accountProfileId: String(req.body?.accountProfileId || '').trim() || undefined,
      reasoningLevel: reasoning as any,
      fallbackCatalogIds,
    });
    res.json({ success: true, policies: await workspaceManager.listRoleExecutionPolicies(scopeType as any, req.params.scopeId) });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to save execution policy' });
  }
});

app.delete('/api/execution-policies/:scopeType/:scopeId', async (req, res) => {
  try {
    const scopeType = String(req.params.scopeType);
    if (!validPolicyScopes.has(scopeType)) return void res.status(400).json({ error: 'Invalid execution policy scope.' });
    await workspaceManager.deleteRoleExecutionPolicies(scopeType as any, req.params.scopeId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to clear execution policies' });
  }
});

app.get('/api/missions/:id/events', async (req, res) => {
  try {
    const afterSequence = Math.max(0, Number(req.query.afterSequence) || 0);
    const rows = sqlite.prepare(`SELECT payload, sequence, schema_version FROM mission_events WHERE mission_id = ? AND sequence > ?
      ORDER BY sequence`).all(req.params.id, afterSequence) as Array<{ payload: string; sequence: number; schema_version: number }>;
    res.json(rows.map((row) => ({ ...JSON.parse(row.payload), sequence: row.sequence, schemaVersion: row.schema_version || 1 })));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch mission events' });
  }
});

app.get('/api/missions/:id/artifacts', async (req, res) => {
  try {
    const rows = db.select().from((schema as any).artifacts)
      .where(eq((schema as any).artifacts.missionId, req.params.id)).all();
    res.json(rows);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch mission artifacts' });
  }
});

app.get('/api/missions/:id/usage', (req, res) => {
  try {
    const rows = db.select().from((schema as any).usageSnapshots)
      .where(eq((schema as any).usageSnapshots.missionId, req.params.id)).all() as any[];
    const inputTokens = rows.reduce((sum, row) => sum + Number(row.inputTokens || 0), 0);
    const outputTokens = rows.reduce((sum, row) => sum + Number(row.outputTokens || 0), 0);
    const costValues = rows.map((row) => row.cost).filter((value) => value !== null && value !== undefined);
    const currencies = [...new Set(rows.map((row) => row.currency).filter(Boolean))];
    res.json({
      available: rows.length > 0,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      totalCost: costValues.length > 0 ? costValues.reduce((sum, value) => sum + Number(value || 0), 0) : null,
      currency: currencies.length === 1 ? currencies[0] : null,
      snapshotCount: rows.length,
      lastRecordedAt: rows.map((row) => row.recordedAt).filter(Boolean).sort().at(-1) || null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch usage snapshots' });
  }
});

app.post('/api/missions/:id/cancel', async (req, res) => {
  try {
    const mission = await workspaceManager.getMission(req.params.id);
    if (!mission) return void res.status(404).json({ error: 'Mission not found' });
    await runtimeHost.stopMission(req.params.id);
    await workspaceManager.cancelMissionTasks(req.params.id);
    const cancelledAt = new Date().toISOString();
    const cancelledTurns = sqlite.transaction(() => {
      const turns = sqlite.prepare("SELECT id FROM conversation_turns WHERE mission_id = ? AND status IN ('queued', 'pending_priority', 'starting', 'running')")
        .all(req.params.id) as Array<{ id: string }>;
      sqlite.prepare("UPDATE mission_commands SET status = 'cancelled', processed_at = ? WHERE mission_id = ? AND status IN ('pending', 'processing')")
        .run(cancelledAt, req.params.id);
      sqlite.prepare("UPDATE mission_runs SET status = 'cancelled', completed_at = ? WHERE mission_id = ? AND status IN ('starting', 'running', 'stopping')")
        .run(cancelledAt, req.params.id);
      sqlite.prepare("UPDATE conversation_turns SET status = 'cancelled', completed_at = ? WHERE mission_id = ? AND status IN ('queued', 'pending_priority', 'starting', 'running')")
        .run(cancelledAt, req.params.id);
      sqlite.prepare('UPDATE missions SET active_run_id = NULL WHERE id = ?').run(req.params.id);
      return turns;
    })();
    const updated = await workspaceManager.updateMission(req.params.id, { status: 'cancelled' });
    for (const turn of cancelledTurns) emitTurnEvent({ id: crypto.randomUUID(), type: 'turn_cancelled', missionId: req.params.id,
      turnId: turn.id, reason: 'Mission cancelled by the user', timestamp: cancelledAt });
    runtimeHost.clearMissionRoutingPreference(req.params.id, false);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to cancel mission' });
  }
});

app.post('/api/missions/:id/retry', async (req, res) => {
  try {
    const mission = await workspaceManager.getMission(req.params.id);
    if (!mission) return void res.status(404).json({ error: 'Mission not found' });
    const tasks = await workspaceManager.listTasks(req.params.id);
    const retryable = tasks.filter((task) => ['rejected', 'blocked', 'revision_requested'].includes(task.status));
    if (retryable.length === 0) return void res.status(400).json({ error: 'The mission has no failed or blocked task to retry.' });
    await workspaceManager.updateMission(req.params.id, { status: 'running' });
    for (const task of retryable) await orchestrator.retryTask(task.id);
    res.json({ success: true, retriedTasks: retryable.map((task) => task.id) });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to retry mission' });
  }
});

app.post('/api/tasks/:id/retry', async (req, res) => {
  try { res.json(await orchestrator.retryTask(req.params.id)); }
  catch (error: any) { res.status(400).json({ error: error?.message || 'Failed to retry task' }); }
});

app.post('/api/missions/:id/candidates/:taskId/select', async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : 'Selected by the user from the Candidate board.';
    await orchestrator.selectCandidate(req.params.id, req.params.taskId, reason);
    const pendingApprovals = (db.select().from((schema as any).approvals)
      .where(eq((schema as any).approvals.missionId, req.params.id)).all() as any[])
      .filter((approval) => approval.type === 'candidate_selection' && approval.status === 'pending');
    const now = new Date().toISOString();
    for (const approval of pendingApprovals) {
      db.update((schema as any).approvals)
        .set({ status: 'approved', decidedBy: 'user', decidedAt: now })
        .where(eq((schema as any).approvals.id, approval.id)).run();
      eventBus.emit({
        id: crypto.randomUUID(),
        type: 'approval_responded',
        missionId: req.params.id,
        approvalId: approval.id,
        approved: true,
        decidedBy: 'user',
        timestamp: now,
      });
    }
    res.json({ success: true, selectedCandidateId: req.params.taskId });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to select candidate' });
  }
});

app.get('/api/missions/:id/approvals', async (req, res) => {
  try {
    res.json(db.select().from((schema as any).approvals)
      .where(eq((schema as any).approvals.missionId, req.params.id)).all());
  } catch {
    res.status(500).json({ error: 'Failed to fetch approvals' });
  }
});

app.post('/api/approvals/:id/decide', async (req, res) => {
  try {
    const decision = String(req.body?.decision || '').toLowerCase();
    if (!['approved', 'rejected'].includes(decision)) return void res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
    const approval = (db.select().from((schema as any).approvals)
      .where(eq((schema as any).approvals.id, req.params.id)).all() as any[])[0];
    if (!approval) return void res.status(404).json({ error: 'Approval not found' });
    if (approval.status !== 'pending') return void res.status(409).json({ error: `Approval has already been ${approval.status}.` });
    const approved = decision === 'approved';
    if (String(approval.id).includes(':')) {
      await runtimeHost.respondToRuntimeApproval(approval.id, approved ? 'approved' : 'rejected');
    } else {
      await orchestrator.handleApprovalDecision(approval.missionId, approval.type, approved, {
        selectedCandidateId: typeof req.body?.selectedCandidateId === 'string' ? req.body.selectedCandidateId : undefined,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
      });
    }

    const now = new Date().toISOString();
    db.update((schema as any).approvals)
      .set({ status: decision, decidedBy: 'user', decidedAt: now })
      .where(eq((schema as any).approvals.id, req.params.id)).run();
    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'approval_responded',
      missionId: approval.missionId,
      approvalId: approval.id,
      approved,
      decidedBy: 'user',
      timestamp: now,
    });
    res.json({ success: true, decision });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to decide approval' });
  }
});

app.get('/api/events/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const missionId = typeof req.query.missionId === 'string' ? req.query.missionId : undefined;
  let lastSequence = Math.max(0, Number(req.query.afterSequence) || 0);
  let replaying = Boolean(missionId);
  const buffered: AgentEvent[] = [];
  const writeEvent = (event: AgentEvent) => {
    if (missionId && event.missionId !== missionId) return;
    const sequence = Number(event.sequence || 0);
    if (missionId && sequence && sequence <= lastSequence) return;
    if (sequence) lastSequence = sequence;
    res.write(`id: ${sequence || event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = eventBus.on('*', (event: AgentEvent) => {
    if (replaying) buffered.push(event);
    else writeEvent(event);
  });
  if (missionId) {
    while (true) {
      const rows = sqlite.prepare(`SELECT payload, sequence, schema_version FROM mission_events WHERE mission_id = ? AND sequence > ? ORDER BY sequence LIMIT 1000`)
        .all(missionId, lastSequence) as Array<{ payload: string; sequence: number; schema_version: number }>;
      for (const row of rows) writeEvent({ ...JSON.parse(row.payload), sequence: row.sequence, schemaVersion: row.schema_version || 1 } as AgentEvent);
      if (rows.length < 1000) break;
    }
    replaying = false;
    for (const event of buffered) writeEvent(event);
  }
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

const wss = new WebSocketServer({ noServer: true });

function rejectWebSocketUpgrade(socket: import('stream').Duplex, status: 400 | 401 | 403 | 503): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 503 ? 'Service Unavailable' : 'Bad Request';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', async (request, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
  } catch {
    rejectWebSocketUpgrade(socket, 400);
    return;
  }

  if (pathname !== '/ws/events') {
    // There is no other upgrade route in this service. Do not leave unknown
    // upgrade sockets hanging or accidentally let them bypass auth.
    socket.destroy();
    return;
  }

  if (!authorizeRuntimeToken(RUNTIME_TOKEN, request.headers, request.url).ok) {
    rejectWebSocketUpgrade(socket, 401);
    return;
  }

  const token = extractBearerHeader(request.headers.authorization);
  if (!token) {
    rejectWebSocketUpgrade(socket, 401);
    return;
  }

  try {
    const authorization = await authService.authorizeWebSocket(token);
    if (!authorization.allowed) {
      rejectWebSocketUpgrade(socket, authorization.status as 401 | 403 | 503);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } catch {
    rejectWebSocketUpgrade(socket, 503);
  }
});

wss.on('connection', (ws: WebSocket) => {
  console.log('[API-Gateway] WebSocket client connected');
  const unsubscribe = eventBus.on('*', (event: AgentEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  });
  ws.on('close', () => {
    console.log('[API-Gateway] WebSocket client disconnected');
    unsubscribe();
  });
  ws.on('error', (err: unknown) => {
    console.error('[API-Gateway] WebSocket error:', err);
    unsubscribe();
  });
});

const isMain = shouldAutoStartGateway();
setImmediate(() => {
  const recoveredAt = new Date().toISOString();
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE mission_commands SET status = 'failed', processed_at = ?, error = COALESCE(error, 'Gateway restarted while command was starting') WHERE status = 'processing'")
      .run(recoveredAt);
    sqlite.prepare("UPDATE mission_runs SET status = 'failed', completed_at = ?, error = COALESCE(error, 'Gateway restarted before completion was confirmed') WHERE status IN ('starting', 'running', 'stopping')")
      .run(recoveredAt);
    sqlite.prepare("UPDATE conversation_turns SET status = 'failed', completed_at = ? WHERE status IN ('starting', 'running')").run(recoveredAt);
    sqlite.prepare("UPDATE missions SET status = 'failed', completed_at = ?, active_run_id = NULL WHERE active_run_id IS NOT NULL")
      .run(recoveredAt);
  })();
  const pending = sqlite.prepare("SELECT DISTINCT mission_id FROM mission_commands WHERE status = 'pending'").all() as Array<{ mission_id: string }>;
  for (const row of pending) void drainMissionCommands(row.mission_id);
});
if (isMain && process.env.NODE_ENV !== 'test' && !server.listening) {
  server.listen(PORT, '127.0.0.1', () => {
    const ready = emitRuntimeReady(server, gatewayVersion());
    const origin = ready?.origin || `http://127.0.0.1:${PORT}`;
    console.log(`[API-Gateway] Server running on ${origin}`);
    console.log(`[API-Gateway] WebSocket stream ready at ${origin.replace(/^http:/, 'ws:')}/ws/events`);
    console.log(`[API-Gateway] SSE event stream ready at ${origin}/api/events/stream`);
  });
}

export { app, server, eventBus, workspaceManager, orchestrator, runtimeHost, shutdownCoordinator };

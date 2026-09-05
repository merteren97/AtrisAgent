import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DATABASE_SCHEMA_VERSION, migrateDatabase } from './migrations';

const sqlite = new Database(':memory:');
sqlite.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE workspaces (id TEXT PRIMARY KEY);
  CREATE TABLE missions (id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id));
  CREATE TABLE mission_events (
    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    task_id TEXT, agent_instance_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    task_id TEXT, run_id TEXT, type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT DEFAULT 'pending', decided_by TEXT, created_at TEXT NOT NULL, decided_at TEXT);
  CREATE TABLE resource_leases (
    id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
    held_by_agent_id TEXT NOT NULL, expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
    status TEXT DEFAULT 'active', metadata TEXT);
  CREATE TABLE agent_instances (
    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), role TEXT NOT NULL,
    model_profile_id TEXT DEFAULT '', account_profile_id TEXT DEFAULT '', runtime_adapter_id TEXT DEFAULT '',
    session_id TEXT, status TEXT DEFAULT 'idle', created_at TEXT NOT NULL);
  CREATE TABLE team_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', is_default INTEGER DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), title TEXT NOT NULL);
  CREATE TABLE worktrees (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), task_id TEXT NOT NULL, branch_name TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
  INSERT INTO workspaces (id) VALUES ('workspace-1');
  INSERT INTO missions (id, workspace_id) VALUES ('mission-1', 'workspace-1');
  INSERT INTO mission_events (id, mission_id, type, payload, created_at) VALUES
    ('event-2', 'mission-1', 'agent_started', '{"id":"event-2"}', '2026-01-01T00:00:01.000Z'),
    ('event-1', 'mission-1', 'mission_started', '{"id":"event-1"}', '2026-01-01T00:00:00.000Z');
  INSERT INTO approvals (id, mission_id, type, status, created_at)
    VALUES ('approval-1', 'mission-1', 'apply', 'processing', '2026-01-01T00:00:00.000Z');
`);

migrateDatabase(sqlite as any);
migrateDatabase(sqlite as any);

assert.equal(sqlite.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION);
assert.deepEqual(sqlite.prepare('SELECT id, sequence, schema_version FROM mission_events ORDER BY sequence').all(), [
  { id: 'event-1', sequence: 1, schema_version: 1 },
  { id: 'event-2', sequence: 2, schema_version: 1 },
]);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_turns', 'mission_runs', 'mission_commands', 'approval_operations', 'mission_completions', 'runtime_telemetry', 'task_attempts')").get() as { count: number }).count, 7);
assert.equal((sqlite.prepare('SELECT COUNT(*) AS count FROM mission_events').get() as { count: number }).count, 2);
assert.ok((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('mission_commands') WHERE name IN ('claimed_at', 'attempt_count', 'request_hash')").get() as { count: number }).count === 3);
assert.ok((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_mission_runs_one_active'").get() as { count: number }).count === 1);
assert.equal((sqlite.prepare("SELECT status FROM approvals WHERE id = 'approval-1'").get() as { status: string }).status, 'reconcile_required');
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_runtime_telemetry_mission_recorded'").get() as { count: number }).count, 1);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('approval_operations') WHERE name IN ('operation_type', 'resource_id', 'idempotency_key', 'result', 'reconciled_at', 'reconcile_attempts')").get() as { count: number }).count, 6);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('mission_completions') WHERE name IN ('run_id', 'turn_id')").get() as { count: number }).count, 2);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('approvals') WHERE name IN ('requested_decision', 'claimed_at', 'attempt_count', 'execution_error')").get() as { count: number }).count, 4);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_resource_leases_active_resource'").get() as { count: number }).count, 1);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'agent_messages'").get() as { count: number }).count, 1);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('agent_instances') WHERE name IN ('task_id', 'parent_agent_id', 'display_name', 'specialty', 'spawn_reason', 'status_message', 'progress', 'workspace_mode', 'started_at', 'completed_at')").get() as { count: number }).count, 10);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('agent_instances') WHERE name = 'profile_id'").get() as { count: number }).count, 1);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('agent_instances') WHERE name = 'agent_profile_id'").get() as { count: number }).count, 1);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('tasks') WHERE name = 'agent_profile_id'").get() as { count: number }).count, 1);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('task_attempts') WHERE name = 'agent_profile_id'").get() as { count: number }).count, 1);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('agent_profiles', 'agent_profile_bindings')").get() as { count: number }).count, 2);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('agent_profiles') WHERE name IN ('id', 'name', 'role', 'instructions', 'capabilities', 'specialty', 'description', 'route_policy', 'allowed_route_policy', 'is_default', 'archived_at', 'created_at', 'updated_at')").get() as { count: number }).count, 13);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('agent_profile_bindings') WHERE name IN ('id', 'scope_type', 'scope_id', 'role', 'profile_id', 'override', 'is_default', 'created_at', 'updated_at')").get() as { count: number }).count, 9);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN ('idx_agent_profiles_role_default', 'idx_agent_profile_bindings_scope_role_profile', 'idx_agent_profile_bindings_scope_role_default')").get() as { count: number }).count, 3);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('task_attempts') WHERE name IN ('runtime_session_id', 'heartbeat_at', 'lease_expires_at', 'retryable', 'claimed_at')").get() as { count: number }).count, 5);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('task_attempts') WHERE name IN ('route_adapter_id', 'route_provider', 'route_account_profile_id', 'route_model_catalog_id', 'route_runtime_model_id', 'route_reasoning_level', 'route_source', 'route_selection_mode', 'provider_session_id')").get() as { count: number }).count, 9);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('team_templates') WHERE name IN ('max_parallel_agents', 'worker_pools')").get() as { count: number }).count, 2);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN ('idx_task_attempts_task_number', 'idx_task_attempts_active_lease')").get() as { count: number }).count, 2);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'deletion_operations'").get() as { count: number }).count, 1);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('deletion_operations') WHERE name IN ('target_type', 'target_id', 'remove_memory', 'phase', 'manifest', 'progress', 'error', 'owner_token', 'lease_expires_at', 'created_at', 'updated_at', 'completed_at')").get() as { count: number }).count, 12);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('tasks') WHERE name = 'target_descriptor'").get() as { count: number }).count, 1);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('worktrees') WHERE name IN ('isolation_kind', 'canonical_container', 'target_name', 'target_path', 'applied_operation_key', 'target_descriptor')").get() as { count: number }).count, 6);
sqlite.prepare(`INSERT INTO resource_leases
  (id, resource_type, resource_id, held_by_agent_id, expires_at, heartbeat_at, status)
  VALUES ('lease-1', 'workspace', 'main', 'agent-1', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'active')`).run();
assert.throws(() => sqlite.prepare(`INSERT INTO resource_leases
  (id, resource_type, resource_id, held_by_agent_id, expires_at, heartbeat_at, status)
  VALUES ('lease-2', 'workspace', 'main', 'agent-2', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'active')`).run());
sqlite.prepare("UPDATE approvals SET status = 'processing' WHERE id = 'approval-1'").run();
sqlite.prepare("INSERT INTO approval_operations (approval_id, decision, status, started_at) VALUES ('approval-1', 'approved', 'applying', 'now')").run();
sqlite.pragma('user_version = 3');
migrateDatabase(sqlite as any);
assert.equal((sqlite.prepare("SELECT status FROM approval_operations WHERE approval_id = 'approval-1'").get() as { status: string }).status, 'reconcile_required');
assert.equal((sqlite.prepare("SELECT status FROM approvals WHERE id = 'approval-1'").get() as { status: string }).status, 'reconcile_required');
assert.throws(() => sqlite.prepare(`INSERT INTO mission_events
  (id, mission_id, type, payload, sequence, schema_version, created_at) VALUES ('duplicate-sequence', 'mission-1', 'x', '{}', 1, 1, 'now')`).run());

sqlite.prepare(`INSERT INTO agent_profiles
  (id, name, role, instructions, capabilities, is_default, created_at, updated_at)
  VALUES ('global-builder', 'Global Builder', 'builder', '', '[]', 1, 'now', 'now')`).run();
assert.throws(() => sqlite.prepare(`INSERT INTO agent_profiles
  (id, name, role, instructions, capabilities, is_default, created_at, updated_at)
  VALUES ('second-builder', 'Second Builder', 'builder', '', '[]', 1, 'now', 'now')`).run());
sqlite.prepare(`INSERT INTO agent_profile_bindings
  (id, scope_type, scope_id, role, profile_id, is_default, created_at, updated_at)
  VALUES ('workspace-builder', 'workspace', 'workspace-1', 'builder', 'global-builder', 1, 'now', 'now')`).run();
assert.throws(() => sqlite.prepare(`INSERT INTO agent_profile_bindings
  (id, scope_type, scope_id, role, profile_id, is_default, created_at, updated_at)
  VALUES ('workspace-builder-2', 'workspace', 'workspace-1', 'builder', 'global-builder', 1, 'now', 'now')`).run());
assert.throws(() => sqlite.prepare(`INSERT INTO agent_profile_bindings
  (id, scope_type, scope_id, role, profile_id, is_default, created_at, updated_at)
  VALUES ('wrong-role-binding', 'workspace', 'workspace-1', 'reviewer', 'global-builder', 0, 'now', 'now')`).run());
assert.throws(() => sqlite.prepare("UPDATE agent_profiles SET role = 'reviewer' WHERE id = 'global-builder'").run());
sqlite.prepare("DELETE FROM missions WHERE id = 'mission-1'").run();
sqlite.prepare("DELETE FROM workspaces WHERE id = 'workspace-1'").run();
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM agent_profiles WHERE id = 'global-builder'").get() as { count: number }).count, 1);

sqlite.close();

const sqliteWithoutApprovals = new Database(':memory:');
sqliteWithoutApprovals.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE workspaces (id TEXT PRIMARY KEY);
  CREATE TABLE missions (id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id));
  CREATE TABLE mission_events (
    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    task_id TEXT, agent_instance_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
`);
assert.doesNotThrow(() => migrateDatabase(sqliteWithoutApprovals as any));
assert.equal(sqliteWithoutApprovals.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION);
assert.equal((sqliteWithoutApprovals.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('agent_profiles', 'agent_profile_bindings')").get() as { count: number }).count, 2);
sqliteWithoutApprovals.close();

console.log('[PASS] migrations preserve data, backfill stable sequences, enforce uniqueness, and are idempotent');

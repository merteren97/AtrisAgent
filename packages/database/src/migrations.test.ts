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
  INSERT INTO workspaces (id) VALUES ('workspace-1');
  INSERT INTO missions (id, workspace_id) VALUES ('mission-1', 'workspace-1');
  INSERT INTO mission_events (id, mission_id, type, payload, created_at) VALUES
    ('event-2', 'mission-1', 'agent_started', '{"id":"event-2"}', '2026-01-01T00:00:01.000Z'),
    ('event-1', 'mission-1', 'mission_started', '{"id":"event-1"}', '2026-01-01T00:00:00.000Z');
`);

migrateDatabase(sqlite as any);
migrateDatabase(sqlite as any);

assert.equal(sqlite.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION);
assert.deepEqual(sqlite.prepare('SELECT id, sequence, schema_version FROM mission_events ORDER BY sequence').all(), [
  { id: 'event-1', sequence: 1, schema_version: 1 },
  { id: 'event-2', sequence: 2, schema_version: 1 },
]);
assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_turns', 'mission_runs', 'mission_commands')").get() as { count: number }).count, 3);
assert.equal((sqlite.prepare('SELECT COUNT(*) AS count FROM mission_events').get() as { count: number }).count, 2);
assert.ok((sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('mission_commands') WHERE name IN ('claimed_at', 'attempt_count', 'request_hash')").get() as { count: number }).count === 3);
assert.ok((sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_mission_runs_one_active'").get() as { count: number }).count === 1);
assert.throws(() => sqlite.prepare(`INSERT INTO mission_events
  (id, mission_id, type, payload, sequence, schema_version, created_at) VALUES ('duplicate-sequence', 'mission-1', 'x', '{}', 1, 1, 'now')`).run());

sqlite.close();
console.log('[PASS] migrations preserve data, backfill stable sequences, enforce uniqueness, and are idempotent');

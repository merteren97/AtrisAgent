import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { persistRuntimeTelemetry } from './runtime-telemetry-store';

const sqlite = new Database(':memory:');
sqlite.exec(`CREATE TABLE runtime_telemetry (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, task_id TEXT NOT NULL,
  agent_instance_id TEXT NOT NULL, adapter_id TEXT NOT NULL, account_profile_id TEXT,
  outcome TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cost REAL, currency TEXT NOT NULL, queue_wait_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
  retry_count INTEGER NOT NULL, worker_utilization REAL NOT NULL, recorded_at TEXT NOT NULL
)`);

const event = {
  id: 'telemetry-1', type: 'runtime_telemetry' as const, missionId: 'mission-1', taskId: 'task-1',
  agentInstanceId: 'agent-1', adapterId: 'codex', outcome: 'completed' as const,
  inputTokens: 10, outputTokens: 20, cost: 0.12, currency: 'USD', queueWaitMs: 30,
  durationMs: 400, retryCount: 2, workerUtilization: 0.5, timestamp: '2026-08-24T20:00:00.000Z',
};
persistRuntimeTelemetry(sqlite, event);
persistRuntimeTelemetry(sqlite, event);
const row = sqlite.prepare('SELECT * FROM runtime_telemetry WHERE id = ?').get(event.id) as any;
assert.equal(row.input_tokens, 10, 'telemetry persists token counts');
assert.equal(row.retry_count, 2, 'telemetry persists retry count');
assert.equal((sqlite.prepare('SELECT COUNT(*) AS count FROM runtime_telemetry').get() as { count: number }).count, 1, 'telemetry persistence is idempotent by event id');
sqlite.close();
console.log('Runtime telemetry store tests passed.');

import type { RuntimeTelemetry } from '@atris-agent-code/event-schema';

export interface TelemetrySqlite {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

export function persistRuntimeTelemetry(sqlite: TelemetrySqlite, event: RuntimeTelemetry): void {
  sqlite.prepare(`INSERT OR IGNORE INTO runtime_telemetry
    (id, mission_id, task_id, agent_instance_id, adapter_id, account_profile_id, outcome,
     input_tokens, output_tokens, cost, currency, queue_wait_ms, duration_ms, retry_count,
     worker_utilization, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    event.id,
    event.missionId,
    event.taskId,
    event.agentInstanceId,
    event.adapterId,
    event.accountProfileId || null,
    event.outcome,
    event.inputTokens,
    event.outputTokens,
    event.cost,
    event.currency,
    event.queueWaitMs,
    event.durationMs,
    event.retryCount,
    event.workerUtilization,
    event.timestamp,
  );
}

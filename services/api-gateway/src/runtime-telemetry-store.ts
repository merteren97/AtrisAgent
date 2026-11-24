import type { RuntimeTelemetry } from '@atris-agent-code/event-schema';

export interface TelemetrySqlite {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all?(...params: unknown[]): unknown[];
  };
}

export type RuntimeTelemetryWithExtendedUsage = RuntimeTelemetry & {
  cachedTokens?: number;
  reasoningTokens?: number;
};

const extendedColumnsCache = new WeakMap<object, boolean>();

function hasExtendedUsageColumns(sqlite: TelemetrySqlite): boolean {
  const cached = extendedColumnsCache.get(sqlite);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const stmt = sqlite.prepare('PRAGMA table_info(runtime_telemetry)');
    if (typeof stmt.all === 'function') {
      const cols = stmt.all() as Array<{ name?: string }>;
      const names = new Set(cols.map((c) => c.name));
      supported = names.has('cached_tokens') && names.has('reasoning_tokens');
    }
  } catch {
    supported = false;
  }
  extendedColumnsCache.set(sqlite, supported);
  return supported;
}

export function persistRuntimeTelemetry(
  sqlite: TelemetrySqlite,
  event: RuntimeTelemetryWithExtendedUsage,
): void {
  if (hasExtendedUsageColumns(sqlite)) {
    sqlite.prepare(`INSERT OR IGNORE INTO runtime_telemetry
      (id, mission_id, task_id, agent_instance_id, adapter_id, account_profile_id, attempt_id, outcome,
       usage_available, usage_source, input_tokens, output_tokens, cached_tokens, reasoning_tokens,
       cost, currency, queue_wait_ms, duration_ms, retry_count, worker_utilization, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.id,
      event.missionId,
      event.taskId,
      event.agentInstanceId,
      event.adapterId,
      event.accountProfileId || null,
      event.attemptId || null,
      event.outcome,
      event.usageAvailable ? 1 : 0,
      event.usageSource,
      event.inputTokens,
      event.outputTokens,
      Math.max(0, Math.round(event.cachedTokens || 0)),
      Math.max(0, Math.round(event.reasoningTokens || 0)),
      event.cost,
      event.currency || '',
      event.queueWaitMs,
      event.durationMs,
      event.retryCount,
      event.workerUtilization,
      event.timestamp,
    );
    return;
  }

  sqlite.prepare(`INSERT OR IGNORE INTO runtime_telemetry
    (id, mission_id, task_id, agent_instance_id, adapter_id, account_profile_id, attempt_id, outcome,
     usage_available, usage_source, input_tokens, output_tokens, cost, currency, queue_wait_ms,
     duration_ms, retry_count, worker_utilization, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    event.id,
    event.missionId,
    event.taskId,
    event.agentInstanceId,
    event.adapterId,
    event.accountProfileId || null,
    event.attemptId || null,
    event.outcome,
    event.usageAvailable ? 1 : 0,
    event.usageSource,
    event.inputTokens,
    event.outputTokens,
    event.cost,
    event.currency || '',
    event.queueWaitMs,
    event.durationMs,
    event.retryCount,
    event.workerUtilization,
    event.timestamp,
  );
}

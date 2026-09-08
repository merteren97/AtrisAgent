import type Database from 'better-sqlite3';

export const DELETION_PHASES = ['stop', 'runtime', 'worktrees', 'checkpoints', 'policy', 'memory', 'relational'] as const;
export type DeletionPhase = typeof DELETION_PHASES[number];
export type DeletionTargetType = 'mission' | 'workspace';

interface Row {
  id: string; target_type: DeletionTargetType; target_id: string; remove_memory: number;
  phase: DeletionPhase; status: 'pending' | 'running' | 'retryable' | 'completed';
  manifest: string; progress: string; error: string | null; owner_token: string | null;
  lease_expires_at: string | null; attempt_count: number; created_at: string; updated_at: string; completed_at: string | null;
}

export interface DeletionOperation {
  id: string; targetType: DeletionTargetType; targetId: string; removeMemory: boolean;
  phase: DeletionPhase | 'completed'; status: Row['status']; manifest: string[];
  progress: Record<string, unknown>; error: string | null; attemptCount: number;
  createdAt: string; updatedAt: string; completedAt: string | null;
}

export type DeletionHandlers = Record<DeletionPhase, (operation: DeletionOperation) => Promise<void>>;

function boundedStrings(values: string[]): string[] {
  return values.slice(0, 256).map((value) => String(value).slice(0, 512));
}

export class DeletionOperationStore {
  constructor(private sqlite: Database.Database, private leaseMs = 30_000) {}

  get(targetType: DeletionTargetType, targetId: string): DeletionOperation | null {
    return this.dto(this.sqlite.prepare('SELECT * FROM deletion_operations WHERE target_type = ? AND target_id = ?').get(targetType, targetId) as Row | undefined);
  }

  listIncomplete(): DeletionOperation[] {
    return (this.sqlite.prepare("SELECT * FROM deletion_operations WHERE status <> 'completed' ORDER BY created_at").all() as Row[]).map((row) => this.dto(row)!);
  }

  begin(targetType: DeletionTargetType, targetId: string, removeMemory: boolean, manifest: string[]): DeletionOperation {
    const now = new Date().toISOString();
    this.sqlite.prepare(`INSERT INTO deletion_operations
      (id, target_type, target_id, remove_memory, phase, status, manifest, progress, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'stop', 'pending', ?, '{}', ?, ?)
      ON CONFLICT(target_type, target_id) DO NOTHING`)
      .run(crypto.randomUUID(), targetType, targetId, removeMemory ? 1 : 0, JSON.stringify(boundedStrings(manifest)), now, now);
    return this.get(targetType, targetId)!;
  }

  recoverInterrupted(): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`UPDATE deletion_operations SET status = 'retryable', owner_token = NULL,
      lease_expires_at = NULL, updated_at = ?, error = COALESCE(error, 'Gateway restarted during deletion; retry is safe')
      WHERE status = 'running'`).run(now);
  }

  /** Mark an unexpected runner failure retryable, without clobbering another owner. */
  markRetryable(id: string, error: unknown, ownerToken?: string): void {
    const message = String(error instanceof Error ? error.message : error).slice(0, 2048);
    const where = ownerToken
      ? "status <> 'completed' AND (status <> 'running' OR owner_token = ?)"
      : "status IN ('pending', 'retryable')";
    const args = ownerToken
      ? [message || 'Deletion runner failed unexpectedly; retry is safe', new Date().toISOString(), id, ownerToken]
      : [message || 'Deletion runner failed unexpectedly; retry is safe', new Date().toISOString(), id];
    this.sqlite.prepare(`UPDATE deletion_operations SET status = 'retryable', error = ?, owner_token = NULL,
      lease_expires_at = NULL, updated_at = ? WHERE id = ? AND ${where}`).run(...args);
  }

  async execute(operation: DeletionOperation, handlers: DeletionHandlers): Promise<DeletionOperation> {
    let current = operation;
    const owner = crypto.randomUUID();
    let ownsCurrentPhase = false;
    while (current.status !== 'completed') {
      if (!ownsCurrentPhase) {
        if (!this.claim(current.id, current.phase as DeletionPhase, owner)) return this.get(current.targetType, current.targetId)!;
        ownsCurrentPhase = true;
      }
      const heartbeatInterval = Math.max(1, Math.floor(this.leaseMs / 3));
      const heartbeat = setInterval(() => {
        try { this.renew(current.id, owner); } catch { /* The handler result will surface the database failure. */ }
      }, heartbeatInterval);
      try {
        await handlers[current.phase as DeletionPhase](current);
        if (!this.advance(current.id, current.phase as DeletionPhase, owner)) {
          return this.get(current.targetType, current.targetId)!;
        }
      } catch (error: any) {
        this.fail(current.id, owner, error?.message || String(error));
        return this.get(current.targetType, current.targetId)!;
      } finally {
        clearInterval(heartbeat);
      }
      current = this.get(current.targetType, current.targetId)!;
    }
    return current;
  }

  private claim(id: string, phase: DeletionPhase, owner: string): boolean {
    const now = new Date();
    const result = this.sqlite.prepare(`UPDATE deletion_operations SET status = 'running', owner_token = ?,
      lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?, error = NULL
      WHERE id = ? AND phase = ? AND (status IN ('pending', 'retryable')
        OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))`)
      .run(owner, new Date(now.getTime() + this.leaseMs).toISOString(), now.toISOString(), id, phase, now.toISOString());
    return result.changes === 1;
  }

  private renew(id: string, owner: string): void {
    const now = new Date();
    this.sqlite.prepare(`UPDATE deletion_operations SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND owner_token = ?`)
      .run(new Date(now.getTime() + this.leaseMs).toISOString(), now.toISOString(), id, owner);
  }

  private advance(id: string, phase: DeletionPhase, owner: string): boolean {
    const index = DELETION_PHASES.indexOf(phase);
    const next = DELETION_PHASES[index + 1];
    const now = new Date().toISOString();
    const progress = JSON.stringify({ completedPhases: DELETION_PHASES.slice(0, index + 1), completedCount: index + 1, totalCount: DELETION_PHASES.length });
    if (next) {
      const result = this.sqlite.prepare(`UPDATE deletion_operations SET phase = ?, status = 'running', progress = ?,
      lease_expires_at = ?, updated_at = ? WHERE id = ? AND owner_token = ? AND phase = ?`)
      .run(next, progress, new Date(Date.now() + this.leaseMs).toISOString(), now, id, owner, phase);
      if (result.changes !== 1) return false;
      const row = this.sqlite.prepare('SELECT phase, status, owner_token FROM deletion_operations WHERE id = ?').get(id) as { phase: DeletionPhase; status: Row['status']; owner_token: string | null } | undefined;
      return row?.phase === next && row.status === 'running' && row.owner_token === owner;
    }
    const result = this.sqlite.prepare(`UPDATE deletion_operations SET phase = 'relational', status = 'completed', progress = ?,
      owner_token = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ? WHERE id = ? AND owner_token = ? AND phase = ?`)
      .run(progress, now, now, id, owner, phase);
    return result.changes === 1;
  }

  private fail(id: string, owner: string, error: string): void {
    this.sqlite.prepare(`UPDATE deletion_operations SET status = 'retryable', error = ?, owner_token = NULL,
      lease_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_token = ?`)
      .run(error.slice(0, 2048), new Date().toISOString(), id, owner);
  }

  private dto(row?: Row): DeletionOperation | null {
    if (!row) return null;
    return { id: row.id, targetType: row.target_type, targetId: row.target_id, removeMemory: Boolean(row.remove_memory),
      phase: row.status === 'completed' ? 'completed' : row.phase, status: row.status,
      manifest: JSON.parse(row.manifest || '[]'), progress: JSON.parse(row.progress || '{}'), error: row.error,
      attemptCount: row.attempt_count, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at };
  }
}

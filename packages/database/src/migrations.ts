export interface SQLiteMigrationDatabase {
  exec(sql: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  transaction<T extends (...args: any[]) => any>(fn: T): T;
}

export const DATABASE_SCHEMA_VERSION = 2;

function hasColumn(sqlite: SQLiteMigrationDatabase, table: string, column: string): boolean {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all()
    .some((row) => (row as { name?: string }).name === column);
}

export function migrateDatabase(sqlite: SQLiteMigrationDatabase): void {
  let current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 1) sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        content TEXT NOT NULL, delivery TEXT NOT NULL, options TEXT, status TEXT NOT NULL DEFAULT 'queued',
        idempotency_key TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turns_mission_idempotency
        ON conversation_turns(mission_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_mission_status ON conversation_turns(mission_id, status, created_at);
      CREATE TABLE IF NOT EXISTS mission_runs (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES conversation_turns(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'starting',
        started_at TEXT NOT NULL, completed_at TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS idx_mission_runs_mission_status ON mission_runs(mission_id, status);
      CREATE TABLE IF NOT EXISTS mission_commands (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE, type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, processed_at TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS idx_mission_commands_pending
        ON mission_commands(mission_id, status, priority DESC, created_at);
    `);
    if (!hasColumn(sqlite, 'mission_events', 'sequence')) sqlite.exec('ALTER TABLE mission_events ADD COLUMN sequence INTEGER');
    if (!hasColumn(sqlite, 'mission_events', 'schema_version')) sqlite.exec('ALTER TABLE mission_events ADD COLUMN schema_version INTEGER');
    const rows = sqlite.prepare(`SELECT rowid, mission_id FROM mission_events
      WHERE sequence IS NULL ORDER BY mission_id, created_at, rowid`).all() as Array<{ rowid: number; mission_id: string }>;
    const maxima = sqlite.prepare(`SELECT mission_id, COALESCE(MAX(sequence), 0) AS max_sequence
      FROM mission_events GROUP BY mission_id`).all() as Array<{ mission_id: string; max_sequence: number }>;
    const next = new Map(maxima.map((row) => [row.mission_id, Number(row.max_sequence) + 1]));
    const update = sqlite.prepare('UPDATE mission_events SET sequence = ?, schema_version = COALESCE(schema_version, 1) WHERE rowid = ?');
    for (const row of rows) {
      const sequence = next.get(row.mission_id) || 1;
      update.run(sequence, row.rowid);
      next.set(row.mission_id, sequence + 1);
    }
    sqlite.exec(`UPDATE mission_events SET schema_version = 1 WHERE schema_version IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_events_mission_sequence ON mission_events(mission_id, sequence);
      PRAGMA user_version = 1;`);
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 2) sqlite.transaction(() => {
    if (!hasColumn(sqlite, 'missions', 'automation_policy')) sqlite.exec('ALTER TABLE missions ADD COLUMN automation_policy TEXT');
    if (!hasColumn(sqlite, 'missions', 'active_run_id')) sqlite.exec('ALTER TABLE missions ADD COLUMN active_run_id TEXT');
    if (!hasColumn(sqlite, 'conversation_turns', 'request_hash')) sqlite.exec('ALTER TABLE conversation_turns ADD COLUMN request_hash TEXT');
    if (!hasColumn(sqlite, 'conversation_turns', 'command_id')) sqlite.exec('ALTER TABLE conversation_turns ADD COLUMN command_id TEXT');
    if (!hasColumn(sqlite, 'mission_runs', 'command_id')) sqlite.exec('ALTER TABLE mission_runs ADD COLUMN command_id TEXT');
    if (!hasColumn(sqlite, 'mission_runs', 'plan_id')) sqlite.exec('ALTER TABLE mission_runs ADD COLUMN plan_id TEXT');
    if (!hasColumn(sqlite, 'mission_runs', 'heartbeat_at')) sqlite.exec('ALTER TABLE mission_runs ADD COLUMN heartbeat_at TEXT');
    if (!hasColumn(sqlite, 'mission_commands', 'claimed_at')) sqlite.exec('ALTER TABLE mission_commands ADD COLUMN claimed_at TEXT');
    if (!hasColumn(sqlite, 'mission_commands', 'attempt_count')) sqlite.exec('ALTER TABLE mission_commands ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
    if (!hasColumn(sqlite, 'mission_commands', 'request_hash')) sqlite.exec('ALTER TABLE mission_commands ADD COLUMN request_hash TEXT');
    if (hasColumn(sqlite, 'missions', 'status') && hasColumn(sqlite, 'missions', 'completed_at')) {
      sqlite.exec(`UPDATE missions SET status = 'failed', completed_at = COALESCE(completed_at, datetime('now'))
        WHERE id IN (SELECT mission_id FROM mission_runs WHERE status IN ('starting', 'running', 'stopping'))`);
    }
    sqlite.exec(`
      UPDATE mission_commands SET status = 'failed', processed_at = COALESCE(processed_at, datetime('now')),
        error = COALESCE(error, 'Gateway restarted while command was starting') WHERE status = 'processing';
      UPDATE mission_runs SET status = 'failed', completed_at = COALESCE(completed_at, datetime('now')),
        error = COALESCE(error, 'Gateway restarted before run completion could be confirmed')
        WHERE status IN ('starting', 'running', 'stopping');
      UPDATE conversation_turns SET status = 'failed', completed_at = COALESCE(completed_at, datetime('now'))
        WHERE status IN ('starting', 'running');
      UPDATE missions SET active_run_id = NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_runs_one_active ON mission_runs(mission_id)
        WHERE status IN ('starting', 'running', 'stopping');
      PRAGMA user_version = 2;
    `);
  })();
}

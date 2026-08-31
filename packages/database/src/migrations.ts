export interface SQLiteMigrationDatabase {
  exec(sql: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  transaction<T extends (...args: any[]) => any>(fn: T): T;
}

export const DATABASE_SCHEMA_VERSION = 17;

function hasColumn(sqlite: SQLiteMigrationDatabase, table: string, column: string): boolean {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all()
    .some((row) => (row as { name?: string }).name === column);
}

function hasTable(sqlite: SQLiteMigrationDatabase, table: string): boolean {
  return sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(table).length > 0;
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
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 3) sqlite.transaction(() => {
    if (hasTable(sqlite, 'approvals')) {
      if (!hasColumn(sqlite, 'approvals', 'requested_decision')) sqlite.exec('ALTER TABLE approvals ADD COLUMN requested_decision TEXT');
      if (!hasColumn(sqlite, 'approvals', 'claimed_at')) sqlite.exec('ALTER TABLE approvals ADD COLUMN claimed_at TEXT');
      if (!hasColumn(sqlite, 'approvals', 'attempt_count')) sqlite.exec('ALTER TABLE approvals ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
      if (!hasColumn(sqlite, 'approvals', 'execution_error')) sqlite.exec('ALTER TABLE approvals ADD COLUMN execution_error TEXT');
       sqlite.exec(`UPDATE approvals SET status = 'reconcile_required', execution_error = COALESCE(execution_error, 'Gateway restarted while approval execution was in progress')
         WHERE status = 'processing'`);
    }
    sqlite.exec('PRAGMA user_version = 3');
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 4) sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS approval_operations (
        approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
        decision TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT, error TEXT);
       CREATE TABLE IF NOT EXISTS mission_completions (
         mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
         plan_id TEXT NOT NULL, status TEXT NOT NULL, summary TEXT,
         tasks_completed INTEGER NOT NULL, total_tasks INTEGER NOT NULL,
         created_at TEXT NOT NULL, completed_at TEXT,
         PRIMARY KEY (mission_id, plan_id));
       UPDATE approval_operations SET status = 'reconcile_required',
         error = COALESCE(error, 'Gateway restarted before approval side effect could be confirmed')
         WHERE status = 'applying';
       PRAGMA user_version = 4;
     `);
     if (hasTable(sqlite, 'approvals')) sqlite.exec(`UPDATE approvals SET status = 'reconcile_required',
       execution_error = COALESCE(execution_error, 'Approval outcome requires reconciliation after restart')
       WHERE id IN (SELECT approval_id FROM approval_operations WHERE status = 'reconcile_required')`);
   })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 5) sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS runtime_telemetry (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        account_profile_id TEXT,
        outcome TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL,
        currency TEXT NOT NULL DEFAULT 'USD',
        queue_wait_ms INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 1,
        worker_utilization REAL NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_telemetry_mission_recorded
        ON runtime_telemetry(mission_id, recorded_at);
      PRAGMA user_version = 5;
    `);
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 6) sqlite.transaction(() => {
    if (hasTable(sqlite, 'approval_operations')) {
      if (!hasColumn(sqlite, 'approval_operations', 'operation_type')) sqlite.exec("ALTER TABLE approval_operations ADD COLUMN operation_type TEXT NOT NULL DEFAULT 'approval'");
      if (!hasColumn(sqlite, 'approval_operations', 'resource_id')) sqlite.exec('ALTER TABLE approval_operations ADD COLUMN resource_id TEXT');
      if (!hasColumn(sqlite, 'approval_operations', 'idempotency_key')) sqlite.exec('ALTER TABLE approval_operations ADD COLUMN idempotency_key TEXT');
      if (!hasColumn(sqlite, 'approval_operations', 'result')) sqlite.exec('ALTER TABLE approval_operations ADD COLUMN result TEXT');
      if (!hasColumn(sqlite, 'approval_operations', 'reconciled_at')) sqlite.exec('ALTER TABLE approval_operations ADD COLUMN reconciled_at TEXT');
      if (!hasColumn(sqlite, 'approval_operations', 'reconcile_attempts')) sqlite.exec('ALTER TABLE approval_operations ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0');
      sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_operations_idempotency ON approval_operations(idempotency_key) WHERE idempotency_key IS NOT NULL');
    }
    sqlite.exec('PRAGMA user_version = 6');
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 7) sqlite.transaction(() => {
    if (hasTable(sqlite, 'mission_completions')) {
      if (!hasColumn(sqlite, 'mission_completions', 'run_id')) sqlite.exec('ALTER TABLE mission_completions ADD COLUMN run_id TEXT');
      if (!hasColumn(sqlite, 'mission_completions', 'turn_id')) sqlite.exec('ALTER TABLE mission_completions ADD COLUMN turn_id TEXT');
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_mission_completions_pending ON mission_completions(status, mission_id)');
    }
    sqlite.exec('PRAGMA user_version = 7');
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 8) sqlite.transaction(() => {
    // Older migrations used `failed` for an interrupted approval. Preserve the
    // audit trail while making the unresolved external side effect explicit.
    if (hasTable(sqlite, 'approvals')) {
      sqlite.exec(`UPDATE approvals SET status = 'reconcile_required'
        WHERE status = 'failed' AND execution_error IN (
          'Gateway restarted while approval execution was in progress',
          'Approval outcome requires reconciliation after restart'
        )`);
    }
    sqlite.exec('PRAGMA user_version = 8');
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 9) sqlite.transaction(() => {
    if (hasTable(sqlite, 'resource_leases')) {
      // Keep one active owner for legacy databases before adding the
      // cross-process uniqueness fence.
      sqlite.exec(`UPDATE resource_leases SET status = 'expired'
        WHERE status = 'active' AND rowid NOT IN (
          SELECT MAX(rowid) FROM resource_leases WHERE status = 'active'
          GROUP BY resource_type, resource_id
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_leases_active_resource
          ON resource_leases(resource_type, resource_id) WHERE status = 'active';`);
    }
    sqlite.exec('PRAGMA user_version = 9');
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 10) sqlite.transaction(() => {
    if (hasTable(sqlite, 'agent_instances')) {
      const columns: Array<[string, string]> = [
        ['task_id', 'TEXT'],
        ['parent_agent_id', 'TEXT'],
        ['display_name', 'TEXT'],
        ['specialty', 'TEXT'],
        ['spawn_reason', 'TEXT'],
        ['status_message', 'TEXT'],
        ['progress', 'INTEGER'],
        ['workspace_mode', 'TEXT'],
        ['started_at', 'TEXT'],
        ['completed_at', 'TEXT'],
      ];
      for (const [name, definition] of columns) {
        if (!hasColumn(sqlite, 'agent_instances', name)) {
          sqlite.exec(`ALTER TABLE agent_instances ADD COLUMN ${name} ${definition}`);
        }
      }
    }
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        from_agent_id TEXT NOT NULL,
        to_agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT,
        kind TEXT NOT NULL DEFAULT 'message',
        reply_to_message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_messages_mailbox
        ON agent_messages(mission_id, to_agent_id, read_at, created_at, id);
      PRAGMA user_version = 10;
    `);
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 11) sqlite.transaction(() => {
    if (!hasTable(sqlite, 'task_attempts')) {
      sqlite.exec(`CREATE TABLE task_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        agent_instance_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'claimed',
        worktree_path TEXT,
        runtime_session_id TEXT,
        heartbeat_at TEXT,
        lease_expires_at TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        result_summary TEXT,
        review_pack TEXT
      )`);
    } else {
      const columns: Array<[string, string]> = [
        ['runtime_session_id', 'TEXT'],
        ['heartbeat_at', 'TEXT'],
        ['lease_expires_at', 'TEXT'],
        ['retryable', 'INTEGER NOT NULL DEFAULT 0'],
        ['claimed_at', 'TEXT'],
      ];
      for (const [name, definition] of columns) {
        if (!hasColumn(sqlite, 'task_attempts', name)) sqlite.exec(`ALTER TABLE task_attempts ADD COLUMN ${name} ${definition}`);
      }
      sqlite.exec(`UPDATE task_attempts SET claimed_at = COALESCE(claimed_at, started_at)`);
    }
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_task_number
      ON task_attempts(task_id, attempt_number);
      CREATE INDEX IF NOT EXISTS idx_task_attempts_active_lease
      ON task_attempts(status, lease_expires_at);
      PRAGMA user_version = 11;`);
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 12) sqlite.transaction(() => {
    if (hasTable(sqlite, 'task_attempts')) {
      const columns: Array<[string, string]> = [
        ['route_adapter_id', 'TEXT'],
        ['route_provider', 'TEXT'],
        ['route_account_profile_id', 'TEXT'],
        ['route_model_catalog_id', 'TEXT'],
        ['route_runtime_model_id', 'TEXT'],
        ['route_reasoning_level', 'TEXT'],
        ['route_source', 'TEXT'],
        ['route_selection_mode', 'TEXT'],
        ['provider_session_id', 'TEXT'],
      ];
      for (const [name, definition] of columns) {
        if (!hasColumn(sqlite, 'task_attempts', name)) sqlite.exec(`ALTER TABLE task_attempts ADD COLUMN ${name} ${definition}`);
      }
    }
    sqlite.exec('PRAGMA user_version = 12');
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 13) sqlite.transaction(() => {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS apply_verification_operations (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL,
      run_id TEXT,
      idempotency_key TEXT NOT NULL,
      apply_phase TEXT NOT NULL DEFAULT 'pending',
      verification_phase TEXT NOT NULL DEFAULT 'pending',
      builder_task_ids TEXT NOT NULL,
      applied_task_ids TEXT NOT NULL DEFAULT '[]',
      verification_passed INTEGER,
      summary TEXT,
      evidence TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_apply_verification_mission_plan
      ON apply_verification_operations(mission_id, plan_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_apply_verification_idempotency
      ON apply_verification_operations(idempotency_key);
    UPDATE apply_verification_operations SET apply_phase = 'blocked',
      error = COALESCE(error, 'Gateway restarted during apply; external state requires reconciliation')
      WHERE apply_phase = 'in_progress';
    UPDATE apply_verification_operations SET verification_phase = 'blocked',
      error = COALESCE(error, 'Gateway restarted during verification; retry is safe')
      WHERE verification_phase = 'running';
    PRAGMA user_version = 13;`);
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 14) sqlite.transaction(() => {
    if (hasTable(sqlite, 'team_templates')) {
      if (!hasColumn(sqlite, 'team_templates', 'max_parallel_agents')) sqlite.exec('ALTER TABLE team_templates ADD COLUMN max_parallel_agents INTEGER');
      if (!hasColumn(sqlite, 'team_templates', 'worker_pools')) sqlite.exec('ALTER TABLE team_templates ADD COLUMN worker_pools TEXT');
    }
    sqlite.exec('PRAGMA user_version = 14');
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 15) sqlite.transaction(() => {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS deletion_operations (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      remove_memory INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL DEFAULT 'stop',
      status TEXT NOT NULL DEFAULT 'pending',
      manifest TEXT NOT NULL DEFAULT '[]',
      progress TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      owner_token TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deletion_operations_target
      ON deletion_operations(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_deletion_operations_incomplete
      ON deletion_operations(status, updated_at) WHERE status <> 'completed';
    UPDATE deletion_operations SET status = 'retryable', owner_token = NULL,
      lease_expires_at = NULL, error = COALESCE(error, 'Gateway restarted during deletion; retry is safe')
      WHERE status = 'running';
    PRAGMA user_version = 15;`);
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 16) sqlite.transaction(() => {
    if (hasTable(sqlite, 'runtime_telemetry')) {
      if (!hasColumn(sqlite, 'runtime_telemetry', 'attempt_id')) sqlite.exec('ALTER TABLE runtime_telemetry ADD COLUMN attempt_id TEXT');
      if (!hasColumn(sqlite, 'runtime_telemetry', 'usage_available')) sqlite.exec('ALTER TABLE runtime_telemetry ADD COLUMN usage_available INTEGER NOT NULL DEFAULT 0');
      if (!hasColumn(sqlite, 'runtime_telemetry', 'usage_source')) sqlite.exec("ALTER TABLE runtime_telemetry ADD COLUMN usage_source TEXT NOT NULL DEFAULT 'unavailable'");
      sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_telemetry_attempt ON runtime_telemetry(attempt_id) WHERE attempt_id IS NOT NULL');
    }
    sqlite.exec('PRAGMA user_version = 16');
  })();
  current = Number(sqlite.pragma('user_version', { simple: true }) || 0);
  if (current < 17) sqlite.transaction(() => {
    if (hasTable(sqlite, 'tasks') && !hasColumn(sqlite, 'tasks', 'target_descriptor')) {
      sqlite.exec('ALTER TABLE tasks ADD COLUMN target_descriptor TEXT');
    }
    if (hasTable(sqlite, 'worktrees')) {
      const columns: Array<[string, string]> = [
        ['isolation_kind', 'TEXT'],
        ['canonical_container', 'TEXT'],
        ['target_name', 'TEXT'],
        ['target_path', 'TEXT'],
        ['applied_operation_key', 'TEXT'],
        ['target_descriptor', 'TEXT'],
      ];
      for (const [name, definition] of columns) {
        if (!hasColumn(sqlite, 'worktrees', name)) sqlite.exec(`ALTER TABLE worktrees ADD COLUMN ${name} ${definition}`);
      }
    }
    sqlite.exec('PRAGMA user_version = 17');
  })();
}

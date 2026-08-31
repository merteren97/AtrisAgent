import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@atris-agent-code/database';
import type { AtrisDatabase } from '@atris-agent-code/database';
import { WorktreeManager } from './worktree-manager';
import { CheckpointManager, isSafeCheckpointId, isValidGitCommitSha } from './checkpoint-manager';
import { WorkspaceManager } from './workspace-manager';

async function runTests() {
  console.log('--- Starting WorkspaceManager & Worktree & Checkpoint Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ws-test-'));

  try {
    const runGit = (cwd: string, args: string[]) => {
      execFileSync('git', args, { cwd, windowsHide: true, stdio: 'ignore' });
    };
    const commitAll = (cwd: string, message: string) => {
      runGit(cwd, ['add', '-A']);
      runGit(cwd, ['-c', 'user.name=AtrisAgent Test', '-c', 'user.email=atrisagent-test@example.invalid', 'commit', '--quiet', '-m', message]);
    };

    const wsPath = path.join(tmpDir, 'test-app');
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'index.ts'), 'console.log("hello world");');
    fs.writeFileSync(path.join(wsPath, 'package.json'), JSON.stringify({ name: 'test-app', dependencies: {} }));

    const worktreeManager = new WorktreeManager();
    const checkpointManager = new CheckpointManager();
    const durableAttemptApi = WorkspaceManager.prototype;
    assert(
      typeof durableAttemptApi.claimTaskAttempt === 'function'
        && typeof durableAttemptApi.markTaskAttemptRunning === 'function'
        && typeof durableAttemptApi.heartbeatTaskAttempt === 'function'
        && typeof durableAttemptApi.finishTaskAttempt === 'function'
        && typeof durableAttemptApi.expireStaleTaskAttempts === 'function'
        && typeof durableAttemptApi.expireOrphanedTaskAttempts === 'function',
      'WorkspaceManager exposes the durable task-attempt lifecycle API',
    );

    const sqlite = new Database(':memory:');
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, git_initialized INTEGER NOT NULL DEFAULT 0, last_opened_at TEXT, last_team_template_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE missions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', team_template_id TEXT NOT NULL DEFAULT '', plan_id TEXT, execution_mode TEXT NOT NULL DEFAULT 'balanced', automation_policy TEXT, active_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, plan_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned', priority TEXT NOT NULL DEFAULT 'medium', assigned_agent_id TEXT, assigned_role TEXT, required_capabilities TEXT NOT NULL, depends_on TEXT NOT NULL, worktree_id TEXT, target_descriptor TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, agent_instance_id TEXT NOT NULL, attempt_number INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'running', worktree_path TEXT, runtime_session_id TEXT, route_adapter_id TEXT, route_provider TEXT, route_account_profile_id TEXT, route_model_catalog_id TEXT, route_runtime_model_id TEXT, route_reasoning_level TEXT, route_source TEXT, route_selection_mode TEXT, provider_session_id TEXT, heartbeat_at TEXT, lease_expires_at TEXT, retryable INTEGER NOT NULL DEFAULT 0, claimed_at TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, error TEXT, result_summary TEXT, review_pack TEXT);
      CREATE UNIQUE INDEX idx_task_attempts_task_number ON task_attempts(task_id, attempt_number);
      CREATE TABLE team_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', max_parallel_agents INTEGER, worker_pools TEXT, is_default INTEGER DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE team_roles (id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES team_templates(id), role TEXT NOT NULL, model_profile_id TEXT, account_profile_id TEXT, default_capabilities TEXT NOT NULL, access_level TEXT NOT NULL);
      CREATE TABLE execution_policies (id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, role TEXT NOT NULL, model_catalog_id TEXT, account_profile_id TEXT, reasoning_level TEXT, fallback_catalog_ids TEXT NOT NULL, selection_mode TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE conversation_turns (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, content TEXT NOT NULL, delivery TEXT NOT NULL, options TEXT, status TEXT NOT NULL DEFAULT 'queued', idempotency_key TEXT, request_hash TEXT, command_id TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
      CREATE TABLE agent_instances (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, role TEXT NOT NULL, model_profile_id TEXT DEFAULT '', account_profile_id TEXT DEFAULT '', runtime_adapter_id TEXT DEFAULT '', session_id TEXT, status TEXT DEFAULT 'idle', task_id TEXT, parent_agent_id TEXT, display_name TEXT, specialty TEXT, spawn_reason TEXT, status_message TEXT, progress INTEGER, workspace_mode TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL);
    `);
    const attemptManager = new WorkspaceManager(drizzle(sqlite, { schema }) as unknown as AtrisDatabase);
    const attemptWorkspace = await attemptManager.createWorkspace({ id: 'attempt-workspace', name: 'Attempt test', path: tmpDir });
    const attemptMission = await attemptManager.createMission({ id: 'attempt-mission', workspaceId: attemptWorkspace.id, title: 'Parallel research' });
    const attemptTasks = await Promise.all([0, 1, 2].map((index) => attemptManager.createTask({
      id: `attempt-task-${index}`,
      missionId: attemptMission.id,
      title: `Research ${index}`,
      assignedRole: 'researcher',
    })));
    const claimedAttempts = await Promise.all(attemptTasks.map((task, index) => attemptManager.claimTaskAttempt({
      taskId: task.id,
      missionId: attemptMission.id,
      agentInstanceId: `researcher-${index}`,
      leaseExpiresAt: '2026-08-30T01:05:00.000Z',
      now: '2026-08-30T01:00:00.000Z',
      route: { adapterId: 'codex', provider: 'openai', accountProfileId: 'profile-explicit', modelCatalogId: 'catalog-explicit', runtimeModelId: 'gpt-5', reasoningLevel: 'high', source: 'explicit', selectionMode: 'fixed' },
    })));
    assert(claimedAttempts.length === 3 && claimedAttempts.every((attempt) => attempt.attemptNumber === 1), 'parallel task attempts are claimed through a synchronous SQLite transaction');
    const retryAttempt = await attemptManager.claimTaskAttempt({
      taskId: attemptTasks[0].id,
      missionId: attemptMission.id,
      agentInstanceId: 'researcher-retry',
      leaseExpiresAt: '2026-08-30T01:10:00.000Z',
      now: '2026-08-30T01:05:00.000Z',
      route: { adapterId: 'claude_code', provider: 'anthropic', accountProfileId: 'profile-workspace', modelCatalogId: 'catalog-workspace', runtimeModelId: 'claude-sonnet', reasoningLevel: 'medium', source: 'workspace', selectionMode: 'prefer' },
    });
    assert(retryAttempt.attemptNumber === 2, 'task attempt numbering remains atomic across retries');
    assert(claimedAttempts[0].routeSource === 'explicit' && claimedAttempts[0].routeRuntimeModelId === 'gpt-5', 'explicit chat route is persisted on the claimed attempt');
    assert(retryAttempt.routeSource === 'workspace' && retryAttempt.routeAdapterId === 'claude_code', 'a retry receives a distinct policy snapshot in a new attempt');
    const routedTasks = await attemptManager.listTasks(attemptMission.id);
    assert(routedTasks[0].effectiveRoute?.adapterId === 'claude_code' && routedTasks[0].effectiveRoute?.runtimeModelId === 'claude-sonnet'
      && !('providerSessionId' in (routedTasks[0].effectiveRoute || {})), 'task read model exposes only the latest effective route snapshot without session secrets');
    sqlite.prepare("INSERT INTO team_templates (id, name, max_parallel_agents, worker_pools, created_at) VALUES (?, ?, ?, ?, ?)")
      .run('limited-team', 'Limited', 99, JSON.stringify([{ role: 'researcher', minInstances: -4, maxInstances: 2, maxParallel: 1 }]), new Date().toISOString());
    await attemptManager.updateMission(attemptMission.id, { teamTemplateId: 'limited-team' });
    const effectivePool = await attemptManager.resolveMissionWorkerPoolPolicy(attemptMission.id);
    assert(effectivePool.maxParallelAgents === 32 && effectivePool.pools.find((pool) => pool.role === 'researcher')?.maxParallel === 1,
      'template global and role overrides are resolved with invalid values capped');
    const fallbackPool = await attemptManager.resolveMissionWorkerPoolPolicy('missing-mission');
    assert(fallbackPool.maxParallelAgents === 4, 'missing and legacy templates use the safe Core worker-pool default');
    sqlite.prepare('UPDATE team_templates SET max_parallel_agents = 2 WHERE id = ?').run('limited-team');
    const reserve = (id: string, role: 'researcher' | 'builder' = 'researcher') => attemptManager.reserveAgentCapacity({
      id, missionId: attemptMission.id, role, displayName: id, spawnReason: 'capacity test', workspaceMode: 'read_only', createdAt: new Date().toISOString(),
    });
    const concurrentReservations = await Promise.allSettled([reserve('pool-researcher-1'), reserve('pool-researcher-2')]);
    assert(concurrentReservations.filter((result) => result.status === 'fulfilled').length === 1,
      'concurrent dynamic spawns atomically enforce the effective role cap');
    await reserve('pool-builder-1', 'builder');
    let globalCapBlocked = false;
    try { await reserve('pool-builder-2', 'builder'); } catch (error: any) { globalCapBlocked = String(error.message).includes('parallel-agent limit reached (2)'); }
    assert(globalCapBlocked, 'dynamic children and existing durable workers share the mission-global cap');
    const restartedManager = new WorkspaceManager(drizzle(sqlite, { schema }) as unknown as AtrisDatabase);
    let restartBlocked = false;
    try { await restartedManager.reserveAgentCapacity({ id: 'restart-reader', missionId: attemptMission.id, role: 'builder', displayName: 'Restart', spawnReason: 'restart test', workspaceMode: 'isolated_worktree', createdAt: new Date().toISOString() }); }
    catch (error: any) { restartBlocked = String(error.message).includes('parallel-agent limit reached (2)'); }
    assert(restartBlocked, 'capacity read model survives WorkspaceManager restart');
    sqlite.prepare("UPDATE agent_instances SET status = 'completed', completed_at = ? WHERE id = 'pool-researcher-1'").run(new Date().toISOString());
    await restartedManager.reserveAgentCapacity({ id: 'released-slot', missionId: attemptMission.id, role: 'researcher', displayName: 'Released slot', spawnReason: 'terminal release test', workspaceMode: 'read_only', createdAt: new Date().toISOString() });
    assert((sqlite.prepare("SELECT COUNT(*) AS count FROM agent_instances WHERE mission_id = ? AND status IN ('idle', 'running', 'waiting')").get(attemptMission.id) as { count: number }).count === 2,
      'terminal agents release durable global and role capacity');
    await attemptManager.markTaskAttemptRunning(retryAttempt.id, 'runtime-session', '2026-08-30T01:05:01.000Z', '2026-08-30T01:10:01.000Z', 'provider-session');
    const persistedAttempts = await attemptManager.listTaskAttempts(attemptTasks[0].id);
    assert(persistedAttempts[0].routeAdapterId === 'codex' && persistedAttempts[1].providerSessionId === 'provider-session', 'attempt reads retain stable route snapshots and attach the provider session at start');
    sqlite.prepare('INSERT INTO conversation_turns (id, mission_id, content, delivery, options, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('supervisor-turn', attemptMission.id, 'Continue', 'queue', JSON.stringify({ clientOption: true }), 'completed', '2026-08-30T01:20:00.000Z');
    await attemptManager.saveSupervisorSessionMetadata('supervisor-turn', {
      providerSessionId: 'opencode-provider-session', resumeCapability: 'restart',
      route: { adapterId: 'opencode', provider: 'opencode', accountProfileId: 'profile-explicit', modelCatalogId: 'catalog-explicit', runtimeModelId: 'provider/model', reasoningLevel: 'high', source: 'explicit', selectionMode: 'fixed' },
      updatedAt: '2026-08-30T01:20:01.000Z',
    });
    const supervisorMetadata = await attemptManager.getLatestSupervisorSessionMetadata(attemptMission.id);
    const persistedTurn = sqlite.prepare('SELECT options FROM conversation_turns WHERE id = ?').get('supervisor-turn') as { options: string };
    const persistedOptions = JSON.parse(persistedTurn.options);
    assert(supervisorMetadata?.providerSessionId === 'opencode-provider-session' && supervisorMetadata.route.modelCatalogId === 'catalog-explicit', 'supervisor provider session capability and explicit route survive manager restart reads');
    assert(persistedOptions.clientOption === true && !JSON.stringify(persistedOptions).includes('password'), 'supervisor metadata preserves existing turn options and contains no server credentials');
    sqlite.close();

    assert(isValidGitCommitSha('0123456789abcdef0123456789abcdef01234567'), '40-character Git commit SHA is accepted');
    assert(!isValidGitCommitSha('0123456789abcdef0123456789abcdef0123456'), 'Short Git commit ref is rejected');
    assert(!isValidGitCommitSha('0123456789abcdef0123456789abcdef0123456; echo injected'), 'Shell metacharacters in Git ref are rejected');
    assert(isSafeCheckpointId(crypto.randomUUID()), 'Generated UUID is accepted as a checkpoint identifier');
    assert(!isSafeCheckpointId('../checkpoint'), 'Traversal checkpoint identifier is rejected');

    const invalidGitDir = path.join(tmpDir, 'invalid-git-dir');
    fs.mkdirSync(path.join(invalidGitDir, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(invalidGitDir, '.git', 'info', 'exclude'), '');
    assert(!(await worktreeManager.isGitRepository(invalidGitDir)), 'Invalid .git directory is not treated as a repository');

    const invalidGitFile = path.join(tmpDir, 'invalid-git-file');
    fs.mkdirSync(invalidGitFile, { recursive: true });
    fs.writeFileSync(path.join(invalidGitFile, '.git'), 'gitdir: missing-worktree-metadata');
    assert(!(await worktreeManager.isGitRepository(invalidGitFile)), 'Invalid .git file is not treated as a repository');

    const realRepo = path.join(tmpDir, 'real-repo');
    fs.mkdirSync(realRepo, { recursive: true });
    runGit(realRepo, ['init', '--quiet']);
    assert(await worktreeManager.isGitRepository(realRepo), 'Initialized Git repository is detected');

    const nestedParent = path.join(tmpDir, 'nested-parent');
    const nestedRepo = path.join(nestedParent, 'nested-repo');
    fs.mkdirSync(path.join(nestedParent, '.git', 'info'), { recursive: true });
    fs.mkdirSync(nestedRepo, { recursive: true });
    runGit(nestedRepo, ['init', '--quiet']);
    assert(!(await worktreeManager.isGitRepository(nestedParent)), 'Invalid parent metadata does not mask a non-Git workspace');
    assert(await worktreeManager.isGitRepository(nestedRepo), 'Nested initialized repository is detected at its own root');

    fs.writeFileSync(path.join(realRepo, 'README.md'), 'linked worktree probe');
    commitAll(realRepo, 'initial');
    const linkedWorktree = path.join(tmpDir, 'linked-worktree');
    runGit(realRepo, ['worktree', 'add', '--detach', linkedWorktree, 'HEAD']);
    assert(fs.lstatSync(path.join(linkedWorktree, '.git')).isFile(), 'Linked worktree uses a .git file');
    assert(await worktreeManager.isGitRepository(linkedWorktree), 'Linked worktree is detected by Git probing');

    const mirrorSource = path.join(tmpDir, 'mirror-source');
    const mirrorTarget = path.join(tmpDir, 'mirror-target');
    fs.mkdirSync(path.join(mirrorSource, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(mirrorSource, '.git', 'info', 'exclude'), '');
    fs.writeFileSync(path.join(mirrorSource, 'source.ts'), 'export const source = true;');
    for (const dirName of ['target', '.cargo-target', '.cargo-target-cache']) {
      fs.mkdirSync(path.join(mirrorSource, dirName, 'generated'), { recursive: true });
      fs.writeFileSync(path.join(mirrorSource, dirName, 'generated', 'artifact.bin'), 'generated');
    }
    fs.mkdirSync(path.join(mirrorSource, '.cargo-targeted'), { recursive: true });
    fs.writeFileSync(path.join(mirrorSource, '.cargo-targeted', 'source.txt'), 'user source');
    for (const dirName of ['local-release', 'scratch']) {
      fs.mkdirSync(path.join(mirrorSource, dirName), { recursive: true });
      fs.writeFileSync(path.join(mirrorSource, dirName, 'notes.txt'), 'user data');
    }
    const mirrorPath = await worktreeManager.createWorktree(
      mirrorSource,
      'atris/mission-invalid-parent/task-mirror',
      mirrorTarget,
    );
    assert(fs.existsSync(path.join(mirrorPath, 'source.ts')), 'Invalid-Git parent falls back to a source mirror');
    assert(!fs.existsSync(path.join(mirrorPath, '.git')), 'Mirror excludes Git metadata');
    assert(!fs.existsSync(path.join(mirrorPath, 'target')), 'Mirror excludes Rust target output');
    assert(!fs.existsSync(path.join(mirrorPath, '.cargo-target')), 'Mirror excludes .cargo-target output');
    assert(!fs.existsSync(path.join(mirrorPath, '.cargo-target-cache')), 'Mirror excludes .cargo-target-* output');
    assert(fs.existsSync(path.join(mirrorPath, '.cargo-targeted', 'source.txt')), 'Mirror preserves similarly named source folders');
    assert(fs.existsSync(path.join(mirrorPath, 'local-release', 'notes.txt')), 'Mirror preserves local-release user files');
    assert(fs.existsSync(path.join(mirrorPath, 'scratch', 'notes.txt')), 'Mirror preserves scratch user files');

    const mirrorCheckpointId = await checkpointManager.createCheckpoint(mirrorSource, 'mirror-safety');
    const mirrorSnapshotPath = path.join(mirrorSource, '.atris-checkpoints', mirrorCheckpointId);
    assert(fs.existsSync(path.join(mirrorSnapshotPath, 'source.ts')), 'Checkpoint snapshot preserves source files');
    assert(!fs.existsSync(path.join(mirrorSnapshotPath, 'target')), 'Checkpoint snapshot excludes Rust target output');
    assert(!fs.existsSync(path.join(mirrorSnapshotPath, '.cargo-target-cache')), 'Checkpoint snapshot excludes .cargo-target-* output');
    assert(fs.existsSync(path.join(mirrorSnapshotPath, '.cargo-targeted', 'source.txt')), 'Checkpoint snapshot preserves similarly named source folders');

    const checkpointIsGitRepo = (checkpointManager as unknown as {
      isGitRepo(workspacePath: string): Promise<boolean>;
    }).isGitRepo.bind(checkpointManager);
    assert(!(await checkpointIsGitRepo(invalidGitDir)), 'Checkpoint manager rejects invalid .git metadata');
    assert(await checkpointIsGitRepo(realRepo), 'Checkpoint manager accepts a real Git repository');

    const wtPath = await worktreeManager.createWorktree(wsPath, 'atris/mission-1/task-1');
    assert(fs.existsSync(wtPath), 'Worktree directory created for non-git workspace');
    assert(fs.existsSync(path.join(wtPath, 'index.ts')), 'Files mirrored to worktree');

    fs.writeFileSync(path.join(wtPath, 'index.ts'), 'console.log("hello updated world");');
    fs.writeFileSync(path.join(wtPath, 'newfile.ts'), 'export const x = 42;');

    const changedFiles = await worktreeManager.getChangedFiles(wtPath);
    assert(changedFiles.length === 2, 'Detects 2 changed files in non-git worktree');
    assert(changedFiles.some((f) => f.path === 'index.ts' && f.status === 'modified'), 'Detects modified index.ts');
    assert(changedFiles.some((f) => f.path === 'newfile.ts' && f.status === 'added'), 'Detects added newfile.ts');

    const diffText = await worktreeManager.getDiff(wtPath);
    assert(diffText.includes('+export const x = 42;'), 'getDiff includes added line');

    const worktreeRoot = await worktreeManager.inspectEntry(wtPath);
    assert(worktreeRoot.kind === 'directory' && worktreeRoot.entries.some((entry) => entry.path === 'index.ts'), 'read-only worktree inspector lists relative entries');
    const worktreeFile = await worktreeManager.inspectEntry(wtPath, 'index.ts');
    assert(worktreeFile.kind === 'file' && Boolean(worktreeFile.content?.includes('updated world')), 'read-only worktree inspector previews bounded text content');
    let previewTraversalRejected = false;
    try { await worktreeManager.inspectEntry(wtPath, '../index.ts'); } catch { previewTraversalRejected = true; }
    assert(previewTraversalRejected, 'read-only worktree inspector rejects traversal');
    fs.writeFileSync(path.join(wtPath, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    const binaryPreview = await worktreeManager.inspectEntry(wtPath, 'binary.bin');
    assert(binaryPreview.kind === 'file' && binaryPreview.previewUnavailable === 'binary' && !binaryPreview.content, 'read-only worktree inspector does not expose binary content');

    const nestedSourceDir = path.join(wsPath, 'src');
    fs.mkdirSync(nestedSourceDir, { recursive: true });
    fs.writeFileSync(path.join(nestedSourceDir, 'stable.ts'), 'export const stable = true;');
    const chkId = await checkpointManager.createCheckpoint(wsPath, 'pre-feature');
    assert(
      typeof chkId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(chkId),
      'createCheckpoint returns a UUID checkpointId',
    );

    fs.writeFileSync(path.join(wsPath, 'index.ts'), 'MUTATED CONTENT');
    fs.writeFileSync(path.join(wsPath, 'extra-after-checkpoint.ts'), 'must be removed');
    fs.rmSync(nestedSourceDir, { recursive: true, force: true });
    assert(fs.readFileSync(path.join(wsPath, 'index.ts'), 'utf-8') === 'MUTATED CONTENT', 'Workspace content mutated');

    await checkpointManager.restoreCheckpoint(chkId, wsPath);
    assert(
      fs.readFileSync(path.join(wsPath, 'index.ts'), 'utf-8') === 'console.log("hello world");',
      'restoreCheckpoint restores original workspace content'
    );
    assert(!fs.existsSync(path.join(wsPath, 'extra-after-checkpoint.ts')), 'Exact restore removes files created after the checkpoint');
    assert(fs.existsSync(path.join(wsPath, 'src', 'stable.ts')), 'Exact restore recreates source files deleted after the checkpoint');

    let traversalRestoreError = '';
    try {
      await checkpointManager.restoreCheckpoint('../../outside', wsPath);
    } catch (error) {
      traversalRestoreError = error instanceof Error ? error.message : String(error);
    }
    assert(traversalRestoreError.includes('valid AtrisAgent checkpoint identifier'), 'Traversal checkpoint IDs fail before filesystem resolution');

    const validGitRef = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: realRepo,
      windowsHide: true,
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(path.join(realRepo, 'README.md'), 'MUTATED GIT CONTENT');
    const validGitCheckpointId = crypto.randomUUID();
    const validGitSnapshotPath = path.join(realRepo, '.atris-checkpoints', validGitCheckpointId);
    fs.mkdirSync(validGitSnapshotPath, { recursive: true });
    fs.writeFileSync(path.join(validGitSnapshotPath, 'README.md'), 'linked worktree probe');
    const validCheckpointDb = {
      select: () => ({
        from: () => ({
          where: async () => [{
            id: validGitCheckpointId,
            workspaceId: 'w1',
            missionId: 'm1',
            snapshotPath: validGitSnapshotPath,
            gitRef: validGitRef,
          }],
        }),
      }),
    } as unknown as NonNullable<Parameters<typeof checkpointManager.restoreCheckpoint>[2]>['db'];
    await checkpointManager.restoreCheckpoint(validGitCheckpointId, realRepo, {
      db: validCheckpointDb,
      expectedWorkspaceId: 'w1',
      expectedMissionId: 'm1',
    });
    assert(
      fs.readFileSync(path.join(realRepo, 'README.md'), 'utf-8') === 'linked worktree probe',
      'Valid Git ref restores the committed workspace state with argument-based Git execution',
    );

    const maliciousCheckpointId = crypto.randomUUID();
    const restoreSnapshotPath = path.join(realRepo, '.atris-checkpoints', maliciousCheckpointId);
    fs.mkdirSync(restoreSnapshotPath, { recursive: true });
    fs.writeFileSync(path.join(restoreSnapshotPath, 'restored.txt'), 'snapshot fallback');
    const injectionMarkerPath = path.join(tmpDir, 'checkpoint-ref-injection-marker.txt');
    const maliciousCheckpointDb = {
      select: () => ({
        from: () => ({
          where: async () => [{
            id: maliciousCheckpointId,
            workspaceId: 'w1',
            missionId: 'm1',
            snapshotPath: restoreSnapshotPath,
            gitRef: `0123456789abcdef0123456789abcdef0123456 & echo injected > "${injectionMarkerPath}"`,
          }],
        }),
      }),
    } as unknown as NonNullable<Parameters<typeof checkpointManager.restoreCheckpoint>[2]>['db'];
    await checkpointManager.restoreCheckpoint(maliciousCheckpointId, realRepo, {
      db: maliciousCheckpointDb,
      expectedWorkspaceId: 'w1',
      expectedMissionId: 'm1',
    });
    assert(
      fs.readFileSync(path.join(realRepo, 'restored.txt'), 'utf-8') === 'snapshot fallback',
      'Invalid Git ref falls back to a contained checkpoint snapshot without invoking a shell',
    );
    assert(!fs.existsSync(injectionMarkerPath), 'Malicious Git ref cannot execute an injected shell command');

    const escapedCheckpointId = crypto.randomUUID();
    const escapedSnapshotPath = path.join(tmpDir, escapedCheckpointId);
    fs.mkdirSync(escapedSnapshotPath, { recursive: true });
    fs.writeFileSync(path.join(escapedSnapshotPath, 'escaped.txt'), 'must not restore');
    const escapedCheckpointDb = {
      select: () => ({
        from: () => ({
          where: async () => [{
            id: escapedCheckpointId,
            workspaceId: 'w1',
            missionId: 'm1',
            snapshotPath: escapedSnapshotPath,
            gitRef: null,
          }],
        }),
      }),
    } as unknown as NonNullable<Parameters<typeof checkpointManager.restoreCheckpoint>[2]>['db'];
    let escapedSnapshotError = '';
    try {
      await checkpointManager.restoreCheckpoint(escapedCheckpointId, realRepo, {
        db: escapedCheckpointDb,
        expectedWorkspaceId: 'w1',
        expectedMissionId: 'm1',
      });
    } catch (error) {
      escapedSnapshotError = error instanceof Error ? error.message : String(error);
    }
    assert(escapedSnapshotError.includes('escapes the expected workspace boundary'), 'Persisted snapshot paths outside checkpoint storage are rejected');
    assert(!fs.existsSync(path.join(realRepo, 'escaped.txt')), 'Escaped snapshot content is never copied into the workspace');

    const ownershipCheckpointId = crypto.randomUUID();
    const ownershipDb = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    } as unknown as NonNullable<Parameters<typeof checkpointManager.restoreCheckpoint>[2]>['db'];
    let ownershipError = '';
    try {
      await checkpointManager.restoreCheckpoint(ownershipCheckpointId, realRepo, {
        db: ownershipDb,
        expectedWorkspaceId: 'other-workspace',
        expectedMissionId: 'other-mission',
      });
    } catch (error) {
      ownershipError = error instanceof Error ? error.message : String(error);
    }
    assert(ownershipError.includes('not found for the requested workspace and mission'), 'Cross-workspace or cross-mission checkpoint lookup fails closed');

    const mergeResult = await worktreeManager.merge(wtPath, 'main', wsPath);
    assert(mergeResult.success === true, 'Non-git merge succeeds');
    assert(fs.existsSync(path.join(wsPath, 'newfile.ts')), 'Merged newfile.ts copied to main workspace');
    await worktreeManager.removeWorktree(wtPath, true, wsPath);
    assert(!fs.existsSync(wtPath), 'Worktree cleaned up successfully');

    // Parent-workspace regression: this mirrors the real AtrisTracker workflow.
    const projectContainer = path.join(tmpDir, 'project-container');
    const atrisTracker = path.join(projectContainer, 'AtrisTracker');
    const siblingProject = path.join(projectContainer, 'OtherProject');
    fs.mkdirSync(atrisTracker, { recursive: true });
    fs.mkdirSync(siblingProject, { recursive: true });
    runGit(atrisTracker, ['init', '--quiet']);
    runGit(siblingProject, ['init', '--quiet']);
    fs.writeFileSync(path.join(atrisTracker, 'tracker.ts'), 'export const usage = "old";\n');
    fs.writeFileSync(path.join(siblingProject, 'sibling.ts'), 'export const untouched = true;\n');
    commitAll(atrisTracker, 'AtrisTracker baseline');
    commitAll(siblingProject, 'Sibling baseline');

    const resolvedProject = await worktreeManager.resolveIsolationBase(
      projectContainer,
      'Analyze AtrisTracker usage collection and implement the fix',
    );
    assert(resolvedProject.kind === 'nested-git', 'Parent workspace resolves a nested Git project instead of mirroring the whole container');
    assert(path.resolve(resolvedProject.path) === path.resolve(atrisTracker), 'Task project hint deterministically selects AtrisTracker');

    let ambiguousError = '';
    try {
      await worktreeManager.resolveIsolationBase(projectContainer, 'Implement a generic feature');
    } catch (error) {
      ambiguousError = error instanceof Error ? error.message : String(error);
    }
    assert(ambiguousError.includes('multiple Git projects'), 'Multiple child repositories fail safely when the task does not identify a project');

    const eightRepoContainer = path.join(tmpDir, 'eight-repo-container');
    fs.mkdirSync(eightRepoContainer, { recursive: true });
    for (let index = 1; index <= 8; index += 1) {
      const repo = path.join(eightRepoContainer, `Sibling${index}`);
      fs.mkdirSync(repo);
      runGit(repo, ['init', '--quiet']);
      fs.writeFileSync(path.join(repo, 'untouched.txt'), `sibling-${index}`);
    }
    const newTarget = await worktreeManager.resolveBuilderTarget(
      eightRepoContainer,
      { kind: 'new_sibling_project', projectName: 'AtrisTask' },
      'Create AtrisTask',
    );
    assert(newTarget.kind === 'new-sibling' && newTarget.targetName === 'AtrisTask', 'Absent AtrisTask resolves as a new sibling without selecting one of eight repositories');
    const newStaging = path.join(eightRepoContainer, '.atris-worktrees', 'mission-new', 'task-new');
    await worktreeManager.createEmptyManagedStaging(newStaging, newTarget.canonicalContainer!);
    assert((await fs.promises.readdir(newStaging)).join(',') === '.atris-baseline', 'New sibling Builder staging starts with only an empty baseline');
    assert(Array.from({ length: 8 }, (_, index) => fs.readFileSync(path.join(eightRepoContainer, `Sibling${index + 1}`, 'untouched.txt'), 'utf8')).every((value, index) => value === `sibling-${index + 1}`), 'New sibling staging does not copy or modify existing repositories');

    for (const unsafeName of ['.', '..', '../escape', 'nested/project', 'nested\\project', 'C:\\escape', '\\\\server\\share', 'name:stream', 'NUL', 'con.txt', 'trail.', 'trail ', '\0bad']) {
      let rejected = false;
      try { await worktreeManager.validateNewSiblingTarget(eightRepoContainer, unsafeName); } catch { rejected = true; }
      assert(rejected, `Unsafe new sibling target is rejected: ${JSON.stringify(unsafeName)}`);
    }
    fs.mkdirSync(path.join(eightRepoContainer, 'Collision'));
    let collisionRejected = false;
    try { await worktreeManager.validateNewSiblingTarget(eightRepoContainer, 'collision'); } catch { collisionRejected = true; }
    assert(collisionRejected, 'New sibling target rejects case-insensitive collisions with existing entries');

    fs.writeFileSync(path.join(newStaging, 'package.json'), JSON.stringify({ name: 'atris-task' }));
    fs.mkdirSync(path.join(newStaging, 'src'));
    fs.writeFileSync(path.join(newStaging, 'src', 'index.ts'), 'export const ready = true;\n');
    const newSiblingChanges = await worktreeManager.getChangedFiles(newStaging);
    assert(newSiblingChanges.length === 2 && newSiblingChanges.every((file) => file.status === 'added'), 'Every new sibling project file is reported as added');
    const newSiblingDiff = await worktreeManager.getDiff(newStaging);
    assert(newSiblingDiff.includes('+++ b/package.json') && newSiblingDiff.includes('+++ b/src/index.ts'), 'New sibling diff includes every added project file');
    assert(!newSiblingChanges.some((file) => file.path.includes('.atris-')) && !newSiblingDiff.includes('.atris-baseline'), 'New sibling review data excludes Atris metadata');
    const firstSiblingApply = await worktreeManager.applyNewSibling(newStaging, newTarget.canonicalContainer!, 'AtrisTask', 'operation-new');
    assert(firstSiblingApply.success && fs.existsSync(path.join(eightRepoContainer, 'AtrisTask', 'package.json')), 'New sibling apply safely publishes staged content into AtrisTask');
    assert(fs.existsSync(path.join(eightRepoContainer, 'AtrisTask', '.atris-operation.json')), 'Atomic apply moves its durable ownership marker with the project');
    const recoveredRetry = await worktreeManager.applyNewSibling(newStaging, newTarget.canonicalContainer!, 'AtrisTask', 'operation-new');
    assert(recoveredRetry.success && recoveredRetry.output.includes('Recovered'), 'Retry reconciles a matching marker after rename and before database ownership');
    const foreignRetry = await worktreeManager.applyNewSibling(newStaging, newTarget.canonicalContainer!, 'AtrisTask', 'other-operation');
    assert(!foreignRetry.success && foreignRetry.output.includes('not owned'), 'Atomic apply never overwrites an existing foreign destination');
    await worktreeManager.finalizeNewSiblingApply(newTarget.canonicalContainer!, 'AtrisTask', 'operation-new');
    assert(!fs.existsSync(path.join(eightRepoContainer, 'AtrisTask', '.atris-operation.json')) && !fs.existsSync(path.join(eightRepoContainer, 'AtrisTask', '.atris-baseline')), 'Applied project contains no Atris baseline or operation marker after ownership is durable');
    const ownedRetry = await worktreeManager.applyNewSibling(newStaging, newTarget.canonicalContainer!, 'AtrisTask', 'operation-new', 'operation-new');
    assert(ownedRetry.success && ownedRetry.output.includes('already applied'), 'Persisted Atris ownership remains idempotent after marker cleanup');

    const nonGitContainer = path.join(tmpDir, 'non-git-child-container');
    const nonGitChild = path.join(nonGitContainer, 'PlainProject');
    const nestedChildRepo = path.join(nonGitChild, 'vendor', 'NestedRepo');
    fs.mkdirSync(nestedChildRepo, { recursive: true });
    fs.writeFileSync(path.join(nonGitChild, 'root.txt'), 'before\n');
    fs.writeFileSync(path.join(nonGitContainer, 'untouched.txt'), 'container\n');
    runGit(nestedChildRepo, ['init', '--quiet']);
    fs.writeFileSync(path.join(nestedChildRepo, 'nested.txt'), 'nested\n');
    commitAll(nestedChildRepo, 'Nested baseline');
    const explicitNonGit = await worktreeManager.resolveBuilderTarget(
      nonGitContainer,
      { kind: 'existing_project', projectName: 'PlainProject' },
    );
    assert(explicitNonGit.kind === 'mirror' && path.resolve(explicitNonGit.targetPath!) === path.resolve(nonGitChild), 'Explicit non-Git child persists its canonical apply target');
    const nonGitWorktree = await worktreeManager.createWorktree(
      explicitNonGit.path,
      'atris/non-git-child',
      undefined,
      'HEAD',
      '',
      explicitNonGit,
    );
    fs.writeFileSync(path.join(nonGitWorktree, 'root.txt'), 'after\n');
    const nonGitMerge = await worktreeManager.merge(nonGitWorktree, undefined, explicitNonGit.targetPath);
    assert(nonGitMerge.success && fs.readFileSync(path.join(nonGitChild, 'root.txt'), 'utf8') === 'after\n', 'Explicit non-Git child applies back to the selected child');
    assert(fs.readFileSync(path.join(nonGitContainer, 'untouched.txt'), 'utf8') === 'container\n', 'Explicit non-Git child apply leaves the parent container untouched');

    const nestedTaskWorktree = await worktreeManager.createWorktree(
      projectContainer,
      'atris/mission-parent/task-builder',
      undefined,
      'HEAD',
      'Implement the AtrisTracker usage fix',
    );
    assert(await worktreeManager.isGitRepository(nestedTaskWorktree), 'Builder receives a linked Git worktree for the selected nested project');
    assert(!fs.existsSync(path.join(projectContainer, '.atris-baseline')), 'Parent project container is never copied into a fallback baseline');

    fs.writeFileSync(path.join(nestedTaskWorktree, 'tracker.ts'), 'export const usage = "fixed";\n');
    const mergeBase = await worktreeManager.resolveMergeBasePath(nestedTaskWorktree, projectContainer);
    assert(path.resolve(mergeBase) === path.resolve(atrisTracker), 'Nested Builder worktree resolves its actual source repository for apply');

    const nestedMerge = await worktreeManager.merge(nestedTaskWorktree, undefined, projectContainer);
    assert(nestedMerge.success, 'Nested Builder result merges back to the owning project');
    assert(fs.readFileSync(path.join(atrisTracker, 'tracker.ts'), 'utf8').includes('fixed'), 'AtrisTracker receives the Builder change');
    assert(fs.readFileSync(path.join(siblingProject, 'sibling.ts'), 'utf8').includes('untouched'), 'Sibling project remains untouched by Builder apply');

    // An interrupted request must be safe to retry after the owning Git merge
    // committed but before the approval outbox was finalized.
    const operationRepo = path.join(tmpDir, 'operation-repo');
    fs.mkdirSync(operationRepo, { recursive: true });
    runGit(operationRepo, ['init', '--quiet']);
    fs.writeFileSync(path.join(operationRepo, 'operation.ts'), 'export const applied = false;\n');
    commitAll(operationRepo, 'Operation baseline');
    const operationWorktree = await worktreeManager.createWorktree(
      operationRepo,
      'atris/mission-operation/task-merge',
    );
    fs.writeFileSync(path.join(operationWorktree, 'operation.ts'), 'export const applied = true;\n');
    const operationKey = 'approval:operation-retry:1:task:merge';
    const firstOperationMerge = await worktreeManager.merge(
      operationWorktree,
      undefined,
      operationRepo,
      { idempotencyKey: operationKey },
    );
    const firstOperationHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: operationRepo,
      windowsHide: true,
      encoding: 'utf-8',
    }).trim();
    assert(firstOperationMerge.success, 'Operation-aware Git merge succeeds');
    assert(execFileSync('git', ['log', '-1', '--format=%B'], {
      cwd: operationRepo,
      windowsHide: true,
      encoding: 'utf-8',
    }).includes(`AtrisAgent-Operation: ${operationKey}`), 'Git merge commit records the operation idempotency marker');

    await worktreeManager.removeWorktree(operationWorktree, true, operationRepo);
    const secondOperationMerge = await worktreeManager.merge(
      operationWorktree,
      undefined,
      operationRepo,
      { idempotencyKey: operationKey },
    );
    const secondOperationHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: operationRepo,
      windowsHide: true,
      encoding: 'utf-8',
    }).trim();
    assert(secondOperationMerge.success && secondOperationMerge.output.includes('already applied'), 'Retry detects an already-applied Git operation');
    assert(firstOperationHead === secondOperationHead, 'Idempotent merge retry does not create a second merge commit');
    assert(!fs.existsSync(operationWorktree), 'Operation-aware worktree is cleaned up successfully');

    await worktreeManager.removeWorktree(nestedTaskWorktree, true, projectContainer);
    assert(!fs.existsSync(nestedTaskWorktree), 'Nested linked worktree is cleaned up from its owning repository');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nTest Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});

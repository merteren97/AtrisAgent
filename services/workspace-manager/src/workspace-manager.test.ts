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
      CREATE TABLE tasks (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, plan_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned', priority TEXT NOT NULL DEFAULT 'medium', assigned_agent_id TEXT, assigned_role TEXT, required_capabilities TEXT NOT NULL, depends_on TEXT NOT NULL, worktree_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
      CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE, agent_instance_id TEXT NOT NULL, attempt_number INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'running', worktree_path TEXT, runtime_session_id TEXT, heartbeat_at TEXT, lease_expires_at TEXT, retryable INTEGER NOT NULL DEFAULT 0, claimed_at TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, error TEXT, result_summary TEXT, review_pack TEXT);
      CREATE UNIQUE INDEX idx_task_attempts_task_number ON task_attempts(task_id, attempt_number);
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
    })));
    assert(claimedAttempts.length === 3 && claimedAttempts.every((attempt) => attempt.attemptNumber === 1), 'parallel task attempts are claimed through a synchronous SQLite transaction');
    const retryAttempt = await attemptManager.claimTaskAttempt({
      taskId: attemptTasks[0].id,
      missionId: attemptMission.id,
      agentInstanceId: 'researcher-retry',
      leaseExpiresAt: '2026-08-30T01:10:00.000Z',
      now: '2026-08-30T01:05:00.000Z',
    });
    assert(retryAttempt.attemptNumber === 2, 'task attempt numbering remains atomic across retries');
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

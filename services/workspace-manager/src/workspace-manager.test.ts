import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { WorktreeManager } from './worktree-manager';
import { CheckpointManager, isValidGitCommitSha } from './checkpoint-manager';

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
      runGit(cwd, ['-c', 'user.name=AtrisAgent Test', '-c', 'user.email=atrisagent-test@example.invalid', 'add', '-A']);
      runGit(cwd, ['-c', 'user.name=AtrisAgent Test', '-c', 'user.email=atrisagent-test@example.invalid', 'commit', '--quiet', '-m', message]);
    };

    const wsPath = path.join(tmpDir, 'test-app');
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'index.ts'), 'console.log("hello world");');
    fs.writeFileSync(path.join(wsPath, 'package.json'), JSON.stringify({ name: 'test-app', dependencies: {} }));

    const worktreeManager = new WorktreeManager();
    const checkpointManager = new CheckpointManager();

    assert(isValidGitCommitSha('0123456789abcdef0123456789abcdef01234567'), '40-character Git commit SHA is accepted');
    assert(!isValidGitCommitSha('0123456789abcdef0123456789abcdef0123456'), 'Short Git commit ref is rejected');
    assert(!isValidGitCommitSha('0123456789abcdef0123456789abcdef0123456; echo injected'), 'Shell metacharacters in Git ref are rejected');

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
    runGit(realRepo, ['-c', 'user.name=AtrisAgent Test', '-c', 'user.email=atrisagent-test@example.invalid', 'add', 'README.md']);
    runGit(realRepo, ['-c', 'user.name=AtrisAgent Test', '-c', 'user.email=atrisagent-test@example.invalid', 'commit', '--quiet', '-m', 'initial']);
    const linkedWorktree = path.join(tmpDir, 'linked-worktree');
    runGit(realRepo, ['worktree', 'add', '--detach', linkedWorktree, 'HEAD']);
    assert(fs.lstatSync(path.join(linkedWorktree, '.git')).isFile(), 'Linked worktree uses a .git file');
    assert(await worktreeManager.isGitRepository(linkedWorktree), 'Linked worktree is detected by Git probing');

    // A workspace can be a project container rather than a repository itself.
    // Builder isolation must select the task's nested repository instead of
    // synchronously mirroring every sibling project in the parent folder.
    const projectContainer = path.join(tmpDir, 'project-container');
    const atrisTrackerRepo = path.join(projectContainer, 'AtrisTracker');
    const siblingRepo = path.join(projectContainer, 'OtherProject');
    for (const repo of [atrisTrackerRepo, siblingRepo]) {
      fs.mkdirSync(repo, { recursive: true });
      runGit(repo, ['init', '--quiet']);
    }
    fs.writeFileSync(path.join(atrisTrackerRepo, 'tracker.ts'), 'export const tracker = 1;\n');
    fs.writeFileSync(path.join(siblingRepo, 'sibling.ts'), 'export const sibling = 1;\n');
    commitAll(atrisTrackerRepo, 'tracker initial');
    commitAll(siblingRepo, 'sibling initial');

    const isolation = await worktreeManager.resolveIsolationBase(
      projectContainer,
      'Task 2: Build & Implement AtrisTracker usage collection',
    );
    assert(isolation.kind === 'nested-git', 'Project-container workspace resolves a nested Git repository');
    assert(path.resolve(isolation.path) === path.resolve(atrisTrackerRepo), 'Task hint selects AtrisTracker instead of a sibling repository');

    const nestedBuilderPath = path.join(projectContainer, '.atris-worktrees', 'mission-nested', 'task-builder');
    const nestedBuilderWorktree = await worktreeManager.createWorktree(
      projectContainer,
      'atris/mission-nested/task-builder',
      nestedBuilderPath,
      'HEAD',
      'Build and verify AtrisTracker usage collection',
    );
    assert(await worktreeManager.isGitRepository(nestedBuilderWorktree), 'Builder receives a linked Git worktree for the nested project');
    assert(fs.existsSync(path.join(nestedBuilderWorktree, 'tracker.ts')), 'Nested Builder worktree contains AtrisTracker source');
    assert(!fs.existsSync(path.join(nestedBuilderWorktree, 'sibling.ts')), 'Nested Builder worktree does not mirror sibling projects');

    fs.writeFileSync(path.join(nestedBuilderWorktree, 'tracker.ts'), 'export const tracker = 2;\n');
    const nestedMerge = await worktreeManager.merge(nestedBuilderWorktree, undefined, projectContainer);
    assert(nestedMerge.success, 'Nested Builder worktree merges into its owning repository');
    assert(fs.readFileSync(path.join(atrisTrackerRepo, 'tracker.ts'), 'utf8').includes('tracker = 2'), 'Nested merge updates AtrisTracker source');
    assert(fs.readFileSync(path.join(siblingRepo, 'sibling.ts'), 'utf8').includes('sibling = 1'), 'Nested merge leaves sibling repository untouched');
    await worktreeManager.removeWorktree(nestedBuilderWorktree, true, projectContainer);
    assert(!fs.existsSync(nestedBuilderWorktree), 'Nested Builder worktree is cleaned up through its owning repository');

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

    const chkId = await checkpointManager.createCheckpoint(wsPath, 'pre-feature');
    assert(
      typeof chkId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(chkId),
      'createCheckpoint returns a UUID checkpointId',
    );

    fs.writeFileSync(path.join(wsPath, 'index.ts'), 'MUTATED CONTENT');
    assert(fs.readFileSync(path.join(wsPath, 'index.ts'), 'utf-8') === 'MUTATED CONTENT', 'Workspace content mutated');

    await checkpointManager.restoreCheckpoint(chkId, wsPath);
    assert(
      fs.readFileSync(path.join(wsPath, 'index.ts'), 'utf-8') === 'console.log("hello world");',
      'restoreCheckpoint restores original workspace content'
    );

    const validGitRef = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: realRepo,
      windowsHide: true,
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(path.join(realRepo, 'README.md'), 'MUTATED GIT CONTENT');
    const validCheckpointDb = {
      select: () => ({
        from: () => ({
          where: async () => [{
            id: 'valid-git-checkpoint',
            snapshotPath: null,
            gitRef: validGitRef,
          }],
        }),
      }),
    } as unknown as NonNullable<Parameters<typeof checkpointManager.restoreCheckpoint>[2]>['db'];
    await checkpointManager.restoreCheckpoint('valid-git-checkpoint', realRepo, { db: validCheckpointDb });
    assert(
      fs.readFileSync(path.join(realRepo, 'README.md'), 'utf-8') === 'linked worktree probe',
      'Valid Git ref restores the committed workspace state with argument-based Git execution',
    );

    const restoreSnapshotPath = path.join(tmpDir, 'malicious-ref-snapshot');
    fs.mkdirSync(restoreSnapshotPath, { recursive: true });
    fs.writeFileSync(path.join(restoreSnapshotPath, 'restored.txt'), 'snapshot fallback');
    const maliciousCheckpointId = 'malicious-ref-checkpoint';
    const injectionMarkerPath = path.join(tmpDir, 'checkpoint-ref-injection-marker.txt');
    const maliciousCheckpointDb = {
      select: () => ({
        from: () => ({
          where: async () => [{
            id: maliciousCheckpointId,
            snapshotPath: restoreSnapshotPath,
            gitRef: `0123456789abcdef0123456789abcdef0123456 & echo injected > "${injectionMarkerPath}"`,
          }],
        }),
      }),
    } as unknown as NonNullable<Parameters<typeof checkpointManager.restoreCheckpoint>[2]>['db'];
    await checkpointManager.restoreCheckpoint(maliciousCheckpointId, realRepo, { db: maliciousCheckpointDb });
    assert(
      fs.readFileSync(path.join(realRepo, 'restored.txt'), 'utf-8') === 'snapshot fallback',
      'Invalid Git ref falls back to the checkpoint snapshot without invoking a shell',
    );
    assert(!fs.existsSync(injectionMarkerPath), 'Malicious Git ref cannot execute an injected shell command');

    const mergeResult = await worktreeManager.merge(wtPath, 'main', wsPath);
    assert(mergeResult.success === true, 'Non-git merge succeeds');
    assert(fs.existsSync(path.join(wsPath, 'newfile.ts')), 'Merged newfile.ts copied to main workspace');

    await worktreeManager.removeWorktree(wtPath, true, wsPath);
    assert(!fs.existsSync(wtPath), 'Worktree cleaned up successfully');
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

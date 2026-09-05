import fs from 'fs';
import path from 'path';
import os from 'os';
import { WorkspaceManager, WorktreeManager } from '@atris-agent-code/workspace-manager';
import { MergeCoordinator } from './merge-coordinator';

async function runTests() {
  console.log('--- Starting MergeCoordinator & ReviewPack Tests ---');
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mc-test-'));

  try {
    const wsPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'package.json'), JSON.stringify({ name: 'test', dependencies: {} }));
    fs.writeFileSync(path.join(wsPath, 'schema.ts'), 'export const db = {};');

    // Mock WorkspaceManager methods for unit test
    const worktreeManager = new WorktreeManager();
    const wtPath = await worktreeManager.createWorktree(wsPath, 'atris/mission-m1/task-t1');

    // Modify worktree files
    fs.writeFileSync(path.join(wtPath, 'schema.ts'), 'export const db = { table: true };');
    fs.writeFileSync(path.join(wtPath, 'package.json'), JSON.stringify({ name: 'test', dependencies: { 'express': '^4.18.2' } }));
    fs.writeFileSync(path.join(wtPath, 'new-file.ts'), 'console.log("new file");');

    let checkpointLabel = '';
    const mockWorkspaceManager = {
      getTask: async (id: string) => ({
        id,
        missionId: 'm1',
        title: 'Update DB Schema and add Express',
        description: 'Refactor database and dependencies',
        worktreeId: wtPath,
      }),
      getMission: async (id: string) => ({ id, workspaceId: 'w1' }),
      getWorkspace: async (id: string) => ({ id, path: wsPath }),
      getWorktreeManager: () => worktreeManager,
      getWorktreeForTask: async () => null,
      getCheckpointManager: () => ({
        createCheckpoint: async (_workspacePath: string, label: string) => {
          checkpointLabel = label;
          return 'chk-mock-123';
        },
        restoreCheckpoint: async () => {},
      }),
    } as unknown as WorkspaceManager;

    const coordinator = new MergeCoordinator(mockWorkspaceManager);

    // Test 1: ReviewPack Generation
    const pack = await coordinator.generateReviewPack('t1', {
      builderSummary: 'Updated schema & added express dependency',
      buildResult: { name: 'build', passed: true, summary: 'Build succeeded', output: null },
      testResult: { name: 'test', passed: true, summary: 'All tests passed', output: null },
    });

    assert(pack.taskId === 't1', 'ReviewPack generated with correct taskId');
    assert(pack.changedFiles.length >= 3, 'ReviewPack contains changedFiles');
    assert(pack.newDependencies.some((d) => d.startsWith('express@')), 'Detects new express dependency');
    assert(pack.riskyOperations.some((r) => r.includes('schema')), 'Detects risky schema alteration');
    assert(pack.buildResult?.passed === true, 'Build result attached correctly');

    const countCoordinator = new MergeCoordinator({
      ...mockWorkspaceManager,
      getWorktreeManager: () => ({
        getChangedFiles: async () => [
          { path: 'small.ts', status: 'modified' },
          { path: 'large.ts', status: 'added' },
          { path: 'deleted.ts', status: 'deleted' },
          { path: 'space name.ts', status: 'added' },
        ],
        getDiff: async () => [
          '--- a/small.ts', '+++ b/small.ts', '-old', '+new',
          '--- /dev/null', '+++ b/large.ts', ...Array(201).fill('+line'),
          'diff --git a/deleted.ts b/deleted.ts', '--- a/deleted.ts', '+++ /dev/null', '-one', '-two',
          'diff --git "a/space name.ts" "b/space name.ts"', '--- /dev/null', '+++ "b/space name.ts"', '+++content',
        ].join('\n'),
      }),
    } as unknown as WorkspaceManager);
    const counted = await countCoordinator.generateReviewPack('t1');
    assert(counted.changedFiles[0].additions === 1 && counted.changedFiles[0].deletions === 1,
      'Small file counts do not include subsequent files');
    assert(counted.changedFiles[1].additions === 201 && counted.changedFiles[2].deletions === 2,
      'New and deleted Git files count their own sections');
    assert(counted.changedFiles[3].additions === 1, 'Quoted paths and plus-prefixed content are counted');
    assert(counted.riskyOperations.filter((risk) => risk.startsWith('Large diff')).length === 1,
      'Only the genuinely large file receives a large-diff warning');

    // Test 2: Apply Worktree & Pre-Merge Checkpoint
    const mergeResult = await coordinator.applyWorktree('t1', undefined, {
      operationId: 'approval-1',
      idempotencyKey: 'approval:approval-1:1:task:t1',
    });
    assert(mergeResult.success === true, 'Apply worktree succeeds');
    assert(mergeResult.status === 'Merged', 'Status is Merged');
    assert(mergeResult.checkpointId === 'chk-mock-123', 'Pre-merge checkpoint ID returned');
    assert(checkpointLabel.includes('approval:approval-1:1:task:t1'), 'Apply operation idempotency key is carried into the durable checkpoint label');
    assert(fs.existsSync(path.join(wsPath, 'new-file.ts')), 'Merged files reflected in main workspace');

    let verifiedPath = '';
    const verification = await coordinator.verifyAppliedWorkspace('t1', async (basePath) => {
      verifiedPath = basePath;
      return { passed: true, summary: 'Base checks passed', evidence: ['test: passed'] };
    });
    assert(path.resolve(verifiedPath) === path.resolve(wsPath), 'Post-apply verifier runs against the actual base workspace');
    assert(verification.passed && verification.evidence.length === 1, 'Post-apply verification evidence is preserved');

    const siblingContainer = path.join(tmpDir, 'container');
    const siblingStaging = path.join(siblingContainer, '.atris-worktrees', 'mission-m2', 'task-t2');
    fs.mkdirSync(siblingContainer);
    await worktreeManager.createEmptyManagedStaging(siblingStaging, siblingContainer);
    fs.writeFileSync(path.join(siblingStaging, 'package.json'), JSON.stringify({ name: 'AtrisTask' }));
    fs.mkdirSync(path.join(siblingStaging, 'src'));
    fs.writeFileSync(path.join(siblingStaging, 'src', 'index.ts'), 'export const task = true;\n');
    let siblingCheckpointed = false;
    let persistedOperation = '';
    let persistedTargetPath = '';
    let failOwnershipPersistence = true;
    const siblingManager = {
      getTask: async () => ({ id: 't2', missionId: 'm2', title: 'Create AtrisTask', description: 'New sibling', worktreeId: siblingStaging }),
      getMission: async () => ({ id: 'm2', workspaceId: 'w2' }),
      getWorkspace: async () => ({ id: 'w2', path: siblingContainer }),
      getWorktreeManager: () => worktreeManager,
      getWorktreeForTask: async () => ({
        isolationKind: 'new-sibling', canonicalContainer: siblingContainer, targetName: 'AtrisTask',
        targetPath: path.join(siblingContainer, 'AtrisTask'), appliedOperationKey: null,
      }),
      markNewSiblingApplied: async (_taskId: string, operationKey: string, targetPath: string) => {
        if (failOwnershipPersistence) throw new Error('injected database failure after rename');
        persistedOperation = operationKey;
        persistedTargetPath = targetPath;
      },
      getCheckpointManager: () => ({ createCheckpoint: async () => { siblingCheckpointed = true; return 'unexpected'; } }),
    } as unknown as WorkspaceManager;
    const siblingCoordinator = new MergeCoordinator(siblingManager);
    const siblingPack = await siblingCoordinator.generateReviewPack('t2');
    assert(siblingPack.changedFiles.length === 2 && siblingPack.changedFiles.every((file) => file.status === 'added'), 'New sibling review pack reports every project file as added');
    assert(siblingPack.unifiedDiff.includes('+++ b/package.json') && siblingPack.unifiedDiff.includes('+++ b/src/index.ts'), 'New sibling review pack diff includes every project file');
    assert(!siblingPack.changedFiles.some((file) => file.path.includes('.atris-')) && !siblingPack.unifiedDiff.includes('.atris-baseline') && !siblingPack.unifiedDiff.includes('.atris-operation'), 'New sibling review pack excludes Atris metadata');
    let injectedFailure = '';
    try {
      await siblingCoordinator.applyWorktree('t2', undefined, { idempotencyKey: 'approval:new-sibling:t2' });
    } catch (error) {
      injectedFailure = error instanceof Error ? error.message : String(error);
    }
    assert(injectedFailure.includes('injected database failure') && fs.existsSync(path.join(siblingContainer, 'AtrisTask', '.atris-operation.json')), 'Fault injection approximates a crash after rename while durable marker remains');
    failOwnershipPersistence = false;
    const siblingApply = await siblingCoordinator.applyWorktree('t2', undefined, { idempotencyKey: 'approval:new-sibling:t2' });
    assert(siblingApply.success && siblingApply.output.includes('Recovered') && fs.existsSync(path.join(siblingContainer, 'AtrisTask', 'package.json')), 'MergeCoordinator retry reconciles the Atris-owned destination');
    assert(!siblingCheckpointed, 'New sibling apply does not checkpoint or merge an existing repository');
    assert(persistedOperation === 'approval:new-sibling:t2' && persistedTargetPath === path.join(siblingContainer, 'AtrisTask'), 'New sibling apply persists Atris ownership and final target path');
    assert(!fs.existsSync(path.join(siblingContainer, 'AtrisTask', '.atris-operation.json')) && !fs.existsSync(path.join(siblingContainer, 'AtrisTask', '.atris-baseline')), 'Marker cleanup occurs only after durable ownership and no Atris metadata remains applied');
    let siblingVerificationPath = '';
    await siblingCoordinator.verifyAppliedWorkspace('t2', async (basePath) => {
      siblingVerificationPath = basePath;
      return { passed: true, summary: 'ok', evidence: [] };
    });
    assert(siblingVerificationPath === path.join(siblingContainer, 'AtrisTask'), 'MergeCoordinator verification resolves the created AtrisTask project');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nTest Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});

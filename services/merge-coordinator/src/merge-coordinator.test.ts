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
      getCheckpointManager: () => ({
        createCheckpoint: async () => 'chk-mock-123',
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

    // Test 2: Apply Worktree & Pre-Merge Checkpoint
    const mergeResult = await coordinator.applyWorktree('t1');
    assert(mergeResult.success === true, 'Apply worktree succeeds');
    assert(mergeResult.status === 'Merged', 'Status is Merged');
    assert(mergeResult.checkpointId === 'chk-mock-123', 'Pre-merge checkpoint ID returned');
    assert(fs.existsSync(path.join(wsPath, 'new-file.ts')), 'Merged files reflected in main workspace');

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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { CheckpointManager } from './checkpoint-manager';

async function runTests() {
  console.log('--- Checkpoint Symlink Security Tests ---');
  let passed = 0;
  let failed = 0;
  const assert = (condition: boolean, message: string) => {
    if (condition) {
      passed += 1;
      console.log(`[PASS] ${message}`);
    } else {
      failed += 1;
      console.error(`[FAIL] ${message}`);
    }
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-checkpoint-symlink-'));
  const workspace = path.join(root, 'workspace');
  const external = path.join(root, 'external');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  const manager = new CheckpointManager();

  try {
    const outsideFile = path.join(external, 'outside.txt');
    fs.writeFileSync(outsideFile, 'outside-original');
    const standaloneLink = path.join(workspace, 'external-link');

    let symlinksSupported = true;
    try {
      fs.symlinkSync(external, standaloneLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      symlinksSupported = false;
      console.log(`[SKIP] Symlink preservation test unavailable on this runner: ${error instanceof Error ? error.message : String(error)}`);
    }

    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'stable.ts'), 'export const stable = true;');
    const checkpointId = await manager.createCheckpoint(workspace, 'symlink-safety');

    if (symlinksSupported) {
      assert(!fs.existsSync(path.join(workspace, '.atris-checkpoints', checkpointId, 'external-link')), 'checkpoint snapshot does not traverse or copy standalone symlinks');
      await manager.restoreCheckpoint(checkpointId, workspace);
      assert(fs.lstatSync(standaloneLink).isSymbolicLink(), 'exact restore preserves a pre-existing standalone workspace symlink omitted from the snapshot');
      assert(fs.readFileSync(outsideFile, 'utf8') === 'outside-original', 'restoring a standalone symlink does not mutate its external target');

      // A hostile post-checkpoint symlink at a path that WAS snapshotted must not
      // receive restored files. The restore should remove the link itself and
      // recreate the real in-workspace directory from the checkpoint.
      fs.rmSync(path.join(workspace, 'src'), { recursive: true, force: true });
      const externalCollisionDir = path.join(external, 'collision');
      fs.mkdirSync(externalCollisionDir, { recursive: true });
      const sentinel = path.join(externalCollisionDir, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'outside-sentinel');
      fs.symlinkSync(externalCollisionDir, path.join(workspace, 'src'), process.platform === 'win32' ? 'junction' : 'dir');

      await manager.restoreCheckpoint(checkpointId, workspace);
      const restoredSrc = fs.lstatSync(path.join(workspace, 'src'));
      assert(restoredSrc.isDirectory() && !restoredSrc.isSymbolicLink(), 'restore replaces a conflicting directory symlink with a real workspace directory');
      assert(fs.readFileSync(path.join(workspace, 'src', 'stable.ts'), 'utf8').includes('stable = true'), 'snapshot content is restored inside the workspace after symlink replacement');
      assert(fs.readFileSync(sentinel, 'utf8') === 'outside-sentinel', 'restore never writes snapshot content through a hostile symlink into an external target');
      assert(!fs.existsSync(path.join(externalCollisionDir, 'stable.ts')), 'external symlink target receives no restored workspace file');
    }
    manager.removeWorkspaceCheckpoints(workspace);
    manager.removeWorkspaceCheckpoints(workspace);
    assert(!fs.existsSync(path.join(workspace, '.atris-checkpoints')), 'checkpoint cleanup is idempotent');
    assert(fs.existsSync(path.join(workspace, 'src', 'stable.ts')), 'checkpoint cleanup retains source project files');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`Checkpoint symlink security tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});

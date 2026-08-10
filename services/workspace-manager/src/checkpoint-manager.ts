import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { checkpoints, type AtrisDatabase, type CheckpointSelect } from '@atris-agent-code/database';
import { eq } from 'drizzle-orm';
import { isGeneratedWorkspaceDirectory, isGitWorktree } from './git-utils';

const execFileAsync = promisify(execFile);
const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function isValidGitCommitSha(value: string | null | undefined): value is string {
  return typeof value === 'string' && GIT_COMMIT_SHA_PATTERN.test(value);
}

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.atris-worktrees',
  '.atris-checkpoints',
  'dist',
  '.next',
  'build',
  '.atris-baseline',
]);

function shouldIgnoreEntry(name: string, ignoreList: Set<string>): boolean {
  return ignoreList.has(name) || isGeneratedWorkspaceDirectory(name);
}

function copyDirRecursive(src: string, dest: string, ignoreList: Set<string> = DEFAULT_IGNORED_DIRS) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name, ignoreList)) {
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, ignoreList);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export interface CreateCheckpointOptions {
  missionId?: string;
  workspaceId?: string;
  isRollbackTarget?: boolean;
  db?: AtrisDatabase;
}

export interface RestoreCheckpointOptions {
  db?: AtrisDatabase;
}

export class CheckpointManager {
  private async isGitRepo(workspacePath: string): Promise<boolean> {
    return isGitWorktree(workspacePath);
  }

  async createCheckpoint(
    workspacePath: string,
    label: string,
    options?: CreateCheckpointOptions
  ): Promise<string> {
    const checkpointId = crypto.randomUUID();
    const snapshotDir = path.join(workspacePath, '.atris-checkpoints', checkpointId);

    fs.mkdirSync(snapshotDir, { recursive: true });
    copyDirRecursive(workspacePath, snapshotDir);

    let gitRef: string | null = null;
    const isGit = await this.isGitRepo(workspacePath);
    if (isGit) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: workspacePath,
          windowsHide: true,
        });
        gitRef = stdout.trim();
      } catch {
        gitRef = null;
      }
    }

    const now = new Date().toISOString();
    if (options?.db) {
      await options.db.insert(checkpoints).values({
        id: checkpointId,
        missionId: options.missionId || 'global-mission',
        workspaceId: options.workspaceId || 'global-workspace',
        label,
        gitRef,
        snapshotPath: snapshotDir,
        createdAt: now,
        isRollbackTarget: options.isRollbackTarget ?? false,
      });
    }

    return checkpointId;
  }

  async restoreCheckpoint(
    checkpointId: string,
    workspacePath: string,
    options?: RestoreCheckpointOptions
  ): Promise<void> {
    let snapshotPath: string | null = path.join(workspacePath, '.atris-checkpoints', checkpointId);
    let gitRef: string | null = null;

    if (options?.db) {
      const rows = await options.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.id, checkpointId));

      if (rows.length > 0) {
        snapshotPath = rows[0].snapshotPath || snapshotPath;
        gitRef = rows[0].gitRef;
      }
    }

    const isGit = await this.isGitRepo(workspacePath);
    if (isGit && isValidGitCommitSha(gitRef)) {
      try {
        await execFileAsync('git', ['reset', '--hard', gitRef], {
          cwd: workspacePath,
          windowsHide: true,
        });
        return;
      } catch {
        // Fallback to snapshot restore if git reset fails
      }
    }

    if (snapshotPath && fs.existsSync(snapshotPath)) {
      copyDirRecursive(snapshotPath, workspacePath);
    } else {
      throw new Error(`Checkpoint snapshot for "${checkpointId}" not found at ${snapshotPath}`);
    }
  }

  async listCheckpoints(
    workspacePath: string,
    options?: { db?: AtrisDatabase; missionId?: string }
  ): Promise<Array<{ id: string; label: string; createdAt: string; isRollbackTarget: boolean; snapshotPath?: string; gitRef?: string }>> {
    if (options?.db) {
      const rows = await options.db.select().from(checkpoints);
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        createdAt: r.createdAt,
        isRollbackTarget: r.isRollbackTarget,
        snapshotPath: r.snapshotPath || undefined,
        gitRef: r.gitRef || undefined,
      }));
    }

    const checkpointsDir = path.join(workspacePath, '.atris-checkpoints');
    if (!fs.existsSync(checkpointsDir)) return [];

    const entries = fs.readdirSync(checkpointsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        id: e.name,
        label: `Snapshot ${e.name}`,
        createdAt: new Date().toISOString(),
        isRollbackTarget: false,
        snapshotPath: path.join(checkpointsDir, e.name),
      }));
  }

  async deleteCheckpoint(
    checkpointId: string,
    workspacePath: string,
    options?: { db?: AtrisDatabase }
  ): Promise<void> {
    const snapshotDir = path.join(workspacePath, '.atris-checkpoints', checkpointId);
    if (fs.existsSync(snapshotDir)) {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }

    if (options?.db) {
      await options.db.delete(checkpoints).where(eq(checkpoints.id, checkpointId));
    }
  }
}

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { and, eq } from 'drizzle-orm';
import { checkpoints, type AtrisDatabase, type CheckpointSelect } from '@atris-agent-code/database';
import { isGeneratedWorkspaceDirectory, isGitWorktree } from './git-utils';

const execFileAsync = promisify(execFile);
const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const CHECKPOINT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidGitCommitSha(value: string | null | undefined): value is string {
  return typeof value === 'string' && GIT_COMMIT_SHA_PATTERN.test(value);
}

export function isSafeCheckpointId(value: string | null | undefined): value is string {
  return typeof value === 'string' && CHECKPOINT_ID_PATTERN.test(value);
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

function canonicalDirectory(dirPath: string, label: string): string {
  const resolved = fs.realpathSync(dirPath);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${dirPath}`);
  return resolved;
}

function assertPathWithin(parentPath: string, childPath: string, label: string): void {
  const relative = path.relative(parentPath, childPath);
  if (relative === '') return;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the expected workspace boundary.`);
  }
}

function checkpointRoot(workspaceRoot: string, create = false): string {
  const root = path.join(workspaceRoot, '.atris-checkpoints');
  if (create) fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(root)) return root;

  const metadata = fs.lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('AtrisAgent checkpoint storage must be a real directory inside the workspace.');
  }
  const canonicalRoot = fs.realpathSync(root);
  assertPathWithin(workspaceRoot, canonicalRoot, 'Checkpoint storage');
  return canonicalRoot;
}

function copyDirRecursive(src: string, dest: string, ignoreList: Set<string> = DEFAULT_IGNORED_DIRS): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name, ignoreList)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, ignoreList);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeEntriesMissingFromSnapshot(
  snapshotDir: string,
  workspaceDir: string,
  ignoreList: Set<string> = DEFAULT_IGNORED_DIRS,
): void {
  const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name, ignoreList)) continue;

    const workspaceEntry = path.join(workspaceDir, entry.name);
    const snapshotEntry = path.join(snapshotDir, entry.name);
    if (!fs.existsSync(snapshotEntry)) {
      // Checkpoints intentionally do not traverse/copy symlinks. Preserve a
      // standalone workspace symlink that has no snapshot counterpart rather
      // than deleting a link that may have existed before the checkpoint.
      if (entry.isSymbolicLink()) continue;
      fs.rmSync(workspaceEntry, { recursive: true, force: true });
      continue;
    }

    const snapshotStat = fs.lstatSync(snapshotEntry);
    const workspaceStat = fs.lstatSync(workspaceEntry);
    if (snapshotStat.isDirectory() && !snapshotStat.isSymbolicLink()
      && workspaceStat.isDirectory() && !workspaceStat.isSymbolicLink()) {
      removeEntriesMissingFromSnapshot(snapshotEntry, workspaceEntry, ignoreList);
      continue;
    }

    const compatibleFiles = snapshotStat.isFile() && workspaceStat.isFile();
    if (!compatibleFiles) fs.rmSync(workspaceEntry, { recursive: true, force: true });
  }
}

function restoreSnapshotExact(snapshotDir: string, workspaceRoot: string): void {
  removeEntriesMissingFromSnapshot(snapshotDir, workspaceRoot);
  copyDirRecursive(snapshotDir, workspaceRoot);
}

export interface CreateCheckpointOptions {
  missionId?: string;
  workspaceId?: string;
  isRollbackTarget?: boolean;
  db?: AtrisDatabase;
}

export interface RestoreCheckpointOptions {
  db?: AtrisDatabase;
  expectedWorkspaceId?: string;
  expectedMissionId?: string;
}

export interface ListCheckpointOptions {
  db?: AtrisDatabase;
  workspaceId?: string;
  missionId?: string;
}

export interface DeleteCheckpointOptions {
  db?: AtrisDatabase;
  expectedWorkspaceId?: string;
  expectedMissionId?: string;
}

export class CheckpointManager {
  constructor(private readonly db?: AtrisDatabase) {}

  private async isGitRepo(workspacePath: string): Promise<boolean> {
    return isGitWorktree(workspacePath);
  }

  private resolveDb(explicit?: AtrisDatabase): AtrisDatabase | undefined {
    return explicit || this.db;
  }

  private async requireOwnedCheckpoint(
    checkpointId: string,
    db: AtrisDatabase,
    expectedWorkspaceId?: string,
    expectedMissionId?: string,
  ): Promise<CheckpointSelect> {
    if (!expectedWorkspaceId || !expectedMissionId) {
      throw new Error('Checkpoint ownership context requires both workspaceId and missionId.');
    }
    const rows = await db.select().from(checkpoints).where(and(
      eq(checkpoints.id, checkpointId),
      eq(checkpoints.workspaceId, expectedWorkspaceId),
      eq(checkpoints.missionId, expectedMissionId),
    ));
    if (!rows[0]) {
      throw new Error('Checkpoint was not found for the requested workspace and mission.');
    }
    return rows[0];
  }

  private resolveSnapshotPath(
    checkpointId: string,
    workspaceRoot: string,
    persistedSnapshotPath?: string | null,
  ): string | null {
    if (!isSafeCheckpointId(checkpointId)) {
      throw new Error('Checkpoint ID is not a valid AtrisAgent checkpoint identifier.');
    }

    const managedRoot = checkpointRoot(workspaceRoot, false);
    if (!fs.existsSync(managedRoot)) return null;
    const canonicalManagedRoot = canonicalDirectory(managedRoot, 'Checkpoint storage');
    const candidate = persistedSnapshotPath || path.join(canonicalManagedRoot, checkpointId);
    if (!fs.existsSync(candidate)) return null;

    const canonicalSnapshot = canonicalDirectory(candidate, 'Checkpoint snapshot');
    assertPathWithin(canonicalManagedRoot, canonicalSnapshot, 'Checkpoint snapshot');
    if (path.basename(canonicalSnapshot) !== checkpointId) {
      throw new Error('Checkpoint snapshot path does not match the requested checkpoint ID.');
    }
    return canonicalSnapshot;
  }

  async createCheckpoint(
    workspacePath: string,
    label: string,
    options?: CreateCheckpointOptions,
  ): Promise<string> {
    const db = this.resolveDb(options?.db);
    if (db && (!options?.missionId || !options?.workspaceId)) {
      throw new Error('Persisted checkpoints require missionId and workspaceId ownership.');
    }

    const workspaceRoot = canonicalDirectory(workspacePath, 'Workspace');
    const checkpointId = crypto.randomUUID();
    const managedRoot = checkpointRoot(workspaceRoot, true);
    const snapshotDir = path.join(managedRoot, checkpointId);
    assertPathWithin(managedRoot, snapshotDir, 'Checkpoint snapshot');

    fs.mkdirSync(snapshotDir, { recursive: false });
    try {
      copyDirRecursive(workspaceRoot, snapshotDir);

      let gitRef: string | null = null;
      if (await this.isGitRepo(workspaceRoot)) {
        try {
          const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
            cwd: workspaceRoot,
            windowsHide: true,
          });
          gitRef = stdout.trim();
        } catch {
          gitRef = null;
        }
      }

      if (db) {
        await db.insert(checkpoints).values({
          id: checkpointId,
          missionId: options!.missionId!,
          workspaceId: options!.workspaceId!,
          label,
          gitRef,
          snapshotPath: snapshotDir,
          createdAt: new Date().toISOString(),
          isRollbackTarget: options?.isRollbackTarget ?? false,
        });
      }
      return checkpointId;
    } catch (error) {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
      throw error;
    }
  }

  async restoreCheckpoint(
    checkpointId: string,
    workspacePath: string,
    options?: RestoreCheckpointOptions,
  ): Promise<void> {
    const workspaceRoot = canonicalDirectory(workspacePath, 'Workspace');
    const db = this.resolveDb(options?.db);
    const record = db
      ? await this.requireOwnedCheckpoint(checkpointId, db, options?.expectedWorkspaceId, options?.expectedMissionId)
      : null;
    const snapshotPath = this.resolveSnapshotPath(checkpointId, workspaceRoot, record?.snapshotPath);
    const gitRef = record?.gitRef ?? null;

    let gitRestored = false;
    if (await this.isGitRepo(workspaceRoot) && isValidGitCommitSha(gitRef)) {
      try {
        await execFileAsync('git', ['reset', '--hard', gitRef], {
          cwd: workspaceRoot,
          windowsHide: true,
        });
        gitRestored = true;
      } catch {
        gitRestored = false;
      }
    }

    if (snapshotPath) {
      restoreSnapshotExact(snapshotPath, workspaceRoot);
      return;
    }
    if (gitRestored) return;

    throw new Error(`Checkpoint snapshot for "${checkpointId}" is unavailable and no valid Git rollback target could be restored.`);
  }

  async listCheckpoints(
    workspacePath: string,
    options?: ListCheckpointOptions,
  ): Promise<Array<{ id: string; label: string; createdAt: string; isRollbackTarget: boolean; snapshotPath?: string; gitRef?: string }>> {
    const workspaceRoot = canonicalDirectory(workspacePath, 'Workspace');
    const db = this.resolveDb(options?.db);
    if (db) {
      if (!options?.workspaceId || !options?.missionId) {
        throw new Error('Listing persisted checkpoints requires workspaceId and missionId ownership.');
      }
      const rows = await db.select().from(checkpoints).where(and(
        eq(checkpoints.workspaceId, options.workspaceId),
        eq(checkpoints.missionId, options.missionId),
      ));
      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        createdAt: row.createdAt,
        isRollbackTarget: row.isRollbackTarget,
        snapshotPath: row.snapshotPath || undefined,
        gitRef: row.gitRef || undefined,
      }));
    }

    const managedRoot = checkpointRoot(workspaceRoot, false);
    if (!fs.existsSync(managedRoot)) return [];
    return fs.readdirSync(managedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeCheckpointId(entry.name))
      .map((entry) => {
        const snapshotPath = path.join(managedRoot, entry.name);
        const stat = fs.statSync(snapshotPath);
        return {
          id: entry.name,
          label: `Snapshot ${entry.name}`,
          createdAt: stat.mtime.toISOString(),
          isRollbackTarget: false,
          snapshotPath,
        };
      });
  }

  async deleteCheckpoint(
    checkpointId: string,
    workspacePath: string,
    options?: DeleteCheckpointOptions,
  ): Promise<void> {
    const workspaceRoot = canonicalDirectory(workspacePath, 'Workspace');
    const db = this.resolveDb(options?.db);
    const record = db
      ? await this.requireOwnedCheckpoint(checkpointId, db, options?.expectedWorkspaceId, options?.expectedMissionId)
      : null;
    const snapshotPath = this.resolveSnapshotPath(checkpointId, workspaceRoot, record?.snapshotPath);

    if (snapshotPath) fs.rmSync(snapshotPath, { recursive: true, force: true });
    if (db) await db.delete(checkpoints).where(and(
      eq(checkpoints.id, checkpointId),
      eq(checkpoints.workspaceId, options!.expectedWorkspaceId!),
      eq(checkpoints.missionId, options!.expectedMissionId!),
    ));
  }
}

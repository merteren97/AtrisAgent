import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { isGeneratedWorkspaceDirectory, isGitWorktree } from './git-utils';
import type { BuilderTargetDescriptor } from '@atris-agent-code/domain';
import { validateDirectChildProjectName } from '@atris-agent-code/domain';

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 45_000;
const NEW_SIBLING_BASELINE = '.atris-baseline';
const NEW_SIBLING_OPERATION_MARKER = '.atris-operation.json';

interface NewSiblingOperationMarker {
  version: 1;
  operationKey: string;
  canonicalContainer: string;
  targetName: string;
  targetPath: string;
  published: boolean;
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function ensureAtrisGitExcludes(basePath: string): void {
  const gitMetadata = path.join(basePath, '.git');
  if (!fs.existsSync(gitMetadata) || !fs.statSync(gitMetadata).isDirectory()) return;
  const excludePath = path.join(gitMetadata, 'info', 'exclude');
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const patterns = ['.atris-worktrees/', '.atris-checkpoints/'];
  const missing = patterns.filter((pattern) => !existing.split(/\r?\n/).includes(pattern));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(excludePath, `${prefix}# AtrisAgent managed workspace data\n${missing.join('\n')}\n`);
}

function filterAtrisManagedStatus(status: string): string {
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const filePath = line.length > 3 ? line.slice(3).replace(/\\/g, '/') : line;
      return !filePath.startsWith('.atris-worktrees/') && !filePath.startsWith('.atris-checkpoints/');
    })
    .join('\n');
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
}

export interface IsolationBase {
  path: string;
  kind: 'workspace-git' | 'nested-git' | 'mirror' | 'new-sibling';
}

export interface ResolvedBuilderTarget extends IsolationBase {
  canonicalContainer?: string;
  targetName?: string;
  targetPath?: string;
}

export type WorktreeInspectResult = {
  kind: 'directory'; path: string; entries: Array<{ path: string; name: string; kind: 'directory' | 'file'; sizeBytes?: number }>; truncated: boolean;
} | {
  kind: 'file'; path: string; sizeBytes: number; content?: string; truncated: boolean; previewUnavailable?: 'binary' | 'special';
};

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.atris-worktrees',
  '.atris-checkpoints',
  'dist',
  '.next',
  'build',
  NEW_SIBLING_BASELINE,
  NEW_SIBLING_OPERATION_MARKER,
]);

function shouldIgnoreEntry(name: string, ignoreList: Set<string>): boolean {
  return ignoreList.has(name) || isGeneratedWorkspaceDirectory(name);
}

async function copyDirRecursive(src: string, dest: string, ignoreList: Set<string> = DEFAULT_IGNORED_DIRS): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name, ignoreList)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, ignoreList);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

function getAllFilesRelative(dir: string, baseDir: string = dir, ignoreList: Set<string> = DEFAULT_IGNORED_DIRS): string[] {
  if (!fs.existsSync(dir)) return [];
  let files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name, ignoreList)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      files = files.concat(getAllFilesRelative(fullPath, baseDir, ignoreList));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

function normalizeProjectHint(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '');
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(directoryPath, 'r');
    await handle.sync();
  } catch (error: any) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export class WorktreeManager {
  private isContainedDirectChild(container: string, candidate: string): boolean {
    return path.dirname(candidate) === container && path.relative(container, candidate) === path.basename(candidate);
  }

  async validateNewSiblingTarget(workspacePath: string, projectName: string): Promise<ResolvedBuilderTarget> {
    const targetName = validateDirectChildProjectName(projectName);
    const canonicalContainer = await fs.promises.realpath(workspacePath);
    const stat = await fs.promises.lstat(canonicalContainer);
    if (!stat.isDirectory()) throw new Error('Registered workspace container is not a directory.');
    const entries = await fs.promises.readdir(canonicalContainer);
    if (entries.some((entry) => entry.toLocaleLowerCase('en-US') === targetName.toLocaleLowerCase('en-US'))) {
      throw new Error(`Cannot create new sibling project "${targetName}": a workspace entry already uses that name.`);
    }
    const targetPath = path.join(canonicalContainer, targetName);
    if (!this.isContainedDirectChild(canonicalContainer, targetPath)) throw new Error('New sibling target escapes the workspace container.');
    return { path: canonicalContainer, kind: 'new-sibling', canonicalContainer, targetName, targetPath };
  }

  async resolveBuilderTarget(
    workspacePath: string,
    descriptor: BuilderTargetDescriptor | null | undefined,
    projectHint = '',
  ): Promise<ResolvedBuilderTarget> {
    if (!descriptor) return this.resolveIsolationBase(workspacePath, projectHint);
    if (descriptor.kind === 'new_sibling_project') {
      const target = await this.validateNewSiblingTarget(workspacePath, descriptor.projectName);
      return target;
    }
    if (descriptor.kind === 'workspace_root') {
      const canonical = await fs.promises.realpath(workspacePath);
      return { path: canonical, kind: await this.isGitRepository(canonical) ? 'workspace-git' : 'mirror' };
    }

    const projectName = validateDirectChildProjectName(descriptor.projectName);
    const canonicalContainer = await fs.promises.realpath(workspacePath);
    const entries = await fs.promises.readdir(canonicalContainer, { withFileTypes: true });
    const matches = entries.filter((entry) => entry.name.toLocaleLowerCase('en-US') === projectName.toLocaleLowerCase('en-US'));
    if (matches.length !== 1 || !matches[0].isDirectory() || matches[0].isSymbolicLink()) {
      throw new Error(`Existing project target "${projectName}" is not one direct child directory of the workspace.`);
    }
    const candidate = await fs.promises.realpath(path.join(canonicalContainer, matches[0].name));
    if (!this.isContainedDirectChild(canonicalContainer, candidate)) throw new Error('Existing project target escapes the workspace container.');
    return {
      path: candidate,
      kind: await this.isGitRepository(candidate) ? 'nested-git' : 'mirror',
      canonicalContainer,
      targetName: matches[0].name,
      targetPath: candidate,
    };
  }

  async createEmptyManagedStaging(stagingPath: string, canonicalContainer: string): Promise<string> {
    const parent = path.dirname(stagingPath);
    await fs.promises.mkdir(parent, { recursive: true });
    const canonicalParent = await fs.promises.realpath(parent);
    const relativeParent = path.relative(canonicalContainer, canonicalParent);
    if (relativeParent.startsWith('..') || path.isAbsolute(relativeParent)) throw new Error('Managed staging path escapes the workspace container.');
    await fs.promises.mkdir(stagingPath, { recursive: false });
    if ((await fs.promises.readdir(stagingPath)).length !== 0) throw new Error('New sibling staging directory was not empty.');
    await fs.promises.mkdir(path.join(stagingPath, NEW_SIBLING_BASELINE));
    return stagingPath;
  }

  private newSiblingMarker(
    canonicalContainer: string,
    targetName: string,
    operationKey: string,
    published = true,
  ): NewSiblingOperationMarker {
    return {
      version: 1,
      operationKey,
      canonicalContainer,
      targetName,
      targetPath: path.join(canonicalContainer, targetName),
      published,
    };
  }

  private markerMatches(actual: NewSiblingOperationMarker, expected: NewSiblingOperationMarker): boolean {
    return actual.version === expected.version
      && actual.operationKey === expected.operationKey
      && actual.canonicalContainer === expected.canonicalContainer
      && actual.targetName === expected.targetName
      && actual.targetPath === expected.targetPath;
  }

  private async readNewSiblingMarker(targetPath: string): Promise<NewSiblingOperationMarker | null> {
    const markerPath = path.join(targetPath, NEW_SIBLING_OPERATION_MARKER);
    try {
      const raw = await fs.promises.readFile(markerPath, 'utf8');
      const marker = JSON.parse(raw) as Partial<NewSiblingOperationMarker>;
      if (marker.version !== 1
        || typeof marker.operationKey !== 'string'
        || typeof marker.canonicalContainer !== 'string'
        || typeof marker.targetName !== 'string'
        || typeof marker.targetPath !== 'string'
        || typeof marker.published !== 'boolean') {
        throw new Error('Operation marker metadata is invalid.');
      }
      return marker as NewSiblingOperationMarker;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async finalizeNewSiblingApply(canonicalContainer: string, targetName: string, operationKey: string): Promise<void> {
    validateDirectChildProjectName(targetName);
    const currentContainer = await fs.promises.realpath(canonicalContainer);
    if (currentContainer !== canonicalContainer) throw new Error('Workspace container canonical path changed before apply finalization.');
    const expected = this.newSiblingMarker(canonicalContainer, targetName, operationKey);
    if (!this.isContainedDirectChild(canonicalContainer, expected.targetPath)) throw new Error('New sibling target escapes the workspace container.');
    const targetStat = await fs.promises.lstat(expected.targetPath);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('Applied new sibling target is not a direct project directory.');
    const marker = await this.readNewSiblingMarker(expected.targetPath);
    if (!marker) return;
    if (!this.markerMatches(marker, expected)) throw new Error('Refusing to remove a mismatched new sibling operation marker.');
    await fs.promises.unlink(path.join(expected.targetPath, NEW_SIBLING_OPERATION_MARKER));
    await syncDirectory(expected.targetPath);
  }

  async applyNewSibling(
    stagingPath: string,
    canonicalContainer: string,
    targetName: string,
    operationKey: string,
    appliedOperationKey?: string | null,
  ): Promise<{ success: boolean; output: string; targetPath: string }> {
    validateDirectChildProjectName(targetName);
    if (!operationKey) throw new Error('New sibling apply operation key is required.');
    const currentContainer = await fs.promises.realpath(canonicalContainer);
    if (currentContainer !== canonicalContainer) throw new Error('Workspace container canonical path changed before apply.');
    const targetPath = path.join(canonicalContainer, targetName);
    if (!this.isContainedDirectChild(canonicalContainer, targetPath)) throw new Error('New sibling target escapes the workspace container.');
    if (fs.existsSync(targetPath)) {
      try {
        const targetStat = await fs.promises.lstat(targetPath);
        if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('Destination is not a direct project directory.');
        const expected = this.newSiblingMarker(canonicalContainer, targetName, operationKey);
        const marker = await this.readNewSiblingMarker(targetPath);
        if (marker) {
          if (!this.markerMatches(marker, expected)) throw new Error('Destination operation marker does not match this apply operation.');
          if (!marker.published) {
            const canonicalStaging = await fs.promises.realpath(stagingPath);
            const stagingRelative = path.relative(canonicalContainer, canonicalStaging);
            if (stagingRelative.startsWith('..') || path.isAbsolute(stagingRelative)) throw new Error('New sibling staging directory escapes the workspace container.');
            await copyDirRecursive(canonicalStaging, targetPath);
            await fs.promises.writeFile(
              path.join(targetPath, NEW_SIBLING_OPERATION_MARKER),
              `${JSON.stringify(expected)}\n`,
              { encoding: 'utf8', flag: 'w' },
            );
            await syncDirectory(targetPath);
            await syncDirectory(canonicalContainer);
          }
          return { success: true, output: `Recovered new sibling project ${targetName} from this Atris operation.`, targetPath };
        }
        if (appliedOperationKey === operationKey) {
          return { success: true, output: `New sibling project ${targetName} was already applied by this Atris operation.`, targetPath };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: `Destination ${targetPath} is not owned by this Atris apply operation: ${message}`, targetPath };
      }
      return { success: false, output: `Destination ${targetPath} already exists and is not owned by this Atris apply operation.`, targetPath };
    }
    const canonicalStaging = await fs.promises.realpath(stagingPath);
    const stagingRelative = path.relative(canonicalContainer, canonicalStaging);
    if (stagingRelative.startsWith('..') || path.isAbsolute(stagingRelative)) throw new Error('New sibling staging directory escapes the workspace container.');
    const temporaryPath = path.join(canonicalContainer, `.atris-apply-${crypto.randomUUID()}`);
    try {
      await copyDirRecursive(canonicalStaging, temporaryPath);
      const markerPath = path.join(temporaryPath, NEW_SIBLING_OPERATION_MARKER);
      const markerHandle = await fs.promises.open(markerPath, 'wx');
      try {
        await markerHandle.writeFile(`${JSON.stringify(this.newSiblingMarker(canonicalContainer, targetName, operationKey))}\n`, 'utf8');
        await markerHandle.sync();
      } finally {
        await markerHandle.close();
      }
      await syncDirectory(temporaryPath);
      try {
        await fs.promises.mkdir(targetPath, { recursive: false });
      } catch (error: any) {
        if (error?.code === 'EEXIST') {
          return { success: false, output: `Destination ${targetPath} appeared during apply; no files were overwritten.`, targetPath };
        }
        throw error;
      }
      const targetMarkerPath = path.join(targetPath, NEW_SIBLING_OPERATION_MARKER);
      await fs.promises.writeFile(
        targetMarkerPath,
        `${JSON.stringify(this.newSiblingMarker(canonicalContainer, targetName, operationKey, false))}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      await syncDirectory(targetPath);
      await copyDirRecursive(temporaryPath, targetPath);
      await fs.promises.writeFile(
        targetMarkerPath,
        `${JSON.stringify(this.newSiblingMarker(canonicalContainer, targetName, operationKey))}\n`,
        { encoding: 'utf8', flag: 'w' },
      );
      await syncDirectory(targetPath);
      await syncDirectory(canonicalContainer);
      return { success: true, output: `Created new sibling project ${targetPath} without replacing an existing destination.`, targetPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Could not safely create new sibling project: ${message}`, targetPath };
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { recursive: true, force: true });
    }
  }
  async inspectEntry(worktreePath: string, requestedPath = ''): Promise<WorktreeInspectResult> {
    if (requestedPath.includes('\0') || path.isAbsolute(requestedPath) || /^[a-zA-Z]:[\\/]/.test(requestedPath) || /^[/\\]{2}/.test(requestedPath)) {
      throw new Error('Worktree preview path must be relative.');
    }
    const normalized = requestedPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.split('/').some((segment) => segment === '..')) throw new Error('Worktree preview path escapes the task worktree.');
    const canonicalRoot = await fs.promises.realpath(worktreePath);
    let cursor = canonicalRoot;
    for (const segment of normalized.split('/').filter(Boolean)) {
      cursor = path.join(cursor, segment);
      const segmentStat = await fs.promises.lstat(cursor);
      if (segmentStat.isSymbolicLink()) throw new Error('Symbolic links are not available in read-only previews.');
    }
    const candidate = normalized ? cursor : canonicalRoot;
    const canonicalCandidate = await fs.promises.realpath(candidate);
    const relative = path.relative(canonicalRoot, canonicalCandidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Worktree preview path escapes the task worktree.');
    const stat = await fs.promises.lstat(canonicalCandidate);
    const apiPath = relative.replace(/\\/g, '/');
    if (stat.isDirectory()) {
      const allEntries = (await fs.promises.readdir(canonicalCandidate, { withFileTypes: true }))
        .filter((entry) => !shouldIgnoreEntry(entry.name, DEFAULT_IGNORED_DIRS) && !entry.isSymbolicLink())
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const entries = await Promise.all(allEntries.slice(0, 1000).map(async (entry) => {
        const childRelative = [apiPath, entry.name].filter(Boolean).join('/');
        const child = await fs.promises.lstat(path.join(canonicalCandidate, entry.name));
        return { path: childRelative, name: entry.name, kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
          ...(entry.isFile() ? { sizeBytes: child.size } : {}) };
      }));
      return { kind: 'directory', path: apiPath, entries, truncated: allEntries.length > entries.length };
    }
    if (!stat.isFile()) return { kind: 'file', path: apiPath, sizeBytes: stat.size, truncated: false, previewUnavailable: 'special' };
    const maxBytes = 256 * 1024;
    const handle = await fs.promises.open(canonicalCandidate, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) return { kind: 'file', path: apiPath, sizeBytes: stat.size, truncated: stat.size > maxBytes, previewUnavailable: 'binary' };
      return { kind: 'file', path: apiPath, sizeBytes: stat.size, content: content.subarray(0, maxBytes).toString('utf8'), truncated: stat.size > maxBytes };
    } finally {
      await handle.close();
    }
  }
  async isGitRepository(dirPath: string): Promise<boolean> {
    return isGitWorktree(dirPath);
  }

  async resolveIsolationBase(workspacePath: string, projectHint = ''): Promise<IsolationBase> {
    if (await this.isGitRepository(workspacePath)) {
      return { path: workspacePath, kind: 'workspace-git' };
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(workspacePath, { withFileTypes: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Workspace could not be inspected at ${workspacePath}: ${message}`, { cause: error });
    }

    const childDirectories = entries
      .filter((entry) => entry.isDirectory() && !shouldIgnoreEntry(entry.name, DEFAULT_IGNORED_DIRS))
      .map((entry) => path.join(workspacePath, entry.name));
    const repositories: string[] = [];
    for (const candidate of childDirectories) {
      if (await this.isGitRepository(candidate)) repositories.push(candidate);
    }

    if (repositories.length === 0) return { path: workspacePath, kind: 'mirror' };
    if (repositories.length === 1) return { path: repositories[0], kind: 'nested-git' };

    const normalizedHint = normalizeProjectHint(projectHint);
    if (normalizedHint) {
      const ranked = repositories
        .map((candidate) => {
          const normalizedName = normalizeProjectHint(path.basename(candidate));
          return {
            candidate,
            normalizedName,
            score: normalizedName && normalizedHint.includes(normalizedName) ? normalizedName.length : 0,
          };
        })
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate));

      if (ranked.length > 0 && (ranked.length === 1 || ranked[0].score > ranked[1].score)) {
        return { path: ranked[0].candidate, kind: 'nested-git' };
      }
    }

    const names = repositories.map((candidate) => path.basename(candidate)).sort().join(', ');
    throw new Error(
      `Workspace contains multiple Git projects (${names}) and AtrisAgent cannot safely choose one for this Builder task. `
      + 'Mention the project/folder name in the task or open the intended project as the workspace. No cross-project mirror was created.',
    );
  }

  private async resolveGitOwner(worktreePath: string): Promise<string | undefined> {
    try {
      const { stdout } = await git(['rev-parse', '--git-common-dir'], worktreePath);
      const rawCommonDir = stdout.trim();
      if (!rawCommonDir) return undefined;
      const commonDir = path.isAbsolute(rawCommonDir)
        ? path.normalize(rawCommonDir)
        : path.resolve(worktreePath, rawCommonDir);
      if (path.basename(commonDir).toLowerCase() === '.git') return path.dirname(commonDir);
    } catch {
      // The caller retains its explicit fallback path.
    }
    return undefined;
  }

  async resolveMergeBasePath(worktreePath: string, fallbackBasePath: string): Promise<string> {
    if (fs.existsSync(worktreePath) && await this.isGitRepository(worktreePath)) {
      return (await this.resolveGitOwner(worktreePath)) || fallbackBasePath;
    }
    return fallbackBasePath;
  }

  async createWorktree(
    basePath: string,
    branchName: string,
    worktreePath?: string,
    baseBranch: string = 'HEAD',
    projectHint: string = '',
    resolvedBase?: IsolationBase,
  ): Promise<string> {
    const isolationBase = resolvedBase ?? await this.resolveIsolationBase(basePath, projectHint);
    const sourcePath = isolationBase.path;
    const targetPath = worktreePath
      || path.join(sourcePath, '.atris-worktrees', branchName.replace(/[\/\\:]/g, '_'));

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    if (fs.existsSync(targetPath)) return targetPath;

    if (isolationBase.kind !== 'mirror') {
      ensureAtrisGitExcludes(sourcePath);
      let branchExists = false;
      try {
        await git(['rev-parse', '--verify', branchName], sourcePath);
        branchExists = true;
      } catch {
        branchExists = false;
      }

      try {
        if (branchExists) {
          await git(['worktree', 'add', targetPath, branchName], sourcePath);
        } else {
          await git(['worktree', 'add', '-b', branchName, targetPath, baseBranch], sourcePath);
        }
      } catch (error: any) {
        if (!branchExists && baseBranch !== 'HEAD') {
          await git(['worktree', 'add', '-b', branchName, targetPath, 'HEAD'], sourcePath);
        } else {
          const detail = error?.stderr || error?.message || 'git worktree add failed';
          throw new Error(`Could not create Builder worktree from ${sourcePath}: ${detail}`, { cause: error });
        }
      }
      return targetPath;
    }

    try {
      await fs.promises.mkdir(targetPath, { recursive: true });
      await copyDirRecursive(sourcePath, targetPath);
      const baselinePath = path.join(targetPath, '.atris-baseline');
      await copyDirRecursive(sourcePath, baselinePath);
      return targetPath;
    } catch (error) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not create an isolated mirror for ${sourcePath}: ${message}`, { cause: error });
    }
  }

  async removeWorktree(worktreePath: string, force: boolean = true, basePath?: string): Promise<void> {
    const worktreeIsGit = fs.existsSync(worktreePath) && await this.isGitRepository(worktreePath);
    let cwd = basePath || (fs.existsSync(worktreePath) ? worktreePath : process.cwd());
    if (worktreeIsGit) cwd = (await this.resolveGitOwner(worktreePath)) || cwd;
    const isGit = worktreeIsGit || await this.isGitRepository(cwd);

    if (isGit) {
      try {
        await git(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], cwd);
      } catch {
        if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      try {
        await git(['worktree', 'prune'], cwd);
      } catch {
        // Ignore cleanup-only prune failures.
      }
    } else if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  async getChangedFiles(worktreePath: string): Promise<ChangedFile[]> {
    if (!fs.existsSync(worktreePath)) return [];
    const isGit = await this.isGitRepository(worktreePath);

    if (isGit) {
      try {
        const { stdout } = await git(['status', '--porcelain'], worktreePath);
        return stdout.split('\n').filter((line) => line.trim().length > 0).map((line) => {
          const statusLetter = line.substring(0, 2).trim();
          const filePath = line.substring(3).trim();
          let status: ChangedFile['status'] = 'unknown';
          if (statusLetter.includes('A') || statusLetter === '??') status = 'added';
          else if (statusLetter.includes('M')) status = 'modified';
          else if (statusLetter.includes('D')) status = 'deleted';
          else if (statusLetter.includes('R')) status = 'renamed';
          return { path: filePath, status };
        });
      } catch {
        return [];
      }
    }

    const baselineDir = path.join(worktreePath, '.atris-baseline');
    if (!fs.existsSync(baselineDir)) return [];
    const baselineFiles = new Set(getAllFilesRelative(baselineDir));
    const currentFiles = new Set(getAllFilesRelative(worktreePath, worktreePath, new Set([...DEFAULT_IGNORED_DIRS, '.atris-baseline'])));
    const changed: ChangedFile[] = [];

    for (const file of currentFiles) {
      if (!baselineFiles.has(file)) {
        changed.push({ path: file, status: 'added' });
      } else {
        const baseBuf = fs.readFileSync(path.join(baselineDir, file));
        const currBuf = fs.readFileSync(path.join(worktreePath, file));
        if (!baseBuf.equals(currBuf)) changed.push({ path: file, status: 'modified' });
      }
    }
    for (const file of baselineFiles) {
      if (!currentFiles.has(file)) changed.push({ path: file, status: 'deleted' });
    }
    return changed;
  }

  async getDiff(worktreePath: string, targetBranch?: string): Promise<string> {
    if (!fs.existsSync(worktreePath)) return '';
    const isGit = await this.isGitRepository(worktreePath);

    if (isGit) {
      try {
        const { stdout: diffOutput } = await git(targetBranch ? ['diff', targetBranch] : ['diff'], worktreePath);
        const { stdout: cachedOutput } = await git(['diff', '--cached'], worktreePath);
        let combined = diffOutput;
        if (cachedOutput && !combined.includes(cachedOutput)) combined = combined ? `${combined}\n${cachedOutput}` : cachedOutput;
        return combined;
      } catch {
        return '';
      }
    }

    const changedFiles = await this.getChangedFiles(worktreePath);
    const baselineDir = path.join(worktreePath, '.atris-baseline');
    let diffText = '';
    for (const cf of changedFiles) {
      const filePath = cf.path;
      const worktreeFile = path.join(worktreePath, filePath);
      const baselineFile = path.join(baselineDir, filePath);
      diffText += `--- a/${filePath}\n+++ b/${filePath}\n`;
      const oldContent = fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, 'utf-8').split('\n') : [];
      const newContent = fs.existsSync(worktreeFile) ? fs.readFileSync(worktreeFile, 'utf-8').split('\n') : [];
      if (cf.status === 'added') {
        for (const line of newContent) diffText += `+${line}\n`;
      } else if (cf.status === 'deleted') {
        for (const line of oldContent) diffText += `-${line}\n`;
      } else if (cf.status === 'modified') {
        for (const line of oldContent) if (!newContent.includes(line)) diffText += `-${line}\n`;
        for (const line of newContent) if (!oldContent.includes(line)) diffText += `+${line}\n`;
      }
    }
    return diffText;
  }

  async merge(
    worktreePath: string,
    targetBranch?: string,
    basePath?: string,
    operation?: { idempotencyKey?: string },
  ): Promise<{ success: boolean; output: string }> {
    let rootPath = basePath || path.dirname(path.dirname(worktreePath));
    const worktreeIsGit = fs.existsSync(worktreePath) && await this.isGitRepository(worktreePath);
    if (worktreeIsGit) rootPath = (await this.resolveGitOwner(worktreePath)) || rootPath;
    const isGit = worktreeIsGit || await this.isGitRepository(rootPath);

    if (isGit) {
      const operationMarker = operation?.idempotencyKey?.trim()
        ? `AtrisAgent-Operation: ${operation.idempotencyKey.trim()}`
        : undefined;

      try {
        if (targetBranch) {
          const { stdout: currentBranch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], rootPath);
          const current = currentBranch.trim();
          if (current !== targetBranch) {
            return { success: false, output: `Workspace is on branch "${current}"; expected target branch "${targetBranch}".` };
          }
        }

        if (operationMarker) {
          const { stdout: existingOperation } = await git([
            'log', 'HEAD', '--format=%H', '--fixed-strings', `--grep=${operationMarker}`, '-n', '1',
          ], rootPath);
          if (existingOperation.trim()) {
            return { success: true, output: `Merge operation ${operationMarker} was already applied.` };
          }
        }
      } catch (error: any) {
        return { success: false, output: error?.stderr || error?.message || 'Git merge preflight failed' };
      }

      if (fs.existsSync(worktreePath)) {
        try {
          await git(['add', '-A'], worktreePath);
          const { stdout: status } = await git(['status', '--porcelain'], worktreePath);
          if (status.trim().length > 0) {
            await git(['-c', 'user.name=AtrisAgent', '-c', 'user.email=local@atrisagent', 'commit', '-m', 'atris: auto-commit worktree changes before merge'], worktreePath);
          }
        } catch {
          // Merge below will return the actionable failure if the branch is unusable.
        }
      }

      let branchName = '';
      try {
        const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
        branchName = stdout.trim();
      } catch {
        // Handled below.
      }
      if (!branchName || branchName === 'HEAD') return { success: false, output: 'Could not determine worktree branch name' };

      try {
        const { stdout: currentBranch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], rootPath);
        const current = currentBranch.trim();
        if (targetBranch && current !== targetBranch) {
          return { success: false, output: `Workspace is on branch "${current}"; expected target branch "${targetBranch}".` };
        }
        const { stdout: rawRootStatus } = await git(['status', '--porcelain'], rootPath);
        const rootStatus = filterAtrisManagedStatus(rawRootStatus);
        if (rootStatus.trim()) {
          return { success: false, output: 'Main workspace has uncommitted changes. Commit, stash, or discard them before applying an agent worktree.' };
        }
        const { stdout } = await git([
          '-c', 'user.name=AtrisAgent',
          '-c', 'user.email=local@atrisagent',
          'merge', '--no-ff', branchName, '-m', [
            `Merge task worktree ${branchName}`,
            operationMarker,
          ].filter(Boolean).join('\n\n'),
        ], rootPath);
        return { success: true, output: stdout };
      } catch (error: any) {
        return { success: false, output: error?.stderr || error?.message || 'Git merge failed' };
      }
    }

    try {
      const changedFiles = await this.getChangedFiles(worktreePath);
      for (const cf of changedFiles) {
        const srcFile = path.join(worktreePath, cf.path);
        const destFile = path.join(rootPath, cf.path);
        if (cf.status === 'deleted') {
          if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
        } else {
          fs.mkdirSync(path.dirname(destFile), { recursive: true });
          fs.copyFileSync(srcFile, destFile);
        }
      }
      return { success: true, output: `Merged ${changedFiles.length} files to non-git workspace ${rootPath}` };
    } catch (error: any) {
      return { success: false, output: error?.message || 'Non-git merge failed' };
    }
  }
}

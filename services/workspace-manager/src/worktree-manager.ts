import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { isGeneratedWorkspaceDirectory, isGitWorktree } from './git-utils';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
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

export class WorktreeManager {
  /**
   * Check if the directory is a Git repository.
   */
  async isGitRepository(dirPath: string): Promise<boolean> {
    return isGitWorktree(dirPath);
  }

  /**
   * Create an isolated git worktree or non-git mirror for a task.
   */
  async createWorktree(
    basePath: string,
    branchName: string,
    worktreePath?: string,
    baseBranch: string = 'main'
  ): Promise<string> {
    const targetPath =
      worktreePath ||
      path.join(basePath, '.atris-worktrees', branchName.replace(/[\/\\:]/g, '_'));

    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    if (fs.existsSync(targetPath)) {
      return targetPath;
    }

    const isGit = await this.isGitRepository(basePath);

    if (isGit) {
      ensureAtrisGitExcludes(basePath);
      let branchExists = false;
      try {
        await git(['rev-parse', '--verify', branchName], basePath);
        branchExists = true;
      } catch {
        branchExists = false;
      }

      try {
        if (branchExists) {
          await git(['worktree', 'add', targetPath, branchName], basePath);
        } else {
          await git(['worktree', 'add', '-b', branchName, targetPath, baseBranch], basePath);
        }
      } catch (err: any) {
        if (!branchExists && baseBranch !== 'HEAD') {
          await git(['worktree', 'add', '-b', branchName, targetPath, 'HEAD'], basePath);
        } else {
          throw err;
        }
      }
    } else {
      // Non-Git Managed Mirror
      fs.mkdirSync(targetPath, { recursive: true });
      copyDirRecursive(basePath, targetPath);

      // Save a baseline snapshot inside targetPath for diff tracking
      const baselinePath = path.join(targetPath, '.atris-baseline');
      copyDirRecursive(basePath, baselinePath);
    }

    return targetPath;
  }

  /**
   * Remove a worktree directory and prune git worktrees if git.
   */
  async removeWorktree(worktreePath: string, force: boolean = true, basePath?: string): Promise<void> {
    const cwd = basePath || (fs.existsSync(worktreePath) ? worktreePath : process.cwd());
    const isGit = await this.isGitRepository(cwd);

    if (isGit) {
      try {
        await git(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], cwd);
      } catch {
        if (fs.existsSync(worktreePath)) {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
      }

      try {
        await git(['worktree', 'prune'], cwd);
      } catch {
        // Ignore prune errors
      }
    } else {
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    }
  }

  /**
   * Get list of changed files in worktree.
   */
  async getChangedFiles(worktreePath: string): Promise<ChangedFile[]> {
    if (!fs.existsSync(worktreePath)) {
      return [];
    }

    const isGit = await this.isGitRepository(worktreePath);

    if (isGit) {
      try {
        const { stdout } = await git(['status', '--porcelain'], worktreePath);
        const lines = stdout.split('\n').filter((l) => l.trim().length > 0);

        return lines.map((line) => {
          const statusLetter = line.substring(0, 2).trim();
          const filePath = line.substring(3).trim();

          let status: ChangedFile['status'] = 'unknown';
          if (statusLetter.includes('A') || statusLetter === '??') {
            status = 'added';
          } else if (statusLetter.includes('M')) {
            status = 'modified';
          } else if (statusLetter.includes('D')) {
            status = 'deleted';
          } else if (statusLetter.includes('R')) {
            status = 'renamed';
          }

          return { path: filePath, status };
        });
      } catch {
        return [];
      }
    } else {
      // Non-Git comparison against .atris-baseline
      const baselineDir = path.join(worktreePath, '.atris-baseline');
      if (!fs.existsSync(baselineDir)) {
        return [];
      }

      const baselineFiles = new Set(getAllFilesRelative(baselineDir));
      const currentFiles = new Set(getAllFilesRelative(worktreePath, worktreePath, new Set([...DEFAULT_IGNORED_DIRS, '.atris-baseline'])));

      const changed: ChangedFile[] = [];

      for (const file of currentFiles) {
        if (!baselineFiles.has(file)) {
          changed.push({ path: file, status: 'added' });
        } else {
          const baseBuf = fs.readFileSync(path.join(baselineDir, file));
          const currBuf = fs.readFileSync(path.join(worktreePath, file));
          if (!baseBuf.equals(currBuf)) {
            changed.push({ path: file, status: 'modified' });
          }
        }
      }

      for (const file of baselineFiles) {
        if (!currentFiles.has(file)) {
          changed.push({ path: file, status: 'deleted' });
        }
      }

      return changed;
    }
  }

  /**
   * Get unified diff of worktree compared to HEAD or target branch.
   */
  async getDiff(worktreePath: string, targetBranch?: string): Promise<string> {
    if (!fs.existsSync(worktreePath)) {
      return '';
    }

    const isGit = await this.isGitRepository(worktreePath);

    if (isGit) {
      try {
        const { stdout: diffOutput } = await git(targetBranch ? ['diff', targetBranch] : ['diff'], worktreePath);
        const { stdout: cachedOutput } = await git(['diff', '--cached'], worktreePath);

        let combined = diffOutput;
        if (cachedOutput && !combined.includes(cachedOutput)) {
          combined = combined ? `${combined}\n${cachedOutput}` : cachedOutput;
        }

        return combined;
      } catch {
        return '';
      }
    } else {
      // Non-Git line-by-line diff generation
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
          for (const line of newContent) {
            diffText += `+${line}\n`;
          }
        } else if (cf.status === 'deleted') {
          for (const line of oldContent) {
            diffText += `-${line}\n`;
          }
        } else if (cf.status === 'modified') {
          for (const line of oldContent) {
            if (!newContent.includes(line)) {
              diffText += `-${line}\n`;
            }
          }
          for (const line of newContent) {
            if (!oldContent.includes(line)) {
              diffText += `+${line}\n`;
            }
          }
        }
      }

      return diffText;
    }
  }

  /**
   * Merge worktree branch to target branch or basePath.
   */
  async merge(
    worktreePath: string,
    targetBranch: string = 'main',
    basePath?: string
  ): Promise<{ success: boolean; output: string }> {
    const rootPath = basePath || path.dirname(path.dirname(worktreePath));
    const isGit = await this.isGitRepository(rootPath);

    if (isGit) {
      if (fs.existsSync(worktreePath)) {
        try {
          await git(['add', '-A'], worktreePath);
          const { stdout: status } = await git(['status', '--porcelain'], worktreePath);
          if (status.trim().length > 0) {
            await git(['-c', 'user.name=AtrisAgent', '-c', 'user.email=local@atrisagent', 'commit', '-m', 'atris: auto-commit worktree changes before merge'], worktreePath);
          }
        } catch (e) {
          // Ignore
        }
      }

      let branchName = '';
      try {
        const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
        branchName = stdout.trim();
      } catch {
        // Fallback
      }

      if (!branchName || branchName === 'HEAD') {
        return { success: false, output: 'Could not determine worktree branch name' };
      }

      try {
        const { stdout: currentBranch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], rootPath);
        if (currentBranch.trim() !== targetBranch) {
          return { success: false, output: `Workspace is on branch "${currentBranch.trim()}"; expected target branch "${targetBranch}".` };
        }
        const { stdout: rawRootStatus } = await git(['status', '--porcelain'], rootPath);
        const rootStatus = filterAtrisManagedStatus(rawRootStatus);
        if (rootStatus.trim()) {
          return { success: false, output: 'Main workspace has uncommitted changes. Commit, stash, or discard them before applying an agent worktree.' };
        }
        const { stdout } = await git(['merge', '--no-ff', branchName, '-m', `Merge task worktree ${branchName}`], rootPath);
        return { success: true, output: stdout };
      } catch (err: any) {
        return {
          success: false,
          output: err?.stderr || err?.message || 'Git merge failed',
        };
      }
    } else {
      // Non-Git merge: Copy changed files from worktree back to rootPath
      try {
        const changedFiles = await this.getChangedFiles(worktreePath);
        for (const cf of changedFiles) {
          const srcFile = path.join(worktreePath, cf.path);
          const destFile = path.join(rootPath, cf.path);

          if (cf.status === 'deleted') {
            if (fs.existsSync(destFile)) {
              fs.unlinkSync(destFile);
            }
          } else {
            const destDir = path.dirname(destFile);
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true });
            }
            fs.copyFileSync(srcFile, destFile);
          }
        }
        return { success: true, output: `Merged ${changedFiles.length} files to non-git workspace ${rootPath}` };
      } catch (err: any) {
        return { success: false, output: err?.message || 'Non-git merge failed' };
      }
    }
  }
}

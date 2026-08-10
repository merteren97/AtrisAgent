import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Return true only when Git itself confirms that the path is inside a
 * non-bare work tree. The presence of a ".git" entry alone is not enough:
 * parent folders can contain stale or unrelated metadata directories, while
 * linked worktrees use a ".git" file rather than a directory.
 */
export async function isGitWorktree(dirPath: string): Promise<boolean> {
  try {
    const result = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: dirPath, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return String(result.stdout || '').trim() === 'true';
  } catch {
    return false;
  }
}

export function isGeneratedWorkspaceDirectory(name: string): boolean {
  return name === 'target' || name === '.cargo-target' || name.startsWith('.cargo-target-');
}

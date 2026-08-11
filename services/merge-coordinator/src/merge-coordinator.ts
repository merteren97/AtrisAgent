import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import type { ReviewPack, CheckResult } from '@atris-agent-code/domain';
import { ReviewPackGenerator, type GenerateReviewPackOptions } from './review-pack-generator';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface RebaseRequest {
  taskId: string;
  targetBranch: string;
  conflictMessage: string;
  instructions: string;
}

export interface MergeResult {
  success: boolean;
  status: 'Merged' | 'NeedsRebase' | 'Failed';
  output: string;
  checkpointId?: string;
  rebaseRequest?: RebaseRequest;
}

export class MergeCoordinator {
  private generator: ReviewPackGenerator;

  constructor(private workspaceManager: WorkspaceManager) {
    this.generator = new ReviewPackGenerator(workspaceManager);
  }

  /**
   * Generate a unified diff review pack for the task's worktree.
   */
  async generateReviewPack(
    taskId: string,
    options?: GenerateReviewPackOptions
  ): Promise<ReviewPack> {
    return await this.generator.generate(taskId, options);
  }

  /**
   * Apply changes from the task's worktree back to its actual source repository
   * with conflict detection and checkpoint rollback support.
   */
  async applyWorktree(
    taskId: string,
    targetBranch?: string,
  ): Promise<MergeResult> {
    const task = await this.workspaceManager.getTask(taskId);
    if (!task) {
      throw new Error(`Task with ID "${taskId}" not found`);
    }

    if (!task.worktreeId) {
      throw new Error(`Task "${taskId}" does not have an active worktree`);
    }

    const mission = await this.workspaceManager.getMission(task.missionId);
    let workspacePath = process.cwd();
    if (mission?.workspaceId) {
      const ws = await this.workspaceManager.getWorkspace(mission.workspaceId);
      if (ws?.path) {
        workspacePath = ws.path;
      }
    }

    const worktreeManager = this.workspaceManager.getWorktreeManager();
    const mergeBasePath = await worktreeManager.resolveMergeBasePath(task.worktreeId, workspacePath);

    // Step 1: Save pre-merge checkpoint at the repository that actually owns the
    // Builder worktree, not at a non-Git parent project container.
    const checkpointManager = (this.workspaceManager as any).getCheckpointManager();
    const checkpointId = await checkpointManager.createCheckpoint(
      mergeBasePath,
      `pre-merge-task-${taskId}`,
      { missionId: task.missionId, isRollbackTarget: true }
    );

    // Step 2: Attempt merge. Omitting targetBranch means "the source repository's
    // currently checked out branch", so repositories are not forced to use main.
    const mergeOutput = await worktreeManager.merge(task.worktreeId, targetBranch, mergeBasePath);

    // Step 3: Conflict & NeedsRebase detection
    const isConflict =
      !mergeOutput.success &&
      (mergeOutput.output.includes('CONFLICT') ||
        mergeOutput.output.includes('Automatic merge failed') ||
        mergeOutput.output.includes('conflict'));

    if (isConflict) {
      try {
        await execAsync('git merge --abort', { cwd: mergeBasePath });
      } catch {
        // Ignore if git merge abort fails or wasn't git
      }

      const targetLabel = targetBranch || 'current workspace branch';
      return {
        success: false,
        status: 'NeedsRebase',
        output: mergeOutput.output,
        checkpointId,
        rebaseRequest: {
          taskId,
          targetBranch: targetLabel,
          conflictMessage: mergeOutput.output,
          instructions: `Merge conflict detected on task "${taskId}". Rebase the Builder worktree onto the ${targetLabel} and resolve conflicts before re-submitting.`,
        },
      };
    }

    if (!mergeOutput.success) {
      return {
        success: false,
        status: 'Failed',
        output: mergeOutput.output,
        checkpointId,
      };
    }

    return {
      success: true,
      status: 'Merged',
      output: mergeOutput.output,
      checkpointId,
    };
  }

  /**
   * Rollback workspace state to a pre-merge checkpoint.
   */
  async rollback(checkpointId: string, workspacePath: string): Promise<void> {
    const checkpointManager = (this.workspaceManager as any).getCheckpointManager();
    await checkpointManager.restoreCheckpoint(checkpointId, workspacePath);
  }
}

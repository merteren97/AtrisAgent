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
   * Apply changes from the task's worktree back to the main branch with conflict detection and checkpoint rollback support.
   */
  async applyWorktree(
    taskId: string,
    targetBranch: string = 'main'
  ): Promise<MergeResult> {
    const task = await this.workspaceManager.getTask(taskId);
    if (!task) {
      throw new Error(`Task with ID "${taskId}" not found`);
    }

    if (!task.worktreeId) {
      throw new Error(`Task "${taskId}" does not have an active worktree`);
    }

    const mission = await this.workspaceManager.getMission(task.missionId);
    let basePath = process.cwd();
    if (mission?.workspaceId) {
      const ws = await this.workspaceManager.getWorkspace(mission.workspaceId);
      if (ws?.path) {
        basePath = ws.path;
      }
    }

    // Step 1: Save pre-merge checkpoint
    const checkpointManager = (this.workspaceManager as any).getCheckpointManager();
    const checkpointId = await checkpointManager.createCheckpoint(
      basePath,
      `pre-merge-task-${taskId}`,
      { missionId: task.missionId, isRollbackTarget: true }
    );

    // Step 2: Attempt merge
    const worktreeManager = this.workspaceManager.getWorktreeManager();
    const mergeOutput = await worktreeManager.merge(task.worktreeId, targetBranch, basePath);

    // Step 3: Conflict & NeedsRebase detection
    const isConflict =
      !mergeOutput.success &&
      (mergeOutput.output.includes('CONFLICT') ||
        mergeOutput.output.includes('Automatic merge failed') ||
        mergeOutput.output.includes('conflict'));

    if (isConflict) {
      // Abort git merge if in progress
      try {
        await execAsync('git merge --abort', { cwd: basePath });
      } catch {
        // Ignore if git merge abort fails or wasn't git
      }

      return {
        success: false,
        status: 'NeedsRebase',
        output: mergeOutput.output,
        checkpointId,
        rebaseRequest: {
          taskId,
          targetBranch,
          conflictMessage: mergeOutput.output,
          instructions: `Merge conflict detected on task "${taskId}". Rebase worktree branch onto "${targetBranch}" and resolve conflicts before re-submitting.`,
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

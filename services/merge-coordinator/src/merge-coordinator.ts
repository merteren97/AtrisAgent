import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import type { ReviewPack } from '@atris-agent-code/domain';
import { ReviewPackGenerator, type GenerateReviewPackOptions } from './review-pack-generator';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface RebaseRequest {
  taskId: string;
  targetBranch?: string;
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

export interface RollbackContext {
  workspaceId: string;
  missionId: string;
}

export class MergeCoordinator {
  private generator: ReviewPackGenerator;

  constructor(private workspaceManager: WorkspaceManager) {
    this.generator = new ReviewPackGenerator(workspaceManager);
  }

  async generateReviewPack(
    taskId: string,
    options?: GenerateReviewPackOptions
  ): Promise<ReviewPack> {
    return await this.generator.generate(taskId, options);
  }

  /**
   * Apply a Builder worktree back to the repository that actually owns it.
   * A mission workspace may be only a parent project container, so checkpointing
   * and merge operations must resolve the linked worktree's Git owner first.
   */
  async applyWorktree(
    taskId: string,
    targetBranch?: string,
  ): Promise<MergeResult> {
    const task = await this.workspaceManager.getTask(taskId);
    if (!task) throw new Error(`Task with ID "${taskId}" not found`);
    if (!task.worktreeId) throw new Error(`Task "${taskId}" does not have an active worktree`);

    const mission = await this.workspaceManager.getMission(task.missionId);
    if (!mission) throw new Error(`Mission with ID "${task.missionId}" not found for task "${taskId}"`);
    const workspace = await this.workspaceManager.getWorkspace(mission.workspaceId);
    if (!workspace?.path) throw new Error(`Workspace with ID "${mission.workspaceId}" not found for mission "${mission.id}"`);

    const worktreeManager = this.workspaceManager.getWorktreeManager();
    const basePath = await worktreeManager.resolveMergeBasePath(task.worktreeId, workspace.path);

    const checkpointManager = this.workspaceManager.getCheckpointManager();
    const checkpointId = await checkpointManager.createCheckpoint(
      basePath,
      `pre-merge-task-${taskId}`,
      {
        missionId: task.missionId,
        workspaceId: mission.workspaceId,
        isRollbackTarget: true,
      },
    );

    const mergeOutput = await worktreeManager.merge(task.worktreeId, targetBranch, basePath);
    const isConflict = !mergeOutput.success && (
      mergeOutput.output.includes('CONFLICT')
      || mergeOutput.output.includes('Automatic merge failed')
      || mergeOutput.output.toLowerCase().includes('conflict')
    );

    if (isConflict) {
      try {
        await execFileAsync('git', ['merge', '--abort'], { cwd: basePath, windowsHide: true });
      } catch {
        // There may be no in-progress merge to abort.
      }
      const branchLabel = targetBranch || 'the current workspace branch';
      return {
        success: false,
        status: 'NeedsRebase',
        output: mergeOutput.output,
        checkpointId,
        rebaseRequest: {
          taskId,
          targetBranch,
          conflictMessage: mergeOutput.output,
          instructions: `Merge conflict detected on task "${taskId}". Rebase the worktree branch onto ${branchLabel} and resolve conflicts before re-submitting.`,
        },
      };
    }

    if (!mergeOutput.success) {
      return { success: false, status: 'Failed', output: mergeOutput.output, checkpointId };
    }

    return { success: true, status: 'Merged', output: mergeOutput.output, checkpointId };
  }

  async rollback(checkpointId: string, workspacePath: string, context: RollbackContext): Promise<void> {
    const checkpointManager = this.workspaceManager.getCheckpointManager();
    await checkpointManager.restoreCheckpoint(checkpointId, workspacePath, {
      expectedWorkspaceId: context.workspaceId,
      expectedMissionId: context.missionId,
    });
  }
}

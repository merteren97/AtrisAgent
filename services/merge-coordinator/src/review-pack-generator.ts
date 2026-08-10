import fs from 'fs';
import path from 'path';
import type { ReviewPack, ChangedFile, CheckResult } from '@atris-agent-code/domain';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';

export interface GenerateReviewPackOptions {
  builderSummary?: string;
  buildResult?: CheckResult | null;
  testResult?: CheckResult | null;
  lintResult?: CheckResult | null;
  reviewerFindings?: string | null;
  artifacts?: string[];
}

export class ReviewPackGenerator {
  constructor(private workspaceManager: WorkspaceManager) {}

  async generate(taskId: string, options: GenerateReviewPackOptions = {}): Promise<ReviewPack> {
    const task = await this.workspaceManager.getTask(taskId);
    if (!task) {
      throw new Error(`Task with ID "${taskId}" not found`);
    }

    if (!task.worktreeId) {
      throw new Error(`Task "${taskId}" does not have an active worktree`);
    }

    const worktreePath = task.worktreeId;
    const worktreeManager = this.workspaceManager.getWorktreeManager();

    // Fetch changed files and diff
    const rawChangedFiles = await worktreeManager.getChangedFiles(worktreePath);
    const unifiedDiff = await worktreeManager.getDiff(worktreePath);

    // Calculate additions and deletions per changed file
    const changedFiles: ChangedFile[] = rawChangedFiles.map((f) => {
      let additions = 0;
      let deletions = 0;

      // Extract addition/deletion line counts from diff if available
      const fileHeader = `+++ b/${f.path}`;
      if (unifiedDiff.includes(fileHeader)) {
        const fileDiffSection = unifiedDiff.split(`--- a/${f.path}`)[1] || '';
        const lines = fileDiffSection.split('\n');
        for (const line of lines) {
          if (line.startsWith('+') && !line.startsWith('+++')) additions++;
          if (line.startsWith('-') && !line.startsWith('---')) deletions++;
        }
      }

      return {
        path: f.path,
        status: f.status === 'unknown' ? 'modified' : f.status,
        additions,
        deletions,
      };
    });

    // Detect new dependencies by inspecting package.json changes
    const newDependencies: string[] = [];
    const pkgJsonChanged = changedFiles.find((f) => f.path.endsWith('package.json'));
    if (pkgJsonChanged && fs.existsSync(path.join(worktreePath, pkgJsonChanged.path))) {
      try {
        const wtPkg = JSON.parse(fs.readFileSync(path.join(worktreePath, pkgJsonChanged.path), 'utf-8'));
        const baselinePkgPath = path.join(worktreePath, '.atris-baseline', pkgJsonChanged.path);
        const basePkg = fs.existsSync(baselinePkgPath)
          ? JSON.parse(fs.readFileSync(baselinePkgPath, 'utf-8'))
          : { dependencies: {}, devDependencies: {} };

        const baseDeps = { ...basePkg.dependencies, ...basePkg.devDependencies };
        const wtDeps = { ...wtPkg.dependencies, ...wtPkg.devDependencies };

        for (const dep of Object.keys(wtDeps)) {
          if (!baseDeps[dep]) {
            newDependencies.push(`${dep}@${wtDeps[dep]}`);
          }
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Evaluate risky operations
    const riskyOperations: string[] = [];
    for (const f of changedFiles) {
      if (f.path.includes('schema') || f.path.includes('migration') || f.path.endsWith('.sql')) {
        riskyOperations.push(`Database schema/migration file altered: ${f.path}`);
      }
      if (f.status === 'deleted') {
        riskyOperations.push(`File deleted: ${f.path}`);
      }
      if (f.path.includes('config') || f.path.includes('security') || f.path.includes('.env')) {
        riskyOperations.push(`Sensitive configuration modified: ${f.path}`);
      }
      if (f.additions + f.deletions > 200) {
        riskyOperations.push(`Large diff in ${f.path} (${f.additions + f.deletions} lines changed)`);
      }
    }

    return {
      taskId: task.id,
      taskSpecification: `${task.title}: ${task.description}`,
      builderSummary: options.builderSummary || `Completed task "${task.title}" in worktree`,
      changedFiles,
      unifiedDiff,
      buildResult: options.buildResult ?? null,
      testResult: options.testResult ?? null,
      lintResult: options.lintResult ?? null,
      newDependencies,
      riskyOperations,
      artifacts: options.artifacts || [],
      reviewerFindings: options.reviewerFindings ?? null,
    };
  }
}

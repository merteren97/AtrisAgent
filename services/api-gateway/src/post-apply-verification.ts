import fs from 'node:fs';
import path from 'node:path';
import type { PostApplyVerificationContext, PostApplyVerificationResult } from '@atris-agent-code/domain';
import { runCommand } from '@atris-agent-code/runtime-host';

const COMMAND_TIMEOUT_MS = 120_000;
const TOTAL_TIMEOUT_MS = 300_000;
const MAX_EVIDENCE_BYTES = 16 * 1024;

interface WorkspaceLookup {
  getMission(id: string): Promise<{ workspaceId: string } | null>;
  getWorkspace(id: string): Promise<{ path: string } | null>;
  getWorktreeForTask?(id: string): Promise<{ isolationKind?: string | null; targetPath?: string | null } | null>;
  resolveAppliedTargetPath?(taskId: string): Promise<string | null>;
}

type VerificationRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

function bounded(text: unknown): string {
  return String(text || '').trim().slice(0, MAX_EVIDENCE_BYTES);
}

function failureEvidence(error: unknown): string {
  const value = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return bounded(value.stderr || value.stdout || value.message || 'Verification command failed.');
}

interface VerificationCommand {
  command: string;
  args: string[];
  label: string;
}

async function deterministicChecks(workspacePath: string): Promise<VerificationCommand[]> {
  const checks: VerificationCommand[] = [];
  const packagePath = `${workspacePath}/package.json`;
  try {
    const parsed = JSON.parse(await fs.promises.readFile(packagePath, 'utf8')) as { scripts?: Record<string, unknown> };
    const scripts = parsed?.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
    const selected = typeof scripts.check === 'string'
      ? ['check']
      : ['typecheck', 'test'].filter((name) => typeof scripts[name] === 'string');
    for (const script of selected) checks.push({ command: 'npm', args: ['run', script], label: `npm run ${script}` });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`package.json could not be inspected: ${failureEvidence(error)}`);
  }
  try {
    await fs.promises.access(`${workspacePath}/Cargo.toml`, fs.constants.R_OK);
    checks.push({ command: 'cargo', args: ['check'], label: 'cargo check' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cargo.toml could not be inspected: ${failureEvidence(error)}`);
  }
  return checks;
}

/** Verify every distinct project changed by the mission's applied Builder tasks. */
export async function verifyAppliedMission(
  context: PostApplyVerificationContext,
  workspaceManager: WorkspaceLookup,
  runner: VerificationRunner = runCommand,
): Promise<PostApplyVerificationResult> {
  const startedAt = Date.now();
  const mission = await workspaceManager.getMission(context.missionId);
  if (!mission) return { passed: false, summary: 'Mission workspace could not be resolved.', evidence: ['Mission record is missing.'] };
  const workspace = await workspaceManager.getWorkspace(mission.workspaceId);
  if (!workspace?.path) return { passed: false, summary: 'Mission workspace could not be resolved.', evidence: ['Registered workspace is missing.'] };

  const evidence: string[] = [];
  const targets = new Map<string, { path: string; taskIds: string[] }>();
  let failed = false;
  for (const taskId of context.builderTaskIds) {
    let appliedPath: string | null = null;
    try {
      if (workspaceManager.resolveAppliedTargetPath) {
        appliedPath = await workspaceManager.resolveAppliedTargetPath(taskId);
      } else {
        const record = await workspaceManager.getWorktreeForTask?.(taskId);
        if (record?.isolationKind === 'new-sibling') appliedPath = record.targetPath || null;
        else if (record?.isolationKind === 'nested-git') appliedPath = record.targetPath || null;
        else appliedPath = workspace.path;
      }
      if (!appliedPath) throw new Error('No canonical applied target path is available.');

      const canonicalPath = await fs.promises.realpath(path.resolve(appliedPath));
      const stat = await fs.promises.stat(canonicalPath);
      if (!stat.isDirectory()) throw new Error('Applied target is not a directory.');
      const key = process.platform === 'win32' ? canonicalPath.toLocaleLowerCase('en-US') : canonicalPath;
      const target = targets.get(key);
      if (target) target.taskIds.push(taskId);
      else targets.set(key, { path: canonicalPath, taskIds: [taskId] });
    } catch (error) {
      failed = true;
      evidence.push(bounded(`[Builder ${taskId}] target resolution failed\n${failureEvidence(error)}`));
    }
  }

  let timedOut = false;
  for (const target of targets.values()) {
    const targetLabel = `[Target ${target.path}; Builders ${target.taskIds.join(', ')}]`;
    if (TOTAL_TIMEOUT_MS - (Date.now() - startedAt) <= 0) {
      failed = true;
      timedOut = true;
      evidence.push(`${targetLabel} Total verification deadline exceeded.`);
      break;
    }

    let checks: VerificationCommand[];
    try {
      checks = await deterministicChecks(target.path);
    } catch (error) {
      failed = true;
      evidence.push(bounded(`${targetLabel} manifest inspection failed\n${failureEvidence(error)}`));
      continue;
    }
    const probeRemainingMs = TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
    if (probeRemainingMs <= 0) {
      failed = true;
      timedOut = true;
      evidence.push(`${targetLabel} Total verification deadline exceeded.`);
      break;
    }
    try {
      const probe = await runner('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: target.path, timeoutMs: Math.min(COMMAND_TIMEOUT_MS, probeRemainingMs), maxOutputBytes: MAX_EVIDENCE_BYTES,
      });
      if (probe.stdout.trim() === 'true') checks.unshift({ command: 'git', args: ['diff', '--check'], label: 'git diff --check' });
    } catch {
      // A recognized manifest is sufficient for non-Git workspaces.
    }
    if (checks.length === 0) {
      failed = true;
      evidence.push(`${targetLabel} No trusted deterministic checks are available.`);
      continue;
    }

    for (const check of checks) {
      const checkRemainingMs = TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
      if (checkRemainingMs <= 0) {
        failed = true;
        timedOut = true;
        evidence.push(`${targetLabel} Total verification deadline exceeded.`);
        break;
      }
      try {
        const result = await runner(check.command, check.args, {
          cwd: target.path,
          timeoutMs: Math.min(COMMAND_TIMEOUT_MS, checkRemainingMs),
          maxOutputBytes: MAX_EVIDENCE_BYTES,
        });
        const output = bounded([result.stdout, result.stderr].filter(Boolean).join('\n'));
        evidence.push(bounded(`${targetLabel} ${check.label}: passed${output ? `\n${output}` : ''}`));
      } catch (error) {
        failed = true;
        const detail = failureEvidence(error);
        if (/timed out|deadline/i.test(detail)) timedOut = true;
        evidence.push(bounded(`${targetLabel} ${check.label}: failed\n${detail}`));
      }
    }
    if (timedOut && TOTAL_TIMEOUT_MS - (Date.now() - startedAt) <= 0) break;
  }

  if (failed) {
    return {
      passed: false,
      summary: timedOut ? 'Workspace verification timed out.' : 'One or more applied targets are unavailable or failed deterministic verification.',
      evidence,
    };
  }
  return {
    passed: true,
    summary: 'Trusted deterministic checks passed for every applied target.',
    evidence,
  };
}

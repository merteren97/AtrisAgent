import fs from 'node:fs';
import type { PostApplyVerificationContext, PostApplyVerificationResult } from '@atris-agent-code/domain';
import { runCommand } from '@atris-agent-code/runtime-host';

const COMMAND_TIMEOUT_MS = 120_000;
const TOTAL_TIMEOUT_MS = 300_000;
const MAX_EVIDENCE_BYTES = 16 * 1024;

interface WorkspaceLookup {
  getMission(id: string): Promise<{ workspaceId: string } | null>;
  getWorkspace(id: string): Promise<{ path: string } | null>;
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

/** Verify the applied result in the mission's registered base workspace. */
export async function verifyAppliedMission(
  context: PostApplyVerificationContext,
  workspaceManager: WorkspaceLookup,
  runner: VerificationRunner = runCommand,
): Promise<PostApplyVerificationResult> {
  const mission = await workspaceManager.getMission(context.missionId);
  if (!mission) return { passed: false, summary: 'Mission workspace could not be resolved.', evidence: ['Mission record is missing.'] };
  const workspace = await workspaceManager.getWorkspace(mission.workspaceId);
  if (!workspace?.path) return { passed: false, summary: 'Mission workspace could not be resolved.', evidence: ['Registered workspace is missing.'] };

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(workspace.path);
  } catch (error) {
    return { passed: false, summary: 'Registered workspace is unavailable.', evidence: [failureEvidence(error)] };
  }
  if (!stat.isDirectory()) {
    return { passed: false, summary: 'Registered workspace is not a directory.', evidence: [bounded(workspace.path)] };
  }

  let checks: VerificationCommand[];
  try {
    checks = await deterministicChecks(workspace.path);
  } catch (error) {
    return { passed: false, summary: 'Workspace verification manifests are invalid.', evidence: [failureEvidence(error)] };
  }
  try {
    const probe = await runner('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: workspace.path, timeoutMs: Math.min(COMMAND_TIMEOUT_MS, TOTAL_TIMEOUT_MS), maxOutputBytes: MAX_EVIDENCE_BYTES,
    });
    if (probe.stdout.trim() === 'true') checks.unshift({ command: 'git', args: ['diff', '--check'], label: 'git diff --check' });
  } catch {
    // A recognized manifest is sufficient for non-Git workspaces.
  }
  if (checks.length === 0) {
    return {
      passed: false,
      summary: 'No trusted deterministic workspace checks are available.',
      evidence: ['Expected package.json scripts (check, or typecheck/test), Cargo.toml, or a Git worktree.'],
    };
  }

  const startedAt = Date.now();
  const evidence: string[] = [];
  for (const check of checks) {
    const remainingMs = TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return { passed: false, summary: 'Workspace verification timed out.', evidence: [...evidence, 'Total verification deadline exceeded.'] };
    }
    try {
      const result = await runner(check.command, check.args, {
        cwd: workspace.path,
        timeoutMs: Math.min(COMMAND_TIMEOUT_MS, remainingMs),
        maxOutputBytes: MAX_EVIDENCE_BYTES,
      });
      const output = bounded([result.stdout, result.stderr].filter(Boolean).join('\n'));
      evidence.push(bounded(`${check.label}: passed${output ? `\n${output}` : ''}`));
    } catch (error) {
      const detail = failureEvidence(error);
      return {
        passed: false,
        summary: /timed out|deadline/i.test(detail) ? 'Workspace verification timed out.' : 'Workspace deterministic checks failed.',
        evidence: [...evidence, bounded(`${check.label}: failed\n${detail}`)],
      };
    }
  }
  try {
    return {
      passed: true,
      summary: 'Trusted deterministic workspace checks passed.',
      evidence,
    };
  } catch (error) {
    return { passed: false, summary: 'Workspace verification failed.', evidence: [failureEvidence(error)] };
  }
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyAppliedMission } from './post-apply-verification';

const context = { missionId: 'mission-1', planId: 'plan-1', builderTaskIds: ['builder-1'] };

function lookup(workspacePath: string) {
  return {
    getMission: async () => ({ workspaceId: 'workspace-1' }),
    getWorkspace: async () => ({ path: workspacePath }),
  };
}

async function main(): Promise<void> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atris-post-apply-'));
  const actualWorkspace = path.join(root, 'actual workspace');
  await fs.promises.mkdir(actualWorkspace);
  await fs.promises.writeFile(path.join(actualWorkspace, 'package.json'), JSON.stringify({ scripts: { check: 'trusted local check' } }));
  const calls: Array<{ command: string; args: string[]; cwd?: string; timeoutMs?: number; maxOutputBytes?: number }> = [];
  const passingRunner = async (command: string, args: string[], options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number }) => {
    calls.push({ command, args, ...options });
    return { stdout: args[0] === 'rev-parse' ? 'true\n' : args[0] === 'run' ? 'checks passed\n' : '', stderr: '', exitCode: 0 };
  };

  try {
    const passed = await verifyAppliedMission(context, lookup(actualWorkspace), passingRunner);
    assert.equal(passed.passed, true);
    assert.equal(calls.length, 3);
    assert(calls.every((call) => call.cwd === actualWorkspace));
    assert.deepEqual(calls.map((call) => call.args), [
      ['rev-parse', '--is-inside-work-tree'],
      ['diff', '--check'],
      ['run', 'check'],
    ]);
    assert.deepEqual(calls.map((call) => call.command), ['git', 'git', 'npm']);
    assert.match(passed.evidence.join('\n'), /checks passed/);
    assert(calls.every((call) => Number(call.timeoutMs) > 0 && Number(call.maxOutputBytes) > 0));

    const failed = await verifyAppliedMission(context, lookup(actualWorkspace), async (command, args, options) => {
      if (args[0] === 'rev-parse') return passingRunner(command, args, options);
      throw Object.assign(new Error('bad whitespace'), { stderr: 'file.ts:1: trailing whitespace' });
    });
    assert.equal(failed.passed, false);
    assert.match(failed.evidence[0] || '', /trailing whitespace/);

    const nonGitCalls: string[] = [];
    const nonGit = await verifyAppliedMission(context, lookup(actualWorkspace), async (command, args) => {
      nonGitCalls.push(`${command} ${args.join(' ')}`);
      return { stdout: command === 'git' ? 'false\n' : 'manifest check passed', stderr: '', exitCode: 0 };
    });
    assert.equal(nonGit.passed, true);
    assert.deepEqual(nonGitCalls, ['git rev-parse --is-inside-work-tree', 'npm run check']);

    const timedOut = await verifyAppliedMission(context, lookup(actualWorkspace), async (command, args) => {
      if (command === 'git') return { stdout: args[0] === 'rev-parse' ? 'false\n' : '', stderr: '', exitCode: 0 };
      throw new Error('Command timed out after 120000ms: npm');
    });
    assert.equal(timedOut.passed, false);
    assert.match(timedOut.summary, /timed out/);

    const missing = await verifyAppliedMission(context, lookup(path.join(root, 'missing')), passingRunner);
    assert.equal(missing.passed, false);
    assert.match(missing.summary, /unavailable/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
  console.log('post-apply-verification tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

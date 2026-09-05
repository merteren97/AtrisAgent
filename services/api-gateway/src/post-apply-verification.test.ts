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

    const atrisTask = path.join(root, 'AtrisTask');
    await fs.promises.mkdir(atrisTask);
    await fs.promises.writeFile(path.join(atrisTask, 'package.json'), JSON.stringify({ scripts: { check: 'verify new project' } }));
    const siblingCalls: string[] = [];
    const siblingLookup = {
      ...lookup(actualWorkspace),
      getWorktreeForTask: async () => ({ isolationKind: 'new-sibling', targetPath: atrisTask }),
    };
    const siblingResult = await verifyAppliedMission(context, siblingLookup, async (_command, _args, options) => {
      siblingCalls.push(options.cwd);
      return { stdout: 'false\n', stderr: '', exitCode: 0 };
    });
    assert.equal(siblingResult.passed, true);
    assert(siblingCalls.length > 0 && siblingCalls.every((cwd) => cwd === atrisTask), 'new sibling verification cwd resolves to AtrisTask rather than its parent container');

    const nestedProject = path.join(root, 'nested-project');
    const siblingTwo = path.join(root, 'SiblingTwo');
    for (const target of [nestedProject, siblingTwo]) {
      await fs.promises.mkdir(target);
      await fs.promises.writeFile(path.join(target, 'package.json'), JSON.stringify({ scripts: { check: 'verify target' } }));
    }
    const mixedContext = {
      ...context,
      builderTaskIds: ['root-builder', 'nested-builder', 'sibling-builder', 'sibling-two-builder'],
    };
    const appliedTargets = new Map([
      ['root-builder', actualWorkspace],
      ['nested-builder', nestedProject],
      ['sibling-builder', atrisTask],
      ['sibling-two-builder', siblingTwo],
    ]);
    const mixedCalls: string[] = [];
    const mixedResult = await verifyAppliedMission(mixedContext, {
      ...lookup(actualWorkspace),
      resolveAppliedTargetPath: async (taskId: string) => appliedTargets.get(taskId) || null,
    }, async (_command, args, options) => {
      mixedCalls.push(options.cwd);
      return { stdout: args[0] === 'rev-parse' ? 'true\n' : '', stderr: '', exitCode: 0 };
    });
    assert.equal(mixedResult.passed, true);
    assert.deepEqual(new Set(mixedCalls), new Set([actualWorkspace, nestedProject, atrisTask, siblingTwo]));
    assert.equal(mixedCalls.length, 12, 'each root, existing project, and sibling target runs all deterministic checks');
    for (const target of appliedTargets.values()) assert(mixedResult.evidence.some((item) => item.includes(target)), `evidence labels target ${target}`);

    const deduplicatedCalls: string[] = [];
    const deduplicated = await verifyAppliedMission({ ...context, builderTaskIds: ['builder-1', 'builder-2'] }, {
      ...lookup(actualWorkspace),
      resolveAppliedTargetPath: async () => actualWorkspace,
    }, async (_command, args, options) => {
      deduplicatedCalls.push(options.cwd);
      return { stdout: args[0] === 'rev-parse' ? 'true\n' : '', stderr: '', exitCode: 0 };
    });
    assert.equal(deduplicated.passed, true);
    assert.equal(deduplicatedCalls.length, 3, 'duplicate applied paths are verified once');
    assert.match(deduplicated.evidence.join('\n'), /Builders builder-1, builder-2/);

    const failureCalls: string[] = [];
    const oneTargetFailed = await verifyAppliedMission({ ...context, builderTaskIds: ['failing-builder', 'passing-builder'] }, {
      ...lookup(actualWorkspace),
      resolveAppliedTargetPath: async (taskId: string) => taskId === 'failing-builder' ? nestedProject : siblingTwo,
    }, async (command, args, options) => {
      failureCalls.push(options.cwd);
      if (command === 'npm' && options.cwd === nestedProject) throw new Error('nested target check failed');
      return { stdout: args[0] === 'rev-parse' ? 'true\n' : '', stderr: '', exitCode: 0 };
    });
    assert.equal(oneTargetFailed.passed, false);
    assert(failureCalls.includes(siblingTwo), 'verification continues to later targets after one target fails');
    assert(oneTargetFailed.evidence.some((item) => item.includes(nestedProject) && item.includes('failed')));
    assert(oneTargetFailed.evidence.some((item) => item.includes(siblingTwo) && item.includes('passed')));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
  console.log('post-apply-verification tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

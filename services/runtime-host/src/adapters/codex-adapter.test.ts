import assert from 'node:assert/strict';
import type { CodexPermissionMode } from '@atris-agent-code/domain';
import { CodexAdapter, buildCodexExecArgs } from './codex-adapter';
import type { SpawnAgentOptions } from './base-adapter';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
  console.log(`[PASS] ${message}`);
}

assertEqual(
  buildCodexExecArgs(
    { role: 'builder', accessMode: 'workspace-write', model: 'gpt-builder', reasoningLevel: 'high' },
    'Implement the task',
    ['-c', 'mcp_servers.atris.enabled=true'],
  ),
  [
    'exec', '--json', '--sandbox', 'workspace-write',
    '-c', 'approval_policy="never"', '--skip-git-repo-check',
    '-c', 'mcp_servers.atris.enabled=true',
    '--model', 'gpt-builder', '-c', 'model_reasoning_effort="high"',
    'Implement the task',
  ],
  'Builder Codex args explicitly preserve workspace-write, noninteractive approval, model, reasoning, and control-plane configuration',
);

assertEqual(
  buildCodexExecArgs(
    { role: 'researcher', accessMode: 'read-only', model: 'gpt-research', reasoningLevel: 'medium' },
    'Research the task',
  ),
  [
    'exec', '--json', '--sandbox', 'read-only',
    '-c', 'approval_policy="never"', '--skip-git-repo-check',
    '--model', 'gpt-research', '-c', 'model_reasoning_effort="medium"',
    'Research the task',
  ],
  'Researcher Codex args explicitly preserve read-only, noninteractive approval, model, and reasoning configuration',
);

for (const role of ['orchestrator', 'researcher', 'reviewer', 'qa', 'builder', undefined]) {
  const sandbox = role && role !== 'builder' ? 'read-only' : 'workspace-write';
  const expected = ['exec', '--json', '--sandbox', sandbox, '-c', 'approval_policy="never"', '--skip-git-repo-check', 'Task'];
  assertEqual(buildCodexExecArgs({ role }, 'Task'), expected, `${role || 'Default'} role retains existing root permission policy`);
  assertEqual(buildCodexExecArgs({ role, planningControls: {} }, 'Task'), expected, `${role || 'Default'} role with empty planning controls retains existing policy`);
}
assertEqual(
  buildCodexExecArgs({ role: 'orchestrator', accessMode: 'workspace-write' }, 'Task')[3],
  'workspace-write',
  'Existing explicit accessMode still overrides root role defaults',
);

const modes: Array<[CodexPermissionMode, string, string, string]> = [
  ['read-only', 'read-only', 'on-request', 'user'],
  ['ask-for-approval', 'workspace-write', 'on-request', 'user'],
  ['approve-for-me', 'workspace-write', 'on-request', 'auto_review'],
  ['full-access', 'danger-full-access', 'never', 'user'],
];
for (const [mode, sandbox, policy, reviewer] of modes) {
  for (const role of ['researcher', 'orchestrator', 'builder']) {
    const prompt = 'Research only; do not modify content';
    assertEqual(
      buildCodexExecArgs({ role, accessMode: 'read-only', planningControls: { codexPermissionMode: mode }, model: 'chosen-model', reasoningLevel: 'high' }, prompt, ['-c', 'mcp_servers.atris.enabled=true']),
      ['exec', '--json', '--sandbox', sandbox, '-c', `approval_policy="${policy}"`, '-c', `approvals_reviewer="${reviewer}"`, '--skip-git-repo-check', '-c', 'mcp_servers.atris.enabled=true', '--model', 'chosen-model', '-c', 'model_reasoning_effort="high"', prompt],
      `${mode} explicitly overrides ${role} sandbox defaults with exact exec-supported arguments and preserves prompt/config`,
    );
  }
}

for (const value of ['', 'never', 'danger-full-access', 'FULL-ACCESS', 'full-access" --dangerously-bypass-approvals-and-sandbox', null, 1, {}, ['full-access']]) {
  assert.throws(() => buildCodexExecArgs({ planningControls: { codexPermissionMode: value as CodexPermissionMode } }, 'Task'), /^Error: Invalid Codex permission mode\.$/);
}
assertEqual(
  buildCodexExecArgs({ planningControls: { codexPermissionMode: 'read-only', approval_policy: 'never', args: ['--dangerously-bypass-approvals-and-sandbox'] } as SpawnAgentOptions['planningControls'] }, 'Task'),
  ['exec', '--json', '--sandbox', 'read-only', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="user"', '--skip-git-repo-check', 'Task'],
  'Unknown planning control keys cannot inject flags or override approval policy',
);

// Stub only help/capability probes. Every spawn below must reject before launching
// a process or preparing the control plane; no provider/model calls are made.
const adapter = new CodexAdapter();
let help = '--json --sandbox --config --approve-for-me';
let helpCalls = 0;
let capabilityCalls = 0;
(adapter as any).commandHelp = async (args: string[], profileId?: string) => {
  assert.deepEqual(args, ['exec', '--help']);
  assert.equal(profileId, 'test-profile');
  helpCalls++;
  return help;
};
adapter.probeCapabilities = async () => {
  capabilityCalls++;
  return { structuredEventStreaming: true, interactiveApproval: false } as Awaited<ReturnType<CodexAdapter['probeCapabilities']>>;
};
const spawnOptions: SpawnAgentOptions = { taskId: 'task', missionId: 'mission', prompt: 'Task', profileId: 'test-profile' };
await assert.rejects(adapter.spawnAgent({ ...spawnOptions, planningControls: { codexPermissionMode: 'injected' as CodexPermissionMode } }), /Invalid Codex permission mode/);
assert.equal(capabilityCalls, 0, 'Invalid modes fail before discovery or flag construction');
assert.equal(helpCalls, 0);
for (const [mode] of modes) {
  await (adapter as any).assertPlanningPermissionsSupported(mode, 'test-profile');
}
for (const missingHelp of ['', '--json --config', '--json --sandbox']) {
  help = missingHelp;
  for (const [mode] of modes) {
    await assert.rejects(adapter.spawnAgent({ ...spawnOptions, planningControls: { codexPermissionMode: mode } }), /does not expose --sandbox and --config/);
  }
}
help = '--json --sandbox --config';
await assert.rejects(adapter.spawnAgent({ ...spawnOptions, planningControls: { codexPermissionMode: 'approve-for-me' } }), /does not expose --approve-for-me/);
for (const mode of ['read-only', 'ask-for-approval', 'full-access'] as const) {
  await (adapter as any).assertPlanningPermissionsSupported(mode, 'test-profile');
}
await assert.rejects(adapter.respondToApproval(), /configured before the run/);
assert.equal(adapter.isSessionAlive('task'), false);
console.log('[PASS] Planning permissions use help capability probes, fail closed when unsupported, and cannot apply interactive approvals in flight');

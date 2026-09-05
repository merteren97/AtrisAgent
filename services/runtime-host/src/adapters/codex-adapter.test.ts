import { buildCodexExecArgs } from './codex-adapter';

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

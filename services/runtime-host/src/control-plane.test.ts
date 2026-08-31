import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  appendControlPlaneInstructions,
  claudeAllowedMcpTools,
  codexControlPlaneArgs,
  configureRuntimeControlPlaneBridge,
  controlPlaneEnv,
  createAntigravityMcpOverlay,
  createClaudeMcpConfig,
  opencodeControlPlaneConfig,
  prepareControlPlaneSession,
  removeTemporaryDirectory,
} from './control-plane';

async function runTests() {
  console.log('--- Starting Runtime Control Plane Injection Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed += 1;
    } else {
      console.error(`[FAIL] ${message}`);
      failed += 1;
    }
  }

  const secretToken = 'super-secret-session-token';
  const runtimeToken = 'runtime-sidecar-secret';
  configureRuntimeControlPlaneBridge({
    endpoint: 'http://127.0.0.1:3001',
    bridgeScriptPath: path.join(process.cwd(), 'services', 'coordination-mcp', 'src', 'control-plane-bridge.mjs'),
    runtimeToken,
    issueGrant: () => ({ token: secretToken, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  });

  const options: any = {
    sessionId: 'agent-123',
    taskId: 'task-123',
    missionId: 'mission-123',
    prompt: 'Implement the bounded task.',
    role: 'orchestrator',
    cwd: process.cwd(),
  };
  const session = prepareControlPlaneSession(options, options.sessionId)!;
  assert(session.token === secretToken && session.serverName === 'atris' && session.runtimeToken === runtimeToken, 'Runtime grant and sidecar token are attached to the exact Atris agent session');

  const codexArgs = codexControlPlaneArgs(session);
  assert(codexArgs.some((value) => value.includes('mcp_servers.atris.command')), 'Codex receives an Atris MCP server through normal config overrides');
  assert(!codexArgs.join(' ').includes(secretToken), 'Codex command-line arguments never contain the control-plane token');
  assert(controlPlaneEnv(session).ATRIS_CONTROL_PLANE_TOKEN === secretToken, 'Control-plane token is delivered through process environment only');
  assert(controlPlaneEnv(session).ATRIS_RUNTIME_TOKEN === runtimeToken, 'Sidecar runtime token is delivered through process environment only');
  assert(
    Object.keys(controlPlaneEnv(session)).sort().join(',') === 'ATRIS_CONTROL_PLANE_TOKEN,ATRIS_CONTROL_PLANE_URL,ATRIS_RUNTIME_TOKEN',
    'Bridge child receives only the required control-plane and runtime token environment keys',
  );

  const claudeConfig = createClaudeMcpConfig(session);
  try {
    const text = fs.readFileSync(claudeConfig.path!, 'utf8');
    assert(text.includes('mcpServers') && text.includes('control-plane-bridge.mjs'), 'Claude gets a session-local MCP config file');
    assert(!text.includes(secretToken), 'Claude MCP config does not persist the session bearer token');
    assert(claudeAllowedMcpTools().includes('mcp__atris__agent_spawn'), 'Claude explicitly allowlists Atris delegation tools');
  } finally {
    claudeConfig.cleanup();
  }

  const openCodeV1 = JSON.parse(opencodeControlPlaneConfig(session, '1.2.3')!);
  const openCodeV2 = JSON.parse(opencodeControlPlaneConfig(session, '2.0.0')!);
  assert(Boolean(openCodeV1.mcp?.atris?.command), 'OpenCode stable config receives a local Atris MCP server');
  assert(Boolean(openCodeV2.mcp?.servers?.atris?.command), 'OpenCode v2 config receives the v2 local MCP server shape');
  assert(!JSON.stringify(openCodeV1).includes(secretToken) && !JSON.stringify(openCodeV2).includes(secretToken), 'OpenCode inline config never contains the bearer token');

  const overlay = createAntigravityMcpOverlay(session, options.sessionId, process.cwd())!;
  try {
    const text = fs.readFileSync(path.join(overlay.cwd, '.agents', 'mcp_config.json'), 'utf8');
    assert(text.includes('mcpServers') && text.includes('control-plane-bridge.mjs'), 'Antigravity receives Atris MCP through an isolated .agents overlay');
    assert(!text.includes(secretToken), 'Antigravity overlay does not persist the session bearer token');
    assert(overlay.extraArgs[0] === '--add-dir' && overlay.extraArgs[1] === process.cwd(), 'Antigravity overlay exposes only the real assigned task workspace');
  } finally {
    overlay.cleanup();
    overlay.cleanup();
  }
  assert(!fs.existsSync(overlay.cwd), 'Antigravity overlay cleanup is idempotent');

  {
    let attempts = 0;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('temporary-directory retry test timed out')), 5_000);
      removeTemporaryDirectory(path.join(os.tmpdir(), 'atris-ebusy-regression'), () => {
        attempts += 1;
        if (attempts < 3) {
          const error = Object.assign(new Error('directory is still in use'), { code: 'EBUSY' });
          throw error;
        }
        clearTimeout(timeout);
        resolve();
      });
    });
    assert(attempts === 3, 'Windows EBUSY cleanup retries without escaping the teardown callback');
  }

  const prompt = appendControlPlaneInstructions(options.prompt, session, process.cwd());
  assert(prompt.includes('agent_spawn') && prompt.includes('Never attempt to override or impersonate'), 'Native agents receive explicit control-plane usage and identity-boundary guidance');

  configureRuntimeControlPlaneBridge(undefined);

  console.log(`\nRuntime Control Plane Test Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error('Runtime control plane test execution error:', error);
  process.exit(1);
});

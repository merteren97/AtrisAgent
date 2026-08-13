import {
  configureRuntimeControlPlaneBridge,
  prepareControlPlaneSession,
} from './control-plane';

function runTests() {
  let passed = 0;
  let failed = 0;
  const assert = (condition: boolean, message: string) => {
    if (condition) {
      passed += 1;
      console.log(`[PASS] ${message}`);
    } else {
      failed += 1;
      console.error(`[FAIL] ${message}`);
    }
  };

  console.log('--- Supervisor Runtime Boundary Tests ---');
  let grantCalls = 0;
  configureRuntimeControlPlaneBridge({
    endpoint: 'http://127.0.0.1:3001/api/control-plane',
    bridgeScriptPath: '/tmp/atris-control-plane-bridge.js',
    issueGrant: () => {
      grantCalls += 1;
      return { token: 'test-token', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
  });

  const isolatedSupervisor = prepareControlPlaneSession({
    sessionId: 'orchestrator-turn-1',
    taskId: 'turn-1',
    missionId: 'supervisor-conversation-1',
    prompt: 'Decide this turn.',
    role: 'orchestrator',
    enableCoordinationMcp: false,
  }, 'orchestrator-turn-1');
  assert(isolatedSupervisor === undefined, 'supervisor decision run receives no coordination MCP session');
  assert(grantCalls === 0, 'supervisor decision run does not mint a synthetic task grant');

  const worker = prepareControlPlaneSession({
    sessionId: 'researcher-1',
    taskId: 'task-1',
    missionId: 'mission-1',
    prompt: 'Research the issue.',
    role: 'researcher',
    enableCoordinationMcp: true,
  }, 'researcher-1');
  assert(Boolean(worker), 'normal mission worker still receives the configured control-plane session');
  assert(grantCalls === 1, 'normal worker grant issuance remains intact');

  configureRuntimeControlPlaneBridge(undefined);
  console.log(`--- Supervisor Runtime Boundary Tests Complete: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

runTests();

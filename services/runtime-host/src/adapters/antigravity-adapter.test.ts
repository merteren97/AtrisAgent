import nodeAssert from 'node:assert/strict';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AntigravityAdapter, findAntigravityExecutable, resolveAntigravityExecutionMode } from './antigravity-adapter';

async function runTests() {
  console.log('--- Starting Antigravity Adapter Tests ---');
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

  assert(resolveAntigravityExecutionMode('workspace-write') === 'accept-edits', 'maps Builder write access to Antigravity accept-edits mode');
  assert(resolveAntigravityExecutionMode('read-only') === 'plan', 'maps read-only agent access to Antigravity plan mode');
  const installDiscovery = { platform: 'win32', localAppData: 'C:\\Users\\test\\AppData\\Local', lookup: async () => undefined, isFile: async () => true };
  assert(await findAntigravityExecutable(installDiscovery) === 'C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe', 'finds the standard Windows installation when inherited PATH is stale');
  assert(await findAntigravityExecutable({ ...installDiscovery, lookup: async () => 'D:\\tools\\agy.exe' }) === 'D:\\tools\\agy.exe', 'respects an explicit CLI installation on PATH');
  assert(await findAntigravityExecutable({ ...installDiscovery, localAppData: 'relative' }) === undefined, 'rejects relative installation roots');
  assert(await findAntigravityExecutable({ ...installDiscovery, isFile: async () => false }) === undefined, 'does not report a missing executable as installed');
  assert(await findAntigravityExecutable({ ...installDiscovery, isFile: async () => { throw new Error('denied'); } }) === undefined, 'handles unavailable installation directories without crashing installDiscovery');

  const passiveInvocations: string[][] = [];
  const unsupported = new AntigravityAdapter(undefined, {
    getHelpText: async () => 'Options:\n  --version',
    runCommand: async (_command, args = []) => {
      passiveInvocations.push(args || []);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  unsupported.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
  const unsupportedStatus = await unsupported.verifyAuthentication();
  assert(unsupportedStatus === 'error', 'rejects verification when the installed CLI has no structured print mode');
  assert(passiveInvocations.length === 0, 'does not spawn an auth probe when structured print mode is unsupported');
  assert(
    String((unsupported as any).lastVerification?.message).includes('print mode'),
    'returns a clear print-mode compatibility explanation for unsupported verification',
  );

  const supportedInvocations: string[][] = [];
  const supported = new AntigravityAdapter(undefined, {
    getHelpText: async () => 'Options:\n  --print, -p\n  --output-format json\n  --sandbox',
    runCommand: async (_command, args = []) => {
      supportedInvocations.push(args || []);
      return { stdout: '{"model":"gemini-3.7-flash-high","response":"ATRIS_AUTH_OK"}', stderr: '', exitCode: 0 };
    },
  });
  supported.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
  const flow = await supported.beginAuthentication();
  assert(flow.status === 'pending' && Boolean(flow.instructions?.includes('background')), 'prepares existing-session attachment without launching an interactive terminal');
  assert(supportedInvocations.length === 0, 'attachment initiation does not execute an interactive login command');
  assert(await supported.verifyAuthentication() === 'connected', 'accepts authentication confirmed by a successful structured print probe');
  assert(
    JSON.stringify(supportedInvocations) === JSON.stringify([[
      '--print',
      'Reply with exactly ATRIS_AUTH_OK. Do not use tools and do not modify files.',
      '--output-format',
      'json',
      '--sandbox',
    ]]),
    'verification invokes the bounded structured print probe supported by the installed CLI',
  );
  assert((supported as any).lastVerification?.activeModel === 'gemini-3.7-flash-high', 'structured print metadata preserves the active model route');

  const capabilityProbe = new AntigravityAdapter(undefined, {
    getHelpText: async () => 'Options:\n  --print, -p\n  --output-format stream-json\n  --sandbox\n  --mode\n  --print-timeout',
    runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });
  capabilityProbe.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
  const capabilitySnapshot = await capabilityProbe.probeCapabilities();
  assert(capabilitySnapshot.structuredEventStreaming && (capabilityProbe as any).cliOptions.supportsSandbox && (capabilityProbe as any).cliOptions.supportsMode,
    'capability probing uses the injected AGY help output and records supported execution flags');

  async function verifyOutput(stdout: string, exitCode = 0): Promise<string> {
    const adapter = new AntigravityAdapter(undefined, {
      getHelpText: async () => 'Options:\n  --print, -p\n  --output-format json\n  --sandbox',
      runCommand: async () => ({ stdout, stderr: '', exitCode }),
    });
    adapter.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
    return adapter.verifyAuthentication();
  }

  assert(await verifyOutput('{"authenticated":false,"message":"Authenticated account found"}', 1) === 'login_required', 'classifies an authentication failure from a non-zero probe');
  assert(await verifyOutput('connected: false', 1) === 'login_required', 'classifies an explicit disconnected probe');
  assert(await verifyOutput('Session expired. Previously authenticated.', 1) === 'login_required', 'prioritizes expired-session output over positive words');
  assert(await verifyOutput('rate limit exceeded', 1) === 'rate_limited', 'classifies a provider rate limit separately from authentication failure');
  assert(await verifyOutput('Authentication status check completed', 1) === 'error', 'returns error for an ambiguous failed probe');
  assert(await verifyOutput('ATRIS_AUTH_OK') === 'connected', 'treats a successful print probe as a connected CLI session');
  assert(await verifyOutput('') === 'error', 'does not treat an empty successful process as an authenticated session');

  const rejected = new AntigravityAdapter(undefined, {
    getHelpText: async () => 'Options:\n  --print, -p\n  --output-format json\n  --sandbox',
    runCommand: async () => { throw Object.assign(new Error('Authentication required'), { stdout: 'Authentication required' }); },
  });
  rejected.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
  assert(await rejected.verifyAuthentication() === 'login_required', 'classifies a rejected auth probe as login required');

  const modelRows = `
gemini-3.8-flash-high      Gemini 3.8 Flash (High)
gemini-3.8-flash-medium    Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low       Gemini 3.8 Flash (Low)
`;
  let discoveryShouldFail = false;
  const discovery = new AntigravityAdapter(undefined, {
    getHelpText: async () => 'Options:\n  --print, -p\n  --output-format json\n  --sandbox',
    runCommand: async (_command, args = []) => {
      if (discoveryShouldFail) throw Object.assign(new Error('model catalog unavailable'), { stderr: 'temporary AGY failure' });
      assert(args[0] === 'models', 'live model discovery invokes the supported `agy models` command');
      return { stdout: modelRows, stderr: '', exitCode: 0 };
    },
  });
  discovery.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
  const liveFamilies = await (discovery as any).discoverLiveModelFamilies('agy.exe');
  assert(liveFamilies.some((family: any) => family.id === 'gemini-3.8-flash'), 'adapter discovery parses the current Gemini 3.8 table fixture');
  discoveryShouldFail = true;
  const failedFamilies = await (discovery as any).discoverLiveModelFamilies('agy.exe');
  assert(failedFamilies.length === 0 && (discovery as any).liveModelFamilies.length === 0, 'failed model discovery clears the prior live route snapshot');
  let unresolvedRoute = '';
  try {
    await discovery.resolveModelCliRoute('gemini-3.8-flash', 'high');
  } catch (error: any) {
    unresolvedRoute = String(error?.message || error);
  }
  assert(unresolvedRoute.includes('live model catalog is unavailable'), 'stale model routes fail closed after live discovery failure');

  let catalogOutput = modelRows + `
claude-sonnet-4-6          Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking   Claude Opus 4.6 (Thinking)
`;
  let routeHelp = '--print --output-format stream-json --sandbox --mode --model --effort';
  let catalogCalls = 0;
  const spawned: Array<{ args: string[]; child: ChildProcess }> = [];
  const routing = new AntigravityAdapter(undefined, {
    getHelpText: async () => routeHelp,
    runCommand: async (_command, args = []) => {
      nodeAssert.deepEqual(args, ['models'], 'Model preparation only runs the passive catalog command');
      catalogCalls++;
      return { stdout: catalogOutput, stderr: '', exitCode: 0 };
    },
  }, async (_command, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    }) as unknown as ChildProcess;
    spawned.push({ args: [...args], child });
    return child;
  });
  routing.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
  routing.verifyAuthentication = async () => 'connected';
  const routeCases = [
    ['claude-opus-4-6', 'high', 'claude-opus-4-6-thinking'],
    ['claude-sonnet-4-6', 'high', 'claude-sonnet-4-6'],
    ['gemini-3.8-flash', 'low', 'gemini-3.8-flash-low'],
    ['gemini-3.8-flash', 'medium', 'gemini-3.8-flash-medium'],
    ['gemini-3.8-flash', 'high', 'gemini-3.8-flash-high'],
  ] as const;
  for (const [model, reasoning, expected] of routeCases) {
    const prepared = await routing.resolveModelCliRoute(model, reasoning);
    nodeAssert.deepEqual(prepared, { modelRoute: expected, args: ['--model', expected] });
    const session = await routing.spawnAgent({
      model, reasoningLevel: reasoning, missionId: 'fixture-mission', taskId: 'fixture-task',
      prompt: 'Fixture only; no provider is launched.', enableCoordinationMcp: false,
    });
    const { args, child } = spawned[spawned.length - 1];
    try {
      nodeAssert.deepEqual(args.slice(-2), prepared.args, 'Background spawn uses the same route preparation as interactive callers');
      nodeAssert.equal(args.includes('--effort'), false, 'Catalog-encoded reasoning never becomes an effort flag');
      assert(Boolean(session.id), `${model} + ${reasoning} reaches the spawn boundary as ${expected} without --effort`);
    } finally { child.emit('close', 0, null); }
  }
  assert(catalogCalls === 1, 'interactive preparation and background launches reuse the verified live family catalog');
  const beforeRejectedSpawns = spawned.length;
  await nodeAssert.rejects(routing.spawnAgent({ model: 'gemini-3.8-flash-low', reasoningLevel: 'high', missionId: 'fixture', taskId: 'fixture', prompt: 'unused', enableCoordinationMcp: false }), /conflicts with reasoning/);
  await nodeAssert.rejects(routing.resolveModelCliRoute('claude-sonnet-4-6', 'low'), /does not support reasoning/);
  await nodeAssert.rejects(routing.resolveModelCliRoute('missing-model'), /not present in the live model catalog/);
  await nodeAssert.rejects(routing.spawnAgent({ reasoningLevel: 'high', missionId: 'fixture', taskId: 'fixture', prompt: 'unused', enableCoordinationMcp: false }), /does not expose reasoning control/);
  await nodeAssert.rejects(routing.resolveModelCliRoute('antigravity-active-route', 'high'), /does not expose reasoning control/);
  assert(spawned.length === beforeRejectedSpawns, 'contradictory, missing and synthetic-active reasoning selections cannot spawn a process');
  nodeAssert.deepEqual(await routing.resolveModelCliRoute('antigravity-active-route'), { args: [] });
  await routing.spawnAgent({ model: 'antigravity-active-route', missionId: 'fixture', taskId: 'fixture', prompt: 'unused', enableCoordinationMcp: false });
  const activeSpawn = spawned[spawned.length - 1];
  try {
    assert(!activeSpawn.args.includes('--model') && !activeSpawn.args.includes('--effort'), 'the synthetic active route launches without fabricated model or effort flags');
  } finally { activeSpawn.child.emit('close', 0, null); }

  routeHelp = '--print --output-format stream-json --sandbox --mode --model';
  const discoveredModels = await routing.discoverModels('fixture-profile');
  const opus = discoveredModels.find(model => model.runtimeModelId === 'claude-opus-4-6');
  assert(opus?.supportedReasoning[0] === 'high' && opus.defaultReasoning === 'high', 'route-based reasoning remains available without a global --effort capability');
  assert(discoveredModels.find(model => model.runtimeModelId === 'antigravity-active-route')?.supportedReasoning.length === 0, 'live-catalog active route does not advertise unsupported reasoning');
  catalogOutput = '';
  const fallbackModels = await routing.discoverModels('fixture-profile');
  assert(fallbackModels.find(model => model.runtimeModelId === 'antigravity-active-route')?.supportedReasoning.length === 0, 'fallback active route does not advertise unsupported reasoning');
  await routing.shutdown();

  const noisyProbe = new AntigravityAdapter(undefined, {
    getHelpText: async () => 'Options:\n  --print, -p\n  --output-format json\n  --sandbox',
    runCommand: async () => {
      throw Object.assign(new Error('AGY probe failed'), {
        stderr: 'authorization: Bearer secret-token\n' + 'x'.repeat(5_000),
      });
    },
  });
  noisyProbe.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
  assert(await noisyProbe.verifyAuthentication() === 'error', 'bounded authentication diagnostics classify a failed provider probe');
  const noisyMessage = String((noisyProbe as any).lastVerification?.message || '');
  assert(noisyMessage.length <= 1_500 && !noisyMessage.includes('secret-token'), 'authentication diagnostics are bounded and redact bearer credentials');

  console.log(`\nAntigravity adapter tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});

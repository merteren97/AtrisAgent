import { AntigravityAdapter, resolveAntigravityExecutionMode } from './antigravity-adapter';

async function runTests() {
  console.log('--- Starting Antigravity Authentication Probe Tests ---');
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
    await (discovery as any).resolveRequestedModelRoute('agy.exe', 'gemini-3.8-flash', 'high');
  } catch (error: any) {
    unresolvedRoute = String(error?.message || error);
  }
  assert(unresolvedRoute.includes('live model catalog is unavailable'), 'stale model routes fail closed after live discovery failure');

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

  console.log(`\nAntigravity authentication probe tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});

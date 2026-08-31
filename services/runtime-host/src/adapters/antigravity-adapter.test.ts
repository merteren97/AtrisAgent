import { AntigravityAdapter, resolveAntigravityPassiveAuthCommand } from './antigravity-adapter';

async function runTests() {
  console.log('--- Starting Antigravity Passive Authentication Tests ---');
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

  assert(
    JSON.stringify(resolveAntigravityPassiveAuthCommand('Commands:\n  auth status   Show authentication status')) === JSON.stringify(['auth', 'status']),
    'detects an explicitly advertised non-interactive auth status command',
  );
  assert(resolveAntigravityPassiveAuthCommand('Options:\n  --print, -p') === null, 'does not infer passive auth support from print mode');

  const passiveInvocations: string[][] = [];
  const unsupported = new AntigravityAdapter(undefined, {
    getHelpText: async () => 'Options:\n  --print, -p',
    runCommand: async (_command, args) => {
      passiveInvocations.push(args || []);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  unsupported.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
  const unsupportedStatus = await unsupported.verifyAuthentication();
  assert(unsupportedStatus === 'login_required', 'requires interactive setup when no safe passive status command is advertised');
  assert(passiveInvocations.length === 0, 'does not spawn agy print or any auth probe when passive status is unsupported');
  assert(
    String((unsupported as any).lastVerification?.message).includes('interactive setup'),
    'returns a clear interactive-setup explanation for unsupported passive verification',
  );

  const supportedInvocations: string[][] = [];
  const supported = new AntigravityAdapter(undefined, {
    getHelpText: async () => 'Commands:\n  auth status   Show authentication status',
    runCommand: async (_command, args) => {
      supportedInvocations.push(args || []);
      return { stdout: 'Authenticated', stderr: '', exitCode: 0 };
    },
  });
  supported.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
  assert(await supported.verifyAuthentication() === 'connected', 'accepts authentication confirmed by the advertised status command');
  assert(
    JSON.stringify(supportedInvocations) === JSON.stringify([['auth', 'status']]),
    'passive verification invokes only the advertised status command and never print mode',
  );

  async function verifyOutput(stdout: string, exitCode = 0): Promise<string> {
    const adapter = new AntigravityAdapter(undefined, {
      getHelpText: async () => 'Commands:\n  auth status   Show authentication status',
      runCommand: async () => ({ stdout, stderr: '', exitCode }),
    });
    adapter.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
    return adapter.verifyAuthentication();
  }

  assert(await verifyOutput('{"authenticated":false,"message":"Authenticated account found"}') === 'login_required', 'rejects a false authenticated JSON field despite incidental positive text');
  assert(await verifyOutput('connected: false') === 'login_required', 'rejects an explicit false connected field');
  assert(await verifyOutput('Session expired. Previously authenticated.') === 'login_required', 'prioritizes expired-session output over positive words');
  assert(await verifyOutput('Authentication status check completed') === 'error', 'returns error for ambiguous successful output');
  assert(await verifyOutput('{"authenticated":true}') === 'connected', 'accepts a documented true authentication field');
  assert(await verifyOutput('Authenticated') === 'connected', 'accepts an unambiguous positive status response');
  assert(await verifyOutput('Authenticated account found, but status command failed', 1) === 'error', 'never accepts positive incidental text from a non-zero command result');

  const rejected = new AntigravityAdapter(undefined, {
    getHelpText: async () => 'Commands:\n  auth status   Show authentication status',
    runCommand: async () => { throw Object.assign(new Error('status command rejected after reading authenticated account metadata'), { stdout: 'Authenticated account found' }); },
  });
  rejected.discoverInstallation = async () => ({ installed: true, path: 'agy.exe' });
  assert(await rejected.verifyAuthentication() === 'error', 'never accepts positive incidental text from a rejected command');

  console.log(`\nAntigravity passive authentication tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertRuntimeLaunchPreconditions,
  normalizeExecutablePath,
  prepareRuntimeCommand,
  runCommand,
  spawnHiddenChecked,
} from './runtime-utils';

async function runTests() {
  console.log('--- Starting Runtime Command Utility Tests ---');
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

  const decodeBase64 = (value: string | undefined) => Buffer.from(value || '', 'base64').toString('utf8');

  const quotedOpenCode = '"C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\opencode.cmd"';
  assert(
    normalizeExecutablePath(quotedOpenCode) === 'C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\opencode.cmd',
    'normalizes legacy executable paths with wrapping quotes',
  );

  const prepared = prepareRuntimeCommand(
    quotedOpenCode,
    ['serve', '--hostname', '127.0.0.1', '--port', '4096'],
    'win32',
    { ComSpec: 'C:\\untrusted\\cmd.exe', SystemRoot: 'C:\\untrusted-windows' },
  );
  assert(prepared.command === 'powershell.exe', 'routes Windows script shims through the static PowerShell bridge');
  assert(prepared.usesPowerShellBridge === true, 'marks Windows script shims as bridged invocations');
  assert(prepared.args.includes('-EncodedCommand'), 'uses a static encoded PowerShell program instead of a dynamic shell command string');
  assert(
    !prepared.args.join(' ').includes('opencode.cmd') && !prepared.args.join(' ').includes('serve'),
    'does not interpolate executable paths or runtime arguments into PowerShell argv',
  );
  assert(
    decodeBase64(prepared.env?.ATRIS_RUNTIME_COMMAND_B64) === 'C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\opencode.cmd',
    'transfers the normalized wrapper path as an opaque environment value',
  );
  assert(
    JSON.stringify(JSON.parse(decodeBase64(prepared.env?.ATRIS_RUNTIME_ARGS_B64)))
      === JSON.stringify(['serve', '--hostname', '127.0.0.1', '--port', '4096']),
    'transfers runtime argv losslessly through Base64 JSON',
  );
  assert(
    prepared.command !== 'C:\\untrusted\\cmd.exe' && !prepared.args.join(' ').includes('C:\\untrusted-windows'),
    'does not trust caller-controlled ComSpec or SystemRoot values as shell executables',
  );

  const resolutionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-path-resolution-'));
  try {
    fs.writeFileSync(path.join(resolutionRoot, 'atris-cli.cmd'), '@echo off\r\n', 'utf8');
    const resolvedBareCommand = prepareRuntimeCommand(
      'atris-cli',
      ['--version'],
      'win32',
      { Path: resolutionRoot, ComSpec: 'C:\\untrusted\\cmd.exe' },
    );
    assert(resolvedBareCommand.command === 'powershell.exe', 'resolves a bare Windows CLI name before entering the static bridge');
    assert(
      decodeBase64(resolvedBareCommand.env?.ATRIS_RUNTIME_COMMAND_B64).endsWith('atris-cli.cmd'),
      'keeps the resolved PATH shim as an opaque bridge value',
    );
  } finally {
    fs.rmSync(resolutionRoot, { recursive: true, force: true });
  }

  const hostileArguments = [
    'hello&echo injected',
    'left|right',
    'redirect>file',
    '100% complete',
    'caret^value',
    'bang!value',
    'quote"value',
    'trailing\\',
  ];
  const hostilePrepared = prepareRuntimeCommand(
    'C:\\tools\\agent.cmd',
    hostileArguments,
    'win32',
    { ComSpec: 'C:\\untrusted\\cmd.exe' },
  );
  const staticPowerShellArgv = hostilePrepared.args.join(' ');
  assert(
    hostileArguments.every((argument) => !staticPowerShellArgv.includes(argument)),
    'keeps metacharacter-bearing runtime arguments out of the shell program text',
  );
  assert(
    JSON.stringify(JSON.parse(decodeBase64(hostilePrepared.env?.ATRIS_RUNTIME_ARGS_B64))) === JSON.stringify(hostileArguments),
    'preserves hostile-looking arguments as data rather than shell syntax',
  );

  const missingCwd = path.join(os.tmpdir(), `atris-missing-cwd-${crypto.randomUUID()}`);
  try {
    assertRuntimeLaunchPreconditions(process.execPath, missingCwd);
    assert(false, 'rejects a missing runtime working directory before spawning');
  } catch (error: any) {
    assert(
      String(error?.message || error).includes('Runtime working directory is unavailable'),
      'rejects a missing runtime working directory before spawning',
    );
  }

  const missingExecutable = path.join(os.tmpdir(), `atris-missing-runtime-${crypto.randomUUID()}${process.platform === 'win32' ? '.exe' : ''}`);
  try {
    assertRuntimeLaunchPreconditions(missingExecutable, os.tmpdir());
    assert(false, 'rejects stale explicit runtime executable paths before spawning');
  } catch (error: any) {
    assert(
      String(error?.message || error).includes('Runtime executable no longer exists'),
      'rejects stale explicit runtime executable paths before spawning',
    );
  }

  try {
    await spawnHiddenChecked(`atris-runtime-does-not-exist-${crypto.randomUUID()}`, [], { stdio: 'ignore' });
    assert(false, 'converts asynchronous ENOENT into a caught runtime launch failure');
  } catch (error: any) {
    assert(
      /Runtime command|Runtime process could not start/i.test(String(error?.message || error)),
      'converts asynchronous ENOENT into a caught runtime launch failure',
    );
  }

  // Discovery/auth helper commands are expected to return compact metadata. A
  // malfunctioning or hostile CLI must not be able to grow the API process heap
  // without bound before a timeout is reached.
  try {
    await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(32768))'], {
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    assert(false, 'rejects helper commands that exceed the configured stdout capture limit');
  } catch (error: any) {
    assert(error?.code === 'OUTPUT_LIMIT_EXCEEDED' && error?.stream === 'stdout', 'reports deterministic stdout output-limit failure');
    assert(Buffer.byteLength(String(error?.stdout || ''), 'utf8') <= 4_096, 'keeps captured stdout memory within the configured byte limit');
  }

  try {
    await runCommand(process.execPath, ['-e', 'process.stderr.write("e".repeat(32768))'], {
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    assert(false, 'rejects helper commands that exceed the configured stderr capture limit');
  } catch (error: any) {
    assert(error?.code === 'OUTPUT_LIMIT_EXCEEDED' && error?.stream === 'stderr', 'reports deterministic stderr output-limit failure');
    assert(Buffer.byteLength(String(error?.stderr || ''), 'utf8') <= 4_096, 'keeps captured stderr memory within the configured byte limit');
  }

  if (process.platform === 'win32') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris runtime wrapper '));
    const wrapper = path.join(root, 'test wrapper.cmd');
    const printer = path.join(root, 'print-args.cjs');
    fs.writeFileSync(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));', 'utf8');
    fs.writeFileSync(wrapper, '@echo off\r\nnode "%~dp0print-args.cjs" %*\r\n', 'utf8');
    const dangerousArguments = [
      'hello world',
      'hello&echo ATRIS_INJECTED',
      'left|right',
      'redirect>injected.txt',
      '100% complete',
      'caret^value',
      'bang!value',
      'quote"value',
      'trailing\\',
    ];
    try {
      const result = await runCommand(`"${wrapper}"`, dangerousArguments, { cwd: root, timeoutMs: 5_000 });
      const received = JSON.parse(result.stdout.trim()) as string[];
      assert(
        JSON.stringify(received) === JSON.stringify(dangerousArguments),
        'preserves spaces, quotes and command metacharacters as literal .cmd arguments through the static bridge',
      );
      assert(!fs.existsSync(path.join(root, 'injected.txt')), 'does not allow a prompt argument to create a redirected file');
      assert(!result.stdout.includes('\nATRIS_INJECTED'), 'does not execute an injected command separator payload');
    } catch (error: any) {
      console.error('[FAIL] securely executes a quoted .cmd path containing spaces through the static bridge');
      console.error(error?.message || error);
      failed += 1;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } else {
    console.log('[SKIP] live .cmd bridge and metacharacter isolation are covered by the Windows CI job');
  }

  console.log(`\nRuntime command utility tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
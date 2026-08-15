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

  const quotedOpenCode = '"C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\opencode.cmd"';
  assert(
    normalizeExecutablePath(quotedOpenCode) === 'C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\opencode.cmd',
    'normalizes legacy executable paths with wrapping quotes',
  );

  const prepared = prepareRuntimeCommand(
    quotedOpenCode,
    ['serve', '--hostname', '127.0.0.1', '--port', '4096'],
    'win32',
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  );
  assert(prepared.command === 'C:\\Windows\\System32\\cmd.exe', 'routes .cmd wrappers through cmd.exe');
  assert(
    prepared.args[0] === '/d'
      && prepared.args[1] === '/v:off'
      && prepared.args[2] === '/s'
      && prepared.args[3] === '/c',
    'disables AutoRun/delayed expansion and uses cmd.exe strict command parsing',
  );
  assert(prepared.windowsVerbatimArguments === true, 'marks the already escaped cmd.exe command line as verbatim');
  assert(
    prepared.args.at(-1)?.includes('C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\opencode.cmd') === true,
    'keeps the normalized OpenCode wrapper path inside the escaped command line',
  );

  const resolutionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-path-resolution-'));
  try {
    fs.writeFileSync(path.join(resolutionRoot, 'atris-cli.cmd'), '@echo off\r\n', 'utf8');
    const resolvedBareCommand = prepareRuntimeCommand(
      'atris-cli',
      ['--version'],
      'win32',
      { Path: resolutionRoot, ComSpec: 'cmd.exe' },
    );
    assert(resolvedBareCommand.command === 'cmd.exe', 'resolves a bare Windows CLI name to its PATH .cmd shim before spawning');
    assert(resolvedBareCommand.args.at(-1)?.includes('atris-cli.cmd') === true, 'keeps the resolved PATH shim in the prepared command line');
  } finally {
    fs.rmSync(resolutionRoot, { recursive: true, force: true });
  }

  const hostilePrepared = prepareRuntimeCommand(
    'C:\\tools\\agent.cmd',
    ['hello&echo injected', 'left|right', 'redirect>file', '100% complete', 'caret^value', 'bang!value'],
    'win32',
    { ComSpec: 'cmd.exe' },
  );
  const hostileCommandLine = hostilePrepared.args.at(-1) || '';
  assert(hostileCommandLine.includes('^&'), 'escapes command separators in batch-wrapper arguments');
  assert(hostileCommandLine.includes('^|'), 'escapes pipe metacharacters in batch-wrapper arguments');
  assert(hostileCommandLine.includes('^>'), 'escapes redirection metacharacters in batch-wrapper arguments');
  assert(hostileCommandLine.includes('^%'), 'escapes percent expansion in batch-wrapper arguments');
  assert(hostileCommandLine.includes('^^'), 'escapes literal carets in batch-wrapper arguments');
  assert(hostileCommandLine.includes('^!'), 'escapes delayed-expansion metacharacters in batch-wrapper arguments');

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
    // This deliberately mirrors npm-generated .cmd shims: the second command
    // parsing layer expands %*, so prepareRuntimeCommand must double-escape cmd
    // metacharacters before the user arguments reach Node.
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
        'preserves spaces, quotes and cmd.exe metacharacters as literal npm-shim arguments on Windows',
      );
      assert(!fs.existsSync(path.join(root, 'injected.txt')), 'does not allow a prompt argument to create a redirected file');
      assert(!result.stdout.includes('\nATRIS_INJECTED'), 'does not execute an injected command separator payload');
    } catch (error: any) {
      console.error('[FAIL] securely executes a quoted npm-style .cmd path containing spaces on Windows');
      console.error(error?.message || error);
      failed += 1;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } else {
    console.log('[SKIP] live .cmd execution and metacharacter isolation are covered by the Windows CI job');
  }

  console.log(`\nRuntime command utility tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});

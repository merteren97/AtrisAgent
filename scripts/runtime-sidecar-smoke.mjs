import { once } from 'node:events';
import { access, mkdir, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_RUNTIME_DIR = join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'runtime');
const READY_PREFIX = 'ATRIS_RUNTIME_READY ';
const READY_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function parseArgs(argv) {
  const options = { runtimeDir: DEFAULT_RUNTIME_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--runtime-dir') {
      if (!argv[index + 1]) throw new Error('--runtime-dir requires a path.');
      options.runtimeDir = resolve(argv[++index]);
    } else if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/runtime-sidecar-smoke.mjs [--runtime-dir <directory>]');
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function assertFile(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function redact(value, secret) {
  return String(value ?? '').replaceAll(secret, '[redacted]');
}

function boundedOutput(lines, line) {
  if (lines.length >= 256) return;
  lines.push(String(line).slice(0, 4096));
}

function collectLines(stream, onLine) {
  let remainder = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    remainder += chunk;
    const lines = remainder.split(/\r?\n/);
    remainder = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => {
    if (remainder) onLine(remainder);
  });
}

function waitForReady(child, stdoutLines, stderrLines, runtimeToken) {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectReady(new Error(
        `Runtime did not report readiness within ${READY_TIMEOUT_MS}ms. `
          + `stdout=${redact(stdoutLines.join('\n'), runtimeToken)} `
          + `stderr=${redact(stderrLines.join('\n'), runtimeToken)}`,
      ));
    }, READY_TIMEOUT_MS);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    collectLines(child.stdout, (line) => {
      boundedOutput(stdoutLines, line);
      if (!line.startsWith(READY_PREFIX)) return;
      try {
        finish(resolveReady, JSON.parse(line.slice(READY_PREFIX.length)));
      } catch {
        finish(rejectReady, new Error('Runtime ready payload was not valid JSON.'));
      }
    });
    collectLines(child.stderr, (line) => boundedOutput(stderrLines, line));
    child.once('error', (error) => finish(
      rejectReady,
      new Error(`Runtime process failed to start: ${redact(error.message, runtimeToken)}`),
    ));
    child.once('exit', (code, signal) => {
      if (settled) return;
      finish(
        rejectReady,
        new Error(
          `Runtime exited before readiness (code=${code ?? 'null'}, signal=${signal ?? 'null'}). `
            + `stdout=${redact(stdoutLines.join('\n'), runtimeToken)} `
            + `stderr=${redact(stderrLines.join('\n'), runtimeToken)}`,
        ),
      );
    });
  });
}

async function requestHealth(origin, runtimeToken, mode) {
  const headers = mode === 'valid'
    ? { 'X-Atris-Runtime-Token': runtimeToken }
    : undefined;
  const suffix = mode === 'query' ? `?runtimeToken=${encodeURIComponent(runtimeToken)}` : '';
  const response = await fetch(`${origin}/health${suffix}`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });
  return response.status;
}

async function assertPortClosed(origin) {
  const url = new URL(origin);
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Runtime port ${url.port} remained reachable after child shutdown.`);
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime did not exit after shutdown.')), SHUTDOWN_TIMEOUT_MS)),
  ]);
}

export async function runRuntimeSidecarSmoke({ runtimeDir = DEFAULT_RUNTIME_DIR } = {}) {
  const resolvedRuntimeDir = resolve(runtimeDir);
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodePath = join(resolvedRuntimeDir, nodeName);
  const gatewayPath = join(resolvedRuntimeDir, 'gateway.cjs');
  const bridgePath = join(resolvedRuntimeDir, 'control-plane-bridge.mjs');
  await Promise.all([
    assertFile(nodePath, 'Staged Node executable'),
    assertFile(gatewayPath, 'Staged gateway bundle'),
    assertFile(bridgePath, 'Staged control-plane bridge'),
  ]);

  const smokeRoot = join(tmpdir(), `atris-runtime-smoke-${randomBytes(10).toString('hex')}`);
  const dataDir = join(smokeRoot, 'data');
  const runtimeToken = randomBytes(32).toString('hex');
  const stdoutLines = [];
  const stderrLines = [];
  let child;
  let origin;
  try {
    await mkdir(dataDir, { recursive: true });
    child = spawn(nodePath, [gatewayPath], {
      cwd: dataDir,
      env: {
        ...process.env,
        PORT: '0',
        NODE_ENV: 'production',
        ATRIS_RUNTIME_MODE: 'packaged',
        ATRIS_RUNTIME_TOKEN: runtimeToken,
        ATRIS_PARENT_PID: String(process.pid),
        ATRIS_AGENT_DATA_DIR: dataDir,
        ATRIS_CONTROL_PLANE_BRIDGE_PATH: bridgePath,
        ATRIS_AUTH_API_URL: 'http://127.0.0.1:3999',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const ready = await waitForReady(child, stdoutLines, stderrLines, runtimeToken);
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(ready.origin ?? '')) {
      throw new Error('Runtime announced a non-loopback or malformed origin.');
    }
    if (Number(ready.pid) !== child.pid) throw new Error('Ready PID did not match the child process.');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ready.version ?? '')) {
      throw new Error('Runtime announced an invalid version.');
    }
    origin = ready.origin;
    if (await requestHealth(origin, runtimeToken, 'valid') !== 200) {
      throw new Error('Token-protected health did not accept the runtime header.');
    }
    if (await requestHealth(origin, runtimeToken, 'missing') !== 401) {
      throw new Error('Token-protected health accepted a missing header.');
    }
    if (await requestHealth(origin, runtimeToken, 'query') !== 401) {
      throw new Error('Token-protected health accepted a query-string token.');
    }
    console.log(`[AtrisAgent] runtime smoke ready at ${origin}; token-header health=200, missing/query=401`);
  } catch (error) {
    throw new Error(`${redact(error instanceof Error ? error.message : error, runtimeToken)} `
      + `stdout=${redact(stdoutLines.join('\n'), runtimeToken)} `
      + `stderr=${redact(stderrLines.join('\n'), runtimeToken)}`);
  } finally {
    if (child) await terminate(child);
    if (origin) await assertPortClosed(origin);
    const resolvedSmokeRoot = resolve(smokeRoot);
    const resolvedTemp = resolve(tmpdir());
    const relativeSmoke = relative(resolvedTemp, resolvedSmokeRoot);
    if (!relativeSmoke || relativeSmoke.startsWith('..') || isAbsolute(relativeSmoke)) {
      throw new Error('Refusing to remove a smoke directory outside the system temp directory.');
    }
    await rm(resolvedSmokeRoot, { recursive: true, force: true });
  }
  console.log('[AtrisAgent] runtime smoke child cleanup=ok');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options) await runRuntimeSidecarSmoke(options);
}

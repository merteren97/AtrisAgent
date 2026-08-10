import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let stopping = false;

/**
 * Starts npm without directly spawning npm.cmd on Windows.
 *
 * Node.js cannot reliably execute .cmd files with shell:false on Windows and
 * may throw `spawn EINVAL`. npm exposes the JavaScript CLI path through
 * npm_execpath, so the preferred route is:
 *
 *   node <npm-cli.js> <arguments>
 *
 * The shell fallback is only used when the script was not started by npm and
 * npm_execpath is unavailable.
 */
function spawnNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  const commonOptions = {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  };

  if (npmExecPath && /\.(?:c|m)?js$/i.test(npmExecPath)) {
    return spawn(process.execPath, [npmExecPath, ...args], {
      ...commonOptions,
      shell: false,
    });
  }

  if (npmExecPath) {
    return spawn(npmExecPath, args, {
      ...commonOptions,
      shell: process.platform === 'win32',
    });
  }

  return spawn('npm', args, {
    ...commonOptions,
    shell: process.platform === 'win32',
  });
}

function terminateChild(child) {
  if (!child.pid || child.killed) return;

  if (process.platform === 'win32') {
    // npm starts Vite/tsx as child processes. Kill the complete process tree so
    // ports 1420 and 3001 are not left occupied after Tauri is closed.
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  child.kill('SIGTERM');
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;

  for (const child of children) terminateChild(child);

  // Let inherited stdout/stderr flush before ending the beforeDevCommand.
  setTimeout(() => process.exit(code), 250).unref();
}

function startProcess(label, args) {
  const child = spawnNpm(args);
  children.push(child);

  child.on('error', (error) => {
    console.error(`[dev-stack] Failed to start ${label}:`, error);
    stop(1);
  });

  child.on('exit', (code, signal) => {
    if (stopping) return;

    if (signal) {
      console.error(`[dev-stack] ${label} stopped by signal ${signal}.`);
      stop(1);
      return;
    }

    // Both services are required by Tauri dev. If either one exits, stop the
    // remaining process instead of leaving a partial stack running.
    stop(code ?? 0);
  });

  return child;
}

startProcess('API gateway', ['run', 'api-gateway:dev']);
startProcess('Vite desktop dev server', [
  'run',
  'dev',
  '-w',
  '@atris-agent-code/desktop',
]);

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('SIGHUP', () => stop(0));
process.on('uncaughtException', (error) => {
  console.error('[dev-stack] Uncaught error:', error);
  stop(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[dev-stack] Unhandled rejection:', reason);
  stop(1);
});

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { RuntimeType } from '@atris-agent-code/domain';

const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CONFIGURABLE_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PreparedRuntimeCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export function resolveAtrisDataDir(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment.ATRIS_AGENT_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (platform === 'win32' && environment.LOCALAPPDATA) {
    return path.join(environment.LOCALAPPDATA, 'AtrisAgent');
  }
  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Application Support', 'AtrisAgent');
  }
  return path.join(homeDirectory, '.local', 'share', 'AtrisAgent');
}

export function getAtrisDataDir(): string {
  return resolveAtrisDataDir();
}

export function getRuntimeProfileDir(runtimeType: RuntimeType, profileId?: string): string {
  const id = profileId || 'default';
  const dir = path.join(getAtrisDataDir(), 'profiles', runtimeType, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function runtimeProfileEnv(runtimeType: RuntimeType, profileId?: string): NodeJS.ProcessEnv {
  const profileDir = getRuntimeProfileDir(runtimeType, profileId);
  switch (runtimeType) {
    case 'codex':
      return { CODEX_HOME: profileDir };
    case 'claude_code':
      return { CLAUDE_CONFIG_DIR: profileDir };
    case 'opencode':
      return { XDG_DATA_HOME: path.join(profileDir, 'data'), XDG_CONFIG_HOME: path.join(profileDir, 'config') };
    case 'antigravity':
      // Antigravity currently owns credentials through the native OS keyring.
      // Do not claim profile isolation until the installed runtime proves support.
      return {};
  }
  return {};
}

/**
 * Installation discovery must store executable paths as filesystem paths, never
 * as shell fragments. `where.exe` normally returns an unquoted path, but older
 * cached profile metadata and third-party locators may include wrapping quotes.
 */
export function normalizeExecutablePath(rawCommand: string): string {
  const command = rawCommand.trim();
  if (command.length < 2) return command;
  const first = command[0];
  const last = command[command.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return command.slice(1, -1).trim();
  }
  return command;
}

function commandPriority(candidate: string): number {
  const extension = path.extname(normalizeExecutablePath(candidate)).toLowerCase();
  if (extension === '.exe' || extension === '.com') return 0;
  if (extension === '.ps1') return 1;
  if (extension === '.cmd') return 2;
  if (extension === '.bat') return 3;
  return 4;
}

export async function findExecutable(command: string): Promise<string | undefined> {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = await runCommand(locator, [command], { timeoutMs: 5_000 });
    const candidates = result.stdout
      .split(/\r?\n/)
      .map(normalizeExecutablePath)
      .filter(Boolean)
      .filter((candidate, index, values) => values.indexOf(candidate) === index)
      .sort((left, right) => commandPriority(left) - commandPriority(right));

    if (process.platform !== 'win32') return candidates[0];

    // npm/pnpm global shims often expose an extensionless POSIX script first,
    // followed by a .cmd/.ps1 launcher. Windows CreateProcess cannot execute the
    // extensionless shim, so prefer a native executable or a supported wrapper.
    return candidates.find((candidate) => {
      const extension = path.extname(candidate).toLowerCase();
      return ['.exe', '.com', '.ps1', '.cmd', '.bat'].includes(extension) && fs.existsSync(candidate);
    }) || candidates.find((candidate) => fs.existsSync(candidate));
  } catch {
    return undefined;
  }
}

const CMD_META_CHARACTERS = new Set([
  '(', ')', '[', ']', '%', '!', '^', '"', '`', '<', '>', '&', '|', ';', ',', ' ', '*', '?',
]);

function escapeCmdMetaCharacters(value: string): string {
  return [...value]
    .map((character) => CMD_META_CHARACTERS.has(character) ? `^${character}` : character)
    .join('');
}

/**
 * Quote one Windows argv value before cmd.exe sees it. Backslashes immediately
 * before quotes/end-of-argument follow the standard CreateProcess/CRT quoting
 * rules; cmd metacharacters are then caret-escaped so user prompt content cannot
 * become a second command, pipe, redirect, variable expansion, or wildcard.
 *
 * This follows the same proven escaping model used by cross-spawn 7.x, but is
 * kept local so runtime-host does not need a shell-execution dependency.
 */
function escapeBatchArgument(value: string, doubleEscapeMetaCharacters = false): string {
  let escaped = '';
  let pendingBackslashes = 0;

  for (const character of String(value)) {
    if (character === '\\') {
      pendingBackslashes += 1;
      continue;
    }

    if (character === '"') {
      escaped += '\\'.repeat(pendingBackslashes * 2 + 1);
      escaped += '"';
      pendingBackslashes = 0;
      continue;
    }

    escaped += '\\'.repeat(pendingBackslashes);
    pendingBackslashes = 0;
    escaped += character;
  }

  escaped += '\\'.repeat(pendingBackslashes * 2);
  escaped = `"${escaped}"`;
  escaped = escapeCmdMetaCharacters(escaped);
  if (doubleEscapeMetaCharacters) escaped = escapeCmdMetaCharacters(escaped);
  return escaped;
}

function isNpmStyleCmdShim(command: string): boolean {
  const normalized = command.replace(/\//g, '\\').toLowerCase();
  if (/\\node_modules\\\.bin\\[^\\]+\.cmd$/.test(normalized) || /\\npm\\[^\\]+\.cmd$/.test(normalized)) {
    return true;
  }
  try {
    const prefix = fs.readFileSync(command, 'utf8').slice(0, 4_096);
    return /%\*/.test(prefix) && /(?:node(?:\.exe)?|node_modules)/i.test(prefix);
  } catch {
    return false;
  }
}

function resolveWindowsExecutableSync(command: string, env: NodeJS.ProcessEnv): string {
  // A path supplied by discovery/profile metadata is already authoritative.
  if (/[\\/]/.test(command) || path.extname(command)) return command;

  const pathValue = env.Path || env.PATH || env.path || process.env.Path || process.env.PATH || '';
  if (!pathValue) return command;
  const directories = pathValue
    .split(';')
    .map(normalizeExecutablePath)
    .filter(Boolean);
  const extensions = ['.exe', '.com', '.ps1', '.cmd', '.bat'];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue searching the remaining PATH entries/extensions.
      }
    }
  }
  return command;
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

/**
 * Fail before Node creates a ChildProcess when a cached executable path or the
 * assigned workspace disappeared. This turns Windows ENOENT crashes into a
 * deterministic runtime error that RuntimeHost can surface to the mission.
 */
export function assertRuntimeLaunchPreconditions(command: string, cwd?: string): void {
  if (cwd) {
    try {
      if (!fs.statSync(cwd).isDirectory()) {
        throw new Error(`Runtime working directory is not a directory: ${cwd}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Runtime working directory')) throw error;
      throw new Error(`Runtime working directory is unavailable: ${cwd}`);
    }
  }

  const normalizedCommand = normalizeExecutablePath(command);
  if (!normalizedCommand) throw new Error('Runtime executable is empty. Refresh the runtime connection and try again.');
  if (!hasPathSeparator(normalizedCommand) && !path.isAbsolute(normalizedCommand)) return;
  try {
    if (!fs.statSync(normalizedCommand).isFile()) {
      throw new Error(`Runtime executable is not a file: ${normalizedCommand}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Runtime executable')) throw error;
    throw new Error(`Runtime executable no longer exists: ${normalizedCommand}. Refresh the account/runtime connection and try again.`);
  }
}

export function describeRuntimeLaunchError(command: string, error: unknown, cwd?: string): string {
  const details = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  if (code === 'ENOENT' || /\bENOENT\b/i.test(details)) {
    return hasPathSeparator(normalizeExecutablePath(command))
      ? `Runtime executable or working directory is unavailable while starting ${normalizeExecutablePath(command)}${cwd ? ` in ${cwd}` : ''}. Refresh the runtime connection and verify the project folder still exists.`
      : `Runtime command "${command}" is no longer available in PATH${cwd ? ` for ${cwd}` : ''}. Refresh the runtime connection and verify the CLI installation.`;
  }
  return `Runtime process could not start (${command}): ${details}`;
}

/**
 * Prepare a process invocation without enabling Node's `shell` mode. Keeping
 * this function deterministic and platform-parameterized lets CI validate the
 * exact Windows argv even when the main quality job runs on Linux.
 */
export function prepareRuntimeCommand(
  rawCommand: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): PreparedRuntimeCommand {
  const normalizedCommand = normalizeExecutablePath(rawCommand);
  const command = platform === 'win32'
    ? resolveWindowsExecutableSync(normalizedCommand, env)
    : normalizedCommand;
  if (platform !== 'win32') return { command, args };

  const extension = path.extname(command).toLowerCase();
  if (extension === '.ps1') {
    return {
      command: env.SystemRoot
        ? path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
    };
  }

  if (extension === '.cmd' || extension === '.bat') {
    // .cmd/.bat files require cmd.exe on Windows. Build one already-escaped
    // command line and use windowsVerbatimArguments so Node does not quote it a
    // second time. /v:off prevents delayed ! expansion inside prompt content.
    const doubleEscape = extension === '.cmd' && isNpmStyleCmdShim(command);
    const shellCommand = [
      escapeCmdMetaCharacters(command),
      ...args.map((argument) => escapeBatchArgument(argument, doubleEscape)),
    ].join(' ');
    return {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', `"${shellCommand}"`],
      windowsVerbatimArguments: true,
    };
  }

  return { command, args };
}

function resolveCommandOutputLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
  return Math.min(MAX_CONFIGURABLE_COMMAND_OUTPUT_BYTES, Math.max(1_024, Math.floor(value)));
}

function appendWithinByteLimit(current: string, chunk: Buffer | string, usedBytes: number, limitBytes: number): {
  value: string;
  usedBytes: number;
  exceeded: boolean;
} {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  const remaining = Math.max(0, limitBytes - usedBytes);
  if (buffer.length <= remaining) {
    return {
      value: current + buffer.toString('utf8'),
      usedBytes: usedBytes + buffer.length,
      exceeded: false,
    };
  }

  return {
    value: current + (remaining > 0 ? buffer.subarray(0, remaining).toString('utf8') : ''),
    usedBytes: limitBytes,
    exceeded: true,
  };
}

export async function runCommand(
  command: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    input?: string;
    maxOutputBytes?: number;
  } = {},
): Promise<CommandResult> {
  assertRuntimeLaunchPreconditions(command, options.cwd);
  const environment = { ...process.env, ...options.env };
  const prepared = prepareRuntimeCommand(command, args, process.platform, environment);
  const maxOutputBytes = resolveCommandOutputLimit(options.maxOutputBytes);

  return new Promise<CommandResult>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(prepared.command, prepared.args, {
      cwd: options.cwd,
      env: environment,
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const failForOutputLimit = (stream: 'stdout' | 'stderr') => {
      if (!child.killed) child.kill('SIGKILL');
      finish(() => {
        const failure = Object.assign(
          new Error(`Command ${stream} exceeded the ${maxOutputBytes}-byte capture limit: ${command}`),
          {
            code: 'OUTPUT_LIMIT_EXCEEDED',
            stream,
            stdout,
            stderr,
            exitCode: 1,
          },
        );
        reject(failure);
      });
    };

    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      finish(() => {
        const failure = Object.assign(new Error(`Command timed out after ${options.timeoutMs ?? 15_000}ms: ${command}`), {
          stdout,
          stderr,
          exitCode: 1,
        });
        reject(failure);
      });
    }, options.timeoutMs ?? 15_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      const next = appendWithinByteLimit(stdout, chunk, stdoutBytes, maxOutputBytes);
      stdout = next.value;
      stdoutBytes = next.usedBytes;
      if (next.exceeded) failForOutputLimit('stdout');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const next = appendWithinByteLimit(stderr, chunk, stderrBytes, maxOutputBytes);
      stderr = next.value;
      stderrBytes = next.usedBytes;
      if (next.exceeded) failForOutputLimit('stderr');
    });
    child.on('error', (error) => finish(() => reject(Object.assign(new Error(describeRuntimeLaunchError(command, error, options.cwd)), { cause: error, stdout, stderr, exitCode: 1 }))));
    child.on('close', (code) => finish(() => {
      const result = { stdout, stderr, exitCode: code ?? 1 };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(stderr || stdout || `${command} failed`), result));
    }));

    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

export async function getHelpText(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  for (const args of [['--help'], ['help']]) {
    try {
      const result = await runCommand(command, args, { env, timeoutMs: 8_000 });
      if (result.stdout || result.stderr) return `${result.stdout}\n${result.stderr}`;
    } catch (error: any) {
      const text = `${error?.stdout || ''}\n${error?.stderr || ''}`.trim();
      if (text) return text;
    }
  }
  return '';
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForHttp(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
}

export async function launchInteractiveTerminal(
  command: string,
  args: string[] = [],
  options: { cwd?: string; title?: string } = {},
): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const title = options.title || 'AtrisAgent Runtime';

  if (process.platform === 'win32') {
    const quoteCmd = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const quotePs = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const safeTitle = title.replace(/[&|<>^]/g, '').trim() || 'AtrisAgent Runtime';
    const normalizedCommand = normalizeExecutablePath(command);
    const extension = path.extname(normalizedCommand).toLowerCase();
    const executable = extension === '.ps1'
      ? ['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', normalizedCommand, ...args].map(quoteCmd).join(' ')
      : [quoteCmd(normalizedCommand), ...args.map(quoteCmd)].join(' ');
    const commandLine = `title ${safeTitle} && ${/\.(?:cmd|bat)$/i.test(normalizedCommand) ? 'call ' : ''}${executable}`;
    const script = `Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/k',${quotePs(commandLine)}) -WorkingDirectory ${quotePs(cwd)}`;
    const launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    launcher.unref();
    return;
  }

  if (process.platform === 'darwin') {
    const shellCommand = [command, ...args].map((value) => `'${value.replace(/'/g, `'\\''`)}'`).join(' ');
    const script = `tell application "Terminal" to do script "cd ${cwd.replace(/"/g, '\\"')} && ${shellCommand.replace(/"/g, '\\"')}"`;
    const launcher = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    launcher.unref();
    return;
  }

  const terminals: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', command, ...args]],
    ['gnome-terminal', ['--', command, ...args]],
    ['konsole', ['-e', command, ...args]],
    ['xterm', ['-e', command, ...args]],
  ];
  for (const [terminal, terminalArgs] of terminals) {
    const terminalPath = await findExecutable(terminal);
    if (!terminalPath) continue;
    const launcher = spawn(terminalPath, terminalArgs, { cwd, detached: true, stdio: 'ignore' });
    launcher.unref();
    return;
  }
  throw new Error('No supported terminal emulator was found for the interactive authentication flow.');
}

export function spawnHidden(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
  assertRuntimeLaunchPreconditions(command, cwd);
  const environment = { ...process.env, ...options.env };
  const prepared = prepareRuntimeCommand(command, args, process.platform, environment);
  const child = spawn(prepared.command, prepared.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments ?? options.windowsVerbatimArguments,
    shell: false,
    env: environment,
  });
  // Node treats an unobserved child-process `error` event as fatal. Runtime
  // adapters attach their own listeners when they need diagnostics, while this
  // baseline listener guarantees that a missing optional CLI cannot terminate
  // the entire local API service.
  child.on('error', () => undefined);
  return child;
}

/**
 * Wait until the operating system confirms that the process was spawned. Agent
 * adapters should use this before emitting `agent_started`; otherwise Windows
 * ENOENT can leave a ghost running agent in the UI even though no process exists.
 */
export async function spawnHiddenChecked(command: string, args: string[], options: SpawnOptions = {}): Promise<ChildProcess> {
  const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
  let child: ChildProcess;
  try {
    child = spawnHidden(command, args, options);
  } catch (error) {
    throw new Error(describeRuntimeLaunchError(command, error, cwd), { cause: error });
  }

  return await new Promise<ChildProcess>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onSpawn = () => finish(() => resolve(child));
    const onError = (error: Error) => finish(() => reject(new Error(describeRuntimeLaunchError(command, error, cwd), { cause: error })));
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(x-api-key\s*[:=]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?code)\s*[:=]\s*)[^\s,"']+/gi, '$1[REDACTED]');
}

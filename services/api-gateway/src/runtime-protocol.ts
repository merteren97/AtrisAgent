import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveAtrisDataDir } from '@atris-agent-code/runtime-host';

export const RUNTIME_READY_PREFIX = 'ATRIS_RUNTIME_READY ';
export const RUNTIME_TOKEN_HEADER = 'X-Atris-Runtime-Token';
export const DEFAULT_GATEWAY_PORT = 3001;

export type RuntimeTokenFailure = 'missing' | 'invalid' | 'query';

export interface RuntimeTokenCheck {
  ok: boolean;
  failure?: RuntimeTokenFailure;
}

export interface RuntimeReadyInfo {
  origin: string;
  pid: number;
  version: string;
}

export interface GatewayDataPath {
  dataDir: string;
  dbPath: string;
  usedLegacyPath: boolean;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function runtimeTokenFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = environment.ATRIS_RUNTIME_TOKEN;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Compare the complete token without making its length observable through
 * timingSafeEqual's same-length precondition.
 */
export function runtimeTokenMatches(expected: string, provided: string | null | undefined): boolean {
  if (typeof provided !== 'string') return false;
  return timingSafeEqual(digest(expected), digest(provided));
}

function queryContainsRuntimeToken(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://127.0.0.1');
  } catch {
    return false;
  }

  for (const key of parsed.searchParams.keys()) {
    const normalized = key.replace(/[-_]/g, '').toLowerCase();
    if (normalized === 'runtimetoken' || normalized === 'xatrisruntimetoken') return true;
  }
  return false;
}

function headerValue(headers: Record<string, string | string[] | undefined>): string | null {
  const value = headers['x-atris-runtime-token'];
  if (Array.isArray(value)) return value[0] || null;
  return typeof value === 'string' ? value : null;
}

export function authorizeRuntimeToken(
  expected: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  url?: string,
): RuntimeTokenCheck {
  if (!expected) return { ok: true };
  if (queryContainsRuntimeToken(url)) return { ok: false, failure: 'query' };
  const provided = headerValue(headers);
  if (!provided) return { ok: false, failure: 'missing' };
  return runtimeTokenMatches(expected, provided)
    ? { ok: true }
    : { ok: false, failure: 'invalid' };
}

function rejectRuntimeToken(response: Response): void {
  response.status(401).json({
    error: 'Unauthorized: local runtime token is missing or invalid.',
    code: 'RUNTIME_TOKEN_REQUIRED',
  });
}

/** Install before all HTTP routes; CORS handles OPTIONS before this gate. */
export function createRuntimeTokenMiddleware(expected: string | undefined) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.method === 'OPTIONS') {
      next();
      return;
    }
    const check = authorizeRuntimeToken(expected, request.headers, request.originalUrl || request.url);
    if (!check.ok) {
      rejectRuntimeToken(response);
      return;
    }
    next();
  };
}

export function resolveGatewayPort(value: string | undefined = process.env.PORT): number {
  if (value === undefined || value.trim() === '') return DEFAULT_GATEWAY_PORT;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : DEFAULT_GATEWAY_PORT;
}

export function gatewayOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function gatewayVersion(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.ATRIS_AGENT_VERSION || environment.npm_package_version || '0.2.0';
}

export function shouldAutoStartGateway(
  environment: NodeJS.ProcessEnv = process.env,
  executablePath: string | undefined = process.argv[1],
): boolean {
  return environment.ATRIS_RUNTIME_MODE === 'packaged'
    || Boolean(executablePath && /(?:^|[\\/])index\.(?:ts|[cm]?js)$/i.test(executablePath));
}

export function formatRuntimeReadyLine(info: RuntimeReadyInfo): string {
  return `${RUNTIME_READY_PREFIX}${JSON.stringify(info)}`;
}

const emittedReadyServers = new WeakSet<Server>();

export function emitRuntimeReady(
  server: Server,
  version: string = gatewayVersion(),
  log: (line: string) => void = console.log,
): RuntimeReadyInfo | undefined {
  if (!server.listening || emittedReadyServers.has(server)) return undefined;
  const address = server.address();
  if (!address || typeof address === 'string') return undefined;
  const info: RuntimeReadyInfo = {
    origin: gatewayOrigin((address as AddressInfo).port),
    pid: process.pid,
    version,
  };
  emittedReadyServers.add(server);
  log(formatRuntimeReadyLine(info));
  return info;
}

function legacyGatewayDataDir(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): string {
  if (platform === 'win32') {
    const roaming = environment.APPDATA || path.join(homeDirectory, 'AppData', 'Roaming');
    return path.join(roaming, 'AtrisAgent');
  }
  if (platform === 'darwin') return path.join(homeDirectory, 'Library', 'Application Support', 'AtrisAgent');
  return path.join(homeDirectory, '.config', 'AtrisAgent');
}

/**
 * New installs share the runtime-host data root. If the old gateway DB exists
 * in its APPDATA location, keep reading it in place; migration is deliberately
 * not attempted by the packaged runtime.
 */
export function resolveGatewayDataPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
  exists: (filePath: string) => boolean = fs.existsSync,
): GatewayDataPath {
  const dataDir = resolveAtrisDataDir(environment, platform, homeDirectory);
  const preferredPath = path.join(dataDir, 'atris.db');
  if (environment.ATRIS_AGENT_DATA_DIR?.trim()) {
    return { dataDir, dbPath: preferredPath, usedLegacyPath: false };
  }

  const legacyPath = path.join(legacyGatewayDataDir(environment, platform, homeDirectory), 'atris.db');
  if (legacyPath !== preferredPath && exists(legacyPath) && !exists(preferredPath)) {
    return { dataDir, dbPath: legacyPath, usedLegacyPath: true };
  }
  return { dataDir, dbPath: preferredPath, usedLegacyPath: false };
}

export interface ParentWatchdogOptions {
  environment?: NodeJS.ProcessEnv;
  intervalMs?: number;
  isAlive?: (pid: number) => boolean;
  onParentExit?: () => void;
}

function parseParentPid(environment: NodeJS.ProcessEnv): number | undefined {
  const value = environment.ATRIS_PARENT_PID?.trim();
  if (!value) return undefined;
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid ? pid : undefined;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts only when an explicit parent PID is supplied (never in normal dev/tests). */
export function startParentWatchdog(options: ParentWatchdogOptions = {}): () => void {
  const environment = options.environment || process.env;
  const parentPid = parseParentPid(environment);
  if (!parentPid) return () => undefined;

  const isAlive = options.isAlive || defaultIsAlive;
  const onParentExit = options.onParentExit || (() => process.exit(0));
  let stopped = false;
  const check = () => {
    if (stopped) return;
    if (!isAlive(parentPid)) {
      stopped = true;
      clearInterval(timer);
      onParentExit();
    }
  };
  const timer = setInterval(check, Math.max(250, options.intervalMs || 2_000));
  timer.unref?.();
  check();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

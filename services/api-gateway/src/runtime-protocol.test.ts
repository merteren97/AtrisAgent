import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  authorizeRuntimeToken,
  createRuntimeTokenMiddleware,
  emitRuntimeReady,
  formatRuntimeReadyLine,
  gatewayVersion,
  gatewayOrigin,
  resolveGatewayDataPath,
  resolveGatewayPort,
  runtimeTokenMatches,
  shouldAutoStartGateway,
  startParentWatchdog,
} from './runtime-protocol';

async function runTests(): Promise<void> {
  assert.equal(runtimeTokenMatches('runtime-secret', 'runtime-secret'), true, 'runtime token comparison accepts the exact header value');
  assert.equal(runtimeTokenMatches('runtime-secret', 'runtime-secret-other'), false, 'runtime token comparison rejects a wrong value');
  assert.equal(authorizeRuntimeToken(undefined, {}).ok, true, 'runtime token gate is disabled when the env value is absent');
  assert.equal(authorizeRuntimeToken('runtime-secret', {}).failure, 'missing', 'runtime token gate rejects a missing header');
  assert.equal(
    authorizeRuntimeToken('runtime-secret', { 'x-atris-runtime-token': 'runtime-secret' }).ok,
    true,
    'runtime token gate accepts the exact header value',
  );
  assert.equal(
    authorizeRuntimeToken('runtime-secret', { 'x-atris-runtime-token': 'runtime-secret' }, '/health?runtimeToken=runtime-secret').failure,
    'query',
    'runtime token query parameters are rejected even when the header is valid',
  );

  const api = express();
  api.use(createRuntimeTokenMiddleware('runtime-secret'));
  api.get('/health', (_request, response) => response.json({ status: 'ok' }));
  const server = await new Promise<http.Server>((resolve) => {
    const instance = http.createServer(api);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Runtime protocol test server did not expose an address.');
  const baseUrl = gatewayOrigin(address.port);
  try {
    const missing = await fetch(`${baseUrl}/health`);
    assert.equal(missing.status, 401, 'runtime token middleware protects health without a header');
    const wrong = await fetch(`${baseUrl}/health`, { headers: { 'X-Atris-Runtime-Token': 'wrong' } });
    assert.equal(wrong.status, 401, 'runtime token middleware rejects a wrong header');
    const query = await fetch(`${baseUrl}/health?runtimeToken=runtime-secret`, { headers: { 'X-Atris-Runtime-Token': 'runtime-secret' } });
    assert.equal(query.status, 401, 'runtime token middleware rejects query transport');
    const valid = await fetch(`${baseUrl}/health`, { headers: { 'X-Atris-Runtime-Token': 'runtime-secret' } });
    assert.equal(valid.status, 200, 'runtime token middleware accepts the exact header');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  assert.equal(resolveGatewayPort(undefined), 3001, 'unset PORT keeps the development default');
  assert.equal(resolveGatewayPort('0'), 0, 'PORT=0 is preserved for packaged dynamic binding');
  assert.equal(resolveGatewayPort('not-a-port'), 3001, 'invalid PORT falls back to the safe default');
  assert.equal(gatewayVersion({ ATRIS_AGENT_VERSION: '1.4.7' }), '1.4.7', 'packaged version comes from ATRIS_AGENT_VERSION');
  assert.equal(gatewayVersion({}), '0.2.0', 'development version keeps the package fallback');
  assert.equal(shouldAutoStartGateway({ ATRIS_RUNTIME_MODE: 'packaged' }, 'gateway.cjs'), true, 'packaged CJS entry explicitly auto-starts the gateway');
  assert.equal(shouldAutoStartGateway({}, 'gateway.cjs'), false, 'arbitrary CJS imports do not auto-start the gateway in tests');
  const readyLine = formatRuntimeReadyLine({ origin: gatewayOrigin(4567), pid: 123, version: '0.2.0' });
  assert.equal(readyLine.startsWith('ATRIS_RUNTIME_READY '), true, 'ready line uses the frozen machine-readable prefix');
  assert.deepEqual(JSON.parse(readyLine.slice('ATRIS_RUNTIME_READY '.length)), {
    origin: 'http://127.0.0.1:4567',
    pid: 123,
    version: '0.2.0',
  }, 'ready line JSON contains only origin, pid and version');
  assert.equal(readyLine.includes('runtime-secret'), false, 'ready line never includes runtime token material');

  const readyServer = http.createServer();
  const readyLog: string[] = [];
  await new Promise<void>((resolve) => readyServer.listen(0, '127.0.0.1', () => resolve()));
  const ready = emitRuntimeReady(readyServer, '0.2.0', (line) => readyLog.push(line));
  assert.equal(ready?.origin.startsWith('http://127.0.0.1:'), true, 'ready helper reports the actual dynamic loopback port');
  assert.equal(readyLog.length, 1, 'ready helper emits one machine line');
  assert.equal(emitRuntimeReady(readyServer, '0.2.0', (line) => readyLog.push(line)), undefined, 'ready helper does not duplicate its machine line');
  await new Promise<void>((resolve, reject) => readyServer.close((error) => error ? reject(error) : resolve()));

  let parentExitCalls = 0;
  const stopWatchdog = startParentWatchdog({
    environment: { ATRIS_PARENT_PID: '4242' },
    intervalMs: 250,
    isAlive: () => false,
    onParentExit: () => { parentExitCalls += 1; },
  });
  stopWatchdog();
  assert.equal(parentExitCalls, 1, 'parent watchdog exits through its callback when the parent is gone');
  let disabledCalls = 0;
  const stopDisabledWatchdog = startParentWatchdog({
    environment: {},
    isAlive: () => { disabledCalls += 1; return false; },
    onParentExit: () => { disabledCalls += 1; },
  });
  stopDisabledWatchdog();
  assert.equal(disabledCalls, 0, 'parent watchdog remains disabled for normal dev/test environments');

  const root = path.join(os.tmpdir(), `atris-runtime-protocol-${crypto.randomUUID()}`);
  const configured = resolveGatewayDataPath({ ATRIS_AGENT_DATA_DIR: root }, process.platform, os.homedir(), () => true);
  assert.equal(configured.dataDir, path.resolve(root), 'configured data root is normalized to an absolute path');
  assert.equal(configured.dbPath, path.join(path.resolve(root), 'atris.db'), 'configured database stays beneath ATRIS_AGENT_DATA_DIR');
  assert.equal(configured.usedLegacyPath, false, 'explicit data root never falls back to the legacy APPDATA location');
  const legacyEnv = {
    LOCALAPPDATA: path.join(root, 'local'),
    APPDATA: path.join(root, 'roaming'),
  };
  const legacyDb = path.join(legacyEnv.APPDATA, 'AtrisAgent', 'atris.db');
  // APPDATA/LOCALAPPDATA are the Windows legacy locations; keep this assertion
  // deterministic when the shared gateway suite runs on Linux/macOS CI.
  const legacy = resolveGatewayDataPath(legacyEnv, 'win32', os.homedir(), (candidate) => candidate === legacyDb);
  assert.equal(legacy.dbPath, legacyDb, 'existing legacy database remains readable without being moved');
  assert.equal(legacy.usedLegacyPath, true, 'legacy database fallback is explicit for migration safety');

  console.log('Runtime protocol tests passed.');
}

runTests().catch((error) => {
  console.error('Runtime protocol test execution error:', error);
  process.exit(1);
});

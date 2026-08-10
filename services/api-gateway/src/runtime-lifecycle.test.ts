import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {
  createRuntimeShutdownCoordinator,
  installRuntimeShutdownRoute,
} from './runtime-lifecycle';

async function listen(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = await new Promise<http.Server>((resolve) => {
    const instance = http.createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Runtime lifecycle test server did not expose an address.');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function runTests(): Promise<void> {
  let stopRuntimeHostCalls = 0;
  let clearControlPlaneCalls = 0;
  let closeServerCalls = 0;
  let closeDatabaseCalls = 0;
  let completedReason = '';
  const coordinator = createRuntimeShutdownCoordinator({
    stopRuntimeHost: async () => { stopRuntimeHostCalls += 1; },
    clearControlPlane: () => { clearControlPlaneCalls += 1; },
    closeServer: () => { closeServerCalls += 1; },
    closeDatabase: () => { closeDatabaseCalls += 1; },
  }, {
    onComplete: (reason) => { completedReason = reason; },
  });

  const first = coordinator.shutdown('test-signal');
  const second = coordinator.shutdown('duplicate-signal');
  assert.strictEqual(first, second, 'concurrent shutdown requests share one promise');
  await first;
  assert.equal(completedReason, 'test-signal', 'the first shutdown reason is preserved');
  assert.equal(stopRuntimeHostCalls, 1, 'RuntimeHost cleanup runs once');
  assert.equal(clearControlPlaneCalls, 1, 'control-plane cleanup runs once');
  assert.equal(closeServerCalls, 1, 'HTTP server cleanup runs once');
  assert.equal(closeDatabaseCalls, 1, 'database cleanup runs once');
  await coordinator.shutdown('after-complete');
  assert.equal(stopRuntimeHostCalls, 1, 'later shutdown requests do not repeat cleanup');

  const app = express();
  const routeCoordinator = createRuntimeShutdownCoordinator();
  assert.equal(installRuntimeShutdownRoute(app, 'runtime-secret', routeCoordinator), true, 'protected runtime registers shutdown route');
  const running = await listen(app);
  try {
    let response = await fetch(`${running.baseUrl}/api/internal/runtime/shutdown`, { method: 'POST' });
    assert.equal(response.status, 401, 'shutdown route rejects a missing runtime token');
    response = await fetch(`${running.baseUrl}/api/internal/runtime/shutdown`, {
      method: 'POST',
      headers: { 'X-Atris-Runtime-Token': 'wrong' },
    });
    assert.equal(response.status, 401, 'shutdown route rejects a wrong runtime token');
    response = await fetch(`${running.baseUrl}/api/internal/runtime/shutdown`, {
      method: 'POST',
      headers: { 'X-Atris-Runtime-Token': 'runtime-secret' },
    });
    assert.equal(response.status, 202, 'shutdown route accepts the exact runtime token');
    await routeCoordinator.shutdown('test-await');
  } finally {
    if (running.server.listening) await close(running.server);
  }

  const unprotected = express();
  assert.equal(installRuntimeShutdownRoute(unprotected, undefined, routeCoordinator), false, 'shutdown route is absent without a runtime token');
  const unprotectedServer = await listen(unprotected);
  try {
    const response = await fetch(`${unprotectedServer.baseUrl}/api/internal/runtime/shutdown`, { method: 'POST' });
    assert.equal(response.status, 404, 'development runtimes cannot invoke shutdown through an absent route');
  } finally {
    await close(unprotectedServer.server);
  }

  console.log('Runtime lifecycle tests passed.');
}

runTests().catch((error) => {
  console.error('Runtime lifecycle test execution error:', error);
  process.exit(1);
});

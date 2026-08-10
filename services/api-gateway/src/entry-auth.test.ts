import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

async function runTests(): Promise<void> {
  const hubCalls: string[] = [];
  const hubServer = http.createServer((req, res) => {
    hubCalls.push(req.headers.authorization || '');
    if (req.headers.authorization === 'Bearer integration-premium-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        user: { id: 'integration-user', email: 'integration@example.test' },
        membership: { status: 'active', plan: 'Premium' },
        entitlement: { product: 'AtrisAgent', status: 'active', plan: 'Premium' },
      }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
  });
  await new Promise<void>((resolve) => hubServer.listen(0, '127.0.0.1', () => resolve()));
  const hubAddress = hubServer.address() as AddressInfo;

  process.env.ATRIS_AUTH_API_URL = `http://127.0.0.1:${hubAddress.port}`;
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.ATRIS_RUNTIME_TOKEN = 'entry-runtime-secret';
  process.env.ATRIS_AGENT_VERSION = '1.4.7';
  process.env.ATRIS_AGENT_DATA_DIR = path.join(os.tmpdir(), `atris-entry-auth-test-${process.pid}`);
  delete process.env.ATRIS_PARENT_PID;
  delete process.env.ATRIS_RUNTIME_MODE;

  const gateway = await import('./entry');
  const { grants } = gateway;
  const { server } = await import('./index');
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Gateway did not expose a TCP address.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const jsonRequest = (token: string | null, path: string, body?: unknown) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Atris-Runtime-Token': 'entry-runtime-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || { tool: 'workspace_get_rules', arguments: {} }),
  });

  try {
    let response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 401, 'runtime token protects health when the sidecar header is missing');
    response = await fetch(`${baseUrl}/health`, { headers: { 'X-Atris-Runtime-Token': 'wrong-runtime-secret' } });
    assert.equal(response.status, 401, 'runtime token rejects a wrong sidecar header');
    response = await fetch(`${baseUrl}/health?runtimeToken=entry-runtime-secret`, { headers: { 'X-Atris-Runtime-Token': 'entry-runtime-secret' } });
    assert.equal(response.status, 401, 'runtime token query transport is rejected');
    response = await fetch(`${baseUrl}/health`, { headers: { 'X-Atris-Runtime-Token': 'entry-runtime-secret' } });
    assert.equal(response.status, 200, 'runtime token allows health with the exact sidecar header');
    const healthBody = await response.json() as Record<string, unknown>;
    assert.equal(healthBody.version, '1.4.7', 'health reports the packaged ATRIS_AGENT_VERSION');
    response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":',
    });
    assert.equal(response.status, 401, 'runtime token rejects malformed JSON before the parser when the sidecar header is missing');
    assert.equal(hubCalls.length, 0, 'runtime token rejects login before contacting AtrisHub');
    response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atris-Runtime-Token': 'entry-runtime-secret' },
      body: '{"email":',
    });
    assert.equal(response.status, 400, 'the correct runtime token reaches the JSON parser for malformed payloads');
    const oversizedBody = JSON.stringify({ payload: 'x'.repeat(2 * 1024 * 1024 + 1) });
    response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedBody,
    });
    assert.equal(response.status, 401, 'runtime token rejects oversized JSON before the parser when the sidecar header is missing');

    const issued = grants.issue({
      agentInstanceId: 'entry-test-agent',
      missionId: 'entry-test-mission',
      taskId: 'entry-test-task',
      role: 'orchestrator',
    });

    response = await jsonRequest(issued.token, '/api/internal/control-plane/call');
    let body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, 'entry control-plane route accepts a valid grant without Hub validation');
    assert.equal(body.ok, true, 'entry control-plane route returns a successful tool result');
    assert.equal(hubCalls.length, 0, 'valid control-plane grants never call AtrisHub');

    response = await jsonRequest(null, '/api/internal/control-plane/call');
    body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 401, 'missing control-plane grants remain unauthorized');
    assert.equal(body.ok, false, 'missing control-plane grants use the registry error response');
    assert.equal(hubCalls.length, 0, 'missing control-plane grants never call AtrisHub');

    response = await jsonRequest('definitely-not-a-control-plane-grant', '/api/internal/control-plane/call');
    assert.equal(response.status, 401, 'invalid control-plane grants remain unauthorized');
    assert.equal(hubCalls.length, 0, 'invalid control-plane grants never call AtrisHub');

    response = await jsonRequest('integration-premium-token', '/api/internal/control-plane/call');
    assert.equal(response.status, 401, 'an AtrisHub bearer token cannot substitute for a control-plane grant');
    assert.equal(hubCalls.length, 0, 'Hub bearer tokens are not sent to AtrisHub on the control-plane route');

    response = await jsonRequest(issued.token, '/api/internal/control-plane/call/extra');
    assert.equal(response.status, 401, 'control-plane exemption does not match prefixed sibling paths');
    assert.equal(hubCalls.length, 1, 'prefixed sibling paths remain behind the Hub gate');

    grants.revokeAgent('entry-test-agent');
    response = await jsonRequest(issued.token, '/api/internal/control-plane/call');
    assert.equal(response.status, 401, 'revoked control-plane grants cannot be replayed');
    assert.equal(hubCalls.length, 1, 'revoked grants never call AtrisHub');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => hubServer.close((error: Error | undefined) => error ? reject(error) : resolve()));
  }

  console.log('API Gateway entry auth integration tests passed.');
}

runTests().catch((error) => {
  console.error('API Gateway entry auth integration test execution error:', error);
  process.exit(1);
});

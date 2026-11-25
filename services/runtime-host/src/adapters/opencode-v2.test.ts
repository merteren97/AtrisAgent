import assert from 'node:assert/strict';
import http from 'node:http';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import { OpenCodeAdapter } from './opencode-adapter';
import { hasOpenCodeConnections, isOpenCodeV2, v2FormAnswer, v2ModelRef, v2Models, v2Questions, v2Reasoning } from './opencode-v2';
import { stripPowerShellClixml } from '../runtime-utils';

// 1. Unit tests for opencode-v2 helpers
assert.equal(isOpenCodeV2('opencode v2.4.1'), true);
assert.equal(isOpenCodeV2('2.0.0'), true);
assert.equal(isOpenCodeV2('1.4.0'), false);
assert.equal(isOpenCodeV2(undefined), false);

assert.deepEqual(v2ModelRef('google/gemini-4-neon', 'high'), {
  providerID: 'google',
  id: 'gemini-4-neon',
  variant: 'high',
});
assert.deepEqual(v2ModelRef('openai/gpt-6.2-sol#medium'), {
  providerID: 'openai',
  id: 'gpt-6.2-sol',
});
assert.throws(() => v2ModelRef('invalid-model'));

const parsedModels = v2Models({
  data: [
    { id: 'gemini-4-neon', providerID: 'google', name: 'Gemini 4 Neon', enabled: true, variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'unknown' }] },
    { id: 'disabled-model', providerID: 'google', enabled: false },
  ],
});
assert.equal(parsedModels.length, 1);
assert.deepEqual(v2Reasoning(parsedModels[0]), ['low', 'medium', 'high']);

assert.equal(hasOpenCodeConnections([{ id: 'google', connections: [{ type: 'credential', method: 'key' }] }]), true);
assert.equal(hasOpenCodeConnections([{ id: 'openai', connections: [{ type: 'credential', method: 'oauth' }, { type: 'env', name: 'OPENAI_API_KEY' }] }]), true);
assert.equal(hasOpenCodeConnections([{ id: 'openai', connections: [{ type: 'credential', status: { status: 'needs_auth' } }] }]), false);
assert.equal(hasOpenCodeConnections([{ id: 'xai', connections: [] }]), false);

const fields = [
  { key: 'mode', type: 'string', title: 'Mode', options: [{ value: 'fast', label: 'Fast' }, { value: 'safe', label: 'Safe' }] },
  { key: 'confirm', type: 'boolean', title: 'Confirm' },
  { key: 'retries', type: 'integer', title: 'Retries' },
];
const qs = v2Questions(fields, 'Setup');
assert.equal(qs?.length, 3);
assert.deepEqual(v2FormAnswer(fields, [['Fast'], ['true'], ['3']]), { mode: 'fast', confirm: true, retries: 3 });

// 2. CLIXML stripping defense
const dirty = '#< CLIXML ERROR Unrecognized flag: --refresh in command opencode models <Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><AV>Preparing modules for first use.</AV></MS></Obj></Objs>';
assert.equal(stripPowerShellClixml(dirty), 'ERROR Unrecognized flag: --refresh in command opencode models');
assert.equal(stripPowerShellClixml('plain output'), 'plain output');

// 3. Mock OpenCode v2.4.1 HTTP + SSE server integration test
async function testV2AdapterAgainstMockServer(): Promise<void> {
  let modelCalls = 0;
  let integrationCalls = 0;
  const recordedRequests: Array<{ method: string; url: string; body: any }> = [];
  let sseResponse: http.ServerResponse | undefined;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    recordedRequests.push({ method: req.method || 'GET', url: req.url || '/', body });

    // Unprefixed paths return SPA HTML in OpenCode v2.4.1!
    if (!req.url?.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>SPA</body></html>');
      return;
    }
    if (req.url === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '2.4.1', pid: 1234 }));
      return;
    }
    if (req.url === '/api/model') {
      modelCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Simulate initial empty hydration on call 1, hydrated models on call 2
      res.end(JSON.stringify({
        location: { directory: process.cwd() },
        data: modelCalls === 1 ? [] : [
          {
            id: 'gemini-4-neon',
            providerID: 'google',
            name: 'Gemini 4 Neon',
            enabled: true,
            variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
            capabilities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 1048576, output: 65536 },
          },
        ],
      }));
      return;
    }
    if (req.url === '/api/integration') {
      integrationCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        location: { directory: process.cwd() },
        data: integrationCalls === 1 ? [] : [{ id: 'google', connections: [{ type: 'credential', method: 'key' }] }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'ses_v2_test' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: {"id":"evt_0","type":"server.connected","data":{}}\n\n');
      sseResponse = res;
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_v2_test/prompt') {
      // OpenCode v2 /prompt enforces additionalProperties: false and only accepts { text, ... }
      assert.deepEqual(Object.keys(body), ['text']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'msg_1' } }));
      setTimeout(() => {
        sseResponse?.write(`data: ${JSON.stringify({ type: 'session.text.delta', data: { sessionID: 'ses_v2_test', delta: 'Hi v2' } })}\n\n`);
        sseResponse?.write(`data: ${JSON.stringify({ type: 'form.created', data: { form: { id: 'frm_9', sessionID: 'ses_v2_test', title: 'Approve', fields: [{ key: 'ok', type: 'boolean', title: 'Continue?' }] } } })}\n\n`);
      }, 20);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_v2_test/permission/perm_1/reply') {
      assert.deepEqual(body, { decision: 'once' });
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_v2_test/form/frm_9/reply') {
      assert.deepEqual(body, { answer: { ok: true } });
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_v2_test/interrupt') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ interrupted: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const eventBus = new LocalEventBus();
  const events: any[] = [];
  eventBus.on('*', (e) => { events.push(e); });

  const adapter = new OpenCodeAdapter(eventBus);
  const fakeProcess = { exitCode: null, killed: false, pid: undefined } as any;
  const mockServer = {
    key: 'default::mock',
    profileId: 'default',
    cwd: process.cwd(),
    url: `http://127.0.0.1:${port}`,
    username: 'opencode',
    password: 'secret',
    process: fakeProcess,
    version: '2.4.1',
    diagnostics: '',
  };
  (adapter as any).servers.set(mockServer.key, mockServer);
  (adapter as any).ensureServer = async () => mockServer;
  (adapter as any).discoverInstallation = async () => ({ installed: true, path: 'opencode', version: 'opencode v2.4.1' });

  try {
    // Hydration retry on /api/model + clean routeLabel (no mojibake '?')
    const descriptors = await adapter.discoverModels('default');
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0].runtimeModelId, 'google/gemini-4-neon');
    assert.equal(descriptors[0].routeLabel, 'OpenCode · google');
    assert.deepEqual(descriptors[0].supportedReasoning, ['low', 'medium', 'high']);
    assert.equal(modelCalls, 2);

    // Hydration retry on /api/integration
    const authStatus = await adapter.verifyAuthentication('default');
    assert.equal(authStatus, 'connected');
    assert.equal(integrationCalls, 2);

    // Spawn agent using v2 /api/session, /api/event, /api/session/:id/prompt
    const session = await adapter.spawnAgent({
      missionId: 'm1',
      taskId: 't1',
      role: 'builder',
      model: 'google/gemini-4-neon',
      reasoningLevel: 'high',
      prompt: 'Hello OpenCode v2',
      cwd: process.cwd(),
    });
    assert.equal(session.runtimeSessionId, 'ses_v2_test');

    // Health check uses /api/info
    assert.equal(await adapter.probeSessionResponsiveness(session.id), true);

    // Wait for SSE text_delta + form.created -> question_asked
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(events.some((e) => e.type === 'text_delta' && e.content === 'Hi v2'));
    assert.ok(events.some((e) => e.type === 'question_asked' && e.requestId === 'frm_9'));

    // Reply to v2 form (204 No Content) and approval (/api/session/:id/permission/:id/reply)
    await adapter.respondToQuestion(session.id, 'frm_9', [['true']]);
    assert.ok(events.some((e) => e.type === 'question_replied' && e.requestId === 'frm_9'));
    await adapter.respondToApproval(`${session.id}:perm_1`, 'approved');

    // Cancel uses /api/session/:id/interrupt
    await adapter.cancel(session.id);
    assert.ok(recordedRequests.some((r) => r.method === 'POST' && r.url === '/api/session/ses_v2_test/interrupt'));
    assert.ok(recordedRequests.some((r) => r.method === 'POST' && r.url === '/api/session' && r.body?.model?.id === 'gemini-4-neon' && r.body?.model?.variant === 'high'));
  } finally {
    sseResponse?.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

await testV2AdapterAgainstMockServer();
console.log('OpenCode v2 adapter + CLIXML tests passed');

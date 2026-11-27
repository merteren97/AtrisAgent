import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ManualOpenCodeV2Sessions,
  buildOpenCodeV2ConfigContent,
  openCodeChildEnvironment,
} from './manual-opencode-v2-session';

// 1. Env sanitization & config merge
{
  const env = openCodeChildEnvironment({
    ATRIS_RUNTIME_TOKEN: 'secret-token',
    ATRIS_PARENT_PID: '999',
    PORT: '4000',
    XDG_DATA_HOME: '/tmp/xdg-data',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  });
  assert.equal(env.ATRIS_RUNTIME_TOKEN, undefined);
  assert.equal(env.ATRIS_PARENT_PID, undefined);
  assert.equal(env.PORT, undefined);
  assert.equal(env.XDG_DATA_HOME, '/tmp/xdg-data');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');

  const merged = JSON.parse(
    buildOpenCodeV2ConfigContent(
      JSON.stringify({ theme: 'dark', mcp: { servers: { existing: { type: 'local', command: ['echo'] } } } }),
      { script: '/tmp/bridge.mjs' },
    )!,
  );
  assert.equal(merged.theme, 'dark');
  assert.deepEqual(merged.mcp.servers.existing, { type: 'local', command: ['echo'] });
  assert.equal(merged.mcp.servers.atris_workspace.type, 'local');
  assert.deepEqual(merged.mcp.servers.atris_workspace.command, [process.execPath, '/tmp/bridge.mjs']);
  assert.equal(merged.mcp.servers.atris_workspace.disabled, false);
  assert.equal(merged.mcp.servers.atris_workspace.codemode, false);
}

// 2. Mock OpenCode v2 HTTP+SSE server script
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-opencode-v2-test-'));
const dataDir = path.join(root, 'data');
const cwd = path.join(root, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

const mockServerScript = path.join(root, 'mock-opencode-v2.cjs');
const stateLogFile = path.join(root, 'server-state.jsonl');

fs.writeFileSync(
  mockServerScript,
  `
const http = require('node:http');
const fs = require('node:fs');

const args = process.argv.slice(2);
if (args[0] !== 'serve') process.exit(2);
const host = args[args.indexOf('--hostname') + 1] || '127.0.0.1';
const port = Number(args[args.indexOf('--port') + 1]);
const expectedAuth = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const logFile = ${JSON.stringify(stateLogFile)};
const record = (entry) => fs.appendFileSync(logFile, JSON.stringify(entry) + '\\n');

let sessionId = 'ses_v2_initial_123';
let sseClients = new Set();
const inbox = [];
const permissionReplies = [];

function emit(type, data) {
  const frame = 'data: ' + JSON.stringify({ type, data }) + '\\n\\n';
  for (const res of sseClients) res.write(frame);
}

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== expectedAuth) {
    res.writeHead(401).end('Unauthorized');
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: '2.4.2' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/event') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\\n\\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {};
    if (req.method === 'POST' && pathname === '/api/session') {
      record({ op: 'create_session', body: parsed, config: process.env.OPENCODE_CONFIG_CONTENT, atrisToken: process.env.ATRIS_CONTROL_PLANE_TOKEN });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: sessionId } }));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/session/' + sessionId) {
      record({ op: 'get_session', sessionId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: sessionId } }));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/session/' + sessionId + '/message') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], cursor: null }));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/session/' + sessionId + '/inbox') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: inbox }));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/session/' + sessionId + '/permission') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/session/' + sessionId + '/model') {
      record({ op: 'switch_model', body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/session/' + sessionId + '/prompt') {
      record({ op: 'prompt', body: parsed });
      if (parsed.text === '__trigger_sse_flow__') {
        emit('session.execution.started', { sessionID: sessionId });
        emit('session.text.delta', { sessionID: sessionId, messageID: 'msg_1', delta: 'Hello ' });
        emit('session.text.delta', { sessionID: sessionId, messageID: 'msg_1', delta: 'v2!' });
        emit('session.tool.called', { sessionID: sessionId, id: 'tool_1', tool: 'write_file', input: { file_path: 'src/app.ts' } });
        emit('file.edited', { sessionID: sessionId, file: 'src/other.ts' });
        emit('session.execution.succeeded', { sessionID: sessionId });
      } else if (parsed.text === '__trigger_turn_1_no_id__') {
        emit('session.execution.started', { sessionID: sessionId });
        emit('session.text.delta', { sessionID: sessionId, delta: 'Turn 1 reply' });
        emit('session.execution.succeeded', { sessionID: sessionId });
      } else if (parsed.text === '__trigger_turn_2_no_id__') {
        emit('session.execution.started', { sessionID: sessionId });
        emit('session.text.delta', { sessionID: sessionId, delta: 'Turn 2 reply' });
        emit('session.execution.succeeded', { sessionID: sessionId });
      } else if (parsed.text === '__trigger_permission__') {
        emit('permission.asked', { sessionID: sessionId, id: 'perm_1', action: 'bash', message: 'Run npm test?' });
      } else if (parsed.text === '__trigger_permission_2__') {
        emit('permission.asked', { sessionID: sessionId, id: 'perm_2', action: 'edit', message: 'Edit file?' });
      } else if (parsed.text === '__trigger_form__') {
        emit('form.created', {
          form: {
            id: 'form_1',
            sessionID: sessionId,
            title: 'Deploy',
            fields: [
              { key: 'env', type: 'string', title: 'Environment', options: [{ value: 'prod', label: 'Production' }] },
            ],
          },
        });
      } else {
        const item = { id: 'inb_1', text: parsed.text, delivery: parsed.delivery || 'queue', createdAt: Date.now() };
        inbox.push(item);
        emit('session.inbox.enqueued', { sessionID: sessionId, item });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'PATCH' && pathname.startsWith('/api/session/' + sessionId + '/inbox/')) {
      const inboxId = pathname.split('/').pop();
      record({ op: 'steer_inbox', inboxId, body: parsed });
      const item = inbox.find((i) => i.id === inboxId);
      if (item) item.delivery = parsed.delivery;
      emit('session.inbox.delivery.changed', { sessionID: sessionId, id: inboxId, delivery: parsed.delivery });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/session/' + sessionId + '/inbox/')) {
      const inboxId = pathname.split('/').pop();
      record({ op: 'cancel_inbox', inboxId });
      emit('session.inbox.cancelled', { sessionID: sessionId, id: inboxId });
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && pathname.includes('/permission/') && pathname.endsWith('/reply')) {
      const requestId = pathname.split('/')[5];
      permissionReplies.push({ requestId, body: parsed });
      record({ op: 'permission_reply', requestId, body: parsed });
      emit('permission.replied', { sessionID: sessionId, id: requestId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && pathname.includes('/form/') && pathname.endsWith('/reply')) {
      const formId = pathname.split('/')[5];
      record({ op: 'form_reply', formId, body: parsed });
      emit('form.replied', { sessionID: sessionId, id: formId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end('Not Found');
  });
});

server.listen(port, host);
`,
);

// Helper executable wrapper that runs mockServerScript with node
const fakeOpenCode = process.platform === 'win32'
  ? path.join(root, 'opencode.cmd')
  : path.join(root, 'opencode');
if (process.platform === 'win32') {
  fs.writeFileSync(fakeOpenCode, `@echo off\r\n"${process.execPath}" "${mockServerScript}" %*\r\n`);
} else {
  fs.writeFileSync(fakeOpenCode, `#!/usr/bin/env sh\nexec "${process.execPath}" "${mockServerScript}" "$@"\n`, { mode: 0o755 });
}

const sessions = new ManualOpenCodeV2Sessions();
const agentId = '11111111-1111-4111-8111-111111111111';

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

try {
  const endpoint = await sessions.create(agentId, {
    agentId,
    dataDir,
    executable: fakeOpenCode,
    cwd,
    env: { XDG_DATA_HOME: path.join(root, 'xdg') },
    model: 'openai/gpt-5',
    reasoning: 'medium',
    coordination: { endpoint: 'http://127.0.0.1:4444', script: '/tmp/coord.mjs', token: 'coord-tok' },
    startupTimeoutMs: 10_000,
  });

  assert.equal(endpoint.sessionId, 'ses_v2_initial_123');
  assert.ok(endpoint.url.startsWith('http://127.0.0.1:'));
  assert.ok(endpoint.password.length >= 20);

  // Duplicate-launch 409 guard
  await assert.rejects(
    sessions.create(agentId, {
      agentId,
      dataDir,
      executable: fakeOpenCode,
      cwd,
      env: {},
    }),
    (err: any) => err.status === 409,
  );

  const session = sessions.get(agentId)!;
  assert.equal(session.activity().state, 'ready');
  assert.deepEqual(session.autoApprove(), { available: true, enabled: false });

  // History file persisted atomically with sessionId
  const historyPath = path.join(dataDir, 'manual-sessions', agentId, 'opencode-history.json');
  const savedHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  assert.equal(savedHistory.sessionId, 'ses_v2_initial_123');

  // SSE messages, activity, and file touches
  await session.sendPrompt('__trigger_sse_flow__', 'queue');
  await waitFor(
    () => session.activity().state === 'completed' && session.messages().messages.some((m) => m.text === 'Hello v2!'),
    'SSE text delta and completion',
  );

  const fileEventsPath = path.join(dataDir, 'manual-sessions', agentId, 'opencode-file-events.jsonl');
  await waitFor(() => fs.existsSync(fileEventsPath), 'file events log');
  const fileEventsRaw = fs.readFileSync(fileEventsPath, 'utf8');
  assert.ok(fileEventsRaw.includes('src/app.ts'));
  assert.ok(fileEventsRaw.includes('src/other.ts'));

  // Auto-approve toggle & dedupe
  await session.sendPrompt('__trigger_permission__');
  await waitFor(() => session.activity().state === 'attention' && session.activity().attentionKind === 'approval', 'permission attention');
  session.setAutoApprove(true);
  assert.equal(session.autoApprove().enabled, true);
  await waitFor(
    () => fs.readFileSync(stateLogFile, 'utf8').includes('"requestId":"perm_1"'),
    'auto-approve reply for pending permission',
  );
  await session.sendPrompt('__trigger_permission_2__');
  await waitFor(
    () => fs.readFileSync(stateLogFile, 'utf8').includes('"requestId":"perm_2"'),
    'auto-approve reply for future permission',
  );

  // Live model switch
  await session.switchModel('anthropic/claude-sonnet-4-6', 'high');
  assert.ok(fs.readFileSync(stateLogFile, 'utf8').includes('"providerID":"anthropic","id":"claude-sonnet-4-6","variant":"high"'));

  // Form questions & reply
  await session.sendPrompt('__trigger_form__');
  await waitFor(() => session.pendingQuestions().length === 1, 'form question');
  assert.equal(session.activity().attentionKind, 'question');
  await session.replyQuestion('form_1', [['Production']]);
  assert.equal(session.pendingQuestions().length, 0);
  assert.ok(fs.readFileSync(stateLogFile, 'utf8').includes('"env":"prod"'));

  // Native inbox list, steer, cancel
  await session.sendPrompt('Queued follow-up', 'queue');
  await waitFor(() => session.inbox().length === 1, 'inbox item enqueued');
  assert.equal(session.inbox()[0].delivery, 'queue');
  await session.steerInbox('inb_1');
  assert.equal(session.inbox()[0].delivery, 'steer');
  await session.cancelInbox('inb_1');
  await waitFor(() => session.inbox().length === 0, 'inbox item cancelled');

  // SSE messages without messageID across 2 turns must not overwrite Turn 1
  await session.sendPrompt('__trigger_turn_1_no_id__', 'queue');
  await waitFor(() => session.messages().messages.some((m) => m.text === 'Turn 1 reply'), 'Turn 1 reply');
  await session.sendPrompt('__trigger_turn_2_no_id__', 'queue');
  await waitFor(() => session.messages().messages.some((m) => m.text === 'Turn 2 reply'), 'Turn 2 reply');
  assert.ok(session.messages().messages.some((m) => m.text === 'Turn 1 reply'), 'Turn 1 reply preserved after Turn 2');

  // Close and verify restart resume via opencode-history.json + model re-applied
  await sessions.closeAll();
  const resumed = await sessions.create(agentId, {
    agentId,
    dataDir,
    executable: fakeOpenCode,
    cwd,
    env: {},
    model: 'openai/gpt-5-mini',
    reasoning: 'low',
    startupTimeoutMs: 10_000,
  });
  assert.equal(resumed.sessionId, 'ses_v2_initial_123');
  const logAfterResume = fs.readFileSync(stateLogFile, 'utf8');
  assert.ok(logAfterResume.includes('"op":"get_session"'));
  assert.ok(logAfterResume.includes('"providerID":"openai","id":"gpt-5-mini","variant":"low"'));

  console.log('OpenCode v2 managed session unit tests passed.');
} finally {
  await sessions.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
}

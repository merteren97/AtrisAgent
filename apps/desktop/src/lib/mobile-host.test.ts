import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

async function main() {
  let writes = 0; let closed = 0; let terminal = 'open'; let activity = 'ready';
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) || null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
  (globalThis as any).localStorage = storage;
  (globalThis as any).window = { __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
    if (command === 'manual_terminal_snapshot') return { status: terminal, inputReady: true };
    if (command === 'manual_terminal_write') { assert.equal(args.id, 'agent'); assert.equal(args.paste, true); writes++; return; }
    if (command === 'manual_terminal_close') { closed++; return; }
    throw new Error('Unexpected native command');
  } } };
  (globalThis as any).window.localStorage = storage;
  const agent = { id: 'agent', conversationId: 'conversation', name: 'Codex', catalogId: 'model-a', runtimeType: 'codex', model: 'model-a', accountProfileId: 'account', providerSessionId: 'provider-session', cwd: 'test-workspace', createdAt: '' };
  const conversation = { id: 'conversation', workspaceId: 'workspace', title: 'Task', createdAt: '', agents: [agent] };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/workspaces') { res.end(JSON.stringify([{ id: 'workspace', name: 'Project' }])); return; }
    if (req.url === '/api/manual/conversations?workspaceId=workspace') { res.end(JSON.stringify([conversation])); return; }
    if (req.url === '/api/manual/agents/agent/activity') { res.end(JSON.stringify({ state: activity })); return; }
    if (req.url === '/api/manual/agents/agent/messages') { res.end(JSON.stringify({ messages: [{ id: 'message', role: 'assistant', text: 'Persisted provider history' }] })); return; }
    res.statusCode = 404; res.end('{"error":"Unexpected test route"}');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const { configureApiRuntime } = await import('./api-client');
    configureApiRuntime({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const { useAccountStore } = await import('@/stores/account-store');
    useAccountStore.setState({ discoveredModels: [{ catalogId: 'model-a', name: 'Codex Model', accountProfileId: 'account', runtimeType: 'codex', available: true, availability: 'available', supportedReasoning: ['high'] }] as any });
    const { handleMobileRequest } = await import('./mobile-host');
    const projects = await handleMobileRequest('workspaces', {}) as any[];
    assert.equal(projects[0].agents[0].id, 'agent');
    assert.equal(projects[0].agents[0].status, 'idle');
    assert.deepEqual(await handleMobileRequest('messages', { agentId: 'agent' }), [{ id: 'message', role: 'assistant', text: 'Persisted provider history' }]);
    const command = { agentId: 'agent', workspaceId: 'workspace', conversationId: 'conversation', id: 'request-1', text: 'Continue' };
    await assert.rejects(handleMobileRequest('send', { ...command, workspaceId: 'wrong' }), /context changed/);
    assert.equal(writes, 0);
    assert.deepEqual(await handleMobileRequest('send', command), { status: 'delivered' });
    assert.deepEqual(await handleMobileRequest('send', command), { status: 'delivered' });
    assert.equal(writes, 1);
    terminal = 'closed';
    assert.deepEqual(await handleMobileRequest('send', { ...command, id: 'request-2' }), { status: 'rejected', reason: 'unavailable' });
    assert.equal(writes, 1);
    terminal = 'open'; activity = 'working';
    await assert.rejects(handleMobileRequest('setModel', { agentId: 'agent', expectedModelId: 'model-a', modelId: 'model-a', reasoning: 'high' }), /current turn/);
    await assert.rejects(handleMobileRequest('setModel', { agentId: 'agent', expectedModelId: 'model-a', modelId: 'model-a', reasoning: 'invalid' }), /reasoning/);
    assert.equal(closed, 0, 'Rejected model changes must not close a native session');
    await assert.rejects(handleMobileRequest('send', { ...command, agentId: 'missing' }), /no longer exists/);
    await assert.rejects(handleMobileRequest('arbitrary-command', { agentId: 'agent' }), /Unsupported/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
void main();

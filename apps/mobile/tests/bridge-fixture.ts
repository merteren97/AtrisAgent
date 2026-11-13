// Local test process only. It is never imported by production relay or clients.
import http from 'node:http';
import { WebSocket } from 'ws';
import { createMobileRelay } from '../../../services/mobile-relay/src/relay';
import { createPairing, encodePairing, RemoteHost, type DeviceConnection, type SocketLike } from '../../../packages/remote/src/index';
import { RemoteAgentCommands } from '../../desktop/src/lib/remote-agent-commands';

const relay = createMobileRelay({ authorize: async token => { if (token !== 'test-owner') throw new Error('Unauthorized'); return { id: 'test-owner', username: 'tester' }; } });
relay.server.listen(4190, '127.0.0.1');
const hosts = new Map<string, { host: RemoteHost; devices: DeviceConnection[]; writes: number }>();
const server = http.createServer((req, res) => {
  void (async () => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url || '/', 'http://127.0.0.1:4191');
    if (url.pathname === '/health') { res.end('{}'); return; }
    if (url.pathname === '/fixture') {
      const pairing = createPairing('ws://127.0.0.1:4190/remote/v1/ws');
      const agent = { id: 'a1', conversationId: 'c1', name: 'Builder', runtime: 'opencode', model: 'GPT Terra', modelId: 'model-1', reasoning: 'high', status: 'idle' };
      const messages = [{ id: 'm1', role: 'assistant', text: 'Ready to continue the implementation.' }];
      let autoApprove = false;
      let questionPending = true;
      const state: { host: RemoteHost; devices: DeviceConnection[]; writes: number } = { host: undefined!, devices: [], writes: 0 };
      const commands = new RemoteAgentCommands({ deliver: async command => { state.writes++; if (command.text === 'uncertain') throw new Error('Lost acknowledgment'); messages.push({ id: command.id, role: 'user', text: command.text }); messages.push({ id: `${command.id}-reply`, role: 'assistant', text: 'The desktop received your message.' }); return 'delivered'; } });
      const host = new RemoteHost(pairing, async (method, params) => {
        if (method === 'session') return { connected: true, desktopName: 'Test Desktop' };
        if (method === 'workspaces') return [{ id: 'w1', name: 'AtrisAgent', agents: [agent] }];
        if (method === 'messages') return messages;
        if (method === 'send') return commands.send({ id: params.id, workspaceId: params.workspaceId, conversationId: params.conversationId, agentId: params.agentId, text: params.text });
        if (method === 'models') return [{ id: 'model-1', name: 'GPT Terra', runtime: 'opencode', available: true, selected: true, reasoning: ['medium', 'high'] }];
        if (method === 'setModel') { agent.reasoning = String(params.reasoning); return agent; }
        if (method === 'controls') return { preferredMode: null, autoApprove: { available: true, enabled: autoApprove }, memory: { nodes: [{ id: 'note', title: 'Project decision', summary: 'Keep changes scoped to the workspace.' }] }, questions: questionPending ? [{ id: 'question-1', questions: [{ header: 'Continue', question: 'Should the agent continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] }] : [] };
        if (method === 'replyQuestion') { if (JSON.stringify(params.answers) !== JSON.stringify([['Yes']])) throw new Error('Invalid test answer'); questionPending = false; return { accepted: true }; }
        if (method === 'setAutoApprove') { if (params.expectedEnabled !== autoApprove) throw new Error('Conflict'); autoApprove = params.enabled === true; return { accepted: true }; }
        throw new Error('Unsupported');
      }, devices => { state.devices = devices; }, address => new WebSocket(address) as unknown as SocketLike);
      state.host = host; await host.connect('test-owner'); hosts.set(pairing.hostId, state);
      res.end(JSON.stringify({ code: encodePairing(pairing), id: pairing.hostId })); return;
    }
    const state = hosts.get(url.searchParams.get('id') || '');
    if (!state) { res.statusCode = 404; res.end('{}'); return; }
    if (url.pathname === '/approve') { state.devices.forEach(device => state.host.approve(device.id)); res.end(JSON.stringify({ devices: state.devices })); return; }
    if (url.pathname === '/revoke') { state.devices.forEach(device => state.host.disconnectDevice(device.id)); res.end('{}'); return; }
    if (url.pathname === '/stats') { res.end(JSON.stringify({ writes: state.writes, devices: state.devices })); return; }
    res.statusCode = 404; res.end('{}');
  })().catch(() => { res.statusCode = 500; res.end('{}'); });
});
server.listen(4191, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { for (const state of hosts.values()) state.host.close(); void relay.close(); server.close(); });

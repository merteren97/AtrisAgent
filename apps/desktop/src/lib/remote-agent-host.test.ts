import assert from 'node:assert/strict';
import { createRemoteAgentHost } from './remote-agent-host';

async function main() {
  const command = { id: 'request', workspaceId: 'project', conversationId: 'chat', agentId: 'agent', text: 'Hello' };
  let writes = 0;
  let status = 'open';
  let inputReady: boolean | null = true;
  const host = createRemoteAgentHost({
    conversations: async () => [{ id: 'chat', workspaceId: 'project', agents: [{ id: 'agent', conversationId: 'chat' }] }],
    terminalStatus: async () => ({ status, inputReady }),
    writeMessage: async (id, text) => { assert.equal(id, 'agent'); assert.equal(text, 'Hello'); writes++; },
  });
  assert.equal(await host.deliver({ ...command, workspaceId: 'another' }), 'unavailable');
  assert.equal(await host.deliver({ ...command, agentId: 'another' }), 'unavailable');
  status = 'closed';
  assert.equal(await host.deliver(command), 'unavailable');
  status = 'open'; inputReady = false;
  assert.equal(await host.deliver(command), 'unavailable');
  assert.equal(writes, 0);
  inputReady = true;
  assert.equal(await host.deliver(command), 'delivered');
  assert.equal(writes, 1);
}

void main();

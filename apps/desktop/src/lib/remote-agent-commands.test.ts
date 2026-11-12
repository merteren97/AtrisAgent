import assert from 'node:assert/strict';
import { RemoteAgentCommands } from './remote-agent-commands';

async function main() {
  const command = { id: 'request-1', workspaceId: 'workspace-1', conversationId: 'conversation-1', agentId: 'agent-1', text: 'Continue the work' };
  let writes = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const commands = new RemoteAgentCommands({ deliver: async () => { writes++; await gate; return 'delivered'; } }, 2);
  const first = commands.send(command);
  const duplicate = commands.send({ ...command });
  assert.equal(first, duplicate, 'duplicate requests share the original receipt');
  assert.deepEqual(await commands.send({ ...command, text: 'different' }), { status: 'rejected', reason: 'conflict' });
  assert.deepEqual(await commands.send({ ...command, id: 'request-2' }), { status: 'rejected', reason: 'busy' });
  release();
  assert.deepEqual(await first, { status: 'delivered' });
  assert.deepEqual(await commands.send(command), { status: 'delivered' });
  assert.equal(writes, 1);

  assert.deepEqual(await commands.send({ ...command, id: 'request-2', text: '\u001b[200~bad' }), { status: 'rejected', reason: 'invalid' });
  assert.deepEqual(await commands.send({ ...command, id: 'request-2', extra: true }), { status: 'rejected', reason: 'invalid' });
  assert.deepEqual(await commands.send({ ...command, id: 'request-2' }), { status: 'delivered' });
  assert.deepEqual(await commands.send({ ...command, id: 'request-3' }), { status: 'rejected', reason: 'capacity' });

  let uncertainWrites = 0;
  const uncertain = new RemoteAgentCommands({ deliver: async () => { uncertainWrites++; throw new Error('lost acknowledgment'); } });
  assert.deepEqual(await uncertain.send(command), { status: 'unknown' });
  assert.deepEqual(await uncertain.send(command), { status: 'unknown' });
  assert.equal(uncertainWrites, 1, 'unknown delivery is not automatically repeated');

  const unavailable = new RemoteAgentCommands({ deliver: async () => 'unavailable' });
  assert.deepEqual(await unavailable.send(command), { status: 'rejected', reason: 'unavailable' });
}

void main();

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPairing, decodePairing, encodePairing, EncryptedChannel } from './index';

test('pairing rejects expired codes and unexpected relay addresses', () => {
  const pairing = createPairing('wss://agent.atrishub.com/remote/v1/ws');
  assert.deepEqual(decodePairing(encodePairing(pairing), pairing.relay), pairing);
  assert.throws(() => decodePairing(encodePairing(pairing), 'wss://other.example/remote/v1/ws'));
  assert.throws(() => decodePairing(encodePairing({ ...pairing, expiresAt: Date.now() - 1 }), pairing.relay));
  assert.throws(() => createPairing('ws://public.example/remote/v1/ws'));
  assert.throws(() => createPairing('wss://user:password@public.example'));
});

test('encrypted channel rejects replay, tampering, wrong direction, and wrong pairing secret', async () => {
  const pairing = createPairing('ws://127.0.0.1/remote/v1/ws');
  const host = new EncryptedChannel(pairing.secret, 'session-a', 'host');
  const device = new EncryptedChannel(pairing.secret, 'session-a', 'device');
  const first = await device.seal({ prompt: 'private' });
  assert.ok(!first.data.includes('private'));
  assert.deepEqual(await host.open(first), { prompt: 'private' });
  await assert.rejects(host.open(first));
  await assert.rejects(device.open(first));
  const wrong = new EncryptedChannel(createPairing(pairing.relay).secret, 'session-a', 'host');
  await assert.rejects(wrong.open(first));
  const next = await device.seal({ prompt: 'next' });
  await assert.rejects(host.open({ ...next, sessionId: 'session-b' }));
  assert.deepEqual(await host.open(next), { prompt: 'next' });
  const anotherConnection = new EncryptedChannel(pairing.secret, 'session-a', 'host', 'fresh-endpoint-nonces');
  await assert.rejects(anotherConnection.open(next), 'Endpoint nonces isolate keys even if a relay reuses a session ID');
});

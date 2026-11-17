import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createMobileRelay } from './relay';
import { createPairing, RemoteClient, RemoteHost, type DeviceConnection, type SocketLike } from '../../../packages/remote/src/index';

const factory = (url: string) => new WebSocket(url) as unknown as SocketLike;
test('real relay requires the same account, encrypted pairing proof, approval, and revocation', async () => {
  const relay = createMobileRelay({ authorize: async token => {
    if (token === 'owner') return { id: 'owner-id', username: 'owner' };
    if (token === 'other') return { id: 'other-id', username: 'other' };
    throw new Error('invalid');
  } });
  relay.server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => relay.server.once('listening', resolve));
  const url = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}/remote/v1/ws`;
  const pairing = createPairing(url);
  let devices: DeviceConnection[] = [];
  let writes = 0;
  const host = new RemoteHost(pairing, async method => { if (method === 'session') return { connected: true }; writes++; return { accepted: true }; }, next => { devices = next; }, factory);
  const client = new RemoteClient(factory);
  const other = new RemoteClient(factory);
  const invalid = new RemoteClient(factory);
  const wrongSecret = new RemoteClient(factory);
  try {
    await host.connect('owner');
    await assert.rejects(other.connect(pairing, 'other'));
    await assert.rejects(invalid.connect(pairing, 'invalid'));
    await wrongSecret.connect({ ...pairing, secret: createPairing(url).secret }, 'owner');
    await assert.rejects(wrongSecret.request('session'));
    assert.equal(devices.length, 0, 'A caller without the pairing key must not appear for approval');
    await client.connect(pairing, 'owner');
    assert.deepEqual(await client.request('session'), { connected: false, pendingApproval: true });
    await assert.rejects(client.request('send'), /Approve/);
    assert.equal(writes, 0);
    assert.equal(devices.length, 1);
    host.approve(devices[0].id);
    assert.deepEqual(await client.request('session'), { connected: true });
    assert.deepEqual(await client.request('send'), { accepted: true });
    assert.equal(writes, 1);
    host.disconnectDevice(devices[0].id);
    await new Promise(resolve => setTimeout(resolve, 40));
    await assert.rejects(client.request('send'));
    assert.equal(writes, 1);
  } finally { client.close(); other.close(); invalid.close(); wrongSecret.close(); host.close(); await relay.close(); }
});

test('mobile disconnect preserves desktop approval and allows reconnect after pairing expiresAt', async () => {
  const relay = createMobileRelay({ authorize: async token => {
    if (token === 'owner') return { id: 'owner-id', username: 'owner' };
    throw new Error('invalid');
  } });
  relay.server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => relay.server.once('listening', resolve));
  const url = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}/remote/v1/ws`;
  const pairing = createPairing(url);
  let devices: DeviceConnection[] = [];
  const host = new RemoteHost(pairing, async method => (method === 'session' ? { connected: true } : { ok: true }), next => { devices = next; }, factory);
  const firstClient = new RemoteClient(factory);
  const secondClient = new RemoteClient(factory);
  const unapprovedExpiredClient = new RemoteClient(factory);
  try {
    await host.connect('owner');
    await firstClient.connect(pairing, 'owner', 'phone-1');
    assert.deepEqual(await firstClient.request('session'), { connected: false, pendingApproval: true });
    assert.equal(devices.length, 1);
    host.approve(devices[0].id);
    assert.deepEqual(await firstClient.request('session'), { connected: true });
    assert.equal(devices[0].online, true);

    firstClient.close();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(devices.length, 1, 'Approved device must stay listed on desktop after mobile closes');
    assert.equal(devices[0].approved, true);
    assert.equal(devices[0].online, false);

    // Expire the QR pairing window; previously approved device must still reconnect.
    pairing.expiresAt = Date.now() - 1000;
    await secondClient.connect(pairing, 'owner', 'phone-1');
    assert.deepEqual(await secondClient.request('session'), { connected: true });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].approved, true);
    assert.equal(devices[0].online, true);

    // Unapproved devices must still be rejected after expiresAt.
    await assert.rejects(async () => {
      await unapprovedExpiredClient.connect(pairing, 'owner', 'phone-2');
      await unapprovedExpiredClient.request('session');
    });

    // Explicit desktop revoke removes the device and blocks further reconnects.
    host.disconnectDevice(devices[0].id);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(devices.length, 0);
  } finally { firstClient.close(); secondClient.close(); unapprovedExpiredClient.close(); host.close(); await relay.close(); }
});

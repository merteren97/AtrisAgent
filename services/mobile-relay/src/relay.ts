import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export interface Identity { id: string; username: string }
export async function authorizeHub(token: string): Promise<Identity> {
  const response = await fetch('https://atrishub.com/api/auth/me', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Unauthorized');
  const data = await response.json() as { user?: Identity };
  if (!data.user?.id || typeof data.user.username !== 'string') throw new Error('Unauthorized');
  return { id: data.user.id, username: data.user.username };
}

/** The relay only routes ciphertext. Device control approval is enforced by
 * the desktop after the encrypted pairing-secret challenge succeeds. */
export function createMobileRelay(options: { authorize?: (token: string) => Promise<Identity>; revalidateMs?: number } = {}) {
  const authorize = options.authorize || authorizeHub;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    res.statusCode = req.url === '/health' ? 200 : 404;
    res.end(JSON.stringify(req.url === '/health' ? { service: 'atris-agent-relay', status: 'ok' } : { error: 'Not found' }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 750_000, perMessageDeflate: false });
  type Peer = { socket: WebSocket; identity: Identity; token: string; role: 'host' | 'device'; hostId: string; sessionId?: string; validating?: boolean };
  const peers = new Map<WebSocket, Peer>();
  const hosts = new Map<string, Peer>();
  const sessions = new Map<string, Peer>();
  const alive = new WeakMap<WebSocket, boolean>();
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/remote/v1/ws' || wss.clients.size >= 200) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  const send = (ws: WebSocket, message: unknown) => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 2_000_000) ws.close(1008, 'Slow receiver'); else ws.send(JSON.stringify(message)); } };
  wss.on('connection', socket => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    let authenticating = false;
    let count = 0; let windowStart = Date.now();
    const deadline = setTimeout(() => socket.close(1008, 'Authentication required'), 10_000);
    socket.on('message', (raw, binary) => {
      void (async () => {
        if (binary) throw new Error('Binary frames are not supported');
        if (Date.now() - windowStart > 10_000) { count = 0; windowStart = Date.now(); }
        if (++count > 200) throw new Error('Rate exceeded');
        const message = JSON.parse(raw.toString());
        const peer = peers.get(socket);
        if (!peer) {
          if (authenticating || message.type !== 'auth' || !['host', 'device'].includes(message.role) || typeof message.token !== 'string' || message.token.length > 8192 || !/^[0-9a-f-]{36}$/i.test(message.hostId)) throw new Error('Invalid authentication');
          authenticating = true;
          const identity = await authorize(message.token);
          if (socket.readyState !== WebSocket.OPEN) return;
          const existing = [...peers.values()].filter(value => value.identity.id === identity.id);
          if (existing.length >= 12) throw new Error('Account connection limit');
          const next: Peer = { socket, identity, token: message.token, role: message.role, hostId: message.hostId };
          if (next.role === 'host') {
            if (hosts.has(next.hostId)) throw new Error('Host already connected');
            hosts.set(next.hostId, next); peers.set(socket, next);
            send(socket, { type: 'registered' });
          } else {
            const host = hosts.get(next.hostId);
            if (!host || host.identity.id !== identity.id) throw new Error('Desktop unavailable');
            next.sessionId = randomUUID(); peers.set(socket, next); sessions.set(next.sessionId, next);
            send(host.socket, { type: 'device', sessionId: next.sessionId, username: identity.username });
            send(socket, { type: 'ready', sessionId: next.sessionId });
          }
          clearTimeout(deadline);
          return;
        }
        if (message.type === 'disconnect' && peer.role === 'host' && typeof message.sessionId === 'string') {
          const device = sessions.get(message.sessionId);
          if (device?.hostId === peer.hostId) device.socket.close(1008, 'Desktop revoked connection');
          return;
        }
        if (message.type === 'hello') {
          if (typeof message.deviceNonce !== 'string' || message.deviceNonce.length > 100 || (peer.role === 'host' && (typeof message.hostNonce !== 'string' || message.hostNonce.length > 100))) throw new Error('Invalid handshake');
          if (peer.role === 'device') {
            if (peer.sessionId !== message.sessionId) throw new Error('Session mismatch');
            const host = hosts.get(peer.hostId);
            if (!host) throw new Error('Desktop disconnected');
            send(host.socket, { type: 'hello', sessionId: peer.sessionId, deviceNonce: message.deviceNonce });
          } else {
            const device = sessions.get(message.sessionId);
            if (!device || device.hostId !== peer.hostId) throw new Error('Session mismatch');
            send(device.socket, { type: 'hello', sessionId: message.sessionId, deviceNonce: message.deviceNonce, hostNonce: message.hostNonce });
          }
          return;
        }
        if (message.type !== 'packet' || typeof message.sessionId !== 'string' || typeof message.data !== 'string' || !Number.isSafeInteger(message.sequence) || message.sequence < 1) throw new Error('Invalid packet');
        if (peer.role === 'device') {
          if (peer.sessionId !== message.sessionId) throw new Error('Session mismatch');
          const host = hosts.get(peer.hostId);
          if (!host) throw new Error('Desktop disconnected');
          send(host.socket, message);
        } else {
          const device = sessions.get(message.sessionId);
          if (!device || device.hostId !== peer.hostId) throw new Error('Session mismatch');
          send(device.socket, message);
        }
      })().catch(() => { send(socket, { type: 'error' }); socket.close(1008, 'Connection rejected'); });
    });
    socket.on('error', () => socket.close());
    socket.on('close', () => {
      clearTimeout(deadline);
      const peer = peers.get(socket); peers.delete(socket);
      if (peer?.role === 'host') {
        if (hosts.get(peer.hostId) === peer) hosts.delete(peer.hostId);
        for (const device of sessions.values()) if (device.hostId === peer.hostId) device.socket.close(1001, 'Desktop disconnected');
      } else if (peer?.sessionId) {
        sessions.delete(peer.sessionId);
        const host = hosts.get(peer.hostId);
        if (host) send(host.socket, { type: 'left', sessionId: peer.sessionId });
      }
    });
  });
  const interval = setInterval(() => {
    for (const peer of peers.values()) {
      if (peer.validating) continue;
      peer.validating = true;
      void authorize(peer.token).then(identity => { if (identity.id !== peer.identity.id) peer.socket.close(1008, 'Session expired'); }).catch(() => peer.socket.close(1008, 'Session expired')).finally(() => { peer.validating = false; });
    }
  }, options.revalidateMs || 60_000);
  interval.unref();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.get(socket)) { socket.terminate(); continue; }
      alive.set(socket, false); socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  return { server, close: async () => { clearInterval(interval); clearInterval(heartbeat); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); } };
}

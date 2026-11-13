export interface Pairing {
  version: 1;
  relay: string;
  hostId: string;
  secret: string;
  expiresAt: number;
}
export interface RpcRequest { id: string; method: string; params?: Record<string, unknown> }
export interface RpcReply { id: string; result?: unknown; error?: string }
export interface WirePacket { type: 'packet'; sessionId: string; sequence: number; data: string }
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}
export type SocketFactory = (url: string) => SocketLike;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const isNonce = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value);
export function toBase64(bytes: Uint8Array): string { return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')); }
export function fromBase64(text: string): Uint8Array { return Uint8Array.from(atob(text), character => character.charCodeAt(0)); }

export function relayUrl(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'wss:' && !(local && url.protocol === 'ws:'))) throw new Error('Relay must use WSS (or loopback WS for local testing).');
  return url.toString();
}
export function createPairing(relay: string): Pairing {
  return { version: 1, relay: relayUrl(relay), hostId: crypto.randomUUID(), secret: toBase64(crypto.getRandomValues(new Uint8Array(32))), expiresAt: Date.now() + 10 * 60_000 };
}
export function encodePairing(pairing: Pairing): string { return `atrisagent:${toBase64(encoder.encode(JSON.stringify(pairing)))}`; }
export function decodePairing(code: string, trustedRelay: string): Pairing {
  if (code.length > 4096 || !code.startsWith('atrisagent:')) throw new Error('Paste an AtrisAgent pairing code from desktop settings.');
  const value = JSON.parse(decoder.decode(fromBase64(code.slice(11)))) as Pairing;
  if (value.version !== 1 || typeof value.secret !== 'string' || fromBase64(value.secret).length !== 32 || !/^[0-9a-f-]{36}$/i.test(value.hostId) || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 11 * 60_000) throw new Error('Pairing code is invalid or expired. Create a new code on desktop.');
  if (relayUrl(value.relay) !== relayUrl(trustedRelay)) throw new Error('Pairing code uses a different relay.');
  return value;
}

/** Per-connection directional keys and authenticated counters prevent replay.
 * The pairing secret is shared out of band; it is never sent to the relay. */
export class EncryptedChannel {
  private sent = 0;
  private received = 0;
  private readonly keys: Promise<{ send: CryptoKey; receive: CryptoKey }>;
  constructor(secret: string, private readonly sessionId: string, role: 'host' | 'device', context = '') {
    this.keys = (async () => {
      const material = await crypto.subtle.importKey('raw', fromBase64(secret) as BufferSource, 'HKDF', false, ['deriveKey']);
      const derive = (direction: string) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(`${sessionId}:${context}`), info: encoder.encode(`atrisagent-remote-v1:${direction}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const [host, device] = await Promise.all([derive('host'), derive('device')]);
      return role === 'host' ? { send: host, receive: device } : { send: device, receive: host };
    })();
  }
  private iv(sequence: number): Uint8Array { const iv = new Uint8Array(12); new DataView(iv.buffer).setBigUint64(4, BigInt(sequence)); return iv; }
  private aad(sequence: number): Uint8Array { return encoder.encode(`atrisagent:1:${this.sessionId}:${sequence}`); }
  async seal(value: unknown): Promise<WirePacket> {
    const data = encoder.encode(JSON.stringify(value));
    if (data.length > 500_000) throw new Error('Response is too large.');
    const sequence = ++this.sent;
    const key = (await this.keys).send;
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: this.iv(sequence) as BufferSource, additionalData: this.aad(sequence) as BufferSource }, key, data);
    return { type: 'packet', sessionId: this.sessionId, sequence, data: toBase64(new Uint8Array(encrypted)) };
  }
  async open(packet: WirePacket): Promise<unknown> {
    if (packet.sessionId !== this.sessionId || !Number.isSafeInteger(packet.sequence) || packet.sequence <= this.received || packet.sequence < 1 || typeof packet.data !== 'string' || packet.data.length > 700_000) throw new Error('Invalid or replayed remote packet.');
    const key = (await this.keys).receive;
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.iv(packet.sequence) as BufferSource, additionalData: this.aad(packet.sequence) as BufferSource }, key, fromBase64(packet.data) as BufferSource);
    // Caller serializes receive processing to avoid racing the replay counter.
    this.received = packet.sequence;
    return JSON.parse(decoder.decode(decrypted));
  }
}

export class RemoteClient {
  private socket?: SocketLike;
  private channel?: EncryptedChannel;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private receive = Promise.resolve();
  private transmit = Promise.resolve();
  constructor(private readonly factory: SocketFactory = url => new WebSocket(url), private readonly onClose: () => void = () => {}) {}
  async connect(pairing: Pairing, token: string): Promise<void> {
    this.close();
    return new Promise((resolve, reject) => {
      const socket = this.factory(pairing.relay);
      this.socket = socket;
      let ready = false;
      let sessionId = '';
      const deviceNonce = toBase64(crypto.getRandomValues(new Uint8Array(32)));
      const timer = setTimeout(() => { reject(new Error('Connection timed out. Check the relay and desktop.')); if (this.socket === socket) this.close(); }, 15_000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', role: 'device', hostId: pairing.hostId, token })));
      socket.addEventListener('message', event => {
        this.receive = this.receive.then(async () => {
          if (this.socket !== socket) return;
          const message = JSON.parse(String(event.data));
          if (message.type === 'ready' && typeof message.sessionId === 'string' && !sessionId) {
            sessionId = message.sessionId;
            socket.send(JSON.stringify({ type: 'hello', sessionId, deviceNonce }));
          } else if (message.type === 'hello' && message.sessionId === sessionId && message.deviceNonce === deviceNonce && isNonce(message.hostNonce) && !ready) {
            this.channel = new EncryptedChannel(pairing.secret, sessionId, 'device', `${deviceNonce}:${message.hostNonce}`);
            ready = true; clearTimeout(timer); resolve();
          } else if (message.type === 'packet' && this.channel) {
            const reply = await this.channel.open(message) as RpcReply;
            const pending = this.pending.get(reply.id);
            if (!pending) return;
            clearTimeout(pending.timer); this.pending.delete(reply.id);
            if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.result);
          } else if (message.type === 'error') throw new Error('Relay authorization failed or desktop is unavailable.');
        }).catch(() => { clearTimeout(timer); reject(new Error('Secure connection failed. Create a new pairing code.')); if (this.socket === socket) this.close(); });
      });
      socket.addEventListener('error', () => { if (!ready) { clearTimeout(timer); reject(new Error('Could not reach the relay.')); } });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        if (!ready) reject(new Error('Connection rejected. Check your account and desktop.'));
        if (this.socket === socket) { this.channel = undefined; this.socket = undefined; this.rejectPending(); this.onClose(); }
      });
    });
  }
  request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const socket = this.socket; const channel = this.channel;
    if (!socket || socket.readyState !== 1 || !channel) return Promise.reject(new Error('Desktop is disconnected.'));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Desktop did not confirm the operation.')); }, 30_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.transmit = this.transmit.then(async () => { const packet = await channel.seal({ id, method, params }); if (this.socket !== socket) throw new Error('Connection changed.'); socket.send(JSON.stringify(packet)); }).catch(() => { this.pending.delete(id); clearTimeout(timer); reject(new Error('Could not send to desktop.')); });
    });
  }
  private rejectPending() { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Connection lost; delivery is not confirmed.')); } this.pending.clear(); }
  close(): void { const socket = this.socket; this.socket = undefined; this.channel = undefined; this.rejectPending(); socket?.close(); }
}

export interface DeviceConnection { id: string; username: string; approved: boolean }
export class RemoteHost {
  private socket?: SocketLike;
  private devices = new Map<string, { channel?: EncryptedChannel; info: DeviceConnection; verified: boolean; queue: Promise<void> }>();
  private transmit = Promise.resolve();
  constructor(private readonly pairing: Pairing, private readonly handle: (method: string, params: Record<string, unknown>) => Promise<unknown>, private readonly changed: (devices: DeviceConnection[]) => void, private readonly factory: SocketFactory = url => new WebSocket(url), private readonly disconnected: () => void = () => {}) {}
  connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.factory(this.pairing.relay); this.socket = socket;
      const timer = setTimeout(() => { reject(new Error('Could not reach the relay.')); if (this.socket === socket) this.close(); }, 15_000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', role: 'host', hostId: this.pairing.hostId, token })));
      socket.addEventListener('message', event => {
        if (this.socket !== socket) return;
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'registered') { clearTimeout(timer); resolve(); }
          else if (message.type === 'device') {
            if (Date.now() > this.pairing.expiresAt || this.devices.size >= 8) { this.disconnectDevice(message.sessionId); return; }
            this.devices.set(message.sessionId, { info: { id: message.sessionId, username: String(message.username).slice(0, 80), approved: false }, verified: false, queue: Promise.resolve() });
          } else if (message.type === 'hello') {
            const device = this.devices.get(message.sessionId);
            if (!device || device.channel || !isNonce(message.deviceNonce)) { this.disconnectDevice(message.sessionId); return; }
            const hostNonce = toBase64(crypto.getRandomValues(new Uint8Array(32)));
            device.channel = new EncryptedChannel(this.pairing.secret, message.sessionId, 'host', `${message.deviceNonce}:${hostNonce}`);
            socket.send(JSON.stringify({ type: 'hello', sessionId: message.sessionId, deviceNonce: message.deviceNonce, hostNonce }));
          } else if (message.type === 'left') { this.devices.delete(message.sessionId); this.notify(); }
          else if (message.type === 'packet') {
            const device = this.devices.get(message.sessionId);
            if (!device?.channel) return;
            const channel = device.channel;
            device.queue = device.queue.then(async () => {
              const request = await channel.open(message) as RpcRequest;
              if (!request || typeof request.id !== 'string' || request.id.length > 100 || typeof request.method !== 'string' || request.method.length > 100 || (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)))) throw new Error('Invalid request');
              if (!this.devices.has(message.sessionId)) return;
              device.verified = true;
              this.notify(); // Only reveal a device after proof of the pairing secret.
              let reply: RpcReply;
              if (!device.info.approved) reply = request.method === 'session' ? { id: request.id, result: { connected: false, pendingApproval: true } } : { id: request.id, error: 'Approve this phone on your desktop first.' };
              else {
                try { reply = { id: request.id, result: await this.handle(request.method, request.params || {}) }; }
                catch (cause) { reply = { id: request.id, error: cause instanceof Error ? cause.message.slice(0, 250) : 'Desktop operation failed.' }; }
              }
              this.transmit = this.transmit.then(async () => {
                if (this.socket !== socket || !this.devices.has(message.sessionId)) return;
                socket.send(JSON.stringify(await channel.seal(reply)));
              }).catch(() => this.disconnectDevice(message.sessionId));
              await this.transmit;
            }).catch(() => this.disconnectDevice(message.sessionId));
          } else if (message.type === 'error') { reject(new Error('Relay rejected the desktop connection.')); this.close(); }
        } catch { reject(new Error('Invalid relay response.')); this.close(); }
      });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Relay connection failed.')); });
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Relay disconnected.')); if (this.socket === socket) { this.socket = undefined; this.devices.clear(); this.notify(); this.disconnected(); } });
    });
  }
  approve(id: string): void { const device = this.devices.get(id); if (device?.verified) device.info.approved = true; this.notify(); }
  disconnectDevice(id: string): void { this.devices.delete(id); this.socket?.send(JSON.stringify({ type: 'disconnect', sessionId: id })); this.notify(); }
  private notify() { this.changed([...this.devices.values()].filter(device => device.verified).map(device => ({ ...device.info }))); }
  close(): void { const socket = this.socket; this.socket = undefined; socket?.close(); this.devices.clear(); this.notify(); }
}

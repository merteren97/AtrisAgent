import { createMobileRelay } from './relay.js';
const relay = createMobileRelay();
relay.server.listen(Number(process.env.PORT || 3015), '127.0.0.1', () => console.log('AtrisAgent relay listening on loopback'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void relay.close(); });

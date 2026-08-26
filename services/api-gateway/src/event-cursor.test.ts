import assert from 'node:assert/strict';
import { cursorFromQuery, decodeEventCursor, encodeEventCursor } from './event-cursor';

const encoded = encodeEventCursor({ sequence: 42, eventId: 'event-42' });
assert.deepEqual(decodeEventCursor(encoded), { sequence: 42, eventId: 'event-42' }, 'cursor round-trips sequence and event identity');
assert.deepEqual(cursorFromQuery({ cursor: encoded }), { sequence: 42, eventId: 'event-42' }, 'opaque cursor takes precedence over legacy query state');
assert.deepEqual(cursorFromQuery({ afterSequence: '7' }), { sequence: 7 }, 'legacy numeric cursor remains readable during migration');
assert.equal(decodeEventCursor('not-a-cursor'), null, 'malformed cursor is rejected');
assert.equal(decodeEventCursor(Buffer.from(JSON.stringify({ v: 1, s: -1 })).toString('base64url')), null, 'negative sequence is rejected');

console.log('Event cursor tests passed.');

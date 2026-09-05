import assert from 'node:assert/strict';
import { cursorFromQuery, decodeEventCursor, encodeEventCursor, replayPages } from './event-cursor';

const encoded = encodeEventCursor({ sequence: 42, eventId: 'event-42' });
assert.deepEqual(decodeEventCursor(encoded), { sequence: 42, eventId: 'event-42' }, 'cursor round-trips sequence and event identity');
assert.deepEqual(cursorFromQuery({ cursor: encoded }), { sequence: 42, eventId: 'event-42' }, 'opaque cursor takes precedence over legacy query state');
assert.deepEqual(cursorFromQuery({ afterSequence: '7' }), { sequence: 7 }, 'legacy numeric cursor remains readable during migration');
assert.equal(decodeEventCursor('not-a-cursor'), null, 'malformed cursor is rejected');
assert.equal(decodeEventCursor(Buffer.from(JSON.stringify({ v: 1, s: -1 })).toString('base64url')), null, 'negative sequence is rejected');

for (const eventCount of [999, 1000, 1001]) {
  const events = Array.from({ length: eventCount }, (_, index) => ({ sequence: index + 1 }));
  const pages = [...replayPages(0, eventCount, (after, through) => events
    .filter((event) => event.sequence > after && event.sequence <= through).slice(0, 1000))];
  assert.equal(pages.flat().length, eventCount, `${eventCount} replay events are paged without duplicates or loops`);
  assert.equal(pages.length, Math.ceil(eventCount / 1000), `${eventCount} replay events use the expected page count`);
}

console.log('Event cursor tests passed.');

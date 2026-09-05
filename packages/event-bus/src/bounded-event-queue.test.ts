import assert from 'node:assert/strict';
import { BoundedEventQueue } from './bounded-event-queue';

const queue = new BoundedEventQueue<string>({ maxItems: 2, maxBytes: 5, sizeOf: (item) => item.length });
queue.enqueue('a');
queue.enqueue('bb');
queue.enqueue('ccc');
assert.deepEqual(queue.dequeue(), ['bb', 'ccc'], 'queue evicts the oldest entry when item capacity is exceeded');
assert.equal(queue.droppedCount, 1, 'queue records dropped entries');
assert.equal(queue.takeDroppedCount(), 1, 'drop count can be consumed by a transport');
assert.equal(queue.droppedCount, 0, 'consuming drops resets the pending gap count');

queue.enqueue('123456');
assert.equal(queue.length, 0, 'oversized entries are rejected instead of evicting the entire queue');
assert.equal(queue.droppedCount, 1, 'oversized entries count as a dropped event');
queue.clear();
assert.equal(queue.length, 0, 'clear removes queued entries');
assert.equal(queue.byteLength, 0, 'clear resets byte accounting');

console.log('Bounded event queue tests passed.');

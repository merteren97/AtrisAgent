import assert from 'node:assert/strict';
import { growTimelineWindow, tailWindow } from './timeline-window';

assert.deepEqual(tailWindow([1, 2, 3, 4], 2), { items: [3, 4], hiddenCount: 2 });
assert.deepEqual(tailWindow([1, 2], 10), { items: [1, 2], hiddenCount: 0 });
assert.equal(growTimelineWindow(160, 500), 320);
assert.equal(growTimelineWindow(480, 500), 500);

console.log('timeline window tests passed');

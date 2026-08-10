import assert from 'node:assert/strict';
import { consumeSseFrames } from './sse-parser';

let parsed = consumeSseFrames('', 'data: {"type":"mission_started"}\r\n\r');
assert.deepEqual(parsed.frames, []);
parsed = consumeSseFrames(parsed.remainder, '\ndata: {"type":"task_created"}\n\n');
assert.deepEqual(parsed.frames, ['data: {"type":"mission_started"}', 'data: {"type":"task_created"}']);
assert.equal(parsed.remainder, '');
console.log('desktop SSE parser contract passed');

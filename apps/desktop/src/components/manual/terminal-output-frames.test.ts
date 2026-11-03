import assert from 'node:assert/strict';
import { TerminalOutputFrames } from './terminal-output-frames';

const begin = '\x1b[?2026h', end = '\x1b[?2026l';
const frame = begin+'\x1b[2J\x1b[HComplete screen'+end;
for (let split = 1; split < frame.length; split++) {
  const buffer = new TerminalOutputFrames();
  assert.equal(buffer.push(frame.slice(0,split),100), '', 'A partial synchronized frame must not erase the visible screen');
  assert.equal(buffer.push(frame.slice(split),150), frame, 'Split CSI markers and frame bytes must survive exactly');
}
const frames = new TerminalOutputFrames();
assert.equal(frames.push('ordinary text'+begin+'clear',100), 'ordinary text');
assert.equal(frames.flushExpired(200), '');
assert.equal(frames.flushExpired(351), begin+'clear', 'A missing end marker must not block cursor/device traffic indefinitely');
assert.equal(frames.push('after timeout',400), 'after timeout');
assert.equal(frames.push(frame+frame,500), frame+frame);
frames.push(begin+'stale',600); frames.reset();
assert.equal(frames.push('new epoch',601),'new epoch');
assert.equal(frames.push(begin+'x'.repeat(1024*1024+1),700),begin+'x'.repeat(1024*1024+1),'Untrusted CLI output cannot buffer an unbounded frame');
console.log('Terminal synchronized-frame splitting, timeout, reset and bounds passed.');

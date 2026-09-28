import assert from 'node:assert/strict';
import { addManualFiles, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS } from './manual-composer';
import { displayManualPrompt } from './manual-chat-content';

const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { lastModified: 1 });
const first = file('screenshot.png', 4);
const second = file('notes.txt', 2);

assert.deepEqual(addManualFiles([], [first, second]), [first, second], 'accepts images and documents together');
assert.deepEqual(addManualFiles([first], [first, second]), [first, second], 'ignores duplicate selections');
assert.throws(() => addManualFiles([], [file('empty.png', 0)]), /empty/);
assert.throws(() => addManualFiles([], [file('large.png', MAX_ATTACHMENT_SIZE + 1)]), /10 MB/);
assert.throws(() => addManualFiles(Array.from({ length: MAX_ATTACHMENTS }, (_, index) => file(`file-${index}.txt`, 1)), [second]), /Attach up to/);
assert.throws(() => addManualFiles([file('large.png', MAX_ATTACHMENT_SIZE)], [file('another.png', MAX_ATTACHMENT_SIZE), file('third.png', MAX_ATTACHMENT_SIZE)]), /25 MB/);
const sent = 'Inspect this\n\nAttached files (read these local paths to inspect their contents, including images):\n- "screen.png": "C:\\\\Temp\\\\abc.png"';
assert.deepEqual(displayManualPrompt(sent), {text:'Inspect this', attachments:[{name:'screen.png',path:'C:\\Temp\\abc.png'}]});
assert.deepEqual(displayManualPrompt('Inspect this\n\nAttached files (read these local paths to inspect their contents, including images):\n- invalid'), {text:'Inspect this\n\nAttached files (read these local paths to inspect their contents, including images):\n- invalid', attachments:[]});

console.log('Manual composer attachment validation passed.');

import assert from 'node:assert/strict';
import { addManualFiles, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS } from './manual-composer';
import { assistantProjectImages, displayManualPrompt } from './manual-chat-content';

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
const generated = 'Screens: [Light](AtrisAgent/landing-app-parity-light.png) · ![Dark](AtrisAgent/landing-app-parity-dark.PNG) · [Hub](AtrisHub/atrisagent-hub-light.png)';
assert.deepEqual(assistantProjectImages(generated), [
  {name:'Light',path:'AtrisAgent/landing-app-parity-light.png'},
  {name:'Dark',path:'AtrisAgent/landing-app-parity-dark.PNG'},
  {name:'Hub',path:'AtrisHub/atrisagent-hub-light.png'},
]);
assert.deepEqual(assistantProjectImages('[External](https://example.test/screen.png) [Data](data:image/png) [Local](C:\\Projects\\shot.webp) [Again](C:\\Projects\\shot.webp)'), [{name:'Local',path:'C:\\Projects\\shot.webp'}]);

console.log('Manual composer attachment validation passed.');

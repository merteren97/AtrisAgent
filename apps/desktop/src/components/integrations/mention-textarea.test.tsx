import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MentionTextarea } from './mention-textarea';

const html = renderToStaticMarkup(<MentionTextarea aria-label="Message" value={'hello @github and @unity-cli\nmail@example.com @github-extra'} readOnly />);
assert.equal((html.match(/<mark /g) || []).length,2);
assert.match(html,/>@github<\/mark>/);
assert.match(html,/>@unity-cli<\/mark>/);
assert.match(html,/<textarea[^>]*aria-label="Message"/);
assert(html.includes('mail@example.com @github-extra'));
const plain = renderToStaticMarkup(<MentionTextarea value="plain text" readOnly />);
assert(!plain.includes('<mark '));
console.log('Mention highlighting preserves text and excludes email/partial names');

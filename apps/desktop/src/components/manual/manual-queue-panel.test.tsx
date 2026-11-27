import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ManualQueuePanel } from './manual-queue-panel';
import type { ManualInboxItem, ManualQueuedPrompt } from '@/stores/manual-store';

const file = new File(['abc'], 'notes.txt', { type: 'text/plain' });

// Empty state renders nothing.
assert.equal(renderToStaticMarkup(<ManualQueuePanel inbox={[]} queued={[]} />), '');

const inbox: ManualInboxItem[] = [
  { id: 'in-1', text: 'Follow up on tests', delivery: 'queue', createdAt: 1 },
  { id: 'in-steer', text: 'Already steering', delivery: 'steer', createdAt: 2 },
];
const queued: ManualQueuedPrompt[] = [
  { id: 'q-1', text: 'Check logs', files: [file], createdAt: 3, status: 'queued' },
  { id: 'q-2', text: 'Retry build', files: [], createdAt: 4, status: 'error', error: 'Terminal busy' },
  { id: 'q-3', text: 'Sending now', files: [], createdAt: 5, status: 'sending' },
];

const html = renderToStaticMarkup(
  <ManualQueuePanel
    inbox={inbox}
    queued={queued}
    canSteer
    onSteerInbox={() => {}}
    onCancelInbox={() => {}}
    onSteerQueued={() => {}}
    onCancelQueued={() => {}}
  />,
);

assert.match(html, /aria-label="Queued messages"/);
assert.match(html, /Follow up on tests/);
assert.doesNotMatch(html, /Already steering/, 'steer inbox items are not shown as queued');
assert.match(html, /Check logs/);
assert.match(html, /1 file/);
assert.match(html, /Retry build/);
assert.match(html, /Terminal busy/);
assert.match(html, /Failed/);
assert.match(html, /Sending…/);
assert.match(html, /aria-label="Send queued message immediately"/);
assert.match(html, /aria-label="Cancel queued message"/);

const attentionHtml = renderToStaticMarkup(
  <ManualQueuePanel
    queued={[{ id: 'q-4', text: 'Wait for answer', files: [], createdAt: 6, status: 'queued' }]}
    canSteer
    attention
    onSteerQueued={() => {}}
    onCancelQueued={() => {}}
  />,
);
assert.match(attentionHtml, /Waiting for response/);
assert.match(attentionHtml, /disabled=""[^>]*aria-label="Send queued message immediately"|aria-label="Send queued message immediately"[^>]*disabled=""/);

const noSteerHtml = renderToStaticMarkup(
  <ManualQueuePanel
    queued={[
      { id: 'q-5', text: 'Codex queued', files: [], createdAt: 7, status: 'queued' },
      { id: 'q-6', text: 'Codex failed', files: [], createdAt: 8, status: 'error', error: 'Write failed' },
    ]}
    canSteer={false}
    onRetryQueued={() => {}}
    onCancelQueued={() => {}}
  />,
);
assert.doesNotMatch(noSteerHtml, /Send queued message immediately/);
assert.match(noSteerHtml, /aria-label="Retry queued message"/);
assert.match(noSteerHtml, /Cancel queued message/);

console.log('ManualQueuePanel render tests passed.');

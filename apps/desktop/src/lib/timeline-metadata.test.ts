import assert from 'node:assert/strict';
import { boundStreamContent, compactTimelineMetadata, MAX_STREAM_CONTENT_LENGTH } from './timeline-metadata';

const compacted = compactTimelineMetadata({
  missionId: 'mission-1',
  sequence: 42,
  content: 'duplicate streamed text',
  thought: 'duplicate thought text',
  optionalToolCallId: undefined,
  args: { content: 'keep this tool argument', thought: 'keep this nested thought' },
  result: 'r'.repeat(20_000),
  tasks: Array.from({ length: 80 }, (_, index) => ({ id: `task-${index}`, title: 'task' })),
  nested: { value: { value: { value: { value: 'deep' } } } },
});

assert.equal(compacted?.missionId, 'mission-1');
assert.equal(compacted?.sequence, 42);
assert.equal('content' in (compacted || {}), false, 'stream content is not duplicated in metadata');
assert.equal('thought' in (compacted || {}), false, 'thought text is not duplicated in metadata');
assert.equal('optionalToolCallId' in (compacted || {}), false, 'absent optional fields are not stringified');
assert.equal((compacted?.args as Record<string, unknown>).content, 'keep this tool argument');
assert.equal((compacted?.args as Record<string, unknown>).thought, 'keep this nested thought');
assert.equal(String(compacted?.result).length <= 8 * 1024 + '\n[metadata truncated]'.length, true);
assert.equal((compacted?.tasks as unknown[]).length, 64);
assert.equal(compacted?.metadataTruncated, true);

const large = `${'head-'.repeat(200_000)}tail-marker`;
const bounded = boundStreamContent(large);
assert.equal(bounded.length <= MAX_STREAM_CONTENT_LENGTH, true);
assert(bounded.startsWith('head-'), 'bounded stream keeps the beginning');
assert(bounded.endsWith('tail-marker'), 'bounded stream keeps the latest output');

const lateFields: Record<string, unknown> = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`field-${index}`, index]));
lateFields.approvalId = 'approval-late';
assert.equal(compactTimelineMetadata(lateFields)?.approvalId, 'approval-late', 'important late metadata fields survive object bounding');

console.log('timeline metadata projection tests passed');

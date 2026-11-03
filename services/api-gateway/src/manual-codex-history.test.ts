import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCodexManualTranscript, readCodexManualHistory } from './manual-codex-history';

const MiB = 1024 * 1024;
const session = 'session-test';
const line = (type: string, payload: unknown, timestamp = '2026-09-08T00:00:00Z') => JSON.stringify({type, payload, timestamp});
const user = (id: string, text: string) => line('event_msg', {type: 'user_message', id, message: text});
const completed = (item: unknown, turn_id = 'turn-1') => line('event_msg', {type: 'item_completed', turn_id, item});
const assistant = (id: string, text: string) => line('response_item', {type: 'message', id, role: 'assistant', content: [{type: 'output_text', text}]});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-history-'));
const filename = (name: string) => path.join(temporary, `${name}.jsonl`);
const texts = (result: ReturnType<typeof readCodexManualHistory>) => result.messages.map(message => message.text);

try {
  // The current bridge's fixture, including its non-newline-terminated last record.
  const fixture = [
    line('session_meta', {id: session}),
    line('response_item', {type: 'message', role: 'developer', content: [{type: 'input_text', text: 'Internal config'}]}),
    line('event_msg', {type: 'user_message', message: 'Hello'}),
    line('response_item', {type: 'message', role: 'user', content: [{type: 'input_text', text: 'Injected environment'}]}),
    line('response_item', {type: 'message', role: 'assistant', channel: 'analysis', content: [{type: 'output_text', text: 'Private reasoning'}]}),
    line('response_item', {type: 'message', role: 'assistant', channel: 'final', content: [{type: 'output_text', text: 'Visible response'}]}),
  ].join('\n');
  const parsed = parseCodexManualTranscript(fixture, session);
  assert.deepEqual(parsed.map(message => message.text), ['Hello', 'Visible response']);
  assert.deepEqual(parseCodexManualTranscript(fixture.split('\n').slice(2).join('\n'), session), parsed, 'Raw fallback IDs survive independent source windows');

  const exact = [
    completed({type: 'UserMessage', id: 'user-1', content: [{type: 'text', text: 'Real user', text_elements: []}, {type: 'image', image_url: 'private'}]}),
    completed({type: 'AgentMessage', id: 'agent-1', phase: 'commentary', content: [{type: 'Text', text: 'Working'}]}),
    completed({type: 'AgentMessage', id: 'agent-2', phase: 'final_answer', content: [{type: 'Text', text: 'Done'}]}),
    completed({type: 'Reasoning', id: 'reason-1', summary_text: ['PRIVATE'], raw_content: ['PRIVATE']}),
    completed({type: 'HookPrompt', id: 'hook-1', content: [{type: 'text', text: 'PRIVATE'}]}),
    completed({type: 'AgentMessage', id: 'bad-case', content: [{type: 'text', text: 'wrong case'}]}),
    completed({type: 'UserMessage', id: 'bad-user', content: [{type: 'Text', text: 'wrong case'}]}),
  ].join('\n');
  assert.deepEqual(parseCodexManualTranscript(exact, session).map(message => [message.id, message.role, message.text]), [
    [`${session}:user-1`, 'user', 'Real user'], [`${session}:agent-1`, 'assistant', 'Working'], [`${session}:agent-2`, 'assistant', 'Done'],
  ]);

  const mixed = [
    assistant('same', 'Draft'),
    user('repeated-1', 'Again'), user('repeated-2', 'Again'),
    completed({type: 'AgentMessage', id: 'same', phase: 'final_answer', content: [{type: 'Text', text: 'Revised'}]}),
    assistant('same', 'Latest raw revision'),
    line('event_msg', {type: 'user_message', turn_id: 'turn-a', message: 'Again'}),
    line('event_msg', {type: 'user_message', turn_id: 'turn-b', message: 'Again'}),
  ].join('\n');
  const revisions = parseCodexManualTranscript(mixed, session);
  assert.deepEqual(revisions.map(message => message.text), ['Latest raw revision', 'Again', 'Again', 'Again', 'Again']);
  assert.equal(new Set(revisions.map(message => message.id)).size, 5, 'Repeated text in independent items/turns is preserved');

  const malformed = [null, [], 42, 'x', {}, {payload: null}, {type: 'event_msg', payload: []}].map(value => JSON.stringify(value));
  malformed.push('not json', line('response_item', {type: 'message', role: 'assistant', content: [null, 4, [], {type: 'output_text', text: 2}, {type: {toString: null}, text: 'PRIVATE'}]}));
  malformed.push(completed(null), completed({type: 'UserMessage', content: [null]}));
  malformed.push(line('response_item', {type: 'function_call', name: 'request_user_input', arguments: JSON.stringify({questions: [null, {question: 'bad', options: null}]})}));
  assert.doesNotThrow(() => parseCodexManualTranscript(malformed.join('\n'), session));
  assert.equal(parseCodexManualTranscript(malformed.join('\n'), session).length, 1, 'Malformed tool questions still yield only a safe tool summary');
  const rollback = filename('rollback');
  fs.writeFileSync(rollback,[user('turn-one','Keep'),assistant('answer-one','Keep reply'),user('turn-two','Remove'),assistant('answer-two','Remove reply')].join('\n')+'\n');
  readCodexManualHistory(rollback,session);
  fs.appendFileSync(rollback,line('event_msg',{type:'thread_rolled_back',num_turns:1})+'\n');
  assert.deepEqual(texts(readCodexManualHistory(rollback,session)),['Keep','Keep reply'],'An authoritative rollback removes cached public turns');
  fs.appendFileSync(rollback,line('event_msg',{type:'thread_rolled_back',num_turns:-1})+'\n');
  assert.deepEqual(texts(readCodexManualHistory(rollback,session)),['Keep','Keep reply'],'Invalid rollback records cannot erase public history');

  const tools = [
    line('response_item', {type: 'function_call', name: 'request_user_input', call_id: 'call-1', arguments: JSON.stringify({secret: 'PRIVATE', questions: [null, {header: 'Publish', question: 'Proceed?', options: [null, {label: 'Yes', description: 'Continue'}, {label: 5}]}]})}),
    line('response_item', {type: 'function_call_output', call_id: 'call-1', output: 'PRIVATE'}),
    line('response_item', {type: 'custom_tool_call', call_id: 'call-2', name: 'patch', input: 'PRIVATE'}),
    line('response_item', {type: 'custom_tool_call_output', call_id: 'call-2', output: {secret: 'PRIVATE'}}),
  ].join('\n');
  const summaries = parseCodexManualTranscript(tools, session);
  assert.equal(summaries.length, 4, 'Request and result sharing a call ID remain distinct summaries');
  assert.equal(summaries[0].question?.id, 'call-1');
  assert.deepEqual(summaries[0].question?.questions, [{header: 'Publish', question: 'Proceed?', options: [{label: 'Yes', description: 'Continue'}], custom: true}]);
  assert.ok(!JSON.stringify(summaries).includes('PRIVATE'), 'Tool payloads never enter public history');

  const stream = filename('stream');
  fs.writeFileSync(stream, user('first', 'Committed') + '\n');
  assert.deepEqual(texts(readCodexManualHistory(stream, session)), ['Committed']);
  // Multiple polls through a growing, oversized tool record must retain public entries.
  fs.appendFileSync(stream, '{"type":"response_item","payload":{"type":"function_call_output","output":"' + 'x'.repeat(2 * MiB));
  let result = readCodexManualHistory(stream, session);
  assert.deepEqual(texts(result), ['Committed']);
  assert.equal(result.loading, true);
  fs.appendFileSync(stream, 'y'.repeat(2 * MiB));
  result = readCodexManualHistory(stream, session);
  assert.deepEqual(texts(result), ['Committed']);
  assert.equal(result.truncated, true);
  fs.appendFileSync(stream, '"}}\n' + assistant('after', 'After huge tool') + '\n');
  for (let poll = 0; poll < 5 && result.loading; poll++) result = readCodexManualHistory(stream, session);
  assert.deepEqual(texts(result), ['Committed', 'After huge tool']);
  assert.ok(!result.loading);
  assert.equal(result.truncated, true);

  const partial = filename('partial');
  fs.writeFileSync(partial, user('first', 'Prior') + '\n' + assistant('unfinished', 'Complete JSON but not a complete JSONL record'));
  result = readCodexManualHistory(partial, session);
  assert.deepEqual(texts(result), ['Prior']);
  assert.equal(result.loading, true);
  fs.appendFileSync(partial, '\n');
  assert.deepEqual(texts(readCodexManualHistory(partial, session)), ['Prior', 'Complete JSON but not a complete JSONL record']);

  // Split inside a four-byte UTF-8 character on disk, then finish it on the next poll.
  const utf8 = filename('utf8');
  const unicode = 'Türkçe 🙂 漢字';
  const encoded = Buffer.from(user('unicode', unicode) + '\n');
  const split = encoded.indexOf(Buffer.from('🙂')) + 2;
  fs.writeFileSync(utf8, encoded.subarray(0, split));
  assert.deepEqual(texts(readCodexManualHistory(utf8, session)), []);
  fs.appendFileSync(utf8, encoded.subarray(split));
  assert.deepEqual(texts(readCodexManualHistory(utf8, session)), [unicode]);

  // Force a UTF-8 code point across the reader's own 2 MiB poll boundary.
  const boundary = filename('utf8-poll');
  // Use an ignored line as padding so the public line itself remains below the line cap.
  const target = Buffer.from(user('boundary', '🙂') + '\n');
  const emojiOffset = target.indexOf(Buffer.from('🙂'));
  const ignoredLength = 2 * MiB - emojiOffset - 2;
  fs.writeFileSync(boundary, Buffer.concat([Buffer.from(' '.repeat(ignoredLength - 1) + '\n'), target]));
  assert.equal(readCodexManualHistory(boundary, session).loading, true);
  assert.deepEqual(texts(readCodexManualHistory(boundary, session)), ['🙂']);

  const lineLimit = filename('line-limit');
  const overhead = Buffer.byteLength(user('limit', ''));
  const atLimit = user('limit', 'a'.repeat(2 * MiB - overhead));
  fs.writeFileSync(lineLimit, atLimit + '\n' + user('limit-over', 'b'.repeat(2 * MiB)) + '\n' + user('recovered', 'Recovered') + '\n');
  let polls = 0;
  do {
    result = readCodexManualHistory(lineLimit, session);
    assert.ok(++polls < 10, 'Reader advances past oversized lines');
  } while (result.loading);
  assert.deepEqual(result.messages.map(message => message.id), [`${session}:limit`, `${session}:recovered`], 'Exactly 2 MiB is allowed; larger lines are skipped');
  assert.equal(result.messages[0].text.length, 2 * MiB - overhead);
  assert.equal(result.truncated, true);

  const pages = filename('pages');
  const entries = Array.from({length: 2300}, (_, index) => assistant(`page-${index}`, `${index}:` + 'p'.repeat(1200)));
  fs.writeFileSync(pages, entries.join('\n') + '\n');
  const originalRead = fs.readSync;
  let requested = 0;
  fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    requested += length;
    return originalRead(fd, buffer, offset, length, position);
  }) as typeof fs.readSync;
  try {
    result = readCodexManualHistory(pages, session, 'bridge');
    assert.equal(result.loading, true);
    assert.ok(result.messages.length > 0 && result.messages.length < 2000);
    assert.ok(requested <= 2 * MiB, 'First poll is IO-bounded');
    requested = 0;
    // The exported module function shares its cursor across fresh caller/bridge wrappers.
    const freshBridgeRead = () => readCodexManualHistory(pages, session, 'bridge');
    result = freshBridgeRead();
    assert.ok(requested <= 2 * MiB, 'Continuation includes boundary verification in its IO budget');
    assert.ok(!result.loading);
    assert.equal(result.messages.length, 2000);
    assert.equal(result.messages[0].id, `${session}:page-300`);
    assert.equal(result.messages.at(-1)?.id, `${session}:page-2299`);
    assert.equal(result.truncated, true);
  } finally { fs.readSync = originalRead; }
  fs.appendFileSync(pages, assistant('page-2299', 'Latest cached revision') + '\n');
  result = readCodexManualHistory(pages, session, 'bridge');
  assert.equal(result.messages.length, 2000);
  assert.equal(result.messages.at(-1)?.text, 'Latest cached revision');
  result.messages[0].text = 'Caller mutation';
  assert.ok(!texts(readCodexManualHistory(pages, session, 'bridge')).includes('Caller mutation'));

  const byteBound = filename('byte-bound');
  fs.writeFileSync(byteBound, Array.from({length: 8}, (_, index) => assistant(`large-${index}`, 'é'.repeat(350000))).join('\n') + '\n');
  do { result = readCodexManualHistory(byteBound, session); } while (result.loading);
  assert.equal(result.truncated, true);
  assert.ok(result.messages.length > 0 && result.messages.length < 8);
  assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) <= 4 * MiB, 'Public UTF-8 text, not JS code units, is bounded');
  assert.equal(result.messages.at(-1)?.id, `${session}:large-7`);

  const reset = filename('reset');
  fs.writeFileSync(reset, user('old', 'Old') + '\n');
  readCodexManualHistory(reset, session);
  fs.writeFileSync(reset, user('new', 'New and longer than the old file, before another poll') + '\n');
  assert.deepEqual(texts(readCodexManualHistory(reset, session)), ['New and longer than the old file, before another poll'], 'Boundary anchor detects same-inode truncate/regrow');
  fs.writeFileSync(reset, '\n');
  assert.deepEqual(texts(readCodexManualHistory(reset, session)), [], 'Shrinking resets public history and the line buffer');
  fs.writeFileSync(reset, user('old-again', 'Old again') + '\n');
  readCodexManualHistory(reset, session);
  fs.appendFileSync(reset, assistant('partial-old', 'Unfinished old record').slice(0, -2));
  assert.equal(readCodexManualHistory(reset, session).loading, true);
  fs.renameSync(reset, reset + '.old');
  fs.writeFileSync(reset, user('replacement', 'Replacement') + '\n');
  assert.deepEqual(texts(readCodexManualHistory(reset, session)), ['Replacement'], 'Replacing the file resets its cursor');

  const isolated = filename('isolation');
  fs.writeFileSync(isolated, user('isolated', 'Scoped') + '\n');
  assert.equal(readCodexManualHistory(isolated, 'session-a', 'shared').messages[0].id, 'session-a:isolated');
  assert.equal(readCodexManualHistory(isolated, 'session-b', 'shared').messages[0].id, 'session-b:isolated');
  assert.equal(readCodexManualHistory(reset, session, 'shared').messages[0].id, `${session}:replacement`, 'Explicit cache keys cannot mix different filenames');

  // LRU eviction is observable as a restart from byte zero, not an unbounded cache.
  const lru = filename('lru');
  fs.writeFileSync(lru, user('lru', 'Retained only until eviction') + '\n' + ' '.repeat(2 * MiB) + '\n');
  assert.equal(readCodexManualHistory(lru, session).loading, true);
  for (let index = 0; index < 64; index++) {
    const other = filename(`eviction-${index}`);
    fs.writeFileSync(other, user(`other-${index}`, 'Other') + '\n');
    readCodexManualHistory(other, session);
  }
  assert.equal(readCodexManualHistory(lru, session).loading, true, 'An evicted cursor starts bounded pagination again');

  console.log('Bounded Codex public-history parser, incremental IO, UTF-8, cache, revisions and reset tests passed.');
} finally { fs.rmSync(temporary, {recursive: true, force: true}); }

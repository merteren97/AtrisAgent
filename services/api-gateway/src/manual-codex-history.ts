import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ManualMessage, ManualQuestion } from './manual-conversations';

const MAX_POLL_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 2000;
const MAX_CACHED_FILES = 64;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const ANCHOR_BYTES = 256;

export interface CodexManualHistory {
  messages: ManualMessage[];
  /** Public entries were evicted, or an oversized JSONL line was skipped. */
  truncated: boolean;
  /** More bytes or an unfinished JSONL line remain; poll again to advance. */
  loading?: boolean;
}

interface PublicHistory {
  messages: Map<string, {message: ManualMessage; bytes: number}>;
  bytes: number;
  truncated: boolean;
}

interface Cursor extends PublicHistory {
  identity: string;
  offset: number;
  anchor: Buffer;
  pending: Buffer;
  pendingLength: number;
  skipping: boolean;
}

// Shared by bridge instances. Fit 30 concurrent agents without an eight-file
// cache repeatedly discarding their cursors; bound aggregate retained memory too.
const cursors = new Map<string, Cursor>();

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function contentText(content: unknown, types: readonly string[]): string {
  if (!Array.isArray(content)) return '';
  return content.filter(part => object(part) && typeof part.type === 'string' && types.includes(part.type) && typeof part.text === 'string')
    .map(part => part.text as string).join('\n');
}

function publicQuestion(args: unknown, id: string): ManualQuestion | undefined {
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return undefined; }
  }
  if (!object(args) || !Array.isArray(args.questions)) return undefined;
  const questions: ManualQuestion['questions'] = [];
  for (const entry of args.questions) {
    if (!object(entry) || typeof entry.question !== 'string' || !Array.isArray(entry.options)) continue;
    questions.push({
      header: typeof entry.header === 'string' ? entry.header : '',
      question: entry.question,
      options: entry.options.filter(option => object(option) && typeof option.label === 'string')
        .map(option => ({label: option.label as string, ...(typeof option.description === 'string' ? {description: option.description} : {})})),
      custom: true,
    });
  }
  return questions.length ? {id, questions} : undefined;
}

/** Only allowlisted public shapes cross this boundary; never stringify provider payloads. */
function publicMessage(record: unknown, line: string, sessionId: string): ManualMessage | undefined {
  if (!object(record) || !object(record.payload)) return undefined;
  const payload = record.payload;
  let value = payload;
  let role: ManualMessage['role'];
  let text: string;
  let kind: string;
  let toolName: string | undefined;
  let question: ManualQuestion | undefined;
  let failed: boolean | undefined;

  if (record.type === 'event_msg' && payload.type === 'item_completed') {
    if (!object(payload.item)) return undefined;
    value = payload.item;
    // Codex 0.166 TurnItem is PascalCase; UserInput alone is snake_case.
    if (value.type === 'UserMessage') {
      role = 'user'; kind = 'user'; text = contentText(value.content, ['text']);
    } else if (value.type === 'AgentMessage' && value.phase !== 'analysis' && value.channel !== 'analysis') {
      role = 'assistant'; kind = `assistant:${nonempty(value.phase) || 'message'}`;
      text = contentText(value.content, ['Text']);
    } else {
      // In particular, Reasoning/HookPrompt/Plan and opaque tool fields stay private.
      return undefined;
    }
  } else if (record.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
    role = 'user'; kind = 'user'; text = payload.message;
  } else if (record.type === 'response_item') {
    if (payload.type === 'message' && payload.role === 'assistant' && payload.channel !== 'analysis' && payload.phase !== 'analysis') {
      role = 'assistant'; kind = `assistant:${nonempty(payload.phase) || nonempty(payload.channel) || 'message'}`;
      text = contentText(payload.content, ['input_text', 'output_text', 'text']);
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      role = 'tool'; kind = 'tool-request';
      toolName = typeof payload.name === 'string' ? payload.name.slice(0, 256) : 'Tool';
      text = 'Tool requested. Open Code for live output and approvals.';
      if (payload.name === 'request_user_input') question = publicQuestion(payload.arguments, nonempty(payload.call_id) || '');
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      role = 'tool'; kind = 'tool-result'; text = 'Tool returned. Open Code to inspect its output.';
      if (typeof payload.failed === 'boolean') failed = payload.failed;
    } else return undefined;
  } else return undefined;

  if (!text) return undefined;
  // A real item ID is canonical across raw response_item and public TurnItem records.
  const providerId = nonempty(value.id) || (value !== payload ? nonempty(payload.item_id) : undefined);
  const callId = nonempty(value.call_id);
  const turnId = nonempty(payload.turn_id) || nonempty(value.turn_id) || nonempty(record.turn_id);
  const fallback = callId ? `call:${callId}:${kind}` : turnId ? `turn:${turnId}:${kind}`
    : `raw:${createHash('sha256').update(line).digest('hex').slice(0, 24)}`;
  const id = `${sessionId}:${providerId || fallback}`;
  if (question && !question.id) question.id = id;
  return {id, role, text, ...(toolName ? {toolName} : {}), ...(question ? {question} : {}), ...(failed !== undefined ? {failed} : {})};
}

function history(): PublicHistory {
  return {messages: new Map(), bytes: 0, truncated: false};
}

function commit(state: PublicHistory, line: string, sessionId: string): void {
  let record: unknown;
  try { record = JSON.parse(line); } catch { return; }
  if (object(record) && record.type === 'event_msg' && object(record.payload) && record.payload.type === 'thread_rolled_back') {
    const count = record.payload.num_turns;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) return;
    const entries = [...state.messages.entries()];
    let remaining = count, cutoff = 0;
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index][1].message.role === 'user' && --remaining === 0) {cutoff = index; break;}
    }
    for (const [id, entry] of entries.slice(cutoff)) {state.messages.delete(id); state.bytes -= entry.bytes;}
    return;
  }
  const message = publicMessage(record, line, sessionId);
  if (!message) return;
  // Include question/option text and metadata in the byte cap as well as message.text.
  const bytes = Buffer.byteLength(JSON.stringify(message));
  const previous = state.messages.get(message.id);
  if (previous) state.bytes -= previous.bytes;
  state.messages.set(message.id, {message, bytes}); // Latest revision, original ordering.
  state.bytes += bytes;
  while (state.messages.size > MAX_MESSAGES || state.bytes > MAX_PUBLIC_BYTES) {
    const oldest = state.messages.keys().next().value!;
    state.bytes -= state.messages.get(oldest)!.bytes;
    state.messages.delete(oldest);
    state.truncated = true;
  }
}

/** Whole-source compatibility parser; unlike the live reader, accepts a final line without LF. */
export function parseCodexManualTranscript(source: string, sessionId: string): ManualMessage[] {
  const state = history();
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline < 0 ? source.length : newline;
    const line = source.slice(start, end);
    if (Buffer.byteLength(line) <= MAX_LINE_BYTES) commit(state, line, sessionId);
    start = end + 1;
  }
  return [...state.messages.values()].map(entry => entry.message);
}

function cursor(identity: string): Cursor {
  return {...history(), identity, offset: 0, anchor: Buffer.alloc(0), pending: Buffer.alloc(0), pendingLength: 0, skipping: false};
}

function consume(state: Cursor, bytes: Buffer, sessionId: string): void {
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline;
    const length = end - start;
    if (!state.skipping && state.pendingLength + length > MAX_LINE_BYTES) {
      state.skipping = true;
      state.pendingLength = 0;
      state.truncated = true;
    }
    if (!state.skipping) {
      if (newline >= 0 && state.pendingLength === 0) {
        commit(state, bytes.subarray(start, end).toString('utf8'), sessionId);
      } else {
        const needed = state.pendingLength + length;
        if (state.pending.length < needed) {
          const next = Buffer.allocUnsafe(Math.min(MAX_LINE_BYTES, Math.max(4096, state.pending.length * 2, needed)));
          state.pending.copy(next, 0, 0, state.pendingLength);
          state.pending = next;
        }
        bytes.copy(state.pending, state.pendingLength, start, end);
        state.pendingLength = needed;
        if (newline >= 0) commit(state, state.pending.subarray(0, needed).toString('utf8'), sessionId);
      }
    }
    if (newline < 0) break;
    state.pendingLength = 0;
    state.skipping = false;
    start = newline + 1;
  }
}

/**
 * Incrementally read complete JSONL records from byte zero. Total readSync requests
 * (including the boundary check) are <= 2 MiB per call. Errors propagate to the
 * caller, which owns binding/path validation. cacheKey optionally namespaces a cursor;
 * filename and sessionId always participate, so namespaces cannot mix histories.
 */
export function readCodexManualHistory(filename: string, sessionId: string, cacheKey?: string): CodexManualHistory {
  const key = JSON.stringify([cacheKey || '', path.resolve(filename), sessionId]);
  const file = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(file);
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    let state = cursors.get(key);
    let budget = MAX_POLL_BYTES;
    if (!state || state.identity !== identity || stat.size < state.offset) state = cursor(identity);
    if (state.anchor.length) {
      const anchor = Buffer.allocUnsafe(state.anchor.length);
      const count = fs.readSync(file, anchor, 0, anchor.length, state.offset - anchor.length);
      budget -= anchor.length;
      // A same-inode truncate/regrow may be larger than the previous cursor already.
      if (count !== anchor.length || !anchor.equals(state.anchor)) state = cursor(identity);
    }
    cursors.delete(key);
    cursors.set(key, state);
    while (cursors.size > MAX_CACHED_FILES) cursors.delete(cursors.keys().next().value!);

    const length = Math.min(budget, Math.max(0, stat.size - state.offset));
    if (length) {
      const buffer = Buffer.allocUnsafe(length);
      const count = fs.readSync(file, buffer, 0, length, state.offset);
      const bytes = buffer.subarray(0, count);
      consume(state, bytes, sessionId);
      state.offset += count;
      const boundary = Buffer.concat([state.anchor, bytes]);
      state.anchor = Buffer.from(boundary.subarray(Math.max(0, boundary.length - ANCHOR_BYTES)));
    }
    let retained = [...cursors.values()].reduce((sum, entry) => sum + entry.bytes + entry.pending.length + entry.anchor.length, 0);
    while (retained > MAX_CACHE_BYTES && cursors.size > 1) {
      const oldest = cursors.keys().next().value!;
      const entry = cursors.get(oldest)!;
      retained -= entry.bytes + entry.pending.length + entry.anchor.length;
      cursors.delete(oldest);
    }
    const loading = state.offset < stat.size || state.pendingLength > 0 || state.skipping;
    return {
      // Do not let callers mutate the cached messages or question objects.
      messages: structuredClone([...state.messages.values()].map(entry => entry.message)),
      truncated: state.truncated,
      ...(loading ? {loading: true} : {}),
    };
  } finally { fs.closeSync(file); }
}

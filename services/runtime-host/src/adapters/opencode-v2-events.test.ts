import assert from 'node:assert/strict';
import { normalizeV2Event } from './opencode-v2-events';

const sessionID = 'ses_a';
const event = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID, ...data } });

assert.deepEqual(normalizeV2Event(event('session.text.delta', { delta: 'Hello' })), {
  type: 'message.part.updated', properties: { sessionID, delta: 'Hello', part: { type: 'text' } },
});
assert.deepEqual(normalizeV2Event(event('session.tool.called', { id: 'call_a', input: { file: 'a' } }), 'read'), {
  type: 'message.part.updated', properties: {
    sessionID,
    part: { type: 'tool', id: 'call_a', tool: 'read', state: { status: 'running', input: { file: 'a' } } },
  },
});
assert.deepEqual(normalizeV2Event(event('session.tool.called', { id: 'call_b', name: 'bash', input: { cmd: 'ls' } })), {
  type: 'message.part.updated', properties: {
    sessionID,
    part: { type: 'tool', id: 'call_b', tool: 'bash', state: { status: 'running', input: { cmd: 'ls' } } },
  },
});
assert.deepEqual(normalizeV2Event(event('permission.asked', { id: 'perm_a', action: 'read', message: 'Read file?', metadata: { path: 'a' } })), {
  type: 'permission.asked', properties: { sessionID, id: 'perm_a', type: 'read', title: 'Read file?', metadata: { path: 'a' } },
});
assert.deepEqual(normalizeV2Event({
  type: 'form.created',
  data: { form: { id: 'frm_1', sessionID, title: 'Confirm', fields: [{ key: 'ok', type: 'boolean', title: 'Proceed?' }] } },
}), {
  type: 'form.created',
  properties: { sessionID, id: 'frm_1', title: 'Confirm', fields: [{ key: 'ok', type: 'boolean', title: 'Proceed?' }] },
});
assert.deepEqual(normalizeV2Event(event('form.replied', { id: 'frm_1', answer: { ok: true } })), {
  type: 'question.replied', properties: { sessionID, requestID: 'frm_1', answers: [] },
});
assert.deepEqual(normalizeV2Event(event('form.cancelled', { id: 'frm_1' })), {
  type: 'question.rejected', properties: { sessionID, requestID: 'frm_1' },
});
assert.deepEqual(normalizeV2Event(event('session.execution.failed', { error: { message: 'Provider failed' } })), {
  type: 'session.error', properties: { sessionID, error: 'Provider failed' },
});
assert.deepEqual(normalizeV2Event(event('session.execution.succeeded')), { type: 'session.idle', properties: { sessionID } });
assert.equal(normalizeV2Event({ type: 'session.execution.succeeded', data: {} }), undefined);
assert.equal(normalizeV2Event(event('session.idle')), undefined, 'Only a completed execution ends the run');
assert.equal(normalizeV2Event(event('session.text.ended', { text: 'Hello' })), undefined, 'Do not emit text twice');
console.log('OpenCode v2 session event translation passed');

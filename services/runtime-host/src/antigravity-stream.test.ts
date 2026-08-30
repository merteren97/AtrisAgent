import assert from 'node:assert/strict';
import { parseAntigravityStreamLine } from './adapters/antigravity-stream';

const init = parseAntigravityStreamLine(JSON.stringify({
  event: 'init',
  conversation_id: '844cd50f-5b14-4ab3-a5b2-b4840fd7d8d4',
  init: { cwd: 'D:/workspace', permission_mode: 'always-proceed' },
}));
assert.equal(init.kind, 'init');
if (init.kind === 'init') assert.equal(init.conversationId, '844cd50f-5b14-4ab3-a5b2-b4840fd7d8d4');

const step = parseAntigravityStreamLine(JSON.stringify({
  event: 'step_update',
  step_update: {
    step_index: 2,
    state: 'DONE',
    step_type: 'agent_response',
    text_delta: 'ATRIS_SUBAGENT_OK\n',
  },
}));
assert.equal(step.kind, 'step');
if (step.kind === 'step') {
  assert.equal(step.stepType, 'agent_response');
  assert.equal(step.content, 'ATRIS_SUBAGENT_OK\n');
  assert.equal(step.state, 'DONE');
}

const result = parseAntigravityStreamLine(JSON.stringify({
  event: 'result',
  result: {
    status: 'SUCCESS',
    response: 'ATRIS_SUBAGENT_OK\n',
    num_turns: 1,
  },
}));
assert.equal(result.kind, 'result');
if (result.kind === 'result') {
  assert.equal(result.success, true);
  assert.equal(result.content, 'ATRIS_SUBAGENT_OK\n');
  assert.equal(result.status, 'SUCCESS');
}

const failure = parseAntigravityStreamLine(JSON.stringify({
  event: 'result',
  result: { status: 'FAILED', error: { message: 'runtime failed' } },
}));
assert.equal(failure.kind, 'result');
if (failure.kind === 'result') {
  assert.equal(failure.success, false);
  assert.equal(failure.error, 'runtime failed');
}

assert.equal(parseAntigravityStreamLine('not-json').kind, 'malformed');
assert.equal(parseAntigravityStreamLine('null').kind, 'malformed');
assert.equal(parseAntigravityStreamLine('[]').kind, 'malformed');
assert.equal(parseAntigravityStreamLine('"event"').kind, 'malformed');
assert.equal(parseAntigravityStreamLine(JSON.stringify({ type: 'result', result: { response: 'missing outcome' } })).kind, 'malformed');
assert.equal(parseAntigravityStreamLine(JSON.stringify({ type: 'result', success: 'true', response: 'string outcome' })).kind, 'malformed');
assert.equal(parseAntigravityStreamLine(JSON.stringify({ event: 'checkpoint' })).kind, 'unknown');

console.log('Antigravity stream protocol tests passed');

import assert from 'node:assert/strict';
import {
  parseAntigravityStreamLine,
  unwrapAntigravityArg,
  unwrapAntigravityArgsRecord,
} from './adapters/antigravity-stream';

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

assert.equal(unwrapAntigravityArg('"C:\\\\foo\\\\bar.ts"'), 'C:\\foo\\bar.ts');
assert.equal(unwrapAntigravityArg('true'), true);
assert.equal(unwrapAntigravityArg('5000'), 5000);
assert.equal(unwrapAntigravityArg('plain text'), 'plain text');
assert.deepEqual(
  unwrapAntigravityArgsRecord({
    Path: '"D:\\\\repo\\\\file.ts"',
    Overwrite: 'true',
    WaitMsBeforeAsync: '5000',
    Native: { a: 1 },
  }),
  { Path: 'D:\\repo\\file.ts', Overwrite: true, WaitMsBeforeAsync: 5000, Native: { a: 1 } },
);

const initWithTranscript = parseAntigravityStreamLine(JSON.stringify({
  event: 'init',
  conversation_id: '844cd50f-5b14-4ab3-a5b2-b4840fd7d8d4',
  transcript_path: 'C:\\Users\\test\\.gemini\\antigravity-cli\\brain\\844cd50f-5b14-4ab3-a5b2-b4840fd7d8d4\\.system_generated\\logs\\transcript.jsonl',
}));
assert.equal(initWithTranscript.kind, 'init');
if (initWithTranscript.kind === 'init') {
  assert.equal(
    initWithTranscript.transcriptPath,
    'C:\\Users\\test\\.gemini\\antigravity-cli\\brain\\844cd50f-5b14-4ab3-a5b2-b4840fd7d8d4\\.system_generated\\logs\\transcript.jsonl',
  );
}

const toolInfoStep = parseAntigravityStreamLine(JSON.stringify({
  event: 'step_update',
  step_update: {
    step_index: 4,
    step_type: 'tool_call',
    state: 'DONE',
    thinking_delta: 'Checking file contents first',
    tool_info: {
      name: 'read_file',
      args: { Path: '"D:\\\\repo\\\\src\\\\index.ts"', StartLine: '1', EndLine: '50' },
      output: 'export const ok = true;',
    },
  },
}));
assert.equal(toolInfoStep.kind, 'step');
if (toolInfoStep.kind === 'step') {
  assert.equal(toolInfoStep.stepIndex, 4);
  assert.equal(toolInfoStep.thinking, 'Checking file contents first');
  assert.equal(toolInfoStep.toolName, 'read_file');
  assert.deepEqual(toolInfoStep.args, { Path: 'D:\\repo\\src\\index.ts', StartLine: 1, EndLine: 50 });
  assert.equal(toolInfoStep.output, 'export const ok = true;');
}

const subagentStep = parseAntigravityStreamLine(JSON.stringify({
  event: 'step_update',
  step_update: {
    step_index: 5,
    step_type: 'subagent',
    tool_name: 'invoke_subagent',
    args: { Role: '"Codebase Researcher"', TypeName: '"research"', Model: '"flash"' },
    subagent_info: {
      conversation_id: '11111111-1111-4111-8111-111111111111',
      state: 'RUNNING',
    },
  },
}));
assert.equal(subagentStep.kind, 'step');
if (subagentStep.kind === 'step') {
  assert.equal(subagentStep.toolName, 'invoke_subagent');
  assert.deepEqual(subagentStep.subagent, {
    conversationId: '11111111-1111-4111-8111-111111111111',
    role: 'Codebase Researcher',
    typeName: 'research',
    model: 'flash',
    state: 'RUNNING',
  });
}

const askStringified = parseAntigravityStreamLine(JSON.stringify({
  event: 'step_update',
  step_update: {
    step_index: 6,
    step_type: 'planner_response',
    tool_name: 'ask_question',
    args: {
      questions: JSON.stringify([{ question: 'Which DB?', options: ['Postgres', 'SQLite'], is_multi_select: false }]),
    },
  },
}));
assert.equal(askStringified.kind, 'step');
if (askStringified.kind === 'step') {
  assert.equal(askStringified.toolName, 'ask_question');
  assert.deepEqual(askStringified.args?.questions, [{ question: 'Which DB?', options: ['Postgres', 'SQLite'], is_multi_select: false }]);
}

const askNative = parseAntigravityStreamLine(JSON.stringify({
  event: 'step_update',
  step_update: {
    step_index: 7,
    step_type: 'planner_response',
    tool_info: {
      name: 'ask_question',
      args: {
        questions: [{ question: 'Deploy target?', options: ['AWS', 'Fly.io'], is_multi_select: true }],
      },
    },
  },
}));
assert.equal(askNative.kind, 'step');
if (askNative.kind === 'step') {
  assert.equal(askNative.toolName, 'ask_question');
  assert.deepEqual(askNative.args?.questions, [{ question: 'Deploy target?', options: ['AWS', 'Fly.io'], is_multi_select: true }]);
}

const richResult = parseAntigravityStreamLine(JSON.stringify({
  event: 'result',
  result: {
    status: 'SUCCESS',
    response: 'Done',
    finished_reason: 'stop',
    conversation_id: '844cd50f-5b14-4ab3-a5b2-b4840fd7d8d4',
    transcript_path: 'C:\\transcript.jsonl',
  },
}));
assert.equal(richResult.kind, 'result');
if (richResult.kind === 'result') {
  assert.equal(richResult.finishedReason, 'stop');
  assert.equal(richResult.conversationId, '844cd50f-5b14-4ab3-a5b2-b4840fd7d8d4');
  assert.equal(richResult.transcriptPath, 'C:\\transcript.jsonl');
}

const swarmAddStep = parseAntigravityStreamLine(JSON.stringify({
  event: 'step_update',
  step_update: {
    step_index: 8,
    step_type: 'tool_call',
    tool_name: 'swarm',
    args: JSON.stringify({ action: 'add', name: 'arch-analyst', model: 'gemini-4-hydrogen-high' }),
    output: 'Created At: 2026-11-18T10:00:00+03:00\nCompleted At: 2026-11-18T10:00:02+03:00\n{"status":"added","name":"arch-analyst","model":"gemini-4-hydrogen-high","model_display_name":"Gemini 4 Hydrogen (High)","conversation_id":"22222222-2222-4222-8222-222222222222"}',
  },
}));
assert.equal(swarmAddStep.kind, 'step');
if (swarmAddStep.kind === 'step') {
  assert.equal(swarmAddStep.toolName, 'swarm');
  assert.deepEqual(swarmAddStep.subagent, {
    conversationId: '22222222-2222-4222-8222-222222222222',
    role: 'arch-analyst',
    typeName: 'swarm',
    model: 'Gemini 4 Hydrogen (High)',
    state: 'added',
  });
}

console.log('Antigravity stream protocol tests passed');

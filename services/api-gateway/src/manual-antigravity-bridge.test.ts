import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildAntigravityToolItem,
  ManualAntigravityBridge,
  parseAntigravityQuestions,
  parseAntigravityTranscript,
} from './manual-antigravity-bridge';
import type { ManualAgent } from './manual-conversations';

const root = fs.mkdtempSync(path.join(os.tmpdir(),'atris-manual-agy-'));
try {
  const provider = path.join(root,'provider');fs.mkdirSync(provider);
  const bridge = new ManualAntigravityBridge(path.join(root,'app'),provider);
  const first = {id:randomUUID(),runtimeType:'antigravity'} as ManualAgent;
  const other = {...first,id:randomUUID()};
  const session = randomUUID(), secondSession = randomUUID();
  const rows = [
    {step_index:0,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:'Merhaba'},
    {step_index:1,type:'CHECKPOINT',source:'SYSTEM',status:'DONE',content:'Private system details'},
    {step_index:2,type:'PLANNER_RESPONSE',source:'MODEL',status:'RUNNING',content:'Partial reply'},
    {step_index:2,type:'PLANNER_RESPONSE',source:'MODEL',status:'DONE',content:'Hello!'},
    {step_index:3,type:'TOOL_CALL',source:'MODEL',status:'DONE',content:'Raw tool payload'},
  ].map(row=>JSON.stringify(row)).join('\n');
  const messages = parseAntigravityTranscript(rows,session);
  assert.deepEqual(messages.map(message=>message.text),['Merhaba','Hello!']);
  assert.equal(parseAntigravityTranscript(rows+'\n{"partial":',session).length,2);
  const wrapped = '<USER_REQUEST>\nMerhaba\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-10T08:32:44+03:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting Model Selection to Gemini 3.8 Flash.\n</USER_SETTINGS_CHANGE>';
  const parseUser = (content: string) => parseAntigravityTranscript(JSON.stringify({step_index:4,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content}),session);
  assert.equal(parseUser(wrapped)[0].text,'Merhaba','Provider metadata is not part of the visible user message');
  assert.equal(parseUser(wrapped.replaceAll('USER_SETTINGS_CHANGE','USERSETTINGSCHANGE'))[0].text,'Merhaba');
  assert.equal(parseUser(wrapped.replaceAll('\n','\r\n'))[0].text,'Merhaba','Windows transcript line endings are supported');
  const codeRequest = 'Review this XML:\n```xml\n<ADDITIONAL_METADATA>keep this</ADDITIONAL_METADATA>\n<USER_REQUEST>example</USER_REQUEST>\n```';
  assert.equal(parseUser(`<USER_REQUEST>\n${codeRequest}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>clock</ADDITIONAL_METADATA>`)[0].text,codeRequest,'Nested tag examples inside the request are preserved');
  for (const unchanged of [codeRequest,'<USER_REQUEST>unfinished', '<USER_REQUEST>hello</USER_REQUEST>\nUser-authored trailing text', '<USER_REQUEST>hello</USER_REQUEST><UNKNOWN>keep</UNKNOWN>', '<USER_REQUEST>hello</USER_REQUEST><ADDITIONAL_METADATA>unfinished']) {
    assert.equal(parseUser(unchanged)[0].text,unchanged,'Ordinary content, unknown suffixes and incomplete envelopes are preserved');
  }
  assert.equal(parseUser('<USER_REQUEST>\n \n</USER_REQUEST><ADDITIONAL_METADATA>clock</ADDITIONAL_METADATA>').length,0,'Empty requests do not create empty bubbles');
  const assistantEnvelope = parseAntigravityTranscript(JSON.stringify({step_index:5,type:'PLANNER_RESPONSE',source:'MODEL',status:'DONE',content:wrapped}),session);
  assert.equal(assistantEnvelope[0].text,wrapped,'Assistant explanations are not normalized as user envelopes');
  const launch = bridge.prepare(first); assert.equal(launch[0],'--log-file');assert.equal(launch.includes('--continue'),false);
  const second = bridge.prepare(other);assert.notEqual(launch[1],second[1]);
  const transcript = path.join(provider,'brain',session,'.system_generated','logs','transcript.jsonl');
  fs.mkdirSync(path.dirname(transcript),{recursive:true});fs.writeFileSync(transcript,rows);
  fs.writeFileSync(path.join(provider,'cli.log'),`Created conversation ${session}`);
  assert.equal(bridge.read(first).bound,false,'Shared logs/newest transcripts never establish identity');
  fs.appendFileSync(launch[1],`INFO Created conversation ${session}\n`);
  assert.equal((bridge as any).session(first),session,'Dedicated creation event resolves exact identity');
  assert.equal(path.relative(fs.realpathSync(provider),fs.realpathSync(transcript)).toLowerCase(),path.join('brain',session,'.system_generated','logs','transcript.jsonl').toLowerCase());
  assert.equal(bridge.read(first).bound,true,'Transcript path is bound');
  assert.deepEqual(bridge.read(first).messages,messages,'Only the launch-owned log binds its exact transcript');
  assert.equal(bridge.read(other).bound,false,'Independent agent does not inherit this session');
  fs.writeFileSync(launch[1],'log rolled beyond creation');
  assert.equal(bridge.read(first).bound,true,'Verified identity survives bounded log rotation');
  const resumed = bridge.prepare(first);assert.deepEqual(resumed.slice(2),['--conversation',session]);
  fs.writeFileSync(resumed[1],`Created conversation ${secondSession}\n`);
  assert.equal(bridge.read(first).bound,false,'A contradictory resumed identity is not silently accepted');
  fs.writeFileSync(second[1],`Created conversation ${session}\nCreated conversation ${secondSession}\n`);
  assert.equal(bridge.read(other).bound,false,'Ambiguous root/subagent logs fail closed');
  assert.throws(()=>bridge.prepare({...first,id:'../../outside'}),'Agent identity cannot escape app data');

  // parseAntigravityQuestions coverage
  const singleQ = parseAntigravityQuestions(
    JSON.stringify([{ question: 'Which runtime?', options: ['(Recommended) Node', 'Deno'] }]),
    'q-single',
  );
  assert.deepEqual(singleQ, {
    id: 'q-single',
    questions: [{
      header: '',
      question: 'Which runtime?',
      options: [{ label: '(Recommended) Node' }, { label: 'Deno' }],
      multiple: false,
      custom: true,
    }],
  });

  const multiQ = parseAntigravityQuestions([
    { question: 'Pick frameworks', options: [{ label: 'React', description: 'UI' }, { text: 'Solid' }], is_multi_select: true, custom: false },
    { header: 'Target', question: 'Deploy?', options: ['Fly', 'AWS'] },
  ], 'q-multi');
  assert.equal(multiQ?.questions[0].header, 'Question 1/2');
  assert.equal(multiQ?.questions[0].multiple, true);
  assert.equal(multiQ?.questions[0].custom, false);
  assert.equal(multiQ?.questions[1].header, 'Target');

  // Backward compatibility: plain PLANNER_RESPONSE emits no extra keys
  const plainMsg = parseAntigravityTranscript(
    JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'Plain' }),
    session,
  )[0];
  assert.deepEqual(plainMsg, { id: `${session}:0`, role: 'assistant', text: 'Plain' });

  // Rich transcript: thinking, stringified args, tools, subagents, artifacts, ask_question + answer
  const subagentId = randomUUID();
  const richRows = [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'Audit the repo' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      thinking: 'Need to read config and spawn researcher.',
      output_tokens: 42,
      content: 'Inspecting files now.',
      tool_calls: [
        { id: 'c1', name: 'read_file', args: { Path: JSON.stringify('D:\\repo\\package.json') } },
        { id: 'c2', name: 'run_command', args: { CommandLine: JSON.stringify('npm test'), toolSummary: JSON.stringify('Run unit tests') } },
        { id: 'c3', name: 'write_file', args: { Path: JSON.stringify(path.join(provider, 'brain', session, 'plan.md')), Content: JSON.stringify('# Plan'), ArtifactMetadata: JSON.stringify({ Summary: 'Implementation plan', RequestFeedback: true }) } },
        { id: 'c4', name: 'invoke_subagent', args: { Role: JSON.stringify('Codebase Researcher'), TypeName: JSON.stringify('research'), Model: JSON.stringify('flash') } },
      ],
    },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: '{"name":"app"}' },
    { step_index: 3, type: 'GENERIC', status: 'ERROR', content: 'Test failed' },
    { step_index: 4, type: 'GENERIC', status: 'DONE', content: 'Wrote plan.md' },
    { step_index: 5, type: 'GENERIC', status: 'DONE', content: `Launched subagent ${subagentId}` },
    { step_index: 6, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', status: 'DONE', content: `[Message] sender=${subagentId} content=Done` },
    {
      step_index: 7,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      content: '',
      tool_calls: [
        { id: 'c5', name: 'ask_question', args: { questions: JSON.stringify([{ question: 'Proceed?', options: ['Yes', 'No'] }]) } },
      ],
    },
    { step_index: 8, type: 'GENERIC', status: 'RUNNING', content: '' },
  ].map(row => JSON.stringify(row)).join('\n');

  const richMessages = parseAntigravityTranscript(richRows, session);
  const planner1 = richMessages.find(m => m.id === `${session}:1`)!;
  assert.equal(planner1.thinking, 'Need to read config and spawn researcher.');
  assert.equal(planner1.thinkingTokens, 42);
  assert.equal(planner1.tools?.length, 4);
  assert.equal(planner1.tools?.[0].summary, 'Read package.json');
  assert.equal(planner1.tools?.[0].status, 'completed');
  assert.equal(planner1.tools?.[1].summary, 'Run unit tests');
  assert.equal(planner1.tools?.[1].status, 'failed');
  assert.equal(planner1.tools?.[2].artifact?.requestFeedback, true);
  assert.equal(planner1.tools?.[2].artifact?.summary, 'Implementation plan');
  assert.equal(planner1.tools?.[3].summary, 'Codebase Researcher (flash)');
  assert.equal(planner1.tools?.[3].subagent?.conversationId, subagentId);
  assert.equal(planner1.tools?.[3].status, 'completed');

  // Answered ask_question emits :answer user message and resolves question
  const answeredRows = richRows.replace(
    JSON.stringify({ step_index: 8, type: 'GENERIC', status: 'RUNNING', content: '' }),
    JSON.stringify({ step_index: 8, type: 'GENERIC', status: 'DONE', content: 'Q1: Proceed?\nA1: Yes' }),
  );
  const answeredMessages = parseAntigravityTranscript(answeredRows, session);
  assert.equal(answeredMessages.find(m => m.id === `${session}:8:answer`)?.text, 'Yes');

  // transcript_full.jsonl preference + pendingQuestions + activity states
  const third = { ...first, id: randomUUID() };
  const thirdLaunch = bridge.prepare(third);
  const thirdSession = randomUUID();
  assert.equal(bridge.activity(third).state, 'unknown');
  fs.appendFileSync(thirdLaunch[1], `2026-11-18T00:00:00Z INFO Created conversation ${thirdSession}\n2026-11-18T00:00:01Z INFO CLI ready for user input\n`);
  assert.equal(bridge.activity(third).state, 'ready');
  fs.appendFileSync(thirdLaunch[1], `2026-11-18T00:00:02Z INFO Surfacing ask_question at step 7\n`);
  assert.equal(bridge.activity(third).state, 'attention');

  const fullTranscript = path.join(provider, 'brain', thirdSession, '.system_generated', 'logs', 'transcript_full.jsonl');
  const compactTranscript = path.join(provider, 'brain', thirdSession, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(fullTranscript), { recursive: true });
  fs.writeFileSync(compactTranscript, JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'Compact' }));
  fs.writeFileSync(fullTranscript, richRows);
  const readThird = bridge.read(third);
  assert.equal(readThird.messages[0].text, 'Audit the repo', 'prefers transcript_full.jsonl over transcript.jsonl');
  assert.equal(readThird.questions.length, 1);
  assert.equal(bridge.pendingQuestions(third).length, 1);
  assert.equal(bridge.activity(third).state, 'attention');

  fs.writeFileSync(fullTranscript, answeredRows + '\n' + JSON.stringify({ step_index: 9, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'All done!' }));
  fs.appendFileSync(thirdLaunch[1], `2026-11-18T00:00:03Z INFO AskQuestion response for step 7\n`);
  assert.equal(bridge.pendingQuestions(third).length, 0);
  assert.equal(bridge.activity(third).state, 'completed');

  // Swarm worker subagent cards, MCP tool summaries, board tools, and timestamp header stripping
  const swarmWorkerId = randomUUID();
  const swarmRows = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'Analyze with swarm' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      thinking: 'Spawning swarm worker and claiming workspace paths.',
      tool_calls: [
        { name: 'swarm', args: { action: '"title"', title: '"AtrisHub Audit"' } },
        { name: 'swarm', args: { action: '"add"', name: '"arch-analyst"', model: '"gemini-4-hydrogen-high"', brief: '"Inspect architecture"' } },
        { name: 'call_mcp_tool', args: { ServerName: '"atris_workspace"', ToolName: '"workspace_send_message"', Arguments: JSON.stringify({ body: 'Started audit' }) } },
        { name: 'read_board', args: { since: '2' } },
        { name: 'post_message', args: { text: '"@arch-analyst check routes"' } },
      ],
    }),
    JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Created At: 2026-11-18T10:00:00Z\nCompleted At: 2026-11-18T10:00:01Z\n{"status":"titled","title":"AtrisHub Audit"}' }),
    JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE', content: `Created At: 2026-11-18T10:00:01Z\nCompleted At: 2026-11-18T10:00:02Z\n{"status":"added","name":"arch-analyst","model":"gemini-4-hydrogen-high","model_display_name":"Gemini 4 Hydrogen (High)","conversation_id":"${swarmWorkerId}"}` }),
    JSON.stringify({ step_index: 4, type: 'GENERIC', status: 'DONE', content: 'Created At: 2026-11-18T10:00:02Z\nCompleted At: 2026-11-18T10:00:03Z\n{"ok":true}' }),
    JSON.stringify({ step_index: 5, type: 'GENERIC', status: 'DONE', content: 'Created At: 2026-11-18T10:00:03Z\nCompleted At: 2026-11-18T10:00:04Z\n{"messages":[]}' }),
    JSON.stringify({ step_index: 6, type: 'GENERIC', status: 'DONE', content: 'Created At: 2026-11-18T10:00:04Z\nCompleted At: 2026-11-18T10:00:05Z\n{"seq":3}' }),
  ].join('\n');
  const parsedSwarmRunning = parseAntigravityTranscript(swarmRows, session);
  const swarmTurn = parsedSwarmRunning.find(m => m.id === `${session}:1`)!;
  assert.equal(swarmTurn.tools?.[0].summary, 'Swarm title: AtrisHub Audit');
  assert.equal(swarmTurn.tools?.[1].summary, 'arch-analyst (Gemini 4 Hydrogen (High))');
  assert.deepEqual(swarmTurn.tools?.[1].subagent, {
    conversationId: swarmWorkerId,
    role: 'arch-analyst',
    typeName: 'swarm',
    model: 'Gemini 4 Hydrogen (High)',
  });
  assert.equal(swarmTurn.tools?.[1].status, 'running', 'Swarm add stays running until worker finishes or is killed');
  assert.equal(swarmTurn.tools?.[2].summary, 'atris_workspace: workspace_send_message');
  assert.equal(swarmTurn.tools?.[2].detail, 'Started audit');
  const externalTool = buildAntigravityToolItem('call_mcp_tool', {
    ServerName: 'external', ToolName: 'lookup', Arguments: JSON.stringify({ token: 'private-fixture', query: 'private-query' }),
  }, { id: 'external-tool', status: 'completed' });
  assert.equal(externalTool.summary, 'external: lookup');
  assert.equal(externalTool.detail, undefined, 'Arbitrary MCP arguments must not appear in the chat card');
  assert.equal(swarmTurn.tools?.[3].summary, 'Read board (since #2)');
  assert.equal(swarmTurn.tools?.[4].summary, 'Post to @arch-analyst');

  const swarmKilledRows = swarmRows + '\n' + [
    JSON.stringify({
      step_index: 7,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      tool_calls: [{ name: 'swarm', args: { action: '"kill"', name: '"arch-analyst"' } }],
    }),
    JSON.stringify({ step_index: 8, type: 'GENERIC', status: 'DONE', content: '{"status":"killed","name":"arch-analyst"}' }),
  ].join('\n');
  const parsedSwarmKilled = parseAntigravityTranscript(swarmKilledRows, session);
  assert.equal(parsedSwarmKilled.find(m => m.id === `${session}:1`)?.tools?.[1].status, 'completed');

  console.log('Antigravity transcript parsing, isolated log binding, resume and ambiguity tests passed.');
} finally { fs.rmSync(root,{recursive:true,force:true}); }

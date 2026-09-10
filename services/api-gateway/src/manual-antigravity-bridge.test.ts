import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManualAntigravityBridge, parseAntigravityTranscript } from './manual-antigravity-bridge';
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
  console.log('Antigravity transcript parsing, isolated log binding, resume and ambiguity tests passed.');
} finally { fs.rmSync(root,{recursive:true,force:true}); }

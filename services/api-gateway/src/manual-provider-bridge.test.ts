import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ManualProviderBridge, parseCodexManualTranscript } from './manual-provider-bridge';
import type { ManualAgent } from './manual-conversations';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-manual-providers-'));
const agent: ManualAgent = {id:randomUUID(), conversationId:randomUUID(), providerSessionId:randomUUID(), name:'Test agent', catalogId:'test', runtimeType:'codex', model:'test-model', accountProfileId:'test', cwd:temporary, configDir:path.join(temporary,'profile'), sharedProfile:false, createdAt:new Date().toISOString()};
const bridge = new ManualProviderBridge(temporary);
const line = (type: string, payload: unknown, timestamp = '2026-09-08T00:00:00Z') => JSON.stringify({type,payload,timestamp});
const publicTranscript = [
  line('session_meta',{id:agent.providerSessionId}),
  line('response_item',{type:'message', role:'developer', content:[{type:'input_text',text:'Internal config'}]}),
  line('event_msg',{type:'user_message',message:'Hello'}),
  line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'Injected environment'}]}),
  line('response_item',{type:'message',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'Private reasoning'}]}),
  line('response_item',{type:'message',role:'assistant',channel:'final',content:[{type:'output_text',text:'Visible response'}]}),
].join('\n');
try {
  const claude = {...agent,id:randomUUID(),runtimeType:'claude_code'};
  const claudeArgs = bridge.prepareClaude(claude, false);
  const settingsFile = claudeArgs[claudeArgs.indexOf('--settings')+1];
  assert.ok(fs.existsSync(settingsFile), 'Claude settings travel as a file, not shell-interpreted JSON');
  assert.equal(JSON.parse(fs.readFileSync(settingsFile,'utf8')).hooks.SessionStart[0].hooks[0].type,'command');
  assert.deepEqual(bridge.prepareClaude(claude,false),claudeArgs,'Repeated launch reuses immutable settings');
  const parsed = parseCodexManualTranscript(publicTranscript, agent.providerSessionId);
  assert.deepEqual(parsed.map(message => message.text), ['Hello','Visible response']);
  assert.deepEqual(parseCodexManualTranscript(publicTranscript.split('\n').slice(2).join('\n'), agent.providerSessionId).map(m=>m.id), parsed.map(m=>m.id), 'Message identity survives bounded history reads');
  const args = bridge.prepareCodex(agent);
  assert.ok(args.includes('--profile'));
  assert.ok(!args.some(arg => arg.includes('bypass')), 'Hook trust is never bypassed');
  const profileText = fs.readFileSync(path.join(agent.configDir, `atris-manual-${agent.id}.config.toml`), 'utf8');
  assert.ok(profileText.includes('command_windows = "powershell.exe'));
  const script = path.join(temporary,'manual-sessions',agent.id,'bind-session.cjs');
  const bindingFile = path.join(temporary,'manual-sessions',agent.id,'bindings.jsonl');
  const transcript = path.join(agent.configDir, `${agent.providerSessionId}.jsonl`);
  fs.writeFileSync(transcript, publicTranscript);
  const callHook = (sessionId: string, transcriptPath: string) => spawnSync(process.execPath,[script,bindingFile],{input:JSON.stringify({hook_event_name:'SessionStart',session_id:sessionId,transcript_path:transcriptPath}),encoding:'utf8'});
  const hookResult = callHook(agent.providerSessionId, transcript);
  assert.equal(hookResult.status,0,`Synthetic hook failed: ${hookResult.stderr || hookResult.error?.message}`);
  assert.equal(bridge.read(agent).bound,true);
  assert.equal(bridge.read(agent).messages.length,2);
  assert.deepEqual(bridge.prepareCodex(agent).slice(0,2),['resume',agent.providerSessionId]);
  assert.equal(callHook(randomUUID(),transcript).status,0);
  assert.equal(bridge.read(agent).messages.length,2,'Wrong session headers are rejected');
  const external = path.join(temporary,'outside-profile.jsonl'); fs.writeFileSync(external,publicTranscript);
  callHook(agent.providerSessionId,external);
  assert.equal(bridge.read(agent).messages.length,2,'Out-of-profile history paths cannot replace a binding');

  // Optional local CLI schema smoke: no model, authentication, network or task is invoked.
  if (process.env.ATRIS_TEST_CODEX_EXECUTABLE) {
    const smoke = spawnSync(process.env.ATRIS_TEST_CODEX_EXECUTABLE,['--profile',`atris-manual-${agent.id}`,'mcp','list'],{env:{...process.env,CODEX_HOME:agent.configDir},encoding:'utf8',timeout:10000});
    assert.equal(smoke.status,0,`Installed Codex rejected the generated profile: ${smoke.stderr}`);
    console.log('Installed Codex accepted the generated layered hook profile.');
  }

  const openAgent = {...agent,id:randomUUID(),runtimeType:'opencode'};
  const prepared = bridge.prepareOpenCode(openAgent);
  assert.ok(!('OPENCODE_CONFIG_CONTENT' in prepared.env),'Inherited config values never cross the UI transport');
  const plugin = await import(prepared.env.ATRIS_MANUAL_OPENCODE_PLUGIN);
  const observer = await plugin.AtrisManualSession();
  await observer.event({event:{type:'session.created',properties:{info:{id:'ses_root'}}}});
  await observer.event({event:{type:'message.updated',properties:{info:{id:'msg_one',sessionID:'ses_root',role:'assistant'}}}});
  await observer.event({event:{type:'message.part.updated',properties:{part:{id:'part_one',messageID:'msg_one',sessionID:'ses_root',type:'text',text:'Live response'}}}});
  await observer.event({event:{type:'session.created',properties:{info:{id:'ses_child',parentID:'ses_root'}}}});
  await observer.event({event:{type:'message.part.updated',properties:{part:{id:'foreign',messageID:'msg_one',sessionID:'ses_child',type:'text',text:'Wrong agent'}}}});
  await new Promise(resolve=>setTimeout(resolve,160));
  const history = bridge.read(openAgent);
  assert.equal(history.bound,true);
  assert.deepEqual(history.messages.map(m=>m.text),['Live response']);
  assert.deepEqual(bridge.prepareOpenCode(openAgent).args.slice(0,2),['--session','ses_root']);
  assert.equal(pathToFileURL(script).protocol,'file:');
  console.log('Codex hook binding, transcript isolation, resume and OpenCode plugin regression tests passed.');
} finally { fs.rmSync(temporary,{recursive:true,force:true}); }

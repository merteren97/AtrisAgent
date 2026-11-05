/** Opt-in real Windows ConPTY + owning app-server acceptance. Default: local fake
 * inference; --authenticated: use the existing Codex account for four no-tool replies.
 * Never copies credentials, changes config.toml, or touches an existing terminal.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {ManualCodexSessions} from '../services/api-gateway/src/manual-codex-session.ts';
import {ManualProviderBridge} from '../services/api-gateway/src/manual-provider-bridge.ts';
import type {ManualAgent} from '../services/api-gateway/src/manual-conversations.ts';

if (process.platform !== 'win32') throw new Error('This acceptance fixture requires Windows ConPTY.');
const executable=process.env.ATRIS_TEST_CODEX_EXECUTABLE;
if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('Set ATRIS_TEST_CODEX_EXECUTABLE to the installed native codex.exe.');
const authenticated=process.argv.includes('--authenticated');
execFileSync('cargo',['test','--manifest-path','apps/desktop/src-tauri/Cargo.toml','--no-run'],{windowsHide:true,stdio:'inherit',timeout:240000});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'atris-native-policy-'));
const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
const home=authenticated ? process.env.CODEX_HOME || path.join(os.homedir(),'.codex') : path.join(root,'home');
if (!authenticated) fs.mkdirSync(home);
const model=process.env.ATRIS_TEST_CODEX_MODEL || 'gpt-6.1-sol';
const reasoning=process.env.ATRIS_TEST_CODEX_REASONING || 'low';
const fake=http.createServer((_req,res)=>{res.writeHead(400,{'content-type':'application/json'});res.end('{"error":{"message":"Disposable local acceptance provider","type":"invalid_request_error"}}');});
if (!authenticated) {
 await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve));
 fs.writeFileSync(path.join(home,'config.toml'),`model_provider="probe"\ncheck_for_update_on_startup=false\n[model_providers.probe]\nname="Local probe"\nbase_url="http://127.0.0.1:${(fake.address() as any).port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
}
const agent:ManualAgent={id:randomUUID(),conversationId:randomUUID(),providerSessionId:randomUUID(),name:'Acceptance',catalogId:'probe',runtimeType:'codex',model,reasoning,accountProfileId:'probe',cwd:fs.realpathSync.native(cwd),configDir:home,sharedProfile:authenticated,createdAt:new Date().toISOString()};
const bridge=new ManualProviderBridge(root), manager=new ManualCodexSessions();
const args=bridge.prepareCodex(agent,true), env=authenticated ? {} : {CODEX_HOME:home};
const profile=path.join(home,`atris-manual-${agent.id}.config.toml`);
const endpoint=await manager.create(agent.id,{executable,cwd:agent.cwd,env,model,reasoning,mode:'ask-for-approval',onThread:(id,file)=>bridge.bindCodexRuntime(agent,id,file)});
args.push('--remote',endpoint.url,'--remote-auth-token-env','ATRIS_CODEX_REMOTE_TOKEN','--cd',agent.cwd);
const modes=['full-access','read-only','approve-for-me','ask-for-approval'] as const;
const markers=modes.map((_,index)=>`ATRIS_ACCEPT_${index}_${randomUUID().slice(0,8)}`);
const prompts=markers.map(marker=>`This is an isolated application acceptance test. Do not call tools, read files or run commands. Reply with exactly ${marker}.`);
const filename=path.join(root,'fixture.json');fs.writeFileSync(filename,JSON.stringify({root,prompts,launch:{id:agent.id,executable,args,cwd:agent.cwd,env:{...env,ATRIS_CODEX_REMOTE_TOKEN:endpoint.token}}}),{mode:0o600});
let exited=false,exitCode:number|null=null;
function launchNative(file:string){exited=false;exitCode=null;const test=spawn('cargo',['test','--manifest-path','apps/desktop/src-tauri/Cargo.toml','manual_terminal::tests::installed_codex_live_permissions','--','--test-threads=1'],{env:{...process.env,ATRIS_TEST_CODEX_LIVE_FIXTURE:file},windowsHide:true,stdio:['ignore','pipe','pipe']});test.on('exit',code=>{exited=true;exitCode=code;});test.on('error',()=>{exited=true;exitCode=-1;});test.stdout.resume();test.stderr.resume();return test;}
let child=launchNative(filename);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const resumeTrace:unknown[]=[];
async function wait(check:()=>boolean,label:string,timeout=90000){const deadline=Date.now()+timeout;while(!check()){if(exited)throw new Error(`Native test exited (${exitCode}) before ${label}`);if(manager.failure(agent.id))throw new Error(`${label}: ${manager.failure(agent.id)}`);if(Date.now()>deadline)throw new Error(`${label} timed out; ${JSON.stringify(manager.get(agent.id)?.status())}`);await sleep(50);}}
async function settled(session:NonNullable<ReturnType<ManualCodexSessions['get']>>,label:string){let since=0;await wait(()=>{if(!session.status().available){since=0;return false;}if(!since)since=Date.now();return Date.now()-since>=300;},label);}
try {
 await wait(()=>fs.existsSync(path.join(root,'native-ready')),'native startup',240000);
 const session=manager.get(agent.id)!;await settled(session,'verified startup');
 const identity=session.status().threadId;assert.equal(session.status().mode,'ask-for-approval');
 for(let index=0;index<modes.length;index++){
  await settled(session,'idle policy update boundary');
  const mode=modes[index], before=session.activity().at;
  const result=await session.apply({...session.status(),mode,fullAccessConfirmed:true});assert.equal(result.mode,mode);assert.equal(result.threadId,identity);
  fs.writeFileSync(path.join(root,`send-${index}`),'send');
  await wait(()=>fs.existsSync(path.join(root,`sent-${index}`)),`native send ${mode}`);
  await wait(()=>session.activity().at!==before && session.status().available,`turn completion ${mode}`);
  await wait(()=>bridge.read(agent).messages.some(message=>message.role==='user'&&message.text.includes(markers[index])),`bound history ${mode}`);
  if(authenticated) await wait(()=>bridge.read(agent).messages.some(message=>message.role==='assistant'&&message.text.trim()===markers[index]),`authenticated reply ${mode}`);
  assert.equal(session.status().mode,mode,'The next native turn preserves the applied policy');assert.equal(session.status().threadId,identity);
 }
 fs.writeFileSync(path.join(root,'finish'),'finish');
 const deadline=Date.now()+15000;while(!exited&&Date.now()<deadline)await sleep(50);assert.equal(exitCode,0,'Native terminal test closes cleanly');
 const closedDeadline=Date.now()+5000;while(manager.get(agent.id)&&Date.now()<closedDeadline)await sleep(50);assert.equal(manager.get(agent.id),undefined,'Owning server closes with the native terminal');
 const resumeRoot=path.join(root,'resume-control');fs.mkdirSync(resumeRoot);
 const resumedArgs=bridge.prepareCodex(agent,true);assert.deepEqual(resumedArgs.slice(0,2),['resume',identity]);
 const resumedEndpoint=await manager.create(agent.id,{executable,cwd:agent.cwd,env,model,reasoning,mode:'ask-for-approval',onThread:(id,file)=>bridge.bindCodexRuntime(agent,id,file)});
 if(!authenticated){const isolated=manager.get(agent.id) as any;const receive=isolated.receive.bind(isolated),write=isolated.write.bind(isolated);isolated.write=(message:any)=>{resumeTrace.push({out:message.method,threadId:message.params?.threadId});write(message);};isolated.receive=(message:any)=>{resumeTrace.push({in:message.method||'response',threadId:message.result?.thread?.id,path:message.result?.thread?.path,error:message.error?.message});receive(message);};}
 resumedArgs.push('--remote',resumedEndpoint.url,'--remote-auth-token-env','ATRIS_CODEX_REMOTE_TOKEN','--cd',agent.cwd);
 const resumeFile=path.join(resumeRoot,'fixture.json');fs.writeFileSync(resumeFile,JSON.stringify({root:resumeRoot,allowDiagnosticCapture:!authenticated,prompts:[prompts[0]],launch:{id:agent.id,executable,args:resumedArgs,cwd:agent.cwd,env:{...env,ATRIS_CODEX_REMOTE_TOKEN:resumedEndpoint.token}}}),{mode:0o600});
 child=launchNative(resumeFile);await wait(()=>fs.existsSync(path.join(resumeRoot,'native-ready')),'resumed native startup');
 const resumed=manager.get(agent.id)!;await settled(resumed,'resumed verified policy');assert.equal(resumed.status().threadId,identity);
 await assert.rejects(resumed.apply({...resumed.status(),runtimeId:endpoint.runtimeId,mode:'read-only'}),/changed/);
 assert.equal((await resumed.apply({...resumed.status(),mode:'read-only'})).mode,'read-only');
 fs.writeFileSync(path.join(resumeRoot,'send-0'),'send');await wait(()=>fs.existsSync(path.join(resumeRoot,'sent-0')),'resumed native send');
 fs.writeFileSync(path.join(resumeRoot,'finish'),'finish');
 const resumedDeadline=Date.now()+15000;while(!exited&&Date.now()<resumedDeadline)await sleep(50);assert.equal(exitCode,0);
 console.log(JSON.stringify({result:'PASS',authenticated,modes:[...modes],sameThread:true,resumeSameThread:true,staleRuntimeRejected:true,nativeConPTY:true,publicHistory:true,closed:true}));
} catch(error) {if(!authenticated&&resumeTrace.length){await sleep(500);const capture=path.join(root,'resume-control','native-startup.txt');console.error(JSON.stringify({isolatedResumeTrace:resumeTrace,isolatedTerminal:fs.existsSync(capture)?fs.readFileSync(capture,'utf8').slice(-6000):undefined}));}throw error;} finally {
 if(!exited&&child.pid)try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
 await manager.closeAll();fake.closeAllConnections();fake.close();
 if(authenticated)fs.rmSync(profile,{force:true});
 // Disposable provider diagnostics stay local to the test; no auth files were copied.
 fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {ManualCodexSessions, effectiveCodexMode, codexChildEnvironment} from './manual-codex-session';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-live-policy-'));
const isolatedEnv = codexChildEnvironment({ATRIS_RUNTIME_TOKEN:'private-sentinel',ATRIS_PARENT_PID:'123',ATRIS_CODEX_REMOTE_TOKEN:'private-control',PORT:'0',CODEX_HOME:'selected-home',OPENAI_API_KEY:'provider-sentinel'});
assert.equal(isolatedEnv.ATRIS_RUNTIME_TOKEN,undefined); assert.equal(isolatedEnv.ATRIS_PARENT_PID,undefined);assert.equal(isolatedEnv.ATRIS_CODEX_REMOTE_TOKEN,undefined);assert.equal(isolatedEnv.PORT,undefined);
assert.equal(isolatedEnv.CODEX_HOME,'selected-home');assert.equal(isolatedEnv.OPENAI_API_KEY,'provider-sentinel');
// A real stdio child exercises framing, identity correlation, WS authentication,
// notification/ack order and process ownership. It is not a real Codex acceptance.
fs.writeFileSync(path.join(root, 'app-server'), `
const readline=require('node:readline');let fault,thread='root',mode=':workspace';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const settings=()=>({cwd:process.cwd(),approvalPolicy:mode===':danger-full-access'?'never':'on-request',approvalsReviewer:mode==='auto'?'auto_review':'user',sandboxPolicy:{type:mode===':danger-full-access'?'dangerFullAccess':mode===':read-only'?'readOnly':'workspaceWrite'}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const p=m.params||{};
if(m.method==='initialize')return send({id:m.id,result:{}});
if(m.method==='fixture/startup')return send({id:m.id,result:{args:process.argv.slice(2),url:process.env.ATRIS_CONTROL_PLANE_URL,token:process.env.ATRIS_CONTROL_PLANE_TOKEN,manual:process.env.ATRIS_MANUAL_COORDINATION,runtimeToken:process.env.ATRIS_RUNTIME_TOKEN}});
if(m.method==='thread/start'||m.method==='thread/resume') {if(!p.ephemeral)thread=p.threadId||'root';return send({id:m.id,result:{thread:{id:p.ephemeral?'title':thread},cwd:process.cwd(),approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'workspaceWrite'}}});}
if(m.method==='fixture/event'){send(p.event);return send({id:m.id,result:{}});}
if(m.method==='fixture/fault'){fault=p.value;return send({id:m.id,result:{}});}
if(m.method==='fixture/large')return send({id:m.id,result:{payload:'ğ'.repeat(9*1024*1024)}});
if(m.method==='thread/settings/update') {if(fault==='timeout')return; if(fault==='error'){fault=null;return send({id:m.id,error:{message:'policy rejected',code:-32600}});}mode=p.approvalsReviewer==='auto_review'?'auto':p.permissions;
 const s=settings();if(fault==='mismatch')s.approvalsReviewer='user';send({method:'thread/settings/updated',params:{threadId:p.threadId,threadSettings:s}});fault=null;return send({id:m.id,result:{}});}
if(m.id!==undefined&&m.method)send({id:m.id,result:{}});
});
`);
const sessions = new ManualCodexSessions();
const sockets: WebSocket[] = [];
let next = 0;
async function open(id: string, coordination?: {endpoint:string;script:string;token:string}, playwright?: {command:string;args:string[]}) {
  const endpoint = await sessions.create(id, {executable:process.execPath, cwd:root, env:{}, mode:'ask-for-approval', onThread:() => {}, coordination, playwright});
  const socket = new WebSocket(endpoint.url, {headers:{Authorization:`Bearer ${endpoint.token}`}}); sockets.push(socket);
  await once(socket, 'open');
  const pending = new Map<number, (message: any) => void>();
  socket.on('message', bytes => {const message=JSON.parse(bytes.toString());pending.get(message.id)?.(message);});
  const rpc = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
    const id=++next; pending.set(id, message=>{pending.delete(id);message.error?reject(new Error(message.error.message)):resolve(message.result);});
    socket.send(JSON.stringify({method,id,params}));
  });
  await rpc('initialize', {clientInfo:{name:'test',version:'1'}});
  await rpc('thread/start', {threadSource:'user'});
  return {socket, rpc, endpoint, session:sessions.get(id)!};
}
try {
  const a=await open('a'), b=await open('b');
  const coordinated = await open('coordinated',{endpoint:'http://127.0.0.1:3456',script:'bridge.mjs',token:'scoped-token'});
  const startup = await coordinated.rpc('fixture/startup');
  assert.equal(startup.token,'scoped-token'); assert.equal(startup.manual,'1'); assert.equal(startup.runtimeToken,undefined);
  assert(startup.args.some((arg:string) => arg.includes('mcp_servers.atris_workspace.command')));
  assert(!startup.args.some((arg:string) => arg.includes('scoped-token')),'Grant must not be placed in argv');
  const browser = await open('browser',undefined,{command:process.execPath,args:['C:\\test path\\cli.js','--isolated']});
  const browserStartup = await browser.rpc('fixture/startup');
  assert(browserStartup.args.includes(`mcp_servers.atris_playwright.command=${JSON.stringify(process.execPath)}`));
  assert(browserStartup.args.includes(`mcp_servers.atris_playwright.args=${JSON.stringify(['C:\\test path\\cli.js','--isolated'])}`));
  assert(!startup.args.some((arg:string) => arg.includes('mcp_servers.atris_playwright')), 'Other sessions retain independent MCP configuration');
  const unauthorized = new WebSocket(a.endpoint.url); let rejected=false;
  unauthorized.on('error', () => {rejected=true;}); await new Promise(resolve => unauthorized.once('close',resolve)); assert.equal(rejected,true);
  const initial=a.session.status();
  assert.equal(a.session.activity().state,'ready','Startup is not a completed task notification');
  const large=await a.rpc('fixture/large');assert.equal(large.payload.length,9*1024*1024,'A fragmented UTF-8 response larger than 16 MiB retains its full frame');
  await assert.rejects(a.session.apply({...initial,mode:'full-access'}), /Confirm Full Access/);
  for (const mode of ['full-access','read-only','approve-for-me','ask-for-approval'] as const) {
    const before=a.session.status();
    const result=await a.session.apply({...before,mode,fullAccessConfirmed:true});
    assert.equal(result.mode,mode); assert.equal(result.applying,false); assert.equal(result.threadId,initial.threadId);
    assert.equal(b.session.status().mode,'ask-for-approval','Other agents retain their own policies');
    await assert.rejects(a.session.apply({...before,mode,fullAccessConfirmed:true}), /changed/);
  }
  await assert.rejects(a.session.apply({...a.session.status(),runtimeId:b.endpoint.runtimeId,mode:'read-only'}), /changed/);
  await a.rpc('fixture/event',{event:{method:'turn/started',params:{threadId:'root',turn:{id:'turn'}}}});
  await assert.rejects(a.session.apply({...a.session.status(),mode:'read-only'}), /active turn/);
  await a.rpc('fixture/event',{event:{method:'turn/completed',params:{threadId:'root',turn:{id:'turn'}}}});
  assert.equal(a.session.activity().state,'completed');
  await a.rpc('fixture/event',{event:{id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'root'}}});
  await assert.rejects(a.session.apply({...a.session.status(),mode:'read-only'}), /pending approval/);
  a.socket.send(JSON.stringify({id:'approval',result:{decision:'decline'}}));
  await a.rpc('fixture/event',{event:{method:'serverRequest/resolved',params:{threadId:'root',requestId:'approval'}}});
  assert.equal(a.session.status().available,true);
  await a.rpc('thread/start',{ephemeral:true,threadSource:'thread_title'});
  assert.equal(a.session.status().threadId,'root','Title helper cannot replace the user thread');
  await a.rpc('thread/resume',{threadId:'foreign'});
  assert.equal(a.session.status().available,false);
  await assert.rejects(a.session.apply({...a.session.status(),mode:'read-only'}), /Multiple conversations/);
  await b.rpc('fixture/fault',{value:'mismatch'});
  await assert.rejects(b.session.apply({...b.session.status(),mode:'approve-for-me'}), /different effective/);
  assert.equal(b.session.status().mode,'ask-for-approval','A mismatched result shows the actual reported policy, not the requested one');
  const c=await open('c');
  await c.rpc('fixture/fault',{value:'timeout'});
  const updating=c.session.apply({...c.session.status(),mode:'read-only'});
  await assert.rejects(c.session.apply({...c.session.status(),mode:'full-access',fullAccessConfirmed:true}), /already in progress/);
  await assert.rejects(c.rpc('thread/settings/update',{threadId:'root',permissions:':danger-full-access'}),/being updated/);
  await assert.rejects(c.rpc('turn/start',{threadId:'root',input:[]}),/being updated/);
  await assert.rejects(updating,/confirm/);
  assert.equal(c.session.status().mode,undefined,'Timeout invalidates the effective policy claim');
  const d=await open('d');
  await d.rpc('fixture/fault',{value:'error'});
  await assert.rejects(d.session.apply({...d.session.status(),mode:'read-only'}), /policy rejected/);
  const e=await open('e');
  await e.rpc('fixture/fault',{value:'timeout'});
  const disconnected=e.session.apply({...e.session.status(),mode:'read-only'});
  e.socket.terminate(); await assert.rejects(disconnected,/disconnect/);
  assert.equal(effectiveCodexMode({approvalPolicy:'never',approvalsReviewer:'auto_review',sandboxPolicy:{type:'dangerFullAccess'}}),undefined);
  console.log('Live permission protocol: authentication, four modes, notification confirmation, stale identity/revision, isolation, active turn/approval, helpers, ambiguity, refusal, timeout and disconnect passed.');
} finally {for(const socket of sockets)socket.terminate();await sessions.closeAll();fs.rmSync(root,{recursive:true,force:true});}

/** Isolated Windows filesystem diagnostic. Uses the existing Codex binary and a
 * disposable, unelevated sandbox home; no account, admin setup or model task.
 * This is sandbox evidence, not a test of auto-review decisions or the reported user failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync, execFile} from 'node:child_process';
import {rm} from 'node:fs/promises';
import readline from 'node:readline';
const executable=process.env.ATRIS_TEST_CODEX_EXECUTABLE;
if(!executable||!path.isAbsolute(executable))throw new Error('Set ATRIS_TEST_CODEX_EXECUTABLE to codex.exe.');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'atris-sandbox-matrix-'));
const home=path.join(root,'home'),cwd=path.join(root,'workspace'),outside=path.join(root,'outside');
for(const dir of [home,cwd,outside,path.join(cwd,'ordinary'),path.join(cwd,'nested-repo')])fs.mkdirSync(dir);
spawnSync('git',['init','--quiet',path.join(cwd,'nested-repo')],{windowsHide:true});
fs.symlinkSync(outside,path.join(cwd,'junction'),'junction');
fs.writeFileSync(path.join(home,'config.toml'),'[windows]\nsandbox="unelevated"\n');
const network=http.createServer((_req,res)=>res.end('fixture'));
await new Promise<void>(resolve=>network.listen(0,'127.0.0.1',resolve));
const child=spawn(executable,['app-server','--stdio'],{cwd,env:{...process.env,CODEX_HOME:home},windowsHide:true,stdio:'pipe'});
child.stderr.resume();let id=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const lines=readline.createInterface({input:child.stdout});
lines.on('line',line=>{const message=JSON.parse(line),p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(new Error(message.error.message)):p.resolve(message.result);});
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error('Sandbox fixture RPC timed out'));},30000);pending.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:key,method,params})+'\n');});
try{
 await rpc('initialize',{clientInfo:{name:'atris_sandbox_fixture',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized","params":{}}\n');
 const program=`const fs=require('node:fs');const cases=${JSON.stringify({ordinary:path.join(cwd,'ordinary','probe'),nestedGitSource:path.join(cwd,'nested-repo','probe'),gitMetadata:path.join(cwd,'nested-repo','.git','probe'),externalJunction:path.join(cwd,'junction','probe'),outside:path.join(outside,'probe')})};const results={};for(const [key,file] of Object.entries(cases)){try{fs.writeFileSync(file,'fixture');results[key]='written';}catch(e){results[key]=e.code;}}const git=require('node:child_process').spawnSync('git',['-C',${JSON.stringify(path.join(cwd,'nested-repo'))},'add','probe'],{windowsHide:true});results.gitAdd=git.status??git.error?.code;fetch('http://127.0.0.1:${(network.address() as any).port}',{signal:AbortSignal.timeout(2000)}).then(r=>results.network=r.status).catch(e=>results.network=e.cause?.code||e.name).finally(()=>console.log(JSON.stringify(results)));`;
 const workspace={type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
 const results=[];
 for(const [mode,policy] of [['ask-for-approval',workspace],['approve-for-me',workspace],['full-access',{type:'dangerFullAccess'}],['read-only',{type:'readOnly',networkAccess:false}],['authorized-external-root',{...workspace,writableRoots:[outside]}]] as const){
  try{const r=await rpc('command/exec',{command:[process.execPath,'-e',program],cwd,sandboxPolicy:policy,timeoutMs:10000});results.push({mode,exitCode:r.exitCode,result:r.stdout?.trim()?JSON.parse(r.stdout.trim()):undefined,error:r.stderr?.trim()?r.stderr.trim().slice(0,300):undefined});}
  catch(e){results.push({mode,error:e instanceof Error?e.message:String(e)});}
 }
 console.log(JSON.stringify({platform:process.platform,codex:spawnSync(executable,['--version'],{encoding:'utf8',windowsHide:true}).stdout.trim(),backend:'unelevated (fixture only)',results},null,2));
}finally{
 for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Fixture closed'));}
 lines.close();
 if(child.exitCode===null&&child.pid&&process.platform==='win32')await new Promise<void>(resolve=>execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},()=>resolve()));
 child.stdin.end();child.kill();
 if(child.exitCode===null)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
 network.closeAllConnections();network.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}

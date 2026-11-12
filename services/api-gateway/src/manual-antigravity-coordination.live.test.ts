import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import express from 'express';
import { installManualCoordinationCallRoute, manualCoordination } from './manual-coordination';
import { prepareManualCoordination } from './manual-coordination-config';
import type { ManualAgent } from './manual-conversations';

async function run() {
  const executable = process.env.ATRIS_TEST_AGY_EXECUTABLE;
  if (!executable) { console.log('Antigravity live MCP test skipped: ATRIS_TEST_AGY_EXECUTABLE is not set.'); return; }
  console.log('Preparing the isolated Antigravity MCP test.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'atris-agy-live-mcp-'));
  const project = path.join(root,'project'); const data = path.join(root,'data');
  fs.mkdirSync(project); fs.mkdirSync(data);
  let requests = 0;
  const app = express(); app.use('/api/internal/manual-coordination/call',(_req,_res,next) => {requests += 1; next();});
  installManualCoordinationCallRoute(app,express.json({limit:'32kb'}));
  let server!: ReturnType<typeof app.listen>;
  await new Promise<void>((resolve,reject) => { server = app.listen(0,'127.0.0.1',error => error ? reject(error) : resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const script = path.resolve(process.cwd(),'../coordination-mcp/src/control-plane-bridge.mjs');
  manualCoordination.configure({endpoint,script});
  const agent = {id:'a',cwd:project,name:'Agy test',runtimeType:'antigravity'} as ManualAgent;
  const grant = manualCoordination.issue(agent);
  const prepared = prepareManualCoordination(agent,data,grant);
  console.log('Starting Antigravity in the test project.');
  const child = spawn(executable,[...prepared.args,'--print','Reply only OK. Do not use tools.','--print-timeout','15s','--output-format','json'],{
    cwd:project,env:{...process.env,...prepared.env},stdio:['ignore','pipe','pipe'],windowsHide:true,
  });
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { if (diagnostics.length < 32_000) diagnostics += String(bytes).slice(0,32_000-diagnostics.length); });
  try {
    const deadline = Date.now()+20_000;
    while (Date.now()<deadline && !manualCoordination.live.snapshot(project).agents.length && child.exitCode === null) await new Promise(resolve => setTimeout(resolve,200));
    const connected = manualCoordination.live.snapshot(project).agents[0]?.id === 'a';
    if (!connected) console.log(JSON.stringify({requests,exitCode:child.exitCode,outputBytes:diagnostics.length,mentionsMcp:/mcp/i.test(diagnostics),mentionsPermission:/permission|denied/i.test(diagnostics)}));
    assert(connected,'Installed Antigravity must connect the scoped MCP bridge');
    assert.equal(prepared.cwd,undefined,'The project must remain the process working directory');
    console.log('Installed Antigravity loaded and connected the workspace MCP bridge.');
  } finally {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') await new Promise<void>(resolve => execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},() => resolve()));
      else child.kill();
    }
    manualCoordination.configure(undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
    const realRoot = fs.realpathSync(root), tmp = fs.realpathSync(os.tmpdir());
    const relative = path.relative(tmp,realRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unexpected test directory');
    try { fs.rmSync(realRoot,{recursive:true,force:true,maxRetries:10,retryDelay:250}); }
    catch { console.warn('Windows retained the temporary test directory; cleanup is deferred.'); }
  }
}
void run();

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { installUnityCliRoutes } from './unity-cli-connection';

const root = fs.mkdtempSync(path.join(os.tmpdir(),'atris-unity-cli-'));
const executable = path.join(root, process.platform === 'win32' ? 'Unity.exe' : 'Unity');
fs.writeFileSync(executable, 'fixture');
const db = new Database(':memory:'); db.exec('CREATE TABLE integration_connections (id TEXT PRIMARY KEY, config TEXT NOT NULL)');
const app = express(); app.use(express.json());
let version = '6000.0.42f1';
installUnityCliRoutes(app, db, async () => version);
const server = app.listen(0,'127.0.0.1');
try {
  await new Promise<void>(resolve => server.once('listening',resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/integrations/unity-cli`;
  const verify = (input:string) => fetch(`${base}/verify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({executable:input})});
  assert.equal((await verify('relative')).status,400);
  assert.equal((await verify(executable)).status,200);
  let response = await fetch(base); assert.equal((await response.json() as any).connection.version,version);
  version = 'invalid'; assert.equal((await verify(executable)).status,400);
  response = await fetch(base); assert.equal((await response.json() as any).connection.version,'6000.0.42f1');
  await fetch(base,{method:'DELETE'}); response = await fetch(base); assert.equal((await response.json() as any).connection,null);
  console.log('Unity CLI connection checks passed');
} finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); fs.rmSync(root,{recursive:true,force:true}); }

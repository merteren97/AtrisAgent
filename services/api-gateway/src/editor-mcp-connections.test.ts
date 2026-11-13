import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { installEditorMcpRoutes, parseEditorCommand } from './editor-mcp-connections';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-editor-mcp-'));
const fixture = path.join(root, 'server.cjs');
fs.writeFileSync(fixture, `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:'test_tool',inputSchema:{type:'object'}}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
const db = new Database(':memory:');
db.exec('CREATE TABLE integration_connections (id TEXT PRIMARY KEY, config TEXT NOT NULL)');
const app = express(); app.use(express.json()); installEditorMcpRoutes(app, db);
const server = app.listen(0,'127.0.0.1');
try {
  assert.throws(() => parseEditorCommand({command:'node',args:[]}));
  assert.throws(() => parseEditorCommand({command:process.execPath,args:['--api-key=secret']}));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/integrations/editors`;
  for (const id of ['unity-mcp','blender','godot']) {
    const result = await fetch(`${base}/${id}/verify`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command:process.execPath,args:[fixture]})});
    assert.equal(result.status,200); assert.equal((await result.json() as any).connection.toolCount,1);
  }
  let response = await fetch(base); assert.equal(Object.keys((await response.json() as any).connections).length,3);
  response = await fetch(`${base}/github`, {method:'DELETE'}); assert.equal(response.status,404);
  await fetch(`${base}/blender`, {method:'DELETE'});
  response = await fetch(base); assert.equal(Object.keys((await response.json() as any).connections).length,2);
  console.log('Editor MCP connection checks passed');
} finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); fs.rmSync(root,{recursive:true,force:true}); }

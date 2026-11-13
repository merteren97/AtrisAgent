import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { configuredPlaywrightCommand, installIntegrationConnectionRoutes, resolvePlaywrightPackage, verifyPlaywrightPackage } from './integration-connections';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-integration-'));
const database = new Database(':memory:');
const app = express();
app.use(express.json());
installIntegrationConnectionRoutes(app, database);
const server = app.listen(0, '127.0.0.1');
try {
  await new Promise<void>(resolve => server.once('listening', resolve));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'cli.js'), `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  const result = m.method === 'initialize' ? {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}} : {tools:[{name:'browser_navigate',inputSchema:{type:'object'}}]};
  console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});`);
  assert.throws(() => resolvePlaywrightPackage('relative/path'));
  assert.equal((await verifyPlaywrightPackage(root)).toolCount, 1);
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/integrations/playwright`;
  let response = await fetch(`${base}/verify`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({packagePath:root}) });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).connection.version, '1.2.3');
  assert.deepEqual(configuredPlaywrightCommand(database), {command:process.execPath,args:[path.join(fs.realpathSync(root),'cli.js'),'--isolated']});
  response = await fetch(base);
  assert.equal((await response.json() as any).connection.toolCount, 1);
  response = await fetch(`${base}/verify`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({packagePath:'invalid'}) });
  assert.equal(response.status, 400);
  response = await fetch(base);
  assert.equal((await response.json() as any).connection.version, '1.2.3', 'A failed verification must not overwrite the saved connection.');
  await fetch(base, { method:'DELETE' });
  response = await fetch(base);
  assert.equal((await response.json() as any).connection, null);
  assert.equal(configuredPlaywrightCommand(database), undefined);
  if (process.env.ATRIS_PLAYWRIGHT_TEST_PACKAGE) {
    const live = await verifyPlaywrightPackage(process.env.ATRIS_PLAYWRIGHT_TEST_PACKAGE);
    assert(live.toolCount > 0);
    console.log(`Live Playwright MCP ${live.version}: ${live.toolCount} tools discovered`);
  }
  console.log('Integration connection checks passed');
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  database.close();
  fs.rmSync(root, {recursive:true,force:true});
}

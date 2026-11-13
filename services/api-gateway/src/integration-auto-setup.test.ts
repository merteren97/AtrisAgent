import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { discoverUnityEditors, hasExistingBlenderAddon, installAutoSetupRoutes, reusableNodeInstallation, setupIntegration } from './integration-auto-setup';

const root = fs.mkdtempSync(path.join(os.tmpdir(),'atris-auto-setup-'));
const editor = path.join(root,'Unity','Hub','Editor','6000.0.42f1','Editor');
fs.mkdirSync(editor,{recursive:true}); fs.writeFileSync(path.join(editor,'Unity.exe'),'fixture');
const db = new Database(':memory:'); db.exec('CREATE TABLE integration_connections (id TEXT PRIMARY KEY, config TEXT NOT NULL)');
const app = express(); app.use(express.json());
let calls = 0;
let failSetup = false;
let release: (() => void) | undefined;
installAutoSetupRoutes(app,db,root,async (id,directory) => {
  calls++; assert.equal(directory,root);
  if (id === 'blender' || failSetup) throw new Error('missing dependency');
  if (id === 'godot') await new Promise<void>(resolve => { release = resolve; });
  return {config:{version:'fixture'},guidance:'Ready'};
});
const server = app.listen(0,'127.0.0.1');
try {
  assert.deepEqual(discoverUnityEditors('win32',{ProgramFiles:root},root),[fs.realpathSync(path.join(editor,'Unity.exe'))]);
  const existing = path.join(root,'Blender Foundation','Blender','5.2','scripts','addons');
  fs.mkdirSync(existing,{recursive:true}); fs.writeFileSync(path.join(existing,'custom.py'),`bl_info = {"name": "Blender MCP"}`);
  assert.equal(hasExistingBlenderAddon('win32',{APPDATA:root},root),true,'Existing Blender add-ons must not be overwritten.');
  fs.rmSync(path.join(root,'Blender Foundation'),{recursive:true,force:true});
  await new Promise<void>(resolve => server.once('listening',resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/integrations`;
  const request = (id:string) => fetch(`${base}/${id}/auto-setup`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command:'ignored',args:['ignored']})});
  assert.equal((await request('invalid')).status,404);
  assert.equal((await request('playwright')).status,200);
  const saved = (db.prepare('SELECT config FROM integration_connections WHERE id = ?').get('playwright') as any).config;
  assert.equal(saved,JSON.stringify({version:'fixture',setupGuidance:'Ready'}));
  assert.equal((await request('blender')).status,400);
  assert.equal(db.prepare('SELECT config FROM integration_connections WHERE id = ?').get('blender'),undefined);
  assert.equal(calls,2);
  failSetup = true;
  assert.equal((await request('playwright')).status,400);
  assert.equal((db.prepare('SELECT config FROM integration_connections WHERE id = ?').get('playwright') as any).config,saved,'A failed re-check preserves the working connection.');
  failSetup = false;
  const pending = request('godot');
  while (!release) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal((await request('godot')).status,409,'A repeated setup request must not start a second installer.');
  release(); assert.equal((await pending).status,200);
  const managed = path.join(root,'integration-packages','fixture','node_modules','@playwright','mcp');
  fs.mkdirSync(managed,{recursive:true}); fs.writeFileSync(path.join(managed,'package.json'),JSON.stringify({name:'@playwright/mcp',version:'0.0.85'})); fs.writeFileSync(path.join(managed,'cli.js'),'fixture');
  assert.equal(reusableNodeInstallation(root,'playwright',{packagePath:managed}),path.resolve(managed,'../../..'));
  assert.equal(reusableNodeInstallation(root,'playwright',{packagePath:root}),undefined);
  if (process.env.ATRIS_AUTO_SETUP_LIVE === '1') {
    const result = await setupIntegration('playwright',root);
    assert((result.config as {toolCount:number}).toolCount > 0);
    const rechecked = await setupIntegration('playwright',root,result.config);
    assert.equal((rechecked.config as {packagePath:string}).packagePath,(result.config as {packagePath:string}).packagePath,'A repeat setup reuses the managed installation.');
    console.log('Live automatic Playwright installation and MCP verification passed');
    const godot = await setupIntegration('godot',root);
    assert((godot.config as {toolCount:number}).toolCount > 0);
    console.log('Live automatic Godot MCP installation and verification passed');
  }
  if (process.env.ATRIS_AUTO_UNITY_LIVE === '1') {
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = root;
    try {
      const unity = await setupIntegration('unity-mcp',root);
      assert((unity.config as {toolCount:number}).toolCount > 0);
      console.log('Live automatic Unity MCP installation and verification passed');
    } finally { if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous; }
  }
  if (process.env.ATRIS_AUTO_BLENDER_LIVE === '1') {
    const previousLocal = process.env.LOCALAPPDATA;
    const previousAddon = process.env.BLENDERMCP_ADDONS_DIR;
    const previousUserAddon = process.env.BLENDER_USER_ADDONS;
    const previousAppData = process.env.APPDATA;
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    const addons = path.join(root,'blender-addons'); fs.mkdirSync(addons);
    process.env.LOCALAPPDATA = root; process.env.APPDATA = root; process.env.HOME = root; process.env.USERPROFILE = root; process.env.BLENDERMCP_ADDONS_DIR = addons; process.env.BLENDER_USER_ADDONS = addons;
    try {
      const blender = await setupIntegration('blender',root);
      assert((blender.config as {toolCount:number}).toolCount > 0);
      assert(fs.readdirSync(addons).length > 0, `The add-on should be installed in the disposable fixture directory: ${blender.guidance}`);
      console.log('Live automatic Blender MCP and add-on installation passed');
    } finally {
      if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
      if (previousAddon === undefined) delete process.env.BLENDERMCP_ADDONS_DIR; else process.env.BLENDERMCP_ADDONS_DIR = previousAddon;
      if (previousUserAddon === undefined) delete process.env.BLENDER_USER_ADDONS; else process.env.BLENDER_USER_ADDONS = previousUserAddon;
      if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    }
  }
  console.log('Automatic integration setup routing and Unity discovery passed');
} finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); fs.rmSync(root,{recursive:true,force:true}); }

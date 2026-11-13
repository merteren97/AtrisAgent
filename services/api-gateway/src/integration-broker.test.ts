import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntegrationBroker } from './integration-broker';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-broker-'));
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name:'@playwright/mcp', version:'1.0.0' }));
fs.writeFileSync(path.join(root, 'cli.js'), `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 let result=m.method==='initialize' ? {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}} : m.method==='tools/list' ? {tools:[{name:'browser_navigate',inputSchema:{type:'object'}}]} : {content:[{type:'text',text:JSON.stringify(m.params.arguments)}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});`);
const scope = { workspaceId:'workspace', sessionId:'session', agentId:'agent' };
let approved = false;
let lastCall: { integrationId:string; workspacePath?:string } | undefined;
const broker = new IntegrationBroker(async call => { lastCall = call; return approved; });
try {
  const token = await broker.openPlaywright(scope, root);
  assert.equal(broker.listTools(token, scope)[0].name, 'playwright__browser_navigate');
  assert.throws(() => broker.listTools(token, {...scope, agentId:'other'}));
  await assert.rejects(broker.callTool(token, scope, 'playwright__browser_navigate', {url:'http://example.test'}), /not authorized/);
  approved = true;
  const result = await broker.callTool(token, scope, 'playwright__browser_navigate', {url:'http://example.test'});
  assert.match(JSON.stringify(result), /example.test/);
  await assert.rejects(broker.callTool(token, scope, 'playwright__unknown', {}), /Unknown/);
  for (const id of ['unity','blender','godot'] as const) {
    const editor = await broker.openEditor(scope, id, {command:process.execPath,args:[path.join(root,'cli.js')]}, root);
    assert.equal(broker.listTools(editor,scope)[0].name,`${id}__browser_navigate`);
    await assert.rejects(broker.callTool(editor, scope, 'playwright__browser_navigate', {}), /Unknown/);
    await broker.callTool(editor,scope,`${id}__browser_navigate`,{url:'about:blank'});
    assert.equal(lastCall?.integrationId,id);
    assert.equal(lastCall?.workspacePath,fs.realpathSync(root));
    await broker.close(editor);
  }
  const githubRequests: string[] = [];
  const github = await broker.openGithub(scope, async () => 'fixture-token', {fetch: async (input, init) => {
    assert.equal(String(input), 'https://api.githubcopilot.com/mcp/');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
    assert.equal(init?.redirect, 'error');
    if (init?.method === 'GET') return new Response(null,{status:405});
    const message = JSON.parse(String(init?.body || '{}'));
    if (message.id === undefined) return new Response(null,{status:202});
    githubRequests.push(message.method);
    const result = message.method === 'initialize' ? {protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'github-fixture',version:'1'}} : message.method === 'tools/list' ? {tools:[{name:'list_issues',inputSchema:{type:'object'}}]} : {content:[{type:'text',text:'issues'}]};
    return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{headers:{'content-type':'application/json'}});
  }});
  assert.equal(broker.listTools(github,scope)[0].name,'github__list_issues');
  assert(!JSON.stringify(broker.listTools(github,scope)).includes('fixture-token'));
  const githubResult = await broker.callTool(github,scope,'github__list_issues',{});
  assert.match(JSON.stringify(githubResult),/issues/);
  assert.equal(lastCall?.integrationId,'github');
  assert(githubRequests.includes('tools/call'));
  await broker.close(github);
  await broker.close(token);
  assert.throws(() => broker.listTools(token, scope));
  const expiring = await broker.openPlaywright(scope, root, {ttlMs:50});
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => broker.listTools(expiring, scope));
  if (process.env.ATRIS_PLAYWRIGHT_TEST_PACKAGE) {
    const live = await broker.openPlaywright(scope, process.env.ATRIS_PLAYWRIGHT_TEST_PACKAGE);
    const navigation = await broker.callTool(live, scope, 'playwright__browser_navigate', { url:'about:blank' });
    assert.equal(navigation.isError, undefined);
    await broker.close(live);
    console.log('Live Playwright MCP navigation passed');
  }
  console.log('Integration broker session checks passed');
} finally {
  await broker.closeAll();
  fs.rmSync(root,{recursive:true,force:true});
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installManualCoordinationCallRoute, manualCoordination } from './manual-coordination';
import { ManualIntegrationGateway } from './manual-integration-gateway';

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'atris-mcp-integration-'));
  const app = express();
  installManualCoordinationCallRoute(app,express.json({limit:'32kb'}));
  let server!: ReturnType<typeof app.listen>;
  await new Promise<void>((resolve,reject) => { server = app.listen(0,'127.0.0.1',error => error ? reject(error) : resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const script = path.resolve(process.cwd(),'../coordination-mcp/src/control-plane-bridge.mjs');
  const scopes = new Map<string,any>();
  const integration = new ManualIntegrationGateway({
    openGithub: async scope => { const key = `fixture-${scope.agentId}`; scopes.set(key,scope); return key; },
    listTools: (key, scope) => { assert.deepEqual(scope,scopes.get(key)); return [{name:'github__list_issues',inputSchema:{type:'object'}}] as any; },
    callTool: async (key, scope, name) => { assert.deepEqual(scope,scopes.get(key)); return {content:[{type:'text',text:`${name}:${scope.agentId}`}]}; },
    close: async key => { scopes.delete(key); }, closeAll: async () => { scopes.clear(); },
  }, async () => 'fixture');
  manualCoordination.setIntegrationGateway(integration);
  manualCoordination.configure({endpoint,script});
  const a = manualCoordination.issue({id:'a',cwd:root,name:'A',runtimeType:'codex'});
  const b = manualCoordination.issue({id:'b',cwd:root,name:'B',runtimeType:'claude'});
  const clients: Client[] = [];
  try {
    const connect = async (token:string) => {
      const client = new Client({name:'test',version:'1.0'});
      const transport = new StdioClientTransport({command:process.execPath,args:[script],env:{...process.env as Record<string,string>,ATRIS_CONTROL_PLANE_URL:endpoint,ATRIS_CONTROL_PLANE_TOKEN:token,ATRIS_MANUAL_COORDINATION:'1',ATRIS_RUNTIME_TOKEN:''}});
      await client.connect(transport); clients.push(client); return client;
    };
    const first = await connect(a.token), second = await connect(b.token);
    const tools = await first.listTools();
    assert(tools.tools.some(tool => tool.name === 'workspace_claim_paths'));
    assert(tools.tools.some(tool => tool.name === 'github__list_issues'));
    const github = await first.callTool({name:'github__list_issues',arguments:{}});
    assert.match(JSON.stringify(github.content),/github__list_issues:a/);
    const secondGithub = await second.callTool({name:'github__list_issues',arguments:{}});
    assert.match(JSON.stringify(secondGithub.content),/github__list_issues:b/);
    const unknown = await fetch(`${endpoint}/api/internal/manual-coordination/call`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${a.token}`},body:JSON.stringify({tool:'integration_call',arguments:{name:'github__delete_repository',arguments:{}}})});
    assert.equal(unknown.status,400);
    assert(!tools.tools.some(tool => tool.name === 'agent_spawn'));
    assert.equal((await first.callTool({name:'workspace_claim_paths',arguments:{paths:['x.ts'],intent:'edit'}})).isError,undefined);
    assert.equal((await second.callTool({name:'workspace_claim_paths',arguments:{paths:['x.ts'],intent:'edit'}})).isError,true);
    await first.callTool({name:'workspace_send_message',arguments:{toAgentId:'b',body:'hello'}});
    const result = await second.callTool({name:'workspace_read_messages'});
    assert.match(JSON.stringify(result.content),/hello/);
    const forbidden = await fetch(`${endpoint}/api/internal/manual-coordination/call`,{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json',Authorization:`Bearer ${a.token}`},body:'{"tool":"heartbeat"}'});
    assert.equal(forbidden.status,403);
    console.log('Manual coordination MCP transport passed');
  } finally {
    await Promise.all(clients.map(client => client.close()));
    manualCoordination.configure(undefined);
    manualCoordination.setIntegrationGateway(undefined);
    await integration.closeAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
void run();

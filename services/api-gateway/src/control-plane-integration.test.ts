import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ControlPlaneGrantRegistry } from './control-plane-grants';
import { installControlPlaneRoutes } from './control-plane-router';

const grants = new ControlPlaneGrantRegistry();
const grant = grants.issue({agentInstanceId:'worker',missionId:'mission',taskId:'task',role:'builder'});
let identity:any;
const integrations = {
  list: async (value:any) => { identity = value; return [{name:'github__list_issues',description:'List issues',inputSchema:{type:'object',properties:{}}}]; },
  call: async (value:any,name:string) => { assert.equal(value.agentId,'worker'); assert.equal(name,'github__list_issues'); return {content:[{type:'text',text:'fixture issues'}]}; },
};
const app = express(); app.use(express.json());
installControlPlaneRoutes(app,{grants,integrations,coordination:{} as any,eventBus:{} as any,workspaceManager:{} as any} as any);
const server = app.listen(0,'127.0.0.1');
const client = new Client({name:'test',version:'1'});
try {
  await new Promise<void>(resolve => server.once('listening',resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const script = path.resolve(process.cwd(),'../coordination-mcp/src/control-plane-bridge.mjs');
  const transport = new StdioClientTransport({command:process.execPath,args:[script],env:{...process.env as Record<string,string>,ATRIS_CONTROL_PLANE_URL:origin,ATRIS_CONTROL_PLANE_TOKEN:grant.token,ATRIS_MANUAL_COORDINATION:'0',ATRIS_RUNTIME_TOKEN:''}});
  await client.connect(transport);
  assert((await client.listTools()).tools.some(tool => tool.name === 'github__list_issues'));
  assert.equal(identity.agentId,'worker'); assert.equal(identity.cwd,'mission'); assert(!identity.sessionKey.includes(grant.token));
  const response = await client.callTool({name:'github__list_issues',arguments:{}});
  assert.match(JSON.stringify(response.content),/fixture issues/);
  grants.revokeAgent('worker');
  const revoked = await client.callTool({name:'github__list_issues',arguments:{}});
  assert.equal(revoked.isError,true);
  console.log('Orchestrator integration MCP transport passed');
} finally { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }

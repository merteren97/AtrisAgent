import assert from 'node:assert/strict';
import { IntegrationBroker } from './integration-broker';
import { readGithubCliToken } from './github-connection';
import express from 'express';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { manualCoordination, installManualCoordinationCallRoute } from './manual-coordination';
import { ManualIntegrationGateway } from './manual-integration-gateway';

if (process.env.ATRIS_GITHUB_MCP_LIVE !== '1') throw new Error('Set ATRIS_GITHUB_MCP_LIVE=1 to run this opt-in live test.');
const broker = new IntegrationBroker(async call => call.integrationId === 'github' && call.tool === 'get_me');
const scope = {workspaceId:'live-test',sessionId:'live-test',agentId:'live-test'};
try {
  const session = await broker.openGithub(scope, readGithubCliToken);
  const tools = broker.listTools(session,scope);
  assert(tools.some(tool => tool.name === 'github__get_me'), 'GitHub MCP must expose get_me');
  const result = await broker.callTool(session,scope,'github__get_me',{});
  assert.notEqual(result.isError,true, 'GitHub MCP account lookup must succeed');
  console.log(`GitHub MCP live test passed; ${tools.length} tools discovered and account lookup succeeded.`);
} finally { await broker.closeAll(); }

const app = express(); installManualCoordinationCallRoute(app,express.json({limit:'32kb'}));
const server = app.listen(0,'127.0.0.1');
const client = new Client({name:'live-bridge-test',version:'1'});
const gateway = new ManualIntegrationGateway(new IntegrationBroker(async call => call.integrationId === 'github' && call.tool === 'get_me'),readGithubCliToken);
manualCoordination.setIntegrationGateway(gateway);
try {
  await new Promise<void>(resolve => server.once('listening',resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const script = path.resolve(process.cwd(),'../coordination-mcp/src/control-plane-bridge.mjs');
  manualCoordination.configure({endpoint,script});
  const grant = manualCoordination.issue({id:'live-bridge-test',cwd:process.cwd(),name:'Live test',runtimeType:'codex'});
  const transport = new StdioClientTransport({command:process.execPath,args:[script],env:{...process.env as Record<string,string>,ATRIS_CONTROL_PLANE_URL:endpoint,ATRIS_CONTROL_PLANE_TOKEN:grant.token,ATRIS_MANUAL_COORDINATION:'1',ATRIS_RUNTIME_TOKEN:''}});
  await client.connect(transport);
  assert((await client.listTools(undefined,{timeout:30_000})).tools.some(tool => tool.name === 'github__get_me'));
  const result = await client.callTool({name:'github__get_me',arguments:{}},undefined,{timeout:30_000});
  assert.notEqual(result.isError,true);
  console.log('Live GitHub MCP through the manual session bridge passed.');
} finally {
  await client.close(); manualCoordination.configure(undefined); manualCoordination.setIntegrationGateway(undefined);
  await gateway.closeAll(); await new Promise<void>(resolve => server.close(() => resolve()));
}

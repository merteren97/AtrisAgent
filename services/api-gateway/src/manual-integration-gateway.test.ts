import assert from 'node:assert/strict';
import { ManualIntegrationGateway } from './manual-integration-gateway';

let opens = 0;
const closed:string[] = [];
const gateway = new ManualIntegrationGateway({
  openGithub: async () => { opens++; if (opens === 1) throw new Error('offline'); return `token-${opens}`; },
  listTools: () => [{name:'github__list_issues',inputSchema:{type:'object'}},{name:'github__delete_repository',inputSchema:{type:'object'}}] as any,
  callTool: async (_token,_scope,name) => ({content:[{type:'text',text:name}]}),
  close: async token => { closed.push(token); },
  closeAll: async () => undefined,
}, async () => 'fixture');
const identity = {agentId:'agent',cwd:'workspace',sessionKey:'session',expiresAt:Date.now()+60_000};
try {
  assert.deepEqual(await gateway.list(identity),[],'Unavailable connections do not break coordination.');
  const tools = await gateway.list(identity);
  assert.deepEqual(tools.map(tool => tool.name),['github__list_issues'],'Only permitted tools are exposed.');
  assert.equal(opens,2,'Failed connections may be retried.');
  const result = await gateway.call(identity,'github__list_issues',{});
  assert.match(JSON.stringify(result),/list_issues/);
  await assert.rejects(gateway.call(identity,'github__delete_repository',{}),/unauthorized/);
  await gateway.revokeAgent(identity.agentId);
  assert.deepEqual(closed,['token-2']);
  console.log('Integration gateway authorization and recovery passed');
} finally { await gateway.closeAll(); }

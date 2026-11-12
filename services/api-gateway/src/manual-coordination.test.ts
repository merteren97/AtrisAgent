import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManualCoordination } from './manual-coordination';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-coordination-'));
try {
  const coordination = new ManualCoordination();
  coordination.configure({endpoint:'http://127.0.0.1:1234',script:'bridge.mjs'});
  const a = coordination.issue({id:'a',cwd:root,name:'A',runtimeType:'codex'});
  const b = coordination.issue({id:'b',cwd:root,name:'B',runtimeType:'claude'});
  const call = (token: string, tool: string, args: Record<string, unknown> = {}) => coordination.call(`Bearer ${token}`, tool, args);
  call(a.token, 'workspace_claim_paths', {paths:['src/a.ts'],intent:'edit',agentId:'b'});
  const snapshot = call(b.token, 'workspace_get_state') as {claims: Array<{agentId:string}>};
  assert.equal(snapshot.claims[0].agentId, 'a');
  assert.throws(() => call(b.token, 'workspace_claim_paths', {paths:['src/a.ts'],intent:'edit'}), /conflict/);
  call(a.token,'workspace_send_message',{toAgentId:'b',body:'private message'});
  assert(!JSON.stringify(call(a.token,'workspace_get_state')).includes('private message'),'Workspace state does not expose other agents’ messages');
  assert.match(JSON.stringify(call(b.token,'workspace_read_messages')),/private message/);
  assert.throws(() => call('invalid', 'workspace_get_state'), /Invalid or expired/);
  assert.throws(() => coordination.call('Bearer ' + ' '.repeat(100_000) + a.token,'heartbeat',{}), /Invalid or expired/);
  assert.throws(() => coordination.call(`Bearer ${a.token}extra`,'heartbeat',{}), /Invalid or expired/);
  assert.throws(() => coordination.issue({id:'a',cwd:root,name:'A',runtimeType:'codex'}), /already has an active/);
  const claimId = (snapshot.claims[0] as {id?:string}).id!;
  assert.equal(coordination.live.clear(root,claimId),true);
  assert.match(JSON.stringify(call(a.token,'workspace_read_messages')),/cleared by the user/);
  coordination.revoke('a');
  assert.throws(() => call(a.token, 'workspace_get_state'), /Invalid or expired/);
  assert.equal((call(b.token, 'workspace_get_state') as {claims:unknown[]}).claims.length, 0);
  console.log('Manual coordination authorization passed');
} finally { fs.rmSync(root,{recursive:true,force:true}); }

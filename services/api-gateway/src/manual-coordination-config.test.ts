import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareManualCoordination } from './manual-coordination-config';
import type { ManualAgent } from './manual-conversations';

const root = fs.mkdtempSync(path.join(os.tmpdir(),'coord-config-'));
try {
  const agent = {id:'a',cwd:root,runtimeType:'claude_code'} as ManualAgent;
  const grant = {endpoint:'http://127.0.0.1:9999',script:'bridge.mjs',token:'secret-token'};
  const claude = prepareManualCoordination(agent,root,grant);
  assert.equal(claude.args[0],'--mcp-config');
  assert(!fs.readFileSync(claude.args[1],'utf8').includes(grant.token));
  assert.equal(claude.env.ATRIS_CONTROL_PLANE_TOKEN,grant.token);
  const open1 = prepareManualCoordination({...agent,runtimeType:'opencode'},root,grant,'1.2.3');
  const open2 = prepareManualCoordination({...agent,runtimeType:'opencode'},root,grant,'2.0.0');
  assert.equal(JSON.parse(open1.env.ATRIS_MANUAL_OPENCODE_MCP).server.enabled,true);
  assert.equal(JSON.parse(open2.env.ATRIS_MANUAL_OPENCODE_MCP).server.disabled,false);
  const anti = prepareManualCoordination({...agent,runtimeType:'antigravity'},root,grant);
  assert.equal(anti.args[0],'--add-dir');
  assert.equal(anti.cwd,undefined,'The CLI remains in the actual project directory');
  const config = fs.readFileSync(path.join(anti.args[1],'.agents','mcp_config.json'),'utf8');
  assert(!config.includes(grant.token),'The grant must not be saved in the MCP config');
  assert.deepEqual(JSON.parse(config).mcpServers.atris_workspace.args,[grant.script]);
  console.log('Manual provider coordination config passed');
} finally { fs.rmSync(root,{recursive:true,force:true}); }

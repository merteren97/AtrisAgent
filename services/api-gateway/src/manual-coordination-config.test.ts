import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  const secondClaude = prepareManualCoordination(agent,root,grant);
  assert.notEqual(secondClaude.args[1],claude.args[1],'Each launch gets its own config file');
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
  const secondAnti = prepareManualCoordination({...agent,id:'b',runtimeType:'antigravity'},root,{...grant,token:'next-token'});
  assert.equal(secondAnti.args[1],anti.args[1],'One execution folder keeps its overlay across launches and tabs');
  assert.equal(secondAnti.env.ATRIS_CONTROL_PLANE_TOKEN,'next-token');
  fs.mkdirSync(path.join(root, 'another-project'));
  assert.notEqual(prepareManualCoordination({...agent,cwd:path.join(root,'another-project'),runtimeType:'antigravity'},root,grant).args[1],anti.args[1]);
  const artifact = path.join(anti.args[1],'test_driver_headers.obj');
  fs.writeFileSync(artifact,'compiler output');
  const fixture = JSON.stringify({agent:{...agent,runtimeType:'antigravity'},root,grant});
  const cli = `
    import { prepareManualCoordination } from ${JSON.stringify(new URL('./manual-coordination-config.ts',import.meta.url).href)};
    const {agent,root,grant} = JSON.parse(process.argv[1]);
    console.log(prepareManualCoordination(agent,root,grant).args[1]);
  `;
  const launch = () => promisify(execFile)(process.execPath,[...process.execArgv,'--input-type=module','-e',cli,fixture]);
  const [first, second] = await Promise.all([launch(),launch()]);
  const recovered = first.stdout.trim();
  assert.notEqual(recovered,anti.args[1]);
  assert.equal(second.stdout.trim(),recovered,'Concurrent launches use the same complete recovery directory');
  assert.equal(fs.readFileSync(artifact,'utf8'),'compiler output');
  assert.deepEqual(fs.readdirSync(recovered),['.agents']);
  assert.deepEqual(fs.readdirSync(path.join(recovered,'.agents')),['mcp_config.json']);
  assert.equal(fs.readFileSync(path.join(recovered,'.agents','mcp_config.json'),'utf8'),config);
  const reopen = () => prepareManualCoordination({...agent,runtimeType:'antigravity'},root,grant).args[1];
  assert.equal(reopen(),recovered);
  fs.mkdirSync(path.join(recovered,'.agents','extra'));
  const next = reopen();
  assert.notEqual(next,recovered,'Repeated contamination also recovers');
  assert.equal(reopen(),next);
  // Missing .agents or mcp_config.json recovers into a clean generation rather than throwing ENOENT.
  fs.rmSync(path.join(next,'.agents','mcp_config.json'));
  const afterMissingConfig = reopen();
  assert.notEqual(afterMissingConfig,next);
  fs.rmSync(path.join(afterMissingConfig,'.agents'),{recursive:true,force:true});
  const afterMissingAgents = reopen();
  assert.notEqual(afterMissingAgents,afterMissingConfig);
  fs.writeFileSync(path.join(anti.args[1],'.agents','mcp_config.json'),'{}');
  assert.throws(() => prepareManualCoordination({...agent,runtimeType:'antigravity'},root,grant), /configuration has changed/);
  // Bounded generation cap prevents unbounded directory loops.
  const boundedProject = path.join(root, 'bounded-project');
  fs.mkdirSync(boundedProject);
  const firstBounded = prepareManualCoordination({...agent,cwd:boundedProject,runtimeType:'antigravity'},root,grant).args[1];
  const baseKeyDir = path.basename(firstBounded);
  const storageDir = path.dirname(firstBounded);
  for (let i = 0; i < 64; i++) {
    const dir = path.join(storageDir, i === 0 ? baseKeyDir : `${baseKeyDir}-${i}`);
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
    fs.rmSync(path.join(dir, '.agents', 'mcp_config.json'), { force: true });
  }
  assert.throws(() => prepareManualCoordination({...agent,cwd:boundedProject,runtimeType:'antigravity'},root,grant), /Could not allocate a clean Antigravity coordination directory/);
  console.log('Manual provider coordination config passed');
} finally { fs.rmSync(root,{recursive:true,force:true}); }

import fs from 'node:fs';
import path from 'node:path';
import type { ManualAgent } from './manual-conversations';

type Grant = {endpoint:string;script:string;token:string};

/** Provider config contains no credentials; bearer grants travel in the child environment. */
export function prepareManualCoordination(agent: ManualAgent, dataDir: string, grant: Grant, version?: string): {env:Record<string,string>;args:string[];cwd?:string} {
  const env: Record<string,string> = {
    ATRIS_CONTROL_PLANE_URL: grant.endpoint,
    ATRIS_CONTROL_PLANE_TOKEN: grant.token,
    ATRIS_MANUAL_COORDINATION: '1',
  };
  const server = {command:process.execPath,args:[grant.script]};
  if (!/^[a-zA-Z0-9-]+$/.test(agent.id)) throw new Error('Invalid agent identity.');
  let directory = fs.realpathSync.native(dataDir);
  for (const part of ['manual-sessions',agent.id,'workspace-coordination']) {
    directory = path.join(directory,part);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory,{mode:0o700});
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Coordination directory must be an ordinary directory.');
  }
  const write = (filename:string, contents:unknown) => {
    if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error('Coordination config cannot be a symbolic link.');
    fs.writeFileSync(filename,JSON.stringify(contents),{mode:0o600});
  };
  if (agent.runtimeType === 'claude_code') {
    const filename = path.join(directory,'claude-mcp.json');
    write(filename,{mcpServers:{atris_workspace:server}});
    return {env,args:['--mcp-config',filename]};
  }
  if (agent.runtimeType === 'opencode') {
    const major = Number(String(version || '').match(/(\d+)/)?.[1] || 1);
    env.ATRIS_MANUAL_OPENCODE_MCP = JSON.stringify({major,server:major >= 2 ? {type:'local',command:[server.command,...server.args],disabled:false,codemode:false} : {type:'local',command:[server.command,...server.args],enabled:true}});
    return {env,args:[]};
  }
  if (agent.runtimeType === 'antigravity') {
    const agents = path.join(directory,'.agents');
    if (!fs.existsSync(agents)) fs.mkdirSync(agents,{mode:0o700});
    const stat = fs.lstatSync(agents);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Coordination config directory must be an ordinary directory.');
    write(path.join(agents,'mcp_config.json'),{mcpServers:{atris_workspace:server}});
    // The actual CLI working directory remains the project. Antigravity loads
    // the additional workspace's MCP config without changing the project root.
    return {env,args:['--add-dir',directory]};
  }
  throw new Error('This provider does not support manual coordination.');
}

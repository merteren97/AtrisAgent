import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ManualAgent } from './manual-conversations';

type Grant = {endpoint:string;script:string;token:string};

function ordinaryDirectory(parent: string, part: string) {
  const directory = path.join(parent, part);
  try { fs.mkdirSync(directory, {mode:0o700}); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Coordination directory must be an ordinary directory.');
  return directory;
}

/** Provider config contains no credentials; bearer grants travel in the child environment. */
export function prepareManualCoordination(agent: ManualAgent, dataDir: string, grant: Grant, version?: string): {env:Record<string,string>;args:string[];cwd?:string} {
  const env: Record<string,string> = {
    ATRIS_CONTROL_PLANE_URL: grant.endpoint,
    ATRIS_CONTROL_PLANE_TOKEN: grant.token,
    ATRIS_MANUAL_COORDINATION: '1',
  };
  const server = {command:process.execPath,args:[grant.script]};
  if (!/^[a-zA-Z0-9-]+$/.test(agent.id)) throw new Error('Invalid agent identity.');
  const root = fs.realpathSync.native(dataDir);
  if (agent.runtimeType === 'antigravity') {
    // Keep the extra workspace stable across launches/tabs of the same execution
    // folder. Its contents are only the MCP launcher; grants still rotate in env.
    const cwd = fs.realpathSync.native(agent.cwd);
    const content = JSON.stringify({mcpServers:{atris_workspace:server}});
    const key = createHash('sha256').update(JSON.stringify([cwd,content])).digest('hex');
    const storage = ordinaryDirectory(root, 'manual-antigravity-coordination');
    const configDir = path.join(storage, key);
    if (!fs.existsSync(configDir)) {
      const temporary = fs.mkdtempSync(path.join(storage, '.creating-'));
      try {
        const config = ordinaryDirectory(temporary, '.agents');
        fs.writeFileSync(path.join(config, 'mcp_config.json'), content, {mode:0o600,flag:'wx'});
        try { fs.renameSync(temporary, configDir); }
        catch (error) { if (!fs.existsSync(configDir)) throw error; }
      } finally { fs.rmSync(temporary, {recursive:true,force:true}); }
    }
    const agents = path.join(configDir, '.agents');
    const filename = path.join(agents, 'mcp_config.json');
    if (![configDir, agents].every(dir => fs.lstatSync(dir).isDirectory() && fs.realpathSync.native(dir) === dir)) {
      throw new Error('The Antigravity coordination directory has changed.');
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let matches: boolean;
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(filename, { bigint: true });
      const expected = Buffer.from(content);
      const bytes = Buffer.alloc(expected.length + 1);
      matches = stat.isFile() && named.isFile() && stat.ino === named.ino && stat.dev === named.dev && stat.size === BigInt(expected.length)
        && fs.readSync(fd, bytes) === expected.length && bytes.subarray(0, expected.length).equals(expected);
    } finally { fs.closeSync(fd); }
    if (!matches
      || fs.readdirSync(configDir).some(entry => entry !== '.agents') || fs.readdirSync(agents).some(entry => entry !== 'mcp_config.json')) {
      throw new Error('The Antigravity coordination configuration has changed.');
    }
    return {env,args:['--add-dir',configDir]};
  }
  let directory = root;
  for (const part of ['manual-sessions',agent.id,'workspace-coordination']) {
    directory = path.join(directory,part);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory,{mode:0o700});
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Coordination directory must be an ordinary directory.');
  }
  if (agent.runtimeType === 'claude_code') {
    const configDir = fs.mkdtempSync(path.join(directory,'claude-'));
    const filename = path.join(configDir,'claude-mcp.json');
    fs.writeFileSync(filename,JSON.stringify({mcpServers:{atris_workspace:server}}),{mode:0o600,flag:'wx'});
    return {env,args:['--mcp-config',filename]};
  }
  if (agent.runtimeType === 'opencode') {
    const major = Number(String(version || '').match(/(\d+)/)?.[1] || 1);
    env.ATRIS_MANUAL_OPENCODE_MCP = JSON.stringify({major,server:major >= 2 ? {type:'local',command:[server.command,...server.args],disabled:false,codemode:false} : {type:'local',command:[server.command,...server.args],enabled:true}});
    return {env,args:[]};
  }
  throw new Error('This provider does not support manual coordination.');
}

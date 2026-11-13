import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Application } from 'express';
import { findExecutable, runCommand } from '@atris-agent-code/runtime-host';
import { verifyEditorServer } from './editor-mcp-connections';
import { verifyPlaywrightPackage } from './integration-connections';

type SetupId = 'github' | 'playwright' | 'unity-mcp' | 'unity-cli' | 'blender' | 'godot';
const IDS: SetupId[] = ['github','playwright','unity-mcp','unity-cli','blender','godot'];
const PACKAGES = {playwright:'@playwright/mcp@0.0.85',godot:'@coding-solo/godot-mcp@0.1.1'} as const;

export function discoverUnityEditors(platform = process.platform, env = process.env, home = os.homedir()): string[] {
  const roots = platform === 'win32' ? [path.join(env.ProgramFiles || 'C:\\Program Files','Unity','Hub','Editor')] : platform === 'darwin' ? ['/Applications/Unity/Hub/Editor'] : [path.join(home,'Unity','Hub','Editor')];
  const candidates:string[] = [];
  for (const root of roots) {
    try {
      const versions = fs.readdirSync(root,{withFileTypes:true}).filter(item => item.isDirectory()).map(item => item.name).sort((a,b) => b.localeCompare(a,undefined,{numeric:true}));
      for (const version of versions.slice(0,100)) {
        const executable = platform === 'win32' ? path.join(root,version,'Editor','Unity.exe') : platform === 'darwin' ? path.join(root,version,'Unity.app','Contents','MacOS','Unity') : path.join(root,version,'Editor','Unity');
        try { if (fs.statSync(executable).isFile()) candidates.push(fs.realpathSync(executable)); } catch { /* Ignore incomplete installations. */ }
      }
    } catch { /* Unity Hub is not installed in this location. */ }
  }
  return candidates;
}

/** Do not let the upstream installer replace an existing, potentially customized add-on. */
export function hasExistingBlenderAddon(platform = process.platform, env = process.env, home = os.homedir()): boolean {
  const base = platform === 'win32' ? (env.APPDATA ? path.join(env.APPDATA,'Blender Foundation','Blender') : undefined) : platform === 'darwin' ? path.join(home,'Library','Application Support','Blender') : path.join(home,'.config','blender');
  const directories = [env.BLENDER_USER_ADDONS,env.BLENDERMCP_ADDONS_DIR].filter((value):value is string => Boolean(value));
  try {
    for (const item of (base ? fs.readdirSync(base,{withFileTypes:true}) : []).filter(item => item.isDirectory() && /^\d+\.\d+/.test(item.name)).slice(0,100)) {
      directories.push(path.join(base!,item.name,'scripts','addons'),path.join(base!,item.name,'extensions','user_default'));
    }
  } catch { /* No Blender user configuration yet. */ }
  for (const directory of directories) {
    try {
      for (const item of fs.readdirSync(directory,{withFileTypes:true}).slice(0,500)) {
        const file = item.isFile() && item.name.endsWith('.py') ? path.join(directory,item.name) : item.isDirectory() ? path.join(directory,item.name,'__init__.py') : '';
        if (!file) continue;
        try {
          const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
          if (/["']name["']\s*:\s*["'](?:MCP for Blender|Blender MCP)["']/.test(fs.readFileSync(file,'utf8').slice(0,64 * 1024))) return true;
        } catch { /* Ignore unreadable unrelated add-ons. */ }
      }
    } catch { /* This version has no add-on directory. */ }
  }
  return false;
}

async function locate(name:'gh'|'uvx'|'npm'):Promise<string | undefined> {
  const found = await findExecutable(name);
  if (found) return found;
  const candidates = name === 'uvx' ? [path.join(os.homedir(),'.local','bin',process.platform === 'win32' ? 'uvx.exe' : 'uvx')] : name === 'gh' && process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files','GitHub CLI','gh.exe')] : [];
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
}

async function ensureTool(name:'gh'|'uvx'|'npm'):Promise<string> {
  let executable = await locate(name);
  if (executable) return executable;
  if (name !== 'npm' && process.platform === 'win32') {
    const winget = await findExecutable('winget');
    if (winget) {
      try {
        await runCommand(winget,['install','--id',name === 'gh' ? 'GitHub.cli' : 'astral-sh.uv','--exact','--silent','--accept-package-agreements','--accept-source-agreements'],{timeoutMs:180_000,maxOutputBytes:256 * 1024});
      } catch { /* Re-probe: another installer may have completed concurrently. */ }
      executable = await locate(name);
    }
  }
  if (!executable) throw new Error(name === 'npm' ? 'Node.js and npm are required. Install Node.js 22 and retry.' : name === 'uvx' ? 'The uv package manager could not be found. Install uv and retry.' : 'GitHub CLI could not be found. Install it and retry.');
  return executable;
}

function managedDirectory(dataDir:string):string {
  const parent = fs.realpathSync(dataDir);
  const root = path.join(parent,'integration-packages');
  if (!fs.existsSync(root)) fs.mkdirSync(root,{mode:0o700});
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The integration package directory is unavailable.');
  return fs.mkdtempSync(path.join(root,'install-'));
}

export function reusableNodeInstallation(dataDir:string, id:'playwright'|'godot', previous:unknown):string | undefined {
  if (!previous || typeof previous !== 'object') return undefined;
  const config = previous as {packagePath?:unknown;args?:unknown};
  const candidate = id === 'playwright' ? config.packagePath : Array.isArray(config.args) && typeof config.args[0] === 'string' ? path.resolve(config.args[0],'../..') : undefined;
  if (typeof candidate !== 'string') return undefined;
  try {
    const packagePath = fs.realpathSync(candidate);
    const managedRoot = fs.realpathSync(path.join(dataDir,'integration-packages'));
    const relative = path.relative(managedRoot,packagePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    const manifest = JSON.parse(fs.readFileSync(path.join(packagePath,'package.json'),'utf8')) as {name:string;version:string};
    if (`${manifest.name}@${manifest.version}` !== PACKAGES[id]) return undefined;
    const entry = path.join(packagePath,id === 'playwright' ? 'cli.js' : 'build/index.js');
    if (!fs.statSync(entry).isFile()) return undefined;
    return path.resolve(packagePath,'../../..');
  } catch { return undefined; }
}

async function installNodePackage(dataDir:string, id:'playwright'|'godot', previous?:unknown):Promise<{directory:string;owned:boolean}> {
  const existing = reusableNodeInstallation(dataDir,id,previous);
  if (existing) return {directory:existing,owned:false};
  const npm = await ensureTool('npm');
  const directory = managedDirectory(dataDir);
  try {
    const result = await runCommand(npm,['install','--prefix',directory,'--no-save','--no-package-lock','--ignore-scripts','--no-audit','--no-fund',PACKAGES[id]],{timeoutMs:180_000,maxOutputBytes:512 * 1024});
    if (result.exitCode !== 0) throw new Error('Package installation failed.');
    return {directory,owned:true};
  } catch { fs.rmSync(directory,{recursive:true,force:true}); throw new Error('Could not install the integration package. Check your network and retry.'); }
}

export async function setupIntegration(id:SetupId, dataDir:string, previous?:unknown):Promise<{config?:unknown; guidance:string}> {
  if (id === 'github') { await ensureTool('gh'); return {guidance:'GitHub CLI is ready. Continue with GitHub sign-in.'}; }
  if (id === 'unity-cli') {
    for (const executable of discoverUnityEditors().slice(0,8)) {
      try {
        const result = await runCommand(executable,['-version'],{timeoutMs:15_000,maxOutputBytes:64 * 1024});
        const version = result.stdout.trim();
        if (result.exitCode === 0 && /^\d{4}\.\d+\.\d+[a-z]\d+(?:\S*)?$/i.test(version)) return {config:{executable,version,verifiedAt:new Date().toISOString()},guidance:'Unity Editor was detected.'};
      } catch { /* Check the next installed version. */ }
    }
    throw new Error('Unity Editor was not found. Install it with Unity Hub and retry.');
  }
  if (id === 'playwright') {
    const {directory,owned} = await installNodePackage(dataDir,id,previous);
    try {
      const config = await verifyPlaywrightPackage(path.join(directory,'node_modules','@playwright','mcp'));
      return {config,guidance:'Playwright MCP is installed and verified.'};
    } catch (error) { if (owned) fs.rmSync(directory,{recursive:true,force:true}); throw error; }
  }
  let command:string; let args:string[]; let guidance:string; let ownedDirectory:string | undefined;
  if (id === 'godot') {
    const {directory,owned} = await installNodePackage(dataDir,id,previous);
    if (owned) ownedDirectory = directory;
    command = process.execPath; args = [path.join(directory,'node_modules','@coding-solo','godot-mcp','build','index.js')];
    guidance = 'Install Godot if needed, then open your project in Godot.';
  } else {
    command = await ensureTool('uvx');
    args = id === 'unity-mcp' ? ['--from','mcpforunityserver==10.3.0','mcp-for-unity','--transport','stdio'] : ['mcp-for-blender@2.1.7'];
    guidance = id === 'unity-mcp' ? 'In Unity, open Package Manager → Add package from git URL, then add https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.3.0.' : 'Open Blender → Preferences → Add-ons and enable MCP for Blender; then start its server from the 3D View sidebar.';
  }
  let config:Awaited<ReturnType<typeof verifyEditorServer>>;
  try { config = await verifyEditorServer({command,args},{startupTimeoutMs:120_000}); }
  catch (error) { if (ownedDirectory) fs.rmSync(ownedDirectory,{recursive:true,force:true}); throw error; }
  if (id === 'blender') {
    if (hasExistingBlenderAddon()) guidance = 'An existing Blender MCP add-on was found. Enable it in Blender Preferences → Add-ons, then start its server from the 3D View sidebar.';
    else try {
      const addon = await runCommand(command,['mcp-for-blender@2.1.7','install-addon'],{timeoutMs:60_000,maxOutputBytes:256 * 1024,env:{PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
      if (addon.exitCode !== 0) guidance = 'Server ready. Install the MCP for Blender add-on in Blender, then enable and start it.';
    } catch { guidance = 'Server ready. Install the MCP for Blender add-on in Blender, then enable and start it.'; }
  }
  return {config,guidance};
}

export function installAutoSetupRoutes(app:Application, sqlite:Database.Database, dataDir:string, setup = setupIntegration):void {
  const active = new Set<string>();
  app.post('/api/integrations/:id/auto-setup',async (req,res) => {
    const id = String(req.params.id) as SetupId;
    if (!IDS.includes(id)) return res.status(404).json({error:'Unknown integration.'});
    if (active.has(id)) return res.status(409).json({error:'Setup is already running.'});
    active.add(id);
    try {
      const row = sqlite.prepare('SELECT config FROM integration_connections WHERE id = ?').get(id) as {config:string} | undefined;
      let previous:unknown; try { previous = row ? JSON.parse(row.config) : undefined; } catch { /* Repair an invalid saved configuration with setup. */ }
      const result = await setup(id,dataDir,previous);
      if (result.config && typeof result.config === 'object' && !Array.isArray(result.config)) {
        result.config = {...result.config,setupGuidance:result.guidance};
        sqlite.prepare('INSERT INTO integration_connections (id, config) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config').run(id,JSON.stringify(result.config));
      }
      return res.json(result);
    } catch (error) { return res.status(400).json({error:error instanceof Error ? error.message : 'Integration setup failed.'}); }
    finally { active.delete(id); }
  });
}

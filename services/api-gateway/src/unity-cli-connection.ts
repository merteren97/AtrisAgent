import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Application } from 'express';
import { runCommand } from '@atris-agent-code/runtime-host';

type VersionProbe = (executable: string) => Promise<string>;
const probe: VersionProbe = async executable => {
  const result = await runCommand(executable, ['-version'], {timeoutMs:15_000,maxOutputBytes:64 * 1024});
  if (result.exitCode !== 0) throw new Error('Unity version check failed.');
  return result.stdout.trim();
};

export function installUnityCliRoutes(app: Application, sqlite: Database.Database, versionProbe: VersionProbe = probe): void {
  app.get('/api/integrations/unity-cli', (_req, res) => {
    const row = sqlite.prepare('SELECT config FROM integration_connections WHERE id = ?').get('unity-cli') as {config:string} | undefined;
    res.json({connection:row ? JSON.parse(row.config) : null});
  });
  app.post('/api/integrations/unity-cli/verify', async (req, res) => {
    const input = req.body?.executable;
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.length > 4096 || !/^unity(?:\.exe)?$/i.test(path.basename(input))) return res.status(400).json({error:'Select the absolute path to the Unity Editor executable.'});
    try {
      const executable = fs.realpathSync(input);
      if (!fs.statSync(executable).isFile()) throw new Error();
      const version = await versionProbe(executable);
      if (!/^\d{4}\.\d+\.\d+[a-z]\d+(?:\S*)?$/i.test(version)) throw new Error();
      const connection = {executable,version,verifiedAt:new Date().toISOString()};
      sqlite.prepare('INSERT INTO integration_connections (id, config) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config').run('unity-cli',JSON.stringify(connection));
      return res.json({connection});
    } catch { return res.status(400).json({error:'Could not verify the selected Unity Editor executable.'}); }
  });
  app.delete('/api/integrations/unity-cli', (_req, res) => { sqlite.prepare('DELETE FROM integration_connections WHERE id = ?').run('unity-cli'); res.json({ok:true}); });
}

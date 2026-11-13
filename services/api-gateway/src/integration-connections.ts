import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Application } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface PlaywrightConnection {
  packagePath: string;
  version: string;
  verifiedAt: string;
  toolCount: number;
}

/** Validate a user-selected local package. No package is installed or downloaded here. */
export function resolvePlaywrightPackage(input: unknown): { directory: string; entry: string; version: string } {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.length > 4096) throw new Error('Select an absolute path to the installed @playwright/mcp package directory.');
  let directory: string;
  let manifest: { name?: unknown; version?: unknown };
  try {
    directory = fs.realpathSync(input);
    if (!fs.statSync(directory).isDirectory()) throw new Error();
    manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    throw new Error('The selected directory could not be read as an installed package.');
  }
  if (manifest.name !== '@playwright/mcp' || typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('The selected directory is not an installed @playwright/mcp package.');
  const entry = path.join(directory, 'cli.js');
  if (!fs.existsSync(entry) || !fs.statSync(entry).isFile() || fs.realpathSync(entry) !== entry) throw new Error('The Playwright MCP package is missing its local cli.js entry.');
  return { directory, entry, version: manifest.version };
}

export async function verifyPlaywrightPackage(input: unknown): Promise<PlaywrightConnection> {
  const pkg = resolvePlaywrightPackage(input);
  const client = new Client({ name: 'atris-agent-integration-check', version: '0.2.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [pkg.entry, '--isolated'], cwd: pkg.directory, stderr: 'ignore', maxBufferSize: 2 * 1024 * 1024 });
  try {
    await client.connect(transport, { timeout: 15_000 });
    const result = await client.listTools(undefined, { timeout: 10_000 });
    if (!result.tools.some(tool => tool.name === 'browser_navigate')) throw new Error('The server did not expose the expected Playwright browser tools.');
    return { packagePath: pkg.directory, version: pkg.version, verifiedAt: new Date().toISOString(), toolCount: result.tools.length };
  } finally {
    await transport.close();
  }
}

/** Resolve at launch time so removed or replaced installations do not become stale CLI config. */
export function configuredPlaywrightCommand(sqlite: Database.Database): { command:string; args:string[] } | undefined {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integration_connections'").get()) return undefined;
  const row = sqlite.prepare('SELECT config FROM integration_connections WHERE id = ?').get('playwright') as {config:string} | undefined;
  if (!row) return undefined;
  let config: PlaywrightConnection;
  try { config = JSON.parse(row.config); } catch { throw new Error('Saved Playwright MCP configuration is invalid. Verify it again in Integrations.'); }
  const pkg = resolvePlaywrightPackage(config.packagePath);
  if (pkg.version !== config.version) throw new Error('Playwright MCP changed since verification. Verify it again in Integrations.');
  return { command: process.execPath, args: [pkg.entry, '--isolated'] };
}

export function installIntegrationConnectionRoutes(app: Application, sqlite: Database.Database): void {
  sqlite.exec('CREATE TABLE IF NOT EXISTS integration_connections (id TEXT PRIMARY KEY, config TEXT NOT NULL)');
  app.get('/api/integrations/playwright', (_req, res) => {
    const row = sqlite.prepare('SELECT config FROM integration_connections WHERE id = ?').get('playwright') as { config: string } | undefined;
    res.json({ connection: row ? JSON.parse(row.config) : null });
  });
  app.post('/api/integrations/playwright/verify', async (req, res) => {
    try {
      const connection = await verifyPlaywrightPackage(req.body?.packagePath);
      sqlite.prepare('INSERT INTO integration_connections (id, config) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config').run('playwright', JSON.stringify(connection));
      res.json({ connection });
    } catch (error) {
      const message = error instanceof Error && (error.message.startsWith('Select ') || error.message.startsWith('The selected ') || error.message.startsWith('The Playwright ') || error.message.startsWith('The server ')) ? error.message : 'Could not connect to the selected Playwright MCP server. Check the installation and try again.';
      res.status(400).json({ error: message });
    }
  });
  app.delete('/api/integrations/playwright', (_req, res) => {
    sqlite.prepare('DELETE FROM integration_connections WHERE id = ?').run('playwright');
    res.json({ ok: true });
  });
}

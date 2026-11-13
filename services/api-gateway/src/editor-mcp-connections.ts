import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Application } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const IDS = ['unity-mcp', 'blender', 'godot'] as const;
type EditorId = typeof IDS[number];
type EditorConnection = { command: string; args: string[]; verifiedAt: string; toolCount: number; serverName: string; serverVersion: string };

export function parseEditorCommand(body: unknown): { command: string; args: string[] } {
  if (!body || typeof body !== 'object') throw new Error('Provide an executable and its arguments.');
  const { command, args } = body as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || !path.isAbsolute(command) || command.length > 4096) throw new Error('Enter an absolute path to the MCP server executable.');
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new Error('Arguments must be a list of at most 32 strings.');
  // Command arguments are persisted. Credentials must use a future secure credential flow.
  if (args.some(arg => /(?:token|password|secret|api[-_]?key|authorization)/i.test(arg) || /(?:ghp_|github_pat_|sk-)[a-z0-9_\-]{12,}/i.test(arg))) throw new Error('Credentials cannot be stored in command arguments.');
  let executable: string;
  try { executable = fs.realpathSync(command); if (!fs.statSync(executable).isFile()) throw new Error(); }
  catch { throw new Error('The selected MCP server executable was not found.'); }
  if (process.platform === 'win32' && !/\.exe$/i.test(executable)) throw new Error('On Windows select an executable (.exe), not a shell script.');
  return { command: executable, args: [...args] as string[] };
}

export async function verifyEditorServer(body: unknown): Promise<EditorConnection> {
  const config = parseEditorCommand(body);
  const client = new Client({ name: 'atris-agent-integration-check', version: '0.2.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: config.command, args: config.args, stderr: 'ignore', maxBufferSize: 2 * 1024 * 1024 });
  try {
    await client.connect(transport, { timeout: 15_000 });
    const result = await client.listTools(undefined, { timeout: 10_000 });
    if (!result.tools.length) throw new Error('The MCP server did not expose any tools.');
    const info = client.getServerVersion();
    return { ...config, verifiedAt: new Date().toISOString(), toolCount: result.tools.length, serverName: String(info?.name || 'MCP server').slice(0, 120), serverVersion: String(info?.version || '').slice(0, 120) };
  } finally { await transport.close(); }
}

export function installEditorMcpRoutes(app: Application, sqlite: Database.Database): void {
  app.get('/api/integrations/editors', (_req, res) => {
    const rows = sqlite.prepare('SELECT id, config FROM integration_connections WHERE id IN (?, ?, ?)').all(...IDS) as Array<{ id: EditorId; config: string }>;
    res.json({ connections: Object.fromEntries(rows.map(row => [row.id, JSON.parse(row.config)])) });
  });
  app.post('/api/integrations/editors/:id/verify', async (req, res) => {
    const id = String(req.params.id);
    if (!IDS.includes(id as EditorId)) return res.status(404).json({ error: 'Unknown editor integration.' });
    try {
      const connection = await verifyEditorServer(req.body);
      sqlite.prepare('INSERT INTO integration_connections (id, config) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config').run(id, JSON.stringify(connection));
      return res.json({ connection });
    } catch (error) {
      const message = error instanceof Error && /^(Provide |Enter |Arguments |Credentials |The selected |On Windows |The MCP server )/.test(error.message) ? error.message : 'Could not connect to the MCP server. Check its installation and try again.';
      return res.status(400).json({ error: message });
    }
  });
  app.delete('/api/integrations/editors/:id', (req, res) => {
    const id = String(req.params.id);
    if (!IDS.includes(id as EditorId)) return res.status(404).json({ error: 'Unknown editor integration.' });
    sqlite.prepare('DELETE FROM integration_connections WHERE id = ?').run(id);
    return res.json({ ok: true });
  });
}

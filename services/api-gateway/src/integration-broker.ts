import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport, FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { resolvePlaywrightPackage } from './integration-connections';
import { parseEditorCommand } from './editor-mcp-connections';
import fs from 'node:fs';

type Scope = { workspaceId: string; sessionId: string; agentId: string };
type Tool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
type IntegrationId = 'playwright' | 'unity' | 'blender' | 'godot' | 'github';
type Call = { scope: Scope; integrationId: IntegrationId; workspacePath?: string; tool: string; arguments: Record<string, unknown> };

interface Entry {
  scope: Scope;
  integrationId: IntegrationId;
  workspacePath?: string;
  expiresAt: number;
  client: Client;
  transport: Transport;
  tools: Map<string, Tool>;
  closed: boolean;
  pending: Promise<unknown>;
  expiry: ReturnType<typeof setTimeout>;
}

/**
 * Private building block for session-bound integrations. It is intentionally not
 * exposed through HTTP until callers provide trusted session identity and policy.
 */
export class IntegrationBroker {
  private sessions = new Map<string, Entry>();
  constructor(private readonly authorize: (call: Call) => Promise<boolean>) {}

  async openPlaywright(scope: Scope, packagePath: string, options: { ttlMs?: number } = {}): Promise<string> {
    const pkg = resolvePlaywrightPackage(packagePath);
    const transport = new StdioClientTransport({ command: process.execPath, args: [pkg.entry, '--isolated'], cwd: pkg.directory, stderr: 'ignore', maxBufferSize: 2 * 1024 * 1024 });
    return this.open(scope, 'playwright', transport, options.ttlMs, undefined, 'browser_navigate');
  }

  /** Credentials are obtained by the gateway and never passed to the AI runtime. */
  async openGithub(scope: Scope, readToken: () => Promise<string>, options: { ttlMs?: number; fetch?: FetchLike } = {}): Promise<string> {
    if (!scope.workspaceId || !scope.sessionId || !scope.agentId) throw new Error('Integration session requires workspace, session and agent identity.');
    const token = await readToken();
    if (!token || token.length > 4096 || /\s/.test(token)) throw new Error('GitHub authentication is unavailable.');
    const transport = new StreamableHTTPClientTransport(new URL('https://api.githubcopilot.com/mcp/'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    try { return await this.open(scope, 'github', transport, options.ttlMs); }
    catch { throw new Error('Could not connect to GitHub MCP. Check the GitHub account and try again.'); }
  }

  /** The caller must verify that the editor's active project matches workspacePath. */
  async openEditor(scope: Scope, integrationId: 'unity' | 'blender' | 'godot', config: {command:string;args:string[]}, workspacePath: string, options: { ttlMs?: number } = {}): Promise<string> {
    if (!['unity', 'blender', 'godot'].includes(integrationId)) throw new Error('Unknown editor integration.');
    const command = parseEditorCommand(config);
    const cwd = fs.realpathSync(workspacePath);
    if (!fs.statSync(cwd).isDirectory()) throw new Error('Integration workspace is unavailable.');
    const transport = new StdioClientTransport({ ...command, cwd, stderr: 'ignore', maxBufferSize: 2 * 1024 * 1024 });
    return this.open(scope, integrationId, transport, options.ttlMs, cwd);
  }

  private async open(scope: Scope, integrationId: IntegrationId, transport: Transport, requestedTtl?: number, workspacePath?: string, expectedTool?: string): Promise<string> {
    if (!scope.workspaceId || !scope.sessionId || !scope.agentId) throw new Error('Integration session requires workspace, session and agent identity.');
    const ttlMs = requestedTtl ?? 30 * 60_000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60_000) throw new Error('Invalid integration session lifetime.');
    const client = new Client({ name: 'atris-agent-integration-broker', version: '0.2.0' }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: 15_000 });
      const result = await client.listTools(undefined, { timeout: 10_000 });
      if (!result.tools.length || (expectedTool && !result.tools.some(tool => tool.name === expectedTool))) throw new Error('The server did not expose the expected integration tools.');
      const token = randomBytes(32).toString('hex');
      const expiry = setTimeout(() => { void this.close(token); }, ttlMs);
      expiry.unref();
      this.sessions.set(token, { scope: { ...scope }, integrationId, workspacePath, expiresAt: Date.now() + ttlMs, client, transport, tools: new Map(result.tools.map(tool => [tool.name, tool])), closed: false, pending: Promise.resolve(), expiry });
      return token;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  private requireSession(token: string, scope: Scope): Entry {
    const entry = this.sessions.get(token);
    if (!entry || entry.closed || entry.expiresAt <= Date.now() || entry.scope.workspaceId !== scope.workspaceId || entry.scope.sessionId !== scope.sessionId || entry.scope.agentId !== scope.agentId) {
      if (entry && entry.expiresAt <= Date.now()) void this.close(token);
      throw new Error('Integration session is unavailable or expired.');
    }
    return entry;
  }

  listTools(token: string, scope: Scope): Tool[] {
    const entry = this.requireSession(token, scope);
    return [...entry.tools.values()].map(tool => ({ ...tool, name: `${entry.integrationId}__${tool.name}` }));
  }

  async callTool(token: string, scope: Scope, name: string, args: Record<string, unknown>) {
    const entry = this.requireSession(token, scope);
    const prefix = `${entry.integrationId}__`;
    if (!name.startsWith(prefix)) throw new Error('Unknown integration tool.');
    const tool = name.slice(prefix.length);
    if (!entry.tools.has(tool) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown integration tool or invalid arguments.');
    const operation = entry.pending.catch(() => undefined).then(async () => {
      this.requireSession(token, scope);
      if (!await this.authorize({ scope: { ...entry.scope }, integrationId: entry.integrationId, workspacePath: entry.workspacePath, tool, arguments: args })) throw new Error('Integration tool call was not authorized.');
      this.requireSession(token, scope);
      return entry.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60_000 });
    });
    entry.pending = operation;
    return operation;
  }

  async close(token: string): Promise<void> {
    const entry = this.sessions.get(token);
    if (!entry) return;
    entry.closed = true;
    this.sessions.delete(token);
    clearTimeout(entry.expiry);
    await entry.transport.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(token => this.close(token)));
  }
}

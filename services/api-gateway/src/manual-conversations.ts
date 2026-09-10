import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Application, Request, Response } from 'express';
import type { RuntimeHost } from '@atris-agent-code/runtime-host';
import { runCommand } from '@atris-agent-code/runtime-host';
import { ManualProviderBridge, readTail } from './manual-provider-bridge';
import { ManualAntigravityBridge } from './manual-antigravity-bridge';
import { manualContentTitle, manualProviderName } from './manual-titles';

export interface ManualAgent {
  id: string; conversationId: string; name: string; catalogId: string;
  runtimeType: string; model: string; accountProfileId: string; providerSessionId: string;
  cwd: string; configDir: string; sharedProfile: boolean; createdAt: string;
  reasoning?: string;
  autoName?: boolean;
  nameSourceId?: string;
}
export interface ManualConversation { id: string; workspaceId: string; title: string; createdAt: string; agents: ManualAgent[] }
export interface ManualMessage { id: string; role: 'user' | 'assistant' | 'tool'; text: string; toolName?: string; failed?: boolean }
export interface ManualNamingUpdate { conversationId: string; agentId: string; agentName?: string; conversationTitle?: string }

const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
function required(value: unknown, label: string, limit = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) return fail(`Invalid ${label}.`);
  return value.trim();
}

function resolveReasoning(value: unknown, descriptor: { supportedReasoning?: readonly string[]; defaultReasoning?: string }): string | undefined {
  if (value === undefined) return descriptor.defaultReasoning || descriptor.supportedReasoning?.[0];
  if (typeof value !== 'string' || !descriptor.supportedReasoning?.includes(value)) return fail('This model does not support the selected reasoning level.');
  return value;
}

/** Only the exact provider session may contribute messages. Never infer identity from cwd/latest file. */
export function parseManualTranscript(source: string, sessionId: string): ManualMessage[] {
  const messages = new Map<string, ManualMessage>();
  for (const line of source.split('\n')) {
    let item: any;
    try { item = JSON.parse(line); } catch { continue; } // Last line can still be in flight.
    if (item.sessionId !== sessionId || item.isSidechain || !['user', 'assistant'].includes(item.type)) continue;
    const content = item.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    blocks.forEach((block: any, index: number) => {
      const id = `${item.uuid || item.message?.id || ''}:${index}`;
      if (id === `:${index}`) return;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        messages.set(id, { id, role: item.type, text: block.text });
      } else if (block.type === 'tool_use') {
        // Arguments can contain credentials. Keep this collapsed summary free of raw payloads.
        messages.set(id, { id, role: 'tool', text: 'Tool requested. Open Code for live output and any required approval.', toolName: String(block.name || 'Tool') });
      } else if (block.type === 'tool_result') {
        messages.set(id, { id, role: 'tool', text: block.is_error ? 'Tool failed. Inspect Code for details.' : 'Tool completed.', failed: Boolean(block.is_error) });
      }
    });
  }
  return [...messages.values()];
}

export class ManualConversationStore {
  constructor(private sqlite: Database.Database, private dataDir = path.dirname(sqlite.name)) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS manual_conversations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manual_agent_sessions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES manual_conversations(id) ON DELETE CASCADE,
      record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS manual_agents_conversation ON manual_agent_sessions(conversation_id);
      CREATE TABLE IF NOT EXISTS manual_memory_receipts (
        agent_id TEXT NOT NULL REFERENCES manual_agent_sessions(id) ON DELETE CASCADE,
         source_id TEXT NOT NULL, PRIMARY KEY(agent_id, source_id));
       CREATE TABLE IF NOT EXISTS manual_automatic_titles (
         conversation_id TEXT PRIMARY KEY REFERENCES manual_conversations(id) ON DELETE CASCADE,
         source_id TEXT);`);
  }
  list(workspaceId: string): ManualConversation[] {
    const rows = this.sqlite.prepare('SELECT id, workspace_id AS workspaceId, title, created_at AS createdAt FROM manual_conversations WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId) as Omit<ManualConversation, 'agents'>[];
    return rows.map(row => ({ ...row, agents: (this.sqlite.prepare('SELECT record FROM manual_agent_sessions WHERE conversation_id = ? ORDER BY rowid').all(row.id) as {record: string}[]).map(a => JSON.parse(a.record)) }));
  }
  workspace(id: string): { id: string; path: string } {
    return this.sqlite.prepare('SELECT id, path FROM workspaces WHERE id = ?').get(id) as {id: string; path: string} || fail('Project not found.', 404);
  }
  conversation(id: string): { id: string; workspaceId: string } {
    return this.sqlite.prepare('SELECT id, workspace_id AS workspaceId FROM manual_conversations WHERE id = ?').get(id) as {id: string; workspaceId: string} || fail('Conversation not found.', 404);
  }
  create(workspaceId: string, title: string | undefined, id: string = randomUUID()): ManualConversation {
    this.workspace(workspaceId);
    const existing = this.sqlite.prepare('SELECT workspace_id FROM manual_conversations WHERE id = ?').get(id) as {workspace_id: string} | undefined;
    if (existing && existing.workspace_id !== workspaceId) return fail('Conversation identity conflict.', 409);
    if (!existing) this.sqlite.transaction(() => {
      this.sqlite.prepare('INSERT INTO manual_conversations VALUES (?, ?, ?, ?)').run(id, workspaceId, title ?? 'New conversation', new Date().toISOString());
      if (title === undefined) this.sqlite.prepare('INSERT INTO manual_automatic_titles (conversation_id) VALUES (?)').run(id);
    })();
    return this.list(workspaceId).find(c => c.id === id)!;
  }
  agent(id: string): ManualAgent {
    const row = this.sqlite.prepare('SELECT record FROM manual_agent_sessions WHERE id = ?').get(id) as {record: string} | undefined;
    return row ? JSON.parse(row.record) : fail('Agent not found.', 404);
  }
  save(agent: ManualAgent): void {
    this.saveBatch([agent]);
  }
  remove(id: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM manual_automatic_titles WHERE conversation_id = ?').run(id);
      this.sqlite.prepare('DELETE FROM manual_memory_receipts WHERE agent_id IN (SELECT id FROM manual_agent_sessions WHERE conversation_id = ?)').run(id);
      this.sqlite.prepare('DELETE FROM manual_agent_sessions WHERE conversation_id = ?').run(id);
      this.sqlite.prepare('DELETE FROM manual_conversations WHERE id = ?').run(id);
    })();
  }
  removeAgent(id: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM manual_memory_receipts WHERE agent_id = ?').run(id);
      this.sqlite.prepare('DELETE FROM manual_agent_sessions WHERE id = ?').run(id);
    })();
  }
  memoryProcessed(agentId: string, sourceId: string): boolean {
    return Boolean(this.sqlite.prepare('SELECT 1 FROM manual_memory_receipts WHERE agent_id = ? AND source_id = ?').get(agentId, sourceId));
  }
  markMemoryProcessed(agentId: string, sourceId: string): void {
    this.sqlite.prepare('INSERT OR IGNORE INTO manual_memory_receipts VALUES (?, ?)').run(agentId, sourceId);
  }
  readMessages(id: string): { supported: boolean; messages: ManualMessage[]; truncated: boolean; bound: boolean; naming?: ManualNamingUpdate } {
    const agent = this.agent(id);
    const result = agent.runtimeType === 'antigravity'
      ? {supported:true,...new ManualAntigravityBridge(this.dataDir).read(agent)}
      : readAgentMessages(agent, new ManualProviderBridge(this.dataDir));
    return { ...result, naming: this.syncTitles(id, result.bound ? result.messages : []) };
  }
  needsTitle(id: string): boolean {
    const agent = this.agent(id);
    return Boolean((agent.autoName && !agent.nameSourceId) || this.sqlite.prepare('SELECT 1 FROM manual_automatic_titles WHERE conversation_id = ? AND source_id IS NULL').get(agent.conversationId));
  }
  syncTitles(id: string, messages: ManualMessage[]): ManualNamingUpdate {
    return this.sqlite.transaction(() => {
      const agent = this.agent(id);
      const automatic = this.sqlite.prepare('SELECT source_id FROM manual_automatic_titles WHERE conversation_id = ?').get(agent.conversationId) as {source_id: string | null} | undefined;
      const pending = (agent.autoName && !agent.nameSourceId) || (automatic && !automatic.source_id);
      const candidate = pending ? messages.filter(message => message.role === 'user').map(message => ({ id: message.id, title: manualContentTitle(message.text) })).find(message => message.title) : undefined;
      if (candidate?.title) {
        if (agent.autoName && !agent.nameSourceId) {
          const names = new Set((this.sqlite.prepare('SELECT record FROM manual_agent_sessions WHERE conversation_id = ? AND id != ?').all(agent.conversationId, id) as {record: string}[]).map(row => (JSON.parse(row.record) as ManualAgent).name));
          let name = candidate.title;
          for (let index = 2; names.has(name); index++) name = `${candidate.title} (${index})`;
          agent.name = name;
          agent.nameSourceId = candidate.id;
          this.sqlite.prepare('UPDATE manual_agent_sessions SET record = ? WHERE id = ?').run(JSON.stringify(agent), id);
        }
        if (automatic && !automatic.source_id) {
          this.sqlite.prepare('UPDATE manual_conversations SET title = ? WHERE id = ?').run(candidate.title, agent.conversationId);
          this.sqlite.prepare('UPDATE manual_automatic_titles SET source_id = ? WHERE conversation_id = ?').run(`${id}:${candidate.id}`, agent.conversationId);
          automatic.source_id = candidate.id;
        }
      }
      const title = automatic?.source_id ? (this.sqlite.prepare('SELECT title FROM manual_conversations WHERE id = ?').get(agent.conversationId) as {title: string}).title : undefined;
      return { conversationId: agent.conversationId, agentId: id, agentName: agent.nameSourceId ? agent.name : undefined, conversationTitle: title };
    })();
  }
  updateModel(id: string, expectedCatalogId: string, catalogId: string, model: string, reasoning?: string): ManualAgent {
    return this.sqlite.transaction(() => {
      const agent = this.agent(id);
      if (agent.catalogId !== expectedCatalogId) return fail('This agent model changed elsewhere. Refresh before applying.', 409);
      const updated = { ...agent, catalogId, model, reasoning };
      this.sqlite.prepare('UPDATE manual_agent_sessions SET record = ? WHERE id = ?').run(JSON.stringify(updated), id);
      return updated;
    })();
  }
  saveBatch(agents: ManualAgent[]): ManualAgent[] {
    return this.sqlite.transaction(() => {
      const result: ManualAgent[] = [];
      for (const agent of agents) {
        const existing = this.sqlite.prepare('SELECT record FROM manual_agent_sessions WHERE id = ?').get(agent.id) as {record: string} | undefined;
        if (existing) {
          const saved = JSON.parse(existing.record) as ManualAgent;
          if (saved.conversationId !== agent.conversationId) return fail('Agent identity conflict.', 409);
          result.push(saved); continue;
        }
        const count = this.sqlite.prepare('SELECT COUNT(*) AS n FROM manual_agent_sessions WHERE conversation_id = ?').get(agent.conversationId) as {n: number};
        if (count.n >= 30) return fail('A manual conversation supports up to 30 agents.', 409);
        if (agent.autoName) {
          const names = new Set((this.sqlite.prepare('SELECT record FROM manual_agent_sessions WHERE conversation_id = ?').all(agent.conversationId) as {record: string}[]).map(row => (JSON.parse(row.record) as ManualAgent).name));
          const prefix = manualProviderName(agent.runtimeType);
          let index = 1;
          while (names.has(`${prefix} ${index}`)) index++;
          agent.name = `${prefix} ${index}`;
        }
        this.sqlite.prepare('INSERT INTO manual_agent_sessions (id, conversation_id, record) VALUES (?, ?, ?)').run(agent.id, agent.conversationId, JSON.stringify(agent));
        result.push(agent);
      }
      return result;
    })();
  }
}

function transcriptPath(agent: ManualAgent): string | null {
  if (agent.runtimeType !== 'claude_code') return null;
  const root = agent.sharedProfile ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') : agent.configDir;
  const projects = path.join(root, 'projects');
  // Directory encoding varies across CLI versions. Search names only, and only for our exact UUID.
  try {
    for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(projects, entry.name, `${agent.providerSessionId}.jsonl`);
      if (fs.existsSync(candidate) && !fs.lstatSync(candidate).isSymbolicLink()) return candidate;
    }
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return null;
}

function readAgentMessages(agent: ManualAgent, bridge: ManualProviderBridge) {
    if (agent.runtimeType === 'codex' || agent.runtimeType === 'opencode') return { supported: true, ...bridge.read(agent) };
    const bindings = bridge.claudeBindings(agent);
    if (bindings.length) {
      let truncated = bindings.length > 8;
      const messages = bindings.slice(-8).flatMap(binding => { const tail = readTail(binding.transcriptPath); truncated ||= tail.truncated; return parseManualTranscript(tail.source, binding.sessionId).map(message => ({...message, id:`${binding.sessionId}:${message.id}`})); });
      return {supported:true, messages, truncated, bound:true};
    }
    const filename = transcriptPath(agent);
    if (!filename) return { supported: agent.runtimeType === 'claude_code', messages: [], truncated: false, bound: false };
    // Bound I/O and parsing even for very long sessions. The UI labels a partial history.
    const tail = readTail(filename);
    return { supported: true, messages: parseManualTranscript(tail.source, agent.providerSessionId), truncated: tail.truncated, bound: true };
}

export function installManualConversations(app: Application, sqlite: Database.Database, runtime: RuntimeHost, dataDir = path.dirname(sqlite.name)): ManualConversationStore {
  const store = new ManualConversationStore(sqlite, dataDir);
  const bridge = new ManualProviderBridge(dataDir);
  const route = (handler: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
    Promise.resolve().then(() => handler(req, res)).catch((error) => res.status(error.status || 500).json({ error: error.message || 'Manual session operation failed.' }));
  };
  const idParam = (req: Request, key: string) => required(req.params[key], key);
  app.get('/api/manual/conversations', route((req, res) => res.json(store.list(required(req.query.workspaceId, 'project')))));
  app.delete('/api/manual/conversations/:conversationId', route((req, res) => {
    store.remove(idParam(req, 'conversationId'));
    res.status(204).end();
  }));
  // The desktop closes its native process before removing the app-owned record.
  // Provider transcripts and curated memory are intentionally not deleted here.
  app.delete('/api/manual/agents/:agentId', route((req, res) => {
    store.removeAgent(idParam(req, 'agentId'));
    res.status(204).end();
  }));
  app.post('/api/manual/conversations', route((req, res) => {
    const id = required(req.body.id, 'conversation ID');
    if (!/^[a-f0-9-]{36}$/i.test(id)) return fail('Invalid conversation identity.');
    res.json(store.create(required(req.body.workspaceId, 'project'), req.body.title === undefined ? undefined : required(req.body.title, 'title'), id));
  }));
  app.post('/api/manual/conversations/:conversationId/agents', route(async (req, res) => {
    const conversation = store.conversation(idParam(req, 'conversationId'));
    const batch = Array.isArray(req.body.agents);
    const inputs = batch ? req.body.agents : [req.body];
    if (!inputs.length || inputs.length > 30) return fail('Choose between 1 and 30 agents.');
    const ids = new Set<string>();
    const agents: ManualAgent[] = [];
    for (const input of inputs) {
      if (!input || typeof input !== 'object') return fail('Invalid agent request.');
      const id = required(input.id, 'agent ID');
      if (!/^[a-f0-9-]{36}$/i.test(id) || ids.has(id)) return fail('Invalid or duplicate agent identity.');
      ids.add(id);
      try {
        const existing = store.agent(id);
        if (existing.conversationId !== conversation.id) return fail('Agent identity conflict.', 409);
        agents.push(existing); continue;
      } catch (error: any) { if (error.status !== 404) throw error; }
      const descriptor = await runtime.getModelCatalogService().resolveModelDescriptor(required(input.catalogId, 'model'));
      if (!descriptor || descriptor.availability !== 'available') return fail('Select an available model from Accounts.');
      const profile = await runtime.getAccountProfileManager().getProfileById(descriptor.accountProfileId);
      if (!profile || profile.authStatus !== 'connected') return fail('The selected CLI account is not connected.');
      if (!['claude_code', 'codex', 'opencode', 'antigravity'].includes(profile.runtimeType)) return fail('This provider does not expose a supported interactive CLI yet.');
      const workspace = store.workspace(conversation.workspaceId);
      const cwd = fs.realpathSync(workspace.path);
      agents.push({ id, conversationId: conversation.id, name: input.name === undefined ? manualProviderName(profile.runtimeType) : required(input.name, 'agent name'), autoName: input.name === undefined,
        catalogId: descriptor.catalogId, runtimeType: profile.runtimeType, model: descriptor.runtimeModelId,
        reasoning: resolveReasoning(input.reasoning, descriptor),
        accountProfileId: profile.id, providerSessionId: randomUUID(), cwd, configDir: profile.configDir,
        sharedProfile: profile.profileMode === 'shared_cli', createdAt: new Date().toISOString() });
    }
    const saved = store.saveBatch(agents);
    res.json(batch ? saved : saved[0]);
  }));
  app.post('/api/manual/agents/:id/launch', route(async (req, res) => {
    const agent = store.agent(idParam(req, 'id'));
    const profile = await runtime.getAccountProfileManager().getProfileById(agent.accountProfileId);
    if (!profile || profile.authStatus !== 'connected') return fail('Reconnect the CLI account before opening this agent.');
    const adapter = runtime.getAdapter(agent.runtimeType);
    if (!adapter) return fail('CLI adapter is unavailable.');
    const installation = await adapter.discoverInstallation(profile.id);
    if (!installation.installed || !installation.path) return fail('CLI executable could not be found.');
    if (!fs.statSync(agent.cwd).isDirectory()) return fail('Project directory is unavailable.');
    const env: Record<string, string> = {};
    if (!agent.sharedProfile) {
      if (agent.runtimeType === 'claude_code') env.CLAUDE_CONFIG_DIR = agent.configDir;
      if (agent.runtimeType === 'codex') env.CODEX_HOME = agent.configDir;
      if (agent.runtimeType === 'opencode') { env.XDG_DATA_HOME = path.join(agent.configDir, 'data'); env.XDG_CONFIG_HOME = path.join(agent.configDir, 'config'); }
    }
    let args = agent.runtimeType === 'claude_code'
      ? bridge.prepareClaude(agent, Boolean(transcriptPath(agent)))
      : ['--model', agent.model];
    // The active-route sentinel is app metadata, not a CLI model name. Never resume
    // the globally latest conversation: manual agents must remain independent.
    if (agent.runtimeType === 'antigravity' && agent.model === 'antigravity-active-route') args = [];
    if (agent.runtimeType === 'antigravity' && agent.model !== 'antigravity-active-route') {
      const descriptor = await runtime.getModelCatalogService().resolveModelDescriptor(agent.catalogId);
      const effort = agent.reasoning || descriptor?.defaultReasoning || (descriptor?.supportedReasoning?.includes('medium') ? 'medium' : descriptor?.supportedReasoning?.[0]);
      if (effort && ['low', 'medium', 'high'].includes(effort)) args.push('--effort', effort);
    }
    if (agent.runtimeType === 'antigravity') args.push(...new ManualAntigravityBridge(dataDir).prepare(agent));
    if (agent.runtimeType === 'codex') {
      const help = await runCommand(installation.path, ['--help'], {timeoutMs: 5000});
      if (!help.stdout.includes('.config.toml')) return fail('Update Codex to a version supporting layered CLI profiles before opening a manual Chat/Code session.');
      args = bridge.prepareCodex(agent);
    }
    if (agent.runtimeType === 'opencode') {
      const prepared = bridge.prepareOpenCode(agent); args = prepared.args; Object.assign(env, prepared.env);
    }
    res.json({ id: agent.id, executable: installation.path, args, cwd: agent.cwd, env });
  }));
  app.get('/api/manual/agents/:id/messages', route((req, res) => res.json(store.readMessages(idParam(req, 'id')))));
  app.get('/api/manual/agents/:id/activity', route((req, res) => {
    const id = idParam(req, 'id');
    // The shell polls every open terminal, including unselected Code panes.
    const naming = store.needsTitle(id) ? store.readMessages(id).naming : store.syncTitles(id, []);
    res.json({ ...bridge.activity(store.agent(id)), naming });
  }));
  app.patch('/api/manual/agents/:id/model', route(async (req, res) => {
    const agent = store.agent(idParam(req, 'id'));
    const catalogId = required(req.body.catalogId, 'model');
    const expected = required(req.body.expectedCatalogId, 'previous model');
    const descriptor = await runtime.getModelCatalogService().resolveModelDescriptor(catalogId);
    if (!descriptor || descriptor.availability !== 'available') return fail('Select a verified available model.');
    const profile = await runtime.getAccountProfileManager().getProfileById(descriptor.accountProfileId);
    if (!profile || profile.authStatus !== 'connected') return fail('Connect this model account first.');
    if (profile.runtimeType !== agent.runtimeType || descriptor.accountProfileId !== agent.accountProfileId) return fail('A different CLI or account requires a new independent agent.', 409);
    res.json(store.updateModel(agent.id, expected, descriptor.catalogId, descriptor.runtimeModelId, resolveReasoning(req.body.reasoning, descriptor)));
  }));
  return store;
}

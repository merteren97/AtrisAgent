import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const LEASE_MS = 90_000;
const MESSAGE_LIMIT = 500;

interface Agent {
  id: string; session: string; workspace: string; name: string; provider: string;
  lastHeartbeat: number; joinedAt: string; summary: string;
}
interface Claim { id: string; workspace: string; path: string; key: string; agentId: string; session: string; intent: string; createdAt: string }
interface Message { id: string; workspace: string; from: string; to?: string; body: string; at: string; readBy: string[] }

/** Live process-local state. Each launch has a fresh session so an old process
 * cannot renew or release claims after a reconnect or manual revocation. */
export class LiveWorkspaceCoordination {
  private agents = new Map<string, Agent>();
  private claims = new Map<string, Claim>();
  private messages: Message[] = [];
  constructor(private now: () => number = () => performance.now()) {}
  clearState(): void { this.agents.clear(); this.claims.clear(); this.messages = []; }

  private root(root: string): string {
    const resolved = fs.realpathSync.native(root);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private normalized(root: string, value: string): { path: string; key: string } {
    if (!value || value.includes('\0') || path.isAbsolute(value)) throw new Error('A workspace-relative path is required.');
    const base = this.root(root);
    const target = path.resolve(base, value);
    let cursor = target;
    const missing: string[] = [];
    for (;;) {
      try {
        fs.lstatSync(cursor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error('Invalid workspace path.');
      missing.unshift(path.basename(cursor)); cursor = parent;
    }
    const real = path.resolve(fs.realpathSync.native(cursor), ...missing);
    const normalized = process.platform === 'win32' ? real.toLowerCase() : real;
    const relative = path.relative(base, normalized);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path must be inside the workspace.');
    return { path: relative.split(path.sep).join('/'), key: normalized };
  }

  private prune(): void {
    const now = this.now();
    for (const [id, agent] of this.agents) {
      if (now - agent.lastHeartbeat < LEASE_MS) continue;
      this.agents.delete(id);
      for (const [claimId, claim] of this.claims) if (claim.session === agent.session) this.claims.delete(claimId);
    }
  }

  join(root: string, id: string, name: string, provider: string): string {
    this.prune();
    const old = this.agents.get(id);
    if (old) for (const [claimId, claim] of this.claims) if (claim.session === old.session) this.claims.delete(claimId);
    const session = randomUUID();
    this.agents.set(id, { id, session, workspace: this.root(root), name: name.slice(0, 120), provider: provider.slice(0, 80), lastHeartbeat: this.now(), joinedAt: new Date().toISOString(), summary: '' });
    return session;
  }

  private agent(id: string, session: string): Agent {
    this.prune();
    const agent = this.agents.get(id);
    if (!agent || agent.session !== session) throw new Error('Coordination session expired; reconnect before continuing.');
    return agent;
  }

  heartbeat(id: string, session: string): void { this.agent(id, session).lastHeartbeat = this.now(); }
  isActive(id: string, session: string): boolean { this.prune(); return this.agents.get(id)?.session === session; }
  state(id: string, session: string) {
    const {agents, claims} = this.snapshot(this.agent(id, session).workspace);
    return {agents, claims};
  }
  leave(id: string, session: string): void {
    const agent = this.agent(id, session);
    this.agents.delete(id);
    for (const [claimId, claim] of this.claims) if (claim.session === agent.session) this.claims.delete(claimId);
  }
  setSummary(id: string, session: string, summary: string): void { this.agent(id, session).summary = summary.slice(0, 1000); }

  claim(id: string, session: string, values: string[], intent: string): Claim[] {
    const agent = this.agent(id, session);
    if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(v => typeof v !== 'string')) throw new Error('Provide between 1 and 100 paths.');
    const paths = [...new Map(values.map(value => { const item = this.normalized(agent.workspace, value); return [item.key, item] as const; })).values()];
    const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
    for (const item of paths) {
      const conflict = [...this.claims.values()].find(claim => claim.workspace === agent.workspace && claim.session !== session && overlaps(claim.key, item.key));
      if (conflict) throw new Error(`Claim conflict: ${item.path} is held by ${conflict.agentId} (${conflict.path}).`);
    }
    return paths.map(item => {
      const existing = [...this.claims.values()].find(claim => claim.session === session && claim.key === item.key);
      if (existing) { existing.intent = intent.slice(0, 1000); return existing; }
      const claim = { id: randomUUID(), workspace: agent.workspace, path: item.path, key: item.key, agentId: id, session, intent: intent.slice(0, 1000), createdAt: new Date().toISOString() };
      this.claims.set(claim.id, claim); return claim;
    });
  }

  release(id: string, session: string, ids: string[]): void {
    this.agent(id, session);
    for (const claimId of ids) if (this.claims.get(claimId)?.session === session) this.claims.delete(claimId);
  }
  clear(root: string, claimId: string): boolean {
    this.prune();
    const claim = this.claims.get(claimId);
    if (!claim || claim.workspace !== this.root(root)) return false;
    this.messages.push({id:randomUUID(),workspace:claim.workspace,from:'system',to:claim.agentId,body:`Your claim for ${claim.path} was cleared by the user. Stop editing it and obtain a new claim before continuing.`,at:new Date().toISOString(),readBy:[]});
    if (this.messages.length > MESSAGE_LIMIT) this.messages.splice(0, this.messages.length - MESSAGE_LIMIT);
    return this.claims.delete(claimId);
  }
  clearAll(root: string): number {
    this.prune();
    const workspace = this.root(root);
    const claims = [...this.claims.values()].filter(claim => claim.workspace === workspace);
    for (const claim of claims) this.clear(root, claim.id);
    return claims.length;
  }
  send(id: string, session: string, body: string, to?: string): void {
    const agent = this.agent(id, session);
    if (!body.trim() || body.length > 4000) throw new Error('Message must contain 1 to 4000 characters.');
    if (to && this.agents.get(to)?.workspace !== agent.workspace) throw new Error('Recipient is not in this workspace.');
    this.messages.push({ id: randomUUID(), workspace: agent.workspace, from: id, ...(to ? {to} : {}), body, at: new Date().toISOString(), readBy: [] });
    if (this.messages.length > MESSAGE_LIMIT) this.messages.splice(0, this.messages.length - MESSAGE_LIMIT);
  }
  read(id: string, session: string): Message[] {
    const agent = this.agent(id, session);
    const messages = this.messages.filter(m => m.workspace === agent.workspace && m.from !== id && (!m.to || m.to === id) && !m.readBy.includes(session));
    for (const message of messages) message.readBy.push(session);
    return messages.map(message => ({ ...message, readBy: [] }));
  }
  snapshot(root: string) {
    this.prune();
    const workspace = this.root(root);
    return {
      agents: [...this.agents.values()].filter(a => a.workspace === workspace).map(({session: _session, workspace: _workspace, lastHeartbeat, ...agent}) => ({...agent, heartbeatAgeMs: Math.max(0, this.now() - lastHeartbeat)})),
      claims: [...this.claims.values()].filter(c => c.workspace === workspace).map(({session: _session, workspace: _workspace, key: _key, ...claim}) => claim),
      messages: this.messages.filter(m => m.workspace === workspace).slice(-100).map(({workspace: _workspace, readBy: _readBy, ...message}) => message),
    };
  }
}

import type { Express, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { redactSensitiveValue } from '@atris-agent-code/event-bus';
import type { ProjectMemoryRoutesOptions } from './project-memory-routes';
import { ManualConversationStore } from './manual-conversations';

// Capture durable, explicit user decisions only, never every turn or an
// assistant's unverified claims. Provider text stays inert data, not instructions.
export function importantManualMemory(text: string): string | undefined {
  const lines = text.split('\n').map(line => line.trim()).filter(line =>
    /^(?:decision\s*:|constraint\s*:|remember\b|always\b|never\b|karar\s*:|kısıt\s*:|unutma\b|bundan sonra\b|her zaman\b|asla\b)/iu.test(line));
  const result = lines.join('\n');
  if (result.length < 20 || result.length > 4000 || /(?:password|secret|token|api[ _-]?key|şifre|parola|private[ _-]?key|-----BEGIN)/iu.test(result)) return undefined;
  if (String(redactSensitiveValue(result)) !== result) return undefined;
  return result || undefined;
}

export function installManualMemoryRoutes(app: Express, store: ManualConversationStore, options: ProjectMemoryRoutesOptions) {
  const synchronizing = new Map<string, Promise<void>>();
  const route = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => { void handler(req, res).catch(error => res.status(error.status || 400).json({error:error.message || 'Manual memory unavailable.'})); };
  const scope = async (req: Request) => {
    const id = String(req.params.conversationId);
    const conversation = store.conversation(id);
    const workspace = await options.workspaceManager.getWorkspace(conversation.workspaceId);
    if (!workspace) throw Object.assign(new Error('Workspace not found.'),{status:404});
    const agentId = req.method === 'GET' ? req.query.agentId : req.body.agentId;
    if (agentId && (typeof agentId !== 'string' || store.agent(agentId).conversationId !== id)) throw new Error('Agent does not belong to this conversation.');
    const { project } = await options.memory.attachWorkspace(workspace);
    return {conversation, project, agentId: agentId as string | undefined};
  };
  app.get('/api/manual/conversations/:conversationId/memory', route(async (req,res) => {
    const {conversation,project,agentId} = await scope(req);
    const snapshot = await options.memory.getSnapshot(project.id);
    res.json({projectId:project.id,nodes:snapshot.nodes.filter(node => node.provenance?.some(p => p.conversationId === conversation.id && (!agentId || p.manualAgentId === agentId)))});
  }));
  app.post('/api/manual/conversations/:conversationId/memory/sync', route(async (req,res) => {
    const {conversation,project,agentId} = await scope(req);
    if (!agentId) throw new Error('An exact agent is required.');
    const existing = synchronizing.get(agentId);
    if (existing) { await existing; res.json({synced:true}); return; }
    const sync = async () => {
      const transcript = store.readMessages(agentId);
      if (!transcript.bound) return;
      const snapshot = await options.memory.getSnapshot(project.id);
      for (const message of transcript.messages.slice(-80)) {
        if (message.role !== 'user') continue;
        const summary = importantManualMemory(message.text);
        if (!summary) continue;
        const sourceId = `auto:${createHash('sha256').update(message.id+'\n'+summary).digest('hex')}`;
        if (store.memoryProcessed(agentId,sourceId)) continue;
        if (!snapshot.nodes.some(node => node.provenance?.some(source => source.manualAgentId===agentId && source.sourceId===sourceId))) {
          await options.memory.createManualMemory(project.id,{type:'decision',title:summary.split('\n')[0].slice(0,120),summary,tags:['manual-conversation','automatic','user-decision'],manualScope:{conversationId:conversation.id,agentId,sourceId}});
        }
        // Durable receipt prevents deleted/archived notes from reappearing on poll.
        store.markMemoryProcessed(agentId,sourceId);
      }
    };
    const pending = sync(); synchronizing.set(agentId,pending);
    try { await pending; res.json({synced:true}); }
    finally { if (synchronizing.get(agentId)===pending) synchronizing.delete(agentId); }
  }));
  app.post('/api/manual/conversations/:conversationId/memory', route(async (req,res) => {
    const text = (value: unknown, limit: number) => { if(typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('Invalid memory content.'); return value.trim(); };
    const title = text(req.body.title,240), summary = text(req.body.summary,4000);
    const body = req.body.body === undefined ? undefined : text(req.body.body,24000);
    const type = req.body.type === 'external_source' ? 'external_source' : 'decision';
    let url: string | undefined;
    if (req.body.url) { const parsed = new URL(text(req.body.url,2000)); if(!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use an HTTP(S) reference without embedded credentials.'); url = parsed.href; }
    if(type === 'external_source' && !url) throw new Error('A reference URL is required.');
    const sourceId = req.body.sourceId ? text(req.body.sourceId,300) : undefined;
    const {conversation,project,agentId} = await scope(req);
    const node = await options.memory.createManualMemory(project.id,{type,title,summary,body,tags:['manual-conversation'],manualScope:{conversationId:conversation.id,agentId,sourceId,url}});
    res.status(201).json(node);
  }));
}

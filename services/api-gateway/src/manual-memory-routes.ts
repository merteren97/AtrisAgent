import type { Express, Request, Response } from 'express';
import type { ProjectMemoryRoutesOptions } from './project-memory-routes';
import { ManualConversationStore } from './manual-conversations';

export function installManualMemoryRoutes(app: Express, store: ManualConversationStore, options: ProjectMemoryRoutesOptions) {
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

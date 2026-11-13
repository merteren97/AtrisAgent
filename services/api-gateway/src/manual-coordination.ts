import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { LiveWorkspaceCoordination } from './live-workspace-coordination';
import type { ManualConversationStore } from './manual-conversations';
import type { ManualIntegrationGateway, ManualIntegrationIdentity } from './manual-integration-gateway';

type Grant = { agentId: string; session?: string; cwd: string; name: string; provider: string; expiresAt: number; windowStart: number; requests: number };
type Configuration = { endpoint: string; script: string };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class ManualCoordination {
  readonly live = new LiveWorkspaceCoordination();
  private grants = new Map<string, Grant>();
  private configuration?: Configuration;
  private integrations?: ManualIntegrationGateway;

  setIntegrationGateway(gateway?: ManualIntegrationGateway): void { this.integrations = gateway; }
  integrationGateway(): ManualIntegrationGateway | undefined { return this.integrations; }

  configure(configuration?: Configuration): void { this.configuration = configuration; if (!configuration) { this.grants.clear(); this.live.clearState(); } }
  isConfigured(): boolean { return Boolean(this.configuration); }

  issue(agent: { id: string; cwd: string; name: string; runtimeType: string }) {
    if (!this.configuration) throw new Error('Live coordination is unavailable; retry after the gateway starts.');
    const now = Date.now();
    for (const [key, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(key);
    const existing = [...this.grants.values()].find(grant => grant.agentId === agent.id && grant.session && this.live.isActive(agent.id, grant.session));
    if (existing) throw Object.assign(new Error('This agent already has an active coordination session. Close it before reopening.'), {status:409});
    this.revoke(agent.id);
    const token = randomBytes(32).toString('base64url');
    this.grants.set(hash(token), { agentId: agent.id, cwd: agent.cwd, name: agent.name, provider: agent.runtimeType, expiresAt: now + 8 * 60 * 60 * 1000, windowStart: now, requests: 0 });
    return { ...this.configuration, token };
  }

  revoke(agentId: string): void {
    for (const [key, grant] of this.grants) if (grant.agentId === agentId) {
      if (grant.session) try { this.live.leave(grant.agentId, grant.session); } catch { /* Already expired. */ }
      this.grants.delete(key);
      void this.integrations?.revoke(key).catch(() => undefined);
    }
  }

  revokeToken(token: string): void {
    const key = hash(token);
    const grant = this.grants.get(key);
    if (!grant) return;
    if (grant.session) try { this.live.leave(grant.agentId, grant.session); } catch { /* Already expired. */ }
    this.grants.delete(key);
    void this.integrations?.revoke(key).catch(() => undefined);
  }

  private authorize(header: string | undefined): {key:string; grant:Grant} {
    const token = header?.length === 50 ? /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header)?.[1] : undefined;
    const key = token ? hash(token) : '';
    const grant = this.grants.get(key);
    if (!grant || grant.expiresAt <= Date.now()) { this.grants.delete(key); throw Object.assign(new Error('Invalid or expired coordination grant.'), {status: 401}); }
    const now = Date.now();
    if (now - grant.windowStart >= 60_000) { grant.windowStart = now; grant.requests = 0; }
    if (++grant.requests > 240) throw Object.assign(new Error('Coordination rate limit exceeded.'), {status: 429});
    return {key,grant};
  }

  integrationIdentity(header: string | undefined): ManualIntegrationIdentity {
    const {key,grant} = this.authorize(header);
    return {agentId:grant.agentId,cwd:grant.cwd,sessionKey:key,expiresAt:grant.expiresAt};
  }

  call(header: string | undefined, tool: string, args: Record<string, any>): unknown {
    const {grant} = this.authorize(header);
    const agentId = grant.agentId;
    if (!grant.session) grant.session = this.live.join(grant.cwd, agentId, grant.name, grant.provider);
    const session = grant.session;
    switch (tool) {
      case 'heartbeat': this.live.heartbeat(agentId, session); return {ok: true};
      case 'workspace_get_state': return this.live.state(agentId, session);
      case 'workspace_join': this.live.setSummary(agentId, session, String(args.summary || '')); return {agentId};
      case 'workspace_claim_paths': return this.live.claim(agentId, session, args.paths, String(args.intent || '')).map(({session: _session, workspace: _workspace, key: _key, ...claim}) => claim);
      case 'workspace_release_paths': if (!Array.isArray(args.claimIds) || args.claimIds.length > 100 || args.claimIds.some((id: unknown) => typeof id !== 'string')) throw new Error('claimIds must contain at most 100 IDs.'); this.live.release(agentId, session, args.claimIds); return {ok: true};
      case 'workspace_send_message': this.live.send(agentId, session, String(args.body || ''), typeof args.toAgentId === 'string' ? args.toAgentId : undefined); return {ok: true};
      case 'workspace_read_messages': return this.live.read(agentId, session);
      default: throw new Error('Unknown workspace coordination tool.');
    }
  }
}

export const manualCoordination = new ManualCoordination();

const route = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
    try { fn(req, res); } catch (error: any) { res.status(error.status || 400).json({error: error.message || 'Coordination failed.'}); }
};

/** This endpoint accepts only an agent-scoped grant, not the desktop token. */
export function installManualCoordinationCallRoute(app: Express, jsonParser: any): void {
  app.use('/api/internal/manual-coordination/call', jsonParser);
  app.post('/api/internal/manual-coordination/call', async (req, res) => {
    if (req.headers.origin) return void res.status(403).json({error:'Browser requests are not accepted.'});
    try {
      const tool = String(req.body?.tool || '');
      if (tool === 'integration_list' || tool === 'integration_call') {
        const identity = manualCoordination.integrationIdentity(req.headers.authorization);
        const gateway = manualCoordination.integrationGateway();
        if (!gateway) return void res.status(503).json({error:'Integration service unavailable.'});
        const args = req.body?.arguments || {};
        const result = tool === 'integration_list' ? await gateway.list(identity) : await gateway.call(identity,args.name,args.arguments);
        return void res.json({result});
      }
      res.json({result: manualCoordination.call(req.headers.authorization, tool, req.body?.arguments || {})});
    } catch (error:any) { res.status(error.status || 400).json({error:error.message || 'Coordination failed.'}); }
  });
}

export function installManualCoordinationRoutes(app: Express, store: ManualConversationStore): void {
  app.get('/api/manual/workspaces/:workspaceId/coordination', route((req, res) => {
    const workspace = store.workspace(String(req.params.workspaceId));
    res.json(manualCoordination.live.snapshot(workspace.path));
  }));
  app.delete('/api/manual/workspaces/:workspaceId/coordination/claims', route((req, res) => {
    const workspace = store.workspace(String(req.params.workspaceId));
    res.json({cleared:manualCoordination.live.clearAll(workspace.path)});
  }));
  app.delete('/api/manual/workspaces/:workspaceId/coordination/claims/:claimId', route((req, res) => {
    const workspace = store.workspace(String(req.params.workspaceId));
    if (!manualCoordination.live.clear(workspace.path, String(req.params.claimId))) return void res.status(404).json({error:'Claim not found.'});
    res.status(204).end();
  }));
}

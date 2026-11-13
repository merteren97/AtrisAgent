import type { IntegrationBroker } from './integration-broker';

export interface ManualIntegrationIdentity { agentId:string; cwd:string; sessionKey:string; expiresAt:number }
type Scope = { workspaceId:string; sessionId:string; agentId:string };
type Broker = Pick<IntegrationBroker,'openGithub'|'listTools'|'callTool'|'close'|'closeAll'>;

// Only tools with a known read-only contract are exposed until the integration
// approval flow can enforce policies independently of individual CLI defaults.
const READ_ONLY_GITHUB_TOOLS = new Set(['get_me','get_file_contents','search_repositories','search_code','search_issues','search_pull_requests','list_issues','issue_read','list_pull_requests','pull_request_read','list_branches','list_commits','get_commit','get_label','list_tags','get_tag','list_releases','get_latest_release','get_release_by_tag']);
type Session = { token:string; scope:Scope };

export class ManualIntegrationGateway {
  private sessions = new Map<string, Promise<Session | null>>();
  private owners = new Map<string, string>();
  constructor(private broker:Broker, private readGithubToken:() => Promise<string>) {}

  private async session(identity: ManualIntegrationIdentity): Promise<Session | null> {
    let pending = this.sessions.get(identity.sessionKey);
    if (!pending) {
      const scope = {workspaceId:identity.cwd,sessionId:identity.sessionKey,agentId:identity.agentId};
      const ttlMs = Math.min(8 * 60 * 60_000, identity.expiresAt - Date.now());
      if (ttlMs <= 0) throw new Error('Integration session expired.');
      pending = this.broker.openGithub(scope, this.readGithubToken, {ttlMs}).then(token => ({token,scope})).catch(() => null);
      this.sessions.set(identity.sessionKey,pending);
      this.owners.set(identity.sessionKey,identity.agentId);
      void pending.then(result => {
        if (!result && this.sessions.get(identity.sessionKey) === pending) {
          this.sessions.delete(identity.sessionKey);
          this.owners.delete(identity.sessionKey);
        }
      });
    }
    return pending;
  }

  async list(identity:ManualIntegrationIdentity) {
    const session = await this.session(identity);
    if (!session) return [];
    return this.broker.listTools(session.token, session.scope).filter(tool => READ_ONLY_GITHUB_TOOLS.has(tool.name.replace(/^github__/,'')));
  }

  async call(identity:ManualIntegrationIdentity, name:unknown, args:unknown) {
    if (typeof name !== 'string' || !name.startsWith('github__') || !READ_ONLY_GITHUB_TOOLS.has(name.slice('github__'.length))) throw new Error('Unknown or unauthorized integration tool.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid integration arguments.');
    const session = await this.session(identity);
    if (!session) throw new Error('GitHub connection is unavailable.');
    return this.broker.callTool(session.token, session.scope, name, args as Record<string,unknown>);
  }

  async revoke(sessionKey:string):Promise<void> {
    const pending = this.sessions.get(sessionKey);
    this.sessions.delete(sessionKey);
    this.owners.delete(sessionKey);
    const session = await pending;
    if (session) await this.broker.close(session.token);
  }

  async revokeAgent(agentId:string):Promise<void> {
    await Promise.all([...this.owners].filter(([,owner]) => owner === agentId).map(([key]) => this.revoke(key)));
  }

  async closeAll():Promise<void> {
    await Promise.all([...this.sessions.keys()].map(key => this.revoke(key)));
    await this.broker.closeAll();
  }
}

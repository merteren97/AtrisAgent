import { useEffect, useState } from 'react';
import { Box, Braces, Github, Globe, Layers3, Loader2, Plug, TerminalSquare, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api-client';
import { useBrowserStore } from '@/stores/browser-store';

type PlaywrightConnection = { packagePath: string; version: string; verifiedAt: string; toolCount: number; setupGuidance?:string };
type GithubStatus = { status: 'not_installed' | 'connected' | 'unverified'; username?: string };
type EditorId = 'unity-mcp' | 'blender' | 'godot';
type EditorConnection = { command: string; args: string[]; verifiedAt: string; toolCount: number; serverName: string; serverVersion: string; setupGuidance?:string };
type UnityConnection = { executable:string; version:string; verifiedAt:string; setupGuidance?:string };
const isEditor = (id: string): id is EditorId => ['unity-mcp', 'blender', 'godot'].includes(id);
const UNITY_PACKAGE_URL = 'https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.3.0';
const SETUP_DETAILS:Record<string,string> = {
  github:'Detects GitHub CLI and, on Windows, installs it if needed. Sign-in continues in your browser.',
  playwright:'Installs and verifies the Playwright MCP package in AtrisAgent’s local data folder.',
  'unity-mcp':'Installs the Unity MCP server. You will then add the Unity package to your project.',
  'unity-cli':'Finds an installed Unity Editor through Unity Hub and checks its version.',
  blender:'Installs the Blender MCP server and attempts to install its Blender add-on.',
  godot:'Installs and verifies the Godot MCP server in AtrisAgent’s local data folder.',
};
const INSTALL_GUIDES:Record<string,string> = {github:'https://cli.github.com/',playwright:'https://nodejs.org/',godot:'https://godotengine.org/download/', 'unity-cli':'https://unity.com/download', 'unity-mcp':'https://docs.astral.sh/uv/getting-started/installation/',blender:'https://docs.astral.sh/uv/getting-started/installation/'};

type Integration = {
  id: string;
  name: string;
  kind: string;
  description: string;
  requirement: string;
  icon: LucideIcon;
};

const INTEGRATIONS: Integration[] = [
  { id: 'github', name: 'GitHub', kind: 'Account', description: 'Work with repositories, issues and pull requests from your conversations.', requirement: 'GitHub account connection', icon: Github },
  { id: 'playwright', name: 'Playwright MCP', kind: 'Browser', description: 'Inspect pages and automate browser workflows with Playwright.', requirement: 'Playwright MCP server and browser', icon: Globe },
  { id: 'unity-mcp', name: 'Unity MCP', kind: 'Editor', description: 'Connect to a Unity editor and work with your project and scenes.', requirement: 'Unity editor and compatible MCP integration', icon: Box },
  { id: 'unity-cli', name: 'Unity CLI', kind: 'Command line', description: 'Run Unity project tasks, tests and builds from the command line.', requirement: 'Unity editor installation', icon: TerminalSquare },
  { id: 'blender', name: 'Blender MCP', kind: 'Editor', description: 'Connect to Blender to inspect and work with scenes and objects.', requirement: 'Blender and compatible MCP integration', icon: Layers3 },
  { id: 'godot', name: 'Godot MCP', kind: 'Editor', description: 'Connect a Godot project to your agent workflows.', requirement: 'Godot and compatible MCP integration', icon: Braces },
];

export function IntegrationsView() {
  const [connection, setConnection] = useState<PlaywrightConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubMessage, setGithubMessage] = useState<string | null>(null);
  const [editors, setEditors] = useState<Partial<Record<EditorId, EditorConnection>>>({});
  const [editorLoading, setEditorLoading] = useState(true);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [unity, setUnity] = useState<UnityConnection | null>(null);
  const [unityBusy, setUnityBusy] = useState(false);
  const [unityError, setUnityError] = useState<string | null>(null);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function openSetup(id:string) {
    const saved = id === 'playwright' ? connection : id === 'unity-cli' ? unity : isEditor(id) ? editors[id] : null;
    setSetupId(id); setSetupError(null); setGuidance(saved?.setupGuidance || null); setCopied(false);
  }

  async function autoSetup() {
    if (!setupId) return;
    setSetupBusy(true); setSetupError(null);
    try {
      const result = await apiRequest<{config?:unknown;guidance:string}>(`/integrations/${setupId}/auto-setup`,{method:'POST',timeoutMs:420_000});
      if (setupId === 'playwright') { setConnection(result.config as PlaywrightConnection); setError(null); }
      else if (setupId === 'unity-cli') { setUnity(result.config as UnityConnection); setUnityError(null); }
      else if (isEditor(setupId)) { setEditors(current => ({...current,[setupId]:result.config as EditorConnection})); setEditorError(null); }
      else if (setupId === 'github') await refreshGithub();
      setGuidance(result.guidance);
    } catch (cause) { setSetupError(cause instanceof Error ? cause.message : 'Setup failed.'); }
    finally { setSetupBusy(false); }
  }

  async function refreshGithub() {
    setGithubBusy(true); setGithubMessage(null);
    try { setGithub(await apiRequest<GithubStatus>('/integrations/github')); }
    catch (cause) { setGithub(null); setGithubMessage(cause instanceof Error ? cause.message : 'Could not check GitHub.'); }
    finally { setGithubBusy(false); }
  }

  async function startGithubLogin() {
    setGithubBusy(true); setGithubMessage(null);
    try {
      await apiRequest('/integrations/github/login', { method:'POST' });
      setGithubMessage('Complete sign-in in the opened terminal and browser, then select Check connection.');
    } catch (cause) { setGithubMessage(cause instanceof Error ? cause.message : 'Could not start sign-in.'); }
    finally { setGithubBusy(false); }
  }

  useEffect(() => {
    let active = true;
    apiRequest<{ connection: PlaywrightConnection | null }>('/integrations/playwright')
      .then(result => { if (active) setConnection(result.connection); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load the connection.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => { void refreshGithub(); }, []);
  useEffect(() => {
    let active = true;
    apiRequest<{connection:UnityConnection | null}>('/integrations/unity-cli').then(result => { if (active) setUnity(result.connection); }).catch(cause => { if (active) setUnityError(cause instanceof Error ? cause.message : 'Could not load Unity CLI.'); });
    return () => { active = false; };
  }, []);

  async function removeUnity() {
    setUnityBusy(true); setUnityError(null);
    try { await apiRequest('/integrations/unity-cli',{method:'DELETE'}); setUnity(null); }
    catch (cause) { setUnityError(cause instanceof Error ? cause.message : 'Could not remove Unity CLI.'); }
    finally { setUnityBusy(false); }
  }
  useEffect(() => {
    let active = true;
    apiRequest<{ connections: Partial<Record<EditorId, EditorConnection>> }>('/integrations/editors')
      .then(result => { if (active) setEditors(result.connections); })
      .catch(cause => { if (active) setEditorError(cause instanceof Error ? cause.message : 'Could not load editor connections.'); })
      .finally(() => { if (active) setEditorLoading(false); });
    return () => { active = false; };
  }, []);

  async function removeEditor(id: EditorId) {
    setEditorBusy(true); setEditorError(null);
    try { await apiRequest(`/integrations/editors/${id}`, {method:'DELETE'}); setEditors(current => { const next = {...current}; delete next[id]; return next; }); }
    catch (cause) { setEditorError(cause instanceof Error ? cause.message : 'Could not remove the connection.'); }
    finally { setEditorBusy(false); }
  }

  async function disconnect() {
    setBusy(true); setError(null);
    try { await apiRequest('/integrations/playwright', { method: 'DELETE' }); setConnection(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove the connection.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-5 py-7 sm:px-8">
        <header className="border-b border-border pb-6">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Plug className="h-3.5 w-3.5" />Workspace tools</div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Integrations</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Connect accounts and development tools for use across your AtrisAgent conversations.</p>
        </header>

        <div role="status" className="mt-6 rounded-xl border border-border bg-muted/30 px-4 py-3">
          <p className="text-sm font-medium">Automatic setup</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Install and manage integration components with guided setup.</p>
        </div>

        <section aria-labelledby="integration-catalog" className="mt-7">
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <div><h2 id="integration-catalog" className="text-sm font-semibold">Integration catalog</h2><p className="mt-1 text-xs text-muted-foreground">Accounts, editors and tools for your workflow.</p></div>
            <span className="text-xs tabular-nums text-muted-foreground">{INTEGRATIONS.length} integrations</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {INTEGRATIONS.map(({ id, name, kind, description, requirement, icon: Icon }) => (
              <article key={id} className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-foreground"><Icon className="h-5 w-5" aria-hidden="true" /></span>
                  <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{name}</h3><p className="mt-0.5 text-xs text-muted-foreground">{kind}</p></div>
                  <Badge variant="secondary" className="shrink-0">{id === 'playwright' ? loading ? 'Checking' : connection ? 'Verified' : 'Setup available' : id === 'github' ? githubBusy ? 'Checking' : !github ? 'Unavailable' : github.status === 'connected' ? 'Verified' : github.status === 'not_installed' ? 'CLI needed' : 'Not verified' : isEditor(id) ? editorLoading ? 'Checking' : editors[id] ? 'Server verified' : 'Setup available' : unity ? 'Verified' : 'Setup available'}</Badge>
                </div>
                <p className="mt-4 min-h-10 text-sm leading-5 text-muted-foreground">{description}</p>
                <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">Requires: {requirement}</p>
                {id === 'github' && <div className="mt-3 space-y-3">
                  {github?.status === 'connected' && <p className="text-xs text-muted-foreground">GitHub CLI account: {github.username}</p>}
                  {github?.status === 'not_installed' && <p className="text-xs leading-5 text-muted-foreground">Set up GitHub CLI to connect an account.</p>}
                  {github?.status === 'unverified' && <p className="text-xs leading-5 text-muted-foreground">Sign in, or check your internet connection and existing GitHub CLI session.</p>}
                  {githubMessage && <p role="status" className="text-xs leading-5 text-muted-foreground">{githubMessage}</p>}
                  <div className="flex flex-wrap gap-2">{github?.status === 'not_installed' ? <Button size="sm" variant="outline" onClick={() => openSetup('github')}>Set up</Button> : github?.status !== 'connected' && <Button size="sm" variant="outline" disabled={githubBusy || !github} onClick={() => void startGithubLogin()}>Sign in with GitHub CLI</Button>}<Button size="sm" variant="ghost" disabled={githubBusy} onClick={() => void refreshGithub()}>Check connection</Button></div>
                </div>}
                {id === 'playwright' && <div className="mt-3 space-y-3">
                  {connection && <p className="text-xs leading-5 text-muted-foreground">Version {connection.version} · {connection.toolCount} tools discovered<br />Last verified: {new Date(connection.verifiedAt).toLocaleString()}</p>}
                  {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                  <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={loading || busy} onClick={() => openSetup('playwright')}>{connection ? 'Set up again' : 'Set up'}</Button>{connection && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect()}>Remove</Button>}</div>
                </div>}
                {isEditor(id) && <div className="mt-3 space-y-3">
                  {editors[id] && <p className="break-all text-xs leading-5 text-muted-foreground">{editors[id]?.serverName} {editors[id]?.serverVersion} · {editors[id]?.toolCount} tools discovered<br />Server verified; editor connection not yet checked.</p>}
                  {editorError && <p role="alert" className="text-xs text-destructive">{editorError}</p>}
                  <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={editorLoading || editorBusy} onClick={() => openSetup(id)}>{editors[id] ? 'Set up again' : 'Set up'}</Button>{editors[id] && <Button size="sm" variant="ghost" disabled={editorBusy} onClick={() => void removeEditor(id)}>Remove</Button>}</div>
                </div>}
                {id === 'unity-cli' && <div className="mt-3 space-y-3">
                  {unity && <p className="text-xs leading-5 text-muted-foreground">Unity {unity.version} detected</p>}
                  {unityError && <p role="alert" className="text-xs text-destructive">{unityError}</p>}
                  <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={unityBusy} onClick={() => openSetup('unity-cli')}>{unity ? 'Detect again' : 'Set up'}</Button>{unity && <Button size="sm" variant="ghost" disabled={unityBusy} onClick={() => void removeUnity()}>Remove</Button>}</div>
                </div>}
              </article>
            ))}
          </div>
        </section>
        <Dialog open={setupId !== null} onOpenChange={value => { if (!value && !setupBusy) setSetupId(null); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Set up {INTEGRATIONS.find(item => item.id === setupId)?.name}</DialogTitle><DialogDescription>AtrisAgent will find the required tools and install the integration components when needed.</DialogDescription></DialogHeader>
            {!guidance && setupId && <p className="text-sm leading-6 text-muted-foreground">{SETUP_DETAILS[setupId]}</p>}
            {setupBusy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Preparing and verifying the integration…</p>}
            {guidance && <p role="status" className="rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm leading-6">{guidance}</p>}
            {guidance && setupId === 'unity-mcp' && <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(UNITY_PACKAGE_URL).then(() => setCopied(true)).catch(() => setSetupError('Could not copy the package URL. Select it from the instructions above.')); }}>{copied ? 'Copied' : 'Copy Unity package URL'}</Button>}
            {setupError && <p role="alert" className="text-sm text-destructive">{setupError}</p>}
            {setupError && setupId && INSTALL_GUIDES[setupId] && <Button variant="ghost" size="sm" onClick={() => useBrowserStore.getState().open(setupError.includes('Node.js') ? 'https://nodejs.org/' : INSTALL_GUIDES[setupId])}>Open installation guide</Button>}
            <DialogFooter><Button variant="outline" disabled={setupBusy} onClick={() => setSetupId(null)}>{guidance ? 'Done' : 'Cancel'}</Button>{guidance && setupId !== 'github' && <Button variant="outline" disabled={setupBusy} onClick={() => { setGuidance(null); void autoSetup(); }}>Check setup again</Button>}{!guidance && <Button disabled={setupBusy} onClick={() => void autoSetup()}>{setupBusy ? 'Setting up…' : setupError ? 'Retry' : 'Start setup'}</Button>}{guidance && setupId === 'github' && <Button disabled={githubBusy} onClick={() => { setSetupId(null); void startGithubLogin(); }}>Continue to sign in</Button>}</DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

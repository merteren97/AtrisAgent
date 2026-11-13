import { useEffect, useState } from 'react';
import { Box, Braces, Github, Globe, Layers3, Loader2, Plug, TerminalSquare, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api-client';

type PlaywrightConnection = { packagePath: string; version: string; verifiedAt: string; toolCount: number };
type GithubStatus = { status: 'not_installed' | 'connected' | 'unverified'; username?: string };
type EditorId = 'unity-mcp' | 'blender' | 'godot';
type EditorConnection = { command: string; args: string[]; verifiedAt: string; toolCount: number; serverName: string; serverVersion: string };
type UnityConnection = { executable:string; version:string; verifiedAt:string };
const isEditor = (id: string): id is EditorId => ['unity-mcp', 'blender', 'godot'].includes(id);

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
  const [open, setOpen] = useState(false);
  const [packagePath, setPackagePath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubMessage, setGithubMessage] = useState<string | null>(null);
  const [editors, setEditors] = useState<Partial<Record<EditorId, EditorConnection>>>({});
  const [editorLoading, setEditorLoading] = useState(true);
  const [editorId, setEditorId] = useState<EditorId | null>(null);
  const [editorCommand, setEditorCommand] = useState('');
  const [editorArgs, setEditorArgs] = useState('[]');
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [unity, setUnity] = useState<UnityConnection | null>(null);
  const [unityOpen, setUnityOpen] = useState(false);
  const [unityBusy, setUnityBusy] = useState(false);
  const [unityPath, setUnityPath] = useState('');
  const [unityError, setUnityError] = useState<string | null>(null);

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

  async function verifyUnity() {
    setUnityBusy(true); setUnityError(null);
    try { const result = await apiRequest<{connection:UnityConnection}>('/integrations/unity-cli/verify', {method:'POST',body:JSON.stringify({executable:unityPath}),timeoutMs:20_000}); setUnity(result.connection); setUnityOpen(false); }
    catch (cause) { setUnityError(cause instanceof Error ? cause.message : 'Unity verification failed.'); }
    finally { setUnityBusy(false); }
  }
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

  async function verifyEditor() {
    if (!editorId) return;
    setEditorBusy(true); setEditorError(null);
    try {
      let args: unknown;
      try { args = JSON.parse(editorArgs); } catch { throw new Error('Arguments must be a JSON array of strings.'); }
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Arguments must be a JSON array of strings.');
      const result = await apiRequest<{connection:EditorConnection}>(`/integrations/editors/${editorId}/verify`, {method:'POST',body:JSON.stringify({command:editorCommand,args}),timeoutMs:35_000});
      setEditors(current => ({...current,[editorId]:result.connection})); setEditorId(null);
    } catch (cause) { setEditorError(cause instanceof Error ? cause.message : 'MCP verification failed.'); }
    finally { setEditorBusy(false); }
  }

  async function removeEditor(id: EditorId) {
    setEditorBusy(true); setEditorError(null);
    try { await apiRequest(`/integrations/editors/${id}`, {method:'DELETE'}); setEditors(current => { const next = {...current}; delete next[id]; return next; }); }
    catch (cause) { setEditorError(cause instanceof Error ? cause.message : 'Could not remove the connection.'); }
    finally { setEditorBusy(false); }
  }

  async function verify() {
    setBusy(true); setError(null);
    try {
      const result = await apiRequest<{ connection: PlaywrightConnection }>('/integrations/playwright/verify', { method: 'POST', body: JSON.stringify({ packagePath }), timeoutMs: 35_000 });
      setConnection(result.connection); setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Connection check failed.'); }
    finally { setBusy(false); }
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
          <p className="text-sm font-medium">Integration setup is in development</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Connect GitHub and verify installed MCP servers for your projects.</p>
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
                  {github?.status === 'not_installed' && <p className="text-xs leading-5 text-muted-foreground">Install GitHub CLI and restart AtrisAgent to connect an account.</p>}
                  {github?.status === 'unverified' && <p className="text-xs leading-5 text-muted-foreground">Sign in, or check your internet connection and existing GitHub CLI session.</p>}
                  {githubMessage && <p role="status" className="text-xs leading-5 text-muted-foreground">{githubMessage}</p>}
                  <div className="flex flex-wrap gap-2">{github?.status !== 'connected' && github?.status !== 'not_installed' && <Button size="sm" variant="outline" disabled={githubBusy || !github} onClick={() => void startGithubLogin()}>Sign in with GitHub CLI</Button>}<Button size="sm" variant="ghost" disabled={githubBusy} onClick={() => void refreshGithub()}>Check connection</Button></div>
                </div>}
                {id === 'playwright' && <div className="mt-3 space-y-3">
                  {connection && <p className="break-all text-xs leading-5 text-muted-foreground">Version {connection.version} · {connection.toolCount} tools discovered<br />Last verified: {new Date(connection.verifiedAt).toLocaleString()}<br />{connection.packagePath}</p>}
                  {error && !open && <p role="alert" className="text-xs text-destructive">{error}</p>}
                  <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={loading || busy} onClick={() => { setPackagePath(connection?.packagePath || ''); setError(null); setOpen(true); }}>{connection ? 'Verify again' : 'Set up'}</Button>{connection && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect()}>Remove</Button>}</div>
                </div>}
                {isEditor(id) && <div className="mt-3 space-y-3">
                  {editors[id] && <p className="break-all text-xs leading-5 text-muted-foreground">{editors[id]?.serverName} {editors[id]?.serverVersion} · {editors[id]?.toolCount} tools discovered<br />Server verified; editor connection not yet checked.</p>}
                  {editorError && !editorId && <p role="alert" className="text-xs text-destructive">{editorError}</p>}
                  <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={editorLoading || editorBusy} onClick={() => { setEditorId(id); setEditorCommand(editors[id]?.command || ''); setEditorArgs(JSON.stringify(editors[id]?.args || [])); setEditorError(null); }}>{editors[id] ? 'Verify again' : 'Set up server'}</Button>{editors[id] && <Button size="sm" variant="ghost" disabled={editorBusy} onClick={() => void removeEditor(id)}>Remove</Button>}</div>
                </div>}
                {id === 'unity-cli' && <div className="mt-3 space-y-3">
                  {unity && <p className="break-all text-xs leading-5 text-muted-foreground">Unity {unity.version}<br />{unity.executable}</p>}
                  {unityError && !unityOpen && <p role="alert" className="text-xs text-destructive">{unityError}</p>}
                  <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={unityBusy} onClick={() => { setUnityPath(unity?.executable || ''); setUnityError(null); setUnityOpen(true); }}>{unity ? 'Verify again' : 'Set up'}</Button>{unity && <Button size="sm" variant="ghost" disabled={unityBusy} onClick={() => void removeUnity()}>Remove</Button>}</div>
                </div>}
              </article>
            ))}
          </div>
        </section>
        <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); setError(null); } }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Set up Playwright MCP</DialogTitle><DialogDescription>Choose an existing local installation to check its MCP connection. This starts the selected package on your computer; only use a package you trust.</DialogDescription></DialogHeader>
            <div className="space-y-2"><Label htmlFor="playwright-package">Installed package directory</Label><Input id="playwright-package" value={packagePath} onChange={event => setPackagePath(event.target.value)} placeholder="C:\\path\\to\\node_modules\\@playwright\\mcp" disabled={busy} /><p className="text-xs leading-5 text-muted-foreground">Select the directory containing the package's package.json and cli.js. AtrisAgent will not download or install it.</p></div>
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy || !packagePath.trim()} onClick={() => void verify()}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{busy ? 'Verifying…' : 'Verify connection'}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={editorId !== null} onOpenChange={value => { if (!value && !editorBusy) { setEditorId(null); setEditorError(null); } }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Set up {INTEGRATIONS.find(item => item.id === editorId)?.name}</DialogTitle><DialogDescription>Start a trusted, already-installed local MCP server to discover its tools. This does not verify an editor or project connection.</DialogDescription></DialogHeader>
            <div className="space-y-2"><Label htmlFor="editor-command">Server executable</Label><Input id="editor-command" value={editorCommand} onChange={event => setEditorCommand(event.target.value)} placeholder="Absolute executable path" disabled={editorBusy} /></div>
            <div className="space-y-2"><Label htmlFor="editor-args">Arguments (JSON array)</Label><Input id="editor-args" value={editorArgs} onChange={event => setEditorArgs(event.target.value)} placeholder={'["argument"]'} disabled={editorBusy} /><p className="text-xs leading-5 text-muted-foreground">Arguments are saved locally. Do not include tokens, passwords or API keys. The server may require a separate editor add-on.</p></div>
            {editorError && <p role="alert" className="text-xs text-destructive">{editorError}</p>}
            <DialogFooter><Button variant="outline" disabled={editorBusy} onClick={() => setEditorId(null)}>Cancel</Button><Button disabled={editorBusy || !editorCommand.trim()} onClick={() => void verifyEditor()}>{editorBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{editorBusy ? 'Verifying…' : 'Verify server'}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={unityOpen} onOpenChange={value => { if (!unityBusy) { setUnityOpen(value); setUnityError(null); } }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Set up Unity CLI</DialogTitle><DialogDescription>Verify an installed Unity Editor by checking its version. Build and project operations are not yet available.</DialogDescription></DialogHeader>
            <div className="space-y-2"><Label htmlFor="unity-path">Unity Editor executable</Label><Input id="unity-path" value={unityPath} onChange={event => setUnityPath(event.target.value)} placeholder="C:\\Program Files\\Unity\\Hub\\Editor\\...\\Editor\\Unity.exe" disabled={unityBusy} /></div>
            {unityError && <p role="alert" className="text-xs text-destructive">{unityError}</p>}
            <DialogFooter><Button variant="outline" disabled={unityBusy} onClick={() => setUnityOpen(false)}>Cancel</Button><Button disabled={unityBusy || !unityPath.trim()} onClick={() => void verifyUnity()}>{unityBusy ? 'Verifying…' : 'Verify Unity'}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

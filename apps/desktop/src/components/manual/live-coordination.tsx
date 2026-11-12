import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api-client';

interface Snapshot {
  agents: Array<{id:string;name:string;provider:string;summary:string;heartbeatAgeMs:number}>;
  claims: Array<{id:string;agentId:string;path:string;intent:string}>;
  messages: Array<{id:string;from:string;to?:string;body:string;at:string}>;
}

export function LiveCoordination({workspaceId}:{workspaceId:string}) {
  const [snapshot,setSnapshot] = useState<Snapshot>();
  const [error,setError] = useState('');
  const [target,setTarget] = useState<string>();
  const [busy,setBusy] = useState(false);
  const endpoint = `/manual/workspaces/${encodeURIComponent(workspaceId)}/coordination`;
  const refresh = useCallback(async () => {
    try { setSnapshot(await apiRequest<Snapshot>(endpoint)); setError(''); }
    catch (cause) { setError(String(cause)); }
  },[endpoint]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); },[refresh]);
  const remove = async () => {
    if (!target || busy) return;
    setBusy(true); setError('');
    try { await apiRequest(`${endpoint}/claims${target === '*' ? '' : `/${encodeURIComponent(target)}`}`,{method:'DELETE'}); setTarget(undefined); await refresh(); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const owner = (id:string) => snapshot?.agents.find(agent => agent.id === id)?.name || id;
  const selected = snapshot?.claims.find(claim => claim.id === target);
  return <div className="min-h-0 flex-1 overflow-auto px-6 py-5"><div className="mx-auto max-w-4xl space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">Live workspace coordination</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Shared by connected manual agents in this workspace. Activity is temporary and clears when the app restarts.</p></div><Button type="button" size="sm" variant="outline" onClick={() => void refresh()}><RefreshCw className="mr-2 h-3.5 w-3.5"/>Refresh</Button></div>
    <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">Claims are advisory: shell commands, external programs and unsupported tools can still change files. Agents should check state and claim paths before editing. Manual Codex, Claude Code, OpenCode and Antigravity sessions can connect; orchestrator sessions are not connected yet.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!snapshot && !error ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/>Loading coordination…</p> : snapshot && <>
      <section><h4 className="mb-3 text-sm font-medium">Connected agents <span className="text-muted-foreground">({snapshot.agents.length})</span></h4>{snapshot.agents.length ? <div className="grid gap-2 sm:grid-cols-2">{snapshot.agents.map(agent => <article key={agent.id} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{agent.name}</span><span className="text-xs text-muted-foreground">{agent.provider}</span></div><p className="mt-1 break-words text-xs text-muted-foreground">{agent.summary || 'No task summary yet'}</p><p className="mt-2 text-xs text-muted-foreground">Heartbeat {Math.floor(agent.heartbeatAgeMs/1000)}s ago</p></article>)}</div> : <p className="text-sm text-muted-foreground">No connected agents. Open or restart an agent to connect.</p>}</section>
      <section><div className="mb-3 flex items-center justify-between gap-2"><h4 className="text-sm font-medium">File claims <span className="text-muted-foreground">({snapshot.claims.length})</span></h4>{snapshot.claims.length > 0 && <Button size="sm" variant="outline" onClick={() => setTarget('*')}>Clear all claims</Button>}</div>{snapshot.claims.length ? <div className="space-y-2">{snapshot.claims.map(claim => <article key={claim.id} className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"><div className="min-w-0"><p className="break-all font-mono text-xs">{claim.path}</p><p className="mt-1 text-xs text-muted-foreground">{owner(claim.agentId)}{claim.intent ? ` · ${claim.intent}` : ''}</p></div><Button type="button" size="icon" variant="ghost" aria-label={`Clear claim for ${claim.path}`} onClick={() => setTarget(claim.id)}><Trash2 className="h-4 w-4"/></Button></article>)}</div> : <p className="text-sm text-muted-foreground">No active file claims.</p>}</section>
      <section><h4 className="mb-3 text-sm font-medium">Recent messages</h4>{snapshot.messages.length ? <div className="space-y-2">{snapshot.messages.map(message => <article key={message.id} className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{owner(message.from)} → {message.to ? owner(message.to) : 'Everyone'} · {new Date(message.at).toLocaleTimeString()}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{message.body}</p></article>)}</div> : <p className="text-sm text-muted-foreground">No coordination messages yet.</p>}</section>
    </>}
    <Dialog open={Boolean(target)} onOpenChange={open => {if (!open && !busy) setTarget(undefined);}}><DialogContent><DialogHeader><DialogTitle>Clear {target === '*' ? 'all claims' : 'this claim'}?</DialogTitle><DialogDescription>{target === '*' ? `This removes ${snapshot?.claims.length || 0} active claim(s).` : `This removes ${selected?.path || 'the selected claim'}.`} The agent may still be editing. Tell it to stop before another agent takes over.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setTarget(undefined)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? 'Clearing…' : target === '*' ? 'Clear all claims' : 'Clear claim'}</Button></DialogFooter></DialogContent></Dialog>
  </div></div>;
}

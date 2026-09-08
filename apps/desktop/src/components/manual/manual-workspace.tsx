import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bot, Code2, MessageSquare, Plus, Send, Square, X, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { useManualStore, type ManualAgent, type ManualMessage } from '@/stores/manual-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useAccountStore } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';
import { apiRequest } from '@/lib/api-client';
import { isTauriRuntime } from '@/lib/secure-storage';
import { ManualTerminal, ensureManualTerminal, type TerminalSnapshot } from './manual-terminal';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const supportsChat = (kind?: string) => ['claude_code', 'codex', 'opencode'].includes(kind || '');
const cliName = (kind: string) => ({ claude_code: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }[kind] || kind);
const selectStyle = 'h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export { ConversationChoice } from '@/components/layout/workspace-home';

function AgentDialog({ conversationId, onClose, onCreated }: { conversationId?: string; onClose: () => void; onCreated: (agent: ManualAgent) => Promise<void> }) {
  const models = useAccountStore(s => s.discoveredModels);
  const workspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const [title, setTitle] = useState(''); const [name, setName] = useState('');
  const [runtime, setRuntime] = useState('claude_code'); const [catalogId, setCatalogId] = useState('');
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  const conversationKey = useRef(crypto.randomUUID()); const agentKey = useRef(crypto.randomUUID());
  const createdConversation = useRef<string | undefined>(conversationId);
  const options = useMemo(() => models.filter(m => m.runtimeType === runtime && m.available), [models, runtime]);
  const selected = options.find(m => m.catalogId === catalogId) || options[0];
  const submit = async () => {
    if (!workspaceId || !selected || pending || (!conversationId && !title.trim())) return;
    setPending(true); setError(null);
    try {
      if (!createdConversation.current) {
        const conversation = await useManualStore.getState().create(workspaceId, title.trim(), conversationKey.current);
        createdConversation.current = conversation.id;
      }
      const agent = await useManualStore.getState().addAgent(createdConversation.current, name.trim() || `${cliName(runtime)} agent`, selected.catalogId, agentKey.current);
      // Creation is durable before launch. A failed launch remains visible and can be retried explicitly.
      await onCreated(agent); onClose();
    } catch (e) { setError(errorText(e)); } finally { setPending(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{conversationId ? 'Add an independent agent' : 'New manual conversation'}</DialogTitle><DialogDescription>Each agent has its own session and context. Agents use this project’s files and stay open until you close them.</DialogDescription></DialogHeader>
    <form className="grid min-w-0 gap-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {!conversationId && <label className="grid gap-1.5 text-xs font-medium">Conversation name<Input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} autoFocus placeholder="e.g. Interface improvements" required /></label>}
      <label className="grid gap-1.5 text-xs font-medium">Agent name<Input value={name} onChange={e => setName(e.target.value)} maxLength={200} placeholder={`${cliName(runtime)} agent`} /></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="grid min-w-0 gap-1.5 text-xs font-medium">CLI<select className={selectStyle} value={runtime} onChange={e => { setRuntime(e.target.value); setCatalogId(''); }}><option value="claude_code">Claude Code</option><option value="codex">Codex</option><option value="opencode">OpenCode</option></select></label>
      <label className="grid min-w-0 gap-1.5 text-xs font-medium">Model<select className={selectStyle} value={selected?.catalogId || ''} onChange={e => setCatalogId(e.target.value)} disabled={!options.length}>{!options.length && <option value="">No available model</option>}{options.map(model => <option key={model.catalogId} value={model.catalogId}>{model.name} · {model.accountName}</option>)}</select></label></div>
      {runtime === 'codex' && <p className="text-xs leading-5 text-muted-foreground">Codex uses a session history hook for Chat. Review and trust the AtrisAgent hook in the CLI’s /hooks screen when prompted.</p>}
      {!options.length && <Button type="button" variant="outline" onClick={() => { useSettingsStore.getState().setActiveView('accounts'); onClose(); }}>Connect a CLI in Accounts</Button>}
      {!isTauriRuntime() && <p className="text-xs text-muted-foreground">Open the desktop app to launch interactive terminals. Conversation history is available here.</p>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" disabled={pending || !selected || (!conversationId && !title.trim())}>{pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{conversationId ? 'Add agent' : 'Create conversation'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

export function ManualWorkspace() {
  const workspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const { conversations, activeByWorkspace, agentByConversation, surfaceByConversation, creating, setCreating, selectAgent, setSurface, drafts, setDraft } = useManualStore();
  const conversation = (workspaceId ? conversations[workspaceId] || [] : []).find(c => c.id === activeByWorkspace[workspaceId!]);
  const agent = conversation?.agents.find(a => a.id === agentByConversation[conversation.id]) || conversation?.agents[0];
  const surface = conversation ? surfaceByConversation[conversation.id] || 'chat' : 'chat';
  const [adding, setAdding] = useState(false); const [closing, setClosing] = useState(false);
  const [pending, setPending] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState(false);
  const actionPending = useRef(false);
  const [messages, setMessages] = useState<ManualMessage[]>([]); const [truncated, setTruncated] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, TerminalSnapshot['status']>>({});
  const [generation, setGeneration] = useState(0); const [grid, setGrid] = useState(1);
  const [search, setSearch] = useState('');
  const messageEnd = useRef<HTMLDivElement>(null); const scroller = useRef<HTMLDivElement>(null); const following = useRef(true);
  const native = isTauriRuntime();
  const agentId = agent?.id;
  const agentIds = conversation?.agents.map(a => a.id).join(',') || '';

  useEffect(() => { setMessages([]); setTruncated(false); setBound(false); setError(null); setClosing(false); following.current = true; }, [agentId]);
  useEffect(() => { setSearch(''); setGrid(1); setAdding(false); }, [conversation?.id]);
  useEffect(() => {
    if (!native || !agentIds) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const results = await Promise.allSettled(agentIds.split(',').map(async id => {
        const snapshot = await invoke<TerminalSnapshot>('manual_terminal_snapshot', { id, after: 0, statusOnly: true });
        if (!disposed && snapshot.status === 'open') ensureManualTerminal(id);
        return [id, snapshot.status] as const;
      }));
      if (disposed) return;
      setStatuses(previous => {
        const next = { ...previous };
        results.forEach((result, index) => { next[agentIds.split(',')[index]] = result.status === 'fulfilled' ? result.value[1] : 'disconnected'; });
        return next;
      });
      timer = setTimeout(poll, 1500);
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [agentIds, native, generation]);
  useEffect(() => {
    if (!agentId || !supportsChat(agent?.runtimeType)) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await apiRequest<{messages: ManualMessage[]; truncated: boolean; bound: boolean}>(`/manual/agents/${agentId}/messages`);
        if (!disposed) { setMessages(result.messages); setTruncated(result.truncated); setBound(Boolean(result.bound)); }
      } catch (e) { if (!disposed) setError(errorText(e)); }
      finally { if (!disposed) timer = setTimeout(poll, 1500); }
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [agentId, agent?.runtimeType]);
  useEffect(() => { if (following.current) messageEnd.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const launch = async (target: ManualAgent) => {
    if (!native) return;
    const request = await apiRequest(`/manual/agents/${target.id}/launch`, { method: 'POST' });
    await invoke('manual_terminal_start', { request });
    ensureManualTerminal(target.id, true);
    setStatuses(previous => ({ ...previous, [target.id]: 'open' })); setGeneration(value => value + 1);
    // Let the user finish the CLI's own trust/login/permission prompts in its real terminal.
    setSurface(target.conversationId, 'code');
  };
  const action = async (label: string, run: () => Promise<unknown>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setPending(label); setError(null);
    try { await run(); } catch (e) { setError(errorText(e)); } finally { setPending(null); actionPending.current = false; }
  };
  const created = async (target: ManualAgent) => {
    try { await launch(target); } catch (e) { setError(`Agent saved. ${errorText(e)} Use Open agent to retry.`); }
  };
  const closeDialog = () => { setCreating(false); setAdding(false); };
  const visibleAgents = conversation?.agents.filter(a => `${a.name} ${a.model} ${cliName(a.runtimeType)}`.toLowerCase().includes(search.toLowerCase())) || [];
  const codeAgents = agent ? [agent, ...(conversation?.agents.filter(a => a.id !== agent.id) || [])].slice(0, grid) : [];
  const live = agent && statuses[agent.id] === 'open';
  const draft = agent ? drafts[agent.id] || '' : '';
  const send = () => agent && action('send', async () => {
    if (!live || !native) return;
    const text = draft.trim(); if (!text) return;
    await invoke('manual_terminal_write', { id: agent.id, data: text, paste: true });
    if (useManualStore.getState().drafts[agent.id] === draft) setDraft(agent.id, '');
  });

  return <section className="manual-workspace flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground" aria-label="Manual conversation">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
      <div className="flex min-w-0 items-center gap-2"><span className="rounded border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Manual</span><span className="truncate text-sm font-medium">{conversation?.title || 'Independent agents'}</span></div>
      <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1" aria-label="Conversation view">{(['chat', 'code'] as const).map(view => <Button key={view} variant={surface === view ? 'secondary' : 'ghost'} size="sm" aria-pressed={surface === view} disabled={!conversation} onClick={() => conversation && setSurface(conversation.id, view)}>{view === 'chat' ? <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> : <Code2 className="mr-1.5 h-3.5 w-3.5" />}{view === 'chat' ? 'Chat' : 'Code'}</Button>)}</div>
    </div>
    {conversation && <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card/40 px-5 py-3">
      {conversation.agents.length > 5 && <Input className="w-32 shrink-0" placeholder="Find agent" aria-label="Find agent" value={search} onChange={e => setSearch(e.target.value)} />}
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="Agents">{visibleAgents.map(item => <button key={item.id} aria-pressed={item.id === agentId} onClick={() => selectAgent(conversation.id, item.id)} className={`flex min-w-40 max-w-64 shrink-0 items-center gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${item.id === agentId ? 'border-primary/35 bg-primary/5 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted'}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statuses[item.id] === 'open' ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} aria-hidden="true" /><span className="min-w-0 text-left"><span className="block truncate font-medium">{item.name}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{cliName(item.runtimeType)} · {statuses[item.id] || 'Not checked'}</span></span></button>)}</div>
      <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" />Add agent</Button>
    </div>}
    {error && <div role="alert" className="flex shrink-0 items-start justify-between gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive"><span className="break-words">{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X className="h-4 w-4" /></button></div>}
    {!conversation || !agent ? <div className="flex flex-1 items-center justify-center p-6"><div className="max-w-md text-center"><Bot className="mx-auto mb-4 h-8 w-8 text-muted-foreground" /><h2 className="text-lg font-medium">Your agents, your workflow</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Group independent agents in a conversation. Each agent keeps its own context and stays under your control.</p><Button className="mt-5" disabled={!workspaceId} onClick={() => conversation ? setAdding(true) : setCreating(true)}><Plus className="mr-2 h-4 w-4" />{conversation ? 'Add first agent' : 'New manual conversation'}</Button></div></div> : <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0"><p className="truncate text-xs font-medium">{agent.name} <span className="font-normal text-muted-foreground">· {cliName(agent.runtimeType)} · {agent.model}</span></p><p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={agent.cwd}>{agent.cwd}</p></div>
        <div className="flex items-center gap-1">
          {surface === 'code' && <select className="h-7 rounded border border-input bg-background px-1 text-xs" aria-label="Terminal layout" value={grid} onChange={e => setGrid(Number(e.target.value))}><option value={1}>Focus</option><option value={2}>2 panes</option><option value={4}>4 panes</option></select>}
          {!live ? <Button size="sm" variant="outline" disabled={!native || Boolean(pending)} onClick={() => void action('open', () => launch(agent))}><RotateCcw className="mr-1 h-3 w-3" />Open agent</Button> : <><Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => void action('interrupt', () => invoke('manual_terminal_write', { id: agent.id, data: agent.runtimeType === 'claude_code' ? '\u001b' : '\u0003', paste: false }))}><Square className="mr-1 h-3 w-3" />Interrupt</Button><Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => setClosing(true)}><X className="mr-1 h-3 w-3" />Close agent</Button></>}
        </div>
      </div>
      {surface === 'code' ? native ? <div className={`grid min-h-0 flex-1 gap-2 overflow-auto p-3 ${grid > 1 ? 'grid-cols-1 auto-rows-[minmax(16rem,1fr)] md:grid-cols-2' : 'grid-cols-1 grid-rows-1'}`}>{codeAgents.map(item => <div className="flex min-h-0 min-w-0 flex-col" key={item.id}>{grid > 1 && <button className="mb-1 truncate text-left text-xs text-muted-foreground" onClick={() => selectAgent(conversation.id, item.id)}>{item.name}</button>}<ManualTerminal id={item.id} generation={generation} /></div>)}</div> : <p className="p-6 text-sm text-muted-foreground">Interactive Code is available in the desktop app.</p> : <>
        <div ref={scroller} onScroll={() => { const node = scroller.current; if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }} className="min-h-0 flex-1 overflow-y-auto select-text">
          <div className="mx-auto w-full max-w-3xl space-y-7 px-6 py-8">
            {!supportsChat(agent.runtimeType) ? <div className="rounded-lg border border-border p-5"><h3 className="text-sm font-medium">Continue in Code</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">This provider’s structured Chat history is not connected yet. Use its interactive terminal to continue this agent.</p><Button className="mt-3" variant="outline" onClick={() => setSurface(conversation.id, 'code')}>Open Code</Button></div> : <>
              {!bound && <p role="status" className="rounded-lg border border-border px-3 py-2 text-xs leading-5 text-muted-foreground">Waiting for this CLI’s session history.{agent.runtimeType === 'codex' ? ' Review the AtrisAgent hook in /hooks, then send a message to connect the session.' : ' Complete CLI setup in Code, then send the first message.'}</p>}
              {truncated && <p className="text-xs text-muted-foreground">Showing recent messages from this long session.</p>}
              {!messages.length && <div className="py-8"><h3 className="text-lg font-medium">Talk to {agent.name}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Finish any CLI setup in Code, then send a message here. Responses and tool activity from this agent appear in this conversation.</p></div>}
              {messages.map(message => message.role === 'tool' ? <details key={message.id} className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">{message.toolName || (message.failed ? 'Tool failed' : 'Tool result')}</summary><p className="mt-2 leading-5">{message.text}</p></details> : <article key={message.id} className={message.role === 'user' ? 'ml-auto max-w-[90%] rounded-xl bg-secondary px-4 py-3' : 'min-w-0'}><p className="mb-2 text-[11px] font-medium text-muted-foreground">{message.role === 'user' ? 'You' : agent.name}</p><MarkdownContent content={message.text} /></article>)}
            </>}
            <div ref={messageEnd} />
          </div>
        </div>
        {supportsChat(agent.runtimeType) && <form className="shrink-0 border-t border-border px-4 py-3" onSubmit={e => { e.preventDefault(); void send(); }}><div className="mx-auto max-w-3xl"><div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground"><span>To {agent.name} · {agent.model}</span><button type="button" className="underline underline-offset-2" onClick={() => setSurface(conversation.id, 'code')}>CLI approvals & live output</button></div><div className="rounded-2xl border border-input bg-card p-3 shadow-sm focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/15"><textarea aria-label={`Message ${agent.name}`} value={draft} onChange={e => setDraft(agent.id, e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} placeholder={live ? 'Message this agent…' : 'Open the agent to continue…'} rows={3} maxLength={32000} className="max-h-40 min-h-20 w-full resize-y bg-transparent px-2 py-1 text-sm outline-none" /><div className="flex items-center justify-between px-1"><span className="text-[10px] text-muted-foreground">{live ? 'CLI open · Shift+Enter for a new line' : 'Session disconnected · history preserved'}</span><Button type="submit" size="sm" disabled={!live || !native || Boolean(pending) || !draft.trim()}>{pending === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}<span className="ml-2">Send</span></Button></div></div></div></form>}
      </>}
    </>}
    {(creating || adding) && <AgentDialog conversationId={adding ? conversation?.id : undefined} onClose={closeDialog} onCreated={created} />}
    <Dialog open={closing} onOpenChange={setClosing}><DialogContent><DialogHeader><DialogTitle>Close {agent?.name}?</DialogTitle><DialogDescription>This stops this agent and its running commands. Other agents continue. Chat history is kept.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setClosing(false)}>Keep open</Button><Button variant="destructive" disabled={Boolean(pending)} onClick={() => agent && void action('close', async () => { await invoke('manual_terminal_close', { id: agent.id }); setStatuses(previous => ({ ...previous, [agent.id]: 'closed' })); setClosing(false); })}>Close agent</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}

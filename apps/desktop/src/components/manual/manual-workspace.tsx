import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bot, Brain, Code2, MessageSquare, Plus, Send, Square, X, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RuntimeBrandIcon, RUNTIME_BRANDS } from '@/components/runtime/runtime-brand-icon';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { useManualStore, type ManualAgent, type ManualMessage, type ManualNamingUpdate } from '@/stores/manual-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useAccountStore, type DiscoveredModel } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';
import { apiRequest } from '@/lib/api-client';
import { isTauriRuntime } from '@/lib/secure-storage';
import { TerminalCanvas } from './terminal-canvas';
import { ensureManualTerminal, disposeManualTerminal, type TerminalSnapshot } from './manual-terminal';
import { ContextTransfer } from './context-transfer';
import { markManualLaunch, markManualClosed } from './manual-activity';
import { ChatSessionControls } from './chat-session-controls';
import { ManualAgentSwitcher } from './manual-agent-switcher';
import { ManualMemory } from './manual-memory';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const supportsChat = (kind?: string) => ['claude_code', 'codex', 'opencode', 'antigravity'].includes(kind || '');
const cliName = (kind: string) => ({ claude_code: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' }[kind] || kind);
const selectStyle = 'h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export { ConversationChoice } from '@/components/layout/workspace-home';

function ManualAgentSetup({ conversationId, onClose, onCreated }: { conversationId?: string; onClose: () => void; onCreated: (agents: ManualAgent[]) => Promise<void> }) {
  const models = useAccountStore(s => s.discoveredModels);
  const workspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const [runtime, setRuntime] = useState('claude_code'); const [catalogId, setCatalogId] = useState('');
  const [count, setCount] = useState(1);
  const existingCount = useManualStore(s => Object.values(s.conversations).flat().find(c => c.id === conversationId)?.agents.length || 0);
  const remaining = 30 - existingCount;
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  const conversationKey = useRef(crypto.randomUUID()); const agentKeys = useRef(Array.from({ length: 30 }, () => crypto.randomUUID()));
  const createdConversation = useRef<string | undefined>(conversationId);
  const options = useMemo(() => models.filter(m => m.runtimeType === runtime && m.available), [models, runtime]);
  const selected = options.find(m => m.catalogId === catalogId) || options[0];
  const submit = async () => {
    if (!workspaceId || !selected || pending) return;
    setPending(true); setError(null);
    try {
      if (!createdConversation.current) {
        const conversation = await useManualStore.getState().create(workspaceId, undefined, conversationKey.current);
        createdConversation.current = conversation.id;
      }
      const agents = await useManualStore.getState().addAgents(createdConversation.current, Array.from({ length: count }, (_, index) => ({
        id: agentKeys.current[index], catalogId: selected.catalogId,
      })));
      // Creation is durable before launch. A failed launch remains visible and can be retried explicitly.
      await onCreated(agents);
    } catch (e) { setError(errorText(e)); } finally { setPending(false); }
  };
  return <section aria-label="Manual agent setup" className="min-h-0 flex-1 overflow-y-auto bg-background">
    <div className="mx-auto w-full max-w-4xl px-6 py-6 lg:px-10 lg:py-8">
      <Button variant="ghost" size="sm" className="-ml-3 mb-5 text-muted-foreground" onClick={onClose} disabled={pending}>← Back to workspace</Button>
      <p className="text-xs font-medium text-primary">Manual workspace</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{conversationId ? 'Add an independent agent' : 'Start your workspace'}</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">Each agent has its own context and terminal. Switch between Chat and Code, work side by side, and close agents only when you decide.</p>
      <form className="mt-6 space-y-6" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <fieldset><legend className="mb-3 text-sm font-medium">1. Choose an AI provider</legend>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {RUNTIME_BRANDS.map(provider => {
              const count = models.filter(model => model.runtimeType === provider.id && model.available).length;
              return <label key={provider.id} className={`relative flex cursor-pointer flex-col rounded-2xl border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring ${runtime === provider.id ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-card hover:border-primary/40 hover:bg-accent/30'}`}>
                <input type="radio" name="provider" value={provider.id} checked={runtime === provider.id} onChange={() => { setRuntime(provider.id); setCatalogId(''); }} className="absolute right-4 top-4 h-4 w-4 accent-primary" />
                <RuntimeBrandIcon runtimeId={provider.id} className="mb-5 h-8 w-8 text-foreground" />
                <span className="text-sm font-semibold">{cliName(provider.id)}</span>
                <span className="mt-1 text-xs leading-5 text-muted-foreground">{count ? `${count} available model${count === 1 ? '' : 's'}` : 'Connect in Accounts'}</span>
              </label>;
            })}
          </div>
        </fieldset>
        <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
          <h2 className="text-sm font-medium">2. Choose a model</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="grid min-w-0 gap-2 text-xs font-medium sm:col-span-2">Model<select className={selectStyle} value={selected?.catalogId || ''} onChange={e => setCatalogId(e.target.value)} disabled={!options.length}>{!options.length && <option value="">No verified model available</option>}{options.map(model => <option key={model.catalogId} value={model.catalogId}>{model.name} · {model.accountName}</option>)}</select></label>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">Conversation and terminal titles are created automatically from your first task, in Chat or Code.</p>
          {runtime === 'codex' && <p className="mt-3 text-xs leading-5 text-muted-foreground">Chat uses a session history hook. Review the AtrisAgent hook in the CLI's /hooks screen when prompted.</p>}
          {runtime === 'antigravity' && <p className="mt-3 text-xs leading-5 text-muted-foreground">Antigravity uses your existing CLI account. Chat reads this agent’s own transcript; approvals and live tool output remain in Code.</p>}
          {!options.length && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/40 p-3"><p className="text-xs leading-5 text-muted-foreground">Connect or verify this provider to load its available models.</p><Button type="button" variant="outline" size="sm" onClick={() => { useSettingsStore.getState().setActiveView('accounts'); onClose(); }}>Open Accounts</Button></div>}
        </div>
        <fieldset disabled={pending}><legend className="mb-3 text-sm font-medium">3. How many agents?</legend>
          <div className="grid grid-cols-4 gap-3">{[1, 2, 4, 8].map(amount => <label key={amount} className={`relative rounded-xl border p-4 text-center focus-within:ring-2 focus-within:ring-ring ${amount > remaining ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${count === amount ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-accent/30'}`}>
            <input type="radio" name="agent-count" value={amount} checked={count === amount} disabled={amount > remaining} onChange={() => setCount(amount)} className="sr-only" />
            <span className="block text-xl font-semibold">{amount}</span><span className="mt-1 block text-xs text-muted-foreground">{amount === 1 ? 'agent' : 'agents'}</span>
          </label>)}</div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">Opens {count} independent CLI {count === 1 ? 'session' : 'sessions'}. Terminals arrange automatically. Add more later, up to 30 per conversation.</p>
        </fieldset>
        {!isTauriRuntime() && <p className="text-xs text-muted-foreground">Use the desktop app to launch interactive terminals.</p>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-border bg-background/95 py-4 backdrop-blur-sm"><Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" className="rounded-xl px-6" disabled={pending || !selected || count > remaining}>{pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{conversationId ? 'Add agent' : 'Create conversation'}</Button></div>
      </form>
    </div>
  </section>;
}

export function ManualWorkspace() {
  const workspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const { conversations, activeByWorkspace, agentByConversation, surfaceByConversation, creating, setCreating, selectAgent, setSurface, drafts, setDraft } = useManualStore();
  const conversation = (workspaceId ? conversations[workspaceId] || [] : []).find(c => c.id === activeByWorkspace[workspaceId!]);
  const surface = conversation ? surfaceByConversation[conversation.id] || 'chat' : 'chat';
  const [adding, setAdding] = useState(false); const [handoff, setHandoff] = useState<ManualAgent | null>(null);
  const hidden = useManualStore(state => state.hiddenAgents);
  const orders = useManualStore(state => state.orderByConversation);
  const order = conversation ? orders[conversation.id] || [] : [];
  const [pending, setPending] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState(false);
  const actionPending = useRef(false);
  const [messages, setMessages] = useState<ManualMessage[]>([]); const [truncated, setTruncated] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, TerminalSnapshot['status']>>({});
  const [memory, setMemory] = useState<{message?:ManualMessage} | null>(null);
  const lifecycleEpoch = useRef(0);
  const visibleAgents = (conversation?.agents || []).filter(item => !hidden[item.id] && !['closed','exited','disconnected'].includes(statuses[item.id])).sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : 999) - (order.includes(b.id) ? order.indexOf(b.id) : 999));
  const agent = conversation?.agents.find(a => a.id === agentByConversation[conversation.id]) || visibleAgents[0] || conversation?.agents[0];
  const openCount = (conversation?.agents || []).filter(item => statuses[item.id] === 'open' && !hidden[item.id]).length;
  const [generation, setGeneration] = useState(0);
  const messageEnd = useRef<HTMLDivElement>(null); const scroller = useRef<HTMLDivElement>(null); const following = useRef(true);
  const native = isTauriRuntime();
  const agentId = agent?.id;
  const agentIds = conversation?.agents.map(a => a.id).join(',') || '';

  useEffect(() => { setMessages([]); setTruncated(false); setBound(false); setError(null); following.current = true; }, [agentId]);
  useEffect(() => { setAdding(false); setHandoff(null); setMemory(null); }, [conversation?.id]);
  useEffect(() => {
    if (!native || !agentIds) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const epoch = lifecycleEpoch.current;
      const results = await Promise.allSettled(agentIds.split(',').map(async id => {
        const snapshot = await invoke<TerminalSnapshot>('manual_terminal_snapshot', { id, after: 0, statusOnly: true });
        if (!disposed && snapshot.status === 'open') ensureManualTerminal(id);
        return [id, snapshot.status] as const;
      }));
      if (disposed) return;
      if (epoch !== lifecycleEpoch.current) { timer = setTimeout(poll, 1500); return; }
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
    let memorySignature = '';
    const poll = async () => {
      try {
        const result = await apiRequest<{messages: ManualMessage[]; truncated: boolean; bound: boolean; naming?: ManualNamingUpdate}>(`/manual/agents/${agentId}/messages`);
        if (!disposed) { setMessages(result.messages); setTruncated(result.truncated); setBound(Boolean(result.bound)); useManualStore.getState().applyNaming(result.naming); }
        const signature = result.messages.filter(message => message.role === 'user').map(message => message.id+':'+message.text).join('\n');
        if (!disposed && result.bound && signature && signature !== memorySignature && agent?.conversationId) {
          await apiRequest(`/manual/conversations/${agent.conversationId}/memory/sync`, {method:'POST',body:JSON.stringify({agentId})});
          memorySignature = signature;
        }
      } catch (e) { if (!disposed) setError(errorText(e)); }
      finally { if (!disposed) timer = setTimeout(poll, 1500); }
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [agentId, agent?.runtimeType]);
  useEffect(() => { if (following.current) messageEnd.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const launch = async (target: ManualAgent, showCode = true) => {
    if (!native) return;
    const request = await apiRequest(`/manual/agents/${target.id}/launch`, { method: 'POST' });
    await invoke('manual_terminal_start', { request });
    lifecycleEpoch.current += 1;
    useManualStore.getState().hideAgent(target.id, false); markManualLaunch(target.id);
    ensureManualTerminal(target.id, true);
    setStatuses(previous => ({ ...previous, [target.id]: 'open' })); setGeneration(value => value + 1);
    // Let the user finish the CLI's own trust/login/permission prompts in its real terminal.
    if (showCode) setSurface(target.conversationId, 'code');
  };
  const action = async (label: string, run: () => Promise<unknown>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setPending(label); setError(null);
    try { await run(); } catch (e) { setError(errorText(e)); } finally { setPending(null); actionPending.current = false; }
  };
  const created = async (targets: ManualAgent[]) => {
    setCreating(false); setAdding(false); setError(null);
    if (!native) return;
    actionPending.current = true;
    const failures: string[] = [];
    try {
      for (let index = 0; index < targets.length; index += 2) {
        setPending(`Opening agents ${index + 1}–${Math.min(index + 2, targets.length)} of ${targets.length}`);
        await Promise.all(targets.slice(index, index + 2).map(async target => {
          try { await launch(target); } catch (e) { failures.push(`${target.name}: ${errorText(e)}`); }
        }));
      }
    } finally { setPending(null); actionPending.current = false; }
    if (failures.length) setError(`Agents saved. ${failures.join(' · ')}. Select the offline agent in Chat and use Open agent to retry.`);
  };
  const closeDialog = () => { if (creating) useManualStore.getState().setMode('choose'); setCreating(false); setAdding(false); };
  const interrupt = (target: ManualAgent) => void action('interrupt', () => invoke('manual_terminal_write', { id: target.id, data: target.runtimeType === 'claude_code' ? '\u001b' : '\u0003', paste: false }));
  const close = (target: ManualAgent) => void action('close', async () => {
    await invoke('manual_terminal_close', { id: target.id });
    lifecycleEpoch.current += 1;
    markManualClosed(target.id); setStatuses(previous => ({ ...previous, [target.id]: 'closed' }));
    useManualStore.getState().hideAgent(target.id, true);
    await useManualStore.getState().removeAgent(target);
    disposeManualTerminal(target.id);
  });
  const restart = (target: ManualAgent) => void action('restart', async () => {
    await invoke('manual_terminal_close', { id: target.id }); lifecycleEpoch.current += 1; markManualClosed(target.id);
    setStatuses(previous => ({ ...previous, [target.id]: 'closed' })); await launch(target);
  });
  const applyModel = (model: DiscoveredModel, independent: boolean, reasoning?: string) => {
    if (!agent || !native) return;
    void action('model', async () => {
      if (independent) {
        const created = await useManualStore.getState().addAgent(agent.conversationId, undefined, model.catalogId, crypto.randomUUID(), reasoning);
        await launch(created, !supportsChat(created.runtimeType));
      } else {
        await invoke('manual_terminal_close', { id: agent.id }); lifecycleEpoch.current += 1; markManualClosed(agent.id);
        setStatuses(previous => ({ ...previous, [agent.id]: 'closed' }));
        const updated = await useManualStore.getState().updateModel(agent, model.catalogId, reasoning);
        await launch(updated, false);
      }
    });
  };
  const live = agent && statuses[agent.id] === 'open';
  const draft = agent ? drafts[agent.id] || '' : '';
  const send = () => agent && action('send', async () => {
    if (!live || !native) return;
    const text = draft.trim(); if (!text) return;
    await invoke('manual_terminal_write', { id: agent.id, data: text, paste: true });
    if (useManualStore.getState().drafts[agent.id] === draft) setDraft(agent.id, '');
  });

  if (creating || adding) return <ManualAgentSetup conversationId={adding ? conversation?.id : undefined} onClose={closeDialog} onCreated={created} />;

  return <section className="manual-workspace flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground" aria-label="Manual conversation">
    <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
      <div className="flex min-w-0 items-center gap-3"><h1 className="truncate text-sm font-medium">{conversation?.title || 'Independent agents'}</h1><span className="text-xs text-muted-foreground">{openCount} open</span></div>
      <div className="flex items-center gap-2">
        {conversation && <Button size="sm" variant="ghost" onClick={() => setMemory({})}><Brain className="mr-1.5 h-3.5 w-3.5"/>Memory</Button>}
        <div className="flex items-center gap-1 rounded-lg bg-muted/40 p-1" aria-label="Conversation view">{(['chat', 'code'] as const).map(view => <Button key={view} variant={surface === view ? 'secondary' : 'ghost'} size="sm" aria-pressed={surface === view} disabled={!conversation} onClick={() => conversation && setSurface(conversation.id, view)}>{view === 'chat' ? <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> : <Code2 className="mr-1.5 h-3.5 w-3.5" />}{view === 'chat' ? 'Chat' : 'Code'}</Button>)}</div>
        {conversation && <Button size="sm" variant="ghost" disabled={Boolean(pending) || conversation.agents.length >= 30} onClick={() => setAdding(true)} title={conversation.agents.length >= 30 ? '30-agent limit reached' : 'Add independent agents'}><Plus className="mr-1 h-3.5 w-3.5" />Add agents</Button>}
      </div>
    </header>
    {pending?.startsWith('Opening') && <p role="status" className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">{pending}</p>}
    {error && <div role="alert" className="flex shrink-0 items-start justify-between gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive"><span className="break-words">{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X className="h-4 w-4" /></button></div>}
    {!conversation || !agent ? <div className="flex flex-1 items-center justify-center p-6"><div className="max-w-md text-center"><Bot className="mx-auto mb-4 h-8 w-8 text-muted-foreground" /><h2 className="text-lg font-medium">Your agents, your workflow</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Group independent agents in a conversation. Each agent keeps its own context and stays under your control.</p><Button className="mt-5" disabled={!workspaceId} onClick={() => conversation ? setAdding(true) : setCreating(true)}><Plus className="mr-2 h-4 w-4" />{conversation ? 'Add first agent' : 'New manual conversation'}</Button></div></div> : <>
      {surface === 'code' ? native ? visibleAgents.length ? <TerminalCanvas agents={visibleAgents} statuses={statuses} selectedId={agentId} pending={Boolean(pending)} generation={generation} onSelect={item => selectAgent(conversation.id, item.id)} onOpen={item => void action('open', () => launch(item))} onInterrupt={interrupt} onClose={close} onRestart={restart} onHandoff={setHandoff} onMove={(source, target) => useManualStore.getState().moveAgent(conversation.id, source, target)} /> : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6"><Bot className="h-8 w-8 text-muted-foreground" /><h2 className="text-base font-medium">All terminal panes closed</h2><p className="text-sm text-muted-foreground">No terminals are running. Open an offline agent in Chat or add a new one.</p><Button variant="outline" onClick={() => setSurface(conversation.id, 'chat')}>View agents</Button></div> : <p className="p-6 text-sm text-muted-foreground">Interactive Code is available in the desktop app.</p> : <>
        <ManualAgentSwitcher agents={conversation.agents} selectedId={agent.id} statuses={statuses} hidden={hidden} onSelect={id=>selectAgent(conversation.id,id)} />
        <div className="mx-auto flex w-full max-w-3xl shrink-0 items-center justify-between gap-3 px-6 py-1.5">
          <span className="flex items-center gap-2 text-xs text-muted-foreground"><span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />{pending === 'model' ? 'Applying model…' : live ? 'CLI connected' : 'CLI closed'}<span className="hidden sm:inline">· Independent session</span></span>
          {!live ? <Button size="sm" variant="ghost" disabled={!native || Boolean(pending)} onClick={() => void action('open', () => launch(agent))}><RotateCcw className="mr-1 h-3 w-3" />Open agent</Button> : <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => interrupt(agent)}><Square className="mr-1 h-3 w-3" />Interrupt</Button>}
        </div>
        <div ref={scroller} onScroll={() => { const node = scroller.current; if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }} className="min-h-0 flex-1 overflow-y-auto select-text">
          <div className="mx-auto w-full max-w-3xl space-y-7 px-6 py-8">
            {!supportsChat(agent.runtimeType) ? <div className="rounded-lg border border-border p-5"><h3 className="text-sm font-medium">Continue in Code</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">This provider’s structured Chat history is not connected yet. Use its interactive terminal to continue this agent.</p><Button className="mt-3" variant="outline" onClick={() => setSurface(conversation.id, 'code')}>Open Code</Button></div> : <>
              {!bound && <div role="status" className="flex items-start gap-3 rounded-xl bg-muted/40 px-4 py-3"><Code2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><p className="text-xs leading-5 text-muted-foreground">Connect this CLI’s history to see its replies here.{agent.runtimeType === 'codex' ? ' Review the AtrisAgent hook in /hooks.' : agent.runtimeType === 'antigravity' ? ' Reopen older agents once to enable their dedicated session link, then send a message.' : ' Complete CLI setup in Code and send your first message.'}<button className="ml-2 font-medium text-foreground underline underline-offset-4" onClick={() => setSurface(conversation.id, 'code')}>Open terminal</button></p></div>}
              {truncated && <p className="text-xs text-muted-foreground">Showing recent messages from this long session.</p>}
              {!messages.length && <div className="py-8"><RuntimeBrandIcon runtimeId={agent.runtimeType} className="mb-4 h-9 w-9 text-foreground" /><h3 className="text-xl font-semibold tracking-tight">What would you like to work on?</h3><p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">Message {agent.name}, choose a model in the composer, or open Code for the live terminal. Each agent keeps its own conversation.</p><div className="mt-5 flex flex-wrap gap-2">{['Explore this project', 'Review recent changes', 'Help me plan a task'].map(prompt => <Button key={prompt} size="sm" variant="outline" className="rounded-full text-xs" onClick={() => setDraft(agent.id, prompt)}>{prompt}</Button>)}</div></div>}
              {messages.map(message => message.role === 'tool' ? <details key={message.id} className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">{message.toolName || (message.failed ? 'Tool failed' : 'Tool result')}</summary><p className="mt-2 leading-5">{message.text}</p></details> : <article key={message.id} className={message.role === 'user' ? 'ml-auto max-w-[90%] rounded-xl bg-secondary px-4 py-3' : 'min-w-0'}><p className="mb-2 text-[11px] font-medium text-muted-foreground">{message.role === 'user' ? 'You' : agent.name}</p><MarkdownContent content={message.text} /></article>)}
            </>}
            <div ref={messageEnd} />
          </div>
        </div>
        <form aria-label="Manual message composer" className="shrink-0 px-4 pb-3 pt-2" onSubmit={e => { e.preventDefault(); if(supportsChat(agent.runtimeType))void send(); }}><div className="mx-auto max-w-3xl rounded-2xl border border-input bg-card p-3 shadow-sm focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/15">{supportsChat(agent.runtimeType)&&<textarea aria-label={`Message ${agent.name}`} value={draft} onChange={e => setDraft(agent.id, e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} placeholder={live ? 'Message this agent…' : 'Open the agent to continue…'} rows={2} maxLength={32000} className="max-h-40 min-h-16 w-full resize-y bg-transparent px-2 py-1 text-sm outline-none" />}<div className="flex items-center justify-between gap-2"><ChatSessionControls key={`${agent.id}:${agent.catalogId}`} agent={agent} agents={conversation.agents} pending={Boolean(pending)||!native} onApply={applyModel}/><div className="flex items-center gap-2"><Button type="button" variant="ghost" size="icon" aria-label="Open memory and references" onClick={()=>setMemory({})}><Brain className="h-4 w-4"/></Button><Button type="submit" size="sm" disabled={!supportsChat(agent.runtimeType)||!live || !native || Boolean(pending) || !draft.trim()}>{pending === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}<span className="ml-2">Send</span></Button></div></div></div><p className="mx-auto mt-2 max-w-3xl px-2 text-[10px] text-muted-foreground">{agent.name} · {live?'CLI open':'Offline'} · Shift+Enter for a new line</p></form>
      </>}
    </>}
    {handoff && conversation && <ContextTransfer source={handoff} agents={conversation.agents} onClose={() => setHandoff(null)} />}
    {memory && conversation && <ManualMemory key={conversation.id+':'+(memory.message?.id||'notes')} conversation={conversation} agent={agent} message={memory.message} onClose={()=>setMemory(null)}/>}
  </section>;
}

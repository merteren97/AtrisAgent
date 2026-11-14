import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, FileText, Loader2, Maximize2, Minimize2, RefreshCw, Sparkles, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import { ApiError, apiRequest } from '@/lib/api-client';
import { useAccountStore } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';
import {
  EMPTY_PLANNING_CHAT, planningChatDisplayText, planningChatKey, usePlanningChatStore,
  type PlanningChatProposal, type PlanningChatState,
} from '@/stores/planning-chat-store';

export interface PlanningChatProps {
  workspaceId: string; planId: string; onDocumentChange: (path: string) => void;
  onClose?: () => void; onExpand?: () => void; expanded?: boolean;
}
type Review = { proposal: PlanningChatProposal; document?: { content: string; revision: string | null }; error?: string };
const suggestions = ['Help me shape this plan', 'Find risks and open questions', 'Research the project before we decide'];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Keying the session isolates in-flight responses, scroll position, and review dialogs. */
export function PlanningChat(props: PlanningChatProps) {
  return <PlanningChatSession key={planningChatKey(props.workspaceId, props.planId)} {...props} />;
}

function PlanningChatSession({ workspaceId, planId, onDocumentChange, onClose, onExpand, expanded }: PlanningChatProps) {
  const key = planningChatKey(workspaceId, planId);
  const preferences = usePlanningChatStore(state => state.plans[key] || EMPTY_PLANNING_CHAT);
  const update = usePlanningChatStore(state => state.update);
  const models = useAccountStore(state => state.discoveredModels);
  const catalogLoading = useAccountStore(state => state.modelCatalogLoading);
  const catalogError = useAccountStore(state => state.modelCatalogError);
  const availableModels = models.filter(model => model.available && model.availability === 'available'
    && model.source !== 'cached' && ['codex', 'claude_code', 'opencode', 'antigravity'].includes(model.runtimeType));
  const model = availableModels.find(item => item.catalogId === preferences.catalogId)
    || (!preferences.catalogId ? availableModels[0] : undefined);
  const reasoning = model?.supportedReasoning.some(level => level === preferences.reasoning) ? preferences.reasoning : '';
  const [chat, setChat] = useState<PlanningChatState>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review>();
  const [following, setFollowing] = useState(true);
  const root = useRef<HTMLElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const actionBusy = useRef(false);
  const reviewLoad = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const latest = useRef<PlanningChatState | undefined>(undefined);
  const onChange = useRef(onDocumentChange);
  onChange.current = onDocumentChange;
  const base = `/planning/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planId)}/chat`;
  const running = chat?.status === 'running';
  const canSend = Boolean(chat && model && preferences.draft.trim() && !running && !busy);

  useEffect(() => {
    if (!preferences.catalogId && model) update(key, { catalogId: model.catalogId });
  }, [key, model, preferences.catalogId, update]);

  useEffect(() => {
    alive.current = true;
    const pending = controllers.current;
    return () => { alive.current = false; pending.forEach(controller => controller.abort()); pending.clear(); };
  }, []);

  const accept = useCallback((state: PlanningChatState) => {
    if (!alive.current || (latest.current && state.revision < latest.current.revision)) return;
    const previous = latest.current;
    latest.current = state;
    setChat(state);
    setLoadError(undefined);
    if (previous) {
      for (const proposal of state.proposals) {
        if (proposal.status === 'applied' && !previous.proposals.some(item => item.id === proposal.id && item.revision === proposal.revision && item.status === 'applied')) {
          onChange.current(proposal.path);
        }
      }
    }
  }, []);

  const request = useCallback(async <T,>(path: string, body?: unknown) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      return await apiRequest<T>(path, { signal: controller.signal, cache: 'no-store',
        ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
      });
    } finally { controllers.current.delete(controller); }
  }, []);

  // Poll only while this selected pane is actually visible. Never overlap polls.
  useEffect(() => {
    let disposed = false;
    let inView = typeof IntersectionObserver === 'undefined';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let pollController: AbortController | undefined;
    const poll = async () => {
      if (disposed || polling || !inView || document.visibilityState === 'hidden') return;
      polling = true;
      pollController = new AbortController();
      try {
        const state = await apiRequest<PlanningChatState>(base, { signal: pollController.signal, cache: 'no-store' });
        if (!disposed) accept(state);
      } catch (error) {
        if (!disposed && !pollController.signal.aborted) setLoadError(errorText(error));
      } finally {
        polling = false;
        if (!disposed) timer = setTimeout(() => void poll(), latest.current?.status === 'running' ? 800 : 4000);
      }
    };
    const wake = () => {
      clearTimeout(timer);
      if (!inView || document.visibilityState === 'hidden') pollController?.abort();
      else void poll();
    };
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting); wake();
    });
    if (root.current) observer?.observe(root.current);
    document.addEventListener('visibilitychange', wake);
    void poll();
    return () => { disposed = true; clearTimeout(timer); pollController?.abort(); observer?.disconnect(); document.removeEventListener('visibilitychange', wake); };
  }, [base, accept]);

  useLayoutEffect(() => {
    const element = timeline.current;
    if (!element || !content.current) return;
    const scroll = () => { if (following) element.scrollTop = element.scrollHeight; };
    scroll();
    const observer = new ResizeObserver(scroll);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [following]);
  useLayoutEffect(() => {
    if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 160)}px`; }
  }, [preferences.draft]);

  const send = async () => {
    if (!canSend || !model || actionBusy.current) return;
    actionBusy.current = true; setBusy(true); setActionError(undefined);
    const input = usePlanningChatStore.getState().prepare(key, preferences.draft, model.catalogId, reasoning || undefined);
    try {
      const state = await request<PlanningChatState>(`${base}/messages`, input);
      // This is deliberately keyed even if the user switched plans during send.
      usePlanningChatStore.getState().acknowledge(key, input);
      if (alive.current) { accept(state); setFollowing(true); }
    } catch (error) {
      if (alive.current) setActionError(`${errorText(error)} Your draft is kept. Retry with the same text and model to safely check this send.`);
    } finally { actionBusy.current = false; if (alive.current) setBusy(false); }
  };

  const stop = async () => {
    if (!chat?.turnId || actionBusy.current) return;
    actionBusy.current = true; setBusy(true); setActionError(undefined);
    try { accept(await request<PlanningChatState>(`${base}/stop`, { turnId: chat.turnId })); }
    catch (error) { if (alive.current) setActionError(errorText(error)); }
    finally { actionBusy.current = false; if (alive.current) setBusy(false); }
  };

  const loadReview = async (proposal: PlanningChatProposal) => {
    const generation = ++reviewLoad.current;
    setReview({ proposal });
    try {
      let document;
      try {
        document = await request<{ content: string; revision: string }>(`/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planId)}/document?path=${encodeURIComponent(proposal.path)}`);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
        document = { content: '', revision: null };
      }
      if (alive.current && reviewLoad.current === generation) setReview(current => current?.proposal.id === proposal.id ? { ...current, document } : current);
    } catch (error) {
      if (alive.current && reviewLoad.current === generation) setReview(current => current?.proposal.id === proposal.id ? { ...current, error: errorText(error) } : current);
    }
  };

  const apply = async () => {
    if (!review?.document || running || actionBusy.current) return;
    actionBusy.current = true; setBusy(true);
    const selected = review;
    try {
      const state = await request<PlanningChatState>(`${base}/updates/${encodeURIComponent(selected.proposal.id)}/apply`, { expectedRevision: selected.document!.revision });
      accept(state);
      if (alive.current) setReview(undefined);
    } catch (error) {
      if (alive.current) {
        // Invalidate the reviewed revision: a second click cannot blindly retry it.
        if (error instanceof ApiError && error.status === 409) {
          const state = (error.details as { state?: PlanningChatState } | undefined)?.state;
          if (state) accept(state);
        }
        setReview({ proposal: selected.proposal, error: `${errorText(error)} Reload the latest document and compare again before applying.` });
      }
    } finally { actionBusy.current = false; if (alive.current) setBusy(false); }
  };

  return <aside ref={root} aria-label="Planning assistant" className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <Sparkles className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium">Planning assistant</h2><p className="text-[11px] text-muted-foreground">{chat ? `${chat.messages.filter(message => message.role !== 'system').length} messages` : 'Connecting…'}</p></div>
      {onExpand && <Button variant="ghost" size="icon" className="size-7" aria-label={expanded ? 'Collapse assistant' : 'Expand assistant'} onClick={onExpand}>{expanded ? <Minimize2 /> : <Maximize2 />}</Button>}
      {onClose && <Button variant="ghost" size="icon" className="size-7" aria-label="Close assistant" onClick={onClose}><X /></Button>}
    </header>
    <div ref={timeline} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain" onScroll={event => {
      const element = event.currentTarget; setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 64);
    }}>
      <div ref={content} className="space-y-5 px-3 py-4">
        {!chat && !loadError && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />Loading conversation…</p>}
        {chat?.messages.length === 0 && <div className="py-5">
          <h3 className="text-sm font-medium">Think it through together</h3>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Explore the project, clarify decisions, and refine this plan. Plan and research documents are included as context.</p>
          <div className="mt-4 flex flex-col items-start gap-2">{suggestions.map(suggestion => <button key={suggestion} type="button" onClick={() => { update(key, { draft: suggestion }); textarea.current?.focus(); }} className="max-w-full rounded-lg border border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{suggestion}</button>)}</div>
        </div>}
        {chat?.messages.map(message => {
          const text = message.role === 'assistant' ? planningChatDisplayText(message.content) : message.content;
          const proposals = chat.proposals.filter(proposal => proposal.turnId === message.turnId);
          return <article key={message.id} className="min-w-0 space-y-2">
            <p className="text-[11px] font-medium text-muted-foreground">{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'Activity'}{message.partial && running && message.turnId === chat.turnId ? ' · Writing' : ''}</p>
            {text && (message.role === 'assistant' ? <div className="min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto"><MarkdownContent content={text} /></div> : <p className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${message.role === 'user' ? 'rounded-xl bg-muted/60 px-3 py-2 text-sm leading-relaxed' : 'text-xs leading-relaxed text-muted-foreground'}`}>{text}</p>)}
            {message.role === 'assistant' && !text && message.partial && running && <p className="text-xs text-muted-foreground">Preparing document update…</p>}
            {message.role === 'assistant' && proposals.map(proposal => <div key={proposal.id} className="min-w-0 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2"><FileText className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-all text-xs font-medium">{proposal.path}</span>{proposal.status === 'applied' && <Check className="size-3.5 shrink-0 text-primary" />}</div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{proposal.status === 'applied' ? 'Document updated' : proposal.status === 'conflict' ? 'The document changed. Compare before applying.' : 'Document update pending'}</p>
              <div className="mt-2 flex flex-wrap gap-2"><Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onDocumentChange(proposal.path)}>Show in document</Button>{proposal.status !== 'applied' && <Button variant="outline" size="sm" className="h-7 px-2" disabled={running || busy} onClick={() => void loadReview(proposal)}>Review update</Button>}</div>
            </div>)}
          </article>;
        })}
      </div>
    </div>
    <div className="shrink-0 border-t border-border px-3 pb-3 pt-2">
      {!following && <Button variant="ghost" size="sm" className="mb-2 w-full" onClick={() => setFollowing(true)}><ArrowDown />Latest messages</Button>}
      <div role="status" className="mb-2 flex min-h-4 items-center gap-2 text-[11px] text-muted-foreground">{running ? <><Loader2 className="size-3 shrink-0 animate-spin" /><span className="min-w-0 break-words">{chat?.activity || 'Working on your plan'}</span></> : chat?.status === 'cancelled' ? 'Stopped · partial response kept' : chat?.status === 'complete' ? 'Ready for your next thought' : chat?.status === 'failed' || chat?.status === 'interrupted' ? 'Needs attention' : 'Plan and research in context'}</div>
      {(loadError || actionError || chat?.error) && <div role="alert" className="mb-2 max-h-28 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs leading-relaxed text-destructive [overflow-wrap:anywhere]">{[loadError, actionError, chat?.error].filter(Boolean).join('\n')}</div>}
      {!availableModels.length && <div className="mb-2 text-xs leading-relaxed text-muted-foreground"><p>{catalogLoading ? 'Loading available models…' : 'Connect a supported model to start planning.'}</p>{catalogError && <p className="mt-1 break-words text-destructive">{catalogError}</p>}<Button variant="link" size="sm" className="h-7 px-0" onClick={() => useSettingsStore.getState().setActiveView('accounts')}>Open Accounts</Button></div>}
      <form onSubmit={event => { event.preventDefault(); void send(); }} className="rounded-xl border border-input bg-card p-2 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/15">
        <textarea ref={textarea} aria-label="Message planning assistant" placeholder="Ask about this plan…" value={preferences.draft} maxLength={16000} rows={3} onChange={event => update(key, { draft: event.target.value })} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        }} className="block max-h-40 min-h-16 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground" />
        <div className="mt-2 flex min-w-0 items-center gap-1 border-t border-border/60 pt-2">
          {model && <RuntimeBrandIcon runtimeId={model.runtimeType} className="size-3.5 shrink-0 text-muted-foreground" />}
          <select aria-label="Planning model" value={model?.catalogId || ''} disabled={busy || running || !availableModels.length} onChange={event => update(key, { catalogId: event.target.value, reasoning: '' })} className="h-7 min-w-0 flex-1 rounded bg-card text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {!model && <option value="">{preferences.catalogId ? 'Model unavailable · select another' : 'Select model'}</option>}{availableModels.map(item => <option key={item.catalogId} value={item.catalogId}>{item.name} · {item.accountName}</option>)}
          </select>
          {running ? <Button type="button" variant="secondary" size="icon" className="size-7 shrink-0" aria-label="Stop response" title="Stop response" disabled={busy} onClick={() => void stop()}>{busy ? <Loader2 className="animate-spin" /> : <Square />}</Button> : <Button type="submit" size="icon" className="size-7 shrink-0" aria-label={busy ? 'Sending message' : 'Send message'} title="Send message" disabled={!canSend}>{busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}</Button>}
        </div>
        {!!model?.supportedReasoning.length && <div className="mt-1 flex min-w-0 items-center gap-2 px-1 text-[11px] text-muted-foreground"><label htmlFor={`reasoning-${planId}`}>Reasoning</label><select id={`reasoning-${planId}`} value={reasoning} disabled={busy || running} onChange={event => update(key, { reasoning: event.target.value })} className="h-6 min-w-0 flex-1 rounded bg-card text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">Model default{model.defaultReasoning ? ` (${model.defaultReasoning})` : ''}</option>{model.supportedReasoning.map(level => <option key={level} value={level}>{level}</option>)}</select></div>}
      </form>
      <p className="mt-1.5 text-[10px] text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
    </div>
    <Dialog open={!!review} onOpenChange={open => { if (!open && !busy) setReview(undefined); }}>
      <DialogContent className="min-w-0 sm:max-w-3xl">
        <DialogHeader><DialogTitle>Review document update</DialogTitle><DialogDescription className="break-all">{review?.proposal.path} · Compare the latest saved document with the proposed replacement. Unsaved editor drafts stay in the editor.</DialogDescription></DialogHeader>
        {review?.error && <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">{review.error}</p>}
        {review?.document ? <div className="grid min-w-0 gap-3 sm:grid-cols-2">{[{ title: review.document.revision === null ? 'Latest document · not created' : 'Latest saved document', text: review.document.content }, { title: 'Proposed replacement', text: review.proposal.content }].map(item => <section key={item.title} className="min-w-0"><h3 className="mb-2 text-xs font-medium">{item.title}</h3><pre tabIndex={0} className="max-h-[45vh] min-h-24 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed [overflow-wrap:anywhere]">{item.text || '(empty document)'}</pre></section>)}</div> : !review?.error && <p role="status" className="text-sm text-muted-foreground">Loading the latest document…</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setReview(undefined)}>Cancel</Button>{review?.error && <Button variant="secondary" disabled={busy} onClick={() => void loadReview(review.proposal)}><RefreshCw />Reload comparison</Button>}<Button disabled={!review?.document || busy || running} onClick={() => void apply()}>{busy && <Loader2 className="animate-spin" />}Apply replacement</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </aside>;
}

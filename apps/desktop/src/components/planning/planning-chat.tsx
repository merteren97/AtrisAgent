import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Check, FileText, History, Loader2, Maximize2, Minimize2, MoreHorizontal, Plus, RefreshCw, RotateCcw, Sparkles, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import { ManualComposer, addManualFiles } from '@/components/manual/manual-composer';
import { CodexPermissions } from '@/components/manual/codex-permissions';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ApiError, apiRequest, getApiBaseUrl, runtimeHeaders } from '@/lib/api-client';
import { getAuthToken } from '@/lib/token-provider';
import { useAccountStore, type DiscoveredModel } from '@/stores/account-store';
import { PlanningCliSetup, planningCliName } from './planning-cli-setup';
import { PlanningMedia } from './planning-media';
import { extractChatImages, ChatImageGallery } from '@/components/chat/chat-image-preview';
import type { CodexPermissionMode } from '@atris-agent-code/domain';
import {
  EMPTY_PLANNING_CHAT, planningChatDisplayText, planningChatKey, usePlanningChatStore,
   type PlanningChatProposal, type PlanningChatState, type PlanningConversation, type PlanningChatInput, type PlanningChatMessage,
} from '@/stores/planning-chat-store';

export interface PlanningChatProps {
  workspaceId: string; planId: string; onDocumentChange: (path: string) => void;
  onClose?: () => void; onExpand?: () => void; expanded?: boolean;
}
type Review = { proposal: PlanningChatProposal; document?: { content: string; revision: string | null }; error?: string };
const suggestions = ['Create a plan and organize its board from the project context', 'Update the board from this plan and research', 'Find risks and open questions'];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const EMPTY_FILES: File[] = [];
const fileMime = (file: File) => ({ md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf' }[file.name.split('.').pop()?.toLowerCase() || ''] || file.type);

/** Keying the session isolates in-flight responses, scroll position, and review dialogs. */
export function PlanningChat(props: PlanningChatProps) {
  return <PlanningChatTabs key={planningChatKey(props.workspaceId, props.planId)} {...props} />;
}

function PlanningChatTabs({ workspaceId, planId, onDocumentChange, onClose, onExpand, expanded }: PlanningChatProps) {
  const planKey = planningChatKey(workspaceId, planId);
  const selectedId = usePlanningChatStore(state => state.activeByPlan[planKey]);
  const [conversations, setConversations] = useState<PlanningConversation[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [adding, setAdding] = useState(false); const [pending, setPending] = useState(false);
  const [closing, setClosing] = useState<PlanningConversation>(); const [renaming, setRenaming] = useState<PlanningConversation>(); const [title, setTitle] = useState('');
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const alive = useRef(true); const busy = useRef(false); const latestRequest = useRef(0);
  const base = `/planning/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planId)}/chat/conversations`;
  const open = conversations.filter(item => !item.closedAt);
  const openIds = open.map(item => item.id).join(',');
  const closed = conversations.filter(item => item.closedAt);
  const selected = open.find(item => item.id === selectedId) || open[0];
  const refresh = useCallback(async () => {
    const generation = ++latestRequest.current;
    try { const result = await apiRequest<PlanningConversation[]>(base, { cache: 'no-store' }); if (alive.current && generation === latestRequest.current) { setConversations(result); setLoading(false); setError(''); } }
    catch (cause) { if (alive.current && generation === latestRequest.current) { setError(errorText(cause)); setLoading(false); } }
  }, [base]);
  useEffect(() => { alive.current = true; void refresh(); const tick = () => { if (document.visibilityState === 'visible') void refresh(); }; const timer = setInterval(tick, 8_000); window.addEventListener('focus', tick); return () => { alive.current = false; latestRequest.current++; clearInterval(timer); window.removeEventListener('focus', tick); }; }, [refresh]);
  useEffect(() => {
    const ids = openIds.split(',').filter(id => id && id !== selected?.id && statuses[id] === 'running');
    if (!ids.length) return;
    let disposed = false; let polling = false; const controller = new AbortController();
    const poll = async () => {
      if (polling || document.visibilityState === 'hidden') return;
      polling = true;
      try { await Promise.all(ids.map(async id => { try { const state = await apiRequest<PlanningChatState>(`${base}/${encodeURIComponent(id)}`, { signal: controller.signal, cache: 'no-store' }); if (!disposed) setStatuses(previous => previous[id] === state.status ? previous : { ...previous, [id]: state.status }); } catch { /* Preserve the last observed state until the runtime reconnects. */ } })); }
      finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 1_500);
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, [base, openIds, selected?.id, statuses]);
  useEffect(() => { if (selected && selected.id !== selectedId) usePlanningChatStore.getState().select(planKey, selected.id); }, [selected, selectedId, planKey]);
  useEffect(() => { if (selected && selected.id !== 'default') usePlanningChatStore.getState().update(planKey, { catalogId: selected.catalogId, reasoning: selected.reasoning || '' }); }, [selected?.id, selected?.catalogId, selected?.reasoning, planKey]);
  const merge = useCallback((conversation: PlanningConversation) => { latestRequest.current++; setConversations(items => [...items.filter(item => item.id !== conversation.id), conversation].sort((a, b) => a.createdAt.localeCompare(b.createdAt))); }, []);
  const create = async (model: DiscoveredModel, reasoning?: string) => {
    const fingerprint = JSON.stringify([workspaceId, planId, model.catalogId, reasoning]);
    const id = usePlanningChatStore.getState().prepareCreation(fingerprint);
    const conversation = await apiRequest<PlanningConversation>(base, { method: 'POST', body: JSON.stringify({ id, catalogId: model.catalogId, ...(reasoning ? { reasoning } : {}), title: `${planningCliName(model.runtimeType)} chat` }) });
    if (!alive.current) return;
    const initial = usePlanningChatStore.getState().plans[planKey];
    if (!selected && initial?.draft) usePlanningChatStore.getState().update(planningChatKey(workspaceId, planId, conversation.id), { draft: initial.draft, editContext: initial.editContext });
    merge(conversation); usePlanningChatStore.getState().select(planKey, conversation.id); usePlanningChatStore.getState().acknowledgeCreation(fingerprint, id); setAdding(false);
  };
  const patch = async (conversation: PlanningConversation, values: Record<string, unknown>) => {
    const result = await apiRequest<PlanningConversation>(`${base}/${encodeURIComponent(conversation.id)}`, { method: 'PATCH', body: JSON.stringify(values) });
    if (alive.current) merge(result);
    return result;
  };
  const close = async (conversation: PlanningConversation, stopFirst = false) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError('');
    try {
      if (stopFirst) await apiRequest(`${base}/${encodeURIComponent(conversation.id)}/stop`, { method: 'POST', body: '{}' });
      await patch(conversation, { closed: true }); if (alive.current) setClosing(undefined);
    } catch (cause) { if (alive.current) { if (cause instanceof ApiError && cause.status === 409) setClosing(conversation); else setError(errorText(cause)); } }
    finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const onState = useCallback((id: string, status: string) => setStatuses(previous => previous[id] === status ? previous : { ...previous, [id]: status }), []);
  return <aside aria-label="Planning assistant" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl bg-background text-foreground">
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 px-4">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles className="h-3.5 w-3.5" /></span><h2 className="min-w-0 flex-1 truncate text-xs font-semibold">Plan assistant</h2><span className="text-[10px] tabular-nums text-muted-foreground">{open.length ? `${open.length} chat${open.length === 1 ? '' : 's'}` : 'Your CLI, your context'}</span>
      {conversations.length > 0 && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Chat actions"><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">{selected && <DropdownMenuItem onSelect={() => { setRenaming(selected); setTitle(selected.title); }}>Rename chat</DropdownMenuItem>}{closed.length > 0 && <><DropdownMenuSeparator /><DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Closed chats · history is kept</DropdownMenuLabel>{closed.map(item => <DropdownMenuItem key={item.id} onSelect={() => { void patch(item, { closed: false }).then(() => usePlanningChatStore.getState().select(planKey, item.id)).catch(cause => setError(errorText(cause))); }}><History className="h-3.5 w-3.5" /><span className="truncate">{item.title}</span></DropdownMenuItem>)}</>}</DropdownMenuContent></DropdownMenu>}
      {onExpand && <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={expanded ? 'Collapse assistant' : 'Expand assistant'} onClick={onExpand}>{expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</Button>}
      {onClose && <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close assistant" onClick={onClose}><X className="h-3.5 w-3.5" /></Button>}
    </header>
    {(open.length > 0 || closed.length > 0) && (
      <div className="flex shrink-0 items-end gap-1 border-b border-border bg-muted/35 px-2 pt-2">
        <div role="tablist" aria-label="Planning chats" className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          {open.map((conversation, index) => (
            <div
              key={conversation.id}
              className={`group relative flex min-w-24 max-w-44 shrink-0 items-center rounded-t-xl border border-b-0 ${
                selected?.id === conversation.id
                  ? 'border-border bg-background text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-muted/70'
              }`}
            >
              <button
                type="button"
                role="tab"
                id={`planning-tab-${conversation.id}`}
                aria-selected={selected?.id === conversation.id}
                aria-controls={`planning-chat-${conversation.id}`}
                tabIndex={selected?.id === conversation.id ? 0 : -1}
                title={`${conversation.title} · ${planningCliName(conversation.runtimeType)} · Double click to rename`}
                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-tl-xl pl-3 pr-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => usePlanningChatStore.getState().select(planKey, conversation.id)}
                onDoubleClick={() => {
                  setRenaming(conversation);
                  setTitle(conversation.title);
                }}
                onKeyDown={event => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    const nextIndex =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                        ? open.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + open.length) % open.length;
                    usePlanningChatStore.getState().select(planKey, open[nextIndex].id);
                    document.getElementById(`planning-tab-${open[nextIndex].id}`)?.focus();
                  }
                }}
              >
                <RuntimeBrandIcon runtimeId={conversation.runtimeType} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{conversation.title}</span>
                {statuses[conversation.id] === 'running' && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />}
              </button>
              <button
                type="button"
                aria-label={`Close ${conversation.title}`}
                disabled={pending}
                title="Close tab · history is kept"
                className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-60 transition-opacity hover:bg-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void close(conversation)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {!open.length && (
            <span className="pb-2 text-xs text-muted-foreground">All chats closed. Reopen below or add a new chat.</span>
          )}
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="mb-0.5 h-8 w-8 shrink-0 rounded-lg"
          aria-label="New planning chat"
          title="New chat · choose a CLI"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-4 w-4" />
        </Button>
        {closed.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mb-0.5 h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                aria-label="Reopen closed chat"
                title="Reopen closed chat"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Closed ({closed.length})</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Reopen closed chat</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {closed.map(item => (
                <DropdownMenuItem
                  key={item.id}
                  className="flex items-center justify-between gap-2"
                  onSelect={() => {
                    void patch(item, { closed: false })
                      .then(() => usePlanningChatStore.getState().select(planKey, item.id))
                      .catch(cause => setError(errorText(cause)));
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <RuntimeBrandIcon runtimeId={item.runtimeType} className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{item.title}</span>
                  </div>
                  <RotateCcw className="h-3 w-3 shrink-0 opacity-70" />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    )}
    {error && (
      <div role="alert" className="flex shrink-0 items-start justify-between gap-2 border-b border-border bg-destructive/5 px-4 py-2 text-xs leading-5 text-destructive">
        <span>{error}</span>
        <button type="button" aria-label="Retry loading chats" onClick={() => void refresh()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
    )}
    {loading ? (
      <div role="status" className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />Loading your chats…
      </div>
    ) : selected ? (
      <PlanningChatSession
        key={planningChatKey(workspaceId, planId, selected.id)}
        workspaceId={workspaceId}
        planId={planId}
        conversation={selected}
        conversations={open}
        onDocumentChange={onDocumentChange}
        onPatch={values => patch(selected, values)}
        onIndependent={create}
        onState={onState}
      />
    ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        {closed.length > 0 && (
          <div className="mb-6 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Closed chats</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {closed.length} closed conversation{closed.length === 1 ? '' : 's'} preserved. Reopen anytime to continue.
                </p>
              </div>
            </div>
            <div className="mt-3 divide-y divide-border/60">
              {closed.map(item => (
                <div key={item.id} className="flex items-center justify-between py-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <RuntimeBrandIcon runtimeId={item.runtimeType} className="h-4 w-4 shrink-0" />
                    <span className="truncate font-medium">{item.title}</span>
                    <span className="text-[10px] text-muted-foreground">({planningCliName(item.runtimeType)})</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 px-2.5 text-xs"
                    onClick={() => {
                      void patch(item, { closed: false })
                        .then(() => usePlanningChatStore.getState().select(planKey, item.id))
                        .catch(cause => setError(errorText(cause)));
                    }}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reopen
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mb-6">
          <h3 className="text-base font-semibold tracking-tight">Start with your preferred CLI.</h3>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">Each chat keeps its own conversation and model. Your plan and research stay alongside it.</p>
        </div>
        <PlanningCliSetup onCreate={create} />
      </div>
    )}
    <Dialog open={adding} onOpenChange={setAdding}><DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg"><DialogHeader><DialogTitle>New planning chat</DialogTitle><DialogDescription>Choose a CLI and model, just like Manual. This chat starts with its own history.</DialogDescription></DialogHeader><div className="min-h-0 overflow-y-auto"><PlanningCliSetup onCreate={create} onCancel={() => setAdding(false)} initialRuntime={selected?.runtimeType} /></div></DialogContent></Dialog>
    <Dialog open={Boolean(closing)} onOpenChange={value => { if (!value && !pending) setClosing(undefined); }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Stop and close this chat?</DialogTitle><DialogDescription>{closing?.title} is still working. Stopping keeps its conversation and any completed document updates.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={pending} onClick={() => setClosing(undefined)}>Keep working</Button><Button disabled={pending} onClick={() => closing && void close(closing, true)}>{pending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Stop and close</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(renaming)} onOpenChange={value => { if (!value && !pending) setRenaming(undefined); }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Rename chat</DialogTitle><DialogDescription>Keep this conversation easy to find.</DialogDescription></DialogHeader><form onSubmit={event => { event.preventDefault(); if (!renaming || !title.trim() || busy.current) return; busy.current = true; setPending(true); void patch(renaming, { title: title.trim() }).then(() => setRenaming(undefined)).catch(cause => setError(errorText(cause))).finally(() => { busy.current = false; setPending(false); }); }}><Input aria-label="Chat name" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} autoFocus /><DialogFooter className="mt-4"><Button type="submit" disabled={pending || !title.trim()}>Save name</Button></DialogFooter></form></DialogContent></Dialog>
  </aside>;
}

interface PlanningChatSessionProps extends Pick<PlanningChatProps, 'workspaceId' | 'planId' | 'onDocumentChange'> {
  conversation: PlanningConversation; conversations: PlanningConversation[];
  onPatch: (patch: Record<string, unknown>) => Promise<PlanningConversation>;
  onIndependent: (model: DiscoveredModel, reasoning?: string) => Promise<void>;
  onState: (id: string, status: string) => void;
}
function PlanningChatSession({ workspaceId, planId, onDocumentChange, conversation, conversations, onPatch, onIndependent, onState }: PlanningChatSessionProps) {
  const key = planningChatKey(workspaceId, planId, conversation.id);
  const preferences = usePlanningChatStore(state => state.plans[key] || EMPTY_PLANNING_CHAT);
  const update = usePlanningChatStore(state => state.update);
  const models = useAccountStore(state => state.discoveredModels);
  const availableModels = models.filter(model => model.available && model.availability === 'available'
    && model.source !== 'cached' && ['codex', 'claude_code', 'opencode', 'antigravity'].includes(model.runtimeType));
  const model = availableModels.find(item => item.catalogId === conversation.catalogId);
  const reasoning = conversation.reasoning;
  const files = usePlanningChatStore(state => state.files[key] || EMPTY_FILES);
  const [chat, setChat] = useState<PlanningChatState>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review>();
  const [attachmentPreview, setAttachmentPreview] = useState<string>();
  const [following, setFollowing] = useState(true);
  const root = useRef<HTMLElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const actionBusy = useRef(false);
  const reviewLoad = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const latest = useRef<PlanningChatState | undefined>(undefined);
  const onChange = useRef(onDocumentChange);
  onChange.current = onDocumentChange;
  const base = `/planning/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planId)}/chat/conversations/${encodeURIComponent(conversation.id)}`;
  const running = chat?.status === 'running';
  const canSend = Boolean(chat && model && (preferences.draft.trim() || files.length) && !running && !busy);

  useEffect(() => {
    update(key, { catalogId: conversation.catalogId, reasoning: conversation.reasoning || '' });
  }, [key, conversation.catalogId, conversation.reasoning, update]);
  useEffect(() => { if (chat) onState(conversation.id, chat.status); }, [chat?.status, conversation.id, onState]);

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
    const store = usePlanningChatStore.getState();
    for (const input of store.plans[key]?.attempts || []) {
      if (!state.messages.some(message => message.clientMessageId === input.id)) continue;
      const sentFiles = (store.staged[key] || []).filter(item => input.attachmentPaths?.includes(item.path)).map(item => item.file);
      store.acknowledge(key, input); store.clearSentFiles(key, sentFiles);
    }
    if (previous) {
      for (const proposal of state.proposals) {
        if (proposal.status === 'applied' && !previous.proposals.some(item => item.id === proposal.id && item.revision === proposal.revision && item.status === 'applied')) {
          onChange.current(proposal.path);
        }
      }
    }
  }, [key]);

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
   const send = async (retry?: PlanningChatMessage) => {
    if ((!retry && !canSend) || !chat || running || !model || actionBusy.current) return;
    actionBusy.current = true; setBusy(true); setActionError(undefined);
    const sentFiles = retry ? [] : [...files];
    const text = retry?.content || preferences.draft.trim() || 'Review the attached files in the context of this plan.';
    try {
      const store = usePlanningChatStore.getState();
      const recovered = !sentFiles.length ? store.plans[key]?.attempts.find(item => item.text === text && item.catalogId === model.catalogId && item.reasoning === reasoning && (!retry || JSON.stringify(item.attachmentPaths || []) === JSON.stringify(retry.attachmentPaths || []))) : undefined;
      const paths: string[] = retry?.attachmentPaths ? [...retry.attachmentPaths] : [];
      if (!recovered) for (const file of sentFiles) {
        let path = usePlanningChatStore.getState().staged[key]?.find(item => item.file === file)?.path;
        if (!path) {
          const headers = runtimeHeaders({ 'Content-Type': 'application/octet-stream' });
          const token = getAuthToken(); if (token) headers.set('Authorization', `Bearer ${token}`);
          const response = await fetch(`${getApiBaseUrl()}/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planId)}/assets?filename=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(fileMime(file))}`, { method: 'POST', headers, body: file });
          const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not attach file.');
          path = result.path; if (!path) throw new Error('The attachment did not return a saved path.');
          usePlanningChatStore.getState().stageFile(key, file, path);
        }
        paths.push(path);
      }
      const input: PlanningChatInput = recovered || usePlanningChatStore.getState().prepare(key, text, model.catalogId, reasoning, paths);
      const state = await request<PlanningChatState>(`${base}/messages`, input);
      // This is deliberately keyed even if the user switched plans during send.
      usePlanningChatStore.getState().acknowledge(key, input);
      usePlanningChatStore.getState().clearSentFiles(key, sentFiles);
      if (alive.current) { accept(state); setFollowing(true); }
    } catch (error) {
      if (alive.current) setActionError(`${errorText(error)} Your draft is kept. Retry with the same text and model to safely check this send.`);
    } finally { actionBusy.current = false; if (alive.current) setBusy(false); }
  };

  const applyModel = async (next: DiscoveredModel, independent: boolean, level?: string): Promise<boolean> => {
    setActionError(undefined);
    try {
      if (independent) await onIndependent(next, level);
      else await onPatch({ catalogId: next.catalogId, ...(level ? { reasoning: level } : {}) });
      return true;
    } catch (cause) { if (alive.current) setActionError(errorText(cause)); return false; }
  };
  const applyPermissions = async (mode: CodexPermissionMode, _now: boolean, confirmed: boolean) => {
    await onPatch({ codexPermissionMode: mode, ...(mode === 'full-access' ? { fullAccessConfirmed: confirmed } : {}) });
    return true;
  };
  const replyApproval = async (id: string, turnId: string, decision: 'allow' | 'deny') => {
    if (actionBusy.current) return;
    actionBusy.current = true; setBusy(true); setActionError(undefined);
    try { accept(await request<PlanningChatState>(`${base}/approvals/${encodeURIComponent(id)}/reply`, { decision, turnId })); }
    catch (cause) { if (alive.current) setActionError(errorText(cause)); }
    finally { actionBusy.current = false; if (alive.current) setBusy(false); }
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
        if (proposal.path === 'board.json') {
          const version = await request<{ board: unknown; revision: string } | null>(`/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planId)}/board`);
          document = { content: version ? JSON.stringify(version.board, null, 2) : '', revision: version?.revision ?? null };
        } else document = await request<{ content: string; revision: string }>(`/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planId)}/document?path=${encodeURIComponent(proposal.path)}`);
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

  const controlAgent = { ...conversation, name: planningCliName(conversation.runtimeType) };
  const failed = chat?.status === 'failed' || chat?.status === 'interrupted';
  const retryMessage = failed ? [...(chat?.messages || [])].reverse().find(message => message.role === 'user' && message.turnId === chat?.turnId) : undefined;
  return <section ref={root} role="tabpanel" id={`planning-chat-${conversation.id}`} aria-labelledby={`planning-tab-${conversation.id}`} className="flex min-h-0 w-full min-w-0 flex-1 flex-col bg-background text-foreground">
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 text-[11px]"><span className="flex min-w-0 items-center gap-2 text-muted-foreground"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse bg-primary' : failed ? 'bg-amber-500' : chat ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} /><span className="truncate">{planningCliName(conversation.runtimeType)} · Independent context</span></span>{running ? <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[10px]" disabled={busy} aria-label="Stop response" onClick={() => void stop()}><Square className="mr-1 h-2.5 w-2.5" />Interrupt</Button> : <span className="shrink-0 text-[10px] text-muted-foreground">Plan + board</span>}</div>
    <div ref={timeline} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain" onScroll={event => {
      const element = event.currentTarget; setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 64);
    }}>
      <div ref={content} className="mx-auto w-full max-w-4xl space-y-6 px-4 py-5">
        {!chat && !loadError && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />Loading conversation…</p>}
        {chat?.messages.length === 0 && <div className="py-5">
          <h3 className="text-sm font-medium">Think it through together</h3>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Explore the project, clarify decisions, and refine this plan. Plan and research documents are included as context.</p>
           <div className="mt-4 flex flex-col items-start gap-2">{suggestions.map(suggestion => <button key={suggestion} type="button" onClick={() => { update(key, { draft: suggestion }); root.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); }} className="max-w-full rounded-lg border border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{suggestion}</button>)}</div>
        </div>}
        {chat?.messages.map(message => {
          const text = message.role === 'assistant' ? planningChatDisplayText(message.content) : message.content;
          const proposals = chat.proposals.filter(proposal => proposal.turnId === message.turnId);
          return <article key={message.id} className="min-w-0 space-y-2">
            <p className="text-[11px] font-medium text-muted-foreground">{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'Activity'}{message.partial && running && message.turnId === chat.turnId ? ' · Writing' : ''}</p>
            {text && (message.role === 'assistant' ? <div className="min-w-0 text-sm leading-relaxed [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
              <MarkdownContent content={text} />
              {extractChatImages(text).length > 0 && <ChatImageGallery images={extractChatImages(text)} workspaceId={workspaceId} planId={planId} />}
            </div> : <p className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${message.role === 'user' ? 'rounded-xl bg-muted/60 px-3 py-2 text-sm leading-relaxed' : 'text-xs leading-relaxed text-muted-foreground'}`}>{text}</p>)}
            {!!message.attachmentPaths?.length && <div aria-label="Sent attachments" className="flex flex-wrap gap-2">{message.attachmentPaths.map(path => <button type="button" key={path} onClick={() => setAttachmentPreview(path)} className="flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><FileText className="h-3 w-3 shrink-0" /><span className="truncate">{path.split('/').pop()}</span></button>)}</div>}
            {message.role === 'assistant' && !text && message.partial && running && <p className="text-xs text-muted-foreground">Preparing document update…</p>}
            {message.role === 'assistant' && proposals.map(proposal => <div key={proposal.id} className="min-w-0 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2"><FileText className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-all text-xs font-medium">{proposal.path}</span>{proposal.status === 'applied' && <Check className="size-3.5 shrink-0 text-primary" />}</div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{proposal.status === 'applied' ? proposal.path === 'board.json' ? 'Board updated' : 'Document updated' : proposal.status === 'conflict' ? 'Changed while the assistant was working. Compare before applying.' : 'Update pending'}</p>
              <div className="mt-2 flex flex-wrap gap-2"><Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onDocumentChange(proposal.path)}>{proposal.path === 'board.json' ? 'Show board' : 'Show in document'}</Button>{proposal.status !== 'applied' && <Button variant="outline" size="sm" className="h-7 px-2" disabled={running || busy} onClick={() => void loadReview(proposal)}>Review update</Button>}</div>
            </div>)}
          </article>;
        })}
      </div>
    </div>
    <div className="shrink-0 border-t border-border/70 px-4 pt-2">
      <div className="mx-auto w-full max-w-4xl">
        {!following && <Button variant="ghost" size="sm" className="mb-2 w-full" onClick={() => setFollowing(true)}><ArrowDown />Latest messages</Button>}
        <div role="status" className="mb-2 flex min-h-4 items-center gap-2 text-[11px] text-muted-foreground">{running ? <><Loader2 className="size-3 shrink-0 animate-spin" /><span className="min-w-0 break-words">{chat?.activity || 'Working on your plan'}</span></> : chat?.status === 'cancelled' ? 'Stopped · partial response kept' : chat?.status === 'complete' ? 'Ready for your next thought' : failed ? 'Response stopped · partial reply kept' : 'Plan, board and research in context'}</div>
        {retryMessage && <div className="mb-2 flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy || !model || Boolean(loadError)} onClick={() => void send(retryMessage)}><RotateCcw className="mr-1.5 size-3" />Retry last message</Button><span className="text-[11px] text-muted-foreground">Uses the current model and saved context.</span></div>}
        {(loadError || actionError || chat?.error) && <div role="alert" className="mb-2 max-h-28 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs leading-relaxed text-destructive [overflow-wrap:anywhere]">{[loadError, actionError, chat?.error].filter(Boolean).join('\n')}</div>}
        {!model && <p className="mb-2 text-xs leading-5 text-muted-foreground">This model is unavailable. Choose another verified model using Model & CLI below.</p>}
        {chat?.approvals?.map(approval => <div key={approval.id} className="mb-3 rounded-xl border border-primary/25 bg-primary/5 p-3"><p className="text-xs font-semibold">OpenCode needs your approval</p><p className="mt-2 break-words text-xs leading-5 text-muted-foreground">{approval.description}</p>{approval.command && <pre className="mt-2 overflow-auto rounded-lg bg-background p-2 text-[11px]">{approval.command}</pre>}{approval.error && <p role="alert" className="mt-2 text-xs text-destructive">{approval.error}</p>}<div className="mt-3 flex gap-2"><Button size="sm" variant="outline" disabled={busy || approval.status === 'replying'} onClick={() => void replyApproval(approval.id, approval.turnId, 'deny')}>Deny</Button><Button size="sm" disabled={busy || approval.status === 'replying'} onClick={() => void replyApproval(approval.id, approval.turnId, 'allow')}>Allow once</Button></div></div>)}
        <ManualComposer key={conversation.id} surface="planning" agent={controlAgent} agents={conversations} native live={Boolean(chat) && !loadError} pending={busy} sendDisabled={running || !model} draft={preferences.draft} files={files} onDraft={value => update(key, { draft: value })} onAddFiles={incoming => { try { usePlanningChatStore.getState().updateFiles(key, current => addManualFiles(current, incoming)); setActionError(undefined); } catch (cause) { setActionError(errorText(cause)); } }} onRemoveFile={file => usePlanningChatStore.getState().updateFiles(key, current => current.filter(item => item !== file))} onSend={() => void send()} onApply={applyModel} autoApprove={conversation.runtimeType === 'opencode' ? { available: Boolean(chat), enabled: conversation.openCodeAutoApprove } : undefined} onAutoApprove={async enabled => { await onPatch({ openCodeAutoApprove: enabled }); }} permissionControl={conversation.runtimeType === 'codex' ? <CodexPermissions agent={controlAgent} live={false} disabled={busy} onApply={applyPermissions} /> : undefined} statusText={running ? 'Working · settings apply next reply' : busy ? 'Saving…' : 'Ready · @ for integrations'} />
      </div>
    </div>
    <Dialog open={!!review} onOpenChange={open => { if (!open && !busy) setReview(undefined); }}>
      <DialogContent className="min-w-0 sm:max-w-3xl">
        <DialogHeader><DialogTitle>Review document update</DialogTitle><DialogDescription className="break-all">{review?.proposal.path} · Compare the latest saved document with the proposed replacement. Unsaved editor drafts stay in the editor.</DialogDescription></DialogHeader>
        {review?.error && <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">{review.error}</p>}
        {review?.document ? <div className="grid min-w-0 gap-3 sm:grid-cols-2">{[{ title: review.document.revision === null ? 'Latest document · not created' : 'Latest saved document', text: review.document.content }, { title: 'Proposed replacement', text: review.proposal.content }].map(item => <section key={item.title} className="min-w-0"><h3 className="mb-2 text-xs font-medium">{item.title}</h3><pre tabIndex={0} className="max-h-[45vh] min-h-24 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed [overflow-wrap:anywhere]">{item.text || '(empty document)'}</pre></section>)}</div> : !review?.error && <p role="status" className="text-sm text-muted-foreground">Loading the latest document…</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setReview(undefined)}>Cancel</Button>{review?.error && <Button variant="secondary" disabled={busy} onClick={() => void loadReview(review.proposal)}><RefreshCw />Reload comparison</Button>}<Button disabled={!review?.document || busy || running} onClick={() => void apply()}>{busy && <Loader2 className="animate-spin" />}Apply replacement</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(attachmentPreview)} onOpenChange={open => { if (!open) setAttachmentPreview(undefined); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle className="break-all text-sm">{attachmentPreview?.split('/').pop()}</DialogTitle><DialogDescription>Saved with this plan.</DialogDescription></DialogHeader>{attachmentPreview && <PlanningMedia workspaceId={workspaceId} planId={planId} path={attachmentPreview} />}</DialogContent></Dialog>
  </section>;
}

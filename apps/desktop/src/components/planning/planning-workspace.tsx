import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Archive, ArrowLeft, ArrowRight, BookOpen, ChevronDown, FileImage, FilePlus2, FileText, Film, LayoutGrid, List, Loader2, MessageSquare, MoreHorizontal, PanelRightOpen, Pin, Plus, Search, TerminalSquare, Upload, Workflow, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { apiRequest, getApiBaseUrl, runtimeHeaders } from '@/lib/api-client';
import { getAuthToken } from '@/lib/token-provider';
import { isTauriRuntime } from '@/lib/secure-storage';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useManualStore, type ManualAgent, type ManualConversation } from '@/stores/manual-store';
import { useMissionStore } from '@/stores/mission-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useAccountStore } from '@/stores/account-store';
import { useBrowserStore } from '@/stores/browser-store';
import { useOrchestratorPreferencesStore } from '@/stores/orchestrator-preferences-store';
import { planningChatKey, usePlanningChatStore } from '@/stores/planning-chat-store';
import { documentKey, planApi, usePlanningStore, type DocumentVersion, type PlanningFile, type PlanningSource } from '@/stores/planning-store';
import { PlanningDocumentEditor } from './planning-document';
import { PlanningBoardView } from './planning-board';
import { PlanningChat } from './planning-chat';
import { PlanningMedia } from './planning-media';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const fileSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const dateLabel = (date: string) => new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const selectClass = 'h-9 min-w-0 w-full rounded-lg border border-input bg-background px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring';
const mimeFor = (file: File) => ({ md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf' }[file.name.split('.').pop()?.toLowerCase() || ''] || file.type);

export function PlanningWorkspace() {
  const workspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const planId = usePlanningStore(state => workspaceId ? state.activeByWorkspace[workspaceId] : null);
  if (!workspaceId) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Open a project to start planning.</div>;
  return <PlanningWorkspaceContent key={`${workspaceId}:${planId || 'library'}`} workspaceId={workspaceId} />;
}

function PlanningWorkspaceContent({ workspaceId }: { workspaceId: string }) {
  const store = usePlanningStore();
  const workspace = useWorkspaceStore(state => state.workspaces.find(item => item.id === workspaceId));
  const plans = store.plans[workspaceId] || [];
  const planId = store.activeByWorkspace[workspaceId] || null;
  const plan = plans.find(item => item.id === planId);
  const [query, setQuery] = useState(''); const [showArchive, setShowArchive] = useState(false); const [listView, setListView] = useState(false);
  const [view, setView] = useState<'board' | 'document'>('board');
  const [filesOpen, setFilesOpen] = useState(false);
  const [documentPath, setDocumentPath] = useState('plan.md'); const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [files, setFiles] = useState<PlanningFile[]>([]); const [refreshKey, setRefreshKey] = useState(0);
  const [saveStatus, setSaveStatus] = useState('Saved locally'); const [boardStatus, setBoardStatus] = useState('Loading board...'); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false); const [title, setTitle] = useState(''); const [dialog, setDialog] = useState<'note' | 'rename' | null>(null);
  const [execution, setExecution] = useState(false); const [target, setTarget] = useState<'manual' | 'orchestrator'>('manual');
  const [model, setModel] = useState(''); const [reasoning, setReasoning] = useState('');
  const [chatExpanded, setChatExpanded] = useState(false); const [availableWidth, setAvailableWidth] = useState(1200);
  const host = useRef<HTMLDivElement>(null); const importInput = useRef<HTMLInputElement>(null); const uploadInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null); const actionBusy = useRef(false);
  const selection = useRef(planId); selection.current = planId;
  const models = useAccountStore(state => state.discoveredModels);
  const availableModels = models.filter(item => item.available && ['claude_code', 'codex', 'opencode', 'antigravity'].includes(item.runtimeType));
  const chosenModel = availableModels.find(item => item.catalogId === model) || availableModels[0];
  const browserOpen = useBrowserStore(state => Boolean(state.url));
  const width = store.widths[workspaceId] || 440;
  const narrow = availableWidth < 846;
  const showChat = !store.chatHidden[workspaceId] && !(browserOpen && narrow);
  const overlayChat = narrow || chatExpanded;
  const maximumChatWidth = Math.max(320, Math.min(640, Math.floor(availableWidth - 466)));
  const effectiveChatWidth = Math.min(width, maximumChatWidth);
  const resizeChat = (value: number) => store.setWidth(workspaceId, Math.min(maximumChatWidth, Math.max(320, value)));
  useEffect(() => { void usePlanningStore.getState().refresh(workspaceId); }, [workspaceId]);
  useEffect(() => { if (store.creating) setTitle(''); }, [store.creating]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(entries => setAvailableWidth(entries[0].contentRect.width)); observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setDocumentPath('plan.md'); setSelectedAsset(null); setView('board'); setFilesOpen(false); setError(''); setNotice(''); setChatExpanded(false); }, [planId]);
  useEffect(() => { if (view === 'board') setSaveStatus(boardStatus); }, [boardStatus, view]);
  const refreshFiles = useCallback(async () => {
    if (!planId) return;
    try { const next = await apiRequest<PlanningFile[]>(`${planApi(workspaceId, planId)}/files`); if (selection.current === planId) setFiles(next); }
    catch (cause) { if (selection.current === planId) setError(message(cause)); }
  }, [workspaceId, planId]);
  useEffect(() => {
    setFiles([]); void refreshFiles();
    const tick = () => { if (document.visibilityState === 'visible') { void refreshFiles(); void usePlanningStore.getState().refresh(workspaceId); } };
    const timer = setInterval(tick, 10_000); window.addEventListener('focus', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); };
  }, [refreshFiles, workspaceId]);
  const action = async (work: () => Promise<void>) => {
    if (actionBusy.current) return;
    actionBusy.current = true; setPending(true); setError('');
    try { await work(); } catch (cause) { setError(message(cause)); } finally { actionBusy.current = false; setPending(false); }
  };
  const openDocument = useCallback((path: string) => { setDocumentPath(path); setSelectedAsset(null); setView('document'); setRefreshKey(value => value + 1); void refreshFiles(); }, [refreshFiles]);
  const openPlan = (id: string | null) => store.select(workspaceId, id);
  const create = () => { setTitle(''); store.setCreating(true); };
  const submitTitle = () => void action(async () => {
    if (store.creating) await store.create(workspaceId, title.trim());
    else if (dialog === 'rename' && planId) { await store.update(workspaceId, planId, { title: title.trim() }); setDialog(null); }
    else if (dialog === 'note' && planId) {
      const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'note';
      const path = `research/${slug}-${crypto.randomUUID().slice(0, 8)}.md`;
      await apiRequest(`${planApi(workspaceId, planId)}/document?path=${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify({ content: `# ${title.trim()}\n\n`, expectedRevision: null }) });
      setDialog(null); openDocument(path);
    }
  });
  const importPlan = (file?: File) => file && void action(async () => {
    if (file.size > 4 * 1024 * 1024) throw new Error('Markdown files must be 4 MB or smaller.');
    await store.create(workspaceId, file.name.replace(/\.md$/i, '').replace(/[-_]/g, ' '), await file.text());
    setNotice('Markdown imported. Add any referenced media from the Files tab.');
  });
  const importFiles = (incoming: File[]) => planId && void action(async () => {
    for (const file of incoming) {
      if (file.size > 512 * 1024 * 1024) throw new Error(`${file.name} exceeds 512 MB.`);
      if (/\.md$/i.test(file.name)) {
        if (file.size > 4 * 1024 * 1024) throw new Error('Markdown files must be 4 MB or smaller.');
        await apiRequest(`${planApi(workspaceId, planId)}/import`, { method: 'POST', body: JSON.stringify({ filename: file.name, content: await file.text() }) });
      } else {
        const headers = runtimeHeaders({ 'Content-Type': 'application/octet-stream' });
        const token = getAuthToken(); if (token) headers.set('Authorization', `Bearer ${token}`);
        const response = await fetch(`${getApiBaseUrl()}${planApi(workspaceId, planId)}/assets?filename=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(mimeFor(file))}`, { method: 'POST', headers, body: file });
        if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || `Import failed (${response.status}).`); }
      }
    }
    await refreshFiles(); setFilesOpen(true); setNotice(`${incoming.length} file${incoming.length === 1 ? '' : 's'} saved in this plan.`);
  });
  const insertAsset = (file: PlanningFile) => void action(async () => {
    if (!planId) return;
    const latest = await apiRequest<DocumentVersion>(`${planApi(workspaceId, planId)}/document?path=plan.md`);
    const key = documentKey(workspaceId, planId, 'plan.md'); const draft = usePlanningStore.getState().drafts[key];
    const label = file.path.split('/').pop()!; const link = `${file.mimeType.startsWith('image/') ? '!' : ''}[${label}](${file.path.split('/').map(encodeURIComponent).join('/')})`;
    store.setDraft(key, { content: `${draft?.content ?? latest.content}\n\n${link}\n`, baseContent: draft?.baseContent ?? latest.content, baseRevision: draft?.baseRevision ?? latest.revision }); openDocument('plan.md');
  });
  const saveAll = async () => {
    if (!planId) return;
    const drafts = Object.entries(usePlanningStore.getState().drafts).filter(([key]) => { const ids = JSON.parse(key); return ids[0] === workspaceId && ids[1] === planId; });
    for (const [key, draft] of drafts) {
      const path = JSON.parse(key)[2];
      const endpoint = `${planApi(workspaceId, planId)}/document?path=${encodeURIComponent(path)}`;
      const disk = await apiRequest<DocumentVersion>(endpoint);
      if (disk.content !== draft.content) await apiRequest(endpoint, { method: 'PUT', body: JSON.stringify({ content: draft.content, expectedRevision: draft.baseRevision }) });
      store.clearDraft(key, draft.content);
    }
  };
  const beginExecution = () => {
    if (boardStatus !== 'Saved locally' && boardStatus !== 'No board yet') { setError('Wait for the board to save or resolve its save error before starting work.'); return; }
    const selected = planId ? usePlanningChatStore.getState().plans[planningChatKey(workspaceId, planId)] : undefined;
    setModel(selected?.catalogId || ''); setReasoning(selected?.reasoning || ''); setExecution(true);
  };
  const handoff = () => void action(async () => {
    if (!planId || !chosenModel) return;
    if (boardStatus !== 'Saved locally' && boardStatus !== 'No board yet') throw new Error('Wait for the board to save or resolve its save error before starting work.');
    await saveAll();
    const prefsStore = useOrchestratorPreferencesStore.getState();
    const preferences = prefsStore.projects[workspaceId] || prefsStore.defaults;
    const options = target === 'orchestrator' ? { teamTemplate: preferences.teamTemplate, trustMode: preferences.trustMode, agentProfileIds: preferences.agentProfileIds,
      automationSettings: preferences.automationSettings, routeScope: preferences.modelScope === 'all' ? 'mission' : 'role',
      ...(preferences.modelScope === 'all' ? {} : { routeRole: 'orchestrator' }), workMode: 'execute', teamLaunch: preferences.teamLaunch } : {};
    const latest = await apiRequest<DocumentVersion>(`${planApi(workspaceId, planId)}/document?path=plan.md`);
    const fingerprint = JSON.stringify([workspaceId, planId, latest.revision, target, chosenModel.catalogId, reasoning, options]);
    const id = store.prepareHandoff(fingerprint);
    const result = await apiRequest<{ source: PlanningSource; conversation?: ManualConversation; agent?: ManualAgent; missionId?: string; prompt: string }>(`${planApi(workspaceId, planId)}/handoff`, { method: 'POST', timeoutMs: 0, body: JSON.stringify({ id, target, catalogId: chosenModel.catalogId, ...(reasoning ? { reasoning } : {}), options }) });
    if (target === 'manual' && result.conversation && result.agent) {
      store.rememberSource('manual', result.conversation.id, result.source);
      await useManualStore.getState().refresh(workspaceId);
      useManualStore.getState().setDraft(result.agent.id, result.prompt);
      useManualStore.getState().select(result.conversation);
      if (isTauriRuntime()) {
        try { const launch = await apiRequest(`/manual/agents/${result.agent.id}/launch`, { method: 'POST' }); await invoke('manual_terminal_start', { request: launch }); useManualStore.getState().setSurface(result.conversation.id, 'code'); }
        catch (cause) { useManualStore.getState().setSurface(result.conversation.id, 'chat'); console.warn('Plan agent is ready; native launch can be retried.', cause); }
      }
    } else if (result.missionId) {
      store.rememberSource('orchestrator', result.missionId, result.source);
      await useMissionStore.getState().fetchMissions(workspaceId);
      useManualStore.getState().setMode('orchestrator'); useMissionStore.getState().setActiveMission(result.missionId);
    }
    store.acknowledgeHandoff(fingerprint, id);
    useSettingsStore.getState().setActiveView('chat'); setExecution(false);
  });
  const openRun = (key: string) => void action(async () => {
    const [kind, id] = key.split(':');
    if (kind === 'manual') { await useManualStore.getState().refresh(workspaceId); const conversation = (useManualStore.getState().conversations[workspaceId] || []).find(item => item.id === id); if (!conversation) throw new Error('The linked Manual conversation is unavailable.'); useManualStore.getState().select(conversation); }
    else { await useMissionStore.getState().fetchMissions(workspaceId); useManualStore.getState().setMode('orchestrator'); useMissionStore.getState().setActiveMission(id); }
    useSettingsStore.getState().setActiveView('chat');
  });
  const visiblePlans = plans.filter(item => Boolean(item.archivedAt) === showArchive && item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const research = files.filter(file => file.path.startsWith('research/') && /\.md$/i.test(file.path));
  const assets = files.filter(file => file.path.startsWith('assets/'));
  const runs = Object.entries(store.sources).filter(([, source]) => source.workspaceId === workspaceId && source.planId === planId);
  return <section ref={host} aria-label="Planning workspace" className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${plan ? 'bg-transparent' : 'bg-background'}`}>
    <input ref={importInput} type="file" accept=".md,text/markdown" className="hidden" aria-label="Import Markdown plan" onChange={event => { importPlan(event.target.files?.[0]); event.target.value = ''; }} />
    <input ref={uploadInput} type="file" multiple className="hidden" aria-label="Import plan files" accept=".md,.png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov,.mp3,.wav,.ogg,.pdf,.txt,.csv,.json" onChange={event => { importFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
    {!plan ? <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-6xl px-6 py-8 lg:px-10 lg:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><BookOpen className="h-4 w-4" />{workspace?.name} / Planning</p><h1 className="mt-3 text-2xl font-semibold tracking-tight">Make room for the next idea.</h1><p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Think it through with AI. Keep the plan, research and references together, then put it to work.</p></div><div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={pending} onClick={() => importInput.current?.click()}><Upload className="mr-2 h-3.5 w-3.5" />Import Markdown</Button><Button size="sm" onClick={create}><Plus className="mr-2 h-4 w-4" />New plan</Button></div></div>
      <div className="mb-5 mt-8 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4"><div className="relative w-full max-w-sm"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a plan…" aria-label="Find a plan" className="h-9 rounded-lg pl-9 text-xs" /></div><div className="flex items-center gap-2"><Button size="sm" variant={showArchive ? 'secondary' : 'ghost'} className="text-xs" aria-pressed={showArchive} onClick={() => setShowArchive(value => !value)}><Archive className="mr-1.5 h-3.5 w-3.5" />Archive</Button><Button size="icon" variant="ghost" className="h-8 w-8" aria-label={listView ? 'Use card view' : 'Use list view'} onClick={() => setListView(value => !value)}>{listView ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}</Button><span className="text-xs tabular-nums text-muted-foreground">{visiblePlans.length} plans</span></div></div>
      {store.loading[workspaceId] && !plans.length ? <p role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading plans…</p> : visiblePlans.length ? <div className={listView ? 'space-y-2' : 'grid gap-4 @min-[600px]:grid-cols-2 @min-[1000px]:grid-cols-3'}>{visiblePlans.map(item => <button key={item.id} onClick={() => openPlan(item.id)} className={`group min-w-0 rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/40 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${listView ? 'flex items-center gap-4 p-4' : 'flex min-h-48 flex-col p-5'}`}><span className={`flex items-center ${listView ? 'gap-3' : 'mb-6 w-full justify-between'}`}><span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted/40"><FileText className="h-4 w-4 text-primary" /></span>{item.pinned && <Pin className="h-3.5 w-3.5 text-muted-foreground" />}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{item.title}</span><span className="mt-2 block text-xs text-muted-foreground">{item.status === 'ready' ? 'Ready to put into action' : 'A work in progress'}</span></span><span className={`flex items-center justify-between gap-3 text-[11px] text-muted-foreground ${listView ? '' : 'mt-6 w-full border-t border-border/60 pt-3'}`}><span className={`rounded-md px-2 py-1 ${item.status === 'ready' ? 'bg-primary/10 text-primary' : 'bg-muted'}`}>{item.status === 'ready' ? 'Ready' : 'Draft'}</span><span>{dateLabel(item.updatedAt)}</span><ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span></button>)}</div> : <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-10 text-center"><span className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary"><BookOpen className="h-6 w-6" /></span><h2 className="text-base font-semibold">{query ? 'No matching plans' : showArchive ? 'No archived plans' : 'Start with an idea, leave with a plan.'}</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{query ? 'Try a different title or clear your search.' : showArchive ? 'Archived plans stay available here.' : 'A focused document, your own AI conversation, and all the context you need in one place.'}</p>{!query && !showArchive && <Button className="mt-5" size="sm" onClick={create}><Plus className="mr-2 h-4 w-4" />Create your first plan</Button>}</div>}
    </div></div> : <div className="planning-workspace-layout relative flex min-h-0 min-w-0 flex-1 gap-3">
      <section aria-label="Plan document panel" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3"><div className="flex min-w-0 flex-1 items-center gap-2"><Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="All plans" onClick={() => openPlan(null)}><ArrowLeft className="h-4 w-4" /></Button><div className="min-w-0"><button className="block max-w-full truncate text-left text-sm font-semibold hover:text-primary" title="Rename plan" onClick={() => { setTitle(plan.title); setDialog('rename'); }}>{plan.title}</button><span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground"><span className={`h-1.5 w-1.5 rounded-full ${saveStatus === 'Saved locally' ? 'bg-emerald-500' : 'bg-amber-500'}`} />{saveStatus}</span></div></div><div className="flex shrink-0 items-center gap-2"><select aria-label="Plan status" value={plan.status} className="h-8 rounded-lg border border-border bg-background px-2 text-xs" onChange={event => void action(() => store.update(workspaceId, plan.id, { status: event.target.value as 'draft' | 'ready' }))}><option value="draft">Draft</option><option value="ready">Ready</option></select><Button size="icon" variant="ghost" aria-label={showChat ? 'Hide plan assistant' : 'Show plan assistant'} className="h-8 w-8" onClick={() => store.setChatHidden(workspaceId, showChat)}><PanelRightOpen className="h-4 w-4" /></Button><DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label="Plan actions" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => { setTitle(plan.title); setDialog('rename'); }}>Rename plan</DropdownMenuItem><DropdownMenuItem onSelect={() => void action(() => store.update(workspaceId, plan.id, { pinned: !plan.pinned }))}><Pin className="h-4 w-4" />{plan.pinned ? 'Unpin' : 'Pin'} plan</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void action(async () => { await store.update(workspaceId, plan.id, { archivedAt: plan.archivedAt ? null : new Date().toISOString() }); openPlan(null); })}><Archive className="h-4 w-4" />{plan.archivedAt ? 'Restore plan' : 'Archive plan'}</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Button size="sm" className="h-8 rounded-lg text-xs" disabled={pending} onClick={beginExecution}><Workflow className="mr-1.5 h-3.5 w-3.5" />Put plan to work<ChevronDown className="ml-1.5 h-3 w-3" /></Button></div></header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <div className="flex min-w-0 shrink-0 items-center justify-between gap-2 border-b border-border px-4"><nav className="flex items-center gap-4" aria-label="Plan views">{([{ id: 'board', label: 'Board', icon: LayoutGrid }, { id: 'document', label: 'Document', icon: FileText }] as const).map(tab => <button key={tab.id} onClick={() => { setView(tab.id); setSelectedAsset(null); if (tab.id === 'document') setDocumentPath('plan.md'); }} aria-current={view === tab.id ? 'page' : undefined} className={`flex h-11 items-center gap-1.5 border-b-2 text-xs font-medium transition-colors ${view === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}><tab.icon className="h-3.5 w-3.5" />{tab.label}</button>)}</nav><div className="flex items-center gap-1"><Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => uploadInput.current?.click()}><Upload className="mr-1 h-3.5 w-3.5" />Add files</Button><Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => { setTitle(''); setDialog('note'); }}><FilePlus2 className="mr-1 h-3.5 w-3.5" />New note</Button></div></div>
        {runs.length > 0 && <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border/60 bg-muted/20 px-5 py-2 text-[11px] text-muted-foreground"><Workflow className="h-3 w-3 shrink-0" /><span className="shrink-0">Linked work</span>{runs.map(([key]) => <button key={key} onClick={() => void openRun(key)} className="shrink-0 rounded-md border border-border bg-background px-2 py-1 hover:text-primary">{key.startsWith('manual:') ? 'Manual agent' : 'Orchestrator mission'} ↗</button>)}</div>}

        <div className={view === 'board' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><PlanningBoardView key={`${plan.id}:board`} workspaceId={workspaceId} planId={plan.id} files={files} refreshKey={0} onOpenFiles={() => { setSelectedAsset(null); setFilesOpen(true); }} onStatus={setBoardStatus} /></div>
        {view === 'document' && <PlanningDocumentEditor key={`${plan.id}:${documentPath}`} workspaceId={workspaceId} planId={plan.id} path={documentPath} refreshKey={refreshKey} onStatus={setSaveStatus} onOpen={openDocument} />}
      </div>
      </section>
      {showChat && <>{overlayChat && <button type="button" aria-label="Close assistant overlay" className="absolute inset-0 z-30 rounded-2xl bg-background/60 backdrop-blur-[2px]" onClick={() => { if (chatExpanded) setChatExpanded(false); else store.setChatHidden(workspaceId, true); }} />}<aside aria-label="Planning assistant panel" onKeyDown={event => { if (event.key === 'Escape' && overlayChat && !event.defaultPrevented && !(event.target as HTMLElement).closest('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) { event.preventDefault(); event.stopPropagation(); if (chatExpanded && !narrow) setChatExpanded(false); else store.setChatHidden(workspaceId, true); } }} className={overlayChat ? 'absolute inset-y-0 right-0 z-40 flex min-h-0 w-full max-w-[600px] flex-col rounded-2xl border border-border bg-background shadow-2xl' : 'relative flex min-h-0 shrink-0 flex-col rounded-2xl border border-border bg-background shadow-sm'} style={overlayChat ? undefined : { width: effectiveChatWidth }}>
        {!overlayChat && <div role="separator" aria-label="Resize planning assistant" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={maximumChatWidth} aria-valuenow={effectiveChatWidth} tabIndex={0} className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none hover:bg-primary/20 focus-visible:bg-primary/25 focus-visible:outline-none" onPointerDown={event => { drag.current = { x: event.clientX, width: effectiveChatWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (drag.current) resizeChat(drag.current.width + drag.current.x - event.clientX); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeChat(effectiveChatWidth + (event.key === 'ArrowLeft' ? 20 : -20)); } }} />}
        <PlanningChat key={`${workspaceId}:${plan.id}`} workspaceId={workspaceId} planId={plan.id} onDocumentChange={openDocument} onClose={() => { store.setChatHidden(workspaceId, true); setChatExpanded(false); }} onExpand={() => setChatExpanded(value => !value)} expanded={chatExpanded} />
      </aside></>}
      {!showChat && <Button variant="secondary" size="sm" className="absolute bottom-4 right-4 z-20 rounded-full border border-border shadow-sm" onClick={() => { if (browserOpen && narrow) useBrowserStore.getState().close(); store.setChatHidden(workspaceId, false); }}><MessageSquare className="mr-2 h-4 w-4" />Plan assistant</Button>}
    </div>}
    <Dialog open={filesOpen} onOpenChange={open => { setFilesOpen(open); if (!open) setSelectedAsset(null); }}><DialogContent className="flex max-h-[85vh] w-[calc(100vw-3rem)] max-w-2xl flex-col sm:max-w-2xl"><DialogHeader><DialogTitle>Files & research</DialogTitle><DialogDescription>Upload references, write research notes and preview media. Everything stays in this plan's folder.</DialogDescription></DialogHeader><div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => uploadInput.current?.click()}><Upload className="mr-1.5 h-3.5 w-3.5" />Add files</Button><Button size="sm" variant="outline" onClick={() => { setFilesOpen(false); setTitle(''); setDialog('note'); }}><FilePlus2 className="mr-1.5 h-3.5 w-3.5" />New research note</Button><span className="ml-auto text-xs tabular-nums text-muted-foreground">{files.length} {files.length === 1 ? 'file' : 'files'} · {research.length} {research.length === 1 ? 'note' : 'notes'}</span></div><div className="min-h-0 flex-1 overflow-y-auto" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); importFiles(Array.from(event.dataTransfer.files)); } }}>{files.map(file => <div key={file.path} className="flex min-w-0 items-center gap-3 border-b border-border/60 py-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">{file.mimeType.startsWith('image/') ? <FileImage className="h-4 w-4 text-muted-foreground" /> : file.mimeType.startsWith('video/') ? <Film className="h-4 w-4 text-muted-foreground" /> : <FileText className="h-4 w-4 text-muted-foreground" />}</span><button className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:text-primary" onClick={() => { if (/\.md$/i.test(file.path) && !file.path.startsWith('assets/')) { setFilesOpen(false); openDocument(file.path); } else setSelectedAsset(file.path); }}>{file.path}</button><span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{fileSize(file.byteSize)}</span>{file.path.startsWith('assets/') && <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-[10px]" disabled={pending} onClick={() => void insertAsset(file)}>Insert in document</Button>}</div>)}{!assets.length && <button onClick={() => uploadInput.current?.click()} className="mt-6 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"><Upload className="h-6 w-6" /><span>Images, videos, documents and Markdown notes</span></button>}{selectedAsset && <PlanningMedia key={selectedAsset} workspaceId={workspaceId} planId={plan?.id || ''} path={selectedAsset} />}</div></DialogContent></Dialog>
    {(error || store.errors[workspaceId] || notice) && <div role={error || store.errors[workspaceId] ? 'alert' : 'status'} className={`flex shrink-0 items-start justify-between gap-3 border-t border-border px-5 py-3 text-xs ${error || store.errors[workspaceId] ? 'bg-destructive/5 text-destructive' : 'bg-muted/30 text-muted-foreground'}`}><span>{error || store.errors[workspaceId] || notice}</span><button aria-label="Dismiss message" onClick={() => { setError(''); setNotice(''); if (store.errors[workspaceId]) void store.refresh(workspaceId); }}><X className="h-3.5 w-3.5" /></button></div>}
    <Dialog open={store.creating || Boolean(dialog)} onOpenChange={open => { if (!open && !pending) { store.setCreating(false); setDialog(null); } }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{store.creating ? 'Start a new plan' : dialog === 'rename' ? 'Rename plan' : 'New research note'}</DialogTitle><DialogDescription>{store.creating ? 'Give your idea a name. The plan, research and conversation will live in this workspace.' : dialog === 'rename' ? 'The plan identity and linked work stay the same.' : 'A Markdown document for sources, comparisons and discoveries.'}</DialogDescription></DialogHeader><form onSubmit={event => { event.preventDefault(); submitTitle(); }}><label className="mb-2 block text-xs font-medium" htmlFor="planning-title">Title</label><Input id="planning-title" autoFocus value={title} maxLength={200} onChange={event => setTitle(event.target.value)} placeholder={dialog === 'note' ? 'e.g. Authentication options' : 'e.g. A better onboarding experience'} /><DialogFooter className="mt-6"><Button type="button" variant="outline" disabled={pending} onClick={() => { store.setCreating(false); setDialog(null); }}>Cancel</Button><Button type="submit" disabled={!title.trim() || pending}>{pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{dialog === 'rename' ? 'Save name' : store.creating ? 'Create plan' : 'Create note'}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={execution} onOpenChange={open => { if (!pending) setExecution(open); }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Put your plan to work</DialogTitle><DialogDescription>Save a fixed version of the plan and its references, then choose how to continue.</DialogDescription></DialogHeader><div className="grid grid-cols-2 gap-3">{([{ id: 'manual', label: 'Manual', icon: TerminalSquare, detail: 'Open an independent agent with the plan ready to send.' }, { id: 'orchestrator', label: 'Orchestrator', icon: Workflow, detail: 'Start coordinated implementation using your project defaults.' }] as const).map(item => <button key={item.id} type="button" aria-pressed={target === item.id} onClick={() => setTarget(item.id)} className={`rounded-xl border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring ${target === item.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'}`}><item.icon className="mb-3 h-5 w-5 text-primary" /><span className="block text-sm font-semibold">{item.label}</span><span className="mt-2 block text-xs leading-5 text-muted-foreground">{item.detail}</span></button>)}</div><label className="grid gap-2 text-xs font-medium">{target === 'manual' ? 'Agent model' : 'Coordinator model'}<select aria-label="Execution model" className={selectClass} value={chosenModel?.catalogId || ''} onChange={event => { setModel(event.target.value); setReasoning(''); }}><option value="" disabled>Select a connected model</option>{availableModels.map(item => <option key={item.catalogId} value={item.catalogId}>{item.name} · {item.accountName}</option>)}</select></label>{chosenModel?.supportedReasoning.length ? <label className="grid gap-2 text-xs font-medium">Reasoning<select aria-label="Execution reasoning" className={selectClass} value={reasoning} onChange={event => setReasoning(event.target.value)}><option value="">Provider default</option>{chosenModel.supportedReasoning.map(value => <option key={value} value={value}>{value}</option>)}</select></label> : null}<p className="rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">The working copy can keep evolving. This execution keeps the saved snapshot it starts with.</p>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={pending} onClick={() => setExecution(false)}>Cancel</Button><Button disabled={!chosenModel || pending} onClick={handoff}>{pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}{target === 'manual' ? 'Continue in Manual' : 'Start Orchestrator'}</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}

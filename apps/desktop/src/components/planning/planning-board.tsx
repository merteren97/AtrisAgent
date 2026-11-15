import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTheme } from 'next-themes';
import { AlertTriangle, ArrowLeft, Check, ChevronRight, ListTree, Loader2, MoreHorizontal, Search, Sparkles, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { ApiError, apiRequest } from '@/lib/api-client';
import { boardApi, documentKey, emptyPlanningLocation, usePlanningStore, type PlanningBoard, type PlanningBoardItem, type PlanningBoardSection, type PlanningBoardStatus, type PlanningBoardVersion, type PlanningFile, type PlanningLocation } from '@/stores/planning-store';
import { boardChanges, boardStatuses, flattenBoard, searchBoard, sectionAt, validBoardPath, type BoardEntry } from './planning-board-model';
import { BoardActions, BoardNavigation, BoardOverview, BoardSearchResults, BoardStatus, BoardThumbnail, ItemReading, SectionCard, SectionItems } from './planning-board-content';
import { ItemEditor, SectionEditor } from './planning-board-editor';

function uniqueId(sections: PlanningBoardSection[], base: string): string {
  const used = new Set(flattenBoard(sections).map(entry => entry.item?.id || entry.section.id));
  let id = base, suffix = 2; while (used.has(id)) id = `${base}-${suffix++}`; return id;
}
function reorder<T>(entries: T[], from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return;
  const [entry] = entries.splice(from, 1); entries.splice(to, 0, entry);
}

export function PlanningBoardView({ workspaceId, planId, planTitle = 'Your plan', visible = true, files, refreshKey, onOpenFiles, onOpenDocument = () => {}, onStatus, onAskAI }: {
  workspaceId: string; planId: string; planTitle?: string; files: PlanningFile[]; refreshKey: number; onOpenFiles: () => void; onOpenDocument?: () => void;
  onStatus: (status: string) => void; onAskAI?: (instruction?: string) => void; visible?: boolean;
}) {
  const locationKey = documentKey(workspaceId, planId, 'location');
  const initial = useRef(usePlanningStore.getState().locations[locationKey] || emptyPlanningLocation()).current;
  const [version, setVersion] = useState<PlanningBoardVersion | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [conflict, setConflict] = useState(false);
  const [review, setReview] = useState<{ latest: PlanningBoardVersion | null; draft: PlanningBoard } | null>(null), [reviewBusy, setReviewBusy] = useState(false);
  const [path, setPath] = useState(initial.path), [activeItem, setActiveItem] = useState<string | null>(initial.itemId);
  const [query, setQuery] = useState(initial.query), [filter, setFilter] = useState<PlanningBoardStatus | ''>(initial.status);
  const [searchOpen, setSearchOpen] = useState(Boolean(initial.query || initial.status));
  const [editing, setEditing] = useState(false), [navigationOpen, setNavigationOpen] = useState(false), [appearanceOpen, setAppearanceOpen] = useState(false);
  const [localAppearance] = useState<NonNullable<PlanningLocation['appearance']>>(initial.appearance || { font: 'sans', accent: 'default', density: 'comfortable' });
  const appearance = version?.board.appearance || localAppearance;
  const { resolvedTheme } = useTheme();
  const [deleting, setDeleting] = useState<{ kind: 'section' | 'item'; path: string[]; itemId?: string; title: string } | null>(null);
  const revision = useRef<string | null>(null), pending = useRef<PlanningBoard | null>(null), saving = useRef(false), blocked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), generation = useRef(0);
  const content = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), restoreFocus = useRef(false);
  const scroll = useRef(initial.scroll), scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locationId = JSON.stringify([path, activeItem, Boolean(query.trim() || filter)]);
  const draftKey = documentKey(workspaceId, planId, 'board.json');
  const entries = useMemo(() => flattenBoard(version?.board.sections || []), [version?.board.sections]);
  const section = version ? sectionAt(version.board.sections, path) : undefined;
  const item = section?.items?.find(entry => entry.id === activeItem);
  const searching = Boolean(query.trim() || filter), results = useMemo(() => searchBoard(entries, query, filter), [entries, query, filter]);

  useEffect(() => { usePlanningStore.getState().setLocation(locationKey, { path, itemId: activeItem, query, status: filter, appearance }); }, [locationKey, path, activeItem, query, filter, appearance]);
  useLayoutEffect(() => {
    if (!visible || !version || !content.current) return;
    content.current.scrollTop = scroll.current[locationId] || 0;
    if (restoreFocus.current) { heading.current?.focus({ preventScroll: true }); restoreFocus.current = false; }
  }, [locationId, Boolean(version), visible]);
  useEffect(() => () => { if (scrollTimer.current) clearTimeout(scrollTimer.current); usePlanningStore.getState().setLocation(locationKey, { scroll: scroll.current }); }, [locationKey]);
  useEffect(() => {
    if (!version) return;
    const valid = validBoardPath(version.board.sections, path);
    if (valid.length !== path.length) { setPath(valid); setActiveItem(null); setEditing(false); }
    else if (activeItem && !section?.items?.some(entry => entry.id === activeItem)) { setActiveItem(null); setEditing(false); }
  }, [version, path, activeItem, section]);

  const load = useCallback(async () => {
    if (saving.current || pending.current) return;
    const request = ++generation.current; setLoading(true);
    try {
      const result = await apiRequest<PlanningBoardVersion | null>(boardApi(workspaceId, planId));
      if (request !== generation.current || pending.current || saving.current) return;
      const draft = usePlanningStore.getState().drafts[draftKey];
      revision.current = result?.revision ?? null; blocked.current = Boolean(draft);
      if (draft) { setVersion({ board: JSON.parse(draft.content) as PlanningBoard, revision: draft.baseRevision }); setError('Your local draft is preserved. Compare it with the saved plan to continue.'); }
      else { setVersion(current => current?.revision === result?.revision ? current : result); setError(''); }
      setConflict(Boolean(draft)); onStatus(draft ? 'Unsaved changes' : result ? 'Saved locally' : 'No board yet');
    } catch (cause) { if (request === generation.current) { setError(cause instanceof Error ? cause.message : 'Could not load the board.'); onStatus('Save needs attention'); } }
    finally { if (request === generation.current) setLoading(false); }
  }, [workspaceId, planId, onStatus, draftKey]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 8_000); return () => { clearInterval(id); generation.current++; }; }, [load]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flush = useCallback(async () => {
    if (saving.current || !pending.current || blocked.current) return;
    const board = pending.current; pending.current = null; saving.current = true; onStatus('Saving...');
    try {
      const saved = await apiRequest<PlanningBoardVersion>(boardApi(workspaceId, planId), { method: 'PUT', body: JSON.stringify({ board, expectedRevision: revision.current }) });
      revision.current = saved.revision; setConflict(false); setError('');
      usePlanningStore.getState().clearDraft(draftKey, JSON.stringify(board));
      if (!pending.current) setVersion(saved); else setVersion(current => current ? { ...current, revision: saved.revision } : current);
      onStatus(pending.current ? 'Unsaved changes' : 'Saved locally');
    } catch (cause) {
      blocked.current = true; setConflict(true);
      setError(cause instanceof ApiError && cause.status === 409 ? 'This plan changed on disk. Your local draft is preserved.' : cause instanceof Error ? cause.message : 'Could not save the board.');
      onStatus('Save needs attention');
    } finally { saving.current = false; if (pending.current && !blocked.current) timer.current = setTimeout(() => void flush(), 300); }
  }, [workspaceId, planId, onStatus, draftKey]);
  const mutate = useCallback((change: (board: PlanningBoard) => void) => {
    if (!version || blocked.current) return;
    const next = structuredClone(version.board); change(next); generation.current++;
    const previous = usePlanningStore.getState().drafts[draftKey];
    usePlanningStore.getState().setDraft(draftKey, { content: JSON.stringify(next), baseContent: previous?.baseContent ?? JSON.stringify(version.board), baseRevision: previous?.baseRevision ?? version.revision });
    setVersion(current => current ? { ...current, board: next } : current); pending.current = next; onStatus('Unsaved changes');
    if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 700);
  }, [version, onStatus, flush, draftKey]);
  const select = (next: string[], itemId: string | null = null, edit = false) => {
    setPath(next); setActiveItem(itemId); setEditing(edit); setQuery(''); setFilter(''); setSearchOpen(false); setNavigationOpen(false); restoreFocus.current = true;
  };
  const setAppearance = (next: NonNullable<PlanningLocation['appearance']>) => mutate(board => { board.appearance = next; });
  const askAI = () => {
    const context = section ? `Edit “${item?.title || section.title}” (${item ? `item ID: ${item.id}; ` : ''}section path: ${path.join(' / ')}). Preserve other sections.` : 'Help me shape this plan into a simple, readable project page.';
    onAskAI?.(`${context}\n\n`);
  };
  const openEntry = (entry: BoardEntry) => select(entry.path, entry.item?.id || null);
  const updateSection = (patch: Partial<PlanningBoardSection>) => mutate(board => { const target = sectionAt(board.sections, path); if (target) Object.assign(target, patch); });
  const updateItem = (id: string, patch: Partial<PlanningBoardItem>) => mutate(board => { const target = sectionAt(board.sections, path)?.items?.find(entry => entry.id === id); if (target) Object.assign(target, patch); });
  const addSection = (parent: string[]) => mutate(board => {
    const id = uniqueId(board.sections, 'new-category'), next: PlanningBoardSection = { id, title: 'New category', kind: 'section', body: '', children: [], items: [] };
    if (!parent.length) board.sections.push(next); else { const target = sectionAt(board.sections, parent); if (target) (target.children ??= []).push(next); }
    select([...parent, id], null, true);
  });
  const addItem = () => mutate(board => { const target = sectionAt(board.sections, path); if (!target) return; const id = uniqueId(board.sections, 'new-item'); (target.items ??= []).push({ id, title: 'New item', body: '' }); select(path, id, true); });
  const move = (parent: string[], id: string, direction: -1 | 1, isItem = false) => mutate(board => {
    const target = sectionAt(board.sections, parent); const siblings = isItem ? target?.items || [] : parent.length ? target?.children || [] : board.sections;
    const index = siblings.findIndex(entry => entry.id === id); reorder<PlanningBoardItem | PlanningBoardSection>(siblings, index, index + direction);
  });
  const reorderTo = (parent: string[], source: string, target: string, isItem = false) => mutate(board => {
    const section = sectionAt(board.sections, parent), siblings = isItem ? section?.items || [] : parent.length ? section?.children || [] : board.sections;
    reorder<PlanningBoardItem | PlanningBoardSection>(siblings, siblings.findIndex(entry => entry.id === source), siblings.findIndex(entry => entry.id === target));
  });
  const confirmDelete = () => {
    if (!deleting) return;
    mutate(board => {
      if (deleting.kind === 'item') { const target = sectionAt(board.sections, deleting.path); if (target) target.items = target.items?.filter(entry => entry.id !== deleting.itemId); }
      else { const parent = deleting.path.slice(0, -1), siblings = parent.length ? sectionAt(board.sections, parent)?.children : board.sections; const index = siblings?.findIndex(entry => entry.id === deleting.path[deleting.path.length - 1]) ?? -1; if (siblings && index >= 0) siblings.splice(index, 1); }
    });
    setDeleting(null);
  };
  const convert = async () => {
    try { const result = await apiRequest<PlanningBoardVersion>(`${boardApi(workspaceId, planId)}/convert`, { method: 'POST', body: '{}' }); revision.current = result.revision; setVersion(result); setConflict(false); onStatus('Saved locally'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not build the board.'); }
  };
  const reviewDraft = async () => {
    try { const latest = await apiRequest<PlanningBoardVersion | null>(boardApi(workspaceId, planId)); const draft = usePlanningStore.getState().drafts[draftKey]; if (draft) setReview({ latest, draft: JSON.parse(draft.content) as PlanningBoard }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not compare the board.'); }
  };
  const resolveDraft = async (apply: boolean) => {
    if (!review || reviewBusy) return; setReviewBusy(true);
    try {
      const result = apply ? await apiRequest<PlanningBoardVersion>(boardApi(workspaceId, planId), { method: 'PUT', body: JSON.stringify({ board: review.draft, expectedRevision: review.latest?.revision ?? null }) }) : review.latest;
      usePlanningStore.getState().clearDraft(draftKey, JSON.stringify(review.draft)); pending.current = null; blocked.current = false; revision.current = result?.revision ?? null;
      setVersion(result); setConflict(false); setError(''); setReview(null); onStatus(result ? 'Saved locally' : 'No board yet');
    } catch (cause) { setReview(null); setError(cause instanceof Error ? cause.message : 'Could not save. Compare again before retrying.'); }
    finally { setReviewBusy(false); }
  };

  if (loading && !version) return <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading plan…</div>;
  if (!version) return <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"><h2 className="text-lg font-semibold">Start with an idea.</h2><p className="max-w-sm text-sm leading-6 text-muted-foreground">Tell the assistant what you want to build. Your plan takes shape here.</p>{onAskAI && <Button onClick={askAI}><Sparkles className="mr-2 h-4 w-4" />Create with AI</Button>}<Button variant="ghost" size="sm" onClick={() => void convert()}>Use existing document</Button>{error && <p role="alert" className="text-xs text-destructive">{error}<button onClick={() => void load()} className="ml-2 underline">Retry</button></p>}</div>;
  const sectionActions = (entry: PlanningBoardSection, index: number, siblings: PlanningBoardSection[], parent: string[]) => ({
    onEdit: () => select([...parent, entry.id], null, true), onDelete: () => setDeleting({ kind: 'section', path: [...parent, entry.id], title: entry.title }),
    onMove: (direction: -1 | 1) => move(parent, entry.id, direction), onReorder: (source: string) => reorderTo(parent, source, entry.id), first: index === 0, last: index === siblings.length - 1, disabled: conflict,
  });
  const itemActions = (entry: PlanningBoardItem, index: number) => ({
    onEdit: () => select(path, entry.id, true), onDelete: () => setDeleting({ kind: 'item', path, itemId: entry.id, title: entry.title }),
    onMove: (direction: -1 | 1) => move(path, entry.id, direction, true), onReorder: (source: string) => reorderTo(path, source, entry.id, true), first: index === 0, last: index === (section?.items?.length || 0) - 1, disabled: conflict,
  });
  const cover = version.board.cover || entries.find(entry => !entry.item && entry.section.cover)?.section.cover;
  const navigation = <BoardNavigation sections={version.board.sections} path={path} title={planTitle} cover={cover} onSelect={next => select(next)} onDocument={() => { setNavigationOpen(false); onOpenDocument(); }} onFiles={() => { setNavigationOpen(false); onOpenFiles(); }} workspaceId={workspaceId} planId={planId} />;
  const accentHue = { default: 250, blue: 212, sage: 154, amber: 35, rose: 345 }[appearance.accent];
  const style = appearance.accent === 'default' ? undefined : {
    '--primary': `${accentHue} ${appearance.accent === 'sage' ? 38 : 70}% ${resolvedTheme === 'dark' ? 70 : 38}%`,
    '--primary-foreground': resolvedTheme === 'dark' ? '220 20% 10%' : '0 0% 100%', '--ring': `${accentHue} 60% 55%`,
    '--color-primary': 'hsl(var(--primary))', '--color-primary-foreground': 'hsl(var(--primary-foreground))', '--color-ring': 'hsl(var(--ring))',
  } as CSSProperties;
  const readingStyle: CSSProperties = { fontFamily: appearance.font === 'editorial' ? 'Georgia, Cambria, serif' : appearance.font === 'mono' ? 'ui-monospace, Consolas, monospace' : undefined };
  return <div className="@container/board flex min-h-0 flex-1 flex-col" style={style}>
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-48 shrink-0 border-r border-border/50 bg-muted/10 @min-[820px]/board:block">{navigation}</aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
          <nav aria-label="Board breadcrumb" className="flex min-w-0 items-center gap-1 text-xs"><Button variant="ghost" size="icon" className="h-7 w-7 @min-[820px]/board:hidden" aria-label="Browse plan sections" onClick={() => setNavigationOpen(true)}><ListTree className="h-4 w-4" /></Button><button className="rounded px-1 py-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => select([])}>Overview</button>{path.map((id, index) => <span key={id} className="flex min-w-0 items-center gap-1"><ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" /><button className="max-w-32 truncate rounded px-1 py-1 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => select(path.slice(0, index + 1))}>{sectionAt(version.board.sections, path.slice(0, index + 1))?.title || id}</button></span>)}</nav>
          <div className="flex items-center gap-1">
            {onAskAI && <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" onClick={askAI}><Sparkles className="h-3.5 w-3.5 text-primary" />Edit with AI</Button>}
            <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" aria-label="Page options"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setSearchOpen(true)}>Find in plan</DropdownMenuItem>
              <DropdownMenuItem disabled={conflict} onSelect={() => setAppearanceOpen(true)}>Appearance</DropdownMenuItem>
              <DropdownMenuItem onSelect={onOpenDocument}>Plan document</DropdownMenuItem><DropdownMenuItem onSelect={onOpenFiles}>Files & research</DropdownMenuItem>
              <DropdownMenuItem disabled={conflict} onSelect={() => addSection([])}>New section</DropdownMenuItem>
              {section && <><DropdownMenuItem disabled={conflict} onSelect={() => addSection(path)}>New subsection</DropdownMenuItem><DropdownMenuItem disabled={conflict} onSelect={addItem}>New item</DropdownMenuItem></>}
            </DropdownMenuContent></DropdownMenu>
          </div>
        </header>
        {searchOpen && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2"><div className="relative min-w-40 flex-1"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" /><Input autoFocus aria-label="Search plan content" value={query} onChange={event => { setQuery(event.target.value); setEditing(false); }} placeholder="Search this plan…" className="h-8 border-transparent bg-muted/30 pl-8 text-xs shadow-none" /></div><select aria-label="Filter by status" value={filter} onChange={event => { setFilter(event.target.value as PlanningBoardStatus | ''); setEditing(false); }} className="h-8 max-w-40 rounded-md border border-border bg-background px-2 text-[11px]"><option value="">All statuses</option>{boardStatuses.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}</select><Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Close search" onClick={() => { setQuery(''); setFilter(''); setSearchOpen(false); }}><X className="h-3.5 w-3.5" /></Button></div>}
        {error && <div role="alert" className={`flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-xs ${conflict ? 'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-200' : 'border-destructive/20 bg-destructive/5 text-destructive'}`}><span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</span><Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => conflict ? void reviewDraft() : void load()}>{conflict ? 'Compare saved plan' : 'Retry'}</Button></div>}
        <div ref={content} onScroll={event => { if (!visible || !event.currentTarget.clientHeight) return; scroll.current = { ...scroll.current, [locationId]: event.currentTarget.scrollTop }; if (scrollTimer.current) clearTimeout(scrollTimer.current); scrollTimer.current = setTimeout(() => usePlanningStore.getState().setLocation(locationKey, { scroll: scroll.current }), 250); }} className={`min-h-0 flex-1 overflow-y-auto ${appearance.density === 'compact' ? 'p-4' : 'px-5 py-6 @min-[700px]/board:px-8'}`}>
          <div className="mx-auto max-w-5xl" style={readingStyle}>
            {searching ? <BoardSearchResults entries={results} onOpen={openEntry} /> : item && section ? <section aria-label="Item detail">
              <button className="mb-5 flex items-center gap-1.5 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => select(path)}><ArrowLeft className="h-3.5 w-3.5" />Back to {section.title}</button>
              <div className="mb-6 flex items-start justify-between gap-3"><div className="min-w-0"><h1 ref={heading} tabIndex={-1} className="break-words text-[28px] font-semibold tracking-tight outline-none">{item.title}</h1>{['review', 'blocked'].includes(item.status || '') && <div className="mt-3"><BoardStatus status={item.status} /></div>}</div>
                {editing ? <Button size="sm" variant="ghost" onClick={() => setEditing(false)} className="shrink-0 text-xs"><Check className="mr-1 h-3.5 w-3.5" />Reading view</Button> : <BoardActions title={item.title} {...itemActions(item, section.items!.findIndex(entry => entry.id === item.id))} />}
              </div>
              {editing ? <fieldset disabled={conflict}><ItemEditor key={item.id} item={item} workspaceId={workspaceId} planId={planId} files={files} onChange={patch => updateItem(item.id, patch)} onFiles={onOpenFiles} /></fieldset> : <ItemReading item={item} workspaceId={workspaceId} planId={planId} onCompareMode={mode => { if (item.compare) updateItem(item.id, { compare: { ...item.compare, mode } }); }} />}
            </section>
            : section ? <section aria-label="Section content"><header className="mb-6">
              <div className="flex items-start justify-between gap-3"><h1 ref={heading} tabIndex={-1} className="break-words text-[28px] font-semibold tracking-tight outline-none">{section.title}</h1>
                {editing ? <Button size="sm" variant="ghost" className="shrink-0 text-xs" onClick={() => setEditing(false)}><Check className="mr-1 h-3.5 w-3.5" />Reading view</Button> : <BoardActions title={section.title} {...sectionActions(section, (path.length === 1 ? version.board.sections : sectionAt(version.board.sections, path.slice(0, -1))?.children || []).findIndex(entry => entry.id === section.id), path.length === 1 ? version.board.sections : sectionAt(version.board.sections, path.slice(0, -1))?.children || [], path.slice(0, -1))} />}
              </div>
              {section.summary && <p className="mt-3 max-w-2xl text-[14px] leading-7 text-muted-foreground">{section.summary}</p>}{section.status === 'blocked' && <div className="mt-3"><BoardStatus status={section.status} /></div>}
              </header>
              {editing ? <fieldset disabled={conflict} className="mb-8"><SectionEditor section={section} files={files} onChange={updateSection} /></fieldset> : <>{section.cover && <div className="mb-6 overflow-hidden rounded-xl"><BoardThumbnail workspaceId={workspaceId} planId={planId} path={section.cover} /></div>}{section.body && <MarkdownContent content={section.body} className="mb-8 text-[13px] leading-7" />}</>}
              {Boolean(section.children?.length) && <section className="mb-7"><div className="grid gap-x-6 gap-y-3 @min-[650px]/board:grid-cols-2">{section.children!.map((child, index) => <SectionCard key={child.id} section={child} workspaceId={workspaceId} planId={planId} onOpen={() => select([...path, child.id])} actions={sectionActions(child, index, section.children!, path)} />)}</div></section>}
              <SectionItems section={section} workspaceId={workspaceId} planId={planId} onOpen={entry => select(path, entry.id)} onToggle={(entry, done) => updateItem(entry.id, { status: done ? 'done' : 'idea' })} actions={itemActions} disabled={conflict} />
              {!section.body && !section.items?.length && !section.children?.length && !editing && <p className="py-4 text-sm leading-7 text-muted-foreground">Use Edit with AI to shape this section, add references or explore the next step.</p>}
            </section> : <>
              <h1 ref={heading} tabIndex={-1} className="sr-only outline-none">Plan overview</h1>
              <BoardOverview title={planTitle} entries={entries} workspaceId={workspaceId} planId={planId} summary={version.board.summary} cover={version.board.cover} />
              {!version.board.sections.length ? <div className="py-6"><p className="mb-5 max-w-md text-sm leading-7 text-muted-foreground">Tell the assistant what you have in mind. It will organize your ideas, references and next steps into a project page.</p>{onAskAI && <Button size="sm" variant="outline" onClick={askAI}><Sparkles className="mr-2 h-3.5 w-3.5" />Create with AI</Button>}</div>
                : <div className="grid gap-x-7 gap-y-5 @min-[600px]/board:grid-cols-2 @min-[1150px]/board:grid-cols-3">{version.board.sections.map((entry, index) => <SectionCard key={entry.id} section={entry} workspaceId={workspaceId} planId={planId} onOpen={() => select([entry.id])} actions={sectionActions(entry, index, version.board.sections, [])} />)}</div>}
            </>}
          </div>
        </div>
      </div>
    </div>
    <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}><DialogContent className="flex h-[min(80vh,640px)] max-w-sm flex-col gap-0 p-0"><DialogHeader className="px-5 pt-5"><DialogTitle>Explore plan</DialogTitle><DialogDescription>Sections, documents and references.</DialogDescription></DialogHeader><div className="min-h-0 flex-1">{navigation}</div></DialogContent></Dialog>
    <Dialog open={appearanceOpen} onOpenChange={setAppearanceOpen}><DialogContent className="max-w-md" style={style}>
      <DialogHeader><DialogTitle>Plan appearance</DialogTitle><DialogDescription>You can also ask AI to change the typography, colors or spacing.</DialogDescription></DialogHeader>
      <fieldset disabled={conflict} className="space-y-5 py-2">
        <label className="grid gap-2 text-xs font-medium">Typography<select aria-label="Plan font" className="h-9 rounded-lg border border-input bg-background px-3" value={appearance.font} onChange={event => setAppearance({ ...appearance, font: event.target.value as typeof appearance.font })}><option value="sans">Modern · Sans serif</option><option value="editorial">Editorial · Serif</option><option value="mono">Technical · Monospace</option></select></label>
        <div><p className="mb-2 text-xs font-medium">Accent color</p><div className="flex flex-wrap gap-2">{(['default', 'blue', 'sage', 'amber', 'rose'] as const).map(accent => <button key={accent} aria-label={`${accent} accent`} aria-pressed={appearance.accent === accent} onClick={() => setAppearance({ ...appearance, accent })} className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs capitalize focus-visible:ring-2 focus-visible:ring-ring ${appearance.accent === accent ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: `hsl(${{ default: 250, blue: 212, sage: 154, amber: 35, rose: 345 }[accent]} 60% 55%)` }} />{accent === 'default' ? 'App theme' : accent}</button>)}</div></div>
        <label className="grid gap-2 text-xs font-medium">Content spacing<select aria-label="Plan density" className="h-9 rounded-lg border border-input bg-background px-3" value={appearance.density} onChange={event => setAppearance({ ...appearance, density: event.target.value as typeof appearance.density })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
        <p className="text-xs leading-5 text-muted-foreground">Saved with the plan, alongside its content and images.</p>
      </fieldset>
    </DialogContent></Dialog>
    <Dialog open={Boolean(deleting)} onOpenChange={open => { if (!open) setDeleting(null); }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Delete {deleting?.kind === 'item' ? 'item' : 'section'}?</DialogTitle><DialogDescription>“{deleting?.title}” will be removed from this plan. Media files remain in the plan folder.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" disabled={conflict} onClick={confirmDelete}><Trash2 className="mr-2 h-4 w-4" />Delete</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !reviewBusy) setReview(null); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>Review your local draft</DialogTitle><DialogDescription>Changes below compare the latest saved plan with your preserved draft. Applying replaces only the saved revision shown here.</DialogDescription></DialogHeader>{review && <div className="max-h-[50vh] overflow-y-auto"><ul className="space-y-2 rounded-lg border border-border bg-muted/15 p-4 text-xs leading-6">{boardChanges(review.latest?.board || null, review.draft).map((change, index) => <li key={index}>{change}</li>)}{!boardChanges(review.latest?.board || null, review.draft).length && <li>No content changes. You can use the saved plan.</li>}</ul><details className="mt-4 text-xs"><summary className="cursor-pointer text-muted-foreground">Technical details · JSON</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{[{ title: 'Latest saved plan', board: review.latest?.board }, { title: 'Local draft', board: review.draft }].map(entry => <section key={entry.title}><h3 className="mb-2 font-medium">{entry.title}</h3><pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border p-3 text-[11px] [overflow-wrap:anywhere]">{JSON.stringify(entry.board, null, 2)}</pre></section>)}</div></details></div>}<DialogFooter><Button variant="ghost" disabled={reviewBusy} onClick={() => setReview(null)}>Cancel</Button><Button variant="outline" disabled={reviewBusy} onClick={() => void resolveDraft(false)}>Use saved plan</Button><Button disabled={reviewBusy} onClick={() => void resolveDraft(true)}>Apply my draft</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

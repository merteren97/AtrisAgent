import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ChevronRight, FolderOpen, GripVertical, ImageIcon, Layers, Loader2, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { ApiError, apiRequest } from '@/lib/api-client';
import { boardApi, type PlanningBoard, type PlanningBoardItem, type PlanningBoardKind, type PlanningBoardSection, type PlanningBoardStatus, type PlanningBoardVersion, type PlanningFile } from '@/stores/planning-store';
import { PlanningMedia, usePlanningMediaUrl } from './planning-media';
import { PlanningCompare } from './planning-compare';

const kinds: Array<{ id: PlanningBoardKind; label: string }> = [
  { id: 'section', label: 'Section' }, { id: 'gallery', label: 'Gallery' }, { id: 'comparison', label: 'Comparison' },
  { id: 'checklist', label: 'Checklist' }, { id: 'research', label: 'Research' }, { id: 'note', label: 'Note' },
];
const statuses: Array<{ id: PlanningBoardStatus; label: string; variant: 'default' | 'secondary' | 'success' | 'warning' | 'outline' | 'destructive' }> = [
  { id: 'idea', label: 'Idea', variant: 'outline' }, { id: 'in-progress', label: 'In progress', variant: 'default' },
  { id: 'review', label: 'Review', variant: 'warning' }, { id: 'done', label: 'Done', variant: 'success' }, { id: 'blocked', label: 'Blocked', variant: 'destructive' },
];
const statusLabel = (status?: PlanningBoardStatus) => statuses.find(entry => entry.id === status)?.label;
const statusVariant = (status?: PlanningBoardStatus) => statuses.find(entry => entry.id === status)?.variant || 'outline';
const kindLabel = (kind: PlanningBoardKind) => kinds.find(entry => entry.id === kind)?.label || 'Section';
const countLabel = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

function uniqueId(sections: PlanningBoardSection[], base: string): string {
  const used = new Set<string>();
  const walk = (entries: PlanningBoardSection[]) => entries.forEach(section => { used.add(section.id); section.items?.forEach(item => used.add(item.id)); if (section.children) walk(section.children); });
  walk(sections);
  let id = base; let suffix = 2;
  while (used.has(id)) id = `${base.slice(0, 70)}-${suffix++}`;
  return id;
}
function itemsIn(section: PlanningBoardSection): number {
  return (section.items?.length || 0) + (section.children || []).reduce((total, child) => total + itemsIn(child), 0);
}
function locate(sections: PlanningBoardSection[], path: string[]): { siblings: PlanningBoardSection[]; index: number; section: PlanningBoardSection } | null {
  if (!path.length) return null;
  const parent = path.length === 1 ? null : locate(sections, path.slice(0, -1));
  const siblings = parent ? parent.section.children ?? [] : sections;
  const index = siblings.findIndex(section => section.id === path[path.length - 1]);
  return index < 0 ? null : { siblings, index, section: siblings[index] };
}
function removeSection(sections: PlanningBoardSection[], path: string[]): void {
  if (path.length === 1) { sections.splice(sections.findIndex(section => section.id === path[0]), 1); return; }
  const parent = locate(sections, path.slice(0, -1));
  if (parent?.section.children) parent.section.children.splice(parent.section.children.findIndex(section => section.id === path[path.length - 1]), 1);
}
function reorder<T>(entries: T[], from: number, to: number): void {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return;
  const [entry] = entries.splice(from, 1); entries.splice(to, 0, entry);
}

function CategoryCover({ workspaceId, planId, path }: { workspaceId: string; planId: string; path: string }) {
  const { url, error } = usePlanningMediaUrl(workspaceId, planId, path);
  if (!url || error) return null;
  return <img src={url} alt="" loading="lazy" className="mb-3 h-32 w-full rounded-lg bg-muted object-cover" />;
}

export function PlanningBoardView({ workspaceId, planId, files, refreshKey, onOpenFiles, onStatus }: {
  workspaceId: string; planId: string; files: PlanningFile[]; refreshKey: number; onOpenFiles: () => void;
  onStatus: (status: string) => void;
}) {
  const [version, setVersion] = useState<PlanningBoardVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [path, setPath] = useState<string[]>([]);
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [compareDraft, setCompareDraft] = useState({ before: '', after: '' });
  const [deleting, setDeleting] = useState<{ kind: 'section' | 'item'; path: string[]; itemId?: string; title: string } | null>(null);
  const revision = useRef<string | null>(null);
  const pending = useRef<PlanningBoard | null>(null);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragged = useRef<{ kind: 'section' | 'item'; path: string[]; itemId?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await apiRequest<PlanningBoardVersion | null>(boardApi(workspaceId, planId));
      revision.current = result?.revision ?? null;
      setVersion(result);
      setConflict(false);
      onStatus(result ? 'Saved locally' : 'No board yet');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load the board.'); onStatus('Save needs attention'); }
    finally { setLoading(false); }
  }, [workspaceId, planId, onStatus]);
  useEffect(() => { setVersion(null); setPath([]); setActiveItem(null); setConflict(false); pending.current = null; void load(); }, [load, refreshKey]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flush = useCallback(async () => {
    if (saving.current || !pending.current) return;
    const board = pending.current; pending.current = null; saving.current = true; onStatus('Saving...');
    try {
      const saved = await apiRequest<PlanningBoardVersion>(boardApi(workspaceId, planId), { method: 'PUT', body: JSON.stringify({ board, expectedRevision: revision.current }) });
      revision.current = saved.revision; setConflict(false); setError('');
      if (!pending.current) setVersion(saved); else setVersion(current => current ? { ...current, revision: saved.revision } : current);
      onStatus(pending.current ? 'Unsaved changes' : 'Saved locally');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError('This board changed on disk. Reload to compare before saving again.'); }
      else setError(cause instanceof Error ? cause.message : 'Could not save the board.');
      onStatus('Save needs attention');
    } finally {
      saving.current = false;
      if (pending.current) timer.current = setTimeout(() => void flush(), 300);
    }
  }, [workspaceId, planId, onStatus]);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 700);
  }, [flush]);
  const mutate = useCallback((change: (board: PlanningBoard) => void) => {
    if (!version) return;
    const next = structuredClone(version.board); change(next);
    setVersion(current => current ? { ...current, board: next } : current);
    pending.current = next; onStatus('Unsaved changes'); schedule();
  }, [version, onStatus, schedule]);

  const current = version ? locate(version.board.sections, path)?.section : null;
  const parentPath = path.slice(0, -1);
  const section = current;
  const item = section?.items?.find(entry => entry.id === activeItem) || null;
  const assets = files.filter(file => file.path.startsWith('assets/'));
  const images = assets.filter(file => file.mimeType.startsWith('image/'));
  useEffect(() => { setCompareDraft({ before: item?.compare?.before || '', after: item?.compare?.after || '' }); }, [item?.id, item?.compare?.before, item?.compare?.after]);

  const addSection = (parent: string[]) => {
    const base = 'new-category';
    mutate(board => {
      const id = uniqueId(board.sections, base);
      const section: PlanningBoardSection = { id, title: 'New category', kind: 'section', body: '', items: [], children: [] };
      if (!parent.length) board.sections.push(section);
      else {
        const target = locate(board.sections, parent)?.section;
        if (target) (target.children ??= []).push(section);
      }
      setPath([...parent, id]); setActiveItem(null);
    });
  };
  const addItem = (sectionPath: string[]) => {
    mutate(board => {
      const target = locate(board.sections, sectionPath)?.section;
      if (!target) return;
      const id = uniqueId(board.sections, 'new-item');
      (target.items ??= []).push({ id, title: 'New item', body: '' });
      setActiveItem(id);
    });
  };
  const updateSection = (sectionPath: string[], patch: Partial<PlanningBoardSection>) => mutate(board => {
    const target = locate(board.sections, sectionPath)?.section; if (target) Object.assign(target, patch);
  });
  const updateItem = (sectionPath: string[], itemId: string, patch: Partial<PlanningBoardItem>) => mutate(board => {
    const target = locate(board.sections, sectionPath)?.section; const item = target?.items?.find(entry => entry.id === itemId); if (item) Object.assign(item, patch);
  });
  const moveSection = (source: string, target: string) => {
    const parent = path;
    mutate(board => { const entries = parent.length ? locate(board.sections, parent)?.section.children ?? [] : board.sections; reorder(entries, entries.findIndex(entry => entry.id === source), entries.findIndex(entry => entry.id === target)); });
  };
  const moveItem = (source: string, target: string) => {
    const sectionPath = path;
    mutate(board => { const entries = locate(board.sections, sectionPath)?.section.items ?? []; reorder(entries, entries.findIndex(entry => entry.id === source), entries.findIndex(entry => entry.id === target)); });
  };
  const confirmDelete = () => {
    if (!deleting) return;
    mutate(board => {
      if (deleting.kind === 'section') removeSection(board.sections, deleting.path);
      else { const section = locate(board.sections, deleting.path)?.section; if (section?.items) section.items = section.items.filter(item => item.id !== deleting.itemId); }
    });
    if (deleting.kind === 'section' && path.length >= deleting.path.length) { setPath(deleting.path.slice(0, -1)); setActiveItem(null); }
    if (deleting.kind === 'item' && activeItem === deleting.itemId) setActiveItem(null);
    setDeleting(null);
  };
  const convert = () => void (async () => {
    try {
      const result = await apiRequest<PlanningBoardVersion>(`${boardApi(workspaceId, planId)}/convert`, { method: 'POST', body: JSON.stringify({}) });
      revision.current = result.revision; setVersion(result); setConflict(false); onStatus('Saved locally');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not build the board from Markdown.'); }
  })();
  const selectSection = (sectionPath: string[]) => { setPath(sectionPath); setActiveItem(null); };

  if (loading && !version) return <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading board...</div>;
  if (!version) return <div className="flex flex-1 flex-col items-center justify-center px-6 text-center"><Layers className="mb-4 h-8 w-8 text-muted-foreground" /><h2 className="text-base font-semibold">This plan has no board.</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">Build one from the Markdown headings, or start with a blank category.</p><div className="mt-5 flex gap-2"><Button size="sm" variant="outline" onClick={convert}><RefreshCw className="mr-2 h-3.5 w-3.5" />Build from Markdown</Button><Button size="sm" onClick={() => void load()}><Plus className="mr-2 h-4 w-4" />Retry</Button></div>{error && <p role="alert" className="mt-4 text-xs text-destructive">{error}</p>}</div>;

  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
      <nav aria-label="Board breadcrumb" className="flex min-w-0 items-center gap-1 text-xs">{<button className="shrink-0 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => selectSection([])}>Board</button>}{path.map((id, index) => <span key={id} className="flex min-w-0 items-center gap-1"><ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" /><button className="max-w-[16rem] truncate rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => selectSection(path.slice(0, index + 1))}>{locate(version.board.sections, path.slice(0, index + 1))?.section.title || id}</button></span>)}</nav>
      <div className="flex items-center gap-2"><Button size="sm" variant="outline" className="h-8 text-xs" onClick={onOpenFiles}><FolderOpen className="mr-1.5 h-3.5 w-3.5" />Files & research</Button>{!section && <Button size="sm" className="h-8 text-xs" onClick={() => addSection([])}><Plus className="mr-1.5 h-3.5 w-3.5" />Add category</Button>}</div>
    </header>
    {conflict && <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300"><span className="flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5" />{error}</span><Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void load()}><RefreshCw className="mr-1.5 h-3 w-3" />Reload board</Button></div>}
    {!conflict && error && <div role="alert" className="shrink-0 border-b border-border bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</div>}
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      {!section ? <div className="mx-auto max-w-6xl">
        {version.board.sections.length === 0 ? <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-10 text-center"><Layers className="mb-4 h-8 w-8 text-muted-foreground" /><h2 className="text-base font-semibold">Shape the plan around the work.</h2><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">Add categories for the parts of the plan, then break each one into subcategories and items. Nothing is fixed in code.</p><div className="mt-5 flex flex-wrap justify-center gap-2"><Button size="sm" variant="outline" onClick={convert}><RefreshCw className="mr-2 h-3.5 w-3.5" />Build from Markdown</Button><Button size="sm" onClick={() => addSection([])}><Plus className="mr-2 h-4 w-4" />Add first category</Button></div></div>
          : <div className="grid gap-3 @min-[720px]:grid-cols-2 @min-[1100px]:grid-cols-3">{version.board.sections.map(entry => <article key={entry.id} draggable onDragStart={() => { dragged.current = { kind: 'section', path: [entry.id] }; }} onDragOver={event => event.preventDefault()} onDrop={() => { if (dragged.current?.kind === 'section' && dragged.current.path.length === 1) moveSection(dragged.current.path[0], entry.id); dragged.current = null; }} className="group flex min-w-0 flex-col rounded-xl border border-border bg-card p-4">
            {entry.cover && <CategoryCover workspaceId={workspaceId} planId={planId} path={entry.cover} />}
            <div className="flex items-start justify-between gap-2"><button onClick={() => selectSection([entry.id])} className="min-w-0 flex-1 text-left"><span className="flex items-center gap-2"><GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" /><span className="truncate text-sm font-semibold">{entry.title}</span></span><span className="mt-1 block text-[11px] text-muted-foreground">{kindLabel(entry.kind)} · {countLabel(itemsIn(entry), 'item')} · {countLabel(entry.children?.length || 0, 'subcategory', 'subcategories')}</span></button><DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Actions for ${entry.title}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => selectSection([entry.id])}>Open</DropdownMenuItem><DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting({ kind: 'section', path: [entry.id], title: entry.title })}><Trash2 className="h-4 w-4" />Delete category</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
            {entry.summary && <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">{entry.summary}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">{entry.status && <Badge variant={statusVariant(entry.status)}>{statusLabel(entry.status)}</Badge>}{entry.cover && <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><ImageIcon className="h-3 w-3" />cover</span>}<span className="ml-auto text-[10px] text-muted-foreground">{entry.items?.length ? countLabel(entry.items.length, 'direct item') : 'No direct items'}</span></div>
          </article>)}</div>}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><FolderOpen className="h-4 w-4" /><span>Research notes, references and uploaded files live alongside the board.</span></div><Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onOpenFiles}>Open files</Button></div>
      </div> : <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3"><button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => selectSection(parentPath)}><ArrowLeft className="h-3.5 w-3.5" />Back</button><div className="flex items-center gap-2"><Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => addSection(path)}><Plus className="mr-1.5 h-3.5 w-3.5" />Add subcategory</Button><Button size="sm" className="h-8 text-xs" onClick={() => addItem(path)}><Plus className="mr-1.5 h-3.5 w-3.5" />Add item</Button></div></header>
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><Input aria-label="Category title" value={section.title} maxLength={200} onChange={event => updateSection(path, { title: event.target.value })} className="h-auto border-none bg-transparent px-0 text-xl font-semibold tracking-tight shadow-none focus-visible:ring-0" /><div className="mt-2 flex flex-wrap items-center gap-2"><select aria-label="Category kind" value={section.kind} onChange={event => updateSection(path, { kind: event.target.value as PlanningBoardKind })} className="h-7 rounded-lg border border-border bg-background px-2 text-[11px]">{kinds.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select><select aria-label="Category status" value={section.status || ''} onChange={event => updateSection(path, { status: event.target.value ? event.target.value as PlanningBoardStatus : undefined })} className="h-7 rounded-lg border border-border bg-background px-2 text-[11px]"><option value="">No status</option>{statuses.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></div></div><DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Category actions"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting({ kind: 'section', path, title: section.title })}><Trash2 className="h-4 w-4" />Delete category</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium">Summary<Input aria-label="Category summary" value={section.summary || ''} maxLength={2000} placeholder="A short orientation for this category" onChange={event => updateSection(path, { summary: event.target.value || undefined })} className="h-9 text-xs" /></label><label className="grid gap-1.5 text-xs font-medium">Cover image<select aria-label="Cover image" value={section.cover || ''} onChange={event => updateSection(path, { cover: event.target.value || undefined })} className="h-9 rounded-lg border border-input bg-background px-2 text-xs"><option value="">No cover</option>{section.cover && !images.some(file => file.path === section.cover) && <option value={section.cover}>{section.cover} (unavailable)</option>}{images.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label></div>
          <label className="mt-3 grid gap-1.5 text-xs font-medium">Markdown body<textarea aria-label="Category body" value={section.body || ''} onChange={event => updateSection(path, { body: event.target.value })} rows={4} className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Context, decisions and links for this category." /></label>
          {section.body?.trim() && <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"><MarkdownContent content={section.body} className="text-xs leading-6" /></div>}
        </div>
        {section.children?.length ? <section aria-label="Subcategories"><h3 className="mb-2 text-xs font-semibold text-muted-foreground">Subcategories</h3><div className="grid gap-2 sm:grid-cols-2">{section.children.map(child => <article key={child.id} draggable onDragStart={() => { dragged.current = { kind: 'section', path: [...path, child.id] }; }} onDragOver={event => event.preventDefault()} onDrop={() => { if (dragged.current?.kind === 'section' && dragged.current.path.length === path.length + 1) moveSection(dragged.current.path[dragged.current.path.length - 1], child.id); dragged.current = null; }} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"><GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" /><button className="min-w-0 flex-1 text-left" onClick={() => selectSection([...path, child.id])}><span className="block truncate text-xs font-semibold">{child.title}</span><span className="mt-0.5 block text-[10px] text-muted-foreground">{kindLabel(child.kind)} · {countLabel(itemsIn(child), 'item')}</span></button>{child.status && <Badge variant={statusVariant(child.status)}>{statusLabel(child.status)}</Badge>}<Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Delete ${child.title}`} onClick={() => setDeleting({ kind: 'section', path: [...path, child.id], title: child.title })}><Trash2 className="h-3.5 w-3.5" /></Button></article>)}</div></section> : null}
        <section aria-label="Items"><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold text-muted-foreground">Items</h3><span className="text-[10px] tabular-nums text-muted-foreground">{section.items?.length || 0}</span></div>
          {section.items?.length ? <div className="grid gap-3 @min-[720px]:grid-cols-2">{section.items.map(entry => <article key={entry.id} draggable onDragStart={() => { dragged.current = { kind: 'item', path, itemId: entry.id }; }} onDragOver={event => event.preventDefault()} onDrop={() => { if (dragged.current?.kind === 'item' && dragged.current.itemId) moveItem(dragged.current.itemId, entry.id); dragged.current = null; }} className={`group min-w-0 rounded-xl border bg-card p-4 ${activeItem === entry.id ? 'border-primary/60 ring-1 ring-primary/20' : 'border-border'}`}><div className="flex items-start justify-between gap-2"><button className="min-w-0 flex-1 text-left" onClick={() => setActiveItem(activeItem === entry.id ? null : entry.id)}><span className="flex items-center gap-2"><GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" /><span className="truncate text-sm font-semibold">{entry.title}</span></span><span className="mt-1 block text-[11px] text-muted-foreground">{entry.body?.trim() ? `${entry.body.trim().slice(0, 90)}${entry.body.trim().length > 90 ? '...' : ''}` : 'No body yet'}</span></button><DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Actions for ${entry.title}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setActiveItem(entry.id)}>Edit item</DropdownMenuItem><DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting({ kind: 'item', path, itemId: entry.id, title: entry.title })}><Trash2 className="h-4 w-4" />Delete item</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div><div className="mt-3 flex flex-wrap items-center gap-2">{entry.status && <Badge variant={statusVariant(entry.status)}>{statusLabel(entry.status)}</Badge>}{entry.media?.length ? <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><ImageIcon className="h-3 w-3" />{entry.media.length} media</span> : null}{entry.compare && <span className="text-[10px] text-muted-foreground">comparison · {entry.compare.mode}</span>}</div></article>)}</div> : <button onClick={() => addItem(path)} className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"><Plus className="h-5 w-5" /><span>Add the first item to this category</span></button>}
        </section>
        {item && <section aria-label="Item detail" className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1"><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Item</p><Input aria-label="Item title" value={item.title} maxLength={200} onChange={event => updateItem(path, item.id, { title: event.target.value })} className="mt-1 h-auto border-none bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:ring-0" /></div><Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Close item detail" onClick={() => setActiveItem(null)}><ArrowLeft className="h-4 w-4" /></Button></div>
          <div className="mt-3 flex flex-wrap items-center gap-2"><select aria-label="Item status" value={item.status || ''} onChange={event => updateItem(path, item.id, { status: event.target.value ? event.target.value as PlanningBoardStatus : undefined })} className="h-7 rounded-lg border border-border bg-background px-2 text-[11px]"><option value="">No status</option>{statuses.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select>{item.media?.length ? <span className="text-[10px] text-muted-foreground">{countLabel(item.media.length, 'linked media file')}</span> : null}</div>
          <label className="mt-3 grid gap-1.5 text-xs font-medium">Markdown body<textarea aria-label="Item body" value={item.body || ''} onChange={event => updateItem(path, item.id, { body: event.target.value })} rows={5} className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="What should someone understand or do here?" /></label>
          {item.body?.trim() && <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"><MarkdownContent content={item.body} className="text-xs leading-6" /></div>}
          <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium">Prompt / next iteration<textarea aria-label="Item prompt" value={item.prompt || ''} onChange={event => updateItem(path, item.id, { prompt: event.target.value || undefined })} rows={3} className="resize-y rounded-lg border border-input bg-background px-3 py-2 text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label><label className="grid gap-1.5 text-xs font-medium">Source URL<Input aria-label="Item source" value={item.source || ''} onChange={event => updateItem(path, item.id, { source: event.target.value || undefined })} placeholder="https://..." className="h-9 text-xs" /></label></div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Media gallery</h3><label className="text-xs">Add file <select aria-label="Add gallery file" value="" onChange={event => { const selected = event.target.value; if (selected) updateItem(path, item.id, { media: [...(item.media || []), { path: selected }] }); }} className="ml-2 h-8 max-w-56 rounded-lg border border-input bg-background px-2 text-xs"><option value="">Choose a file</option>{assets.filter(file => !item.media?.some(media => media.path === file.path)).map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label></div>
          {!assets.length && <button type="button" onClick={onOpenFiles} className="mt-2 text-xs text-primary underline">Upload files to this plan</button>}
          {item.media?.length ? <div className="mt-2 grid gap-3 sm:grid-cols-2">{item.media.map((media, index) => <div key={media.path} className="min-w-0 rounded-xl border border-border p-3"><PlanningMedia workspaceId={workspaceId} planId={planId} path={media.path} label={media.label || media.path.split('/').pop()} alt={media.alt} /><label className="grid gap-1 text-xs">Alt text<Input aria-label={`Alt text for ${media.path}`} value={media.alt || ''} onChange={event => updateItem(path, item.id, { media: item.media?.map((entry, i) => i === index ? { ...entry, alt: event.target.value } : entry) })} className="h-8 text-xs" /></label><button type="button" className="mt-2 text-xs text-destructive underline" onClick={() => updateItem(path, item.id, { media: item.media?.filter((_, i) => i !== index) })}>Remove from gallery</button></div>)}</div> : <p className="mt-2 text-xs text-muted-foreground">No files linked to this item yet.</p>}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">{(['before', 'after'] as const).map(which => <label key={which} className="grid gap-1.5 text-xs font-medium">Comparison {which}<select aria-label={`Comparison ${which}`} value={compareDraft[which]} onChange={event => { const next = { ...compareDraft, [which]: event.target.value }; setCompareDraft(next); updateItem(path, item.id, { compare: next.before && next.after ? { mode: item.compare?.mode || 'slider', ...next } : undefined }); }} className="h-9 rounded-lg border border-input bg-background px-2 text-xs"><option value="">Choose an image</option>{compareDraft[which] && !images.some(file => file.path === compareDraft[which]) && <option value={compareDraft[which]}>{compareDraft[which]} (unavailable)</option>}{images.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>)}</div>
          {item.compare && <PlanningCompare key={`${item.compare.before}:${item.compare.after}`} workspaceId={workspaceId} planId={planId} compare={item.compare} onModeChange={mode => updateItem(path, item.id, { compare: { ...item.compare!, mode } })} />}
          {item.source && <a href={item.source} target="_blank" rel="noreferrer" className="mt-3 inline-flex text-[11px] text-primary underline-offset-4 hover:underline">Open source</a>}
        </section>}
      </div>}
    </div>
    <Dialog open={Boolean(deleting)} onOpenChange={open => { if (!open) setDeleting(null); }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Delete {deleting?.kind === 'item' ? 'item' : 'category'}?</DialogTitle><DialogDescription>{deleting ? `"${deleting.title}" will be removed from the board. Markdown bodies and media files stay in the plan folder.` : ''}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" onClick={confirmDelete}><Trash2 className="mr-2 h-4 w-4" />Delete</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

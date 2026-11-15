import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, Check, CheckCheck, Circle, CircleAlert, FileText, ImageIcon, Layers, LayoutGrid, ListChecks, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MarkdownContent } from '@/components/chat/markdown-content';
import type { PlanningBoardItem, PlanningBoardSection, PlanningBoardStatus } from '@/stores/planning-store';
import { boardStatuses, flattenBoard, type BoardEntry } from './planning-board-model';
import { PlanningMedia, usePlanningMediaUrl } from './planning-media';
import { PlanningCompare } from './planning-compare';

export const kindIcons = { section: Layers, gallery: ImageIcon, comparison: LayoutGrid, checklist: ListChecks, research: BookOpen, note: FileText };
export function BoardStatus({ status }: { status?: PlanningBoardStatus }) {
  const entry = boardStatuses.find(value => value.id === status);
  return entry ? <Badge variant={entry.variant} className="gap-1.5 whitespace-nowrap text-[10px] font-medium">{status === 'done' ? <Check className="h-3 w-3" /> : status === 'blocked' ? <CircleAlert className="h-3 w-3" /> : <Circle className="h-2 w-2 fill-current" />}{entry.label}</Badge> : null;
}

function ThumbnailImage({ workspaceId, planId, path, fit = 'cover' }: { workspaceId: string; planId: string; path: string; fit?: 'cover' | 'contain' }) {
  const { url, error, setError } = usePlanningMediaUrl(workspaceId, planId, path);
  return url && !error ? <img src={url} alt="" loading="lazy" className={`h-full w-full transition-transform duration-200 ${fit === 'contain' ? 'object-contain' : 'object-cover group-hover:scale-[1.02]'}`} onError={() => setError('Preview unavailable')} />
    : <span className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"><ImageIcon className="h-5 w-5" />{error ? 'Preview unavailable' : 'Loading preview…'}</span>;
}
export function BoardThumbnail({ className = 'aspect-[16/9]', ...props }: { workspaceId: string; planId: string; path: string; className?: string; fit?: 'cover' | 'contain' }) {
  const host = useRef<HTMLDivElement>(null); const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '200px' });
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  return <div ref={host} aria-hidden="true" className={`w-full overflow-hidden bg-muted/40 ${className}`}>{visible && <ThumbnailImage {...props} />}</div>;
}

export function BoardNavigation({ sections, path, onSelect, onDocument, onFiles, workspaceId, planId, title, cover }: {
  sections: PlanningBoardSection[]; path: string[]; onSelect: (path: string[]) => void; onDocument: () => void; onFiles: () => void; workspaceId: string; planId: string; title: string; cover?: string;
}) {
  return <nav aria-label="Plan sections" className="flex h-full min-h-0 flex-col px-3 py-5">
    <div className="mb-6 px-2">{cover && <div className="mb-3 overflow-hidden rounded-md"><BoardThumbnail workspaceId={workspaceId} planId={planId} path={cover} /></div>}<p className="break-words text-sm font-semibold leading-5">{title}</p></div>
    <button onClick={() => onSelect([])} aria-current={!path.length ? 'page' : undefined} className={`rounded-md px-2 py-1.5 text-left text-[13px] focus-visible:ring-2 focus-visible:ring-ring ${!path.length ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground'}`}>Overview</button>
    <p className="mb-2 mt-6 px-2 text-[10px] font-medium uppercase tracking-[.16em] text-muted-foreground">Project</p>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!sections.length && <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">Your plan's sections will appear here.</p>}
      {flattenBoard(sections).filter(entry => !entry.item).map(entry => {
        const selected = entry.path.join('/') === path.join('/');
        return <button key={entry.section.id} onClick={() => onSelect(entry.path)} aria-current={selected ? 'page' : undefined} title={entry.trail.join(' / ')} style={{ paddingLeft: 8 + (entry.path.length - 1) * 12 }} className={`mb-0.5 flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground'}`}><span className="truncate">{entry.section.title}</span>{entry.section.status === 'blocked' && <span aria-label="Blocked" className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}</button>;
      })}
    </div>
    <div className="mt-4 space-y-1 border-t border-border/60 pt-3">
      <button onClick={onDocument} className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Plan document</button>
      <button onClick={onFiles} className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Files & research</button>
    </div>
  </nav>;
}

export interface CardActions { onEdit: () => void; onDelete: () => void; onMove: (direction: -1 | 1) => void; onReorder: (source: string) => void; first: boolean; last: boolean; disabled?: boolean }
export function BoardActions({ title, onEdit, onDelete, onMove, first, last, disabled }: CardActions & { title: string }) {
  return <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label={`Actions for ${title}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
    <DropdownMenuItem disabled={disabled} onSelect={onEdit}><Pencil className="h-3.5 w-3.5" />Edit</DropdownMenuItem>
    <DropdownMenuItem disabled={disabled || first} onSelect={() => onMove(-1)}><ArrowUp className="h-3.5 w-3.5" />Move up</DropdownMenuItem>
    <DropdownMenuItem disabled={disabled || last} onSelect={() => onMove(1)}><ArrowDown className="h-3.5 w-3.5" />Move down</DropdownMenuItem>
    <DropdownMenuItem disabled={disabled} onSelect={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="h-3.5 w-3.5" />Delete</DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
}

export function SectionCard({ section, workspaceId, planId, onOpen, actions }: {
  section: PlanningBoardSection; workspaceId: string; planId: string; onOpen: () => void; actions: CardActions;
}) {
  const preview = section.cover || section.items?.flatMap(item => item.media || []).find(media => /\.(png|jpe?g|webp|gif)$/i.test(media.path))?.path;
  return <article draggable={!actions.disabled} onDragStart={event => { event.dataTransfer.setData('application/x-atris-section', section.id); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => { if (!actions.disabled && event.dataTransfer.types.includes('application/x-atris-section')) event.preventDefault(); }} onDrop={event => { const source = event.dataTransfer.getData('application/x-atris-section'); if (source && !actions.disabled) { event.preventDefault(); actions.onReorder(source); } }} className="group flex min-w-0 flex-col overflow-hidden">
    {preview && <button onClick={onOpen} aria-label={`Open ${section.title}`} className="block focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><BoardThumbnail workspaceId={workspaceId} planId={planId} path={preview} /></button>}
    <div className="flex items-start gap-2 py-3">
      <button onClick={onOpen} className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><h3 className="break-words text-sm font-semibold leading-6 group-hover:text-primary">{section.title}</h3>{(section.summary || section.body) && <p className="mt-1 line-clamp-3 text-[13px] leading-6 text-muted-foreground">{section.summary || section.body}</p>}</button>
      <div className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"><BoardActions title={section.title} {...actions} /></div>
    </div>
  </article>;
}

export function BoardOverview({ title, entries, workspaceId, planId, summary, cover: projectCover }: { title: string; entries: BoardEntry[]; workspaceId: string; planId: string; summary?: string; cover?: string }) {
  const cover = projectCover || entries.find(entry => !entry.item && entry.section.cover)?.section.cover;
  return <header className="mb-8">
    {cover && <div className="mb-6 overflow-hidden rounded-lg"><BoardThumbnail workspaceId={workspaceId} planId={planId} path={cover} fit="contain" className="aspect-[21/8] min-h-32 max-h-72" /></div>}
    <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{title}</h1>
    {summary && <MarkdownContent content={summary} className="mt-3 text-[14px] leading-7 text-muted-foreground" />}
  </header>;
}

export function ItemReading({ item, workspaceId, planId, onCompareMode }: { item: PlanningBoardItem; workspaceId: string; planId: string; onCompareMode: (mode: 'slider' | 'side-by-side') => void }) {
  return <div className="space-y-5">
    {item.compare && <PlanningCompare workspaceId={workspaceId} planId={planId} compare={item.compare} onModeChange={onCompareMode} />}
    {Boolean(item.media?.length) && <div className="grid gap-4 @min-[700px]/board:grid-cols-2">{item.media!.map(media => <PlanningMedia key={media.path} workspaceId={workspaceId} planId={planId} path={media.path} label={media.label} alt={media.alt} />)}</div>}
    {item.body ? <MarkdownContent content={item.body} className="text-[13px] leading-7" /> : <p className="text-sm text-muted-foreground">No description yet. Edit this item to add context.</p>}
    {item.source && <a href={item.source} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-2 break-all text-xs text-primary underline-offset-4 hover:underline"><BookOpen className="h-3.5 w-3.5 shrink-0" />{item.source}</a>}
    {item.prompt && <details className="rounded-lg border border-border/70 px-4 py-3"><summary className="cursor-pointer text-xs font-medium">Prompt / next iteration</summary><p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-muted-foreground">{item.prompt}</p></details>}
    {item.status === 'done' && <p className="flex items-center gap-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground"><CheckCheck className="h-3.5 w-3.5" />Marked done in this plan. Execution verification is tracked separately.</p>}
  </div>;
}

export function SectionItems({ section, workspaceId, planId, onOpen, onToggle, actions, disabled }: {
  section: PlanningBoardSection; workspaceId: string; planId: string; onOpen: (item: PlanningBoardItem) => void;
  onToggle: (item: PlanningBoardItem, done: boolean) => void; actions: (item: PlanningBoardItem, index: number) => CardActions; disabled: boolean;
}) {
  const items = section.items || [], checklist = section.kind === 'checklist', prose = !['gallery', 'comparison'].includes(section.kind);
  if (!items.length) return null;
  return <div className={prose ? 'divide-y divide-border/40' : 'grid gap-5 @min-[600px]/board:grid-cols-2 @min-[1150px]/board:grid-cols-3'}>{items.map((item, index) => {
    const preview = item.media?.find(media => /\.(png|jpe?g|webp|gif)$/i.test(media.path))?.path || item.compare?.after;
    return <article key={item.id} draggable={!disabled} onDragStart={event => { event.dataTransfer.setData('application/x-atris-item', item.id); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => { if (!disabled && event.dataTransfer.types.includes('application/x-atris-item')) event.preventDefault(); }} onDrop={event => { const source = event.dataTransfer.getData('application/x-atris-item'); if (source && !disabled) { event.preventDefault(); actions(item, index).onReorder(source); } }} className={prose ? 'group flex min-w-0 items-start gap-3 py-4' : 'group min-w-0 overflow-hidden'}>
      {checklist && <input type="checkbox" aria-label={`Mark ${item.title} done`} checked={item.status === 'done'} disabled={disabled} onChange={event => onToggle(item, event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-primary" />}
      {!checklist && !prose && preview && <button onClick={() => onOpen(item)} aria-label={`Open ${item.title}`} className="block w-full focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><BoardThumbnail workspaceId={workspaceId} planId={planId} path={preview} /></button>}
      <div className={`min-w-0 flex-1 ${prose ? '' : 'pt-3'}`}><div className="flex items-start justify-between gap-2"><button onClick={() => onOpen(item)} className="min-w-0 rounded text-left focus-visible:ring-2 focus-visible:ring-ring"><h3 className={`break-words text-sm font-medium leading-6 ${item.status === 'done' && checklist ? 'text-muted-foreground line-through' : 'group-hover:text-primary'}`}>{item.title}</h3>{item.body && <p className={`mt-1 text-[13px] leading-6 text-muted-foreground ${prose ? 'line-clamp-4' : 'line-clamp-2'}`}>{item.body}</p>}</button><div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"><BoardActions title={item.title} {...actions(item, index)} /></div></div>
        {['blocked', 'review'].includes(item.status || '') && <div className="mt-2"><BoardStatus status={item.status} /></div>}
      </div>
    </article>;
  })}</div>;
}

export function BoardSearchResults({ entries, onOpen }: { entries: BoardEntry[]; onOpen: (entry: BoardEntry) => void }) {
  return <section aria-label="Search results"><h2 className="mb-4 text-lg font-semibold">Search results <span className="text-sm font-normal text-muted-foreground">{entries.length}</span></h2>{!entries.length ? <p role="status" className="py-8 text-sm text-muted-foreground">No matching content. Try a different phrase or status.</p> : <div className="divide-y divide-border/50">{entries.map(entry => <button key={entry.item?.id || entry.section.id} onClick={() => onOpen(entry)} className="flex w-full items-center gap-4 rounded px-2 py-3 text-left hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{(entry.item || entry.section).title}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{entry.trail.join(' / ')}</span></span><ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /></button>)}</div>}</section>;
}

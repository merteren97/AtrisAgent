import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { documentKey, usePlanningStore, type PlanningBoardItem, type PlanningBoardSection, type PlanningBoardStatus, type PlanningFile } from '@/stores/planning-store';
import { boardKinds, boardStatuses } from './planning-board-model';
import { PlanningMedia } from './planning-media';

const selectClass = 'h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring';
const textClass = 'w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-[13px] leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring';
export function StatusSelect({ value, onChange }: { value?: PlanningBoardStatus; onChange: (value: PlanningBoardStatus | undefined) => void }) {
  return <label className="grid gap-1.5 text-xs font-medium">Status<select aria-label="Content status" value={value || ''} onChange={event => onChange((event.target.value || undefined) as PlanningBoardStatus | undefined)} className={selectClass}><option value="">No status</option>{boardStatuses.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}</select></label>;
}
export function SectionEditor({ section, files, onChange }: { section: PlanningBoardSection; files: PlanningFile[]; onChange: (patch: Partial<PlanningBoardSection>) => void }) {
  const images = files.filter(file => file.path.startsWith('assets/') && file.mimeType.startsWith('image/'));
  return <div className="space-y-5 rounded-xl border border-primary/20 bg-muted/10 p-5">
    <label className="grid gap-1.5 text-xs font-medium">Title<Input aria-label="Category title" value={section.title} maxLength={200} onChange={event => onChange({ title: event.target.value })} /></label>
    <div className="grid gap-4 @min-[550px]/board:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium">View type<select aria-label="Category kind" value={section.kind} onChange={event => onChange({ kind: event.target.value as PlanningBoardSection['kind'] })} className={selectClass}>{boardKinds.map(kind => <option key={kind.id} value={kind.id}>{kind.label}</option>)}</select></label><StatusSelect value={section.status} onChange={status => onChange({ status })} /></div>
    <label className="grid gap-1.5 text-xs font-medium">Summary<textarea aria-label="Category summary" value={section.summary || ''} maxLength={2000} rows={2} onChange={event => onChange({ summary: event.target.value || undefined })} className={textClass} /></label>
    <label className="grid gap-1.5 text-xs font-medium">Cover image<select aria-label="Cover image" value={section.cover || ''} onChange={event => onChange({ cover: event.target.value || undefined })} className={selectClass}><option value="">No cover</option>{section.cover && !images.some(file => file.path === section.cover) && <option value={section.cover}>{section.cover} (unavailable)</option>}{images.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>
    <label className="grid gap-1.5 text-xs font-medium">Content · Markdown<textarea aria-label="Category body" value={section.body || ''} rows={8} onChange={event => onChange({ body: event.target.value })} className={`${textClass} font-mono text-xs`} placeholder="Context, decisions and links for this section." /></label>
    <p className="text-[11px] text-muted-foreground">Changes save automatically. Switch to reading to preview this section.</p>
  </div>;
}
export function ItemEditor({ item, workspaceId, planId, files, onChange, onFiles }: { item: PlanningBoardItem; workspaceId: string; planId: string; files: PlanningFile[]; onChange: (patch: Partial<PlanningBoardItem>) => void; onFiles: () => void }) {
  const locationKey = documentKey(workspaceId, planId, 'location');
  const comparisonDraft = usePlanningStore.getState().locations[locationKey]?.comparisonDrafts?.[item.id];
  const onComparisonDraft = (draft: { before: string; after: string }) => {
    const store = usePlanningStore.getState();
    store.setLocation(locationKey, { comparisonDrafts: { ...store.locations[locationKey]?.comparisonDrafts, [item.id]: draft } });
  };
  const assets = files.filter(file => file.path.startsWith('assets/')), images = assets.filter(file => file.mimeType.startsWith('image/'));
  const [compare, setCompare] = useState(comparisonDraft || { before: item.compare?.before || '', after: item.compare?.after || '' });
  useEffect(() => { setCompare(item.compare ? { before: item.compare.before, after: item.compare.after } : comparisonDraft || { before: '', after: '' }); }, [item.id, item.compare?.before, item.compare?.after]);
  return <div className="space-y-5 rounded-xl border border-primary/20 bg-muted/10 p-5">
    <label className="grid gap-1.5 text-xs font-medium">Title<Input aria-label="Item title" value={item.title} maxLength={200} onChange={event => onChange({ title: event.target.value })} /></label>
    <StatusSelect value={item.status} onChange={status => onChange({ status })} />
    <label className="grid gap-1.5 text-xs font-medium">Content · Markdown<textarea aria-label="Item body" value={item.body || ''} rows={8} onChange={event => onChange({ body: event.target.value })} className={`${textClass} font-mono text-xs`} /></label>
    <label className="grid gap-1.5 text-xs font-medium">Prompt / next iteration<textarea aria-label="Item prompt" value={item.prompt || ''} rows={3} onChange={event => onChange({ prompt: event.target.value || undefined })} className={textClass} /></label>
    <label className="grid gap-1.5 text-xs font-medium">Source URL<Input aria-label="Item source" value={item.source || ''} onChange={event => onChange({ source: event.target.value || undefined })} placeholder="https://…" /></label>
    <section><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Media gallery</h3><button onClick={onFiles} className="text-xs text-primary underline-offset-4 hover:underline">Upload files</button></div>
      <select aria-label="Add gallery file" value="" className={selectClass} onChange={event => { if (event.target.value) onChange({ media: [...(item.media || []), { path: event.target.value }] }); }}><option value="">Link a file…</option>{assets.filter(file => !item.media?.some(media => media.path === file.path)).map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select>
      {item.media?.map((media, index) => <div key={media.path} className="mt-3 rounded-lg border border-border p-3"><PlanningMedia workspaceId={workspaceId} planId={planId} path={media.path} label={media.label} alt={media.alt} /><label className="grid gap-1.5 text-xs">Alt text<Input aria-label={`Alt text for ${media.path}`} value={media.alt || ''} onChange={event => onChange({ media: item.media?.map((entry, i) => i === index ? { ...entry, alt: event.target.value } : entry) })} /></label><button className="mt-3 text-xs text-destructive" onClick={() => onChange({ media: item.media?.filter((_, i) => i !== index) })}>Remove from gallery</button></div>)}
    </section>
    <section><h3 className="mb-3 text-sm font-semibold">Before / after comparison</h3><div className="grid gap-4 @min-[550px]/board:grid-cols-2">{(['before', 'after'] as const).map(which => <label key={which} className="grid gap-1.5 text-xs font-medium">{which === 'before' ? 'Before' : 'After'}<select aria-label={`Comparison ${which}`} value={compare[which]} className={selectClass} onChange={event => { const next = { ...compare, [which]: event.target.value }; setCompare(next); onComparisonDraft(next); onChange({ compare: next.before && next.after ? { mode: item.compare?.mode || 'slider', ...next } : undefined }); }}><option value="">Choose an image…</option>{compare[which] && !images.some(file => file.path === compare[which]) && <option value={compare[which]}>{compare[which]} (unavailable)</option>}{images.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>)}</div>{Boolean(compare.before) !== Boolean(compare.after) && <p className="mt-2 text-[11px] text-muted-foreground">Choose both images to publish the comparison. Your partial selection is saved on this device.</p>}</section>
    <p className="text-[11px] text-muted-foreground">Changes save automatically. Switch to reading to preview this item.</p>
  </div>;
}

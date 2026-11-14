import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Code2, Eye, FileWarning, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { ApiError, apiRequest } from '@/lib/api-client';
import { documentKey, planApi, usePlanningStore, type DocumentVersion } from '@/stores/planning-store';
import { PlanningMedia } from './planning-media';

export function resolvePlanningLink(documentPath: string, link: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(link); } catch { return null; }
  if (/^[a-z][\w+.-]*:|^[\\/]|[\\\x00-\x1f]/i.test(decoded)) return null;
  const parts = documentPath.split('/').slice(0, -1);
  for (const part of decoded.split('/')) { if (part === '..') { if (!parts.length) return null; parts.pop(); } else if (part && part !== '.') parts.push(part); }
  const path = parts.join('/');
  return path === 'plan.md' || /^(research|assets)\//.test(path) ? path : null;
}

export function PlanningMarkdown({ content, workspaceId, planId, path, onTask }: { content: string; workspaceId: string; planId: string; path: string; onTask?: (line: number, checked: boolean) => void }) {
  const nodes: ReactNode[] = []; let buffer: string[] = []; let fenced = false;
  const flush = () => { if (buffer.length) { nodes.push(<MarkdownContent key={`text-${nodes.length}`} content={buffer.join('\n')} className="text-sm leading-7 [&_p]:leading-7 [&>div.font-semibold]:mt-6 [&>div.font-semibold]:text-lg" />); buffer = []; } };
  content.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced) {
      const task = /^\s*[-*+] \[([ xX])\]\s+(.*)$/.exec(line);
      if (task) { flush(); nodes.push(<label key={`task-${index}`} className="my-2 flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1.5 h-3.5 w-3.5 accent-primary" checked={task[1].toLowerCase() === 'x'} disabled={!onTask} onChange={event => onTask?.(index, event.target.checked)} /><MarkdownContent content={task[2]} /></label>); return; }
      const match = /^\s*!?\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
      const local = match ? resolvePlanningLink(path, match[2]) : null;
      if (match && local && /\.(png|jpe?g|gif|webp|mp4|webm|mov|mp3|wav|ogg)$/i.test(local)) { flush(); nodes.push(<PlanningMedia key={`media-${index}-${local}`} workspaceId={workspaceId} planId={planId} path={local} label={match[1]} />); return; }
    }
    buffer.push(line);
  });
  flush();
  return <div className="min-w-0 space-y-3">{nodes}</div>;
}

export function PlanningDocumentEditor({ workspaceId, planId, path, refreshKey, onStatus, onOpen }: {
  workspaceId: string; planId: string; path: string; refreshKey: number;
  onStatus: (status: string) => void; onOpen: (path: string) => void;
}) {
  const key = documentKey(workspaceId, planId, path);
  const draft = usePlanningStore(state => state.drafts[key]);
  const [version, setVersion] = useState<DocumentVersion | null>(null);
  const [mode, setMode] = useState<'preview' | 'edit'>(draft ? 'edit' : 'preview');
  const [error, setError] = useState(''); const [conflict, setConflict] = useState(false); const [review, setReview] = useState(false); const [saving, setSaving] = useState(false);
  const alive = useRef(true); const busy = useRef(false);
  const requestGeneration = useRef(0);
  const endpoint = `${planApi(workspaceId, planId)}/document?path=${encodeURIComponent(path)}`;
  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const latest = await apiRequest<DocumentVersion>(endpoint);
      if (!alive.current || generation !== requestGeneration.current) return;
      const currentDraft = usePlanningStore.getState().drafts[key];
      setVersion(latest);
      if (currentDraft?.content === latest.content) { usePlanningStore.getState().clearDraft(key, currentDraft.content); setConflict(false); }
      else setConflict(Boolean(currentDraft && currentDraft.baseRevision !== latest.revision));
    } catch (cause) { if (alive.current && generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : 'Could not load document.'); }
  }, [endpoint, key]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; requestGeneration.current++; }; }, [load]);
  useEffect(() => { void load(); }, [refreshKey, load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && !busy.current) void load(); };
    const timer = setInterval(refresh, 5_000); window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);
  const edit = (content: string) => {
    const current = usePlanningStore.getState().drafts[key];
    if (!version) return;
    setError('');
    usePlanningStore.getState().setDraft(key, { content, baseContent: current?.baseContent ?? version.content, baseRevision: current?.baseRevision ?? version.revision });
  };
  const save = useCallback(async (revision?: string) => {
    const current = usePlanningStore.getState().drafts[key];
    if (!current || busy.current) return;
    busy.current = true; setSaving(true); setError(''); requestGeneration.current++;
    try {
      const saved = await apiRequest<DocumentVersion>(endpoint, { method: 'PUT', body: JSON.stringify({ content: current.content, expectedRevision: revision || current.baseRevision }) });
      if (!alive.current) return;
      const newer = usePlanningStore.getState().drafts[key];
      if (newer && newer.content !== current.content) usePlanningStore.getState().setDraft(key, { ...newer, baseContent: saved.content, baseRevision: saved.revision });
      else usePlanningStore.getState().clearDraft(key, current.content);
      setVersion(saved); setConflict(false); setReview(false);
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : 'Could not save document. Your draft is kept.');
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); void load(); }
    } finally { busy.current = false; if (alive.current) setSaving(false); }
  }, [endpoint, key, load]);
  useEffect(() => {
    if (!draft || conflict || error || saving || !version) return;
    const timer = setTimeout(() => void save(), 1_100); return () => clearTimeout(timer);
  }, [draft, conflict, error, saving, version, save]);
  useEffect(() => { onStatus(saving ? 'Saving…' : conflict ? 'External changes' : error ? 'Save needs attention' : draft ? 'Unsaved draft' : version ? 'Saved locally' : 'Loading…'); }, [saving, conflict, error, draft, version, onStatus]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (conflict) setReview(true); else void save(); } };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, [save, conflict]);
  const recover = async () => {
    if (!draft) return;
    const nextPath = `research/recovered-${Date.now()}.md`;
    try { await apiRequest(`${planApi(workspaceId, planId)}/document?path=${encodeURIComponent(nextPath)}`, { method: 'PUT', body: JSON.stringify({ content: draft.content, expectedRevision: null }) }); usePlanningStore.getState().clearDraft(key, draft.content); setReview(false); onOpen(nextPath); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save recovery copy.'); }
  };
  const content = draft?.content ?? version?.content ?? '';
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70 px-5 py-2">
      <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={path}>{path}</span>
      <div className="flex items-center gap-1"><div className="flex rounded-lg bg-muted/50 p-0.5">{(['preview', 'edit'] as const).map(view => <Button key={view} size="sm" variant={mode === view ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs" aria-pressed={mode === view} onClick={() => setMode(view)}>{view === 'preview' ? <Eye className="mr-1.5 h-3 w-3" /> : <Code2 className="mr-1.5 h-3 w-3" />}{view === 'preview' ? 'Preview' : 'Markdown'}</Button>)}</div><Button size="sm" variant="ghost" className="h-7 text-xs" disabled={!draft || saving} onClick={() => conflict ? setReview(true) : void save()}>{saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Save className="mr-1.5 h-3 w-3" />}Save</Button></div>
    </div>
    {(conflict || error) && <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-5 py-3 text-xs"><span className="flex items-start gap-2"><FileWarning className="h-4 w-4 shrink-0 text-amber-500" />{conflict ? 'This file changed on disk. Your draft is preserved.' : error}</span>{conflict ? <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setReview(true)}>Compare changes</Button> : <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => version ? void save() : void load()}>Retry</Button>}</div>}
    {!version ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading document…</div>
      : mode === 'edit' ? <textarea aria-label={`Edit ${path}`} spellCheck={false} value={content} onChange={event => edit(event.target.value)} className="min-h-0 w-full flex-1 resize-none bg-transparent px-6 py-6 font-mono text-[13px] leading-7 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" />
        : <div className="min-h-0 flex-1 overflow-y-auto select-text"><article className="mx-auto w-full max-w-[780px] px-7 py-8 sm:px-10"><PlanningMarkdown content={content} workspaceId={workspaceId} planId={planId} path={path} onTask={(index, checked) => { const lines = content.split('\n'); lines[index] = lines[index].replace(/\[([ xX])\]/, checked ? '[x]' : '[ ]'); edit(lines.join('\n')); }} /><div className="mt-10 flex items-center gap-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground"><Check className="h-3 w-3" />Markdown file · Stored in this workspace</div></article></div>}
    <Dialog open={review} onOpenChange={setReview}><DialogContent className="flex max-h-[85vh] w-[calc(100vw-3rem)] max-w-5xl flex-col sm:max-w-5xl"><DialogTitle>Review external changes</DialogTitle><DialogDescription>Compare the latest saved file with your draft before replacing anything.</DialogDescription><div className="grid min-h-0 flex-1 gap-4 overflow-auto sm:grid-cols-2"><section><h3 className="mb-2 text-xs font-semibold">Latest on disk</h3><pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-xs leading-6">{version?.content}</pre></section><section><h3 className="mb-2 text-xs font-semibold">Your draft</h3><pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-xs leading-6">{draft?.content}</pre></section></div><div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => { usePlanningStore.getState().clearDraft(key); setConflict(false); setError(''); setReview(false); }}>Use disk version</Button><Button size="sm" variant="outline" onClick={() => void recover()}>Save draft as a new note</Button><Button size="sm" disabled={saving || !version} onClick={() => void save(version!.revision)}>Replace with my draft</Button></div></DialogContent></Dialog>
  </div>;
}

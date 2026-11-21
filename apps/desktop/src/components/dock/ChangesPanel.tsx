import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronRight, FileCode2, FileDiff, Loader2, RefreshCw, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useManualStore } from '@/stores/manual-store';
import { useMissionStore } from '@/stores/mission-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useSettingsStore } from '@/stores/settings-store';
import { textRows, unifiedRows, type DiffRow } from './change-diff';
import { t, useLanguageStore } from '@/stores/language-store';

export type ReviewFile = { path: string; status: string; additions?: number; deletions?: number; state?: string; issue?: string };
type ChangeFile = ReviewFile & { revision?: string };
type ChangeListData = { mode: 'isolated' | 'direct' | 'live' | 'staged'; quality?: 'pending' | 'verified' | 'failed'; files: ChangeFile[]; omitted?: number; error?: string };
type FileDiffData = { before: string | null; after: string | null } | { unavailable: 'binary' | 'large' } | { diff: string };
type ChangeAction = 'apply' | 'discard' | 'undo';
const listCache = new Map<string, ChangeListData>();
const previewCache = new Map<string, FileDiffData>();
function cache<T>(entries: Map<string, T>, key: string, value: T, limit: number) {
  entries.delete(key); entries.set(key, value);
  if (entries.size > limit) entries.delete(entries.keys().next().value!);
}

export function ReviewEmpty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-36 flex-1 flex-col items-center justify-center gap-2 p-5 text-center text-xs text-muted-foreground"><FileDiff className="size-6 opacity-40" />{children}</div>;
}

const states: Record<string, [string, string]> = {
  added: ['Added', 'text-emerald-700 dark:text-emerald-400'],
  deleted: ['Deleted', 'text-rose-700 dark:text-rose-400'],
  modified: ['Modified', 'text-amber-700 dark:text-amber-400'],
  renamed: ['Renamed', 'text-sky-700 dark:text-sky-400'],
};
const checkboxStyle = 'size-4 accent-primary dark:[color-scheme:dark]';

export function ReviewFiles({ files, opened, selected, onToggle, canSelect, onOpen }: { files: ReviewFile[]; opened?: string; selected?: ReadonlySet<string>; onToggle?: (file: ReviewFile) => void; canSelect?: (file: ReviewFile) => boolean; onOpen: (file: ReviewFile) => void }) {
  return <ul className="space-y-0.5 p-1.5">
    {files.map(file => {
      const [status, color] = states[file.status] || states.modified;
      const slash = file.path.lastIndexOf('/');
      return <li key={file.path} className={cn('flex min-w-0 items-center rounded-md hover:bg-muted/60', opened === file.path && 'bg-accent')}>
        {onToggle && <label className="flex size-9 shrink-0 items-center justify-center rounded-md"><input type="checkbox" aria-label={`Select ${file.path}`} disabled={canSelect ? !canSelect(file) : false} checked={selected?.has(file.path) || false} onChange={() => onToggle(file)} className={checkboxStyle} /></label>}
        <button type="button" aria-current={opened === file.path || undefined} title={`${status} · ${file.path}`} onClick={() => onOpen(file)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', color)} aria-label={status}>{status[0]}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{file.path.slice(slash + 1)}</span>{slash >= 0 && <span className="block truncate text-[11px] text-muted-foreground">{file.path.slice(0, slash)}</span>}
            {file.state === 'conflict' && <span className="block truncate text-[11px] text-destructive">{t('Conflict')}</span>}
            {file.state === 'reverted' && <span className="block truncate text-[11px] text-muted-foreground">{t('Undone')}</span>}
          </span>
          {Boolean(file.additions || file.deletions) && <span className="shrink-0 font-mono text-[10px]"><span className="text-emerald-700 dark:text-emerald-400">+{file.additions || 0}</span>{' '}<span className="text-rose-700 dark:text-rose-400">−{file.deletions || 0}</span></span>}
          <ChevronRight className="size-3 shrink-0 text-muted-foreground @[820px]/review:hidden" />
        </button>
      </li>;
    })}
  </ul>;
}

const rowColor = { add: 'bg-emerald-500/10 text-emerald-900 dark:text-emerald-200', remove: 'bg-rose-500/10 text-rose-900 dark:text-rose-200', context: '' };
function CodeLine({ row, number }: { row?: DiffRow; number?: number }) {
  return <div className={cn('flex min-w-0 items-start', row ? rowColor[row.kind] : 'bg-muted/25')}>
    <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground" aria-hidden="true">{number}</span>
    <span className="w-4 shrink-0 select-none text-center" aria-hidden="true">{row?.kind === 'add' ? '+' : row?.kind === 'remove' ? '−' : ''}</span>
    <code className="min-w-0 flex-1 select-text whitespace-pre-wrap break-all px-1">{row?.text || ' '}</code>
  </div>;
}

export function CodeReview({ rows }: { rows: DiffRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const chunks = useMemo(() => {
    const result: Array<{ kind: 'context' | 'edit' | 'hunk'; rows: DiffRow[] }> = [];
    for (const row of rows) {
      const kind = row.hunk ? 'hunk' : row.kind === 'context' ? 'context' : 'edit';
      const last = result[result.length - 1];
      if (last?.kind === kind && kind !== 'hunk') last.rows.push(row);
      else result.push({ kind, rows: [row] });
    }
    return result;
  }, [rows]);
  if (!rows.length) return <ReviewEmpty>No line changes to display. The file may be empty, or only its line endings or permissions changed.</ReviewEmpty>;
  const lineLimit = 3000;
  const foldable = chunks.some(chunk => chunk.kind === 'context' && chunk.rows.length > 8);
  return <div className="min-w-0 font-mono text-[11px] leading-5 sm:text-xs @[960px]/review:text-[13px] @[960px]/review:leading-6" aria-label="Code comparison">
    <div className="sticky top-0 z-[1] flex justify-between border-b bg-card px-3 py-1.5 font-sans text-[11px] font-medium text-muted-foreground"><span className="@[960px]/review:hidden">Inline changes</span><span className="hidden w-1/2 @[960px]/review:block">Before</span><span className="hidden flex-1 @[960px]/review:block">After</span>{foldable && <button type="button" className="whitespace-nowrap text-foreground underline-offset-2 hover:underline" onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide context' : 'Show context'}</button>}</div>
    {(() => {
      let budget = lineLimit;
      return chunks.map(({ kind, rows: group }, index) => {
        if (budget <= 0) return null;
        if (kind === 'hunk') return <div key={index} className="bg-primary/5 px-3 py-1 text-[10px] text-muted-foreground">{group[0].text}</div>;
        const collapsed = kind === 'context' && !expanded && group.length > 8;
        const visible = (collapsed ? [...group.slice(0, 3), ...group.slice(-3)] : group).slice(0, budget);
        budget -= visible.length;
        if (kind === 'context') return <div key={index}>{visible.map((row, at) => <div key={at}>
          {collapsed && at === 3 && <button type="button" onClick={() => setExpanded(true)} className="block w-full bg-muted/50 px-2 text-center text-[10px] text-muted-foreground hover:bg-muted">{group.length - 6} unchanged lines</button>}
          <div className="@[960px]/review:hidden"><CodeLine row={row} number={row.after} /></div><div className="hidden grid-cols-2 divide-x @[960px]/review:grid"><CodeLine row={row} number={row.before} /><CodeLine row={row} number={row.after} /></div>
        </div>)}</div>;
        const left = visible.filter(row => row.kind === 'remove'), right = visible.filter(row => row.kind === 'add');
        return <div key={index}>
          <div className="@[960px]/review:hidden">{visible.map((row, at) => <CodeLine key={at} row={row} number={row.before ?? row.after} />)}</div>
          <div className="hidden divide-y divide-border/25 @[960px]/review:block">{Array.from({ length: Math.max(left.length, right.length) }, (_, at) => <div key={at} className="grid grid-cols-2 divide-x"><CodeLine row={left[at]} number={left[at]?.before} /><CodeLine row={right[at]} number={right[at]?.after} /></div>)}</div>
        </div>;
      });
    })()}
    {rows.length > lineLimit && <p className="border-t px-3 py-2 font-sans text-muted-foreground">Large comparison · up to {lineLimit.toLocaleString()} lines are shown at once.</p>}
  </div>;
}

export function ReviewLayout({ list, detail, opened, onBack }: { list: ReactNode; detail: ReactNode; opened?: string; onBack: () => void }) {
  return <div className="flex min-h-0 flex-1 overflow-hidden @[820px]/review:grid @[820px]/review:grid-cols-[minmax(235px,290px)_minmax(0,1fr)]">
    <div className={cn('min-w-0 flex-1 overflow-auto @[820px]/review:block @[820px]/review:border-r', opened && 'hidden')}>{list}</div>
    <div className={cn('min-w-0 flex-1 flex-col overflow-hidden @[820px]/review:flex', opened ? 'flex' : 'hidden')}>
      {opened ? <><div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5"><Button variant="ghost" size="icon" onClick={onBack} className="size-7 @[820px]/review:hidden" aria-label="Back to changed files"><ArrowLeft className="size-4" /></Button><FileCode2 className="size-3.5 shrink-0 text-muted-foreground" /><span title={opened} className="min-w-0 truncate font-mono text-[11px]">{opened}</span></div><div className="min-h-0 flex-1 overflow-auto">{detail}</div></> : <ReviewEmpty>Select a file to review its changes.</ReviewEmpty>}
    </div>
  </div>;
}

export function ChangesList({ root, title, project, builder = false }: { root: string; title?: string; project?: string; builder?: boolean }) {
  useLanguageStore(state => state.language);
  const [data, setData] = useState(() => listCache.get(root));
  const [request, refresh] = useState(0);
  const [opened, open] = useState<string>();
  const [selected, select] = useState<Map<string, string>>(() => new Map());
  const [loadError, setLoadError] = useState('');
  const [actionStatus, setActionStatus] = useState<{ text: string; error?: boolean }>();
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<{ action: ChangeAction; files: ChangeFile[] }>();
  const files = data?.files || [];
  const current = files.find(file => file.path === opened);
  const previewKey = current && JSON.stringify([root, current.path, current.revision]);
  const [preview, setPreview] = useState<{ key: string; data?: FileDiffData; error?: string }>();
  const [previewRequest, retryPreview] = useState(0);
  const shownPreview = previewKey && current?.revision && previewCache.get(previewKey) || (preview?.key === previewKey ? preview?.data : undefined);
  const rows = useMemo(() => shownPreview && 'before' in shownPreview ? textRows(shownPreview.before, shownPreview.after)
    : shownPreview && 'diff' in shownPreview ? [...unifiedRows(shownPreview.diff).values()].flat() : [], [shownPreview]);
  const selectable = files.filter(file => file.revision && (data?.mode !== 'live' || file.state === 'published' || file.state === 'reverting'));
  const visibleSelection = selectable.filter(file => selected.get(file.path) === file.revision);
  const selectedPaths = new Set(visibleSelection.map(file => file.path));
  const selectablePaths = new Set(selectable.map(file => file.path));

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let refreshInterval = 5000;
    const load = async () => {
      try {
        const result = await apiRequest<ChangeListData>(root, { signal: controller.signal, cache: 'no-store' });
        if (!Array.isArray(result?.files)) throw new Error('Changes are unavailable in the current runtime.');
        if (!controller.signal.aborted) {
          refreshInterval = result.mode === 'live' ? 1800 : 5000;
          const previous = listCache.get(root);
          const next = previous && JSON.stringify(previous) === JSON.stringify(result) ? previous : result;
          cache(listCache, root, next, 24);
          setData(next); setLoadError('');
        }
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Changes could not be loaded.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, refreshInterval);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [root, request]);

  useEffect(() => {
    if (!current || !previewKey || current.state === 'conflict' && !current.revision) return;
    if (current.revision && previewCache.has(previewKey)) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ path: current.path, revision: current.revision || '' });
    void apiRequest<FileDiffData>(`${root}/file?${query}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) {
        if (current.revision) cache(previewCache, previewKey, result, 24);
        setPreview({ key: previewKey, data: result });
      }
    }, error => {
      if (!controller.signal.aborted) setPreview({ key: previewKey, error: error.message });
    });
    return () => controller.abort();
  }, [root, previewKey, current?.state, previewRequest]);

  const resolve = async () => {
    if (!confirm || pending) return;
    const { action, files: targets } = confirm;
    setPending(true); setConfirm(undefined); setActionStatus(undefined);
    try {
      const result = await apiRequest<{ completed: string[]; error?: string; conflicts?: Array<{ path: string; reason: string }> }>(`${root}/resolve`, { method: 'POST', body: JSON.stringify({ action, files: targets.map(({ path, revision }) => ({ path, revision })) }) });
      const verb = action === 'apply' ? 'Applied' : action === 'discard' ? 'Discarded' : t('Undone');
      const issue = result.error || result.conflicts?.map(item => `${item.path}: ${item.reason}`).join('\n');
      setActionStatus(issue ? { text: `${verb} ${result.completed.length}/${targets.length}.\n${issue}`, error: true } : { text: `${verb}: ${result.completed.length}` });
      select(new Map());
      if (opened && result.completed.includes(opened)) open(undefined);
    } catch (error) { setActionStatus({ text: error instanceof Error ? error.message : 'The selected changes could not be updated.', error: true }); }
    finally { setPending(false); refresh(value => value + 1); }
  };

  const show = (action: ChangeAction, targets: ChangeFile[]) => setConfirm({ action, files: targets });
  const blocked = pending || Boolean(loadError);
  return <div className="@container/review flex h-full min-h-0 min-w-0 flex-col">
    <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
      <div className="min-w-0">{title && <p className="truncate text-xs font-semibold" title={title}>{title}</p>}
        <p className="truncate text-[11px] text-muted-foreground">{data?.mode === 'live' ? t('Live in project') : project ?? t('Staged changes')}</p></div>
      <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Refresh changes" title="Refresh changes" onClick={() => { refresh(value => value + 1); retryPreview(value => value + 1); }}><RefreshCw className="size-3.5" /></Button>
    </header>
    {builder && data?.mode === 'live' && <p role="status" className={cn('border-b px-3 py-2 text-xs', data.quality === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
      {t(data.quality === 'failed' ? 'Verification failed' : data.quality === 'verified' ? 'Verified' : 'Awaiting verification')}
    </p>}
    {(loadError || data?.error) && <p role="alert" className="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">{loadError || data?.error}</p>}
    {actionStatus && <p role={actionStatus.error ? 'alert' : 'status'} className={cn('max-h-28 overflow-y-auto whitespace-pre-wrap break-words border-b px-3 py-2 text-xs', actionStatus.error ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400')}>{actionStatus.text}</p>}
    {!data ? <ReviewEmpty>{!loadError && t('Loading changes…')}</ReviewEmpty> : data.mode === 'direct' ? <ReviewEmpty><strong className="text-foreground">Direct workspace session</strong><p>This older conversation does not record undo history.</p></ReviewEmpty> : !files.length ? <ReviewEmpty><strong className="text-foreground">{t('No changes yet')}</strong></ReviewEmpty> : <>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">{selectable.length > 0 && <label className="flex items-center gap-2"><input type="checkbox" className={checkboxStyle} checked={visibleSelection.length === selectable.length} ref={input => { if (input) input.indeterminate = visibleSelection.length > 0 && visibleSelection.length < selectable.length; }} onChange={event => select(event.target.checked ? new Map(selectable.map(file => [file.path, file.revision!])) : new Map())} />{t('Select all')}</label>}<span className="ml-auto tabular-nums">{visibleSelection.length ? `${visibleSelection.length} / ` : ''}{files.length}</span></div>
      <ReviewLayout opened={current?.path} onBack={() => open(undefined)} list={<ReviewFiles files={files} opened={current?.path} selected={selectedPaths} canSelect={file => selectablePaths.has(file.path)} onOpen={file => open(file.path)} onToggle={data.mode === 'staged' ? undefined : file => {
        const revision = (file as ChangeFile).revision;
        if (!revision) return;
        select(old => { const next = new Map(old); if (next.get(file.path) === revision) next.delete(file.path); else next.set(file.path, revision); return next; });
      }} />} detail={<>
        {current?.issue && <p role="status" className="border-b px-3 py-2 text-xs text-destructive">{current.issue}</p>}
        {current?.state === 'conflict' && !current.revision ? null : shownPreview ? 'unavailable' in shownPreview ? <ReviewEmpty>{shownPreview.unavailable === 'binary' ? 'Binary file' : 'File is too large to preview'}</ReviewEmpty> : <CodeReview key={previewKey} rows={rows} />
          : preview?.key === previewKey && preview?.error ? <ReviewEmpty>{preview.error}<Button size="sm" variant="outline" onClick={() => retryPreview(value => value + 1)}>Retry</Button></ReviewEmpty> : <ReviewEmpty>Loading comparison…</ReviewEmpty>}
      </>} />
      {data.mode === 'live' && <footer className="flex shrink-0 flex-wrap gap-1.5 border-t p-2">
        {current && selectablePaths.has(current.path) && <Button size="sm" variant="outline" disabled={blocked} onClick={() => show('undo', [current])}><Undo2 />{t('Undo file')}</Button>}
        <Button size="sm" variant="outline" disabled={blocked || !visibleSelection.length} onClick={() => show('undo', visibleSelection)}>{pending ? <Loader2 className="animate-spin" /> : <Undo2 />}{t('Undo selected')}</Button>
      </footer>}
      {data.mode === 'isolated' && (
      <footer className="flex shrink-0 flex-wrap items-center gap-1.5 border-t p-2">
        <Button className="h-7 text-[11px]" size="sm" disabled={blocked || !visibleSelection.length} onClick={() => show('apply', visibleSelection)}>{pending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}Apply selected</Button>
        <Button className="h-7 text-[11px]" size="sm" variant="outline" disabled={blocked || !visibleSelection.length} onClick={() => show('discard', visibleSelection)}><Undo2 className="size-3" />Discard selected</Button>
        <Button className="h-7 text-[11px]" size="sm" variant="ghost" disabled={blocked} onClick={() => show('apply', files)}>Apply all</Button>
        <Button className="h-7 text-[11px]" size="sm" variant="ghost" disabled={blocked} onClick={() => show('discard', files)}>Discard all</Button>
      </footer>
      )}
    </>}
    {Boolean(data?.omitted) && <p className="shrink-0 border-t px-3 py-1 text-[10px] text-muted-foreground">Generated files, common secret files and links are excluded.</p>}
    <Dialog open={Boolean(confirm)} onOpenChange={value => { if (!value) setConfirm(undefined); }}>
      <DialogContent className="z-[115]" showCloseButton={false}>
        <DialogHeader><DialogTitle>{confirm?.action === 'undo' ? t('Undo project changes?') : `${confirm?.action === 'apply' ? 'Apply' : 'Discard'} ${confirm?.files.length} ${confirm?.files.length === 1 ? 'file' : 'files'}?`}</DialogTitle><DialogDescription>{confirm?.action === 'undo' ? t('Restore the previous project versions. Files edited since publication will be kept.') : confirm?.action === 'apply' ? `Write the reviewed changes to ${project}. Conflicting project edits will be kept.` : 'Restore the selected files in this conversation copy to their last approved state. The project will not be modified.'}</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setConfirm(undefined)}>{t('Cancel')}</Button><Button variant={confirm?.action === 'apply' ? 'default' : 'destructive'} onClick={() => void resolve()}>{confirm?.action === 'undo' ? t('Undo changes') : confirm?.action === 'apply' ? 'Apply to project' : 'Discard changes'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

export function DockChanges({ orchestrator }: { orchestrator: ReactNode }) {
  const workspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const project = useWorkspaceStore(state => state.workspaces.find(item => item.id === workspaceId)?.name);
  const mode = useManualStore(state => state.mode);
  const current = useManualStore(state => workspaceId ? state.conversations[workspaceId]?.find(item => item.id === state.activeByWorkspace[workspaceId]) : undefined);
  const mission = useMissionStore(state => state.missions.find(item => item.id === state.activeMissionId && item.workspaceId === workspaceId));
  const view = useSettingsStore(state => state.activeView);
  if (view === 'chat' && mode === 'manual' && current) return <ChangesList key={current.id} root={`/manual/conversations/${encodeURIComponent(current.id)}/changes`} title={current.title} project={project || 'Project'} />;
  if (view === 'chat' && mode === 'orchestrator' && mission) return <div key={mission.id} className="flex h-full min-h-0 min-w-0 flex-col"><header className="border-b px-3 py-2"><p className="truncate text-xs font-semibold" title={mission.title}>{mission.title}</p><p className="truncate text-[11px] text-muted-foreground">{project} · Orchestrator</p></header><div className="min-h-0 flex-1">{orchestrator}</div></div>;
  return <ReviewEmpty>Open a Manual or Orchestrator chat to see its changes.</ReviewEmpty>;
}

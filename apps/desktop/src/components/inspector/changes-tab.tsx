import { useEffect, useState } from 'react';
import { ChevronLeft, FileCode2, Folder, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChangesList, ReviewEmpty } from '@/components/dock/ChangesPanel';
import { useMissionStore } from '@/stores/mission-store';
import { t, useLanguageStore } from '@/stores/language-store';
import { apiRequest } from '@/lib/api-client';

type WorktreeResult = { kind: 'directory'; path: string; entries: Array<{ path: string; name: string; kind: 'directory' | 'file' }>; truncated: boolean }
  | { kind: 'file'; path: string; content?: string; truncated: boolean; previewUnavailable?: string };

function BuilderFiles({ root }: { root: string }) {
  const [path, navigate] = useState('');
  const [result, setResult] = useState<{ path: string; data?: WorktreeResult; error?: string }>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<WorktreeResult>(`${root}/worktree?path=${encodeURIComponent(path)}`, { signal: controller.signal, cache: 'no-store' }).then(
      data => { if (!controller.signal.aborted) setResult({ path, data }); },
      error => { if (!controller.signal.aborted) setResult({ path, error: error.message }); },
    );
    return () => controller.abort();
  }, [root, path, attempt]);

  const data = result?.path === path ? result.data : undefined;
  const error = result?.path === path ? result.error : undefined;
  return <div className="flex min-h-0 flex-1 flex-col">
    {path && <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1 text-xs">
      <Button variant="ghost" size="icon" aria-label="Parent directory" onClick={() => navigate(path.split('/').slice(0, -1).join('/'))}><ChevronLeft /></Button>
      <span className="truncate font-mono">{path}</span>
    </div>}
    {error ? <ReviewEmpty>{error}<Button size="sm" variant="outline" onClick={() => retry(value => value + 1)}>{t('Retry')}</Button></ReviewEmpty>
      : !data ? <ReviewEmpty><Loader2 className="size-4 animate-spin" />Loading worker files…</ReviewEmpty>
      : <ScrollArea className="min-h-0 flex-1">
        {data.kind === 'directory' ? <ul className="p-2">{data.entries.map(entry => <li key={entry.path}><button type="button" onClick={() => navigate(entry.path)} className="flex w-full min-w-0 items-center gap-2 rounded-md p-2 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
          {entry.kind === 'directory' ? <Folder className="size-3.5 shrink-0" /> : <FileCode2 className="size-3.5 shrink-0" />}
          <span className="truncate">{entry.name}</span>
        </button></li>)}{!data.entries.length && <li className="p-2 text-xs text-muted-foreground">This directory is empty.</li>}</ul>
          : <pre className="whitespace-pre-wrap break-all p-3 text-xs">{data.previewUnavailable ? 'Preview unavailable.' : data.content || 'Empty file.'}</pre>}
        {data.truncated && <p className="px-3 py-2 text-xs text-muted-foreground">Preview truncated.</p>}
      </ScrollArea>}
  </div>;
}

export function ChangesTab() {
  useLanguageStore(state => state.language);
  const missionId = useMissionStore(state => state.activeMissionId);
  const tasks = useMissionStore(state => state.activeTasks);
  const [selected, select] = useState('');
  const [browse, setBrowse] = useState(false);
  const builders = tasks.filter(task => task.missionId === missionId && task.assignedRole === 'builder');
  const builder = builders.find(task => task.id === selected) ?? builders[0];
  if (!builder) return <ReviewEmpty>{t('No Builder changes yet')}</ReviewEmpty>;
  const root = `/tasks/${encodeURIComponent(builder.id)}`;

  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
      <select aria-label={t('Builder output')} value={builder.id} onChange={event => select(event.target.value)} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs">
        {builders.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select>
      <Button size="sm" variant="ghost" type="button" aria-pressed={browse} onClick={() => setBrowse(value => !value)}>{t(browse ? 'Changes' : 'Browse files')}</Button>
    </div>
    {browse ? <BuilderFiles key={root} root={root} /> : <div className="min-h-0 flex-1"><ChangesList key={root} root={`${root}/changes`} builder /></div>}
  </div>;
}

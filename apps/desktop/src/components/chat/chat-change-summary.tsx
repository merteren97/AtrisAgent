import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronDown, FileDiff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { t, useLanguageStore } from '@/stores/language-store';
import { useRightDockStore } from '@/stores/right-dock-store';

type FileChange = { path: string; status: string; state?: string; taskId?: string };
type Snapshot = { files: FileChange[]; mode?: string; quality?: 'pending' | 'failed' | 'verified' };
const statusText: Record<string, string> = { added: 'Added', deleted: 'Deleted', modified: 'Modified', renamed: 'Renamed' };

export function ChatChangeSummary({ endpoint }: { endpoint: string }) {
  const dockOpen = useRightDockStore(state => state.open);
  if (dockOpen) return null;
  return <Summary key={endpoint} endpoint={endpoint} />;
}

function Summary({ endpoint }: { endpoint: string }) {
  useLanguageStore(state => state.language);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      let interval = 4000;
      try {
        if (document.visibilityState === 'hidden') return;
        const result = await apiRequest<Snapshot>(endpoint, { signal: controller.signal, cache: 'no-store' });
        if (!controller.signal.aborted && Array.isArray(result.files)) {
          setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(result) ? previous : result);
          if (result.mode === 'isolated' || result.mode === 'direct') interval = 12000;
        }
      } catch { /* Keep the last good summary. The full panel exposes errors and retry. */ }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, interval); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint]);
  const files = snapshot?.files;
  if (!files?.length) return null;

  const count = (status: string) => files.filter(file => file.status === status && file.state !== 'reverted').length;
  const changeCounts = ([['added', 'Added'], ['modified', 'Modified'], ['deleted', 'Deleted'], ['renamed', 'Renamed']] as const)
    .flatMap(([status, label]) => count(status) ? [`${count(status)} ${t(label)}`] : []);
  return <div className="w-full shrink-0 px-3 pb-2 pt-1">
    <section aria-label={t('Changed files')} className="mx-auto flex w-full max-w-3xl items-start gap-2 rounded-xl border border-border/70 bg-card/70 px-2.5 py-1.5">
      <FileDiff aria-hidden="true" className="mt-1.5 size-4 shrink-0 text-primary" />
      <details className="group min-w-0 flex-1">
        <summary className="flex min-h-7 cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 rounded-sm text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="font-medium">{t('Changed files')} <span className="tabular-nums text-muted-foreground">{files.length}</span></span>
          {changeCounts.length > 0 && <span className="hidden text-[11px] text-muted-foreground sm:inline">{changeCounts.join(' · ')}</span>}
          {snapshot?.quality === 'failed' && <span className="text-[11px] text-destructive">{t('Verification failed')}</span>}
          <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <ul className="max-h-28 space-y-0.5 overflow-y-auto py-1" aria-label={t('Changed files')}>
          {files.slice(0, 5).map(file => <li key={`${file.taskId || ''}:${file.path}`} className="flex min-w-0 items-center gap-2 py-0.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={file.path}>{file.path}</span>
            <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground',
              file.state !== 'reverted' && file.state !== 'conflict' && file.status === 'added' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
              file.state !== 'reverted' && file.state !== 'conflict' && file.status === 'deleted' && 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
              file.state === 'conflict' && 'text-destructive')}>
              {t(file.state === 'reverted' ? 'Undone' : file.state === 'conflict' ? 'Conflict' : statusText[file.status] || 'Modified')}
            </span>
          </li>)}
          {files.length > 5 && <li className="text-[11px] text-muted-foreground">+{files.length - 5}</li>}
        </ul>
      </details>
      <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => useRightDockStore.setState({ open: true, activeTab: 'changes' })}>
        {t('Review files')}<ArrowUpRight aria-hidden="true" />
      </Button>
    </section>
  </div>;
}

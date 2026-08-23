import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileCode2, Loader2, RefreshCw, AlertTriangle, Plus, Minus, Folder, ChevronLeft } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useMissionStore } from '@/stores/mission-store';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface ChangedFile { path: string; status: string; additions: number; deletions: number }
interface ReviewPack { taskId: string; taskSpecification: string; builderSummary: string; changedFiles: ChangedFile[]; unifiedDiff: string; newDependencies: string[]; riskyOperations: string[] }
type WorktreeEntry = { path: string; name: string; kind: 'directory' | 'file'; sizeBytes?: number };
type WorktreeResult = { kind: 'directory'; path: string; entries: WorktreeEntry[]; truncated: boolean }
  | { kind: 'file'; path: string; sizeBytes: number; content?: string; truncated: boolean; previewUnavailable?: 'binary' | 'special' };

export function ChangesTab() {
  const { activeMissionId, activeTasks } = useMissionStore();
  const [packs, setPacks] = useState<ReviewPack[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'files' | 'diff'>('files');
  const [browser, setBrowser] = useState<WorktreeResult | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const browserRequest = useRef(0);

  const load = async () => {
    if (!activeMissionId) { setPacks([]); return; }
    setLoading(true); setError(null);
    const builderTasks = activeTasks.filter((task) => task.assignedRole === 'builder');
    const results = await Promise.all(builderTasks.map(async (task) => {
      try {
        const response = await apiRequest<{ diff: ReviewPack }>(`/tasks/${task.id}/diff`);
        return response.diff;
      } catch { return null; }
    }));
    const available = results.filter((pack): pack is ReviewPack => Boolean(pack));
    setPacks(available);
    setSelectedTaskId((current) => current && available.some((pack) => pack.taskId === current) ? current : available[0]?.taskId || null);
    if (builderTasks.length > 0 && available.length === 0) setError('Builder worktrees exist, but review packs are not available yet.');
    setLoading(false);
  };

  useEffect(() => { void load(); }, [activeMissionId, activeTasks.map((task) => `${task.id}:${task.status}`).join('|')]);
  const selected = packs.find((pack) => pack.taskId === selectedTaskId);
  const inspect = async (relativePath = '') => {
    if (!selectedTaskId) return;
    const requestId = ++browserRequest.current;
    setBrowserLoading(true); setBrowserError(null);
    try {
      const result = await apiRequest<WorktreeResult>(`/tasks/${selectedTaskId}/worktree?path=${encodeURIComponent(relativePath)}`);
      if (requestId === browserRequest.current) setBrowser(result);
    } catch (inspectError: any) {
      if (requestId === browserRequest.current) setBrowserError(inspectError?.message || 'Worker files are not available yet.');
    } finally { if (requestId === browserRequest.current) setBrowserLoading(false); }
  };
  useEffect(() => { setBrowser(null); if (selectedTaskId && mode === 'files') void inspect(); }, [selectedTaskId, mode]);

  if (!activeMissionId) return <Empty text="Select a mission to inspect its worktree changes." />;
  if (loading && packs.length === 0) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generating review packs…</div>;
  if (!selected) return <Empty text={error || 'No Builder change set has been produced for this mission.'} action={<Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 h-3.5 w-3.5" />Refresh</Button>} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <select className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs" value={selected.taskId} onChange={(event) => setSelectedTaskId(event.target.value)}>
          {packs.map((pack) => <option key={pack.taskId} value={pack.taskId}>{pack.taskSpecification}</option>)}
        </select>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void load()}><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /></Button>
        <div className="flex rounded-md border border-border p-0.5">
          {(['files', 'diff'] as const).map((item) => <button key={item} type="button" onClick={() => setMode(item)} aria-pressed={mode === item}
            className={cn('rounded px-2 py-1 text-[9px] capitalize', mode === item ? 'bg-accent text-foreground' : 'text-muted-foreground')}>{item}</button>)}
        </div>
      </div>
      <div className="border-b border-border bg-muted/20 p-3 text-xs">
        <p className="font-medium">{selected.builderSummary}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge variant="outline">{selected.changedFiles.length} files</Badge>
          <Badge variant="outline" className="text-emerald-400"><Plus className="mr-1 h-3 w-3" />{selected.changedFiles.reduce((sum, file) => sum + file.additions, 0)}</Badge>
          <Badge variant="outline" className="text-rose-400"><Minus className="mr-1 h-3 w-3" />{selected.changedFiles.reduce((sum, file) => sum + file.deletions, 0)}</Badge>
        </div>
        {(selected.riskyOperations.length > 0 || selected.newDependencies.length > 0) && <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2 text-amber-200"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />{[...selected.riskyOperations, ...selected.newDependencies.map((item) => `New dependency: ${item}`)].join(' · ')}</div>}
      </div>
      {mode === 'diff' ? <ScrollArea className="flex-1">
        <pre className="min-h-full whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-muted-foreground">{selected.unifiedDiff || 'No textual diff was produced.'}</pre>
      </ScrollArea> : <div className="flex min-h-0 flex-1 flex-col">
        {browserLoading ? <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading worker files…</div>
          : browserError ? <Empty text={browserError} action={<Button size="sm" variant="outline" onClick={() => void inspect()}><RefreshCw className="mr-2 h-3.5 w-3.5" />Retry</Button>} />
            : browser?.kind === 'directory' ? <ScrollArea className="flex-1">
              <div className="p-2">
                {browser.path && <button type="button" onClick={() => void inspect(browser.path.split('/').slice(0, -1).join('/'))} className="mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[10px] text-muted-foreground hover:bg-accent"><ChevronLeft className="h-3.5 w-3.5" />Parent directory</button>}
                {browser.entries.map((entry) => <button key={entry.path} type="button" onClick={() => void inspect(entry.path)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[10px] hover:bg-accent">
                  {entry.kind === 'directory' ? <Folder className="h-3.5 w-3.5 text-primary" /> : <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>{entry.sizeBytes !== undefined && <span className="text-[8px] text-muted-foreground">{entry.sizeBytes} B</span>}
                </button>)}
                {browser.entries.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">This directory is empty.</p>}
              </div>
            </ScrollArea> : browser?.kind === 'file' ? <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[10px]"><button type="button" onClick={() => void inspect(browser.path.split('/').slice(0, -1).join('/'))} aria-label="Back to directory"><ChevronLeft className="h-3.5 w-3.5" /></button><span className="truncate font-mono">{browser.path}</span><span className="ml-auto text-muted-foreground">{browser.sizeBytes} B</span></div>
              <ScrollArea className="flex-1"><pre className="min-h-full whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-muted-foreground">{browser.previewUnavailable ? `Preview unavailable: ${browser.previewUnavailable} file.` : browser.content || 'Empty file.'}{browser.truncated ? '\n\n[Preview truncated]' : ''}</pre></ScrollArea>
            </div> : <Empty text="Select a worker file to inspect it read-only." />}
      </div>}
    </div>
  );
}

function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted-foreground"><FileCode2 className="mb-3 h-9 w-9 opacity-25" /><p className="mb-3 max-w-xs text-xs">{text}</p>{action}</div>;
}

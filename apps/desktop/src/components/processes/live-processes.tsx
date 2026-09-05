import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { ArrowDown, Bot, Circle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { projectMissionProcesses } from '@/lib/process-projection';
import { DEFAULT_TIMELINE_WINDOW, growTimelineWindow, tailWindow } from '@/lib/timeline-window';
import { useAgentStore } from '@/stores/agent-store';
import { useMissionStore } from '@/stores/mission-store';

const BOTTOM_THRESHOLD = 32;
const COMPACT_CONTENT_LENGTH = 480;

function nearBottom(viewport: HTMLElement): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD;
}

function ProcessContent({ content }: { content: string }) {
  if (content.length <= COMPACT_CONTENT_LENGTH) return <span className="whitespace-pre-wrap break-words">{content}</span>;
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-foreground/90 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="whitespace-pre-wrap break-words">{content.slice(0, COMPACT_CONTENT_LENGTH).trimEnd()}…</span>
        <span className="ml-2 text-[10px] text-primary group-open:hidden">Show full output</span>
      </summary>
      <span className="mt-2 block whitespace-pre-wrap break-words border-l border-border pl-3 text-foreground/90">{content}</span>
    </details>
  );
}

export function LiveProcesses() {
  const { missions, activeMissionId, activeTasks, timeline } = useMissionStore();
  const agents = useAgentStore((state) => state.agents);
  const [selectedId, setSelectedId] = useState('orchestrator');
  const [detached, setDetached] = useState(false);
  const [visibleCount, setVisibleCount] = useState(DEFAULT_TIMELINE_WINDOW);
  const viewportRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const mission = missions.find((item) => item.id === activeMissionId);
  const processes = useMemo(
    () => mission ? projectMissionProcesses(mission, agents, activeTasks, timeline) : [],
    [activeTasks, agents, mission, timeline],
  );
  const selected = processes.find((process) => process.id === selectedId) || processes[0];
  const visibleStream = useMemo(
    () => tailWindow(selected?.stream || [], visibleCount),
    [selected?.stream, visibleCount],
  );

  useEffect(() => {
    setSelectedId('orchestrator');
    followRef.current = true;
    setDetached(false);
    setVisibleCount(DEFAULT_TIMELINE_WINDOW);
  }, [activeMissionId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [selected?.stream]);

  const selectProcess = (id: string) => {
    setSelectedId(id);
    followRef.current = true;
    setDetached(false);
    setVisibleCount(DEFAULT_TIMELINE_WINDOW);
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    followRef.current = nearBottom(event.currentTarget);
    setDetached(!followRef.current);
  };

  const jumpToLatest = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followRef.current = true;
    setDetached(false);
    viewport.scrollTo({ top: viewport.scrollHeight });
  };

  if (!mission || !selected) return null;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Live processes">
      <div className="border-b border-border p-3 md:hidden">
        <label className="sr-only" htmlFor="process-selector">Process</label>
        <select id="process-selector" value={selected.id} onChange={(event) => selectProcess(event.target.value)} className="h-9 w-full rounded-md border border-border bg-card px-3 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring">
          {processes.map((process) => <option key={process.id} value={process.id}>{process.name} · {process.status}</option>)}
        </select>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-card/30 p-2 md:block" aria-label="Process catalog">
          {processes.map((process) => (
            <button key={process.id} type="button" aria-current={selected.id === process.id ? 'true' : undefined} onClick={() => selectProcess(process.id)} className={`mb-1 flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${selected.id === process.id ? 'bg-primary/10 text-foreground ring-1 ring-primary/20' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}>
              <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{process.name}</span><span className="mt-0.5 block truncate text-[10px] capitalize">{process.status}</span></span>
            </button>
          ))}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-2 border-b border-border bg-card/20 px-4 py-3 text-[10px] sm:grid-cols-4">
            <div><span className="block uppercase tracking-wider text-muted-foreground">Status</span><span className="mt-1 flex items-center gap-1.5 capitalize"><Circle className="h-2 w-2 fill-current text-primary" />{selected.status}</span></div>
            <div className="min-w-0"><span className="block uppercase tracking-wider text-muted-foreground">Model</span><span className="mt-1 block truncate">{selected.model}</span></div>
            <div className="min-w-0"><span className="block uppercase tracking-wider text-muted-foreground">Task</span><span className="mt-1 block truncate" title={selected.task}>{selected.task}</span></div>
            <div className="min-w-0"><span className="block uppercase tracking-wider text-muted-foreground">Parent</span><span className="mt-1 block truncate">{selected.parent}</span></div>
          </header>
          <div className="relative min-h-0 flex-1">
            <ScrollArea className="h-full" viewportRef={viewportRef} onViewportScroll={handleScroll}>
              <div role="log" aria-live={detached ? 'off' : 'polite'} aria-relevant="additions" aria-label={`${selected.name} activity stream`} className="min-h-full p-4 font-mono text-[11px] leading-5">
                {visibleStream.hiddenCount > 0 && (
                  <div className="mb-3 flex justify-center">
                    <Button type="button" variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => setVisibleCount((count) => growTimelineWindow(count, selected.stream.length))}>
                      Load {Math.min(DEFAULT_TIMELINE_WINDOW, visibleStream.hiddenCount)} older updates
                    </Button>
                  </div>
                )}
                {selected.stream.length === 0 ? <p className="text-muted-foreground">No process activity recorded.</p> : visibleStream.items.map((item) => (
                  <div key={item.id} className={`grid grid-cols-[4.5rem_4.5rem_minmax(0,1fr)] gap-2 border-b border-border/40 py-1.5 last:border-0 ${item.category === 'output' ? 'my-1 rounded-md bg-muted/20 px-2' : ''}`}>
                    <time className="tabular-nums text-muted-foreground">{item.timestamp}</time>
                    <Badge variant="outline" className={`h-5 justify-center rounded px-1 text-[8px] uppercase ${item.category === 'error' ? 'border-destructive/30 text-destructive' : item.category === 'tool' ? 'text-amber-400' : item.category === 'output' ? 'text-primary' : 'text-muted-foreground'}`}>{item.category}</Badge>
                    <div className="min-w-0"><span className="mr-2 text-muted-foreground">{item.label}</span><ProcessContent content={item.content} /></div>
                  </div>
                ))}
              </div>
            </ScrollArea>
            {detached && <Button type="button" variant="secondary" size="sm" className="absolute bottom-4 right-4 h-7 rounded-full text-[10px] shadow-md" onClick={jumpToLatest}><ArrowDown className="h-3.5 w-3.5" />Jump to latest</Button>}
          </div>
        </div>
      </div>
    </section>
  );
}

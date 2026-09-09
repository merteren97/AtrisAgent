import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCcw, Square, X } from 'lucide-react';
import type { ManualAgent } from '@/stores/manual-store';
import { Button } from '@/components/ui/button';
import { ManualTerminal, type TerminalSnapshot } from './manual-terminal';

export function terminalColumns(count: number, width: number): number {
  return Math.max(1, Math.min(count, 5, Math.ceil(Math.sqrt(count)), Math.floor(width / 360)));
}

export function TerminalCanvas({ agents, statuses, selectedId, pending, generation, onSelect, onOpen, onInterrupt, onClose }: {
  agents: ManualAgent[]; statuses: Record<string, TerminalSnapshot['status']>; selectedId?: string;
  pending: boolean; generation: number; onSelect: (agent: ManualAgent) => void;
  onOpen: (agent: ManualAgent) => void; onInterrupt: (agent: ManualAgent) => void; onClose: (agent: ManualAgent) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 600 });
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(root.current); return () => observer.disconnect();
  }, []);
  const visible = focused && agents.some(agent => agent.id === focused) ? agents.filter(agent => agent.id === focused) : agents;
  const columns = terminalColumns(visible.length, size.width);
  const rows = Math.ceil(visible.length / columns);
  return <div ref={root} className="min-h-0 flex-1 overflow-auto p-2" aria-label="Agent terminals">
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`, height: Math.max(size.height, rows * 250 + Math.max(0, rows - 1) * 8) }}>
      {visible.map((agent, index) => <section key={agent.id} aria-label={`${agent.name} terminal`} onFocusCapture={() => onSelect(agent)} className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-background ${selectedId === agent.id ? 'border-primary/40' : 'border-border'}`} style={index === visible.length - 1 && visible.length % columns === 1 ? { gridColumn: '1 / -1' } : undefined}>
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card/60 px-3">
          <button type="button" onClick={() => onSelect(agent)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={`${agent.model} · ${agent.cwd}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statuses[agent.id] === 'open' ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />
            <span className="truncate font-medium">{agent.name}</span><span className="truncate text-muted-foreground">{statuses[agent.id] || 'Not started'}</span>
          </button>
          {statuses[agent.id] !== 'open' ? <Button size="icon" variant="ghost" className="h-7 w-7" disabled={pending} onClick={() => onOpen(agent)} aria-label={`Open ${agent.name}`}><RotateCcw className="h-3.5 w-3.5" /></Button> : <Button size="icon" variant="ghost" className="h-7 w-7" disabled={pending} onClick={() => onInterrupt(agent)} aria-label={`Interrupt ${agent.name}`}><Square className="h-3 w-3" /></Button>}
          {agents.length > 1 && <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setFocused(focused === agent.id ? null : agent.id)} aria-label={focused === agent.id ? 'Show all terminals' : `Focus ${agent.name}`}>
            {focused === agent.id ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>}
          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" disabled={pending || statuses[agent.id] !== 'open'} onClick={() => onClose(agent)} aria-label={`Close ${agent.name}`}><X className="h-3.5 w-3.5" /></Button>
        </header>
        <ManualTerminal id={agent.id} generation={generation} />
      </section>)}
    </div>
  </div>;
}

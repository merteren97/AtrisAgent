import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCcw, Square, X, GripVertical, MoreHorizontal, FlipHorizontal, Share2, Eraser, ArrowLeft, ArrowRight } from 'lucide-react';
import type { ManualAgent } from '@/stores/manual-store';
import { Button } from '@/components/ui/button';
import { ManualTerminal, ensureManualTerminal, type TerminalSnapshot } from './manual-terminal';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';

export function terminalColumns(count: number, width: number): number {
  return Math.max(1, Math.min(count, 5, Math.ceil(Math.sqrt(count)), Math.floor(width / 360)));
}

export function TerminalCanvas({ agents, statuses, selectedId, pending, generation, onSelect, onOpen, onInterrupt, onClose, onMove, onRestart, onHandoff }: {
  agents: ManualAgent[]; statuses: Record<string, TerminalSnapshot['status']>; selectedId?: string;
  pending: boolean; generation: number; onSelect: (agent: ManualAgent) => void;
  onOpen: (agent: ManualAgent) => void; onInterrupt: (agent: ManualAgent) => void; onClose: (agent: ManualAgent) => void;
  onMove: (source: string, target: string) => void; onRestart: (agent: ManualAgent) => void; onHandoff: (agent: ManualAgent) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 600 });
  const [focused, setFocused] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
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
      {visible.map((agent, index) => <section key={agent.id} data-manual-terminal={agent.id} aria-label={`${agent.name} terminal`} onFocusCapture={() => onSelect(agent)} className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-background ${dropTarget === agent.id ? 'border-primary ring-2 ring-primary/30' : selectedId === agent.id ? 'border-primary/40' : 'border-border'} ${dragged === agent.id ? 'opacity-50' : ''}`} style={index === visible.length - 1 && visible.length % columns === 1 ? { gridColumn: '1 / -1' } : undefined}>
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card/60 px-3">
          <button type="button" disabled={!!focused} aria-label={`Move ${agent.name}`} title="Drag to reorder. Use the menu to move with a keyboard." className="touch-none cursor-grab text-muted-foreground active:cursor-grabbing disabled:opacity-30" onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragged(agent.id); }} onPointerMove={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-manual-terminal]')?.dataset.manualTerminal;
            setDropTarget(target && target !== agent.id && visible.some(item => item.id === target) ? target : null);
            const viewport = root.current;
            if (viewport) { const rect = viewport.getBoundingClientRect(); if (event.clientY > rect.bottom - 40) viewport.scrollTop += 16; else if (event.clientY < rect.top + 40) viewport.scrollTop -= 16; }
          }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { if (dropTarget) onMove(agent.id, dropTarget); event.currentTarget.releasePointerCapture(event.pointerId); } setDragged(null); setDropTarget(null); }} onPointerCancel={() => { setDragged(null); setDropTarget(null); }} onLostPointerCapture={() => { setDragged(null); setDropTarget(null); }} onKeyDown={event => { if (event.key === 'Escape') { setDragged(null); setDropTarget(null); } }}><GripVertical className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => onSelect(agent)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={`${agent.model} · ${agent.cwd}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statuses[agent.id] === 'open' ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />
            <span className="truncate font-medium">{agent.name}</span><span className="truncate text-muted-foreground">{statuses[agent.id] || 'Not started'}</span>
          </button>
          {statuses[agent.id] !== 'open' ? <Button size="icon" variant="ghost" className="h-7 w-7" disabled={pending} onClick={() => onOpen(agent)} aria-label={`Open ${agent.name}`}><RotateCcw className="h-3.5 w-3.5" /></Button> : <Button size="icon" variant="ghost" className="h-7 w-7" disabled={pending} onClick={() => onInterrupt(agent)} aria-label={`Interrupt ${agent.name}`}><Square className="h-3 w-3" /></Button>}
          {agents.length > 1 && <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setFocused(focused === agent.id ? null : agent.id)} aria-label={focused === agent.id ? 'Show all terminals' : `Focus ${agent.name}`}>
            {focused === agent.id ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>}
          <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Options for ${agent.name}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-52 rounded-xl p-1.5">
            <DropdownMenuItem onSelect={() => setFlipped(previous => ({ ...previous, [agent.id]: !previous[agent.id] }))}><FlipHorizontal />{flipped[agent.id] ? 'Back to terminal' : 'Flip terminal'}</DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={() => onRestart(agent)}><RotateCcw />Restart terminal</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ensureManualTerminal(agent.id).terminal.clear()}><Eraser />Clear screen</DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={() => onHandoff(agent)}><Share2 />Transfer context</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={index === 0 || !!focused} onSelect={() => onMove(agent.id, visible[index - 1].id)}><ArrowLeft />Move earlier</DropdownMenuItem>
            <DropdownMenuItem disabled={index === visible.length - 1 || !!focused} onSelect={() => onMove(agent.id, visible[index + 1].id)}><ArrowRight />Move later</DropdownMenuItem>
            <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={pending} onSelect={() => onClose(agent)}><X />Close terminal</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" disabled={pending} onClick={() => onClose(agent)} aria-label={`Close ${agent.name}`} title="Stop this CLI and close its pane"><X className="h-3.5 w-3.5" /></Button>
        </header>
        {flipped[agent.id] ? <div className="min-h-0 flex-1 overflow-auto p-5"><h2 className="text-sm font-medium">Session details</h2><dl className="mt-4 space-y-3 text-xs">{[['CLI', agent.runtimeType], ['Model', agent.model], ['Directory', agent.cwd], ['Status', statuses[agent.id] || 'Unknown']].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-all select-text">{value}</dd></div>)}</dl><p className="mt-4 text-xs text-muted-foreground">Flipping does not stop this CLI. Its context remains independent.</p><Button size="sm" variant="outline" className="mt-4" onClick={() => setFlipped(previous => ({ ...previous, [agent.id]: false }))}>Back to terminal</Button></div> : <ManualTerminal id={agent.id} generation={generation} />}
      </section>)}
    </div>
  </div>;
}

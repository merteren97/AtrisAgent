import { useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { buildMemoryGraphLayout, connectedMemoryNodeIds } from '@/lib/memory-graph';
import type { MemoryEdge, MemoryNode, MemoryNodeType } from '@/stores/memory-store';

function nodeClasses(type: MemoryNodeType): string {
  if (type === 'project') return 'fill-primary stroke-primary';
  if (type === 'research_finding') return 'fill-emerald-400 stroke-emerald-300';
  if (type === 'decision') return 'fill-violet-400 stroke-violet-300';
  if (type === 'requirement' || type === 'user_constraint') return 'fill-amber-400 stroke-amber-300';
  if (['change', 'file', 'symbol', 'component'].includes(type)) return 'fill-blue-400 stroke-blue-300';
  if (['bug', 'issue', 'mistake'].includes(type)) return 'fill-rose-400 stroke-rose-300';
  if (type === 'verification' || type === 'test') return 'fill-cyan-400 stroke-cyan-300';
  if (type === 'lesson' || type === 'pattern') return 'fill-lime-400 stroke-lime-300';
  return 'fill-muted-foreground stroke-foreground/50';
}

export function MemoryGraphView({
  nodes,
  edges,
  selectedNodeId,
  onSelect,
}: {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  const [zoom, setZoom] = useState(0.92);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const layout = useMemo(() => buildMemoryGraphLayout(nodes, edges, 500), [nodes, edges]);
  const pointById = useMemo(() => new Map(layout.points.map((point) => [point.id, point])), [layout.points]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const neighborhood = useMemo(
    () => selectedNodeId ? connectedMemoryNodeIds(selectedNodeId, edges) : null,
    [edges, selectedNodeId],
  );

  const reset = () => {
    setZoom(0.92);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div className="relative h-full min-h-[240px] overflow-hidden bg-muted/10">
      <svg
        className="h-full w-full touch-none"
        viewBox="-560 -560 1120 1120"
        onWheel={(event) => {
          event.preventDefault();
          setZoom((value) => Math.max(0.35, Math.min(2.4, value + (event.deltaY > 0 ? -0.08 : 0.08))));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const scale = 1120 / Math.max(1, event.currentTarget.clientWidth);
          setPan({
            x: drag.current.panX + (event.clientX - drag.current.x) * scale,
            y: drag.current.panY + (event.clientY - drag.current.y) * scale,
          });
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {edges.map((edge) => {
            const from = pointById.get(edge.fromNodeId);
            const to = pointById.get(edge.toNodeId);
            if (!from || !to) return null;
            const emphasized = !selectedNodeId || edge.fromNodeId === selectedNodeId || edge.toNodeId === selectedNodeId;
            return (
              <line
                key={edge.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={cn('stroke-border', emphasized ? 'opacity-70' : 'opacity-15')}
                strokeWidth={emphasized && selectedNodeId ? 1.8 : 1.1}
              />
            );
          })}
          {layout.points.map((point) => {
            const node = nodeById.get(point.id);
            if (!node) return null;
            const selected = selectedNodeId === node.id;
            const related = !neighborhood || neighborhood.has(node.id);
            return (
              <g
                key={node.id}
                transform={`translate(${point.x} ${point.y})`}
                className={cn('cursor-pointer transition-opacity', related ? 'opacity-100' : 'opacity-20')}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); onSelect(node.id); }}
              >
                {selected ? <circle r={point.radius + 7} className="fill-primary/10 stroke-primary/60" strokeWidth="2" /> : null}
                <circle r={point.radius} className={cn('stroke-[1.5]', nodeClasses(node.type))} />
                {node.pinned ? <circle r="2.3" cy={-(point.radius + 5)} className="fill-amber-300" /> : null}
                {(selected || point.radius >= 11) ? (
                  <text y={point.radius + 14} textAnchor="middle" className="pointer-events-none fill-foreground text-[10px] font-medium">
                    {node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md border border-border bg-background/90 p-1 shadow-sm">
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={reset} aria-label="Reset graph view">
              <RotateCcw className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset graph view</TooltipContent>
        </Tooltip>
        <span className="px-1 text-[9px] tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
      </div>

      {layout.truncated ? (
        <div className="absolute bottom-2 left-2 right-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[9px] text-amber-300">
          Showing 500 high-value/connected nodes. Search or filter to narrow the graph.
        </div>
      ) : null}
    </div>
  );
}
